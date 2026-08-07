import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(path.join(os.tmpdir(), 'lba-win-vnc-verify-'));
const verifier = path.join(import.meta.dirname, 'verify-evidence.mjs');
const writeJson = (name, value) => writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`);

try {
  writeJson('capture-summary.json', {
    schema: 'labview-benchmark-actor/windows-docker-tightvnc-failure@1',
    outcome: 'inconclusive',
    failedGate: 3,
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
      desktopTarget: 'Inherited',
      api: {
        context: {
          mode: 'Inherited',
          windowStation: 'Service-dynamic$',
          desktop: 'Default',
          qualifiedDesktop: 'Service-dynamic$\\Default',
          explicitStartupDesktop: null,
          processWindowStationChanged: false,
        },
        monitorRectangles: [{ left: 0, top: 0, right: 1024, bottom: 768 }],
      },
    },
  });
  writeJson('failure-receipt.json', {
    schema: 'labview-benchmark-actor/windows-docker-tightvnc-failure@1',
    outcome: 'inconclusive',
    failedGate: 3,
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
    desktopTarget: 'Inherited',
    api: {
      context: {
        mode: 'Inherited',
        windowStation: 'Service-dynamic$',
        desktop: 'Default',
        qualifiedDesktop: 'Service-dynamic$\\Default',
        explicitStartupDesktop: null,
        processWindowStationChanged: false,
      },
      monitorRectangles: [{ left: 0, top: 0, right: 1024, bottom: 768 }],
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
  assert.equal(manifest.desktop.target, 'Inherited');
  assert.equal(manifest.desktop.context.windowStation, 'Service-dynamic$');
  assert.ok(manifest.files.some((entry) => entry.path === 'host-orchestration.log' && /^[a-f0-9]{64}$/.test(entry.sha256)));

  writeFileSync(path.join(root, 'host-orchestration.log'), 'tampered\n');
  const tampered = spawnSync(process.execPath, [verifier, '--verify', root], { encoding: 'utf8' });
  assert.notEqual(tampered.status, 0, 'manifest verification must fail after evidence tampering');
  assert.match(tampered.stderr, /size mismatch|SHA-256 mismatch/);
  console.log('windows-docker evidence verifier self-test: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
