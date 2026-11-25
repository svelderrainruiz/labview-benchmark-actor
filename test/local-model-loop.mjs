#!/usr/bin/env node
// Host-free tests for the local-model loop (#134 slice 4, src/mcp/localModelLoop.ts): argument validation and the
// Windows/Linux/macOS captures-root defaults, the capture-source planning (shared ffmpeg argv in
// src/capturePlatform.ts), the Ollama preflight, the clip window, the cue ordering and the receipt -- with fakes
// for ffmpeg (frame recorder + clip encoder), the Ollama HTTP API (incl. the streamed /api/chat) and nvidia-smi.
// When a real ffmpeg is on PATH, one end-to-end run records the lavfi test source. Run after `npm run compile`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const loop = require(join(root, 'out', 'mcp', 'localModelLoop.js'));
const platformMod = require(join(root, 'out', 'capturePlatform.js'));
const bridge = require(join(root, 'out', 'mcp', 'ollamaMcpBridge.js'));

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
async function rejects(fn, pattern, msg, exitCode) {
  try {
    await fn();
  } catch (error) {
    assert(pattern.test(String(error && error.message)), `${msg} (got: ${error && error.message})`);
    if (exitCode !== undefined) assert(error.exitCode === exitCode, `${msg}: exit ${exitCode} (got ${error.exitCode})`);
    return error;
  }
  assert(false, `${msg} (no error thrown)`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = mkdtempSync(join(tmpdir(), 'lba-loop-'));
const { LOOP_EXIT } = loop;

// ---- 1. arguments + captures-root defaults ---------------------------------------------------------------------
{
  const linux = loop.parseLoopArgs([], {}, 'linux', '/home/op');
  assert(linux.source === 'desktop' && linux.fps === 4 && linux.leadMs === 2000 && linux.tailMs === 3000, 'defaults: desktop source, 4 fps, 2 s lead, 3 s tail');
  assert(linux.model === 'qwen2.5vl:3b' && linux.endpoint.href === 'http://127.0.0.1:11434/' && linux.prompt.length > 0, 'defaults: qwen2.5vl:3b on 127.0.0.1:11434 with a fixed prompt');
  assert(linux.allowTools.length === 0 && linux.maxTurns === 4 && linux.cold === false && linux.nvidiaSmi === 'nvidia-smi' && linux.image === undefined && linux.ffmpeg === undefined, 'defaults: no extra tools, warm model, nvidia-smi on PATH');
  assert(linux.gpuThresholdPct === 10 && linux.gpuMemoryRiseMb === 100, 'defaults: the slice-2 GPU cue thresholds');
  assert(linux.capturesDir === '/home/op/.config/Code/User/globalStorage/svelderrainruiz.labview-benchmark-actor/captures', `Linux default captures root: ${linux.capturesDir}`);
  assert(loop.parseLoopArgs([], { XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/op').capturesDir === '/xdg/Code/User/globalStorage/svelderrainruiz.labview-benchmark-actor/captures', 'XDG_CONFIG_HOME moves the Linux root');
  const win = loop.parseLoopArgs([], { APPDATA: 'C:\\Users\\op\\AppData\\Roaming' }, 'win32', 'C:\\Users\\op');
  assert(win.capturesDir === 'C:\\Users\\op\\AppData\\Roaming\\Code\\User\\globalStorage\\svelderrainruiz.labview-benchmark-actor\\captures', `Windows default captures root: ${win.capturesDir}`);
  assert(loop.parseLoopArgs([], {}, 'win32', 'C:\\Users\\op').capturesDir === 'C:\\Users\\op\\AppData\\Roaming\\Code\\User\\globalStorage\\svelderrainruiz.labview-benchmark-actor\\captures', 'without APPDATA Windows falls back to the roaming profile');
  assert(loop.parseLoopArgs([], {}, 'darwin', '/Users/op').capturesDir === '/Users/op/Library/Application Support/Code/User/globalStorage/svelderrainruiz.labview-benchmark-actor/captures', 'macOS default captures root');
  assert(platformMod.defaultCapturesDir('linux', {}, '/h') === loop.parseLoopArgs([], {}, 'linux', '/h').capturesDir, 'the CLI default is capturePlatform.defaultCapturesDir');

  const png = join(work, 'in.png');
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
  const full = loop.parseLoopArgs(['--source', 'test', '--fps', '2.5', '--lead-ms', '0', '--tail-ms', '10', '--model', ' m:1 ', '--ollama', '127.0.0.1:11535',
    '--prompt', 'hi', '--image', png, '--allow-tool', 'export_capture_clip', '--allow-tool', 'add_capture_marker', '--max-turns', '2', '--cold',
    '--captures-dir', join(work, 'caps'), '--ffmpeg', '/opt/ffmpeg', '--nvidia-smi', '/usr/bin/nvidia-smi', '--gpu-threshold-pct', '12.5', '--gpu-memory-rise-mb', '200'], {}, 'linux', '/h');
  assert(full.source === 'test' && full.fps === 2.5 && full.leadMs === 0 && full.tailMs === 10 && full.model === 'm:1' && full.endpoint.href === 'http://127.0.0.1:11535/', 'every option parses (a bare host:port gets http://)');
  assert(full.image === png && full.allowTools.join() === 'export_capture_clip,add_capture_marker' && full.maxTurns === 2 && full.cold === true, '--image, repeated --allow-tool, --max-turns, --cold');
  assert(full.ffmpeg === '/opt/ffmpeg' && full.nvidiaSmi === '/usr/bin/nvidia-smi' && full.gpuThresholdPct === 12.5 && full.gpuMemoryRiseMb === 200, '--ffmpeg, --nvidia-smi and the cue thresholds');

  const bad = [
    [['--source', 'screen'], /--source must be desktop or test/],
    [['--fps', '0'], /--fps: /],
    [['--fps', '31'], /--fps: /],
    [['--fps', 'x'], /--fps: /],
    [['--lead-ms=-1'], /--lead-ms must be an integer/],
    [['--lead-ms', '1.5'], /--lead-ms must be an integer/],
    [['--tail-ms', '600001'], /--tail-ms must be an integer from 0 through 600000/],
    [['--max-turns', '0'], /--max-turns must be an integer from 1 through 32/],
    [['--model', '  '], /--model must not be empty/],
    [['--ollama', 'ftp://x'], /--ollama must be an http\(s\) URL/],
    [['--ollama', 'http://['], /--ollama must be an http\(s\) URL/],
    [['--prompt', ' '], /--prompt must not be empty/],
    [['--image', join(work, 'missing.png')], /--image must name an existing \.png file/],
    [['--image', join(work, 'in.jpg')], /--image must name an existing \.png file/],
    [['--allow-tool', 'rm -rf'], /--allow-tool needs a tool name/],
    [['--captures-dir', ' '], /--captures-dir must not be empty/],
    [['--gpu-threshold-pct', '0'], /--gpu-threshold-pct must be a number above 0 and at most 100/],
    [['--gpu-threshold-pct', '101'], /--gpu-threshold-pct must be a number above 0/],
    [['--gpu-memory-rise-mb=-5'], /--gpu-memory-rise-mb must be a number above 0/],
    [['--bogus'], /Unknown option '--bogus'/],
    [['stray'], /Unexpected argument 'stray'|positional/i]
  ];
  for (const [argv, pattern] of bad) throws(() => loop.parseLoopArgs(argv, {}, 'linux', '/h'), pattern, `rejects ${argv.join(' ')}`, LOOP_EXIT.usage);
}

// ---- 2. capture-source planning (the extension's ffmpeg argv) ------------------------------------------------
{
  assert(platformMod.ffmpegTestSourceArgs('f-%05d.png', 4).join(' ') === '-y -re -f lavfi -i testsrc=size=640x360:rate=4 f-%05d.png', 'the test source is lavfi testsrc in real time');
  assert(platformMod.captureFramesPerSecond(4) === 4 && platformMod.captureFramesPerSecond(30) === 30, 'fps 4 and 30 are accepted');
  for (const v of [0, -1, 31, NaN, Infinity]) throws(() => platformMod.captureFramesPerSecond(v), /frames per second/, `fps ${v} is rejected`);
  assert(platformMod.captureFpsOf({ workload: 'desktop-capture', plane: 'LINUX', source: 'ffmpeg-lavfi-testsrc', framesPerSecond: 4 }) === 4, 'captureFpsOf reads framesPerSecond');
  assert(platformMod.captureFpsOf(platformMod.captureMetadataForPlatform('win32')) === 12, 'a labview-launch capture keeps 12 fps');
  const winArgs = platformMod.ffmpegFrameCaptureArgs('win32', 'f.png', '4', {});
  assert(winArgs.join(' ') === '-y -f gdigrab -framerate 4 -i desktop f.png' && platformMod.ffmpegCaptureArgsForPlatform('win32', 'f.png', {}).join(' ') === '-y -f gdigrab -framerate 12 -i desktop f.png', 'the loop uses the extension gdigrab argv at the stated fps');
  const linuxArgs = platformMod.ffmpegFrameCaptureArgs('linux', 'f.png', '4', { DISPLAY: ':1', XDG_SESSION_TYPE: 'x11' }, '800x600');
  assert(linuxArgs.includes('x11grab') && linuxArgs.includes('800x600') && linuxArgs.includes(':1'), 'the loop uses the extension x11grab argv');
  const rs = platformMod.resourceSamplerCommand('linux', '/c/resources.jsonl');
  assert(rs.command === 'bash' && rs.args[0] === '-c' && rs.windowsHide === false, 'Linux resource sampler is the bash script');
  const ws = platformMod.resourceSamplerCommand('win32', 'C:\\c\\resources.jsonl');
  assert(ws.command === 'powershell' && ws.args.at(-1) === platformMod.windowsSamplerScript('C:\\c\\resources.jsonl') && ws.windowsHide, 'Windows resource sampler is the PowerShell script, hidden');

  const t = loop.planCaptureSource({ source: 'test', fps: 4 }, 'darwin', 'f.png', {});
  assert(t.meta.source === 'ffmpeg-lavfi-testsrc' && t.meta.framesPerSecond === 4 && t.meta.plane === 'LINUX' && t.args.includes('lavfi'), 'the test source runs anywhere');
  const w = loop.planCaptureSource({ source: 'desktop', fps: 4 }, 'win32', 'f.png', {});
  assert(w.meta.source === 'ffmpeg-gdigrab' && w.meta.plane === 'WIN' && w.meta.workload === 'desktop-capture', 'Windows desktop = gdigrab');
  const l = loop.planCaptureSource({ source: 'desktop', fps: 4 }, 'linux', 'f.png', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, '640x480');
  assert(l.meta.source === 'ffmpeg-x11grab' && l.meta.plane === 'LINUX', 'Linux desktop = x11grab');
  throws(() => loop.planCaptureSource({ source: 'desktop', fps: 4 }, 'darwin', 'f.png', {}), /supported on Windows and Linux.*--source test/, 'macOS desktop is refused', LOOP_EXIT.prerequisite);
  throws(() => loop.planCaptureSource({ source: 'desktop', fps: 4 }, 'linux', 'f.png', {}), /desktop capture unavailable: .*--source test/, 'Linux without an X display is refused', LOOP_EXIT.prerequisite);
}

// ---- 3. pure clip window, cue order, cue receipts, excerpt --------------------------------------------------
{
  const frames = [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000].map((tMs, index) => ({ index, tMs }));
  const a = loop.planLoopClip(frames, 1000, 1300, [], 250);
  assert(a.anchor === 'prompt sent' && a.startInstantMs === 750 && a.endInstantMs === 1550 && a.fromFrame === 3 && a.toFrame === 7, `prompt-anchored window widened to whole frames: ${JSON.stringify(a)}`);
  const g = loop.planLoopClip(frames, 1000, 1300, [900, 1200], 250);
  assert(g.anchor === 'gpu cue' && g.startInstantMs === 650 && g.fromFrame === 2, 'an earlier GPU cue moves the start');
  const c = loop.planLoopClip(frames, 100, 5000, [1200]);
  assert(c.fromFrame === 0 && c.toFrame === 8 && c.startInstantMs === -900 && c.endInstantMs === 6000, 'the default 1 s pad is clamped to the capture');
  const one = loop.planLoopClip([{ index: 0, tMs: 0 }], 500, 600, []);
  assert(one.fromFrame === 0 && one.toFrame === 0, 'a one-frame capture clips that frame');
  throws(() => loop.planLoopClip([], 0, 1, []), /no frames to clip/, 'no frames -> clip error', LOOP_EXIT.clip);

  const ordered = loop.orderMarkers([{ id: 'b', instantMs: 20 }, { id: 'gpu', instantMs: 10 }, { id: 'loop', instantMs: 10 }, { id: 'a', instantMs: 5 }]);
  assert(ordered.map((m) => m.id).join() === 'a,gpu,loop,b', 'markers sort by instant, stable on ties');

  const rows = loop.cueReceipts([
    { label: 'prompt sent', kind: 'agent-cue', instantMs: 1000, source: { kind: 'local-model-loop' }, imageGrab: { toleranceMs: 200, nearestFrameIndex: 4, deltaMs: 0, admitted: true } },
    { label: 'GPU rose', kind: 'agent-cue', instantMs: 1350, source: { kind: 'gpu-edge', edge: 'utilization', gpuIndex: 0, utilizationLag: { minMs: 180, maxMs: 380 } }, imageGrab: { toleranceMs: 200, nearestFrameIndex: null, deltaMs: Infinity, admitted: false } },
    { label: 'bare', kind: 'agent-cue', instantMs: 7 }
  ], 1000);
  assert(rows[0].source === 'local-model-loop' && rows[0].offsetFromPromptMs === 0 && rows[0].imageGrab.admitted && rows[0].edge === undefined, 'loop cue row');
  assert(rows[1].edge === 'utilization' && rows[1].gpuIndex === 0 && rows[1].offsetFromPromptMs === 350 && rows[1].imageGrab.deltaMs === null && rows[1].imageGrab.nearestFrameIndex === null && rows[1].utilizationLag.maxMs === 380, 'GPU edge row with the platform lag, non-finite delta -> null');
  assert(rows[2].source === 'agent-cue' && rows[2].imageGrab.toleranceMs === null && rows[2].imageGrab.admitted === false, 'a marker without grab/source still yields a row');
  assert(loop.cueReceipts([{ label: 'x', instantMs: 1 }], null)[0].offsetFromPromptMs === null, 'without a prompt instant the offset is null');

  assert(loop.responseExcerpt('short') === 'short' && [...loop.responseExcerpt('é'.repeat(300))].length === 200, 'the excerpt keeps at most 200 characters');
  assert([...loop.responseExcerpt('😀'.repeat(250))].length === 200 && !loop.responseExcerpt('😀'.repeat(250)).includes('\ufffd'), 'the excerpt never splits a code point');
  assert(loop.sha256('abc') === createHash('sha256').update('abc').digest('hex'), 'sha256 helper');
}

// ---- 4. fake Ollama (version, tags, show, generate, streamed chat) -------------------------------------------
const ollama = {
  version: { status: 200, body: '{"version":"0.40.18"}' },
  tags: { status: 200, body: JSON.stringify({ models: [{ name: 'qwen2.5vl:3b', model: 'qwen2.5vl:3b', digest: 'd1g3st', size: 3200627168 }, { name: 'plain:latest', model: 'plain:latest' }] }) },
  show: { status: 200, body: '{"capabilities":["completion","vision"]}' },
  generate: { status: 200, body: '{"done":true}' },
  chat: [],
  requests: []
};
const server = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const route = { '/api/version': 'version', '/api/tags': 'tags', '/api/show': 'show', '/api/generate': 'generate' }[req.url];
  ollama.requests.push({ url: req.url, body: text ? JSON.parse(text) : null });
  if (route) {
    const reply = ollama[route];
    if (reply === 'drop') return req.socket.destroy();
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    return res.end(reply.body);
  }
  if (req.url === '/api/chat') {
    const reply = ollama.chat.shift() ?? { status: 500, lines: [] };
    res.writeHead(reply.status, { 'Content-Type': 'application/x-ndjson' });
    for (const line of reply.lines) {
      res.write(line);
      await sleep(reply.gapMs ?? 5);
    }
    return res.end();
  }
  res.writeHead(404);
  res.end('{}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = new URL(`http://127.0.0.1:${server.address().port}`);
const streamOf = (...parts) => [...parts.map((content) => `${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`), `${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`];

{
  const info = await loop.ollamaPreflight(endpoint, 'qwen2.5vl:3b');
  assert(info.ollamaVersion === '0.40.18' && info.digest === 'd1g3st' && info.sizeBytes === 3200627168 && info.capabilities.join() === 'completion,vision', `preflight reads version, digest, size, capabilities: ${JSON.stringify(info)}`);
  const plain = await loop.ollamaPreflight(endpoint, 'plain');
  assert(plain.name === 'plain' && plain.digest === null && plain.sizeBytes === null, 'a tag-less model name matches :latest; missing digest/size are null');
  ollama.show = { status: 404, body: '{}' };
  assert((await loop.ollamaPreflight(endpoint, 'plain')).capabilities === null, 'an /api/show failure leaves capabilities unknown');
  ollama.show = { status: 200, body: '{"license":"x"}' };
  assert((await loop.ollamaPreflight(endpoint, 'plain')).capabilities === null, 'an /api/show without capabilities leaves them unknown');
  ollama.show = { status: 200, body: '{"capabilities":["completion","vision"]}' };
  await rejects(() => loop.ollamaPreflight(endpoint, 'llama3:8b'), /model llama3:8b is not available.*ollama pull llama3:8b/, 'a missing model names the pull command', LOOP_EXIT.prerequisite);
  ollama.tags = { status: 200, body: '{"models":"nope"}' };
  await rejects(() => loop.ollamaPreflight(endpoint, 'qwen2.5vl:3b'), /is not available/, 'a malformed tag list has no models', LOOP_EXIT.prerequisite);
  const tagsOk = { status: 200, body: JSON.stringify({ models: [{ name: 'qwen2.5vl:3b', model: 'qwen2.5vl:3b', digest: 'd1g3st', size: 3200627168 }] }) };
  ollama.tags = { status: 500, body: '{}' };
  await rejects(() => loop.ollamaPreflight(endpoint, 'qwen2.5vl:3b'), /did not list its models/, 'a failing /api/tags is a prerequisite error', LOOP_EXIT.prerequisite);
  ollama.tags = tagsOk;
  ollama.version = { status: 200, body: '{"name":"not-ollama"}' };
  await rejects(() => loop.ollamaPreflight(endpoint, 'qwen2.5vl:3b'), /did not answer like Ollama/, 'a non-Ollama server is refused', LOOP_EXIT.prerequisite);
  ollama.version = { status: 200, body: '{"version":"0.40.18"}' };
  const gone = createServer();
  await new Promise((resolve) => gone.listen(0, '127.0.0.1', resolve));
  const gonePort = gone.address().port;
  await new Promise((resolve) => gone.close(resolve));
  await rejects(() => loop.ollamaPreflight(new URL(`http://127.0.0.1:${gonePort}`), 'qwen2.5vl:3b'), /Ollama is not reachable at http:\/\/127\.0\.0\.1:\d+ \(start it with "ollama serve"/, 'an unreachable Ollama names the fix', LOOP_EXIT.prerequisite);
}

// ---- 5. the streamed bridge path (first token, done, failures) ------------------------------------------------
{
  const timing = [];
  const hooks = { onChatRequest: (t) => timing.push(`req${t}`), onFirstToken: (t) => timing.push(`first${t}`), onDone: (t) => timing.push(`done${t}`) };
  const base = { model: 'qwen2.5vl:3b', endpoint, prompt: 'p', maxTurns: 2, allow: new Set(['get_host_capabilities']), stream: true, offerTools: false, images: ['aW1n'] };
  ollama.requests.length = 0;
  ollama.chat.push({ status: 200, lines: [`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: false })}\n`, ...streamOf('Hel', 'lo')] });
  const ok = await bridge.runBridge(base, hooks);
  assert(!ok.failure && ok.finalText === 'Hello' && ok.receipt.exitCode === 0 && ok.receipt.ollamaVersion === '0.40.18', `a streamed answer is folded into one message: ${JSON.stringify(ok.failure)}`);
  assert(timing.join() === 'req0,first0,done0', `first token is the first non-empty chunk, then done: ${timing}`);
  const chat = ollama.requests.find((r) => r.url === '/api/chat').body;
  assert(chat.stream === true && chat.tools.length === 0 && chat.messages[0].images[0] === 'aW1n', 'streamed request, no tools offered to a tool-less model, the image rides on the prompt');
  assert(ok.toolsOffered.length === 0 && ok.receipt.toolsListed.includes('export_capture_clip'), 'the MCP server is still discovered');

  const offered = await (async () => {
    ollama.chat.push({ status: 200, lines: streamOf('ok') });
    return bridge.runBridge({ ...base, offerTools: undefined }, {});
  })();
  assert(offered.toolsOffered.join() === 'get_host_capabilities', 'with tools capability the allow-listed tools are offered');

  const failures = [
    [{ status: 500, lines: [] }, /HTTP 500/],
    [{ status: 200, lines: ['not json\n'] }, /invalid JSON/],
    [{ status: 200, lines: ['{"error":"boom"}\n'] }, /stream error/],
    [{ status: 200, lines: [`${JSON.stringify({ message: { role: 'assistant', content: 'x' }, done: false })}\n`] }, /stream ended before done/]
  ];
  for (const [reply, pattern] of failures) {
    ollama.chat.push(reply);
    const run = await bridge.runBridge(base, {});
    assert(run.failure && run.failure.stage === 'Ollama chat' && pattern.test(run.failure.message), `stream failure ${pattern}: ${JSON.stringify(run.failure)}`);
  }
  // get_benchmark_series needs no lbabus, so the call succeeds on every CI host.
  ollama.chat.push({ status: 200, lines: [`${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_benchmark_series', arguments: {} } }] }, done: true })}\n`] });
  ollama.chat.push({ status: 200, lines: streamOf('done') });
  const tooled = await bridge.runBridge({ ...base, offerTools: true, allow: new Set(['get_benchmark_series']) }, {});
  assert(tooled.finalText === 'done' && tooled.receipt.toolCalls.length === 1 && tooled.receipt.toolCalls[0].ok, 'a streamed tool call is executed and the next turn answers');
}

// ---- 6. the whole loop with fakes ----------------------------------------------------------------------------
// A PNG signature + IHDR (64x48) is all the clip planner reads; the fake encoder never decodes it.
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
  const state = { hot: false, recorderArgs: null, samplerFile: null, ffmpegCalls: [], stops: [] };
  const deps = {
    platform: 'linux',
    env: {},
    now: () => Date.now(),
    sleep,
    root,
    resolveFfmpeg: () => '/fake/ffmpeg',
    x11VideoSize: async () => '640x480',
    startRecorder: (ffmpeg, args) => {
      state.recorderArgs = [ffmpeg, ...args];
      const pattern = args.at(-1);
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        const file = pattern.replace('%05d', String(n).padStart(5, '0'));
        writeFileSync(file, FRAME_PNG);
        const at = Date.now() / 1000;
        utimesSync(file, at, at);
      }, 50);
      return { stop: async () => { clearInterval(timer); state.stops.push('recorder'); }, lastError: () => '' };
    },
    startResourceSampler: (platform, file) => {
      state.samplerFile = file;
      return { stop: () => state.stops.push('sampler') };
    },
    gpuRunner: () => async (args) => {
      if (args[0] === '--query-gpu=index,name') return '0, NVIDIA Fake RTX\n';
      return `${smiStamp(Date.now())}, ${state.hot ? 90 : 0}, ${state.hot ? 4000 : 500}, 30.00\n`;
    },
    bridge: async (config, hooks) => {
      state.bridgeConfig = config;
      state.serverEnv = hooks.serverEnv;
      hooks.onChatRequest(0);
      state.hot = true;
      await sleep(400);
      hooks.onFirstToken(0);
      hooks.onFirstToken(0);
      await sleep(100);
      hooks.onDone(0);
      return { receipt: { ollamaVersion: '0.40.18', toolCalls: [] }, finalText: `${'A'.repeat(250)}`, toolsOffered: [] };
    },
    clipRun: async (command, argv) => {
      state.ffmpegCalls.push([command, ...argv]);
      if (argv.includes('-version')) return { stdout: 'ffmpeg version 8', stderr: '' };
      writeFileSync(argv.at(-1), Buffer.from('fake-mp4'));
      return { stdout: '', stderr: '' };
    },
    ...overrides
  };
  return { deps, state };
}
const cfg = (extra = []) => loop.parseLoopArgs(['--source', 'test', '--lead-ms', '400', '--tail-ms', '400', '--ollama', endpoint.href, '--captures-dir', join(work, 'caps'), ...extra], {}, 'linux', work);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
{
  const { deps, state } = fakeDeps();
  const lines = [];
  const receipt = await loop.runLocalModelLoop(cfg(['--allow-tool', 'export_capture_clip']), deps, (l) => lines.push(l));
  const dir = receipt.captureDir;
  assert(receipt.schema === 'labview-benchmark-actor/local-model-loop@v1' && dir.startsWith(join(work, 'caps', 'run-')) && receipt.captureId === dir.split('run-').pop(), 'the capture is a run-<uuid> dir under --captures-dir');
  assert(lines[0].startsWith('capture started: ') && lines[0].includes('ffmpeg-lavfi-testsrc at 4 fps'), 'progress goes to the log');
  assert(state.recorderArgs[0] === '/fake/ffmpeg' && state.recorderArgs.includes('lavfi') && state.recorderArgs.at(-1) === join(dir, 'frame-%05d.png'), 'the recorder gets the test-source argv into the capture dir');
  assert(state.samplerFile === join(dir, 'resources.jsonl') && state.stops.join() === 'sampler,recorder', 'the CPU/RAM sampler runs and everything is stopped');
  assert(state.bridgeConfig.stream === true && state.bridgeConfig.offerTools === false && state.bridgeConfig.allow.has('export_capture_clip') && state.bridgeConfig.allow.has('get_host_capabilities') && state.bridgeConfig.images === undefined, 'the bridge streams, keeps its default allow-list, adds --allow-tool and offers no tools to a tool-less model');
  assert(state.serverEnv.LBA_CAPTURE_ROOT === join(work, 'caps') && state.serverEnv.LBA_FFMPEG_PATH === '/fake/ffmpeg', 'the MCP tools see the loop capture root and ffmpeg');

  const capture = readJson(join(dir, 'capture.json'));
  assert(capture.fps === 4 && capture.source === 'ffmpeg-lavfi-testsrc' && capture.workload === 'desktop-capture' && capture.frames.length === receipt.frameCount && receipt.frameCount > 10, `capture.json in the extension format (${receipt.frameCount} frames)`);
  assert(capture.frames.every((f, i) => f.index === i && typeof f.tMs === 'number' && f.image === `frame-${String(i + 1).padStart(5, '0')}.png`), 'frames[] carry index/tMs/image');
  const labels = capture.markers.map((m) => m.label);
  assert(labels.includes('prompt sent') && labels.includes('first token') && labels.includes('response done'), `the three loop cues are markers: ${labels}`);
  assert(capture.markers.every((m, i, all) => i === 0 || all[i - 1].instantMs <= m.instantMs), 'markers are in time order');
  const loopCues = capture.markers.filter((m) => m.source.kind === 'local-model-loop');
  assert(loopCues.length === 3 && loopCues.every((m) => m.kind === 'agent-cue' && m.imageGrab && typeof m.imageGrab.deltaMs === 'number'), 'loop cues are agent cues on the shared image grab');
  assert(new Set(capture.markers.map((m) => m.id)).size === capture.markers.length, 'marker ids are unique');
  const gpuCues = capture.markers.filter((m) => m.source.kind === 'gpu-edge');
  assert(gpuCues.length === 2 && gpuCues.some((m) => m.source.edge === 'model-load') && gpuCues.some((m) => m.source.edge === 'compute' && m.source.utilizationLag.maxMs === 380), `both automatic GPU cues are present: ${JSON.stringify(gpuCues.map((m) => m.label))}`);
  assert(readJson(join(dir, 'active-capture-session.json')).state === 'stopped' && readJson(join(dir, 'capture-status.json')).state !== 'failed', 'the capture is left stopped and consistent');

  assert(receipt.model.name === 'qwen2.5vl:3b' && receipt.model.digest === 'd1g3st' && receipt.model.ollamaVersion === '0.40.18' && receipt.model.cold === false, 'the receipt names the model digest');
  assert(receipt.response.chars === 250 && receipt.response.excerpt.length === 200 && receipt.response.sha256 === loop.sha256('A'.repeat(250)), 'the answer is a hash + 200-char excerpt');
  assert(receipt.prompt.sha256 === loop.sha256(loop.LOOP_DEFAULTS.prompt) && receipt.prompt.image === null && !JSON.stringify(receipt).includes(loop.LOOP_DEFAULTS.prompt), 'the prompt is hashed, never echoed');
  const t = receipt.timing;
  assert(t.firstTokenLatencyMs >= 380 && t.responseMs >= t.firstTokenLatencyMs && t.leadMs === 400 && t.tailMs === 400, `first-token latency and response time: ${JSON.stringify(t)}`);
  const cue = (label) => receipt.cues.find((c) => c.label === label);
  assert(cue('prompt sent').offsetFromPromptMs === 0 && cue('first token').offsetFromPromptMs === t.firstTokenLatencyMs && cue('response done').offsetFromPromptMs === t.responseMs, 'cue offsets are measured from prompt sent');
  assert(receipt.cues.every((c) => c.imageGrab.toleranceMs === 200 && typeof c.imageGrab.admitted === 'boolean'), 'every cue reports its grab tolerance and admission');
  assert(receipt.gpu.available === true && receipt.gpu.sampleCount > 5 && receipt.gpu.gpus[0].name === 'NVIDIA Fake RTX' && receipt.gpu.edges.length === 2, 'the GPU series is available with two edges');
  assert(receipt.gpu.edges.every((e) => e.offsetFromPromptMs > -200 && e.offsetFromPromptMs < 600), `GPU edges follow the prompt: ${receipt.gpu.edges.map((e) => e.offsetFromPromptMs)}`);
  const cl = receipt.clip;
  assert(cl.file.startsWith('clips/clip-') && cl.sha256 === loop.sha256('fake-mp4') && cl.sizeBytes === 8 && cl.durationMs > 0, 'the clip receipt carries file, sha256, bytes, duration');
  const startFrame = capture.frames[cl.window.fromFrame];
  const endFrame = capture.frames[cl.window.toFrame];
  assert(startFrame.tMs <= cl.window.startInstantMs || cl.window.fromFrame === 0, 'the clip starts at or before (first of prompt/GPU) - 1 s');
  assert(endFrame.tMs >= cl.window.endInstantMs || cl.window.toFrame === capture.frames.length - 1, 'the clip ends at or after response done + 1 s');
  assert(cl.window.startInstantMs === Math.min(t.promptSentInstantMs, ...receipt.gpu.edges.map((e) => e.instantMs)) - 1000, 'the window starts 1 s before the earliest of prompt sent and the first GPU cue');
  assert(receipt.receiptFile === `clips/loop-${cl.window.fromFrame}-${cl.window.toFrame}.json` && existsSync(join(dir, receipt.receiptFile)) && existsSync(join(dir, cl.receiptFile)), 'the loop receipt is written next to the clip');
  assert(JSON.stringify(readJson(join(dir, receipt.receiptFile))) === JSON.stringify(receipt), 'the written receipt equals the printed one');
  assert(!/data:image|base64/.test(JSON.stringify(receipt)), 'the receipt carries no pixels');
}

// cold start + image + a tools-capable model
{
  const { deps, state } = fakeDeps();
  ollama.show = { status: 200, body: '{"capabilities":["completion","tools"]}' };
  ollama.requests.length = 0;
  const png = join(work, 'in.png');
  const receipt = await loop.runLocalModelLoop(cfg(['--cold', '--image', png]), deps);
  const unload = ollama.requests.find((r) => r.url === '/api/generate');
  assert(unload && unload.body.keep_alive === 0 && unload.body.model === 'qwen2.5vl:3b', '--cold unloads the model first (keep_alive 0)');
  assert(state.bridgeConfig.offerTools === true && state.bridgeConfig.images[0] === readFileSync(png).toString('base64'), 'a tools-capable model is offered tools; --image is sent base64');
  assert(receipt.model.cold === true && receipt.prompt.image.bytes === readFileSync(png).length && receipt.prompt.image.sha256 === loop.sha256(readFileSync(png)), 'the image is hashed in the receipt');
  ollama.show = { status: 200, body: '{"capabilities":["completion","vision"]}' };
  ollama.generate = { status: 500, body: '{}' };
  await rejects(() => loop.runLocalModelLoop(cfg(['--cold']), fakeDeps().deps), /could not unload qwen2\.5vl:3b for --cold/, '--cold failing is a prerequisite error', LOOP_EXIT.prerequisite);
  ollama.generate = { status: 200, body: '{"done":true}' };
}

// Linux desktop: X display size via xdpyinfo, else a prerequisite error
{
  const { deps, state } = fakeDeps({ env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' } });
  const receipt = await loop.runLocalModelLoop(loop.parseLoopArgs(['--lead-ms', '0', '--tail-ms', '0', '--ollama', endpoint.href, '--captures-dir', join(work, 'caps')], {}, 'linux', work), deps);
  assert(receipt.source === 'ffmpeg-x11grab' && state.recorderArgs.includes('x11grab') && state.recorderArgs.includes('640x480'), 'Linux desktop records x11grab at the xdpyinfo size');
  const before = readdirSync(join(work, 'caps')).length;
  const noX = fakeDeps({ env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, x11VideoSize: async () => { throw new Error('xdpyinfo missing'); } }).deps;
  await rejects(() => loop.runLocalModelLoop(loop.parseLoopArgs(['--ollama', endpoint.href, '--captures-dir', join(work, 'caps')], {}, 'linux', work), noX), /desktop capture unavailable: xdpyinfo missing; use --source test/, 'no X size -> prerequisite error', LOOP_EXIT.prerequisite);
  assert(readdirSync(join(work, 'caps')).length === before, 'a prerequisite failure creates no capture directory');
}

// nvidia-smi missing: the loop runs, GPU unavailable with a reason, no GPU cues
{
  const enoent = () => async () => { throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }); };
  const { deps } = fakeDeps({ gpuRunner: enoent });
  const receipt = await loop.runLocalModelLoop(cfg(), deps);
  assert(receipt.gpu.available === false && typeof receipt.gpu.reason === 'string' && receipt.gpu.reason.length > 0 && receipt.gpu.edges.length === 0, `no nvidia-smi -> GPU unavailable with a reason: ${receipt.gpu.reason}`);
  assert(receipt.cues.every((c) => c.source === 'local-model-loop') && receipt.cues.length === 3 && receipt.clip.window.anchor === 'prompt sent', 'only the loop cues; the clip anchors on prompt sent');
}

// failures: ffmpeg missing, 0 frames, model failure, clip failure, Ollama down
{
  await rejects(() => loop.runLocalModelLoop(cfg(), fakeDeps({ resolveFfmpeg: () => null }).deps), /ffmpeg was not found/, 'no ffmpeg -> prerequisite error', LOOP_EXIT.prerequisite);

  const blank = fakeDeps({ startRecorder: () => ({ stop: async () => undefined, lastError: () => 'Unknown input format: lavfi' }) });
  const err = await rejects(() => loop.runLocalModelLoop(cfg(), blank.deps), /no usable frames .*no frames were captured.*; ffmpeg: Unknown input format: lavfi/, '0 frames -> capture error with ffmpeg stderr', LOOP_EXIT.capture);
  const failedDir = readdirSync(join(work, 'caps')).map((d) => join(work, 'caps', d)).find((d) => existsSync(join(d, 'active-capture-session.json')) && readJson(join(d, 'active-capture-session.json')).state === 'failed');
  assert(failedDir && readJson(join(failedDir, 'capture-status.json')).state === 'failed' && !existsSync(join(failedDir, 'capture.json')), `the failed capture is marked failed, consistently (${err.message})`);
  const quiet = fakeDeps({ startRecorder: () => ({ stop: async () => undefined, lastError: () => '' }) });
  await rejects(() => loop.runLocalModelLoop(cfg(), quiet.deps), /no usable frames \([^;]*\)$/, '0 frames without ffmpeg stderr', LOOP_EXIT.capture);

  const failing = fakeDeps({ bridge: async (config, hooks) => { hooks.onChatRequest(0); return { receipt: { ollamaVersion: '', toolCalls: [] }, finalText: '', toolsOffered: [], failure: { stage: 'Ollama chat', message: 'Ollama answered with HTTP 500.' } }; } });
  const modelErr = await rejects(() => loop.runLocalModelLoop(cfg(), failing.deps), /Ollama chat failed: Ollama answered with HTTP 500\./, 'a chat failure -> model error', LOOP_EXIT.model);
  assert(modelErr.receipt.clip === null && modelErr.receipt.receiptFile === 'loop-receipt.json' && existsSync(join(modelErr.receipt.captureDir, 'loop-receipt.json')) && modelErr.receipt.model.ollamaVersion === '0.40.18', 'the failed loop still writes its receipt in the capture');
  assert(readJson(join(modelErr.receipt.captureDir, 'active-capture-session.json')).state === 'stopped' && existsSync(join(modelErr.receipt.captureDir, 'capture.json')), 'the capture is still assembled and stopped');
  const silent = fakeDeps({ bridge: async () => ({ receipt: { ollamaVersion: 'v', toolCalls: [] }, finalText: '', toolsOffered: [] }) });
  await rejects(() => loop.runLocalModelLoop(cfg(), silent.deps), /Ollama chat failed: no complete response\./, 'no response instants -> model error', LOOP_EXIT.model);
  const throwing = fakeDeps({ bridge: async () => { throw new Error('bridge crashed'); } });
  await rejects(() => loop.runLocalModelLoop(cfg(), throwing.deps), /bridge crashed/, 'a crashing bridge still stops the capture');
  assert(throwing.state.stops.join() === 'sampler,recorder', 'the recorder and sampler are stopped after a crash');

  const badClip = fakeDeps({ clipRun: async (c, argv) => { if (argv.includes('-version')) return { stdout: 'ffmpeg', stderr: '' }; throw Object.assign(new Error('exit 1'), { stderr: 'Unknown encoder libx264' }); } });
  const clipErr = await rejects(() => loop.runLocalModelLoop(cfg(), badClip.deps), /clip failed: .*libx264/, 'a clip failure -> clip error', LOOP_EXIT.clip);
  assert(clipErr.receipt.receiptFile === 'loop-receipt.json' && clipErr.receipt.cues.length >= 3, 'the clip failure keeps the cue receipt');
}

// ---- 7. the CLI wrapper ------------------------------------------------------------------------------------
{
  const io = () => {
    const o = { out: [], err: [] };
    return { o, io: { out: (t) => o.out.push(t), err: (t) => o.err.push(t) } };
  };
  let r = io();
  assert(await loop.runLocalModelLoopCli(['--help'], r.io) === 0 && r.o.out[0] === loop.LOOP_USAGE && loop.LOOP_USAGE.includes('--source desktop|test'), '--help prints the usage');
  r = io();
  assert(await loop.runLocalModelLoopCli(['--fps', '99'], r.io, fakeDeps().deps) === LOOP_EXIT.usage && r.o.out.length === 0 && r.o.err[0].startsWith('local-model-loop: --fps') && r.o.err[1] === loop.LOOP_USAGE, 'a usage error exits 2 with the usage on stderr');
  r = io();
  const ok = fakeDeps({ env: { XDG_CONFIG_HOME: join(work, 'xdg') } }).deps;
  assert(await loop.runLocalModelLoopCli(['--source', 'test', '--lead-ms', '0', '--tail-ms', '0', '--ollama', endpoint.href], r.io, ok) === 0, 'the CLI exits 0');
  const printed = JSON.parse(r.o.out.join('\n'));
  assert(r.o.out.length === 1 && printed.captureDir.startsWith(join(work, 'xdg', 'Code', 'User', 'globalStorage', 'svelderrainruiz.labview-benchmark-actor', 'captures')), 'ONE JSON receipt on stdout, in the default captures root');
  r = io();
  assert(await loop.runLocalModelLoopCli(['--source', 'test', '--lead-ms', '0', '--tail-ms', '0', '--ollama', endpoint.href, '--captures-dir', join(work, 'caps')], r.io, fakeDeps({ resolveFfmpeg: () => null }).deps) === LOOP_EXIT.prerequisite && r.o.out.length === 0 && /ffmpeg was not found/.test(r.o.err[0]), 'a prerequisite failure exits 3 without a receipt');
  r = io();
  const failing = fakeDeps({ bridge: async (config, hooks) => { hooks.onChatRequest(0); return { receipt: { ollamaVersion: '', toolCalls: [] }, finalText: '', toolsOffered: [], failure: { stage: 'Ollama chat', message: 'x.' } }; } }).deps;
  assert(await loop.runLocalModelLoopCli(['--source', 'test', '--lead-ms', '300', '--tail-ms', '0', '--ollama', endpoint.href, '--captures-dir', join(work, 'caps')], r.io, failing) === LOOP_EXIT.model && JSON.parse(r.o.out[0]).error === 'Ollama chat failed: x.', 'a model failure exits 5 and still prints the receipt');
  r = io();
  assert(await loop.runLocalModelLoopCli(['--source', 'test', '--lead-ms', '0', '--ollama', endpoint.href, '--captures-dir', join(work, 'caps')], r.io, fakeDeps({ bridge: async () => { throw new Error('boom'); } }).deps) === 1 && r.o.err.at(-1) === 'local-model-loop: boom', 'an unexpected error exits 1');
}

// ---- 8. end to end with the real ffmpeg (lavfi test source), when present ---------------------------------
let ffmpegPresent = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
  ffmpegPresent = true;
} catch {
  /* no ffmpeg on this host: the fakes above cover the loop */
}
if (ffmpegPresent) {
  const { deps } = fakeDeps();
  const real = { ...deps, resolveFfmpeg: loop.defaultLoopDeps.resolveFfmpeg, startRecorder: loop.defaultLoopDeps.startRecorder, clipRun: loop.defaultLoopDeps.clipRun, startResourceSampler: loop.defaultLoopDeps.startResourceSampler };
  const receipt = await loop.runLocalModelLoop(loop.parseLoopArgs(['--source', 'test', '--lead-ms', '1000', '--tail-ms', '1000', '--ollama', endpoint.href, '--captures-dir', join(work, 'e2e')], {}, process.platform, work), real);
  const clipFile = join(receipt.captureDir, receipt.clip.file);
  assert(receipt.frameCount >= 6 && existsSync(clipFile) && receipt.clip.sizeBytes === readFileSync(clipFile).length, `real ffmpeg recorded ${receipt.frameCount} test frames and encoded the clip`);
  let probed = null;
  try {
    probed = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipFile], { windowsHide: true }).toString().trim()) * 1000;
  } catch {
    /* ffprobe absent */
  }
  if (probed !== null) assert(Math.abs(probed - receipt.clip.durationMs) <= 250, `the clip duration matches ffprobe within one frame interval (${probed} vs ${receipt.clip.durationMs})`);
  console.log(`  e2e: ${receipt.frameCount} frames, clip ${receipt.clip.durationMs} ms${probed !== null ? `, ffprobe ${probed} ms` : ''}`);
} else {
  console.log('  e2e: skipped (no ffmpeg on PATH)');
}

await new Promise((resolve) => server.close(resolve));
rmSync(work, { recursive: true, force: true });
console.log(`local-model-loop: ${checks} checks passed`);
