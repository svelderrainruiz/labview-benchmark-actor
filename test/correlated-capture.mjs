#!/usr/bin/env node
// Host-free tests for the correlated capture (#134 slices 1-3): the clip between two markers (src/captureClip.ts),
// the nvidia-smi GPU samples + automatic GPU cues (src/gpuSamples.ts), the agent-cue markers that share the
// user-click nearest-frame grab (src/captureMarkers.ts + media/markerImageGrab.mjs), their MCP tools
// (export_capture_clip, add_capture_marker, get_benchmark_series runId) and the correlator's GPU curves.
// No real nvidia-smi or ffmpeg is needed: both are injected runners. Run after `npm run compile`.
import { JSDOM } from 'jsdom';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const out = (file) => require(join(root, 'out', file));
const gpu = out('gpuSamples.js');
const markersMod = out('captureMarkers.js');
const clip = out('captureClip.js');
const core = out('mcp/benchmarkActorMcpServer.js');
const runner = out('mcp/runBenchmarkActorMcpServer.js');
const { resolveMarkerImageGrab, DEFAULT_MARKER_TOLERANCE_MS } = await import(pathToFileURL(join(root, 'media', 'markerImageGrab.mjs')).href);
const frameMarkers = await import(pathToFileURL(join(root, 'experiments', 'resource-usage-correlation', 'frameMarkers.mjs')).href);
const { buildFrameCorrelatorHtml } = await import(pathToFileURL(join(root, 'media', 'frame-correlator.mjs')).href);

let checks = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
    process.exit(1);
  }
  checks += 1;
}
async function rejects(fn, pattern, msg) {
  try {
    await fn();
  } catch (error) {
    assert(pattern.test(String(error && error.message)), `${msg} (got: ${error && error.message})`);
    return error;
  }
  assert(false, `${msg} (no error thrown)`);
}
const work = mkdtempSync(join(tmpdir(), 'lba-correlated-'));
const stamp = (y, mo, d, h, mi, s, ms) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();

