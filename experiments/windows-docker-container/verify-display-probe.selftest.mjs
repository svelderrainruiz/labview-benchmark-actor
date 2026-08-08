import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(path.join(os.tmpdir(), 'lba-display-probe-verify-'));
const script = path.join(import.meta.dirname, 'verify-display-probe.mjs');
const json = (name, value) => writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`);
try {
  json('probe-environment.json', {
    runId: 'display-probe-selftest',
    isolation: 'hyperv',
    desktopTarget: 'Inherited',
    deviceAssignment: 'none',
    image: {
      reference: 'nationalinstruments/labview:2026q3-windows',
      id: `sha256:${'a'.repeat(64)}`,
    },
  });
  const display = {
    desktopTarget: 'Inherited',
    api: {
      context: { mode: 'Inherited', windowStation: 'Service-dynamic$', desktop: 'Default' },
      monitorRectangles: [],
    },
    localGdi: { path: null, analysis: { passed: false, reason: 'capture-error' } },
  };
  json('display-diagnostics.json', display);
  json('display-probe.json', {
    schema: 'labview-benchmark-actor/windows-container-display-probe@1',
    status: 'unsupported-display-surface',
    passed: false,
    classification: 'desktop-has-zero-displays',
    desktopTarget: 'Inherited',
    display,
    tightVncStarted: false,
    relayStarted: false,
    secretCreated: false,
    cleanup: { probeProcessStopped: true, probeExecutableRemoved: true },
  });
  json('cleanup-verification.json', {
    containerAbsent: true,
    noRelayListener: true,
    noVncListener: true,
    secretNeverCreated: true,
    probeTemporaryStateRemoved: true,
  });
  const result = spawnSync(process.execPath, [script, '--finalize-and-verify', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json')));
  assert.equal(manifest.outcome, 'unsupported-display-surface');

  const environment = JSON.parse(readFileSync(path.join(root, 'probe-environment.json')));
  json('probe-environment.json', { ...environment, deviceAssignment: 'directx-gpu-class' });
  const invalidDevice = spawnSync(process.execPath, [script, '--finalize-and-verify', root], { encoding: 'utf8' });
  assert.notEqual(invalidDevice.status, 0, 'Hyper-V device assignment must fail evidence verification');
  assert.match(invalidDevice.stderr, /must not assign a device/);
  json('probe-environment.json', environment);

  json('network-relay.json', { forbidden: true });
  const forbiddenRelay = spawnSync(process.execPath, [script, '--finalize-and-verify', root], { encoding: 'utf8' });
  assert.notEqual(forbiddenRelay.status, 0, 'probe-only evidence must reject relay artifacts');
  assert.match(forbiddenRelay.stderr, /contains network-relay\.json/);
  unlinkSync(path.join(root, 'network-relay.json'));
  const restored = spawnSync(process.execPath, [script, '--finalize-and-verify', root], { encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);

  writeFileSync(path.join(root, 'display-probe.json'), 'tampered\n');
  const tampered = spawnSync(process.execPath, [script, '--verify', root], { encoding: 'utf8' });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /size mismatch|hash mismatch/);
  console.log('Windows container display-probe evidence self-test: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
