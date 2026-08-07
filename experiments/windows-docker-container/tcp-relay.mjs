import net from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';

function errorDetail(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function assertUsableContainerIpv4(address) {
  if (net.isIP(address) !== 4) throw new Error(`container target must be an IPv4 address (got '${address}')`);
  const octets = address.split('.').map(Number);
  if (octets[0] === 0) throw new Error(`container target must not be unspecified (${address})`);
  if (octets[0] === 127) throw new Error(`container target must not be loopback (${address})`);
  if (octets[0] >= 224 && octets[0] <= 239) throw new Error(`container target must not be multicast (${address})`);
  if (address === '255.255.255.255') throw new Error(`container target must not be broadcast (${address})`);
  if (octets[0] === 169 && octets[1] === 254) throw new Error(`container target must not be link-local (${address})`);
  return address;
}

export function probeTcpEndpoint({
  host,
  port,
  timeoutMs = 3000,
  connect = (options) => net.createConnection(options),
}) {
  if (net.isIP(host) !== 4) throw new Error(`TCP probe host must be IPv4 (got '${host}')`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`TCP probe port is invalid (${port})`);
  if (!(timeoutMs > 0)) throw new Error('TCP probe timeout must be positive');
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = (connected, error = null) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve({
        connected,
        elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
        error: error ? errorDetail(error) : null,
      });
    };
    try {
      socket = connect({ host, port });
      socket.once('connect', () => finish(true));
      socket.once('error', (error) => finish(false, error));
      socket.setTimeout(timeoutMs, () => {
        const error = new Error(`TCP probe timed out after ${timeoutMs} ms`);
        error.code = 'ETIMEDOUT';
        finish(false, error);
      });
    } catch (error) {
      finish(false, error);
    }
  });
}

export function createLoopbackTcpRelay({
  upstreamHost,
  upstreamPort = 5900,
  listenPort = 0,
  connectUpstream = (options) => net.createConnection(options),
} = {}) {
  assertUsableContainerIpv4(upstreamHost);
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error(`relay upstream port is invalid (${upstreamPort})`);
  }
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new Error(`relay listen port is invalid (${listenPort})`);
  }

  const counters = {
    acceptedConnections: 0,
    successfulUpstreamConnections: 0,
    upstreamConnectionFailures: 0,
    downstreamErrors: 0,
    downstreamToUpstreamBytes: 0,
    upstreamToDownstreamBytes: 0,
    serverErrors: 0,
    lastUpstreamError: null,
    lastServerError: null,
  };
  const pairs = new Set();
  let bound = null;
  let readyState = false;
  let closing = false;
  let closePromise = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const server = net.createServer({ allowHalfOpen: true }, (downstream) => {
    if (closing) {
      downstream.destroy();
      return;
    }
    counters.acceptedConnections += 1;
    const pair = { downstream, upstream: null, downstreamClosed: false, upstreamClosed: false };
    pairs.add(pair);
    const removePairIfClosed = () => {
      if (pair.downstreamClosed && (pair.upstreamClosed || !pair.upstream)) pairs.delete(pair);
    };
    downstream.on('data', (chunk) => { counters.downstreamToUpstreamBytes += chunk.length; });
    downstream.on('error', () => { counters.downstreamErrors += 1; });
    downstream.on('close', () => {
      pair.downstreamClosed = true;
      if (pair.upstream && !pair.upstream.destroyed && !downstream.readableEnded) pair.upstream.destroy();
      removePairIfClosed();
    });

    let upstream;
    try {
      upstream = connectUpstream({ host: upstreamHost, port: upstreamPort, allowHalfOpen: true });
    } catch (error) {
      counters.upstreamConnectionFailures += 1;
      counters.lastUpstreamError = errorDetail(error);
      downstream.destroy();
      return;
    }
    pair.upstream = upstream;
    upstream.once('connect', () => { counters.successfulUpstreamConnections += 1; });
    upstream.on('data', (chunk) => { counters.upstreamToDownstreamBytes += chunk.length; });
    upstream.on('error', (error) => {
      counters.upstreamConnectionFailures += 1;
      counters.lastUpstreamError = errorDetail(error);
      downstream.destroy();
    });
    upstream.on('close', () => {
      pair.upstreamClosed = true;
      if (!downstream.destroyed && !upstream.readableEnded) downstream.destroy();
      removePairIfClosed();
    });
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });

  server.on('error', (error) => {
    counters.serverErrors += 1;
    counters.lastServerError = errorDetail(error);
    if (!readyState) readyReject(error);
  });
  server.listen({ host: LOOPBACK_HOST, port: listenPort, exclusive: true }, () => {
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== LOOPBACK_HOST || address.family !== 'IPv4') {
      const error = new Error(`relay did not bind IPv4 loopback (${JSON.stringify(address)})`);
      readyReject(error);
      server.close();
      return;
    }
    bound = { address: address.address, family: address.family, port: address.port, requestedPort: listenPort };
    readyState = true;
    readyResolve(bound);
  });

  const close = ({ timeoutMs = 5000 } = {}) => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      for (const pair of pairs) {
        pair.downstream.destroy();
        pair.upstream?.destroy();
      }
      const closeStarted = process.hrtime.bigint();
      if (server.listening) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`relay shutdown timed out after ${timeoutMs} ms`)), timeoutMs);
          server.close((error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          });
        });
      }
      const postCloseProbe = bound
        ? await probeTcpEndpoint({ host: LOOPBACK_HOST, port: bound.port, timeoutMs: Math.min(timeoutMs, 1000) })
        : { connected: false, elapsedMs: 0, error: null };
      if (postCloseProbe.connected) throw new Error(`relay listener ${LOOPBACK_HOST}:${bound.port} remained reachable after shutdown`);
      return {
        closed: true,
        listenerReachable: false,
        elapsedMs: Number(process.hrtime.bigint() - closeStarted) / 1e6,
        activeConnections: pairs.size,
      };
    })();
    return closePromise;
  };

  return {
    ready,
    get readyState() { return readyState; },
    endpoint() { return bound ? { ...bound } : null; },
    upstream: () => ({ host: upstreamHost, port: upstreamPort }),
    stats: () => ({ ...counters, activeConnections: pairs.size }),
    close,
  };
}
