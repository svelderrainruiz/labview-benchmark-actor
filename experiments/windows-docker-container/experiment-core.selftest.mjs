import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  analyzePixels,
  buildDockerExecArgs,
  buildExperimentRecords,
  changedPixelRatio,
  classifyRfbStartFailure,
  classifyDisplayProof,
  desktopTargetContract,
  matchDesktopProbe,
  parseDockerStats,
  proveLabviewVisibility,
  selectContainerNetworkTarget,
  selectRepresentativeFrames,
  validateLoopbackListenerBindings,
  validateMonotonicFrames,
  validateChildDesktopMatch,
  withTimeout,
} from './experiment-core.mjs';

const rgba = (width, height, pixel) => {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) out.set(pixel(i), i * 4);
  return out;
};
const W = 20;
const H = 10;
const black = rgba(W, H, () => [0, 0, 0, 255]);
const gray = rgba(W, H, () => [80, 80, 80, 255]);
const varied = rgba(W, H, (i) => (i % 2 ? [230, 230, 230, 255] : [30, 30, 30, 255]));

assert.equal(analyzePixels(black, W, H).passed, false);
assert.equal(analyzePixels(gray, W, H).reason, 'single-color-or-single-luminance-population');
assert.equal(analyzePixels(varied, W, H).passed, true);
assert.equal(changedPixelRatio(gray, varied, W, H).ratio, 1);
assert.deepEqual(desktopTargetContract('Inherited'), {
  mode: 'Inherited',
  changesProcessWindowStation: false,
  explicitStartupDesktop: null,
});
assert.deepEqual(desktopTargetContract('WinSta0'), {
  mode: 'WinSta0',
  changesProcessWindowStation: true,
  explicitStartupDesktop: 'WinSta0\\Default',
});
assert.throws(() => desktopTargetContract('dynamic-service-name'), /unsupported desktop target/);
const displaySource = readFileSync(path.join(import.meta.dirname, 'display-surface.cs'), 'utf8');
assert.ok(!/Service-0x/i.test(displaySource), 'dynamic service-window-station names must never be hardcoded');
assert.match(displaySource, /startup\.lpDesktop = context\.explicitStartupDesktop/);
const inheritedBranch = /} else \{([\s\S]*?)\n    }/.exec(displaySource)?.[1] ?? '';
assert.ok(!inheritedBranch.includes('SetProcessWindowStation'), 'Inherited mode must not switch the process window station');
assert.ok(!inheritedBranch.includes('SetThreadDesktop'), 'Inherited mode must not switch the thread desktop');
const dynamicContext = {
  mode: 'Inherited',
  qualifiedDesktop: 'Service-0x0-test$\\Default',
};
assert.equal(validateChildDesktopMatch({
  bootstrapContext: dynamicContext,
  childContext: { ...dynamicContext },
  parentSessionId: 2,
  childSessionId: 2,
  childProcessId: 42,
  window: { processId: 42, desktop: dynamicContext.qualifiedDesktop },
}), true);
assert.throws(() => validateChildDesktopMatch({
  bootstrapContext: dynamicContext,
  childContext: { ...dynamicContext },
  parentSessionId: 2,
  childSessionId: 3,
}), /session differs/);
assert.equal(proveLabviewVisibility({
  initialRgba: gray,
  candidateRgba: varied,
  width: W,
  height: H,
  initialFingerprint: '0000000000000000',
  candidateFingerprint: 'ffffffffffffffff',
  labviewPid: 42,
  expectedDesktop: dynamicContext.qualifiedDesktop,
  window: {
    processId: 42,
    title: 'LabVIEW 2026',
    visible: true,
    minimized: false,
    desktop: dynamicContext.qualifiedDesktop,
    bounds: { left: 0, top: 0, right: W, bottom: H },
  },
}).passed, true);

const frame = (index, ms, dhashHex) => ({ index, ms, dhashHex });
const frames = [
  frame(0, 0, '0000000000000000'),
  frame(1, 80, '0000000000000000'),
  frame(2, 160, '00ff000000000000'),
  frame(3, 240, '0fff000000000000'),
  ...Array.from({ length: 8 }, (_, i) => frame(4 + i, 320 + i * 80, 'ffffffffffffffff')),
];
const selected = selectRepresentativeFrames(frames, 100, { window: 8, toleranceHamming: 2 });
assert.equal(selected.initial.index, 0);
assert.equal(selected.transition.index, 2);
assert.equal(selected.settled.index, 4);
assert.throws(
  () => selectRepresentativeFrames(frames.slice(0, 2), 100, { window: 1, toleranceHamming: 2 }),
  /no visual launch transition/,
);

