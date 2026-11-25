#!/usr/bin/env node
// Host-free tests for the local-model loop's reference mode (#139 slice 2, src/mcp/openWebUiReference.ts and
// `--reference openwebui` in src/mcp/localModelLoop.ts): the reference flags and the token-file rules, the
// OpenAI-compatible SSE client against a fake Open WebUI, the fixed decoding on both sides, the comparison block,
// and a sentinel token that must never appear in any output or artifact. Run after `npm run compile`.
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const loop = require(join(root, 'out', 'mcp', 'localModelLoop.js'));
const ref = require(join(root, 'out', 'mcp', 'openWebUiReference.js'));
const bridge = require(join(root, 'out', 'mcp', 'ollamaMcpBridge.js'));
const mcpServer = require(join(root, 'out', 'mcp', 'benchmarkActorMcpServer.js'));

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
    process.exit(1);
  }
  checks += 1;
}
function throws(fn, pattern, msg, exitCode) {
  try {
    fn();
  } catch (error) {
    assert(pattern.test(String(error && error.message)), `${msg} (got: ${error && error.message})`);
    if (exitCode !== undefined) assert(error.exitCode === exitCode, `${msg}: exit ${exitCode} (got ${error.exitCode})`);
    return error;
  }
  assert(false, `${msg} (no error thrown)`);
}
async function rejects(fn, pattern, msg, check) {
  try {
    await fn();
  } catch (error) {
    assert(pattern.test(String(error && error.message)), `${msg} (got: ${error && error.message})`);
    if (check) check(error);
    return error;
  }
  assert(false, `${msg} (no error thrown)`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = mkdtempSync(join(tmpdir(), 'lba-loop-ref-'));
const { LOOP_EXIT } = loop;
const posix = process.platform !== 'win32';
// A recognizable value that is never a real credential; every output and artifact is grepped for it.
const SENTINEL = 'SENTINEL-TOKEN-6f1c0e7d-NEVER-LEAK';
const tokenFile = join(work, 'owui.key');
writeFileSync(tokenFile, `  ${SENTINEL}\n`, { mode: 0o600 });
if (posix) chmodSync(tokenFile, 0o600);
const hostPlatform = posix ? 'linux' : 'win32';
const refArgs = (endpoint, extra = []) => ['--reference', 'openwebui', '--endpoint', endpoint, '--token-file', tokenFile, '--reference-model', 'fast', ...extra];

// ---- 1. flags, fixed decoding and the token-file rules ---------------------------------------------------------
{
  const plain = loop.parseLoopArgs([], {}, 'linux', '/h');
  assert(plain.reference === undefined && plain.fixedDecoding === false && plain.seed === 42 && plain.maxTokens === 256, 'without --reference: no reference, Ollama defaults (seed 42 / 256 tokens only when asked)');
  const seeded = loop.parseLoopArgs(['--seed', '7', '--max-tokens', '64'], {}, 'linux', '/h');
  assert(seeded.fixedDecoding === true && seeded.seed === 7 && seeded.maxTokens === 64 && seeded.reference === undefined, '--seed / --max-tokens alone fix the local decoding');

  const cfg = loop.parseLoopArgs(refArgs('https://owui.example.invalid/base/', ['--reference-timeout-ms', '5000']), {}, hostPlatform, '/h');
  assert(cfg.reference.kind === 'openwebui' && cfg.reference.endpoint.href === 'https://owui.example.invalid/base/' && cfg.reference.model === 'fast' && cfg.reference.timeoutMs === 5000, 'the reference flags parse');
  assert(cfg.fixedDecoding === true && cfg.model === 'qwen2.5vl:3b', 'reference mode fixes decoding; --model stays the local Ollama model');
  assert(cfg.reference.token() === SENTINEL, 'the token is read and trimmed');
  assert(!JSON.stringify(cfg).includes(SENTINEL) && !inspect(cfg, { depth: 10 }).includes(SENTINEL), 'the token never serializes or inspects with the config');
  assert(loop.parseLoopArgs(refArgs('http://127.0.0.1:9/'), {}, hostPlatform, '/h').reference.endpoint.hostname === '127.0.0.1' && loop.parseLoopArgs(refArgs('http://localhost:9'), {}, hostPlatform, '/h').reference.endpoint.hostname === 'localhost', 'plain http only for 127.0.0.1 / localhost');
  assert(ref.referenceUrl(new URL('https://owui.example.invalid/base/'), '/api/models').href === 'https://owui.example.invalid/base/api/models', 'a base path is kept');

  let reads = 0;
  const ops = { stat: () => ({ isFile: () => true, mode: 0o100600 }), read: () => { reads += 1; return `${SENTINEL}\r\n`; } };
  const once = loop.parseLoopArgs(refArgs('https://owui.example.invalid'), {}, 'linux', '/h', ops);
  once.reference.token();
  once.reference.token();
  assert(reads === 1 && once.reference.token() === SENTINEL, 'the token file is read exactly once');

  const bad = [
    [['--reference', 'openai'], /--reference must be openwebui/],
    [['--endpoint', 'https://owui.example.invalid'], /--endpoint needs --reference openwebui/],
    [['--token-file', tokenFile], /--token-file needs --reference openwebui/],
    [['--reference-model', 'fast'], /--reference-model needs --reference openwebui/],
    [['--reference', 'openwebui', '--token-file', tokenFile, '--reference-model', 'fast'], /needs --endpoint/],
    [['--reference', 'openwebui', '--endpoint', 'https://owui.example.invalid', '--reference-model', 'fast'], /needs --token-file/],
    [['--reference', 'openwebui', '--endpoint', 'https://owui.example.invalid', '--token-file', tokenFile], /needs --reference-model/],
    [refArgs('http://owui.example.invalid'), /--endpoint must be an https URL/],
    [refArgs('ftp://127.0.0.1'), /--endpoint must be an https URL/],
    [refArgs('not a url'), /--endpoint must be an https URL/],
    [refArgs('https://user:pw@owui.example.invalid'), /must not carry credentials/],
    [refArgs('https://owui.example.invalid/?k=v'), /must not carry credentials, a query/],
    [[...refArgs('https://owui.example.invalid').slice(0, -1), 'fa st'], /--reference-model needs a model id/],
    [refArgs('https://owui.example.invalid', ['--reference-timeout-ms', '5']), /--reference-timeout-ms must be an integer/],
    [['--seed=-1'], /--seed must be an integer/],
    [['--max-tokens', '0'], /--max-tokens must be an integer from 1/]
  ];
  for (const [argv, pattern] of bad) throws(() => loop.parseLoopArgs(argv, {}, hostPlatform, '/h'), pattern, `rejects ${argv.join(' ')}`, LOOP_EXIT.usage);

  // Token-file failures: usage class, a clear message, never the content.
  const withFile = (name, content, mode) => {
    const file = join(work, name);
    writeFileSync(file, content);
    if (posix && mode !== undefined) chmodSync(file, mode);
    return file;
  };
  const tokenCases = [
    [join(work, 'missing.key'), /--token-file could not be read \(ENOENT\)/],
    [withFile('empty.key', '', 0o600), /--token-file is empty/],
    [withFile('blank.key', ' \n\t\n', 0o600), /--token-file is empty/],
    [withFile('two.key', `${SENTINEL} ${SENTINEL}\n`, 0o600), /visible ASCII/],
    [work, /--token-file must name a regular file/]
  ];
  if (posix) {
    tokenCases.push([withFile('group.key', SENTINEL, 0o640), /readable by its owner only \(chmod 600/]);
    tokenCases.push([withFile('world.key', SENTINEL, 0o644), /readable by its owner only/]);
  }
  for (const [file, pattern] of tokenCases) {
    const argv = ['--reference', 'openwebui', '--endpoint', 'https://owui.example.invalid', '--token-file', file, '--reference-model', 'fast'];
    const error = throws(() => loop.parseLoopArgs(argv, {}, hostPlatform, '/h'), pattern, `token file ${file.split(/[\\/]/).pop()}`, LOOP_EXIT.usage);
    assert(!error.message.includes(SENTINEL), `the token-file error never shows the content (${error.message})`);
  }
  const winLoose = loop.parseLoopArgs(refArgs('https://owui.example.invalid'), {}, 'win32', '/h', { stat: () => ({ isFile: () => true, mode: 0o100666 }), read: () => SENTINEL });
  assert(winLoose.reference.token() === SENTINEL, 'the owner-only check is POSIX only');
}

// ---- 2. pure helpers ----------------------------------------------------------------------------------------
{
  const body = ref.referenceChatBody('fast', { prompt: 'p', temperature: 0, seed: 42, maxTokens: 256 });
  assert(body.stream === true && body.temperature === 0 && body.seed === 42 && body.max_tokens === 256 && body.messages[0].content === 'p' && body.stream_options.include_usage === true, 'the OpenAI-compatible body: stream, temperature 0, seed, max_tokens');
  const vision = ref.referenceChatBody('fast', { prompt: 'p', image: Buffer.from('png'), temperature: 0, seed: 1, maxTokens: 2 });
  assert(vision.messages[0].content[1].image_url.url === `data:image/png;base64,${Buffer.from('png').toString('base64')}`, 'an image rides as a data URL');
  assert(ref.redact(`a${SENTINEL}b${SENTINEL}`, SENTINEL) === 'a[redacted]b[redacted]' && ref.redact('x', '') === 'x', 'redact replaces every occurrence');

  const samples = [
    { ms: 1000, gpus: [{ utilizationPct: 0, memoryUsedMb: 500 }] },
    { ms: 1100, gpus: [{ utilizationPct: 4, memoryUsedMb: 520 }] },
    { ms: 2000, gpus: [{ utilizationPct: 95, memoryUsedMb: 4000 }] },
    { ms: 2100, gpus: [{ utilizationPct: null, memoryUsedMb: 4100 }] }
  ];
  const idle = loop.gpuWindowStats(samples, 1000, 1500, 10, 100);
  assert(idle.sampleCount === 2 && idle.maxUtilizationPct === 4 && idle.meanUtilizationPct === 2 && idle.memoryUsedMb.min === 500 && idle.memoryUsedMb.max === 520 && idle.idle === true, `the idle control: ${JSON.stringify(idle)}`);
  const busy = loop.gpuWindowStats(samples, 1900, 2200, 10, 100);
  assert(busy.idle === false && busy.memoryUsedMb.max === 4100 && busy.maxUtilizationPct === 95, 'a busy window is not idle and has the VRAM peak');
  assert(loop.gpuWindowStats(samples, 5000, 6000, 10, 100).idle === null && loop.gpuWindowStats([], 0, 1, 10, 100).maxUtilizationPct === null, 'no samples: idle unknown');
  assert(loop.gpuWindowStats(samples.slice(0, 1).concat([{ ms: 1200, gpus: [{ utilizationPct: 1, memoryUsedMb: 900 }] }]), 1000, 1300, 10, 100).idle === false, 'a memory rise breaks the control');

  const side = loop.phaseSide({ promptSentMs: 100, firstTokenMs: 350, responseDoneMs: 2350 }, 50, 'tokens');
  assert(side.firstTokenMs === 250 && side.totalMs === 2250 && side.tokensPerSecond === 25 && side.outputUnit === 'tokens', `phase side: ${JSON.stringify(side)}`);
  assert(loop.phaseSide({}, null, 'chunks').tokensPerSecond === null && loop.phaseSide({ promptSentMs: 1, firstTokenMs: 2, responseDoneMs: 2 }, 3, 'chunks').tokensPerSecond === null, 'no rate without a generation interval');

  const frames = Array.from({ length: 20 }, (_, i) => ({ tMs: i * 500 }));
  const w = loop.planLoopClip(frames, 6000, 8000, [6300], 1000, 2000);
  assert(w.anchor === 'reference sent' && w.startInstantMs === 1000 && w.fromFrame === 2, 'in reference mode the clip starts 1 s before reference sent');
  assert(loop.planLoopClip(frames, 6000, 8000, [6300], 1000).anchor === 'prompt sent', 'without a reference instant the clip is unchanged');
  assert(loop.LOOP_EXIT.reference === 7 && loop.LOOP_EXIT.referenceTimeout === 8 && loop.LOOP_USAGE.includes('--reference openwebui --endpoint <https url> --token-file <path> --reference-model <id>'), 'exit codes 7/8 and the usage line');
}

// ---- 3. fake Open WebUI (/api/models, streamed /api/chat/completions) ------------------------------------------
const owui = { models: { status: 200, body: JSON.stringify({ data: [{ id: 'fast' }, { id: 'thinking' }, { id: 'coding' }] }) }, chat: [], requests: [], onChat: null };
const echo = (req) => JSON.stringify({ youSent: req.headers });
const owuiServer = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  owui.requests.push({ url: req.url, method: req.method, headers: req.headers, body: text });
  if (req.url.endsWith('/api/models')) {
    const reply = owui.models;
    // Some servers echo request headers back; the client must never surface them.
    res.writeHead(reply.status, { 'Content-Type': 'application/json', 'X-Echo-Authorization': String(req.headers.authorization) });
    return res.end(reply.echo ? echo(req) : reply.body);
  }
  if (req.url.endsWith('/api/chat/completions')) {
    owui.onChat?.();
    const reply = owui.chat.shift() ?? { status: 500, lines: [] };
    if (reply.delayMs) await sleep(reply.delayMs);
    res.writeHead(reply.status, { 'Content-Type': reply.status === 200 ? 'text/event-stream' : 'application/json', 'X-Echo-Authorization': String(req.headers.authorization) });
    if (reply.echo) return res.end(echo(req));
    for (const line of typeof reply.lines === 'function' ? reply.lines(req) : reply.lines) {
      res.write(line);
      await sleep(reply.gapMs ?? 5);
    }
    return res.end();
  }
  res.writeHead(404);
  res.end('{}');
});
await new Promise((resolve) => owuiServer.listen(0, '127.0.0.1', resolve));
const owuiUrl = `http://127.0.0.1:${owuiServer.address().port}/`;
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content, extra = {}) => sse({ choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }] });
const sseStream = (parts, { usage = { prompt_tokens: 12, completion_tokens: 40 }, done = true } = {}) => [
  ': keep-alive comment\n\n',
  sse({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
  ...parts.map((p) => delta(p)),
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ...(usage ? [sse({ choices: [], usage })] : []),
  ...(done ? ['data: [DONE]\n\n'] : [])
];
const refConfig = (overrides = {}) => ({ kind: 'openwebui', endpoint: new URL(owuiUrl), model: 'fast', timeoutMs: 5000, token: () => SENTINEL, ...overrides });
const request = { prompt: 'hello', temperature: 0, seed: 42, maxTokens: 256 };
const kindIs = (kind) => (error) => {
  assert(error.kind === kind, `kind ${kind} (got ${error.kind})`);
  assert(!error.message.includes(SENTINEL) && !String(error.stack).includes(SENTINEL), `the error never quotes the token (${error.message})`);
};

{
  const info = await ref.referencePreflight(refConfig());
  assert(info.id === 'fast' && info.listed === 3, 'preflight: the model is served');
  const pre = owui.requests.at(-1);
  assert(pre.method === 'GET' && pre.headers.authorization === `Bearer ${SENTINEL}` && !pre.url.includes(SENTINEL), 'the token is sent only as the Authorization header');
  await rejects(() => ref.referencePreflight(refConfig({ model: 'nope' })), /reference model nope is not served by the reference endpoint \(3 models listed\)/, 'a missing model', kindIs('prerequisite'));
  owui.models = { status: 401, echo: true };
  await rejects(() => ref.referencePreflight(refConfig()), /answered HTTP 401 \(check the token file\)$/, 'a refused token (the body echoes the headers)', kindIs('prerequisite'));
  owui.models = { status: 200, echo: true };
  await rejects(() => ref.referencePreflight(refConfig()), /did not answer like Open WebUI/, 'a body without data[] (an echo)', kindIs('prerequisite'));
  owui.models = { status: 200, body: 'not json' };
  await rejects(() => ref.referencePreflight(refConfig()), /did not answer like Open WebUI/, 'a non-JSON body', kindIs('prerequisite'));
  owui.models = { status: 200, body: JSON.stringify({ data: [{ id: 'fast' }, { id: 'thinking' }, { id: 'coding' }] }) };

  owui.requests.length = 0;
  const marks = [];
  owui.chat.push({ status: 200, lines: sseStream(['Hel', 'lo', ' there']) });
  const ok = await ref.runReferenceChat(refConfig(), request, { onSent: () => marks.push('sent'), onFirstToken: () => marks.push('first'), onDone: () => marks.push('done') });
  assert(ok.text === 'Hello there' && ok.chunks === 3 && ok.usage.completionTokens === 40 && ok.usage.promptTokens === 12 && ok.finishReason === 'stop' && ok.sawDone, `the SSE stream folds into one answer with usage: ${JSON.stringify({ ...ok, text: undefined })}`);
  assert(marks.join() === 'sent,first,done', `cues in order: ${marks}`);
  const chat = owui.requests.at(-1);
  const sentBody = JSON.parse(chat.body);
  assert(chat.method === 'POST' && chat.url === '/api/chat/completions' && chat.headers.authorization === `Bearer ${SENTINEL}` && chat.headers.accept === 'text/event-stream', 'POST /api/chat/completions with the bearer header');
  assert(!chat.body.includes(SENTINEL) && !chat.url.includes(SENTINEL) && sentBody.temperature === 0 && sentBody.seed === 42 && sentBody.max_tokens === 256 && sentBody.model === 'fast', 'the body carries the fixed options, never the token');

  owui.chat.push({ status: 200, lines: sseStream(['a', 'b'], { usage: null }) });
  const noUsage = await ref.runReferenceChat(refConfig(), request);
  assert(noUsage.usage.completionTokens === null && noUsage.chunks === 2, 'without usage the chunks are counted');
  owui.chat.push({ status: 200, lines: [delta('', { reasoning_content: 'think' }), delta('x'), sse({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { eval_count: 9 } })] });
  const thinking = await ref.runReferenceChat(refConfig(), request);
  owui.chat.push({ status: 200, lines: [delta('', { reasoning_content: 'hmm' }), delta('y'), 'data: [DONE]\n\n'] });
  const refOrder = [];
  await ref.runReferenceChat(refConfig(), request, { onFirstToken: () => refOrder.push('first'), onFirstAnswer: () => refOrder.push('answer') });
  assert(refOrder.join() === 'first,answer', `reference: reasoning is the first token, content the first answer (${refOrder})`);
  assert(thinking.reasoningChars === 5 && thinking.text === 'x' && thinking.chunks === 2 && thinking.usage.completionTokens === 9 && !thinking.sawDone && thinking.finishReason === 'length', 'reasoning deltas count as output; a finish_reason without [DONE] ends the stream; eval_count usage');

  const failures = [
    [{ status: 401, echo: true }, /answered HTTP 401 \(check the token file\)$/, 'run'],
    [{ status: 500, echo: true }, /answered HTTP 500$/, 'run'],
    [{ status: 200, lines: ['data: {nope\n\n'] }, /invalid JSON in the stream/, 'run'],
    [{ status: 200, lines: ['data: [1]\n\n'] }, /invalid chunk/, 'run'],
    [{ status: 200, lines: [sse({ error: { message: `bad token ${SENTINEL}` } })] }, /the stream reported an error$/, 'run'],
    [{ status: 200, lines: [delta('x')] }, /the stream ended before \[DONE\]/, 'run'],
    [{ status: 200, delayMs: 600, lines: sseStream(['late']) }, /timed out after 300 ms/, 'timeout'],
    [{ status: 200, gapMs: 400, lines: sseStream(['slow', 'er']) }, /timed out after 300 ms/, 'timeout']
  ];
  for (const [reply, pattern, kind] of failures) {
    owui.chat.push(reply);
    await rejects(() => ref.runReferenceChat(refConfig({ timeoutMs: 300 }), request), pattern, `reference failure ${pattern}`, kindIs(kind));
  }
  const gone = createServer();
  await new Promise((resolve) => gone.listen(0, '127.0.0.1', resolve));
  const gonePort = gone.address().port;
  await new Promise((resolve) => gone.close(resolve));
  await rejects(() => ref.runReferenceChat(refConfig({ endpoint: new URL(`http://127.0.0.1:${gonePort}`) }), request), /the reference endpoint is not reachable$/, 'an unreachable endpoint', kindIs('run'));
  await rejects(() => ref.referencePreflight(refConfig({ endpoint: new URL(`http://127.0.0.1:${gonePort}`) })), /the reference endpoint is not reachable$/, 'an unreachable preflight', kindIs('prerequisite'));
}

// ---- 4. fake Ollama (the REAL bridge runs: decoding options on /api/chat, eval_count stats) ----------------------
const gpu = { hot: false };
// #143: `capabilities` is what /api/show reports; a chat part is content text or { thinking } (a thinking model).
const ollama = { chat: [], requests: [], capabilities: ['completion', 'vision'], omitCounts: false };
const ollamaServer = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  ollama.requests.push({ url: req.url, raw: text, body: text ? JSON.parse(text) : null });
  const fixed = {
    '/api/version': '{"version":"0.40.18"}',
    '/api/tags': JSON.stringify({ models: [{ name: 'qwen2.5vl:3b', model: 'qwen2.5vl:3b', digest: 'd1g3st', size: 3200627168 }] }),
    '/api/show': JSON.stringify({ capabilities: ollama.capabilities }),
    '/api/generate': '{"done":true}'
  }[req.url];
  if (fixed) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(fixed);
  }
  if (req.url === '/api/chat') {
    gpu.hot = true;
    const parts = ollama.chat.shift() ?? ['Local', ' answer'];
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    await sleep(250);
    for (const part of parts) {
      const message = typeof part === 'string' ? { role: 'assistant', content: part } : { role: 'assistant', content: '', ...part };
      res.write(`${JSON.stringify({ message, done: false })}\n`);
      await sleep(100);
    }
    const done = { message: { role: 'assistant', content: '' }, done: true };
    if (!ollama.omitCounts) Object.assign(done, { eval_count: 30, eval_duration: 900000000, prompt_eval_count: 25 });
    res.write(`${JSON.stringify(done)}\n`);
    return res.end();
  }
  res.writeHead(404);
  res.end('{}');
});
await new Promise((resolve) => ollamaServer.listen(0, '127.0.0.1', resolve));
const ollamaUrl = `http://127.0.0.1:${ollamaServer.address().port}/`;

