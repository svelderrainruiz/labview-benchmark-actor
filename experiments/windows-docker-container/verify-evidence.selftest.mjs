import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodePng } from '../manual-procedure-record/capture-adapter.mjs';
import { analyzePixels } from './experiment-core.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'lba-win-vnc-verify-'));
const verifier = path.join(import.meta.dirname, 'verify-evidence.mjs');
const writeJson = (name, value) => writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`);

try {
  const containerId = 'a'.repeat(64);
  const rgba = new Uint8Array([
    0, 0, 0, 255, 0, 0, 0, 255,
    0, 0, 0, 255, 0, 0, 0, 255,
  ]);
  const imageRelative = 'frames/transport-baseline-rfb.png';
  const imagePath = path.join(root, imageRelative);
  mkdirSync(path.dirname(imagePath), { recursive: true });
  writeFileSync(imagePath, encodePng(rgba, 2, 2));
  const imageAnalysis = analyzePixels(rgba, 2, 2);
  const failure = {
    schema: 'labview-benchmark-actor/windows-docker-tightvnc-failure@1',
    outcome: 'inconclusive',
    failedGate: 3,
    classification: 'black-or-uniform-framebuffer',
    transportOnly: true,
    labviewLaunchTriggered: false,
    frameCount: 3,
    environment: {
      container: {
        id: containerId,
        transportOnly: true,
        desktopTarget: 'WinSta0',
      },
      lbabus: {
        hostStage: { version: '0.15.0', payloadSha256: 'b'.repeat(64) },
        containerProbe: { version: '0.15.0', payloadSha256: 'b'.repeat(64) },
      },
    },
    rfb: {
      rfbVersion: '3.8',
      securityType: 2,
      width: 2,
      height: 2,
      updateCount: 1,
    },
    representatives: {},
    network: { target: { networkName: 'nat', ipAddress: '172.20.0.2' } },
    relay: {
      processId: 42,
      bound: { address: '127.0.0.1', family: 'IPv4', port: 49152, requestedPort: 0 },
      upstream: { host: '172.20.0.2', port: 5900 },
      stats: { downstreamToUpstreamBytes: 10, upstreamToDownstreamBytes: 20 },
      cleanup: { closed: true },
    },
    display: {
      desktopTarget: 'WinSta0',
      api: {
        context: {
          mode: 'WinSta0',
          windowStation: 'WinSta0',
          desktop: 'Default',
          qualifiedDesktop: 'WinSta0\\Default',
          explicitStartupDesktop: 'WinSta0\\Default',
          processWindowStationChanged: true,
        },
        monitorRectangles: [],
      },
    },
    imageAcquisition: {
      schema: 'labview-benchmark-actor/windows-container-rfb-image@1',
      status: 'acquired-but-unusable',
      usable: false,
      visualClaim: false,
      source: 'run-owned-container-tightvnc-rfb',
      sourceContainerId: containerId,
      upstreamEndpoint: { host: '172.20.0.2', port: 5900, networkName: 'nat' },
      hostRelayEndpoint: { address: '127.0.0.1', family: 'IPv4', port: 49152, requestedPort: 0 },
      rfb: { version: '3.8', securityType: 2, width: 2, height: 2, updateCountAtSample: 1 },
      frameIndex: 0,
      framePollCount: 3,
      monotonicMs: 1,
      wallTime: '2026-08-08T00:00:00.000Z',
      dhashHex: '0000000000000000',
      path: imageRelative,
      size: statSync(imagePath).size,
      pngSha256: createHash('sha256').update(readFileSync(imagePath)).digest('hex'),
      rgbaSha256: createHash('sha256').update(rgba).digest('hex'),
      analysis: imageAnalysis,
    },
  };
  writeJson('capture-summary.json', failure);
  writeJson('failure-receipt.json', failure);
  writeJson('lbabus-host-stage.json', {
    schema: 'labview-benchmark-actor/windows-container-lbabus-stage@1',
    version: '0.15.0',
    payloadSha256: 'b'.repeat(64),
  });
  writeJson('lbabus-container.json', {
    schema: 'labview-benchmark-actor/windows-container-lbabus@1',
    status: 'passed',
    version: '0.15.0',
    payloadSha256: 'b'.repeat(64),
    capabilities: ['  [yes] labview-cli  LabVIEWCLI on PATH (host-native)'],
  });
  writeJson('network-preflight.json', {
    status: 'passed',
    target: { networkName: 'nat', ipAddress: '172.20.0.2' },
    dockerPublishedPorts: [],
    dockerPortOutput: [],
    directProbe: { connected: true },
  });
  writeJson('network-relay.json', {
    processId: 42,
    bound: { address: '127.0.0.1', family: 'IPv4', port: 49152, requestedPort: 0 },
    upstream: { host: '172.20.0.2', port: 5900 },
    listenerBindings: [{ localAddress: '127.0.0.1', localPort: 49152, owningProcess: 42 }],
    stats: {
      acceptedConnections: 1,
      successfulUpstreamConnections: 1,
      downstreamToUpstreamBytes: 10,
      upstreamToDownstreamBytes: 20,
      activeConnections: 0,
    },
    cleanup: { closed: true, listenerBindingsAfterClose: [] },
  });
  writeJson('display-diagnostics.json', {
    desktopTarget: 'WinSta0',
    api: {
      context: {
        mode: 'WinSta0',
        windowStation: 'WinSta0',
        desktop: 'Default',
        qualifiedDesktop: 'WinSta0\\Default',
        explicitStartupDesktop: 'WinSta0\\Default',
        processWindowStationChanged: true,
      },
      monitorRectangles: [],
    },
    desktopProbe: { marker: 'selftest' },
    localGdi: null,
  });
  writeJson('cleanup-verification.json', {
    containerAbsent: true,
    vncPortClosed: true,
    relayListenerClosed: true,
    relayCleanupProven: true,
    secretDirectoryRemoved: true,
  });
  writeFileSync(path.join(root, 'host-orchestration.log'), 'failure evidence\n');

  const finalized = spawnSync(process.execPath, [verifier, '--finalize-and-verify', root], { encoding: 'utf8' });
  assert.equal(finalized.status, 0, finalized.stderr);
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.outcome, 'inconclusive');
  assert.equal(manifest.relay.bound.address, '127.0.0.1');
  assert.equal(manifest.relay.upstream.host, '172.20.0.2');
  assert.equal(manifest.relay.stats.upstreamToDownstreamBytes, 20);
  assert.equal(manifest.desktop.target, 'WinSta0');
  assert.equal(manifest.desktop.context.windowStation, 'WinSta0');
  assert.ok(manifest.files.some((entry) => entry.path === imageRelative));
  assert.ok(manifest.files.some((entry) => entry.path === 'host-orchestration.log' && /^[a-f0-9]{64}$/.test(entry.sha256)));

  writeFileSync(path.join(root, 'host-orchestration.log'), 'tampered\n');
  const tampered = spawnSync(process.execPath, [verifier, '--verify', root], { encoding: 'utf8' });
  assert.notEqual(tampered.status, 0, 'manifest verification must fail after evidence tampering');
  assert.match(tampered.stderr, /size mismatch|SHA-256 mismatch/);
  console.log('windows-docker evidence verifier self-test: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
