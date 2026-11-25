// LBA-REQ-019 / T-019: exercise the compiled CLI and real stdio server without Ollama or a live bus.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_ACTOR_MCP_TOOLS } from '../out/mcp/benchmarkActorMcpServer.js';
import { ACG_GRID_TOOLS } from '../out/acg-mcp-bundle/acg-mcp/grid-tools.mjs';

const bundle = fileURLToPath(new URL('../out/mcp/', import.meta.url));
const entry = 'ollamaMcpBridge.js';
const cwd = await mkdtemp(join(tmpdir(), 'bridge test '));
const registry = [...BENCHMARK_ACTOR_MCP_TOOLS, ...ACG_GRID_TOOLS];
const defaults = ['get_host_capabilities', 'get_benchmark_series', 'poll_coordination_bus'];
const hash = text => createHash('sha256').update(text).digest('hex');
const done = { role: 'assistant', content: 'Probe complete.' };
const toolCall = (name, args = {}) => ({ function: { name, arguments: args } });
const calls = (...tool_calls) => ({ role: 'assistant', content: '', tool_calls });
const requests = [];
let replies;
let versionReply;
let redirectHits = 0;
let port;
// Sent inside the prefix of a cut-off body, before the socket is destroyed: it must never be echoed.
const CUT_MARKER = 'CUT_PREFIX_MARKER_' + 'sent-before-the-cut-'.repeat(3);
// Neither valid gzip nor valid brotli; it carries both markers so a leak of any decoded or raw byte shows.
const CORRUPT = `not compressed data at all, CHAT_BODY_MARKER ${CUT_MARKER}`;

// A scripted raw reply: { status, body, headers, short } or { truncate: true } (headers plus half a body, then
// reset). With short, Content-Length claims that many bytes more than the body, and the socket is destroyed.
function send(res, reply) {
  if (reply.truncate) {
    const sent = `{"version":"${CUT_MARKER}","message":{"role":"assistant","content":"${CUT_MARKER}`;
    res.writeHead(200, { 'Content-Length': String(sent.length * 2) });
    res.write(sent, () => res.socket.destroy());
    return;
  }
  if (reply.short) {
    res.writeHead(reply.status, { ...reply.headers, 'Content-Length': String(Buffer.byteLength(reply.body) + reply.short) });
    res.write(reply.body, () => res.socket.destroy());
    return;
  }
  res.writeHead(reply.status, reply.headers ?? {});
  res.end(reply.body ?? '{}');
}

const fake = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/redirect-target') {
    redirectHits++;
    return res.end('{"version":"redirected","message":{"role":"assistant","content":""}}');
  }
  if (req.method === 'GET' && req.url === '/api/version') {
    return versionReply ? send(res, versionReply) : res.end('{"version":"test-1"}');
  }
  if (req.method !== 'POST' || req.url !== '/api/chat') {
    res.writeHead(400);
    return res.end('{}');
  }
  // Record every chat attempt before looking at the queue, so an extra turn is always counted.
  let text = '';
  for await (const chunk of req) text += chunk;
  requests.push(JSON.parse(text));
  const reply = replies.shift();
  if (!reply || reply.status || reply.truncate) return send(res, reply ?? { status: 400 });
  res.end(JSON.stringify({ message: reply }));
});

function run(args, script = join(bundle, entry), env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, '--model', 'test-model', ...args], {
      cwd, timeout: 20_000, env: { ...process.env, LBA_LBABUS_PATH: process.execPath,
        OLLAMA_HOST: `127.0.0.1:${port}`, ...env }
    }, (err, stdout, stderr) => {
      if (err && (err.killed || typeof err.code !== 'number')) return reject(err);
      resolve({ code: err?.code ?? 0, stdout: stdout.trim(), stderr });
    });
  });
}
function script(...steps) {
  replies = steps;
  requests.length = 0;
  versionReply = undefined;
  redirectHits = 0;
}
function receipt(result, code) {
  assert.equal(result.code, code, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.exitCode, code);
  return value;
}