{
  const base = { model: 'qwen2.5vl:3b', endpoint: new URL(ollamaUrl), prompt: 'p', maxTurns: 1, allow: new Set(), stream: true, offerTools: false };
  const stats = [];
  ollama.requests.length = 0;
  const run = await bridge.runBridge({ ...base, options: { temperature: 0, seed: 42, num_predict: 256 } }, { onStats: (turn, s) => stats.push([turn, s]) });
  const body = ollama.requests.find((r) => r.url === '/api/chat').body;
  assert(!run.failure && body.options.temperature === 0 && body.options.seed === 42 && body.options.num_predict === 256, 'the bridge sends the decoding options');
  assert(stats.length === 1 && stats[0][0] === 0 && stats[0][1].evalCount === 30 && stats[0][1].evalDurationNs === 900000000 && stats[0][1].contentChunks === 2 && stats[0][1].streamChunks === 2 && stats[0][1].promptEvalCount === 25 && stats[0][1].thinkingChars === 0, `the done chunk's counts reach onStats: ${JSON.stringify(stats)}`);
  ollama.requests.length = 0;
  await bridge.runBridge(base, {});
  assert(!('options' in ollama.requests.find((r) => r.url === '/api/chat').body), 'without options the /api/chat body is unchanged');

  // #143: omitTools drops the `tools` key; omitTools false/absent leaves the body byte-for-byte as before.
  const chatRaw = async (config) => {
    ollama.requests.length = 0;
    const run = await bridge.runBridge(config, {});
    return { run, raw: ollama.requests.find((r) => r.url === '/api/chat').raw };
  };
  const tooled = { ...base, offerTools: true, allow: new Set([[...mcpServer.OLLAMA_DEFAULT_TOOLS][0]]) };
  const plain = await chatRaw(tooled);
  const explicitFalse = await chatRaw({ ...tooled, omitTools: false });
  assert(plain.raw === explicitFalse.raw && JSON.parse(plain.raw).tools.length === 1, 'omitTools false: the /api/chat body is byte-for-byte unchanged (tools key kept)');
  const omitted = await chatRaw({ ...tooled, omitTools: true });
  assert(!('tools' in JSON.parse(omitted.raw)) && omitted.run.toolsOffered.length === 0, 'omitTools: no tools key, nothing offered');

  // #143: thinking chunks before content: first token = the first thinking chunk, first answer = the first content.
  const order = [];
  const thinkStats = [];
  ollama.chat.push([{ thinking: 'Let me think' }, { thinking: ' more' }, 'Ans', 'wer']);
  const thought = await bridge.runBridge(base, {
    onFirstToken: () => order.push('first'), onFirstAnswer: () => order.push('answer'), onDone: () => order.push('done'),
    onStats: (_t, st) => thinkStats.push(st)
  });
  assert(thought.finalText === 'Answer' && order.join() === 'first,answer,done', `thinking before content: ${order}`);
  assert(thinkStats[0].thinkingChars === 17 && thinkStats[0].contentChunks === 2 && thinkStats[0].streamChunks === 4, `thinking characters and all stream deltas are counted: ${JSON.stringify(thinkStats)}`);
}

