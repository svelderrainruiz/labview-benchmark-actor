#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from '../manual-procedure-record/capture-adapter.mjs';
import { analyzePixels } from './experiment-core.mjs';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = (root, name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const atomicJson = (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
};

function finalize(root) {
  const environment = readJson(root, 'probe-environment.json');
  const probe = readJson(root, 'display-probe.json');
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'manifest.json' && !entry.name.endsWith('.tmp'))
    .map((entry) => {
      const full = path.join(root, entry.name);
      const stat = statSync(full);
      return { path: entry.name, size: stat.size, sha256: sha256(full), modifiedWallTime: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schema: 'labview-benchmark-actor/windows-container-display-probe-manifest@1',
    runId: environment.runId,
    outcome: probe.passed ? 'display-surface-available' : 'unsupported-display-surface',
    isolation: environment.isolation,
    desktopTarget: probe.desktopTarget,
    generatedWallTime: new Date().toISOString(),
    files,
  };
  atomicJson(path.join(root, 'manifest.json'), manifest);
}

function verify(root) {
  const manifest = readJson(root, 'manifest.json');
  for (const entry of manifest.files) {
    const full = path.join(root, entry.path);
    assert.equal(statSync(full).size, entry.size, `${entry.path} size mismatch`);
    assert.equal(sha256(full), entry.sha256, `${entry.path} hash mismatch`);
    if (entry.path.endsWith('.json')) JSON.parse(readFileSync(full, 'utf8'));
  }
  const environment = readJson(root, 'probe-environment.json');
  const probe = readJson(root, 'display-probe.json');
  const display = readJson(root, 'display-diagnostics.json');
  const cleanup = readJson(root, 'cleanup-verification.json');
  assert.equal(environment.image.reference, 'nationalinstruments/labview:2026q3-windows');
  assert.match(environment.image.id, /^sha256:[a-f0-9]{64}$/);
  assert.ok(['process', 'hyperv'].includes(environment.isolation));
  assert.equal(probe.schema, 'labview-benchmark-actor/windows-container-display-probe@1');
  assert.equal(probe.tightVncStarted, false);
  assert.equal(probe.relayStarted, false);
  assert.equal(probe.secretCreated, false);
  assert.equal(display.desktopTarget, probe.desktopTarget);
  assert.equal(display.api.context.mode, probe.desktopTarget);
  assert.equal(cleanup.containerAbsent, true);
  assert.equal(cleanup.noRelayListener, true);
  assert.equal(cleanup.noVncListener, true);
  assert.equal(cleanup.secretNeverCreated, true);
  assert.equal(cleanup.probeTemporaryStateRemoved, true);
  for (const forbidden of ['network-relay.json', 'resource-samples.json', 'benchmark.json', 'launch-capture.json']) {
    assert.equal(existsSync(path.join(root, forbidden)), false, `probe-only evidence contains ${forbidden}`);
  }
  if (display.localGdi?.path) {
    const png = path.join(root, display.localGdi.path);
    const decoded = decodePng(readFileSync(png));
    assert.equal(sha256(png), display.localGdi.sha256);
    assert.equal(analyzePixels(decoded.rgba, decoded.width, decoded.height).passed, display.localGdi.analysis.passed);
  }
  if (environment.isolation === 'hyperv') {
    assert.equal(environment.deviceAssignment, 'none', 'Hyper-V probe must not assign a device');
  }
  return {
    outcome: manifest.outcome,
    classification: probe.classification,
    isolation: environment.isolation,
    files: manifest.files.length,
  };
}

const [command, directory] = process.argv.slice(2);
if (!['--finalize-and-verify', '--verify'].includes(command) || !directory) {
  console.error('Usage: node verify-display-probe.mjs <--finalize-and-verify|--verify> <run-directory>');
  process.exitCode = 2;
} else {
  const root = path.resolve(directory);
  if (command === '--finalize-and-verify') finalize(root);
  console.log(JSON.stringify(verify(root)));
}