// ---- 1. nvidia-smi parsing (timestamp column, [N/A], multi-GPU, garbage) -----------------------------------
{
  const t = gpu.parseNvidiaSmiTimestamp('2026/11/25 01:53:24.915');
  assert(t === stamp(2026, 11, 25, 1, 53, 24, 915), 'timestamp column parses as local time to epoch ms');
  assert(gpu.parseNvidiaSmiTimestamp(' 2026/11/25 01:53:24 ') === stamp(2026, 11, 25, 1, 53, 24, 0), 'timestamp without milliseconds parses');
  assert(gpu.parseNvidiaSmiTimestamp('2026/11/25 01:53:24.5') === stamp(2026, 11, 25, 1, 53, 24, 500), 'a 1-digit fraction is tenths of a second');
  for (const bad of ['2026/02/31 10:00:00.000', '2026/13/01 10:00:00', '2026/01/30 24:00:00', '2026/01/30 10:60:00', '2026/01/30 10:59:60', 'Tue Nov 25 01:53:24 2026', '', '[N/A]']) {
    assert(gpu.parseNvidiaSmiTimestamp(bad) === undefined, `an impossible or garbage timestamp is rejected: "${bad}"`);
  }
  assert(gpu.parseNvidiaSmiField(' 45 ') === 45 && gpu.parseNvidiaSmiField('4.50') === 4.5 && gpu.parseNvidiaSmiField('-1') === -1, 'numeric fields parse');
  for (const na of ['[N/A]', 'N/A', '[Not Supported]', '[Unknown Error]']) assert(gpu.parseNvidiaSmiField(na) === null, `${na} is null, never 0`);
  for (const junk of ['abc', '4.5W', '', '1e3']) assert(gpu.parseNvidiaSmiField(junk) === undefined, `garbage field "${junk}" is undefined`);

  const identity = gpu.parseNvidiaSmiIdentity('0, NVIDIA RTX PRO 1000 Blackwell Generation Laptop GPU\r\n1, NVIDIA L4\n');
  assert(identity.ok && identity.value.length === 2 && identity.value[1].index === 1 && identity.value[1].name === 'NVIDIA L4', 'identity parses every GPU (CRLF tolerant)');
  assert(!gpu.parseNvidiaSmiIdentity('\n').ok && /no GPUs/.test(gpu.parseNvidiaSmiIdentity('').reason), 'empty identity output fails with a reason');
  assert(/unexpected nvidia-smi GPU line/.test(gpu.parseNvidiaSmiIdentity('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver').reason), 'a driver error line fails identity');

  const one = gpu.parseNvidiaSmiQuery('2026/11/25 01:53:24.915, 0, 45, 4.50\n');
  assert(one.ok && one.value.ms === t && one.value.gpus.length === 1, 'one GPU row parses with its nvidia-smi timestamp as the sample time');
  assert(JSON.stringify(one.value.gpus[0]) === JSON.stringify({ index: 0, utilizationPct: 0, memoryUsedMb: 45, powerW: 4.5 }), 'a 0% reading stays a real 0');
  const multi = gpu.parseNvidiaSmiQuery('2026/11/25 01:53:24.915, 37, 4120, [N/A]\r\n2026/11/25 01:53:24.917, [N/A], 512, 61.20\r\n', [{ index: 3, name: 'a' }, { index: 7, name: 'b' }]);
  assert(multi.ok && multi.value.ms === t, 'multi-GPU sample time is the first row timestamp');
  assert(multi.value.gpus[0].index === 3 && multi.value.gpus[0].powerW === null && multi.value.gpus[1].index === 7 && multi.value.gpus[1].utilizationPct === null, 'multi-GPU rows take the identity indices, [N/A] is null');
  const noIdentity = gpu.parseNvidiaSmiQuery('2026/11/25 01:53:24.915, 1, 2, 3\n2026/11/25 01:53:24.915, 4, 5, 6');
  assert(noIdentity.ok && noIdentity.value.gpus[1].index === 1, 'without identity rows are indexed in order');
  assert(/no GPU rows/.test(gpu.parseNvidiaSmiQuery('').reason), 'empty query output fails');
  assert(/2 GPU rows, expected 1/.test(gpu.parseNvidiaSmiQuery('2026/11/25 01:53:24.915, 1, 2, 3\n2026/11/25 01:53:24.915, 1, 2, 3', [{ index: 0, name: 'x' }]).reason), 'a GPU count mismatch fails the sample');
  for (const garbage of ['0, 45, 4.50', '2026/11/25 01:53:24.915, 45, 4.50', '2026/11/25 01:53:24.915, abc, 45, 4.50', 'garbage', '2026/11/25 01:53:24.915, 1, 2, 3, 4']) {
    const parsed = gpu.parseNvidiaSmiQuery(garbage);
    assert(!parsed.ok && /unexpected nvidia-smi row/.test(parsed.reason), `garbage row fails: "${garbage}"`);
  }
  const longLine = `x${'y'.repeat(100)}`;
  assert(/\.\.\."$/.test(gpu.parseNvidiaSmiQuery(longLine).reason), 'a long garbage row is excerpted');
  assert(gpu.NVIDIA_SMI_QUERY_ARGS[0] === '--query-gpu=timestamp,utilization.gpu,memory.used,power.draw' && gpu.NVIDIA_SMI_QUERY_ARGS[1] === '--format=csv,noheader,nounits', 'the one-shot query asks for the timestamp column first');
  assert(gpu.DEFAULT_GPU_CUE_UTIL_THRESHOLD_PCT === 10 && gpu.DEFAULT_GPU_CUE_MEMORY_RISE_MB === 100, 'cue defaults follow the #134 measurements (10%, 100 MiB)');
}

// ---- 2. nvidia-smi runner (argument array, ENOENT reason) -----------------------------------------------------
{
  const ok = await gpu.nvidiaSmiRunner(process.execPath, 5000)(['-e', 'process.stdout.write("2026/11/25 01:53:24.915, 1, 2, 3")']);
  assert(/01:53:24\.915/.test(ok), 'nvidiaSmiRunner runs the command with an argument array and returns stdout');
  const missing = gpu.nvidiaSmiRunner(join(work, 'no-such-nvidia-smi'));
  const error = await rejects(() => missing(['-L']), /ENOENT|no-such-nvidia-smi/, 'a missing nvidia-smi rejects');
  assert(error.code === 'ENOENT', 'a missing nvidia-smi rejects with ENOENT');
  assert(typeof gpu.nvidiaSmiRunner() === 'function', 'the default runner targets nvidia-smi on PATH');
}

// ---- 3. GPU sampler: identity once, timestamped samples, unavailable never zeros -----------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function smiFake({ identity = '0, NVIDIA Test GPU', rows, delayMs = 0 } = {}) {
  let n = 0;
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === '--query-gpu=index,name') {
      if (identity instanceof Error || identity === null) throw identity;
      return identity;
    }
    if (delayMs) await sleep(delayMs);
    const row = rows(n++);
    if (row instanceof Error) throw row;
    return row;
  };
  return { run, calls };
}
const smiRow = (i, util, mem) => {
  const d = new Date(2026, 10, 25, 1, 53, 24, 0);
  d.setMilliseconds(i * 100);
  const p = (v, w = 2) => String(v).padStart(w, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}, ${util}, ${mem}, 5.00\n`;
};
{
  const dir = join(work, 'sampler-ok');
  mkdirSync(dir);
  const fake = smiFake({ rows: (i) => (i === 1 ? 'garbage\n' : smiRow(i, i * 10, 45 + i)) });
  const sampler = gpu.startGpuSampler({ dir, run: fake.run, intervalMs: 2 });
  const ready = await sampler.ready;
  assert(ready.available && ready.gpus[0].name === 'NVIDIA Test GPU', 'the sampler records the GPU identity once');
  assert(JSON.parse(readFileSync(join(dir, 'gpu.json'), 'utf8')).available === true, 'gpu.json is written once the identity probe finished');
  while (fake.calls.length < 6) await sleep(2);
  const header = await sampler.stop();
  assert(fake.calls.filter((a) => a[0] === '--query-gpu=index,name').length === 1, 'the identity is queried once per capture');
  assert(fake.calls.slice(1).every((a) => a[0] === '--query-gpu=timestamp,utilization.gpu,memory.used,power.draw'), 'every sample is a one-shot timestamped query');
  const lines = readFileSync(join(dir, 'gpu.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(lines.length === header.sampleCount && header.failedSamples === 1 && /unexpected nvidia-smi row/.test(header.lastError), 'a garbage sample is counted as failed, not written');
  assert(lines[0].ms === stamp(2026, 11, 25, 1, 53, 24, 0) && lines[1].ms === stamp(2026, 11, 25, 1, 53, 24, 200), 'samples are stamped with the nvidia-smi timestamp, not the arrival time');
  assert(JSON.parse(readFileSync(join(dir, 'gpu.json'), 'utf8')).sampleCount === header.sampleCount, 'stop() rewrites gpu.json with the final counts');
}
{
  const dir = join(work, 'sampler-inflight');
  mkdirSync(dir);
  const fake = smiFake({ rows: (i) => smiRow(i, 5, 45), delayMs: 25 });
  const sampler = gpu.startGpuSampler({ dir, run: fake.run, now: Date.now });
  await sampler.ready;
  const header = await sampler.stop();
  assert(header.sampleCount === 1 && !header.failedSamples && header.lastError === undefined, 'stop() waits for the in-flight sample and schedules no more');
  await sleep(40);
  assert(fake.calls.length === 2, 'no sample runs after stop()');
}
{
  const dir = join(work, 'sampler-all-fail');
  mkdirSync(dir);
  const fake = smiFake({ rows: () => new Error('nvidia-smi timed out') });
  const sampler = gpu.startGpuSampler({ dir, run: fake.run, intervalMs: 1 });
  await sampler.ready;
  while (fake.calls.length < 3) await sleep(2);
  const header = await sampler.stop();
  assert(!header.available && header.reason === 'no GPU sample succeeded (nvidia-smi timed out)' && header.sampleCount === 0, 'zero successful samples marks the series unavailable with the reason');
  assert(!existsSync(join(dir, 'gpu.jsonl')), 'a failing sampler writes no zero rows');
}
for (const [name, identity, reason] of [
  ['enoent', Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }), /^nvidia-smi not found on PATH$/],
  ['garbage', 'No devices were found', /unexpected nvidia-smi GPU line/],
  ['non-error', null, /^null$/]
]) {
  const dir = join(work, `sampler-${name}`);
  mkdirSync(dir);
  const fake = smiFake({ identity, rows: () => smiRow(0, 1, 1) });
  const sampler = gpu.startGpuSampler({ dir, run: fake.run });
  const ready = await sampler.ready;
  const header = await sampler.stop();
  assert(!ready.available && reason.test(ready.reason) && !header.available && header.sampleCount === undefined, `identity ${name}: series unavailable with the reason`);
  assert(fake.calls.length === 1 && !existsSync(join(dir, 'gpu.jsonl')), `identity ${name}: no sampling, no zeros`);
}

// ---- 4. reading + attaching the series (additive, old captures unchanged) -----------------------------------
{
  const empty = join(work, 'series-none');
  mkdirSync(empty);
  assert(gpu.readGpuSeries(empty) === null, 'a capture without gpu.json has no GPU series (old capture)');
  const record = { startMs: 1000, frames: [{ index: 0, tMs: 0 }] };
  const before = JSON.stringify(record);
  gpu.attachGpuSeries(record, null);
  assert(JSON.stringify(record) === before, 'attaching no series leaves an old capture byte-identical');

  const broken = join(work, 'series-broken');
  mkdirSync(broken);
  writeFileSync(join(broken, 'gpu.json'), '{not json');
  const brokenSeries = gpu.readGpuSeries(broken);
  assert(!brokenSeries.header.available && /gpu\.json unreadable/.test(brokenSeries.header.reason), 'an unreadable gpu.json is an unavailable series with the reason');

  const unavailable = join(work, 'series-unavailable');
  mkdirSync(unavailable);
  writeFileSync(join(unavailable, 'gpu.json'), JSON.stringify({ schema: gpu.GPU_SERIES_SCHEMA, source: 'nvidia-smi', available: false, reason: 'nvidia-smi not found on PATH', gpus: [] }));
  writeFileSync(join(unavailable, 'gpu.jsonl'), '{"ms":1,"gpus":[]}\n');
  const unavailableSeries = gpu.readGpuSeries(unavailable);
  assert(unavailableSeries.samples.length === 0, 'an unavailable series reads no samples');
  const record2 = { startMs: 'x', frames: [{ index: 0, tMs: 0 }] };
  gpu.attachGpuSeries(record2, unavailableSeries);
  assert(record2.gpu.available === false && record2.gpu.reason === 'nvidia-smi not found on PATH' && record2.gpu.samples.length === 0, 'an unavailable series is persisted with its reason, no samples');
  assert(record2.frames[0].gpus === undefined && !('failedSamples' in record2.gpu), 'an unavailable series adds nothing to frames');

  const noLines = join(work, 'series-nolines');
  mkdirSync(noLines);
  writeFileSync(join(noLines, 'gpu.json'), JSON.stringify({ schema: gpu.GPU_SERIES_SCHEMA, source: 'nvidia-smi', available: true, gpus: [{ index: 0, name: 'g' }] }));
  const noLineSeries = gpu.readGpuSeries(noLines);
  assert(noLineSeries.header.available && noLineSeries.samples.length === 0, 'an available header without gpu.jsonl yields no samples');
  const record3 = { frames: [{ index: 0, tMs: 0 }] };
  gpu.attachGpuSeries(record3, noLineSeries);
  assert(record3.gpu.sampleCount === 0 && record3.frames[0].gpus === undefined, 'an empty available series leaves frames untouched');

  const ok = join(work, 'series-ok');
  mkdirSync(ok);
  writeFileSync(join(ok, 'gpu.json'), JSON.stringify({ schema: gpu.GPU_SERIES_SCHEMA, source: 'nvidia-smi', available: true, gpus: [{ index: 0, name: 'g' }], sampleCount: 3, failedSamples: 2 }));
  const reading = (u) => [{ index: 0, utilizationPct: u, memoryUsedMb: 50, powerW: 5 }];
  writeFileSync(join(ok, 'gpu.jsonl'), [
    JSON.stringify({ ms: 1000, gpus: reading(1) }),
    JSON.stringify({ ms: 1090, gpus: reading(2) }),
    JSON.stringify({ ms: 'bad', gpus: reading(9) }),
    JSON.stringify({ ms: 1200, gpus: reading(3) }),
    '{"ms":13'
  ].join('\n'));
  const series = gpu.readGpuSeries(ok);
  assert(series.samples.length === 3, 'readGpuSeries skips a non-numeric sample and a partial last line');
  const record4 = { startMs: 1000, frames: [{ index: 0, tMs: 0 }, { index: 1, tMs: 83 }, { index: 2, tMs: 'x' }, { index: 3, tMs: 250 }] };
  gpu.attachGpuSeries(record4, series);
  assert(record4.gpu.available && record4.gpu.failedSamples === 2 && record4.gpu.samples[1].tMs === 90 && record4.gpu.samples[1].ms === 1090, 'the gpu block carries samples on both the epoch and frame axes');
  assert(record4.frames[0].gpus[0].utilizationPct === 1 && record4.frames[1].gpus[0].utilizationPct === 2 && record4.frames[3].gpus[0].utilizationPct === 3, 'each frame takes the nearest GPU sample');
  assert(record4.frames[2].gpus === undefined, 'a frame without a finite instant gets no GPU reading');
}

// ---- 5. rising edges + automatic cues (two edges, debounce, platform lag) -----------------------------------
{
  const pts = (values, step = 100) => values.map((value, i) => ({ ms: i * step, value }));
  const over = (v) => v >= 10;
  assert(gpu.risingEdges(pts([20, 0, 20]), over, 1000).length === 0, 'a signal already above at the start is not an edge, and a short dip does not re-arm');
  assert(JSON.stringify(gpu.risingEdges(pts([0, 12, 8, 12, 9, 15, 3, 14]), over, 1000)) === JSON.stringify([100]), 'a noisy signal around the threshold yields one edge');
  assert(JSON.stringify(gpu.risingEdges(pts([0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12]), over, 1000)) === JSON.stringify([100, 1300]), 'the detector re-arms after staying below for rearmMs');
  assert(JSON.stringify(gpu.risingEdges(pts([null, NaN, 0, null, 50]), over, 1000)) === JSON.stringify([400]), 'null/NaN readings are skipped, never zeros');

  assert(gpu.gpuUtilizationLag('WIN').minMs === 450 && gpu.gpuUtilizationLag('win32').platform === 'win32', 'the Windows lag is ~0.45 s');
  assert(gpu.gpuUtilizationLag('LINUX').maxMs === 380 && gpu.gpuUtilizationLag('linux').minMs === 180, 'the Linux lag is 0.18-0.38 s');
  assert(gpu.gpuUtilizationLag('darwin') === null && gpu.gpuUtilizationLag(undefined) === null, 'an unmeasured platform has no lag');

  const sample = (ms, util, mem) => ({ ms, gpus: [{ index: 0, utilizationPct: util, memoryUsedMb: mem, powerW: 5 }] });
  const cold = [sample(0, 0, 45), sample(100, 0, 60), sample(3680, 0, 2200), sample(4800, 3, 4100), sample(5090, 22, 4100), sample(5190, 8, 4100), sample(5290, 25, 4100)];
  const cues = gpu.gpuCues(cold, { platform: 'LINUX' });
  assert(cues.length === 2 && cues[0].edge === 'model-load' && cues[0].ms === 3680 && cues[1].edge === 'compute' && cues[1].ms === 5090, 'model load (VRAM rise) leads compute (utilization) on a cold start');
  assert(cues[0].label === 'GPU memory rose >100 MiB above start (model load)' && cues[1].label === 'GPU rose above 10% (compute, util lags 0.18-0.38 s)', `cue labels name the edge and the platform lag: ${cues.map((c) => c.label)}`);
  assert(cues.every((c) => c.utilizationLag && c.utilizationLag.platform === 'linux' && c.label.length <= 80), 'every automatic cue carries the measured lag and fits 80 characters');
  const win = gpu.gpuCues(cold, { platform: 'WIN', utilThresholdPct: 20, memoryRiseMb: 3000, rearmMs: 0 });
  assert(win.map((c) => c.ms).join() === '4800,5090,5290' && win[1].label === 'GPU rose above 20% (compute, util lags ~0.45 s)', 'settings move both thresholds; a short rearm admits a second compute edge');
  const unmeasured = gpu.gpuCues(cold);
  assert(unmeasured[1].label === 'GPU rose above 10% (compute)' && unmeasured[1].utilizationLag === null, 'an unmeasured platform keeps the plain compute label');
  const twoGpus = gpu.gpuCues([
    { ms: 0, gpus: [{ index: 1, utilizationPct: 0, memoryUsedMb: null, powerW: null }, { index: 0, utilizationPct: 0, memoryUsedMb: 10, powerW: 1 }] },
    { ms: 100, gpus: [{ index: 1, utilizationPct: 50, memoryUsedMb: null, powerW: null }] },
    { ms: 200, gpus: [{ index: 0, utilizationPct: 0, memoryUsedMb: 500, powerW: 1 }] }
  ]);
  assert(twoGpus.length === 2 && twoGpus[0].label === 'GPU 1 rose above 10% (compute)' && twoGpus[1].label === 'GPU 0 memory rose >100 MiB above start (model load)', 'several GPUs prefix the label with the GPU index; no memory baseline means no model-load edge');
  const sameInstant = gpu.gpuCues([
    { ms: 0, gpus: [{ index: 1, utilizationPct: 0, memoryUsedMb: null, powerW: null }, { index: 0, utilizationPct: 0, memoryUsedMb: null, powerW: null }] },
    { ms: 100, gpus: [{ index: 1, utilizationPct: 90, memoryUsedMb: null, powerW: null }, { index: 0, utilizationPct: 90, memoryUsedMb: null, powerW: null }] }
  ]);
  assert(sameInstant.map((c) => c.gpuIndex).join() === '0,1', 'simultaneous cues are ordered by GPU index');
  assert(gpu.gpuCues([]).length === 0, 'no samples, no cues');
}

// ---- 6. the shared nearest-frame grab (every branch of media/markerImageGrab.mjs) ----------------------------
{
  const frames = [{ index: 0, captureEpochMs: 0, image: 'frame-00001.png' }, { index: 1, captureEpochMs: 1000 }, null, { index: 2, captureEpochMs: NaN }];
  assert(frameMarkers.resolveMarkerImageGrab.toString() === resolveMarkerImageGrab.toString() && readFileSync(join(root, 'media', 'markerImageGrab.mjs'), 'utf8') === readFileSync(join(root, 'experiments', 'resource-usage-correlation', 'markerImageGrab.mjs'), 'utf8') && frameMarkers.DEFAULT_MARKER_TOLERANCE_MS === DEFAULT_MARKER_TOLERANCE_MS && DEFAULT_MARKER_TOLERANCE_MS === 200, 'frameMarkers.mjs re-exports the one shared grab unchanged');
  let threw = false;
  try { resolveMarkerImageGrab(0, frames, -1); } catch { threw = true; }
  assert(threw, 'a negative tolerance throws');
  const miss = JSON.stringify({ nearestFrameIndex: null, nearestCaptureEpochMs: null, deltaMs: null, admitted: false, imageRef: null });
  assert(JSON.stringify(resolveMarkerImageGrab(NaN, frames)) === miss && JSON.stringify(resolveMarkerImageGrab(0, 'x')) === miss && JSON.stringify(resolveMarkerImageGrab(0, [])) === miss, 'a non-finite instant or no frames is a miss');
  assert(JSON.stringify(resolveMarkerImageGrab(0, [null, { index: 0, captureEpochMs: Infinity }])) === miss, 'only unusable frames is a miss');
  const hit = resolveMarkerImageGrab(150, frames);
  assert(hit.nearestFrameIndex === 0 && hit.deltaMs === 150 && hit.admitted && hit.imageRef === 'frame-00001.png', 'within tolerance the grab is admitted with the image');
  const noImage = resolveMarkerImageGrab(1100, frames);
  assert(noImage.admitted && noImage.imageRef === null, 'an admitted frame without an image has a null imageRef');
  const far = resolveMarkerImageGrab(500, frames);
  assert(far.nearestFrameIndex === 0 && far.deltaMs === 500 && !far.admitted && far.imageRef === null, 'outside tolerance the grab is not admitted and has no image');
  const tie = resolveMarkerImageGrab(500, [{ index: 1, captureEpochMs: 1000 }, { index: 0, captureEpochMs: 0 }, { index: 2, captureEpochMs: 1000 }], 600);
  assert(tie.nearestFrameIndex === 0, 'an exact tie keeps the earlier frame');
  assert(resolveMarkerImageGrab(0, [{ index: 1.5, captureEpochMs: 0 }]).nearestFrameIndex === null, 'a non-integer frame index is reported as null');
}

// ---- 7. agent-cue markers (same grab as a user click) ---------------------------------------------------------
const grab = await markersMod.loadMarkerImageGrab(root);
{
  assert(grab === resolveMarkerImageGrab, 'loadMarkerImageGrab loads the staged media grab');
  const fakeRoot = join(work, 'fake-ext');
  mkdirSync(join(fakeRoot, 'media'), { recursive: true });
  writeFileSync(join(fakeRoot, 'media', 'markerImageGrab.mjs'), 'export const nothing = 1;\n');
  await rejects(() => markersMod.loadMarkerImageGrab(fakeRoot), /does not export resolveMarkerImageGrab/, 'a media module without the grab is rejected');

  assert(markersMod.validateMarkerLabel('  model ready  ') === 'model ready', 'labels are trimmed');
  for (const bad of [undefined, 3, '   ', 'x'.repeat(81)]) {
    await rejects(() => markersMod.validateMarkerLabel(bad), /label must be/, `label ${JSON.stringify(bad)} is rejected`);
  }
  const record = { startMs: 10000, frames: [{ index: 0, tMs: 0, image: 'frame-00001.png' }, { index: 1, tMs: 83, image: 'frame-00002.png' }, { index: 2, tMs: 1000 }], markers: [{ kind: 'user-click' }] };
  const byInstant = markersMod.buildAgentCueMarker(record, { instantMs: 90, label: 'tokens streaming', createdAt: '2026-11-25T00:00:00.000Z' }, grab);
  const userClick = grab(90, record.frames.map((f) => ({ index: f.index, captureEpochMs: f.tMs, image: f.image })), 200);
  assert(JSON.stringify(byInstant.imageGrab) === JSON.stringify({ toleranceMs: 200, ...userClick }), 'an agent cue grabs exactly what a user click at the same instant grabs');
  assert(byInstant.kind === 'agent-cue' && byInstant.id === 'cue-90-2' && byInstant.frameIndex === 1 && byInstant.label === 'tokens streaming' && byInstant.imageGrab.imageRef === 'frame-00002.png', 'the cue carries kind agent-cue, the nearest frame and the image');
  const byFrame = markersMod.buildAgentCueMarker({ frames: record.frames }, { frameIndex: 2, label: 'done', toleranceMs: 0 }, grab);
  assert(byFrame.instantMs === 1000 && byFrame.frameIndex === 2 && byFrame.id === 'cue-1000-1' && byFrame.imageGrab.toleranceMs === 0 && byFrame.imageGrab.imageRef === null && typeof byFrame.createdAt === 'string', 'a frame index cue lands on that frame instant');
  const farCue = markersMod.buildAgentCueMarker(record, { instantMs: 600, label: 'gap' }, grab);
  assert(!farCue.imageGrab.admitted && farCue.imageGrab.nearestFrameIndex === 2 && farCue.imageGrab.deltaMs === 400, 'a cue outside tolerance is recorded but not admitted');
  const oddFrames = { frames: [{ index: 'a', tMs: 0 }] };
  assert(markersMod.buildAgentCueMarker(oddFrames, { frameIndex: 0, label: 'x' }, grab).frameIndex === 0, 'a frame cue keeps its frame index when the grab has none');
  assert(markersMod.buildAgentCueMarker(oddFrames, { instantMs: 0, label: 'x' }, grab).frameIndex === null, 'an instant cue without a grab index has no frame index');
  await rejects(() => markersMod.buildAgentCueMarker({ frames: 'none' }, { instantMs: 0, label: 'x' }, grab), /no frames/, 'a capture without frames rejects a cue');
  await rejects(() => markersMod.buildAgentCueMarker(record, { label: 'x' }, grab), /exactly one/, 'a cue needs an instant or a frame');
  await rejects(() => markersMod.buildAgentCueMarker(record, { instantMs: 1, frameIndex: 1, label: 'x' }, grab), /exactly one/, 'a cue takes an instant or a frame, not both');
  await rejects(() => markersMod.buildAgentCueMarker(record, { frameIndex: 3, label: 'x' }, grab), /between 0 and 2/, 'a frame index outside the capture is rejected');
  await rejects(() => markersMod.buildAgentCueMarker(record, { instantMs: Infinity, label: 'x' }, grab), /finite/, 'a non-finite instant is rejected');

  const lag = gpu.gpuUtilizationLag('WIN');
  const cueMarkers = markersMod.gpuCueMarkers(record, [
    { ms: 10083, edge: 'model-load', gpuIndex: 0, label: 'GPU memory rose >100 MiB above start (model load)', utilizationLag: lag },
    { ms: 11000, edge: 'compute', gpuIndex: 0, label: 'GPU rose above 10% (compute, util lags ~0.45 s)', utilizationLag: lag }
  ], grab, '2026-11-25T00:00:00.000Z');
  assert(cueMarkers.length === 2 && cueMarkers[0].instantMs === 83 && cueMarkers[0].frameIndex === 1 && cueMarkers[1].frameIndex === 2, 'GPU cues map their epoch instant onto the frame axis');
  assert(cueMarkers[0].id === 'cue-83-2' && cueMarkers[1].id === 'cue-1000-3', 'GPU cue ids continue the marker sequence');
  assert(cueMarkers[1].source.kind === 'gpu-edge' && cueMarkers[1].source.edge === 'compute' && cueMarkers[1].source.sampleMs === 11000 && cueMarkers[1].source.utilizationLag.minMs === 450, 'each GPU cue records its edge, sample and the platform lag');
  const noStart = markersMod.gpuCueMarkers({ frames: record.frames }, [{ ms: 83, edge: 'compute', gpuIndex: 0, label: 'c', utilizationLag: null }], grab);
  assert(noStart[0].instantMs === 83 && noStart[0].id === 'cue-83-1', 'a record without startMs maps cues from 0');

  const capDir = join(work, 'append');
  mkdirSync(capDir);
  const capturePath = join(capDir, 'capture.json');
  writeFileSync(capturePath, JSON.stringify({ frames: [] }));
  assert(markersMod.appendCaptureMarker(capturePath, { id: 'a' }) === 1 && markersMod.appendCaptureMarker(capturePath, { id: 'b' }) === 2, 'appendCaptureMarker creates markers[] and appends');
  const text = readFileSync(capturePath, 'utf8');
  assert(text.endsWith('}\n') && text.includes('\n  "markers": [') && JSON.parse(text).markers[1].id === 'b', 'capture.json keeps the 2-space format with a trailing newline');

  // #138: the operator's twins (m-10188-1 / m-10188-2: same kind, instantMs and frameIndex) are stored once.
  const twinA = { id: 'm-10188-1', instantMs: 10187.682409099365, frameIndex: 10, kind: 'user-click', imageGrab: { nearestFrameIndex: 10, deltaMs: 255.68, admitted: false, imageSrc: null } };
  const twinB = { ...twinA, id: 'm-10188-2' };
  assert(markersMod.isTwinMarker(twinA, twinB) && !markersMod.isTwinMarker(twinA, { ...twinB, frameIndex: 11 }) && !markersMod.isTwinMarker(twinA, { ...twinB, instantMs: 10187.7 }) && !markersMod.isTwinMarker(twinA, { ...twinB, kind: 'agent-cue' }), 'isTwinMarker compares kind, instantMs and frameIndex');
  assert(!markersMod.isTwinMarker({ id: 'a' }, { id: 'b' }) && !markersMod.isTwinMarker(null, twinA) && !markersMod.isTwinMarker({ ...twinA, label: 'x' }, { ...twinB, label: 'y' }), 'markers without an instant, or with different labels, are never twins');
  assert(markersMod.appendCaptureMarker(capturePath, twinA) === 3, 'a new user-click marker is appended');
  const beforeTwin = readFileSync(capturePath, 'utf8');
  assert(markersMod.appendCaptureMarker(capturePath, twinB) === 3, 'an exact twin is not appended; the unchanged count is returned');
  assert(readFileSync(capturePath, 'utf8') === beforeTwin, 'capture.json is unchanged by a rejected twin');
  assert(markersMod.appendCaptureMarker(capturePath, { ...twinB, id: 'm-10188-3', frameIndex: 11 }) === 4, 'a marker differing in frameIndex is still appended');
  const stored = JSON.parse(readFileSync(capturePath, 'utf8')).markers[2];
  assert(JSON.stringify(stored) === JSON.stringify(twinA), 'the stored user-click marker keeps its id, fields and imageGrab shape');
}

// ---- 8. capture directory resolution -------------------------------------------------------------------------
function makeCapture(rootDir, record, { meta = true, uuid = randomUUID() } = {}) {
  const dir = join(rootDir, `run-${uuid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'capture.json'), `${JSON.stringify(record, null, 2)}\n`);
  if (meta) writeFileSync(join(dir, 'capture-meta.json'), '{}');
  return { dir, uuid };
}
{
  const capRoot = join(work, 'captures');
  mkdirSync(capRoot);
  await rejects(() => markersMod.resolveCaptureDir(''), /no capture root/, 'an unset capture root is rejected');
  await rejects(() => markersMod.resolveCaptureDir(join(work, 'nope')), /no capture root/, 'a missing capture root is rejected');
  await rejects(() => markersMod.resolveCaptureDir(capRoot), /no assembled capture/, 'an empty capture root has no latest capture');
  const older = makeCapture(capRoot, { frames: [] }, { uuid: '00000000-0000-4000-8000-000000000001' });
  const newer = makeCapture(capRoot, { frames: [] }, { meta: false, uuid: '00000000-0000-4000-8000-000000000002' });
  utimesSync(join(older.dir, 'capture-meta.json'), 1000, 1000);
  utimesSync(join(newer.dir, 'capture.json'), 2000, 2000);
  mkdirSync(join(capRoot, `run-${randomUUID()}`));
  mkdirSync(join(capRoot, 'not-a-run'));
  symlinkSync(older.dir, join(capRoot, `run-${randomUUID()}`));
  assert(markersMod.resolveCaptureDir(capRoot).runId === newer.uuid && markersMod.resolveCaptureDir(capRoot, 'latest').runId === newer.uuid, 'latest picks the newest capture (capture.json time when there is no meta)');
  utimesSync(join(older.dir, 'capture-meta.json'), 2000, 2000);
  assert(markersMod.resolveCaptureDir(capRoot).runId === newer.uuid, 'a time tie picks the later run name deterministically');
  const explicit = markersMod.resolveCaptureDir(capRoot, older.uuid.toUpperCase());
  assert(explicit.runId === older.uuid && explicit.dir.endsWith(`run-${older.uuid}`), 'an explicit run id resolves case-insensitively');
  await rejects(() => markersMod.resolveCaptureDir(capRoot, randomUUID()), /not found/, 'an unknown run id is rejected');
  assert(markersMod.captureIdOf(older.dir) === older.uuid && markersMod.captureIdOf(join(work, 'plain-dir')) === 'plain-dir', 'captureIdOf is the run uuid, else the directory name');
}