// ---- 5. the whole loop (fake ffmpeg / nvidia-smi, real bridge, fake Ollama + Open WebUI) ------------------------
const FRAME_PNG = Buffer.alloc(33);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(FRAME_PNG, 0);
FRAME_PNG.writeUInt32BE(13, 8);
FRAME_PNG.write('IHDR', 12, 'latin1');
FRAME_PNG.writeUInt32BE(64, 16);
FRAME_PNG.writeUInt32BE(48, 20);
const smiStamp = (ms) => {
  const d = new Date(ms);
  const p = (v, w = 2) => String(v).padStart(w, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
function fakeDeps(overrides = {}) {
  const state = { bridgeConfig: null };
  const deps = {
    platform: hostPlatform,
    env: {},
    now: () => Date.now(),
    sleep,
    root,
    resolveFfmpeg: () => '/fake/ffmpeg',
    x11VideoSize: async () => '640x480',
    startRecorder: (ffmpeg, args) => {
      const pattern = args.at(-1);
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        const file = pattern.replace('%05d', String(n).padStart(5, '0'));
        writeFileSync(file, FRAME_PNG);
        const at = Date.now() / 1000;
        utimesSync(file, at, at);
      }, 50);
      return { stop: async () => clearInterval(timer), lastError: () => '' };
    },
    startResourceSampler: () => ({ stop: () => undefined }),
    gpuRunner: () => async (args) => {
      if (args[0] === '--query-gpu=index,name') return '0, NVIDIA Fake RTX\n';
      return `${smiStamp(Date.now())}, ${gpu.hot ? 90 : 0}, ${gpu.hot ? 4000 : 500}, 30.00\n`;
    },
    bridge: (config, hooks) => {
      state.bridgeConfig = config;
      return bridge.runBridge(config, hooks);
    },
    clipRun: async (command, argv) => {
      if (argv.includes('-version')) return { stdout: 'ffmpeg version 8', stderr: '' };
      writeFileSync(argv.at(-1), Buffer.from('fake-mp4'));
      return { stdout: '', stderr: '' };
    },
    ...overrides
  };
  return { deps, state };
}
const io = () => {
  const o = { out: [], err: [] };
  return { o, io: { out: (t) => o.out.push(t), err: (t) => o.err.push(t) } };
};
const caps = join(work, 'caps');
const loopArgv = (extra = []) => ['--source', 'test', '--lead-ms', '300', '--tail-ms', '300', '--ollama', ollamaUrl, '--captures-dir', caps, ...refArgs(owuiUrl), ...extra];
function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}
/** Every stdout/stderr line, the argv and every file of every capture: none may hold the sentinel token. */
function assertNoSentinel(label, o, argv) {
  assert(!o.out.join('\n').includes(SENTINEL), `${label}: stdout is clean`);
  assert(!o.err.join('\n').includes(SENTINEL), `${label}: stderr is clean`);
  assert(!argv.join(' ').includes(SENTINEL), `${label}: argv is clean`);
  const leaks = existsSync(caps) ? filesUnder(caps).filter((file) => readFileSync(file).includes(SENTINEL)) : [];
  assert(leaks.length === 0, `${label}: no artifact holds the token (${leaks.join(', ')})`);
}
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Sentinel-token test: the full loop against the fake SSE server; every output and artifact is grepped.
{
  gpu.hot = false;
  owui.requests.length = 0;
  ollama.requests.length = 0;
  owui.onChat = () => { gpu.hot = false; };
  owui.chat.push({ status: 200, gapMs: 60, lines: sseStream(['The ', 'GPU ', 'runs ', 'the ', 'matrix ', 'maths.']) });
  const { deps, state } = fakeDeps();
  const r = io();
  const argv = loopArgv();
  const code = await loop.runLocalModelLoopCli(argv, r.io, deps);
  assert(code === 0, `reference loop exits 0 (stderr: ${r.o.err.join(' | ')})`);
  const receipt = JSON.parse(r.o.out.join('\n'));
  assertNoSentinel('sentinel token never leaks (full loop against a fake SSE server)', r.o, argv);
  const dir = receipt.captureDir;
  const chatReq = owui.requests.find((q) => q.url === '/api/chat/completions');
  assert(chatReq.headers.authorization === `Bearer ${SENTINEL}`, 'the reference chat carried the bearer header');
  const sent = JSON.parse(chatReq.body);
  const local = ollama.requests.find((q) => q.url === '/api/chat').body;
  assert(sent.temperature === 0 && local.options.temperature === 0 && sent.seed === local.options.seed && sent.seed === 42 && sent.max_tokens === local.options.num_predict && sent.max_tokens === 256, 'both sides: temperature 0, the same seed and max tokens');
  assert(sent.messages[0].content === local.messages[0].content && sent.messages[0].content === loop.LOOP_DEFAULTS.prompt, 'both sides get the same prompt');
  assert(state.bridgeConfig.model === 'qwen2.5vl:3b' && sent.model === 'fast', '--model is the local model, --reference-model the Open WebUI id');

  const c = receipt.comparison;
  assert(c.schema === loop.LOOP_COMPARISON_SCHEMA && c.models.reference === 'fast' && c.models.local === 'qwen2.5vl:3b' && c.decoding.seed === 42 && c.decoding.maxTokens === 256, 'the comparison block names both models and the decoding');
  assert(c.reference.outputTokens === 40 && c.reference.outputUnit === 'tokens' && c.reference.firstTokenMs > 0 && c.reference.totalMs >= c.reference.firstTokenMs && c.reference.tokensPerSecond > 0, `reference side: ${JSON.stringify(c.reference)}`);
  assert(c.local.outputTokens === 30 && c.local.outputUnit === 'tokens' && c.local.firstTokenMs >= 200 && c.local.totalMs > c.local.firstTokenMs && c.local.tokensPerSecond > 0, `local side: ${JSON.stringify(c.local)}`);
  assert(c.reference.gpuControl.idle === true && c.reference.gpuControl.sampleCount > 0 && c.reference.gpuControl.maxUtilizationPct === 0 && c.reference.gpuControl.memoryUsedMb.max === 500, `the laptop GPU stayed idle during the reference: ${JSON.stringify(c.reference.gpuControl)}`);
  assert(c.local.vramPeakMb === 4000 && c.local.maxUtilizationPct === 90 && c.local.toolCalls === 0, 'the local VRAM peak and utilization');
  assert(c.gpuEdges.length === 2 && c.gpuEdges.every((e) => e.duringReference === false && e.offsetFromPromptMs > -200), `GPU edges follow the local prompt, none during the reference: ${JSON.stringify(c.gpuEdges)}`);
  assert(receipt.reference.model === 'fast' && receipt.reference.modelsListed === 3 && receipt.reference.endpointScheme === 'http' && /^[0-9a-f]{64}$/.test(receipt.reference.endpointSha256), 'the reference identity is hashed, not the host');
  assert(!JSON.stringify(receipt).includes('127.0.0.1:' + owuiServer.address().port), 'the reference endpoint host never appears in the receipt');
  assert(receipt.reference.response.excerpt === 'The GPU runs the matrix maths.' && receipt.reference.response.sha256 === loop.sha256('The GPU runs the matrix maths.'), 'the reference answer is a hash + excerpt');
  assert(receipt.decoding.temperature === 0 && receipt.response.excerpt === 'Local answer', 'decoding block + local answer excerpt');

  const capture = readJson(join(dir, 'capture.json'));
  const labels = capture.markers.map((m) => m.label);
  const at = (label) => capture.markers.find((m) => m.label === label).instantMs;
  assert(['reference sent', 'reference first token', 'reference done', 'prompt sent', 'first token', 'response done'].every((l) => labels.includes(l)), `six cues on one axis: ${labels}`);
  assert(at('reference sent') < at('reference first token') && at('reference first token') <= at('reference done') && at('reference done') < at('prompt sent'), 'the reference phase precedes the local phase');
  assert(new Set(capture.markers.map((m) => m.id)).size === capture.markers.length && capture.markers.every((m, i, all) => i === 0 || all[i - 1].instantMs <= m.instantMs), 'unique ids, time order');
  assert(receipt.clip.window.anchor === 'reference sent' && receipt.clip.window.startInstantMs === receipt.reference.sentInstantMs - 1000, 'the clip includes the idle control');
  assert(JSON.stringify(readJson(join(dir, receipt.receiptFile))) === JSON.stringify(receipt), 'the written receipt equals the printed one');
  console.log(`  sample comparison block:\n${JSON.stringify(c, null, 2).split('\n').map((l) => `    ${l}`).join('\n')}`);
}

