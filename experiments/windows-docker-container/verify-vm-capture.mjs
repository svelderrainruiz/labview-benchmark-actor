#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from '../manual-procedure-record/capture-adapter.mjs';
import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';
import { analyzePixels } from './experiment-core.mjs';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const json = (root, name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const walk = (root, directory = root) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(root, full) : [path.relative(root, full).replaceAll('\\', '/')];
});
const atomicJson = (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
};

function finalize(root) {
  const summary = json(root, 'capture-summary.json');
  const files = walk(root).filter((name) => name !== 'manifest.json' && !name.endsWith('.tmp')).sort().map((name) => {
    const file = path.join(root, name);
    const stat = statSync(file);
    return { path: name, size: stat.size, sha256: sha256(file), modifiedWallTime: stat.mtime.toISOString() };
  });
  atomicJson(path.join(root, 'manifest.json'), {
    schema: 'labview-benchmark-actor/windows-vm-capture-manifest@1',
    outcome: summary.outcome,
    classification: summary.classification ?? null,
    generatedWallTime: new Date().toISOString(),
    files,
  });
}

function verify(root) {
  const manifest = json(root, 'manifest.json');
  for (const entry of manifest.files) {
    const file = path.join(root, entry.path);
    assert.equal(statSync(file).size, entry.size, `${entry.path} size mismatch`);
    assert.equal(sha256(file), entry.sha256, `${entry.path} hash mismatch`);
    if (entry.path.endsWith('.json')) JSON.parse(readFileSync(file, 'utf8'));
  }
  const summary = json(root, 'capture-summary.json');
  const launch = json(root, 'launch-diagnostics.json');
  const resources = json(root, 'resource-samples.json');
  const cleanup = json(root, 'cleanup-verification.json');
  const guestCleanup = json(root, 'guest-cleanup-verification.json');
  assert.equal(cleanup.vmPoweredOff, true);
  assert.equal(cleanup.natRuleRemoved, true);
  assert.equal(cleanup.hostVncSecretRemoved, true);
  assert.equal(cleanup.guestVncSecretRemoved, true);
  assert.equal(cleanup.vncPasswordRegistryRemoved, true);
  assert.equal(cleanup.captureTasksRemoved, true);
  assert.equal(cleanup.captureProcessesStopped, true);
  assert.equal(guestCleanup.schema, 'labview-benchmark-actor/windows-vm-guest-cleanup@1');
  assert.equal(guestCleanup.labviewProcesses, 0);
  assert.equal(guestCleanup.tightVncProcesses, 0);
  assert.equal(guestCleanup.captureTasks, 0);
  assert.equal(guestCleanup.vncPasswordPresent, false);
  assert.equal(guestCleanup.guestVncSecretPresent, false);
  assert.equal(guestCleanup.guestTightVncMsiPresent, false);
  assert.ok(resources.samples.length > 0);
  if (summary.outcome === 'blocked') {
    assert.equal(summary.classification, 'labview-activation-required');
    assert.match(launch.expectedWindow.className, /NI License Manager Wizard/);
  }
  const capture = json(root, 'launch-capture.json');
  const benchmark = json(root, 'benchmark.json');
  const images = capture.frames.filter((frame) => frame.image).map((frame) => frame.image);
  assert.ok(images.length >= 3, 'VM capture must retain representative PNGs');
  for (const image of images) {
    const decoded = decodePng(readFileSync(path.join(root, image)));
    assert.equal(analyzePixels(decoded.rgba, decoded.width, decoded.height).passed, true, `${image} pixel proof failed`);
  }
  const settled = capture.frames.find((frame) => frame.index === benchmark.frames[0].index);
  assert.ok(settled?.image, 'settled long packet is missing');
  const decodedSettled = decodePng(readFileSync(path.join(root, settled.image)));
  assert.equal(
    dhash64FromRgba(decodedSettled.rgba, decodedSettled.width, decodedSettled.height),
    benchmark.frames[0].perceptualFingerprint,
    'settled PNG fingerprint mismatch',
  );
  return { outcome: summary.outcome, classification: summary.classification ?? null, files: manifest.files.length };
}

const [command, directory] = process.argv.slice(2);
if (!['--finalize-and-verify', '--verify'].includes(command) || !directory) {
  console.error('Usage: node verify-vm-capture.mjs <--finalize-and-verify|--verify> <directory>');
  process.exitCode = 2;
} else {
  const root = path.resolve(directory);
  if (command === '--finalize-and-verify') finalize(root);
  console.log(JSON.stringify(verify(root)));
}
