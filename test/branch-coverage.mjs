#!/usr/bin/env node

import assert from 'node:assert/strict';
import { coberturaWorkingTreeText, normalizeCoberturaXml } from '../scripts/coverage-core.mjs';
import { reviewerStationForEnvironment } from '../out/reviewerStation.js';
import {
  captureMetadataForPlatform,
  ffmpegCaptureArgsForPlatform,
  labviewCandidatesForPlatform,
  linuxSamplerScript,
} from '../out/capturePlatform.js';
import {
  buildBenchmarkPanelHtml,
  buildCrossPlaneResourcePanelHtml,
  buildCrossPlaneTrendPanelHtml,
  buildResourcePanelHtml,
  buildTrendPanelHtml,
  dhashGridCells,
  dhashGridDataUri,
  dhashGridSvg,
  escapeHtml,
  scrubberModelFromRecord,
  scrubberModelFromTrend,
} from '../media/benchmark-panels.mjs';
import {
  buildReviewerVerdict,
  buildVerdictBusPost,
  canonicalize,
  enrolledReviewerPublicKeys,
  gateVisualReview,
  generateEnrolledKeypair,
  signReviewerVerdict,
  validateReviewerVerdict,
  verifyReviewerVerdict,
} from '../media/reviewerVerdict.mjs';
import { buildLaunchCapture, correlateDualStream } from '../media/launch-capture.mjs';
import {
  buildCaptureStatus,
  buildCapturingStatus,
  buildFailedStatus,
  validateCaptureStatus,
} from '../media/captureStatus.mjs';
import {
  buildAgentRequest,
  buildOpDone,
  selectPendingRequest,
  validateAgentRequest,
  validateOpDone,
} from '../media/handoffRequest.mjs';
import { buildFrameCorrelatorHtml } from '../media/frame-correlator.mjs';
import { buildMeshBoardHtml } from '../media/meshBoardView.mjs';
import { buildMeshCalibrationHtml } from '../media/meshCalibrationView.mjs';
import { counterBitmap, counterSvg } from '../media/counter-render.mjs';

function throws(fn, pattern) {
  assert.throws(fn, pattern);
}