// The endpoint echoes the token everywhere it can (headers, content): the excerpt is redacted, nothing leaks.
{
  owui.chat.push({ status: 200, lines: (req) => sseStream([`echo ${req.headers.authorization} `, 'end'], { usage: null }) });
  const r = io();
  const argv = loopArgv(['--lead-ms', '0', '--tail-ms', '0']);
  assert(await loop.runLocalModelLoopCli(argv, r.io, fakeDeps().deps) === 0, 'an echoing endpoint still completes');
  const receipt = JSON.parse(r.o.out.join('\n'));
  assert(receipt.reference.response.excerpt === 'echo Bearer [redacted] end' && receipt.comparison.reference.outputUnit === 'chunks' && receipt.comparison.reference.outputTokens === 2, 'an echoed token is redacted; without usage the chunks are counted and labelled');
  assertNoSentinel('echoing endpoint', r.o, argv);
}

// Failures through the CLI: preflight 401 (exit 3, nothing created), HTTP error (7), timeout (8), bad token file (2).
{
  const before = existsSync(caps) ? readdirSync(caps).length : 0;
  owui.models = { status: 401, echo: true };
  let r = io();
  let argv = loopArgv();
  assert(await loop.runLocalModelLoopCli(argv, r.io, fakeDeps().deps) === LOOP_EXIT.prerequisite && r.o.out.length === 0 && /answered HTTP 401 \(check the token file\)/.test(r.o.err[0]), 'a refused token at preflight exits 3');
  assert(readdirSync(caps).length === before, 'a preflight failure creates no capture');
  assertNoSentinel('preflight 401', r.o, argv);
  owui.models = { status: 200, body: JSON.stringify({ data: [{ id: 'fast' }] }) };

  owui.chat.push({ status: 401, echo: true });
  r = io();
  argv = loopArgv(['--tail-ms', '0']);
  ollama.requests.length = 0;
  assert(await loop.runLocalModelLoopCli(argv, r.io, fakeDeps().deps) === LOOP_EXIT.reference, `an HTTP error from the reference exits 7 (${r.o.err.join(' | ')})`);
  const failed = JSON.parse(r.o.out[0]);
  assert(/answered HTTP 401/.test(failed.error) && failed.receiptFile === 'loop-receipt.json' && failed.clip === null && existsSync(join(failed.captureDir, 'capture.json')), 'the failed reference still writes its receipt and capture');
  assert(!ollama.requests.some((q) => q.url === '/api/chat'), 'the local phase is skipped after a reference failure');

  // A reference failure so fast that no frame was captured keeps the reference exit code.
  owui.chat.push({ status: 500, lines: [] });
  r = io();
  argv = loopArgv(['--lead-ms', '0', '--tail-ms', '0']);
  const blank = fakeDeps({ startRecorder: () => ({ stop: async () => undefined, lastError: () => '' }) }).deps;
  assert(await loop.runLocalModelLoopCli(argv, r.io, blank) === LOOP_EXIT.reference && /answered HTTP 500; the capture yielded no usable frames/.test(r.o.err.at(-1)), `a reference failure wins over an empty capture (${r.o.err.at(-1)})`);
  assertNoSentinel('reference HTTP 401 with echoed headers', r.o, argv);

  owui.chat.push({ status: 200, delayMs: 800, lines: sseStream(['late']) });
  r = io();
  argv = loopArgv(['--tail-ms', '0', '--reference-timeout-ms', '300']);
  assert(await loop.runLocalModelLoopCli(argv, r.io, fakeDeps().deps) === LOOP_EXIT.referenceTimeout && /timed out after 300 ms/.test(JSON.parse(r.o.out[0]).error), 'a reference timeout exits 8');
  assertNoSentinel('reference timeout', r.o, argv);

  r = io();
  argv = ['--source', 'test', '--ollama', ollamaUrl, '--captures-dir', caps, '--reference', 'openwebui', '--endpoint', owuiUrl, '--token-file', join(work, 'empty.key'), '--reference-model', 'fast'];
  assert(await loop.runLocalModelLoopCli(argv, r.io, fakeDeps().deps) === LOOP_EXIT.usage && r.o.err[0] === 'local-model-loop: --token-file is empty' && r.o.err[1] === loop.LOOP_USAGE, 'an empty token file is a usage error');
}