// ---- 9. clip planning + export (slice 1) ---------------------------------------------------------------------
function png(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}
function clipCapture(rootDir, { frames = 5, tMs = (i) => i * 1000, fps = 1, markers, screen = null, width = 65, height = 49 } = {}) {
  const record = {
    fps,
    startMs: 50000,
    screen,
    frames: Array.from({ length: frames }, (_, i) => ({ index: i, tMs: tMs(i), image: `frame-${String(i + 1).padStart(5, '0')}.png` })),
    markers: markers ?? []
  };
  const cap = makeCapture(rootDir, record);
  record.frames.forEach((f) => writeFileSync(join(cap.dir, f.image), png(width, height)));
  return { ...cap, record };
}
const click = (frameIndex, admitted = true, extra = {}) => ({ id: `m-${frameIndex}`, kind: 'user-click', instantMs: frameIndex * 1000 + 20, frameIndex, imageGrab: { nearestFrameIndex: frameIndex, deltaMs: 20, admitted, imageSrc: 'data:' }, ...extra });
{
  const clipRoot = join(work, 'clip-captures');
  mkdirSync(clipRoot);
  const cap = clipCapture(clipRoot, {
    markers: [click(0), { ...click(3), id: 'late', kind: 'agent-cue', label: 'end', imageGrab: { toleranceMs: 150, nearestFrameIndex: 3, deltaMs: 20, admitted: true } }, click(1)]
  });
  assert(JSON.stringify(clip.readPngSize(join(cap.dir, 'frame-00001.png'))) === JSON.stringify({ width: 65, height: 49 }), 'readPngSize reads the IHDR size');
  writeFileSync(join(cap.dir, 'not-png.png'), Buffer.alloc(40));
  await rejects(() => clip.readPngSize(join(cap.dir, 'not-png.png')), /not a PNG frame/, 'a non-PNG frame is rejected');

  const latest = clip.planClip(cap.record, cap.dir);
  assert(latest.selection === 'latest-markers' && latest.from === 1 && latest.to === 3, 'the default clip spans the latest two markers, in frame order');
  assert(latest.markers[0].role === 'start' && latest.markers[0].markerIndex === 2 && latest.markers[1].markerIndex === 1 && latest.markers[1].label === 'end', 'latest markers out of order are swapped into start/end');
  assert(latest.markers[1].imageGrab.toleranceMs === 150 && latest.markers[0].imageGrab.toleranceMs === 200 && latest.markers[0].imageGrab.deltaMs === 20 && latest.markers[0].imageGrab.admitted === true, 'the receipt reports each marker tolerance (click default 200 ms), deltaMs and admitted');
  assert(latest.markers[0].frameSource === 'imageGrab.nearestFrameIndex' && latest.captureId === cap.uuid, 'an admitted marker uses imageGrab.nearestFrameIndex');
  assert(latest.crop.width === 64 && latest.crop.height === 48 && latest.crop.mode === 'full' && latest.crop.frameWidth === 65, 'odd frame dimensions are trimmed to even');
  assert(JSON.stringify(latest.durationsMs) === '[1000,1000,1000]' && latest.realDurationMs === 3000 && latest.outputFps === 1, 'slow desktop frames are held for their real interval; the last for 1/fps');

  // #138: the operator's capture stored every click twice; the default clip skips the exact twins.
  const twin = (frameIndex, seq, instantMs) => ({ id: `m-${Math.round(instantMs)}-${seq}`, kind: 'user-click', instantMs, frameIndex, imageGrab: { nearestFrameIndex: frameIndex, deltaMs: 255.68, admitted: false, imageSrc: null } });
  const doubled = { ...cap.record, markers: [twin(1, 1, 1255.68), twin(1, 2, 1255.68), twin(3, 3, 3141.18), twin(3, 4, 3141.18)] };
  const dedup = clip.planClip(doubled, cap.dir);
  assert(dedup.selection === 'latest-markers' && dedup.from === 1 && dedup.to === 3, `the default clip skips exact twins (got ${dedup.from}-${dedup.to})`);
  assert(dedup.markers[0].markerIndex === 0 && dedup.markers[0].id === 'm-1256-1' && dedup.markers[1].markerIndex === 2 && dedup.markers[1].id === 'm-3141-3', 'the first of each twin pair is used');
  const doubledTail = { ...cap.record, markers: [click(0), click(2), twin(4, 3, 4020), twin(4, 4, 4020)] };
  const tail = clip.planClip(doubledTail, cap.dir);
  assert(tail.from === 2 && tail.to === 4 && tail.markers[1].markerIndex === 2, 'a twin pair at the end pairs with the previous distinct marker');
  assert(clip.planClip(doubled, cap.dir, { fromMarker: 0, toMarker: 1 }).from === 1, 'explicit marker indices are honoured as given');
  await rejects(() => clip.planClip({ ...cap.record, markers: [twin(1, 1, 1255.68), twin(1, 2, 1255.68)] }, cap.dir), /has 1 marker\(s\) \(plus 1 exact twin\(s\)\)/, 'a twin pair alone is one marker, not a clip');

  const byIndex = clip.planClip(cap.record, cap.dir, { fromMarker: 0, toMarker: 'late', crop: { x: 1, y: 2, w: 31, h: 20 } });
  assert(byIndex.selection === 'markers' && byIndex.from === 0 && byIndex.to === 3 && byIndex.markers[1].id === 'late', 'markers can be given by index or id');
  assert(byIndex.crop.mode === 'rect' && byIndex.crop.width === 30 && byIndex.crop.x === 1, 'a crop rectangle is validated and trimmed to even');
  const byFrames = clip.planClip(cap.record, cap.dir, { fromFrame: 2, toFrame: 2 });
  assert(byFrames.selection === 'frames' && byFrames.markers === null && byFrames.images.length === 1 && byFrames.realDurationMs === 1000, 'a single frame is a valid 1-frame clip');

  const rejectsPlan = (record, options, pattern, msg, dir = cap.dir) => rejects(() => clip.planClip(record, dir, options), pattern, msg);
  await rejectsPlan({ ...cap.record, frames: 'x' }, {}, /no frames/, 'a capture without frames has no clip');
  await rejectsPlan({ ...cap.record, markers: undefined }, {}, /0 marker\(s\)/, 'the default needs two markers');
  await rejectsPlan(cap.record, { fromMarker: 0, toFrame: 1 }, /not both/, 'markers and frames are exclusive');
  await rejectsPlan(cap.record, { monitor: 0, crop: { x: 0, y: 0, w: 2, h: 2 } }, /monitor or a crop/, 'monitor and crop are exclusive');
  await rejectsPlan(cap.record, { fromFrame: 1 }, /both a start and an end frame/, 'a frame range needs both ends');
  await rejectsPlan(cap.record, { toMarker: 1 }, /both a start and an end marker/, 'a marker range needs both ends');
  await rejectsPlan(cap.record, { fromMarker: 0, toMarker: 9 }, /not in capture/, 'a marker index outside the capture is rejected');
  await rejectsPlan(cap.record, { fromMarker: 'nope', toMarker: 0 }, /not in capture/, 'an unknown marker id is rejected');
  const foreign = { ...cap.record, markers: [click(0, true, { captureId: 'other-capture' }), click(1, true, { runId: cap.uuid })] };
  await rejectsPlan(foreign, { fromMarker: 0, toMarker: 1 }, /belongs to capture other-capture/, 'a marker from another capture is rejected');
  assert(clip.planClip(foreign, cap.dir, { fromMarker: 1, toMarker: 1 }).from === 1, 'a marker stamped with this capture id is accepted');
  await rejectsPlan(cap.record, { fromMarker: 1, toMarker: 0 }, /end \(frame 0\) is before the start \(frame 3\)/, 'an end before the start is rejected');
  await rejectsPlan(cap.record, { fromFrame: 3, toFrame: 1 }, /before the start/, 'an end frame before the start frame is rejected');
  await rejectsPlan(cap.record, { fromFrame: 0, toFrame: 5 }, /end frame 5 is not a frame/, 'a frame outside the capture is rejected');
  const notAdmitted = { ...cap.record, markers: [click(0, false, { frameIndex: 2 }), { kind: 7, id: 3, label: 4, instantMs: 'x', frameIndex: 4, imageGrab: null }] };
  const fallback = clip.planClip(notAdmitted, cap.dir);
  assert(fallback.from === 2 && fallback.markers[0].frameSource === 'frameIndex' && fallback.markers[0].imageGrab.admitted === false && fallback.markers[0].imageGrab.nearestFrameIndex === 0, 'a marker not admitted falls back to its frameIndex and reports admitted false');
  assert(fallback.markers[1].id === null && fallback.markers[1].kind === null && !('label' in fallback.markers[1]) && fallback.markers[1].instantMs === null && fallback.markers[1].imageGrab.deltaMs === null && fallback.markers[1].imageGrab.nearestFrameIndex === null, 'malformed marker fields are reported as null');
  await rejectsPlan({ ...cap.record, markers: [click(0), { kind: 'user-click', imageGrab: { admitted: false } }] }, {}, /marker 1 has no frame index/, 'a marker without any frame index is rejected');
  await rejectsPlan({ ...cap.record, frames: [{ index: 0, tMs: 0 }] }, { fromFrame: 0, toFrame: 0 }, /frame 0 image is missing/, 'a frame without an image is rejected');
  await rejectsPlan({ ...cap.record, frames: [{ index: 0, tMs: 0, image: '../frame-00001.png' }] }, { fromFrame: 0, toFrame: 0 }, /image is missing/, 'a frame image outside the capture is rejected');
  await rejectsPlan({ ...cap.record, frames: [{ index: 0, tMs: 0, image: 'gone.png' }] }, { fromFrame: 0, toFrame: 0 }, /image is missing/, 'a deleted frame image is rejected');
  await rejectsPlan(cap.record, { fromFrame: 0, toFrame: 0, crop: { x: 40, y: 0, w: 30, h: 10 } }, /outside the 65x49 frame/, 'a crop outside the frame is rejected');
  await rejectsPlan(cap.record, { fromFrame: 0, toFrame: 0, crop: { x: 0, y: 0, w: 1.5, h: 10 } }, /outside/, 'a non-integer crop is rejected');
  await rejectsPlan(cap.record, { fromFrame: 0, toFrame: 0, crop: { x: 0, y: 0, w: 1, h: 10 } }, /too small/, 'a crop under 2x2 is rejected');
  await rejectsPlan(cap.record, { fromFrame: 0, toFrame: 0, monitor: 0 }, /records no monitor 0/, 'a monitor crop needs a recorded screen layout');
  await rejectsPlan({ ...cap.record, screen: { width: 65, height: 49, monitors: 'x' } }, { fromFrame: 0, toFrame: 0, monitor: 0 }, /no monitor 0/, 'a malformed monitor layout is rejected');
  const monitorPlan = clip.planClip({ ...cap.record, screen: { monitors: [{ x: 0, y: 0, width: 32, height: 49 }, { x: 32, y: 0, width: 33, height: 49 }] } }, cap.dir, { fromFrame: 0, toFrame: 0, monitor: 1 });
  assert(monitorPlan.crop.mode === 'monitor' && monitorPlan.crop.monitor === 1 && monitorPlan.crop.x === 32 && monitorPlan.crop.width === 32 && monitorPlan.crop.height === 48, 'a recorded monitor crops to that monitor');

  const fast = { ...cap.record, fps: 'x', frames: [{ index: 0, tMs: 0, image: 'frame-00001.png' }, { index: 1, tMs: 'bad', image: 'frame-00002.png' }, { index: 2, tMs: 50, image: 'frame-00003.png' }, { index: 3, tMs: 40, image: 'frame-00004.png' }] };
  const fastPlan = clip.planClip(fast, cap.dir, { fromFrame: 0, toFrame: 3 });
  assert(fastPlan.captureFps === 12 && fastPlan.outputFps === 12 && fastPlan.durationsMs[0] === 1000 / 12 && fastPlan.durationsMs[2] === 0, 'a missing fps defaults to 12; unusable gaps fall back to one frame, negative gaps to 0');
  const slow = clip.planClip({ ...cap.record, fps: 0.5 }, cap.dir, { fromFrame: 4, toFrame: 4 });
  assert(slow.outputFps === 1 && slow.realDurationMs === 2000, 'a sub-1 fps capture encodes at 1 fps and holds the last frame for its interval');

  const list = clip.concatList({ images: ["it's.png", 'b.png'], durationsMs: [1000, 83.3333333] });
  assert(list === "ffconcat version 1.0\nfile '../it'\\''s.png'\nduration 1.000000\nfile '../b.png'\nduration 0.083333\nfile '../b.png'\n", `concatList quotes names, keeps real durations and repeats the last file: ${list}`);
  const args = clip.clipFfmpegArgs(latest, 'list.ffconcat', 'out.mp4');
  assert(args.join(' ') === '-nostdin -hide_banner -loglevel error -y -f concat -safe 0 -i list.ffconcat -vf crop=64:48:0:0,fps=1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart -t 3.000 out.mp4', `ffmpeg argv is H.264 yuv420p capped at the real duration: ${args.join(' ')}`);

  // export with an injected ffmpeg runner
  const ran = [];
  let listText = '';
  const fakeFfmpeg = async (command, argv) => {
    ran.push([command, ...argv]);
    if (argv.includes('-version')) return { stdout: 'ffmpeg version 8', stderr: '' };
    listText = readFileSync(argv[argv.indexOf('-i') + 1], 'utf8');
    writeFileSync(argv.at(-1), Buffer.from('fake-mp4-bytes'));
    return { stdout: '', stderr: '' };
  };
  const receipt = await clip.exportCaptureClip(cap.dir, {}, { ffmpeg: '/opt/ffmpeg', run: fakeFfmpeg, now: () => new Date('2026-11-25T09:00:00Z') });
  assert(receipt.schema === 'labview-benchmark-actor/capture-clip@v1' && receipt.captureId === cap.uuid && receipt.clip.file === 'clips/clip-1-3.mp4', 'the clip is written inside the capture directory');
  assert(receipt.clip.sha256 === createHash('sha256').update('fake-mp4-bytes').digest('hex') && receipt.clip.sizeBytes === 14, 'the receipt carries the clip SHA-256 and byte size');
  assert(receipt.frameRange.from === 1 && receipt.frameRange.to === 3 && receipt.frameRange.count === 3 && receipt.timing.mode === 'real-interval' && receipt.clip.durationMs === 3000 && receipt.createdAt === '2026-11-25T09:00:00.000Z', 'the receipt carries the inclusive frame range, real-time timing and duration');
  assert(receipt.markers.length === 2 && receipt.markers.every((m) => 'toleranceMs' in m.imageGrab && 'deltaMs' in m.imageGrab && 'admitted' in m.imageGrab) && typeof receipt.markers[0].instantMs === 'number', 'the receipt carries both marker instants, toleranceMs, deltaMs and admitted');
  assert(!JSON.stringify(receipt).includes('data:') && !('pixels' in receipt), 'the receipt holds metadata only, never pixels');
  assert(ran[0].join(' ') === '/opt/ffmpeg -hide_banner -version' && ran[1].includes('libx264'), 'ffmpeg is probed, then run with an argument array');
  assert(listText.split('\n').filter((l) => l.startsWith('file ')).length === 4 && listText.includes("file '../frame-00002.png'"), 'the concat list references the capture frames in place');
  assert(!existsSync(join(cap.dir, 'clips', 'clip-1-3.ffconcat')), 'the concat list is removed after encoding');
  assert(JSON.stringify(JSON.parse(readFileSync(join(cap.dir, 'clips', 'clip-1-3.json'), 'utf8'))) === JSON.stringify(receipt), 'the receipt JSON is written next to the clip');
  const defaultNow = await clip.exportCaptureClip(cap.dir, { fromFrame: 0, toFrame: 0 }, { ffmpeg: 'ffmpeg', run: fakeFfmpeg });
  assert(Number.isFinite(Date.parse(defaultNow.createdAt)) && defaultNow.clip.file === 'clips/clip-0-0.mp4', 'createdAt defaults to now');

  const enoent = async () => { throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }); };
  await rejects(() => clip.exportCaptureClip(cap.dir, {}, { ffmpeg: null }), /labviewBenchmarkActor\.ffmpegPath/, 'no ffmpeg names the setting');
  const missing = await rejects(() => clip.exportCaptureClip(cap.dir, {}, { ffmpeg: 'ffmpeg', run: enoent }), /ffmpeg was not found.*labviewBenchmarkActor\.ffmpegPath/, 'a missing ffmpeg names the setting');
  assert(missing instanceof clip.ClipError, 'a missing ffmpeg is a ClipError');
  await rejects(() => clip.exportCaptureClip(cap.dir, {}, { ffmpeg: 'ffmpeg', run: async () => { throw new Error('EACCES'); } }), /not runnable: EACCES/, 'an unrunnable ffmpeg is reported');
  const encodeFail = (stderr) => async (command, argv) => {
    if (argv.includes('-version')) return { stdout: '', stderr: '' };
    throw Object.assign(new Error('exit 1'), stderr === undefined ? {} : { stderr });
  };
  await rejects(() => clip.exportCaptureClip(cap.dir, {}, { ffmpeg: 'ffmpeg', run: encodeFail('frame=1\nUnknown encoder libx264\n') }), /failed to encode the clip: Unknown encoder libx264$/, 'an encode failure reports ffmpeg stderr last line');
  await rejects(() => clip.exportCaptureClip(cap.dir, {}, { ffmpeg: 'ffmpeg', run: encodeFail(undefined) }), /failed to encode the clip: exit 1$/, 'an encode failure without stderr reports the error');
  assert(!existsSync(join(cap.dir, 'clips', 'clip-1-3.ffconcat')), 'the concat list is removed after a failed encode');
  await rejects(() => clip.exportCaptureClip(join(work, 'nope'), {}, { ffmpeg: 'ffmpeg' }), /holds no capture\.json/, 'a directory without capture.json is rejected');

  // real execFile runner (node stands in for ffmpeg)
  const okRun = await clip.execFileRunner(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert(okRun.stdout === 'ok', 'execFileRunner runs an argument array');
  const failed = await rejects(() => clip.execFileRunner(process.execPath, ['-e', 'process.stderr.write("bad frame");process.exit(3)']), /Command failed/, 'execFileRunner rejects a failing command');
  assert(failed.stderr === 'bad frame', 'execFileRunner keeps the stderr of a failure');
  assert(clip.clipFfmpegCommand(' /x/ffmpeg ', {}) === '/x/ffmpeg' && clip.clipFfmpegCommand('  ', { LBA_FFMPEG_PATH: '/env/ffmpeg' }) === '/env/ffmpeg' && clip.clipFfmpegCommand(undefined, {}) === 'ffmpeg', 'ffmpeg resolution: explicit, LBA_FFMPEG_PATH, then PATH');
  assert(typeof clip.clipFfmpegCommand() === 'string', 'clipFfmpegCommand reads process.env by default');

  // CLI
  const parsed = clip.parseClipArgs(['--dir', cap.dir, '--ffmpeg', 'ff', '--from-marker', '0', '--to-marker', 'late', '--crop', '0, 0, 8, 8']);
  assert(parsed.dir === cap.dir && parsed.ffmpeg === 'ff' && parsed.options.fromMarker === 0 && parsed.options.toMarker === 'late' && parsed.options.crop.w === 8, 'parseClipArgs reads markers, crop, dir and ffmpeg');
  const framesParsed = clip.parseClipArgs(['--from-frame', '1', '--to-frame', '2', '--monitor', '0']);
  assert(framesParsed.options.fromFrame === 1 && framesParsed.options.toFrame === 2 && framesParsed.options.monitor === 0, 'parseClipArgs reads frames and monitor');
  for (const [argv, pattern] of [[['--dir'], /--dir needs a value/], [['--ffmpeg'], /--ffmpeg needs/], [['--from-marker'], /marker index or id/], [['--to-frame', '-1'], /non-negative integer/], [['--monitor'], /non-negative integer/], [['--crop', '1,2,3'], /x,y,w,h/], [['--crop'], /x,y,w,h/], [['--bogus'], /unknown option/]]) {
    await rejects(() => clip.parseClipArgs(argv), pattern, `parseClipArgs rejects ${argv.join(' ')}`);
  }
  const io = () => { const o = { out: [], err: [] }; return { o, io: { out: (t) => o.out.push(t), err: (t) => o.err.push(t) } }; };
  let r = io();
  assert(await clip.runClipCli(['--help'], r.io) === 0 && /usage: node out\/captureClip\.js/.test(r.o.out[0]), 'the CLI prints usage');
  r = io();
  assert(await clip.runClipCli(['-h'], r.io) === 0, 'the CLI accepts -h');
  r = io();
  assert(await clip.runClipCli([], r.io) === 2 && /--dir <captureDir> is required/.test(r.o.err[0]), 'the CLI requires --dir');
  r = io();
  assert(await clip.runClipCli(['--dir', cap.dir, '--from-frame', '0', '--to-frame', '1'], r.io, { run: fakeFfmpeg }) === 0 && JSON.parse(r.o.out[0]).clip.file === 'clips/clip-0-1.mp4', 'the CLI prints the receipt JSON');
  const brokenDir = join(clipRoot, 'broken');
  mkdirSync(brokenDir);
  writeFileSync(join(brokenDir, 'capture.json'), '{');
  r = io();
  assert(await clip.runClipCli(['--dir', brokenDir], r.io) === 1 && /^export-clip: /.test(r.o.err[0]), 'an unexpected failure exits 1');
  const child = spawn(process.execPath, [join(root, 'out', 'captureClip.js'), '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert(code === 0 && /usage:/.test(childOut), 'node out/captureClip.js --help runs as a CLI');
  const badChild = spawn(process.execPath, [join(root, 'out', 'captureClip.js'), '--dir', join(work, 'nope')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const badCode = await new Promise((resolve) => badChild.on('close', resolve));
  assert(badCode === 2, 'the CLI exits 2 for a rejected clip');
}

// ---- 10. MCP tools (opt-in, metadata only) --------------------------------------------------------------------
{
  const fake = (text) => async () => ({ content: [{ type: 'text', text }] });
  const seen = [];
  const deps = {
    serverVersion: '1',
    getHostCapabilities: fake('caps'),
    getBenchmarkSeries: async (args) => { seen.push(args); return { content: [{ type: 'text', text: 'series' }] }; },
    pollCoordinationBus: fake('poll'),
    postCoordinationNote: fake('note'),
    exportCaptureClip: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }),
    addCaptureMarker: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] })
  };
  const call = (name, args, d = deps) => core.handleBenchmarkActorMcpMessage({ id: 1, method: 'tools/call', params: { name, arguments: args } }, d);
  const list = await core.handleBenchmarkActorMcpMessage({ id: 1, method: 'tools/list' }, deps);
  const tools = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
  assert(tools.export_capture_clip && tools.add_capture_marker, 'tools/list publishes export_capture_clip and add_capture_marker');
  assert(!core.OLLAMA_DEFAULT_TOOLS.has('export_capture_clip') && !core.OLLAMA_DEFAULT_TOOLS.has('add_capture_marker'), 'the new capture tools are opt-in (not in OLLAMA_DEFAULT_TOOLS)');
  assert(tools.add_capture_marker.inputSchema.properties.label.maxLength === 80 && tools.get_benchmark_series.inputSchema.properties.runId, 'schemas carry the label limit and the series runId');

  await call('get_benchmark_series', undefined);
  await call('get_benchmark_series', { runId: 'latest' });
  assert(seen[0] === undefined && seen[1].runId === 'latest', 'get_benchmark_series passes a runId only when given');
  const clipCall = await call('export_capture_clip', { runId: '00000000-0000-4000-8000-000000000001', fromMarker: 0, toMarker: 1, crop: { x: 0, y: 0, w: 2, h: 2 } });
  assert(JSON.parse(clipCall.result.content[0].text).crop.w === 2, 'export_capture_clip forwards validated arguments');
  const frameCall = await call('export_capture_clip', { fromFrame: 0, toFrame: 3, monitor: 1 });
  assert(JSON.parse(frameCall.result.content[0].text).monitor === 1, 'export_capture_clip forwards frames and monitor');
  const markerCall = await call('add_capture_marker', { runId: 'latest', instantMs: 12.5, label: ' model ready ' });
  assert(JSON.stringify(JSON.parse(markerCall.result.content[0].text)) === JSON.stringify({ label: 'model ready', runId: 'latest', instantMs: 12.5 }), 'add_capture_marker forwards a trimmed label and the instant');
  const frameMarker = await call('add_capture_marker', { frameIndex: 2, label: 'x' });
  assert(JSON.parse(frameMarker.result.content[0].text).frameIndex === 2, 'add_capture_marker forwards a frame index');
  for (const [name, args, pattern] of [
    ['get_benchmark_series', { runId: '../etc' }, /runId/],
    ['get_benchmark_series', [], /arguments must be an object/],
    ['export_capture_clip', 'x', /arguments must be an object/],
    ['export_capture_clip', { path: '/etc' }, /unknown argument "path"/],
    ['export_capture_clip', { fromFrame: -1 }, /fromFrame/],
    ['export_capture_clip', { toMarker: 1.5 }, /toMarker/],
    ['export_capture_clip', { crop: { x: 0, y: 0, w: 0, h: 2 } }, /"w" must be an integer >= 1/],
    ['export_capture_clip', { crop: { x: 0, y: 0, w: 2 } }, /crop" needs integer/],
    ['export_capture_clip', { crop: { x: 0, y: 0, w: 2, h: 2, z: 1 } }, /unknown argument "z"/],
    ['add_capture_marker', { instantMs: 1 }, /label/],
    ['add_capture_marker', { instantMs: 1, label: '  ' }, /label/],
    ['add_capture_marker', { instantMs: 1, label: 'x'.repeat(81) }, /label/],
    ['add_capture_marker', { instantMs: '1', label: 'x' }, /instantMs/],
    ['add_capture_marker', { label: 'x' }, /exactly one/],
    ['add_capture_marker', { instantMs: 1, frameIndex: 1, label: 'x' }, /exactly one/],
    ['add_capture_marker', { kind: 'user-click', instantMs: 1, label: 'x' }, /unknown argument "kind"/]
  ]) {
    const res = await call(name, args);
    assert(res.error && res.error.code === -32602 && pattern.test(res.error.message), `${name} ${JSON.stringify(args)} -> -32602 ${res.error && res.error.message}`);
  }
  const bare = { ...deps, exportCaptureClip: undefined, addCaptureMarker: undefined };
  const unavailable = await call('export_capture_clip', {}, bare);
  const unavailableMarker = await call('add_capture_marker', { instantMs: 0, label: 'x' }, bare);
  assert(unavailable.result.isError && /capture tools are not available/.test(unavailable.result.content[0].text) && unavailableMarker.result.isError, 'servers without capture deps answer with a tool error');
}

