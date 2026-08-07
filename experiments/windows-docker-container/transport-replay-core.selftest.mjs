import assert from 'node:assert/strict';
import { deriveTransportReplay, validateTransportReplay } from './transport-replay-core.mjs';

const sourceFiles = {
  manifest: 'manifest.json',
  failureReceipt: 'failure-receipt.json',
  networkPreflight: 'network-preflight.json',
  networkRelay: 'network-relay.json',
  cleanupVerification: 'cleanup-verification.json',
  tightVncLog: 'tvnserver.log',
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
        dockerPublishedPorts: [],
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
  sources: {
    manifest: source('manifest'),
    failureReceipt: source('failureReceipt'),
    networkPreflight: source('networkPreflight'),
    networkRelay: source('networkRelay'),
    cleanupVerification: source('cleanupVerification'),
    tightVncLog: source('tightVncLog'),
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

for (const [mutate, pattern] of [
  [(value) => { value.networkRelay.bound.address = '0.0.0.0'; }, /loopback-only relay/],
  [(value) => { value.failureReceipt.rfb.securityType = 1; }, /authenticated RFB/],
  [(value) => { value.networkRelay.stats.upstreamToDownstreamBytes = 0; }, /positive integer/],
  [(value) => { value.cleanupVerification.containerAbsent = false; }, /cleanup proof/],
  [(value) => { value.failureReceipt.initialAnalysis.blackFraction = 0; }, /black framebuffer/],
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