// ---- 6. #143 like-for-like: alias detection, --no-tools, prompt tokens, any-kind first token -------------------
{
  // Flags: --no-tools parses; with --allow-tool it is a usage error (exit 2).
  assert(loop.parseLoopArgs(['--no-tools'], {}, 'linux', '/h').noTools === true && loop.parseLoopArgs([], {}, 'linux', '/h').noTools === false, '--no-tools parses (default off)');
  throws(() => loop.parseLoopArgs(['--no-tools', '--allow-tool', 'x'], {}, 'linux', '/h'), /--no-tools and --allow-tool exclude each other/, '--no-tools + --allow-tool', LOOP_EXIT.usage);
  const r = io();
  assert(await loop.runLocalModelLoopCli(['--no-tools', '--allow-tool', 'x', '--source', 'test', '--captures-dir', caps], r.io, fakeDeps().deps) === LOOP_EXIT.usage && r.o.err[1] === loop.LOOP_USAGE && loop.LOOP_USAGE.includes('[--no-tools]'), 'the CLI exits 2 for --no-tools + --allow-tool');

  // Traits of /api/models entries: only booleans and the base id.
  const T = ref.referenceModelTraits;
  const aliasEntry = { id: 'fast', info: { base_model_id: 'gemma4:e4b', meta: { toolIds: ['tool-one'], builtinTools: { 'builtin-one': true }, defaultFeatureIds: ['feature-one'] } } };
  assert(JSON.stringify(T(aliasEntry)) === '{"alias":true,"baseModelId":"gemma4:e4b","hasTools":true,"hasDefaultFeatures":true}', `alias traits: ${JSON.stringify(T(aliasEntry))}`);
  assert(JSON.stringify(T({ id: 'gemma4:e4b' })) === '{"alias":false,"baseModelId":null,"hasTools":false,"hasDefaultFeatures":false}', 'a base entry');
  assert(JSON.stringify(T({ id: 'b', info: { base_model_id: '', meta: { toolIds: [], builtinTools: { a: false }, defaultFeatureIds: [] } } })) === '{"alias":false,"baseModelId":null,"hasTools":false,"hasDefaultFeatures":false}', 'empty values are not an alias, tools or features');
  assert(T({ id: 'odd', info: { base_model_id: 'has space; rm' } }).alias === true && T({ id: 'odd', info: { base_model_id: 'has space; rm' } }).baseModelId === null, 'an odd base id is an alias without an echoed id');
  assert(T({ id: 'x', info: { meta: { builtinTools: { a: true } } } }).hasTools === true, 'a true builtinTools value counts as tools');

  owui.models = { status: 200, body: JSON.stringify({ data: [aliasEntry, { id: 'gemma4:e4b', info: null }, { id: 'gemma4:26b' }] }) };
  ollama.capabilities = ['completion', 'tools'];
  const leakWords = ['tool-one', 'builtin-one', 'feature-one'];
  const runLoop = async (refModel, extra) => {
    gpu.hot = false;
    owui.onChat = () => { gpu.hot = false; };
    ollama.requests.length = 0;
    const o = io();
    const argv = ['--source', 'test', '--lead-ms', '100', '--tail-ms', '100', '--ollama', ollamaUrl, '--captures-dir', caps,
      '--reference', 'openwebui', '--endpoint', owuiUrl, '--token-file', tokenFile, '--reference-model', refModel, ...extra];
    const code = await loop.runLocalModelLoopCli(argv, o.io, fakeDeps().deps);
    assert(code === 0, `${refModel} ${extra.join(' ')}: exit 0 (${o.o.err.join(' | ')})`);
    assertNoSentinel(`#143 ${refModel}`, o.o, argv);
    const receipt = JSON.parse(o.o.out.join('\n'));
    const all = `${o.o.out.join('\n')}\n${o.o.err.join('\n')}\n${filesUnder(receipt.captureDir).map((f) => readFileSync(f, 'latin1')).join('\n')}`;
    assert(leakWords.every((w) => !all.includes(w)), `${refModel}: no tool or feature name of the entry in any output or artifact`);
    return { receipt, err: o.o.err, chat: ollama.requests.filter((q) => q.url === '/api/chat') };
  };

  // Alias: one warning line naming the base id and the flag; traits recorded; tools offered as before.
  owui.chat.push({ status: 200, lines: sseStream(['Red, ', 'yellow, ', 'blue.'], { usage: { prompt_tokens: 276, completion_tokens: 6 } }) });
  const alias = await runLoop('fast', []);
  const warnings = alias.err.filter((l) => /^warning:/.test(l));
  assert(warnings.length === 1 && warnings[0] === 'warning: reference model fast is an Open WebUI alias of gemma4:e4b; use --reference-model gemma4:e4b for a like-for-like comparison', `one alias warning: ${warnings}`);
  const traitsAlias = { alias: true, baseModelId: 'gemma4:e4b', hasTools: true, hasDefaultFeatures: true };
  assert(Object.entries(traitsAlias).every(([k, v]) => alias.receipt.reference[k] === v && alias.receipt.comparison.referenceModel[k] === v), `alias traits in the receipt: ${JSON.stringify(alias.receipt.comparison.referenceModel)}`);
  assert(alias.chat.length === 1 && Array.isArray(alias.chat[0].body.tools) && alias.chat[0].body.tools.length === mcpServer.OLLAMA_DEFAULT_TOOLS.size, 'without --no-tools the default tools are offered');
  assert(alias.receipt.model.toolsOffered.length === mcpServer.OLLAMA_DEFAULT_TOOLS.size && alias.receipt.comparison.local.toolsOffered.length === mcpServer.OLLAMA_DEFAULT_TOOLS.size, 'toolsOffered lists them');
  assert(alias.receipt.comparison.reference.promptTokens === 276 && alias.receipt.comparison.local.promptTokens === 25, 'prompt tokens on both sides show the mismatch');

  // Without --no-tools the /api/chat body is byte-for-byte the same with and without an unrelated flag.
  owui.chat.push({ status: 200, lines: sseStream(['x']) });
  const unrelated = await runLoop('fast', ['--gpu-threshold-pct', '20', '--fps', '5']);
  assert(unrelated.chat[0].raw === alias.chat[0].raw && Object.keys(alias.chat[0].body).join() === 'model,stream,messages,tools,options', 'the /api/chat body is byte-for-byte unchanged by unrelated flags');

  // Base tag + --no-tools: no warning, no tools key, toolsOffered [], equal prompt tokens.
  owui.chat.push({ status: 200, lines: sseStream(['Red, ', 'yellow, ', 'blue.'], { usage: { prompt_tokens: 25, completion_tokens: 6 } }) });
  const parity = await runLoop('gemma4:e4b', ['--no-tools']);
  assert(!parity.err.some((l) => /^warning:/.test(l)), 'no warning for a base entry');
  assert(parity.receipt.reference.alias === false && parity.receipt.reference.baseModelId === null && parity.receipt.comparison.referenceModel.hasTools === false && parity.receipt.comparison.referenceModel.hasDefaultFeatures === false, 'base traits in the receipt');
  assert(parity.chat.length === 1 && !('tools' in parity.chat[0].body) && !parity.chat[0].raw.includes('"tools"'), '--no-tools: the Ollama request has no tools key');
  assert(Array.isArray(parity.receipt.model.toolsOffered) && parity.receipt.model.toolsOffered.length === 0 && parity.receipt.comparison.local.toolsOffered.length === 0, '--no-tools: toolsOffered is []');
  assert(parity.receipt.comparison.reference.promptTokens === 25 && parity.receipt.comparison.local.promptTokens === 25, 'equal prompt tokens');

  // Gap 3: thinking before content on both sides. first token = any kind, first answer = content, rate over first token -> done.
  ollama.omitCounts = true;
  ollama.chat.push([{ thinking: 'Let me think' }, { thinking: ' more' }, { thinking: ' still' }, 'Ans', 'wer']);
  owui.chat.push({ status: 200, gapMs: 60, lines: [delta('', { reasoning_content: 'mull' }), delta('', { reasoning_content: 'ing' }), delta('Red'), sse({ choices: [], usage: { prompt_tokens: 25, completion_tokens: 20 } }), 'data: [DONE]\n\n'] });
  const think = await runLoop('gemma4:e4b', ['--no-tools']);
  const cl = think.receipt.comparison.local;
  const cr = think.receipt.comparison.reference;
  assert(cl.firstTokenMs !== null && cl.firstAnswerMs - cl.firstTokenMs >= 250 && cl.thinkingChars === 23, `local: thinking is the first token, the answer starts later: ${JSON.stringify(cl)}`);
  assert(cl.outputUnit === 'chunks' && cl.outputTokens === 5 && cl.tokensPerSecond === Math.round((5 / ((cl.totalMs - cl.firstTokenMs) / 1000)) * 100) / 100, 'without eval_count, local fallback counts thinking and content stream chunks');
  assert(cr.firstAnswerMs - cr.firstTokenMs >= 100 && cr.reasoningChars === 7 && cr.tokensPerSecond === Math.round((20 / ((cr.totalMs - cr.firstTokenMs) / 1000)) * 100) / 100, `reference: reasoning first, same rate rule: ${JSON.stringify(cr)}`);
  assert(think.receipt.timing.firstAnswerLatencyMs === cl.firstAnswerMs && think.receipt.timing.firstTokenLatencyMs === cl.firstTokenMs, 'timing block has both latencies');
  const labels = think.receipt.cues.map((c) => c.label);
  const order = ['reference sent', 'reference first token', 'reference answer started', 'reference done', 'prompt sent', 'first token', 'answer started', 'response done'];
  assert(order.every((l) => labels.includes(l)) && order.every((l, i) => i === 0 || labels.indexOf(order[i - 1]) < labels.indexOf(l)), `eight cues in order: ${labels}`);
  console.log(`  sample comparison block (#143, --no-tools, thinking model):\n${JSON.stringify(think.receipt.comparison, null, 2).split('\n').map((l) => `    ${l}`).join('\n')}`);

  ollama.omitCounts = false;
  owui.onChat = null;
  ollama.capabilities = ['completion', 'vision'];
  owui.models = { status: 200, body: JSON.stringify({ data: [{ id: 'fast' }] }) };
}