// ---- 11. MCP runner deps over a capture root -----------------------------------------------------------------
{
  const capRoot = join(work, 'mcp-captures');
  mkdirSync(capRoot);
  const old = makeCapture(capRoot, { startMs: 1, frames: [{ index: 0, tMs: 0, image: 'frame-00001.png' }] });
  const series = runner.captureGpuSeries(capRoot, old.uuid);
  assert(series.runId === old.uuid && series.gpu.available === false && /predates GPU sampling/.test(series.gpu.reason), 'a capture without GPU samples reports why (no zeros)');
  const samples = Array.from({ length: 2500 }, (_, i) => ({ tMs: i, ms: 1000 + i, gpus: [] }));
  const withGpu = makeCapture(capRoot, { startMs: 1000, frames: [], gpu: { available: true, gpus: [{ index: 0, name: 'g' }], samples } });
  const strided = runner.captureGpuSeries(capRoot, withGpu.uuid);
  assert(strided.gpu.sampleStride === 3 && strided.gpu.samples.length === 834 && strided.gpu.samples[1].tMs === 3 && strided.startMs === 1000, 'get_benchmark_series strides a long GPU series to at most 1000 samples');
  const odd = makeCapture(capRoot, { frames: [], gpu: { available: false, reason: 'nvidia-smi not found on PATH' } });
  assert(runner.captureGpuSeries(capRoot, odd.uuid).gpu.samples.length === 0, 'a gpu block without samples projects to none');

  const env = await runner.getBenchmarkSeries(undefined, { runId: withGpu.uuid }, capRoot);
  const envelope = JSON.parse(env.content[0].text);
  assert(!env.isError && envelope.points > 0 && envelope.capture.gpu.available === true, 'get_benchmark_series returns the capture GPU series next to the bundled series');
  const plain = JSON.parse((await runner.getBenchmarkSeries()).content[0].text);
  assert(!('capture' in plain), 'get_benchmark_series without runId is unchanged');
  const missing = await runner.getBenchmarkSeries(undefined, { runId: randomUUID() }, capRoot);
  assert(missing.isError && /unavailable: capture .* not found/.test(missing.content[0].text), 'an unknown capture is a tool error');
  const savedRoot = process.env.LBA_CAPTURE_ROOT;
  delete process.env.LBA_CAPTURE_ROOT;
  const noRoot = await runner.getBenchmarkSeries(undefined, { runId: 'latest' });
  assert(noRoot.isError && /no capture root/.test(noRoot.content[0].text), 'without LBA_CAPTURE_ROOT the capture series is unavailable');
  process.env.LBA_CAPTURE_ROOT = capRoot;
  const viaEnv = await runner.getBenchmarkSeries(undefined, { runId: withGpu.uuid });
  assert(!viaEnv.isError, 'get_benchmark_series reads LBA_CAPTURE_ROOT by default');
  if (savedRoot === undefined) delete process.env.LBA_CAPTURE_ROOT; else process.env.LBA_CAPTURE_ROOT = savedRoot;

  const clipRoot = join(work, 'mcp-clips');
  mkdirSync(clipRoot);
  const cap = clipCapture(clipRoot, { markers: [click(0), click(2)] });
  const fakeFfmpeg = async (command, argv) => {
    if (!argv.includes('-version')) writeFileSync(argv.at(-1), 'mp4');
    return { stdout: '', stderr: '' };
  };
  const tools = runner.createCaptureToolDeps(clipRoot, root, { run: fakeFfmpeg, ffmpeg: 'ffmpeg' });
  const clipResult = await tools.exportCaptureClip({ runId: cap.uuid });
  const clipReceipt = JSON.parse(clipResult.content[0].text);
  assert(!clipResult.isError && clipReceipt.clip.file === 'clips/clip-0-2.mp4' && clipReceipt.frameRange.count === 3 && existsSync(join(cap.dir, 'clips', 'clip-0-2.mp4')), 'export_capture_clip writes the clip inside the capture and returns the receipt');
  const badClip = await tools.exportCaptureClip({ fromFrame: 2, toFrame: 0 });
  assert(badClip.isError && /before the start/.test(badClip.content[0].text), 'a rejected clip is a tool error');
  const envFfmpeg = runner.createCaptureToolDeps(clipRoot, root, { run: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  const noFfmpeg = await envFfmpeg.exportCaptureClip({ fromFrame: 0, toFrame: 0 });
  assert(noFfmpeg.isError && /labviewBenchmarkActor\.ffmpegPath/.test(noFfmpeg.content[0].text), 'a missing ffmpeg names the setting through MCP');
  const added = await runner.createCaptureToolDeps(clipRoot).addCaptureMarker({ runId: cap.uuid, frameIndex: 1, label: 'agent saw the dialog' });
  const addedBody = JSON.parse(added.content[0].text);
  assert(!added.isError && addedBody.markerIndex === 2 && addedBody.marker.kind === 'agent-cue' && addedBody.marker.imageGrab.admitted === true && addedBody.marker.imageGrab.nearestFrameIndex === 1, 'add_capture_marker appends an agent cue with the shared grab');
  assert(JSON.parse(readFileSync(join(cap.dir, 'capture.json'), 'utf8')).markers.length === 3, 'the cue is persisted in capture.json');
  const again = JSON.parse((await runner.createCaptureToolDeps(clipRoot).addCaptureMarker({ runId: cap.uuid, frameIndex: 1, label: 'agent saw the dialog' })).content[0].text);
  assert(again.markerIndex === 2 && again.marker.id === addedBody.marker.id && JSON.parse(readFileSync(join(cap.dir, 'capture.json'), 'utf8')).markers.length === 3, 'an identical cue is not stored twice; the stored one is reported (#138)');
  const addFail = await tools.addCaptureMarker({ runId: randomUUID(), instantMs: 0, label: 'x' });
  assert(addFail.isError && /not found/.test(addFail.content[0].text), 'a cue for an unknown capture is a tool error');
}

// ---- 12. correlator: GPU curves and labelled agent cues ------------------------------------------------------
{
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const frames = [0, 1, 2].map((i) => ({ index: i, tMs: i * 83, cpuPct: 10, ramMb: 100, diskPct: 1, imageSrc: px, gpus: [{ index: 0, utilizationPct: i === 1 ? null : i * 20, memoryUsedMb: 400 + i, powerW: 5 }] }));
  frames[2].gpus.push({ index: 1, utilizationPct: 3, memoryUsedMb: 10, powerW: 2 });
  const markers = [{ id: 'cue-166-1', kind: 'agent-cue', label: 'GPU rose above 10% (compute)', instantMs: 166, frameIndex: 2, imageGrab: { toleranceMs: 200, nearestFrameIndex: 2, deltaMs: 0, admitted: true } }];
  const html = buildFrameCorrelatorHtml({ title: 'gpu', fps: 12, selectedIndex: 2, frames, markers }, 'gpu-nonce-000000000000000000000000', 'vscode-webview://render');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const doc = dom.window.document;
  const polylines = doc.getElementById('fc-graph').querySelectorAll('polyline').length;
  // GPU 1 has one reading (frame 3 only), so its curves have a single point and draw no polyline: 3 base + 3 GPU 0.
  assert(polylines === 6, `the correlator plots CPU/RAM/disk plus util/mem/power per GPU (got ${polylines})`);
  const gpu0Util = [...doc.getElementById('fc-graph').querySelectorAll('polyline')][3].getAttribute('points').split(' ');
  assert(gpu0Util.length === 2, 'an [N/A] utilization reading is a gap in the GPU curve, never zero');
  const legend = doc.getElementById('fc-legend').textContent;
  assert(/GPU 0 util %/.test(legend) && /GPU 0 mem MiB/.test(legend) && /GPU 1 power W/.test(legend), 'the legend names each GPU curve');
  assert(/agent-cue: GPU rose above 10% \(compute\)/.test(doc.getElementById('fc-markreadout').textContent), 'the marker readout shows the agent-cue label');
  const plainHtml = buildFrameCorrelatorHtml({ title: 'old', fps: 12, selectedIndex: 0, frames: frames.map(({ gpus, ...f }) => f) }, 'gpu-nonce-000000000000000000000000', 'vscode-webview://render');
  const plainDoc = new JSDOM(plainHtml, { runScripts: 'dangerously', pretendToBeVisual: true }).window.document;
  assert(plainDoc.getElementById('fc-graph').querySelectorAll('polyline').length === 3 && !/GPU/.test(plainDoc.getElementById('fc-legend').textContent), 'a capture without GPU samples charts exactly as before');
}

// ---- 13. correlator: one marker per click, and a double-click is not a twin pair (#138) ---------------------------
{
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const frames = Array.from({ length: 55 }, (_, i) => ({ index: i, tMs: i * 1000 + 0.68, cpuPct: 10, ramMb: 100, diskPct: 1, imageSrc: px }));
  const html = buildFrameCorrelatorHtml({ title: 'dup', fps: 1, selectedIndex: 0, frames }, 'dup-nonce-000000000000000000000000', 'vscode-webview://render');
  const posted = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
      window.SVGElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 300, right: 1000, bottom: 300, x: 0, y: 0 });
    }
  });
  const { window } = dom;
  const svg = window.document.getElementById('fc-graph');
  const pointer = (type, clientX) => svg.dispatchEvent(new window.MouseEvent(type, { clientX, clientY: 100, bubbles: true, cancelable: true }));
  const count = () => window.document.getElementById('fc-root').getAttribute('data-marker-count');
  // the real Chromium double-click sequence (see frameCorrelatorMarkers.playwright.cjs): two presses, one pixel
  for (const type of ['pointerdown', 'pointerup', 'click', 'pointerdown', 'pointerup', 'click', 'dblclick']) pointer(type, 185);
  assert(count() === '1' && posted.length === 1 && posted[0].type === 'frame-marker', `a double-click drops and posts exactly one marker (got ${count()}, ${posted.length} posted)`);
  const first = posted[0].marker;
  assert(first.id === `m-${Math.round(first.instantMs)}-1` && first.kind === 'user-click' && first.frameIndex === 10 && JSON.stringify(Object.keys(first)) === '["id","instantMs","frameIndex","kind","imageGrab"]', 'the click marker keeps its id and fields');
  assert(JSON.stringify(Object.keys(first.imageGrab)) === '["nearestFrameIndex","deltaMs","admitted","imageSrc"]', 'the click marker keeps its imageGrab shape');
  for (const type of ['pointerdown', 'pointerup', 'pointerup', 'lostpointercapture']) pointer(type, 540);
  assert(count() === '2' && posted.length === 2 && posted[1].marker.id === `m-${Math.round(posted[1].marker.instantMs)}-2`, 'a repeated pointerup drops at most one marker per pointerdown; ids stay consecutive');
  window.close();
}

rmSync(work, { recursive: true, force: true });
console.log(`correlated-capture: ${checks} checks passed`);