const visibility = proveLabviewVisibility({
  initialRgba: gray,
  candidateRgba: varied,
  width: W,
  height: H,
  initialFingerprint: '0000000000000000',
  candidateFingerprint: 'ffffffffffffffff',
  labviewPid: 42,
  window: {
    processId: 42,
    title: 'LabVIEW 2026',
    visible: true,
    minimized: false,
    desktop: 'WinSta0\\Default',
    bounds: { left: 0, top: 0, right: W, bottom: H },
  },
});
assert.equal(visibility.status, 'passed');
assert.equal(proveLabviewVisibility({
  initialRgba: gray,
  candidateRgba: varied,
  width: W,
  height: H,
  initialFingerprint: '0000000000000000',
  candidateFingerprint: 'ffffffffffffffff',
  labviewPid: 42,
  window: {
    processId: 42,
    title: '',
    titleEvidence: 'LabVIEW',
    visible: true,
    minimized: false,
    desktop: 'WinSta0\\Default',
    bounds: { left: 0, top: 0, right: W, bottom: H },
  },
}).passed, true);
assert.equal(proveLabviewVisibility({
  initialRgba: gray,
  candidateRgba: varied,
  width: W,
  height: H,
  initialFingerprint: '0000000000000000',
  candidateFingerprint: 'ffffffffffffffff',
  labviewPid: 42,
  window: { ...visibility.window, processId: 9 },
}).passed, false);

const localProbe = rgba(W, H, (i) => (i % 3 === 0 ? [255, 255, 255, 255] : i % 3 === 1 ? [0, 0, 128, 255] : [255, 165, 0, 255]));
const probeMatch = matchDesktopProbe({
  localRgba: localProbe,
  rfbRgba: Uint8Array.from(localProbe),
  width: W,
  height: H,
  bounds: { left: 0, top: 0, right: W, bottom: H },
});
assert.equal(probeMatch.passed, true);
assert.equal(probeMatch.hamming, 0);
assert.equal(probeMatch.histogramDistance, 0);
const blackProbeMatch = matchDesktopProbe({
  localRgba: localProbe,
  rfbRgba: black,
  width: W,
  height: H,
  bounds: { left: 0, top: 0, right: W, bottom: H },
});
assert.equal(blackProbeMatch.passed, false);
const displayOk = {
  api: {
    getDcSucceeded: true,
    monitorRectangles: [{ left: 0, top: 0, right: W, bottom: H }],
  },
};
assert.deepEqual(
  classifyDisplayProof({ display: { api: { getDcSucceeded: false, monitorRectangles: [] } } }),
  { passed: false, classification: 'desktop-screen-dc-unavailable' },
);
assert.deepEqual(
  classifyDisplayProof({ display: { api: { getDcSucceeded: true, monitorRectangles: [] } } }),
  { passed: false, classification: 'desktop-has-zero-displays' },
);
assert.deepEqual(
  classifyDisplayProof({ display: displayOk, localGdi: { analysis: { passed: false } } }),
  { passed: false, classification: 'desktop-local-gdi-capture-black' },
);
assert.deepEqual(
  classifyDisplayProof({
    display: displayOk,
    localGdi: { analysis: { passed: true } },
    rfbAnalysis: { passed: false },
  }),
  { passed: false, classification: 'rfb-black-despite-local-gdi' },
);
assert.deepEqual(
  classifyDisplayProof({
    display: displayOk,
    localGdi: { analysis: { passed: true } },
    rfbAnalysis: { passed: true },
    probeMatch: { passed: false },
  }),
  { passed: false, classification: 'rfb-probe-mismatch' },
);
assert.deepEqual(
  classifyDisplayProof({
    display: displayOk,
    localGdi: { analysis: { passed: true } },
    rfbAnalysis: { passed: true },
    probeMatch,
  }),
  { passed: true, classification: 'rfb-probe-visible' },
);

assert.deepEqual(
  parseDockerStats({ CPUPerc: '12.5%', MemUsage: '512MiB / 4GiB', BlockIO: '1.5MB / 2GiB' }),
  { cpuPct: 12.5, ramMb: 512, blockReadMb: 1.430511474609375, blockWriteMb: 2048 },
);
const execArgs = buildDockerExecArgs('a'.repeat(64), 'LaunchLabVIEW', ['-OutputPath', 'C:\\evidence\\launch.json']);
assert.equal(execArgs[0], 'exec');
assert.ok(!execArgs.join(' ').toLowerCase().includes('password'));

