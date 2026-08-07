#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const receiptPath = process.argv[2];
const hashFile = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});
if (!receiptPath) {
  console.error('Usage: node verify-vm-provisioning-receipt.mjs <receipt.json>');
  process.exitCode = 2;
} else {
  const receipt = JSON.parse(readFileSync(path.resolve(receiptPath), 'utf8'));
  assert.equal(receipt.schema, 'labview-benchmark-actor/windows-vm-provisioning@1');
  assert.equal(receipt.outcome, 'blocked-activation');
  for (const source of [receipt.sources.windows, receipt.sources.labview]) {
    assert.equal(statSync(source.file).size, source.size, `${source.file} size mismatch`);
    assert.equal(await hashFile(source.file), source.sha256, `${source.file} hash mismatch`);
  }
  const vmInfo = execFileSync('VBoxManage', ['showvminfo', receipt.vm.name, '--machinereadable'], { encoding: 'utf8' });
  assert.match(vmInfo, new RegExp(`^UUID="${receipt.vm.uuid}"$`, 'm'));
  assert.match(vmInfo, /^VMState="poweroff"$/m);
  assert.equal(/Forwarding.*lba-vnc/i.test(vmInfo), false, 'VNC NAT rule remains');
  assert.equal(/"SATA-[12]-0"="(?!none)/m.test(vmInfo), false, 'temporary optical media remains attached');
  assert.equal(statSync('D:\\lba-vm-assets\\.vnc-password', { throwIfNoEntry: false }), undefined, 'host VNC secret remains');
  assert.equal(statSync('D:\\lba-vm-assets\\.vnc-port', { throwIfNoEntry: false }), undefined, 'host VNC port file remains');
  const snapshots = execFileSync('VBoxManage', ['snapshot', receipt.vm.name, 'list', '--machinereadable'], { encoding: 'utf8' });
  for (const uuid of Object.values(receipt.vm.snapshots)) assert.ok(snapshots.includes(uuid), `snapshot ${uuid} is missing`);
  const boxes = execFileSync('vagrant', ['box', 'list'], { encoding: 'utf8' });
  assert.equal(/actor\/win11-labview2026\s+\(virtualbox,/i.test(boxes), false, 'blocked box must not be registered');
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const captureRoot = path.join(repoRoot, receipt.visualProof.evidence);
  const manifest = path.join(captureRoot, 'manifest.json');
  assert.equal(createHash('sha256').update(readFileSync(manifest)).digest('hex'), receipt.visualProof.manifestSha256);
  const failure = JSON.parse(readFileSync(path.join(captureRoot, 'failure-receipt.json'), 'utf8'));
  const cleanup = JSON.parse(readFileSync(path.join(captureRoot, 'cleanup-verification.json'), 'utf8'));
  const guestCleanup = JSON.parse(readFileSync(path.join(captureRoot, 'guest-cleanup-verification.json'), 'utf8'));
  assert.equal(failure.outcome, 'blocked');
  assert.equal(failure.classification, 'labview-activation-required');
  assert.match(failure.launchDiagnostics.expectedWindow.className, /NI License Manager Wizard/);
  for (const [key, value] of Object.entries(receipt.cleanup)) {
    if (['opticalMediaDetached', 'guestCleanupSha256'].includes(key)) continue;
    assert.equal(cleanup[key], value, `capture cleanup '${key}' mismatch`);
  }
  assert.equal(createHash('sha256').update(readFileSync(path.join(captureRoot, 'guest-cleanup-verification.json'))).digest('hex'), receipt.cleanup.guestCleanupSha256);
  assert.equal(guestCleanup.labviewProcesses, 0);
  assert.equal(guestCleanup.tightVncProcesses, 0);
  assert.equal(guestCleanup.captureTasks, 0);
  assert.equal(guestCleanup.vncPasswordPresent, false);
  assert.equal(receipt.registration.registered, false);
  console.log(JSON.stringify({
    outcome: receipt.outcome,
    vm: receipt.vm.name,
    blocker: receipt.registration.reason,
    captureEvidence: receipt.visualProof.evidence,
  }));
}
