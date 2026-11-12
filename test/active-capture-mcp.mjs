#!/usr/bin/env node
// Host-free tests for the active-capture MCP resource contract. Run after `npm run compile`.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const core = require(join(root, 'out', 'mcp', 'benchmarkActorMcpServer.js'));
const { buildActiveCaptureSession, validateActiveCaptureSession, writeActiveCaptureSession } = require(join(root, 'out', 'captureSession.js'));
const { createActiveCaptureResourceProvider } = require(join(root, 'out', 'mcp', 'activeCaptureEvidence.js'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgAI/ScL9WQAAAABJRU5ErkJggg==', 'base64');
for (let offset = 8; offset + 12 <= png.length;) {
  const length = png.readUInt32BE(offset);
  png.writeUInt32BE(crc32(png.subarray(offset + 4, offset + 8 + length)), offset + 8 + length);
  offset += 12 + length;
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
}

const captureRoot = join(tmpdir(), `lba-active-capture-${randomUUID()}`);
const runId = randomUUID();
const runDirectory = join(captureRoot, `run-${runId}`);
mkdirSync(runDirectory, { recursive: true });
const session = buildActiveCaptureSession({
  runId,
  state: 'capturing',
  plane: 'LINUX',
  source: 'visible-desktop',
  startedAt: '2026-11-11T12:00:00.000Z',
  updatedAt: '2026-11-11T12:00:00.000Z'
});
const invalidSessions = [
  null,
  [],
  { ...session, schema: 'wrong' },
  { ...session, runId: 1 },
  { ...session, runId: randomUUID() },
  { ...session, workload: 'other' },
  { ...session, state: 'unknown' },
  { ...session, plane: 'OTHER' },
  { ...session, source: '../private' },
  { ...session, startedAt: 'not-a-date' },
  { ...session, stoppedAt: 'not-a-date' },
  { ...session, availableEvidence: ['frames'] },
  { ...session, updatedAt: 'not-a-date' },
  { ...session, state: 'stopped', stoppedAt: null }
];
for (const invalid of invalidSessions) {
  assert(validateActiveCaptureSession(invalid, runId) === null, 'malformed active-capture session records fail closed');
}
const completedSession = buildActiveCaptureSession({
  runId: randomUUID(), state: 'stopped', plane: 'WIN', source: 'ffmpeg-gdigrab',
  startedAt: '2026-11-11T12:00:00.000Z', stoppedAt: '2026-11-11T12:01:00.000Z'
});
assert(validateActiveCaptureSession(completedSession)?.stoppedAt === completedSession.stoppedAt, 'valid terminal session records retain their stop timestamp');
writeActiveCaptureSession(runDirectory, session);
writeFileSync(join(runDirectory, 'frame-00001.png'), png);
writeFileSync(join(runDirectory, 'frame-00002.png'), png.subarray(0, 20));
writeFileSync(join(runDirectory, 'frame-00004.png'), png);
writeFileSync(join(runDirectory, 'frame-00006.png'), Buffer.alloc(png.length));
const malformedPng = Buffer.from(png);
malformedPng.write('1HDR', 12, 'ascii');
writeFileSync(join(runDirectory, 'frame-00007.png'), malformedPng);
writeFileSync(join(runDirectory, 'frame-00008.png'), Buffer.alloc(8 * 1024 * 1024 + 1));
const wrongFirstChunk = Buffer.from(png);
wrongFirstChunk.write('JHDR', 12, 'ascii');
writeFileSync(join(runDirectory, 'frame-00009.png'), wrongFirstChunk);
const zeroWidthPng = Buffer.from(png);
zeroWidthPng.writeUInt32BE(0, 16);
writeFileSync(join(runDirectory, 'frame-00010.png'), zeroWidthPng);
const noIdatPng = Buffer.from(png);
noIdatPng.write('tEXt', 37, 'ascii');
writeFileSync(join(runDirectory, 'frame-00011.png'), noIdatPng);
const badIendPng = Buffer.from(png);
badIendPng.writeUInt32BE(1, badIendPng.length - 12);
writeFileSync(join(runDirectory, 'frame-00012.png'), badIendPng);
writeFileSync(join(runDirectory, 'frame-999999999999999999999999.png'), png);
const samples = [
  JSON.stringify({
    ms: 1794398400100,
    cpuPct: 4.2,
    ramMb: 900,
    diskPct: 0,
    disks: [
      null,
      {},
      { name: 'PhysicalDisk0', writeMBs: 0.1, readMBs: 0.2 },
      { name: '/tmp/private-capture-path', writeMBs: 9, readMBs: 0 }
    ]
  }),
  JSON.stringify({ ms: 1794398400200 }),
  '',
  'null',
  JSON.stringify({ ms: -1 }),
  '{invalid-json',
  '{"ms":1794398400300'
].slice(0, -1).join('\n') + '\n{"ms":1794398400300';
writeFileSync(join(runDirectory, 'resources.jsonl'), `${samples}`);

const malformedId = randomUUID();
const malformedDirectory = join(captureRoot, `run-${malformedId}`);
mkdirSync(malformedDirectory, { recursive: true });
writeFileSync(join(malformedDirectory, 'active-capture-session.json'), JSON.stringify({ schema: 'wrong' }));
const missingBeaconDirectory = join(captureRoot, `run-${randomUUID()}`);
mkdirSync(missingBeaconDirectory, { recursive: true });
const corruptBeaconDirectory = join(captureRoot, `run-${randomUUID()}`);
mkdirSync(corruptBeaconDirectory, { recursive: true });
writeFileSync(join(corruptBeaconDirectory, 'active-capture-session.json'), '{invalid-json');

const lifecycleRunIds = new Map();
for (const state of ['finalizing', 'stopped', 'failed']) {
  const lifecycleId = randomUUID();
  lifecycleRunIds.set(state, lifecycleId);
  const directory = join(captureRoot, `run-${lifecycleId}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'resources.jsonl'), '');
  writeActiveCaptureSession(directory, buildActiveCaptureSession({
    runId: lifecycleId,
    state,
    plane: 'WIN',
    source: 'ffmpeg-gdigrab',
    startedAt: '2026-11-11T12:00:00.000Z',
    stoppedAt: state === 'stopped' || state === 'failed' ? '2026-11-11T12:01:00.000Z' : undefined,
    updatedAt: '2026-11-11T12:01:00.000Z'
  }));
}

let symlinkRunCreated = false;
try {
  symlinkSync(runDirectory, join(captureRoot, `run-${randomUUID()}`), 'dir');
  symlinkRunCreated = true;
} catch {
  // Symlink creation may be unavailable to an unprivileged Windows test process.
}
let symlinkFrameCreated = false;
try {
  symlinkSync(join(runDirectory, 'frame-00001.png'), join(runDirectory, 'frame-00005.png'));
  symlinkFrameCreated = true;
} catch {
  // The reader still has deterministic traversal and partial-file coverage without symlink privileges.
}

const provider = createActiveCaptureResourceProvider(captureRoot);
const resources = provider.listResources();
const sessionResource = resources.find((resource) => resource.uri === `lba-capture://session/${runId}`);
assert(resources.length === 4 && sessionResource, `discovery publishes valid opaque session URIs and skips malformed/symlinked runs: ${JSON.stringify(resources)}`);
assert(!JSON.stringify(resources).includes(captureRoot), 'resource discovery never exposes the configured capture root');
assert(createActiveCaptureResourceProvider('').listResources().length === 0, 'an unconfigured capture root returns no resources');
assert(createActiveCaptureResourceProvider(join(captureRoot, 'missing')).listResources().length === 0, 'a missing capture root returns no resources');
const rootFile = join(tmpdir(), `lba-capture-root-file-${randomUUID()}`);
writeFileSync(rootFile, 'not a directory');
assert(createActiveCaptureResourceProvider(rootFile).listResources().length === 0, 'a file cannot be used as a capture root');
rmSync(rootFile, { force: true });

const deps = {
  serverVersion: '1.4.14',
  getHostCapabilities: async () => ({ content: [{ type: 'text', text: '' }] }),
  getBenchmarkSeries: async () => ({ content: [{ type: 'text', text: '' }] }),
  pollCoordinationBus: async () => ({ content: [{ type: 'text', text: '' }] }),
  postCoordinationNote: async () => ({ content: [{ type: 'text', text: '' }] }),
  captureResources: provider
};
async function request(method, params, id = 1) {
  return core.handleBenchmarkActorMcpMessage({ jsonrpc: '2.0', id, method, params }, deps);
}

const initialized = await request('initialize', {}, 1);
assert(initialized.result.capabilities.resources, 'initialize advertises the MCP resources capability');
const listed = await request('resources/list', {}, 2);
assert(listed.result.resources.length === 4, 'resources/list exposes each valid lifecycle session resource');
const templates = await request('resources/templates/list', {}, 3);
assert(templates.result.resourceTemplates.length === 2, 'resource templates advertise bounded batch and explicit frame reads');

const sessionUri = sessionResource.uri;
const sessionResponse = await request('resources/read', { uri: sessionUri }, 4);
const metadata = JSON.parse(sessionResponse.result.contents[0].text);
assert(metadata.schema === 'labview-benchmark-actor/active-capture-session@1' && metadata.state === 'capturing', 'session read returns versioned lifecycle metadata');
assert(metadata.runId === runId && metadata.workload === 'labview-launch' && metadata.watermarks.frameSequence === 12 && metadata.watermarks.sampleSequence === 5, 'session read returns workload, opaque identity, and current sequence watermarks');
assert(!JSON.stringify(metadata).includes(captureRoot), 'session metadata does not leak local paths');
for (const [state, lifecycleId] of lifecycleRunIds) {
  const lifecycleUri = `lba-capture://session/${lifecycleId}`;
  const lifecycleRead = await request('resources/read', { uri: lifecycleUri }, 40 + lifecycleId.length);
  assert(JSON.parse(lifecycleRead.result.contents[0].text).state === state, `session read preserves the ${state} lifecycle state`);
}
assert(validateActiveCaptureSession({ ...session, state: 'stopped', stoppedAt: null }) === null, 'terminal session states require a stop timestamp');

const batchUri = `lba-capture://session/${runId}/batch?afterFrame=0&afterSample=0&limit=12`;
const batchResponse = await request('resources/read', { uri: batchUri }, 5);
const batch = JSON.parse(batchResponse.result.contents[0].text);
assert(batch.schema === 'active-capture-evidence-batch@1' && batch.frames.length === 2, 'bounded batch returns only structurally complete frames');
assert(batch.frames[0].sequence === 1 && batch.frames[1].sequence === 4, 'frame metadata remains ordered by sequence');
assert(batch.frameGaps.some((gap) => gap.from === 3 && gap.to === 3), 'batch identifies missing sequence gaps');
assert([2, 6, 7, 8, 9, 10, 11, 12].every((sequence) => batch.incompleteFrames.includes(sequence)) && batch.sampleTailIncomplete, 'batch reports partial, malformed, and oversized frame writes plus an incomplete JSONL tail');
if (symlinkFrameCreated) assert(batch.incompleteFrames.includes(5), 'batch refuses a symlinked frame resource');
assert(batch.samples.length === 2 && batch.samples[0].sequence === 1 && batch.samples[1].sequence === 2, 'batch excludes malformed records and a partial resource-sample tail');
assert(batch.samples[0].disks.length === 1, 'sample projection removes path-shaped disk labels');
assert(batch.samples[1].disks.length === 0 && batch.incompleteSamples.length === 3, 'sample projection handles missing disk data and reports malformed records');
assert(!JSON.stringify(batch).includes(captureRoot) && !JSON.stringify(batch).includes('/tmp/private-capture-path'), 'batch output contains no host paths');

const frameRead = await request('resources/read', { uri: batch.frames[0].uri }, 6);
assert(frameRead.result.contents[0].mimeType === 'image/png', 'explicit frame read returns image/png');
assert(Buffer.from(frameRead.result.contents[0].blob, 'base64').equals(png), 'explicit frame read returns the verified PNG bytes');

const staleCursor = await request('resources/read', { uri: `lba-capture://session/${runId}/batch?afterFrame=99` }, 7);
assert(staleCursor.error?.code === -32002 && !staleCursor.error.message.includes(captureRoot), 'stale cursors fail with a pathless resource error');
const oversizedBatch = await request('resources/read', { uri: `lba-capture://session/${runId}/batch?limit=13` }, 8);
assert(oversizedBatch.error?.code === -32002, 'batch limits above the configured bound are rejected');
for (const uri of [
  `lba-capture://session/${runId}/batch?limit=0`,
  `lba-capture://session/${runId}/batch?afterFrame=-1`,
  `lba-capture://session/${runId}/batch?limit=1&limit=2`,
  `lba-capture://session/${runId}/batch?unknown=1`
]) {
  const invalidBatch = await request('resources/read', { uri }, 80 + uri.length);
  assert(invalidBatch.error?.code === -32002, 'malformed batch query parameters fail closed');
}
const pagedBatch = await request('resources/read', { uri: `lba-capture://session/${runId}/batch?afterFrame=1&afterSample=1&limit=2` }, 13);
assert(JSON.parse(pagedBatch.result.contents[0].text).frames.every((frame) => frame.sequence > 1), 'frame cursors exclude already-read sequences');
const emptyBatch = await request('resources/read', { uri: `lba-capture://session/${lifecycleRunIds.get('stopped')}/batch` }, 14);
assert(JSON.parse(emptyBatch.result.contents[0].text).frames.length === 0, 'an empty finalized capture returns an empty bounded batch');
const traversal = await request('resources/read', { uri: 'lba-capture://session/../etc/passwd' }, 9);
assert(traversal.error?.code === -32002 && !traversal.error.message.includes(captureRoot), 'path-traversal resource URIs fail closed');
const absentRun = await request('resources/read', { uri: `lba-capture://session/${randomUUID()}` }, 15);
assert(absentRun.error?.code === -32002, 'unknown opaque run identifiers are unavailable');
const missingUri = await request('resources/read', {}, 10);
assert(missingUri.error?.code === -32602, 'resources/read requires a bounded string URI');
const unavailableProvider = createActiveCaptureResourceProvider('');
let missingRootReadFailed = false;
try { unavailableProvider.readResource(sessionUri); } catch { missingRootReadFailed = true; }
assert(missingRootReadFailed, 'a resource read without a configured root fails closed');

const sessionBefore = readFileSync(join(runDirectory, 'active-capture-session.json'));
const changedFrameUri = batch.frames[0].uri;
const changedFrameBytes = Buffer.from(png);
changedFrameBytes[changedFrameBytes.length - 1] ^= 0xff;
writeFileSync(join(runDirectory, 'frame-00001.png'), changedFrameBytes);
const changedFrame = await request('resources/read', { uri: changedFrameUri }, 11);
assert(changedFrame.error?.code === -32002, `frame read rejects bytes changed since the metadata batch: ${JSON.stringify(changedFrame)}`);
const corruptBatch = JSON.parse((await request('resources/read', { uri: batchUri }, 12)).result.contents[0].text);
assert(!corruptBatch.frames.some((frame) => frame.sequence === 1) && corruptBatch.incompleteFrames.includes(1), 'a fresh metadata read refuses a CRC-corrupt PNG instead of issuing a new valid-looking digest');
const fileSystem = require('node:fs');
const originalOpen = fileSystem.openSync;
const replacementTarget = join(runDirectory, 'frame-00004.png');
let replaced = false;
try {
  fileSystem.openSync = function replaceBeforeOpen(filePath, ...args) {
    if (filePath === replacementTarget && !replaced) {
      replaced = true;
      renameSync(replacementTarget, join(runDirectory, 'replaced-frame.png'));
      writeFileSync(replacementTarget, png);
    }
    return originalOpen.call(this, filePath, ...args);
  };
  const replacementBatch = JSON.parse((await request('resources/read', { uri: batchUri }, 16)).result.contents[0].text);
  assert(replaced && !replacementBatch.frames.some((frame) => frame.sequence === 4) && replacementBatch.incompleteFrames.includes(4), 'file replacement between stat and open is refused even when the replacement has the same size and bytes');
} finally {
  fileSystem.openSync = originalOpen;
}
const originalRead = fileSystem.readSync;
let growingDescriptor;
let grew = false;
let maximumRequested = 0;
try {
  fileSystem.openSync = function trackGrowingFile(filePath, ...args) {
    const descriptor = originalOpen.call(this, filePath, ...args);
    if (filePath === replacementTarget) growingDescriptor = descriptor;
    return descriptor;
  };
  fileSystem.readSync = function growDuringRead(descriptor, buffer, offset, length, position) {
    if (descriptor === growingDescriptor) {
      maximumRequested = Math.max(maximumRequested, length);
      if (!grew) {
        grew = true;
        appendFileSync(replacementTarget, Buffer.from([0]));
      }
    }
    return originalRead.call(this, descriptor, buffer, offset, length, position);
  };
  const growthBatch = JSON.parse((await request('resources/read', { uri: batchUri }, 17)).result.contents[0].text);
  assert(grew && maximumRequested <= png.length + 1 && !growthBatch.frames.some((frame) => frame.sequence === 4) && growthBatch.incompleteFrames.includes(4), 'a growing file is refused with reads capped at the original size plus one detection byte');
} finally {
  fileSystem.openSync = originalOpen;
  fileSystem.readSync = originalRead;
}
assert(readFileSync(join(runDirectory, 'active-capture-session.json')).equals(sessionBefore), 'resource reads never mutate session lifecycle state');

const serverPath = join(root, 'out', 'mcp', 'runBenchmarkActorMcpServer.js');
assert(existsSync(serverPath), 'compiled stdio server exists');
const stdioRequests = [
  { jsonrpc: '2.0', id: 21, method: 'initialize' },
  { jsonrpc: '2.0', id: 22, method: 'resources/list' },
  { jsonrpc: '2.0', id: 23, method: 'resources/read', params: { uri: sessionUri } },
  { jsonrpc: '2.0', id: 24, method: 'resources/read', params: { uri: batchUri } }
];
const stdioResponses = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, LBA_CAPTURE_ROOT: captureRoot },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const responses = new Map();
  let buffer = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('active-capture stdio resources timed out'));
  }, 10000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        if (message.id !== undefined) responses.set(message.id, message);
      }
      newline = buffer.indexOf('\n');
    }
    if (stdioRequests.every((request) => responses.has(request.id))) {
      clearTimeout(timer);
      child.stdin.end();
      resolve(responses);
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', reject);
  child.stdin.end(`${stdioRequests.map((request) => JSON.stringify(request)).join('\n')}\n`);
});
assert(stdioResponses.get(21).result.capabilities.resources, 'stdio initialize advertises resources');
assert(stdioResponses.get(22).result.resources.length === 4, 'spawned stdio server discovers active sessions from its configured root');
assert(JSON.parse(stdioResponses.get(23).result.contents[0].text).runId === runId, 'spawned stdio server reads session metadata');
assert(JSON.parse(stdioResponses.get(24).result.contents[0].text).schema === 'active-capture-evidence-batch@1', 'spawned stdio server reads bounded evidence batches');
assert(!JSON.stringify([...stdioResponses.values()]).includes(captureRoot), 'stdio responses never expose the configured root');

rmSync(captureRoot, { recursive: true, force: true });
console.log('active-capture-mcp: PASS -- pathless lifecycle, bounded cursors, partial/gap handling, hash-bound frames, no mutation, and stdio resources');