const resources = [
  {
    ms: 100,
    cpuPct: 10,
    ramMb: 500,
    diskPct: null,
    counters: { dockerBlockReadMb: 1, dockerBlockWriteMb: 2 },
  },
];
const metadata = {
  runId: 'selftest',
  rfb: { width: W, height: H, updateCount: 12, securityType: 2 },
};
const records = buildExperimentRecords({
  frames,
  resourceSamples: resources,
  workloadStartMs: 100,
  fps: 12,
  capacityBytes: 4096,
  representatives: {
    initial: { frameIndex: 0, path: 'initial.png', size: 100 },
    transition: { frameIndex: 2, path: 'transition.png', size: 110 },
    settled: { frameIndex: 4, path: 'settled.png', size: 120 },
  },
  metadata,
  settleOptions: { window: 8, toleranceHamming: 2 },
});
assert.equal(records.benchmark.schema, 'labview-benchmark-actor/boot-benchmark-v1');
assert.equal(records.benchmark.plane, 'WIN');
assert.equal(records.launchCapture.dualPacket.frameCount, frames.length);
assert.equal(records.launchCapture.dualPacket.authoritativeFrames, 3);
assert.equal(records.launchCapture.dualPacket.frames.length, frames.length);
assert.equal(records.benchmark.sourceDetail.uniqueFingerprintCount, 4);
assert.throws(() => buildExperimentRecords({
  frames,
  resourceSamples: [],
  workloadStartMs: 100,
  fps: 12,
  representatives: {},
  metadata,
  settleOptions: { window: 8, toleranceHamming: 2 },
}), /resource samples are missing/);
assert.equal(validateMonotonicFrames(frames), true);
assert.throws(() => validateMonotonicFrames([{ index: 1, ms: 0 }]), /discontinuity/);
await assert.rejects(
  withTimeout(new Promise(() => {}), 5, 'RFB timeout self-test'),
  /RFB timeout self-test/,
);

const containerId = 'a'.repeat(64);
const networkId = 'b'.repeat(64);
const endpointId = 'c'.repeat(64);
const inspection = (networks, ports = {}) => ({
  Id: containerId,
  State: { Running: true },
  NetworkSettings: { Ports: ports, Networks: networks },
});
const nat = {
  NetworkID: networkId,
  EndpointID: endpointId,
  IPAddress: '172.20.0.2',
  IPPrefixLen: 16,
  Gateway: '172.20.0.1',
};
const selectedNetwork = selectContainerNetworkTarget(inspection({ nat }), { expectedContainerId: containerId });
assert.equal(selectedNetwork.target.ipAddress, '172.20.0.2');
assert.deepEqual(selectedNetwork.publishedPorts, []);
assert.throws(() => selectContainerNetworkTarget(inspection({})), /no usable IPv4/);
assert.throws(() => selectContainerNetworkTarget(inspection({ nat: { ...nat, IPAddress: 'bad' } })), /no usable IPv4/);
assert.throws(
  () => selectContainerNetworkTarget(inspection({ one: nat, two: { ...nat, EndpointID: 'd'.repeat(64), IPAddress: '172.21.0.2' } })),
  /ambiguous/,
);
assert.equal(
  selectContainerNetworkTarget(inspection({ other: { ...nat, NetworkID: 'd'.repeat(64) }, nat })).target.networkName,
  'nat',
);
assert.throws(
  () => selectContainerNetworkTarget(inspection({ nat }), { expectedContainerId: 'd'.repeat(64) }),
  /stale/,
);
assert.throws(
  () => selectContainerNetworkTarget(inspection({ nat }), { expectedTarget: { ...selectedNetwork.target, ipAddress: '172.20.0.9' } }),
  /changed/,
);
assert.throws(
  () => selectContainerNetworkTarget(inspection({ nat }, { '5900/tcp': [{ HostIp: '0.0.0.0', HostPort: '50000' }] })),
  /published ports/,
);
assert.equal(validateLoopbackListenerBindings(
  [{ localAddress: '127.0.0.1', localPort: 49152, owningProcess: 42 }],
  { port: 49152, processId: 42 },
), true);
assert.throws(
  () => validateLoopbackListenerBindings([{ localAddress: '0.0.0.0', localPort: 49152, owningProcess: 42 }], { port: 49152, processId: 42 }),
  /non-loopback/,
);
assert.deepEqual(
  classifyRfbStartFailure(new Error('connect refused'), { upstreamConnectionFailures: 1 }),
  { failedGate: 2, classification: 'relay-upstream-failure' },
);
assert.deepEqual(
  classifyRfbStartFailure(new Error('RFB: connection reset'), {
    upstreamConnectionFailures: 1,
    successfulUpstreamConnections: 1,
  }),
  { failedGate: 3, classification: 'rfb-handshake-failure' },
);
assert.deepEqual(
  classifyRfbStartFailure(new Error('RFB: VNC authentication failed'), {}),
  { failedGate: 3, classification: 'rfb-handshake-failure' },
);
assert.deepEqual(
  classifyRfbStartFailure(new Error('RFB full framebuffer update timed out'), {}),
  { failedGate: 3, classification: 'rfb-no-framebuffer-update' },
);

console.log('windows-docker experiment core self-test: PASS');