// benchmark-panels: exercise empty, degenerate, custom-option, failure, and fallback branches.
assert.equal(escapeHtml(null), '');
assert.match(escapeHtml(`&<>"'`), /&amp;&lt;&gt;&quot;&#39;/);
throws(() => dhashGridCells('bad'), /16 hex/);
assert.equal(dhashGridCells('8000000000000000')[0][0], true);
assert.match(dhashGridSvg('0000000000000000', { cell: 8, gap: 0, on: 'on', off: 'off' }), /width="64"/);
assert.match(dhashGridDataUri('ffffffffffffffff', { cell: 4 }), /^data:image\/svg\+xml;base64,/);

const emptyRun = buildBenchmarkPanelHtml(null, 'n');
assert.match(emptyRun, /no captured frame/);
const fallbackRun = buildBenchmarkPanelHtml({
  workload: '<run>',
  spans: [{ id: 'other', ms: 'bad' }],
  frames: [{ caseId: 'first' }],
  sourceDetail: {
    framesCaptured: 0,
    stableTailFrames: '',
    settleOpts: { window: 2, toleranceHamming: 1 },
  },
}, 'n');
assert.match(fallbackRun, /&lt;run&gt;/);
const completeRun = buildBenchmarkPanelHtml({
  workload: 'launch',
  plane: 'WIN',
  hypervisor: 'vbox',
  substrate: 'vm',
  spans: [{ id: 'launchMs', ms: 12, from: 'a', to: 'b', clock: 'mono', scope: 'host' }],
  frames: [{ settled: true, perceptualFingerprint: '0123456789abcdef', integrityHash: 'f'.repeat(64) }],
}, 'n');
assert.match(completeRun, /12<small>/);

const emptyTrend = buildTrendPanelHtml(null, 'n');
assert.match(emptyTrend, /0 runs/);
const oneTrend = buildTrendPanelHtml({
  values: [5],
  baselineMs: 5,
  verdict: 'REGRESSION',
  regressed: true,
  slopeMsPerRun: 1,
  toleranceMs: 2,
  driftThresholdMsPerRun: 0.5,
  drifting: true,
  stats: { min: 5, max: 5 },
}, 'n');
assert.match(oneTrend, /BREACHED/);
const manyTrend = buildTrendPanelHtml({
  values: [1, 3],
  regressed: false,
  drifting: false,
  toleranceMs: 1,
  stats: { mean: 2, median: 2, min: 1, max: 3, stddev: 1, spread: 2 },
}, 'n');
assert.match(manyTrend, /not breached/);
assert.match(buildTrendPanelHtml({ values: [Number.NaN], baselineMs: Number.NaN }, 'n'), /1 runs/);
assert.match(buildTrendPanelHtml({ values: [1] }, 'n'), /benchmark/);

assert.match(buildCrossPlaneTrendPanelHtml(null, null, null, 'n'), /cross-plane metric/);
const crossTrend = buildCrossPlaneTrendPanelHtml({
  workload: 'launch',
  metric: 'launchMs',
  verdict: 'FAIL',
  flags: ['risk'],
  witness: { meanDeltaMs: 1, medianDeltaMs: null, slopeDeltaMsPerRun: null, status: 'witness', toleranceMs: 3, faster: 'LINUX' },
  win: { hypervisor: 'vbox', mean: 2, median: 2, spread: 1, slopeMsPerRun: 0, verdict: 'PASS' },
  linux: null,
}, { values: [2] }, { values: [1, 2] }, 'n');
assert.match(crossTrend, /risk/);
assert.match(buildCrossPlaneTrendPanelHtml({
  verdict: 'PASS',
  witness: {},
  linux: {},
  win: {},
}, { values: [1] }, { values: [1] }, 'n'), /PASS/);

assert.match(buildResourcePanelHtml(null, 'n'), /resource correlation/);
const resources = buildResourcePanelHtml({
  workload: 'launch',
  launchMs: 10,
  triggerEpochMs: 2,
  samples: [
    { epochMs: 1, cpuPct: 1, ramMb: 10, diskPct: 0 },
    { epochMs: 1, cpuPct: 2, ramMb: 11, diskPct: 3 },
    { epochMs: 'bad', cpuPct: 9 },
  ],
  windows: {
    cpu: { pre: { mean: 1 }, post: { mean: 2 }, deltaMean: 1 },
    ram: { pre: {}, post: {}, deltaMean: -1 },
    disk: { pre: { mean: Number.NaN }, post: { mean: Number.NaN } },
  },
}, 'n');
assert.match(resources, /\+1/);

assert.match(buildCrossPlaneResourcePanelHtml(null, 'n'), /cross-plane resource agreement/);
const crossResources = buildCrossPlaneResourcePanelHtml({
  verdict: 'FAIL',
  metrics: {
    cpu: {
      status: 'diverge',
      win: { deltaMean: -2 },
      linux: { deltaMean: 3 },
      agreementDelta: 5,
      toleranceDelta: 1,
      witness: true,
    },
    ram: {
      status: 'agree',
      win: { deltaMean: 0 },
      linux: { deltaMean: 0 },
      agreementDelta: 0,
      toleranceDelta: 1,
    },
    disk: {
      status: '',
      win: { deltaMean: 'bad' },
      linux: { deltaMean: Number.NaN },
      agreementDelta: 0,
      toleranceDelta: 1,
    },
  },
}, 'n');
assert.match(crossResources, /RAM agreement/);

throws(() => scrubberModelFromTrend(null), /no values/);
const trendModel = scrubberModelFromTrend({ values: [1], workload: '', metric: '' }, {
  pinDhash: 'bad',
  title: 'custom',
});
assert.equal(trendModel.title, 'custom');
assert.match(scrubberModelFromTrend({ values: [1] }).title, /benchmark/);
throws(() => scrubberModelFromRecord(null), /no fingerprinted/);
const recordModel = scrubberModelFromRecord({
  workload: '',
  frames: [
    null,
    { perceptualFingerprint: '0000000000000000', index: 4, settled: false },
    { perceptualFingerprint: 'ffffffffffffffff', caseId: 'ready', settled: true },
  ],
}, { title: 'frames', metric: 'custom' });
assert.equal(recordModel.points[0].caseId, undefined);
assert.equal(recordModel.metricLabel, 'custom');
assert.match(scrubberModelFromRecord({
  frames: [{ perceptualFingerprint: '0'.repeat(16) }],
}).title, /benchmark/);

// Mesh views: cover empty inputs and failed/edge classifications.
assert.match(buildMeshBoardHtml(null), /0 actors/);
const meshBoard = buildMeshBoardHtml({
  schema: '<mesh>',
  invariants: { monotone: Number.NaN, separable: false, repeatable: false },
  concurrency: { allActorsSampledEveryFrame: false, actorsPerFrame: 1 },
  measured: { exactly12fps: false },
  allActorsRecovered: false,
  actors: [
    { actor: '<a>', rung: 'heavy', cpuPoolPctMean: 120 },
    { actor: 'b', rung: 'idle', cpuPoolPctMean: -1 },
  ],
  perActorInverseRead: [
    { actor: '<a>', correct: true, inferredRung: null, confidence: Number.NaN },
  ],
}, { cspSource: 'vscode-resource:' });
assert.match(meshBoard, /&lt;a&gt;/);

assert.match(buildMeshCalibrationHtml(null), /Mesh-Stress Calibration/);
const calibration = buildMeshCalibrationHtml({
  host: { hostname: '<host>', cpus: 2, totalMemGb: 4 },
  frameRateHz: 12,
  ladder: { repeats: 1, commanded: [{ rung: '<idle>', spinners: 0 }] },
  invariants: { monotone: Number.NaN, separable: false, repeatable: false },
  cpuTotalPctMeanCurve: [{ rung: null, expected: 110, tolerance: 0 }],
  salientDimensions: ['<cpu>'],
  separability: [{ from: 'idle', to: 'light', separableDims: 0 }],
  inverseRead: { heldOutRung: null, inferredRung: 'idle', confidence: Number.NaN },
}, { cspSource: 'vscode-resource:' });
assert.match(calibration, /mismatch/);

// Reviewer verdict: invalid enrollment, shape, signature, decision, and bus fallbacks.
assert.equal(canonicalize([1, null]), '[1,null]');
assert.equal(canonicalize({ b: 1, a: undefined }), '{"a":null,"b":1}');
assert.deepEqual(enrolledReviewerPublicKeys(null, { version: '1.0.0', purpose: 'visual' }), []);
assert.deepEqual(enrolledReviewerPublicKeys(' legacy-key '), [' legacy-key ']);
assert.deepEqual(enrolledReviewerPublicKeys([
  [],
  {},
  { publicKeyPem: 'key', validFrom: 'bad', validThrough: '1.0.0', purposes: ['visual'] },
  { publicKeyPem: 'key', validFrom: '2.0.0', validThrough: '1.0.0', purposes: ['visual'] },
  { publicKeyPem: 'key', validFrom: '1.0.0', validThrough: '2.0.0', purposes: ['quorum'] },
  { publicKeyPem: 'key', validFrom: '1.0.0', validThrough: '2.0.0', purposes: ['visual'] },
], { version: '1.5.0', purpose: 'visual' }), ['key']);
assert.deepEqual(enrolledReviewerPublicKeys(
  { publicKeyPem: 'key', validFrom: '1.0.0', validThrough: '1.1.0', purposes: ['visual'] },
  { version: '2.0.0', purpose: 'visual' },
), []);

const defaultVerdict = buildReviewerVerdict({
  target: 'bad',
  verdict: 'unknown',
  station: 'unknown',
  evidence: [null, { ref: null }, { ref: 3 }],
});
assert.equal(defaultVerdict.verdict, 'fail');
assert.equal(validateReviewerVerdict(null).ok, false);
assert.equal(validateReviewerVerdict({ schema: 'bad', verdict: 'bad', target: null, station: 'bad' }).ok, false);
assert.equal(validateReviewerVerdict({
  schema: defaultVerdict.schema,
  verdict: 'pass',
  target: {},
  reviewer: 'r',
  station: 'WINDOWS_VM',
}).ok, false);

const key = generateEnrolledKeypair();
const otherKey = generateEnrolledKeypair();
const passVerdict = buildReviewerVerdict({
  target: { component: 'extension', version: '1.4.3', commit: 'a'.repeat(40), vsixSha256: 'b'.repeat(64) },
  verdict: 'pass',
  reviewer: 'r',
  station: 'LINUX_CODESPACE',
  notes: null,
  renderedAt: 'now',
});
throws(() => signReviewerVerdict(passVerdict, {}), /privateKeyPem/);
throws(() => signReviewerVerdict(passVerdict, { privateKeyPem: key.privateKeyPem }), /reviewer/);
throws(() => signReviewerVerdict(passVerdict, { privateKeyPem: key.privateKeyPem, reviewer: 'r', station: 'bad' }), /station/);
const signOff = signReviewerVerdict(passVerdict, {
  privateKeyPem: key.privateKeyPem,
  reviewer: 'r',
  station: 'LINUX_CODESPACE',
});
const allowlist = {
  r: [{
    publicKeyPem: key.publicKeyPem,
    validFrom: '1.4.3',
    validThrough: '1.4.3',
    purposes: ['visual'],
  }],
};
assert.equal(verifyReviewerVerdict(passVerdict, signOff, { reviewerAllowlist: allowlist }).ok, true);
assert.equal(verifyReviewerVerdict(passVerdict, null).ok, false);
assert.equal(verifyReviewerVerdict(passVerdict, { ...signOff, algorithm: 'rsa', station: 'bad' }, { reviewerAllowlist: allowlist }).ok, false);
assert.equal(verifyReviewerVerdict({ ...passVerdict, notes: 'tampered' }, signOff, { reviewerAllowlist: allowlist }).ok, false);
assert.equal(verifyReviewerVerdict(passVerdict, { ...signOff, reviewer: 'x' }, { reviewerAllowlist: allowlist }).ok, false);
assert.equal(verifyReviewerVerdict(passVerdict, signOff, { reviewerAllowlist: { r: [] } }).ok, false);
assert.equal(verifyReviewerVerdict(passVerdict, { ...signOff, publicKeyPem: otherKey.publicKeyPem }, { reviewerAllowlist: allowlist }).ok, false);
assert.equal(verifyReviewerVerdict(passVerdict, { ...signOff, signature: 'bad' }, { reviewerAllowlist: allowlist }).ok, false);
assert.equal(verifyReviewerVerdict(passVerdict, { ...signOff, publicKeyPem: 'bad' }, { reviewerAllowlist: { r: ['bad'] } }).ok, false);
const nullVerdictSignOff = signReviewerVerdict(null, {
  privateKeyPem: key.privateKeyPem,
  reviewer: 'r',
});
assert.equal(nullVerdictSignOff.subject.consensusVerdict, null);
assert.equal(nullVerdictSignOff.subject.target, null);
assert.equal(verifyReviewerVerdict(
  { ...passVerdict, target: undefined },
  { ...signOff, publicKeyPem: undefined, signature: '' },
  { reviewerAllowlist: { r: [] } },
).ok, false);

const failVerdict = { ...passVerdict, verdict: 'changes' };
const reject = signReviewerVerdict(failVerdict, {
  privateKeyPem: key.privateKeyPem,
  reviewer: 'r',
  station: 'WINDOWS_VM',
});
assert.equal(gateVisualReview({ verdict: failVerdict, signOffs: [reject], reviewerAllowlist: allowlist }).publish, false);
assert.equal(gateVisualReview({ verdict: passVerdict, signOffs: [null, reject], reviewerAllowlist: allowlist, minReviewers: 2 }).publish, false);
assert.equal(gateVisualReview({ verdict: passVerdict, signOffs: [signOff, signOff], reviewerAllowlist: allowlist, minReviewers: 1 }).publish, true);
assert.equal(gateVisualReview({}).publish, false);
assert.equal(validateReviewerVerdict({
  ...passVerdict,
  target: { ...passVerdict.target, commit: 'x', vsixSha256: 'y' },
}).ok, false);
assert.equal(gateVisualReview({
  verdict: { ...passVerdict, target: { ...passVerdict.target, vsixSha256: null } },
  signOffs: [signOff],
  reviewerAllowlist: allowlist,
}).publish, false);
assert.deepEqual(buildVerdictBusPost(null), {
  type: 'BLOCKED',
  task: 'extension-release-0.0.0',
  ref: null,
  priority: 'P1',
  reviewer: null,
  summary: 'Reviewer visual verdict: FAIL for extension 0.0.0',
});
assert.match(buildVerdictBusPost({ verdict: passVerdict, signOff }).summary, /digest/);

// Capture/handoff/render primitives: invalid/default and rich branches.
throws(() => buildLaunchCapture(null), /non-empty/);
throws(() => buildLaunchCapture({ frames: [] }), /non-empty/);
throws(() => correlateDualStream(null), /frames required/);
throws(() => correlateDualStream([{ frameIndex: 0, shortBytes: 0, longBytes: 1 }]), /shortBytes/);
throws(() => correlateDualStream([{ shortBytes: 1, longBytes: 1 }]), /frameIndex/);
const minimalCapture = buildLaunchCapture({ frames: [{ imageFile: 'a.png' }] });
assert.equal(minimalCapture.fps, 12);
assert.equal(minimalCapture.dualPacket.authoritative, false);
const richCapture = buildLaunchCapture({
  frames: [
    { ms: 100, imageFile: 'a.png', imageBytes: 10, dhashHex: '0'.repeat(16) },
    { imageFile: 'b.png', imageBytes: 10 },
  ],
  resourceSamples: [
    null,
    { ms: 200, cpuPct: Number.NaN },
    {
      ms: 100,
      cpuPct: 1,
      ramMb: 2,
      diskPct: 3,
      counters: { x: 1 },
      disks: [null, { name: null }, { name: 'C:', writeMBs: 4, readMBs: Number.NaN }],
    },
  ],
  fps: -1,
  startMs: 100,
  capacityBytes: 58,
  meta: { workload: '', plane: 'WIN', source: '', screenW: 10, screenH: 20 },
});
assert.deepEqual(richCapture.counterKeys, ['x']);
assert.deepEqual(richCapture.diskNames, ['C:']);
assert.equal(richCapture.dualPacket.authoritativeFrames, 1);
assert.equal(buildLaunchCapture({ frames: [{ imageFile: 'x', imageBytes: 1 }], capacityBytes: 1 }).dualPacket.outcome, 'short-protection-blocked');

assert.equal(buildCapturingStatus().runDir, null);
assert.equal(buildFailedStatus({ error: null }).error, 'unknown');
assert.equal(buildFailedStatus({ runDir: 'r', startedAt: 's', stoppedAt: 'e', error: 'x' }).runDir, 'r');
const emptyStopped = buildCaptureStatus(null, null);
assert.equal(emptyStopped.frameCount, 0);
const stopped = buildCaptureStatus(
  { frames: [{ ms: 10 }, { tMs: 2 }], diskNames: ['X'] },
  [null, { disks: null }, { ms: 11, disks: [null, { name: null }, { name: 'C:', writeMBs: 2, readMBs: 3 }] }],
  { writeThresholdMBs: Number.NaN, writeMinSamples: 1 },
);
assert.equal(stopped.wroteToDisk, true);
assert.deepEqual(stopped.diskNames, ['X']);
assert.equal(validateCaptureStatus(null).ok, false);
assert.equal(validateCaptureStatus({ schema: stopped.schema, state: 'stopped' }).ok, false);
assert.equal(validateCaptureStatus({ schema: stopped.schema, state: 'failed', error: 1 }).ok, false);

assert.equal(validateAgentRequest(buildAgentRequest()).ok, false);
assert.equal(validateAgentRequest(null).ok, false);
assert.equal(validateOpDone(buildOpDone()).ok, false);
assert.equal(validateOpDone(null).ok, false);
assert.equal(selectPendingRequest(null, null), null);
assert.equal(selectPendingRequest([
  buildAgentRequest({ id: 'a', title: 'A', createdAt: '2026-01-01T00:00:00Z' }),
  null,
  buildAgentRequest({ id: 'b', title: 'B', createdAt: '2026-01-02T00:00:00Z' }),
], ['a']).id, 'b');
assert.equal(selectPendingRequest([
  buildAgentRequest({ id: 'a', title: 'A', createdAt: 'same' }),
  buildAgentRequest({ id: 'b', title: 'B', createdAt: 'same' }),
], []).id, 'b');
assert.equal(selectPendingRequest([
  buildAgentRequest({ id: 'z', title: 'Z', createdAt: null }),
  buildAgentRequest({ id: 'a', title: 'A', createdAt: null }),
], []).id, 'z');

assert.match(buildFrameCorrelatorHtml(null, 'n', ''), /frame correlator/);
assert.match(buildFrameCorrelatorHtml({
  title: 'x',
  fps: 1,
  selectedIndex: 2,
  frames: [],
  markers: [],
  markerToleranceMs: 0,
  counterKeys: [],
  diskNames: [],
}, 'n', 'vscode-resource:'), /vscode-resource:/);
throws(() => counterBitmap(-1), /non-negative/);
assert.equal(counterBitmap(0).width, 3);
assert.match(counterSvg(1, { minDigits: 1, cellPx: 1, on: 'red', off: 'blue', pad: 0 }), /fill="blue"/);

const cobertura = '<coverage timestamp="123"><sources><source>C:\\repo</source></sources></coverage>';
assert.equal(
  normalizeCoberturaXml(cobertura),
  '<coverage timestamp="0"><sources>\n    <source>.</source>\n  </sources></coverage>',
);
assert.equal(
  normalizeCoberturaXml('<coverage timestamp="456"><sources>\n<source>/home/repo</source>\n</sources></coverage>'),
  '<coverage timestamp="0"><sources>\n    <source>.</source>\n  </sources></coverage>',
);
assert.equal(
  coberturaWorkingTreeText(cobertura, 'win32'),
  '<coverage timestamp="0"><sources>\r\n    <source>.</source>\r\n  </sources></coverage>',
);
assert.equal(coberturaWorkingTreeText(cobertura, 'linux'), normalizeCoberturaXml(cobertura));
assert.equal(reviewerStationForEnvironment('win32', {}), 'WINDOWS_VM');
assert.equal(reviewerStationForEnvironment('linux', {}), 'UBUNTU_VM');
assert.equal(reviewerStationForEnvironment('linux', { CODESPACES: 'true' }), 'LINUX_CODESPACE');
assert.equal(reviewerStationForEnvironment('darwin', {}), 'WINDOWS_VM');
assert.deepEqual(labviewCandidatesForPlatform('linux'), [
  '/usr/local/natinst/LabVIEW-2026-64/labview',
  '/usr/local/natinst/LabVIEW-2026-64/labview64',
]);
assert.equal(labviewCandidatesForPlatform('darwin').length, 0);
assert.deepEqual(captureMetadataForPlatform('linux'), {
  workload: 'labview-launch',
  plane: 'LINUX',
  source: 'ffmpeg-x11grab',
});
assert.deepEqual(captureMetadataForPlatform('win32'), {
  workload: 'labview-launch',
  plane: 'WIN',
  source: 'ffmpeg-gdigrab',
});
assert.deepEqual(
  ffmpegCaptureArgsForPlatform('linux', '/tmp/frame.png', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }),
  ['-y', '-f', 'x11grab', '-framerate', '12', '-draw_mouse', '0', '-i', ':0', '/tmp/frame.png'],
);
assert.deepEqual(
  ffmpegCaptureArgsForPlatform('win32', 'frame.png', {}),
  ['-y', '-f', 'gdigrab', '-framerate', '12', '-i', 'desktop', 'frame.png'],
);
throws(() => ffmpegCaptureArgsForPlatform('linux', 'frame.png', { XDG_SESSION_TYPE: 'x11' }), /requires DISPLAY/);
throws(() => ffmpegCaptureArgsForPlatform('linux', 'frame.png', { DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' }), /requires an Xorg session/);
throws(() => ffmpegCaptureArgsForPlatform('darwin', 'frame.png', {}), /unsupported/);
const linuxSampler = linuxSamplerScript("/tmp/res'ources.jsonl");
assert.match(linuxSampler, /\/proc\/stat/);
assert.match(linuxSampler, /MemAvailable/);
assert.match(linuxSampler, /res'\\''ources\.jsonl/);

console.log('branch-coverage: PASS');
