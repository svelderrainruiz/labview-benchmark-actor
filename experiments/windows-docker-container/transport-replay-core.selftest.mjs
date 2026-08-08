import assert from 'node:assert/strict';
import { deriveTransportReplay, validateTransportReplay } from './transport-replay-core.mjs';

const sourceFiles = {
  manifest: 'manifest.json',
  failureReceipt: 'failure-receipt.json',
  networkPreflight: 'network-preflight.json',
  networkRelay: 'network-relay.json',
  cleanupVerification: 'cleanup-verification.json',
  tightVncLog: 'tvnserver.log',
  rfbImage: 'frames/transport-baseline-rfb.png',
  lbabusHostStage: 'lbabus-host-stage.json',
  lbabusContainer: 'lbabus-container.json',
};
const source = (role) => ({
  path: `experiments/windows-docker-container/evidence/run-1/${sourceFiles[role]}`,
  size: 10,
  sha256: role.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
});

const base = () => ({
  manifest: {
    runId: 'run-1',
    outcome: 'inconclusive',
    files: [{
      path: 'frames/transport-baseline-rfb.png',
      size: source('rfbImage').size,
      sha256: source('rfbImage').sha256,
    }],
    relay: {
      cleanup: {
        closed: true,
        listenerReachable: false,
        elapsedMs: 1.25,
        listenerBindingsAfterClose: [],
        closedWallTime: '2026-08-07T00:00:05.000Z',
      },
    },
  },
  failureReceipt: {
    outcome: 'inconclusive',
    failedGate: 3,
    classification: 'black-or-uniform-framebuffer',
    transportOnly: true,
    labviewLaunchTriggered: false,
    wallTime: '2026-08-07T00:00:04.000Z',
    environment: {
      runId: 'run-1',
      image: {
        reference: 'nationalinstruments/labview:2026q3-windows',
        id: `sha256:${'1'.repeat(64)}`,
        expectedId: `sha256:${'1'.repeat(64)}`,
        os: 'windows',
        architecture: 'amd64',
      },
      container: {
        id: 'container-1',
        isolation: 'process',
        transportOnly: true,
        desktopTarget: 'WinSta0',
        dockerPublishedPorts: [],
      },
      lbabus: {
        hostStage: { payloadSha256: 'e'.repeat(64) },
        containerProbe: { payloadSha256: 'e'.repeat(64) },
      },
    },
    rfb: {
      width: 1024,
      height: 768,
      rfbVersion: '3.8',
      securityType: 2,
      securityTypeName: 'VNC Authentication',
      updateCount: 2,
    },
    frameCount: 18,
    initialAnalysis: {
      passed: false,
      pixels: 1024 * 768,
      blackFraction: 1,
      meaningfulLumaPopulations: 1,
      reason: 'single-color-or-single-luminance-population',
    },
    imageAcquisition: {
      schema: 'labview-benchmark-actor/windows-container-rfb-image@1',
      status: 'acquired-but-unusable',
      usable: false,
      visualClaim: false,
      source: 'run-owned-container-tightvnc-rfb',
      sourceContainerId: 'container-1',
      upstreamEndpoint: { host: '172.20.0.2', port: 5900 },
      hostRelayEndpoint: { address: '127.0.0.1', port: 49152 },
      rfb: { version: '3.8', securityType: 2, width: 1024, height: 768, updateCountAtSample: 1 },
      framePollCount: 18,
      path: 'frames/transport-baseline-rfb.png',
      size: source('rfbImage').size,
      pngSha256: source('rfbImage').sha256,
      rgbaSha256: 'f'.repeat(64),
    },
  },
  networkPreflight: {
    status: 'passed',
    containerId: 'container-1',
    wallTime: '2026-08-07T00:00:01.000Z',
    target: { ipAddress: '172.20.0.2' },
    dockerPublishedPorts: [],
    directProbe: {
      connected: true,
      elapsedMs: 1.5,
      endpoint: '172.20.0.2:5900',
    },
  },
  networkRelay: {
    status: 'rfb-traversed',
    readyWallTime: '2026-08-07T00:00:02.000Z',
    rfbTraversedWallTime: '2026-08-07T00:00:03.000Z',
    bound: { address: '127.0.0.1', family: 'IPv4', port: 49152 },
    upstream: { host: '172.20.0.2', port: 5900 },
    listenerBindings: [{ localAddress: '127.0.0.1', localPort: 49152 }],
    stats: {
      acceptedConnections: 1,
      successfulUpstreamConnections: 1,
      upstreamConnectionFailures: 0,
      downstreamErrors: 0,
      downstreamToUpstreamBytes: 88,
      upstreamToDownstreamBytes: 6291559,
      serverErrors: 0,
    },
  },
  cleanupVerification: {
    wallTime: '2026-08-07T00:00:06.000Z',
    containerAbsent: true,
    relayListenerClosed: true,
    relayCleanupProven: true,
    vncPortClosed: true,
    secretDirectoryRemoved: true,
  },
  tightVncLog: 'The console desktop has 0 displays\nDesktop resize is disabled, sending blank screen\n',
  rfbImage: {
    width: 1024,
    height: 768,
    rgbaSha256: 'f'.repeat(64),
    analysis: {
      passed: false,
      blackFraction: 1,
      meaningfulLumaPopulations: 1,
      reason: 'single-color-or-single-luminance-population',
    },
  },
  lbabusHostStage: {
    schema: 'labview-benchmark-actor/windows-container-lbabus-stage@1',
    version: '0.15.0',
    payloadSha256: 'e'.repeat(64),
  },
  lbabusContainer: {
    schema: 'labview-benchmark-actor/windows-container-lbabus@1',
    status: 'passed',
    version: '0.15.0',
    payloadSha256: 'e'.repeat(64),
    capabilities: ['  [yes] labview-cli  LabVIEWCLI on PATH (host-native)'],
  },
  sources: {
    manifest: source('manifest'),
    failureReceipt: source('failureReceipt'),
    networkPreflight: source('networkPreflight'),
    networkRelay: source('networkRelay'),
    cleanupVerification: source('cleanupVerification'),
    tightVncLog: source('tightVncLog'),
    rfbImage: source('rfbImage'),
    lbabusHostStage: source('lbabusHostStage'),
    lbabusContainer: source('lbabusContainer'),
  },
});

