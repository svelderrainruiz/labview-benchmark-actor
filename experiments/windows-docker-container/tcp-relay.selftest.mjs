import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { createLoopbackTcpRelay, probeTcpEndpoint } from './tcp-relay.mjs';

const timeout = async (promise, message, ms = 2000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const listen = async (handler) => {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    handler(socket);
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  return server;
};
const closeServer = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const connect = async (port) => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  return socket;
};
const collectUntilEnd = (socket) => new Promise((resolve, reject) => {
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.once('end', () => resolve(Buffer.concat(chunks)));
  socket.once('error', reject);
});
const waitForClose = (socket) => new Promise((resolve) => socket.once('close', resolve));

const upstream = await listen((socket) => socket.pipe(socket));
const upstreamPort = upstream.address().port;
const relay = createLoopbackTcpRelay({
  upstreamHost: '172.20.0.2',
  upstreamPort,
  connectUpstream: ({ port, allowHalfOpen }) => net.createConnection({ host: '127.0.0.1', port, allowHalfOpen }),
});
assert.equal(relay.readyState, false, 'relay readiness must not be reported synchronously');
assert.equal(relay.endpoint(), null, 'relay endpoint must be unavailable before listen completes');
const bound = await relay.ready;
assert.equal(bound.address, '127.0.0.1');
assert.equal(bound.family, 'IPv4');
assert.equal(bound.requestedPort, 0);
assert.ok(bound.port > 0, 'relay must receive an OS-assigned ephemeral port');

for (const payload of [Buffer.from('first-byte-exact'), Buffer.from([0, 1, 2, 3, 254, 255])]) {
  const client = await connect(bound.port);
  const response = timeout(once(client, 'data').then(([data]) => data), 'relay echo timed out');
  client.write(payload);
  assert.deepEqual(await response, payload, 'relay must forward bytes exactly in both directions');
  client.end();
  await waitForClose(client);
}
assert.equal(relay.stats().acceptedConnections, 2, 'relay must support sequential connections');
assert.equal(relay.stats().successfulUpstreamConnections, 2);
assert.ok(relay.stats().downstreamToUpstreamBytes > 0);
assert.equal(relay.stats().downstreamToUpstreamBytes, relay.stats().upstreamToDownstreamBytes);
const cleanup = await relay.close();
assert.equal(cleanup.closed, true);
assert.equal(cleanup.listenerReachable, false);
assert.equal((await probeTcpEndpoint({ host: '127.0.0.1', port: bound.port, timeoutMs: 200 })).connected, false);
await closeServer(upstream);

const upstreamEnds = await listen((socket) => socket.end('upstream-finished'));
const upstreamEndsPort = upstreamEnds.address().port;
const upstreamEndsRelay = createLoopbackTcpRelay({
  upstreamHost: '172.20.0.3',
  upstreamPort: upstreamEndsPort,
  connectUpstream: ({ port, allowHalfOpen }) => net.createConnection({ host: '127.0.0.1', port, allowHalfOpen }),
});
const upstreamEndsBound = await upstreamEndsRelay.ready;
const upstreamEndsClient = await connect(upstreamEndsBound.port);
assert.equal((await timeout(collectUntilEnd(upstreamEndsClient), 'upstream disconnect did not reach downstream')).toString(), 'upstream-finished');
upstreamEndsClient.destroy();
await upstreamEndsRelay.close();
await closeServer(upstreamEnds);

let downstreamCloseObserved;
const downstreamCloseServer = await listen((socket) => {
  downstreamCloseObserved = waitForClose(socket);
});
const downstreamClosePort = downstreamCloseServer.address().port;
const downstreamCloseRelay = createLoopbackTcpRelay({
  upstreamHost: '172.20.0.4',
  upstreamPort: downstreamClosePort,
  connectUpstream: ({ port, allowHalfOpen }) => net.createConnection({ host: '127.0.0.1', port, allowHalfOpen }),
});
const downstreamCloseBound = await downstreamCloseRelay.ready;
const downstreamClient = await connect(downstreamCloseBound.port);
while (!downstreamCloseObserved) await new Promise((resolve) => setImmediate(resolve));
downstreamClient.destroy();
await timeout(downstreamCloseObserved, 'downstream disconnect did not close upstream');
await downstreamCloseRelay.close();
await closeServer(downstreamCloseServer);

