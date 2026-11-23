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
let port;

const fake = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/api/version') return res.end('{"version":"test-1"}');
  if (req.method !== 'POST' || req.url !== '/api/chat' || !replies.length) {
    res.writeHead(400);
    return res.end('{}');
  }
  let text = '';
  for await (const chunk of req) text += chunk;
  requests.push(JSON.parse(text));
  res.end(JSON.stringify({ message: replies.shift() }));
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
  assert.equal(requests.length, 1);
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
  script();
  receipt(await run(['--self-test']), 2); // HTTP failure in chat

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