try {
  // The real server execs "capabilities" as an argv element. A tiny Node fixture makes that probe portable.
  await writeFile(join(cwd, 'capabilities'), 'console.log("fixture capability");\n');
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  port = fake.address().port;

  script(calls(toolCall('get_host_capabilities')), done);
  const success = receipt(await run(['--self-test', '--ollama', `http://127.0.0.1:${port}`],
    undefined, { OLLAMA_HOST: '127.0.0.1:0' }), 0);
  assert.deepEqual(success, {
    ollamaVersion: 'test-1', model: 'test-model', toolsListed: registry.map(t => t.name),
    toolCalls: [{ name: 'get_host_capabilities', argumentsSha256: hash('{}'), ok: true }],
    finalTextSha256: hash(done.content), exitCode: 0
  });
  console.log('Ollama self-test receipt:', JSON.stringify(success));
  assert.equal(requests[0].stream, false);
  assert.equal(requests[0].model, 'test-model');
  assert.match(requests[0].messages[0].content, /get_host_capabilities/);
  assert.deepEqual(requests[0].tools, registry.filter(t => defaults.includes(t.name)).map(t => ({
    type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema }
  })));
  assert.deepEqual(requests[1].messages.map(m => m.role), ['user', 'assistant', 'tool']);
  const [probe] = JSON.parse(requests[1].messages[2].content).content;
  assert.equal(probe.text, 'fixture capability');

  script(calls(toolCall('post_coordination_note', { message: 'not sent' }), toolCall('teardown'),
    toolCall('not_listed'), toolCall('get_benchmark_series', '{}')), done);
  const mixed = receipt(await run(['--prompt', 'Inspect', '--json', '--allow-tool', 'not_listed']), 1);
  assert.deepEqual(mixed.toolCalls.map(c => c.ok), [false, false, false, true]);
  const history = requests[1].messages;
  assert.equal(history[0].content, 'Inspect');
  for (const msg of history.slice(2, 5)) assert.match(msg.content, /not allowed/i);
  assert.deepEqual(history[1].tool_calls[3].function.arguments, {});
  assert.match(history[5].content, /seriesHash/);
  assert.equal(history[5].tool_name, 'get_benchmark_series');

  script(calls(toolCall('spin_up_witness', '{"plane":"WIN"}')));
  const limited = receipt(await run(['--self-test', '--max-turns', '1', '--allow-tool', 'spin_up_witness',
    '--allow-tool', 'post_coordination_note']), 0);
  assert.deepEqual(limited.toolCalls, [{ name: 'spin_up_witness', argumentsSha256: hash('{"plane":"WIN"}'), ok: true }]);
  assert.equal(limited.finalTextSha256, hash(''));
  assert.equal(requests.length, 1); // max-turns-records-every-attempt
  for (const name of ['spin_up_witness', 'post_coordination_note']) {
    assert.deepEqual(requests[0].tools.find(t => t.function.name === name).function.parameters,
      registry.find(t => t.name === name).inputSchema);
  }

  script(calls(toolCall('poll_coordination_bus', { tail: -1 }), toolCall('get_host_capabilities'),
    toolCall('poll_coordination_bus', 'not json')), done);
  const failed = receipt(await run(['--self-test'], undefined, { LBA_LBABUS_PATH: join(cwd, 'absent') }), 1);
  assert.deepEqual(failed.toolCalls.map(c => c.ok), [false, false, false]);
  assert.match(requests[1].messages[2].content, /integer/);
  assert.equal(JSON.parse(requests[1].messages[3].content).isError, true);
  assert.match(requests[1].messages[4].content, /JSON object/);

  script(done);
  assert.deepEqual(receipt(await run(['--self-test']), 1).toolCalls, []);
  script(done);
  assert.equal((await run([])).stdout, done.content);
  assert.match((await run(['--max-turns', '0'])).stderr, /--max-turns/);
  assert.equal((await run(['--prompt', 'x', '--self-test'])).code, 1);
  // unlisted-tool-name-redacted: an invented name is model text and must never be echoed.
  const marker = 'IGNORE_PREVIOUS_INSTRUCTIONS_' + 'leaked-tool-result-text-'.repeat(12);
  script(calls(toolCall(marker, { q: 1 })), done);
  const unlistedRun = await run(['--self-test', '--json']);
  const unlisted = receipt(unlistedRun, 1);
  for (const out of [unlistedRun.stdout, unlistedRun.stderr]) assert.equal(out.includes(marker), false);
  assert.deepEqual(unlisted.toolCalls, [{ name: 'unlisted', nameSha256: `sha256:${hash(marker)}`,
    argumentsSha256: hash('{"q":1}'), ok: false }]);
  assert.match(requests[1].messages[2].content, /not allowed/i);
  console.log('unlisted-tool-name-redacted: PASS');

  // assistant-turn-replayed-verbatim: thinking, call ids and function.index go back to Ollama unchanged.
  const thinking = 'THINKING_MARKER_' + 'private-reasoning-'.repeat(4);
  const callId = 'CALL_ID_MARKER_' + 'call-0-'.repeat(4);
  const index = 731_942_068;
  const rich = { role: 'assistant', content: '', thinking,
    tool_calls: [{ id: callId, function: { index, name: 'get_host_capabilities', arguments: {} } }] };
  script(rich, done);
  const richRun = await run(['--self-test']);
  receipt(richRun, 0);
  assert.deepEqual(requests[1].messages[1], rich);
  for (const out of [richRun.stdout, richRun.stderr]) {
    for (const value of [thinking, callId, String(index)]) assert.equal(out.includes(value), false, value);
  }
  console.log('assistant-turn-replayed-verbatim: PASS');

  // chat-404-exit-1: both services answered, so a chat HTTP error is a failed self-test, not unreachable.
  const body = 'CHAT_BODY_MARKER model "test-model" not found';
  script({ status: 404, body });
  const notFound = await run(['--self-test']);
  assert.deepEqual(receipt(notFound, 1).toolCalls, []);
  assert.equal(requests.length, 1);
  assert.match(notFound.stderr, /HTTP 404/);
  for (const out of [notFound.stdout, notFound.stderr]) assert.equal(out.includes('CHAT_BODY_MARKER'), false);
  console.log('chat-404-exit-1: PASS');

  // connection-refused-exit-2: no HTTP status ever arrived.
  const gone = createServer();
  gone.listen(0, '127.0.0.1');
  await once(gone, 'listening');
  const refusedPort = gone.address().port;
  await new Promise(resolve => gone.close(resolve));
  const refused = await run(['--self-test', '--ollama', `http://127.0.0.1:${refusedPort}`]);
  assert.equal(receipt(refused, 2).ollamaVersion, '');
  assert.equal(refused.stderr.includes('CHAT_BODY_MARKER'), false);
  console.log('connection-refused-exit-2: PASS');

  // fake-counts-post-after-queue-empty: the fake itself must count a chat POST it has no reply for.
  script();
  const extra = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', body: '{}' });
  await extra.text();
  assert.equal(extra.status, 400);
  assert.equal(requests.length, 1);
  console.log('fake-counts-post-after-queue-empty: PASS');

  // A fully read and decoded but unusable response means Ollama was reached: exit 1, never the body in the output.
  const unusable = [
    ['version-null-exit-1', () => { versionReply = { status: 200, body: 'null' }; }, 0],
    ['chat-null-exit-1', () => { replies.push({ status: 200, body: 'null' }); }, 1],
    ['chat-non-json-exit-1', () => { replies.push({ status: 200, body: 'CHAT_BODY_MARKER <html>' }); }, 1],
    ['tool-call-without-function-exit-1', () => { replies.push({ role: 'assistant', content: '',
      tool_calls: [{ CHAT_BODY_MARKER: true }] }); }, 1],
    ['redirect-302-exit-1', () => { replies.push({ status: 302, body: 'CHAT_BODY_MARKER',
      headers: { Location: '/redirect-target' } }); }, 1]
  ];
  for (const [name, setup, chats] of unusable) {
    script();
    setup();
    const result = await run(['--self-test']);
    assert.deepEqual(receipt(result, 1).toolCalls, [], name);
    assert.equal(requests.length, chats, name);
    for (const out of [result.stdout, result.stderr]) assert.equal(out.includes('CHAT_BODY_MARKER'), false, name);
    if (name.startsWith('redirect')) {
      assert.match(result.stderr, /HTTP 302/);
      assert.equal(redirectHits, 0, 'the redirect target is never requested');
    }
    console.log(`${name}: PASS`);
  }

  // A body that could not be read in full or decoded is exit 2 with one fixed diagnostic, never its bytes.
  // fetch cannot tell a corrupt encoding from a cut transfer, so a complete corrupt body is 2 as well.
  const corrupt = (encoding, short = 0) => ({ status: 200, body: CORRUPT, short,
    headers: { 'Content-Encoding': encoding, 'Content-Length': String(Buffer.byteLength(CORRUPT)) } });
  const unreadable = [
    ['bad-gzip-complete-exit-2', 'version', corrupt('gzip')],
    ['bad-gzip-complete-exit-2', 'chat', corrupt('gzip')],
    ['bad-brotli-complete-exit-2', 'chat', corrupt('br')],
    ['bad-gzip-truncated-exit-2', 'version', corrupt('gzip', 65)],
    ['bad-gzip-truncated-exit-2', 'chat', corrupt('gzip', 65)],
    ['body-cut-mid-stream-exit-2', 'version', { truncate: true }],
    ['body-cut-mid-stream-exit-2', 'chat', { truncate: true }]
  ];
  for (const [name, where, reply] of unreadable) {
    script();
    if (where === 'version') versionReply = reply;
    else replies.push(reply);
    const result = await run(['--self-test']);
    const label = `${name} (${where})`;
    assert.equal(receipt(result, 2).finalTextSha256, hash(''), label);
    assert.equal(requests.length, where === 'chat' ? 1 : 0, label);
    assert.match(result.stderr, new RegExp(`^Ollama ${where} failed: body could not be read or decoded\\.$`, 'm'), label);
    for (const out of [result.stdout, result.stderr]) {
      for (const leak of [CUT_MARKER, 'CHAT_BODY_MARKER', 'not compressed']) assert.equal(out.includes(leak), false, label);
    }
    console.log(`${label}: PASS`);
  }

  for (const file of [entry, 'benchmarkActorMcpServer.js']) await copyFile(join(bundle, file), join(cwd, file));
  assert.deepEqual(receipt(await run(['--self-test'], join(cwd, entry)), 2).toolsListed, []);
} finally {
  await new Promise(resolve => fake.close(resolve));
  try {
    if (port) assert.equal(receipt(await run(['--self-test']), 2).ollamaVersion, '');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
console.log('Ollama bridge: PASS');