const activeServer = await listen(() => {});
const activePort = activeServer.address().port;
const activeRelay = createLoopbackTcpRelay({
  upstreamHost: '172.20.0.5',
  upstreamPort: activePort,
  connectUpstream: ({ port, allowHalfOpen }) => net.createConnection({ host: '127.0.0.1', port, allowHalfOpen }),
});
const activeBound = await activeRelay.ready;
const activeClient = await connect(activeBound.port);
await timeout((async () => {
  while (activeRelay.stats().successfulUpstreamConnections < 1) await new Promise((resolve) => setImmediate(resolve));
})(), 'active upstream did not connect');
const activeClientClosed = waitForClose(activeClient);
await activeRelay.close();
await timeout(activeClientClosed, 'active downstream was not closed during relay shutdown');
await closeServer(activeServer);

const refusedHolder = await listen(() => {});
const refusedPort = refusedHolder.address().port;
await closeServer(refusedHolder);
const refusedRelay = createLoopbackTcpRelay({
  upstreamHost: '172.20.0.6',
  upstreamPort: refusedPort,
  connectUpstream: ({ port }) => net.createConnection({ host: '127.0.0.1', port }),
});
const refusedBound = await refusedRelay.ready;
const refusedClient = await connect(refusedBound.port);
const refusedClosed = waitForClose(refusedClient);
refusedClient.write('trigger-upstream');
await timeout(refusedClosed, 'upstream refusal did not close downstream');
assert.equal(refusedRelay.stats().upstreamConnectionFailures, 1);
await refusedRelay.close();

const failureCleanupServer = await listen((socket) => socket.pipe(socket));
const failureCleanupPort = failureCleanupServer.address().port;
const failureCleanupRelay = createLoopbackTcpRelay({
  upstreamHost: '172.20.0.8',
  upstreamPort: failureCleanupPort,
  connectUpstream: ({ port }) => net.createConnection({ host: '127.0.0.1', port }),
});
const failureCleanupBound = await failureCleanupRelay.ready;
try {
  throw new Error('forced capture failure');
} catch (error) {
  assert.match(error.message, /forced capture failure/);
} finally {
  await failureCleanupRelay.close();
}
assert.equal((await probeTcpEndpoint({ host: '127.0.0.1', port: failureCleanupBound.port, timeoutMs: 200 })).connected, false);
await closeServer(failureCleanupServer);

const timeoutCleanupServer = await listen((socket) => socket.pipe(socket));
const timeoutCleanupPort = timeoutCleanupServer.address().port;
const timeoutCleanupRelay = createLoopbackTcpRelay({
  upstreamHost: '172.20.0.9',
  upstreamPort: timeoutCleanupPort,
  connectUpstream: ({ port }) => net.createConnection({ host: '127.0.0.1', port }),
});
const timeoutCleanupBound = await timeoutCleanupRelay.ready;
await assert.rejects(timeout(new Promise(() => {}), 'forced capture timeout', 10), /forced capture timeout/);
await timeoutCleanupRelay.close();
assert.equal((await probeTcpEndpoint({ host: '127.0.0.1', port: timeoutCleanupBound.port, timeoutMs: 200 })).connected, false);
await closeServer(timeoutCleanupServer);

const occupied = await listen(() => {});
const occupiedPort = occupied.address().port;
const bindFailureRelay = createLoopbackTcpRelay({
  upstreamHost: '172.20.0.7',
  upstreamPort: 5900,
  listenPort: occupiedPort,
});
await assert.rejects(bindFailureRelay.ready, /EADDRINUSE|address already in use/i);
await bindFailureRelay.close();
await closeServer(occupied);

for (const invalid of ['127.0.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'not-an-ip']) {
  assert.throws(() => createLoopbackTcpRelay({ upstreamHost: invalid }), /must not|must be/);
}

console.log('windows-docker loopback TCP relay self-test: PASS');
