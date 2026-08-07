#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateLifecycle } from './vm-lifecycle-core.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node verify-vm-lifecycle-cache.mjs <cache.json>');
  process.exitCode = 2;
} else {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const cachePath = path.resolve(file);
  const record = JSON.parse(readFileSync(cachePath, 'utf8'));
  validateLifecycle(record);
  assert.equal(record.historicalCoverage.preProvisionMonotonicStartObserved, false);
  assert.match(record.historicalCoverage.note, /must not be estimated/);
  for (const checkpoint of record.checkpoints.filter((item) => item.phase !== 'CACHE-SEALED')) {
    assert.equal(checkpoint.authority, 'historical-state-proof');
    assert.equal(checkpoint.monotonicNs, null);
    assert.equal(checkpoint.timingTicks64, null);
  }
  assert.equal(record.checkpoints.at(-1).phase, 'CACHE-SEALED');
  assert.equal(record.checkpoints.at(-1).authority, 'live-dual-clock');
  assert.equal(record.cache.state, 'verified-poweroff-activation-required');
  assert.equal(record.resume.state, 'activation-required');
  assert.equal(record.resume.nextPhase, 'ACTIVATION-RESUME-START');
  assert.equal(record.completion.complete, false);
  assert.equal(record.completion.completedThrough, 'ACTIVATION-REQUIRED');
  assert.match(record.resume.command, /vm-lifecycle\.mjs resume/);

  const hashFile = (filePath) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  for (const artifact of record.cache.artifacts) {
    const artifactPath = path.isAbsolute(artifact.path) ? artifact.path : path.join(repoRoot, artifact.path);
    assert.equal(statSync(artifactPath).size, artifact.size, `${artifact.path} size mismatch`);
    assert.equal(await hashFile(artifactPath), artifact.sha256, `${artifact.path} hash mismatch`);
  }

  const vmInfo = execFileSync('VBoxManage', ['showvminfo', record.vmName, '--machinereadable'], { encoding: 'utf8' });
  assert.match(vmInfo, new RegExp(`^UUID="${record.cache.vm.uuid}"$`, 'm'));
  assert.match(vmInfo, /^VMState="poweroff"$/m);
  assert.equal(/Forwarding.*lba-vnc/i.test(vmInfo), false);
  const snapshots = execFileSync('VBoxManage', ['snapshot', record.vmName, 'list', '--machinereadable'], { encoding: 'utf8' });
  for (const uuid of Object.values(record.cache.snapshots)) assert.ok(snapshots.includes(uuid), `snapshot ${uuid} missing`);
  const boxes = execFileSync('vagrant', ['box', 'list'], { encoding: 'utf8' });
  assert.equal(/actor\/win11-labview2026\s+\(virtualbox,/i.test(boxes), false);

  const captureRoot = path.join(repoRoot, record.visualCapture.evidenceRoot);
  const launchTrigger = JSON.parse(readFileSync(path.join(captureRoot, 'launch-trigger.json'), 'utf8'));
  const capture = JSON.parse(readFileSync(path.join(captureRoot, 'launch-capture.json'), 'utf8'));
  const benchmark = JSON.parse(readFileSync(path.join(captureRoot, 'benchmark.json'), 'utf8'));
  const transition = capture.frames.find((frame) => frame.index === record.visualCapture.splash.frameIndex);
  const settled = capture.frames.find((frame) => frame.index === record.visualCapture.activationWizardSettled.frameIndex);
  const round4 = (value) => Math.round(value * 10000) / 10000;
  assert.equal(record.visualCapture.workloadStartMs, launchTrigger.hostMonotonicMs);
  assert.equal(
    record.visualCapture.splash.msFromLaunchTrigger,
    round4(capture.startMs + transition.tMs - launchTrigger.hostMonotonicMs),
  );
  assert.equal(
    record.visualCapture.activationWizardSettled.msFromLaunchTrigger,
    round4(capture.startMs + settled.tMs - launchTrigger.hostMonotonicMs),
  );
  assert.equal(
    record.visualCapture.activationWizardSettled.benchmarkLaunchMsRaw,
    benchmark.spans.find((span) => span.id === 'launchMs').ms,
  );
  assert.ok(Math.abs(record.visualCapture.activationWizardSettled.timingRoundingDeltaMs) <= 0.5);
  assert.equal(settled.dhashHex, record.visualCapture.activationWizardSettled.fingerprint);
  assert.equal(record.visualCapture.diagnosticOnly, true);
  assert.match(record.visualCapture.warning, /not activated IDE readiness/);

  console.log(JSON.stringify({
    lifecycleId: record.lifecycleId,
    state: record.state,
    checkpoints: record.checkpoints.length,
    cacheArtifacts: record.cache.artifacts.length,
    nextPhase: record.resume.nextPhase,
    diagnosticSplashMs: record.visualCapture.splash.msFromLaunchTrigger,
    diagnosticActivationWizardSettleMs: record.visualCapture.activationWizardSettled.msFromLaunchTrigger,
  }));
}