// Without --reference nothing changes: no options on /api/chat, no decoding/reference/comparison in the receipt.
{
  const { deps, state } = fakeDeps();
  ollama.requests.length = 0;
  const receipt = await loop.runLocalModelLoop(loop.parseLoopArgs(['--source', 'test', '--lead-ms', '0', '--tail-ms', '0', '--ollama', ollamaUrl, '--captures-dir', caps], {}, hostPlatform, work), deps);
  assert(state.bridgeConfig.options === undefined && !('options' in ollama.requests.find((q) => q.url === '/api/chat').body), 'no decoding options without --reference/--seed/--max-tokens');
  assert(!('decoding' in receipt) && !('reference' in receipt) && !('comparison' in receipt) && receipt.cues.every((cue) => cue.source !== 'openwebui-reference'), 'the receipt has no reference keys');
}

// A real child process (real ffmpeg lavfi source, no GPU): the token is absent from its stdout/stderr and artifacts.
let ffmpegPresent = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
  ffmpegPresent = true;
} catch {
  /* no ffmpeg on this host: the in-process runs above cover the loop */
}
if (ffmpegPresent) {
  owui.chat.push({ status: 200, lines: sseStream(['child ', 'process']) });
  const argv = [join(root, 'out', 'mcp', 'localModelLoop.js'), ...loopArgv(['--lead-ms', '500', '--tail-ms', '500', '--nvidia-smi', join(work, 'no-nvidia-smi')])];
  const child = await new Promise((resolve) => {
    execFile(process.execPath, argv, { windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  assert(child.code === 0, `the CLI child exits 0 (${String(child.stderr).split('\n').slice(-3).join(' | ')})`);
  assertNoSentinel('child process', { out: [String(child.stdout)], err: [String(child.stderr)] }, argv);
  const receipt = JSON.parse(child.stdout);
  assert(receipt.comparison.reference.outputTokens === 40 && receipt.clip.sizeBytes > 0, 'the child wrote the comparison and the clip');
  console.log(`  child: ${receipt.frameCount} frames, reference ${receipt.comparison.reference.totalMs} ms, local ${receipt.comparison.local.totalMs} ms`);
} else {
  console.log('  child process: skipped (no ffmpeg on PATH)');
}

await new Promise((resolve) => owuiServer.close(resolve));
await new Promise((resolve) => ollamaServer.close(resolve));
rmSync(work, { recursive: true, force: true });
console.log(`local-model-loop-reference: ${checks} checks passed`);