const clone = (value) => structuredClone(value);
const input = base();
const record = deriveTransportReplay(input);
assert.equal(validateTransportReplay(record), true);
assert.deepEqual(record, deriveTransportReplay(base()), 'transport replay must be deterministic');
assert.equal(record.mprr.markers.length, 6);
assert.equal(record.mprr.visualFramesEncoded, 0);
assert.equal(record.transport.totalRelayBytes, 6291647);
assert.equal(record.capabilities.labviewVisualLaunchBenchmark, 'unsupported-by-windows-container-platform');
assert.equal(record.framebuffer.tightVncZeroDisplayMode, 'blank-screen');
assert.equal(record.framebuffer.diagnosticImage.acquiredFromContainerRfb, true);
assert.equal(record.framebuffer.diagnosticImage.usable, false);
assert.equal(record.capabilities.lbabusInContainer, 'supported-and-proven');
const desktopSizeInput = base();
desktopSizeInput.tightVncLog =
  'The console desktop has 0 displays\nDesktop resize is enabled, sending NewFBSize 1024x768\nupdate requested\n';
assert.equal(
  deriveTransportReplay(desktopSizeInput).framebuffer.tightVncZeroDisplayMode,
  'desktop-size-then-black-update',
);

for (const [mutate, pattern] of [
  [(value) => { value.networkRelay.bound.address = '0.0.0.0'; }, /loopback-only relay/],
  [(value) => { value.failureReceipt.rfb.securityType = 1; }, /authenticated RFB/],
  [(value) => { value.networkRelay.stats.upstreamToDownstreamBytes = 0; }, /positive integer/],
  [(value) => { value.cleanupVerification.containerAbsent = false; }, /cleanup proof/],
  [(value) => { value.failureReceipt.initialAnalysis.blackFraction = 0; }, /black framebuffer/],
  [(value) => { value.rfbImage.rgbaSha256 = '0'.repeat(64); }, /retained container RFB image/],
  [(value) => { value.lbabusContainer.status = 'failed'; }, /lbabus capability proof/],
  [(value) => { value.tightVncLog = 'one display'; }, /zero-display log/],
  [(value) => { value.networkPreflight.dockerPublishedPorts = ['5900/tcp']; }, /publication/],
  [(value) => { value.sources.manifest.path = 'C:\\outside\\manifest.json'; }, /sources\.manifest\.path/],
]) {
  const changed = base();
  mutate(changed);
  assert.throws(() => deriveTransportReplay(changed), pattern);
}

const forbidden = clone(record);
forbidden.forbiddenClaims.labviewLaunchMs = 100;
assert.throws(() => validateTransportReplay(forbidden), /forbidden GUI/);
const inventedFrame = clone(record);
inventedFrame.mprr.visualFramesEncoded = 1;
assert.throws(() => validateTransportReplay(inventedFrame), /invented retained visual frames/);
const badPacket = clone(record);
badPacket.mprr.markers[0].packetSha256 = '0'.repeat(64);
assert.throws(() => validateTransportReplay(badPacket), /packet digest/);

console.log('Windows container transport replay core self-test: PASS');
