#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sha256,
  validateBaseBootstrapReceipt,
  validateGoldenBaseProof,
  validateGoldenBoxDefinition,
} from '../scripts/verify-ubuntu-golden-box.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const vagrantfile = readFileSync(join(repoRoot, 'cleanroom', 'ubuntu-labview', 'production-golden-box.Vagrantfile'), 'utf8');
const metadataText = readFileSync(join(repoRoot, 'cleanroom', 'ubuntu-labview', 'production-golden-box.metadata.json'), 'utf8');
const metadata = JSON.parse(metadataText);
const activationCycle = readFileSync(join(repoRoot, 'cleanroom', 'ubuntu-labview', 'golden-activation-cycle.ps1'), 'utf8');

const baseReceipt = {
  schema: 'labview-benchmark-actor/ubuntu-base-bootstrap@1',
  os: { name: 'Ubuntu 24.04.4 LTS', version: '24.04' },
  vm: { name: 'lba-golden-proof', uuid: '01234567-89ab-cdef-0123-456789abcdef' },
  tools: {
    git: { path: '/usr/bin/git', version: 'git version 2.43.0' },
    sshd: { path: '/usr/sbin/sshd', version: '1:9.6p1-3ubuntu13.18' },
    virtualBoxGuestService: { path: '/usr/sbin/VBoxService', version: '7.0.16_Ubuntur162802' },
  },
  services: {
    ssh: { activeState: 'active', enabledState: 'enabled' },
    virtualBoxGuestUtils: { activeState: 'active', enabledState: 'enabled' },
  },
  timings: {
    install: { durationNs: '10926017658', monotonicClockSource: 'python.time.monotonic_ns' },
    firstBootValidation: { durationNs: '300449402', monotonicClockSource: 'python.time.monotonic_ns' },
  },
  failures: [],
  outcome: 'PASS',
};

assert.equal(validateGoldenBoxDefinition({ metadata, vagrantfile }).ok, true, 'committed golden definition must validate');
assert.equal(
  validateGoldenBoxDefinition({
    metadata: { ...metadata, definition: { ...metadata.definition, sha256: '0'.repeat(64) } },
    vagrantfile,
  }).ok,
  false,
  'definition digest drift must fail closed',
);
assert.equal(validateBaseBootstrapReceipt(baseReceipt).ok, true, 'valid base receipt must pass');
assert.equal(
  validateBaseBootstrapReceipt({
    ...baseReceipt,
    services: { ...baseReceipt.services, ssh: { activeState: 'inactive', enabledState: 'enabled' } },
  }).ok,
  false,
  'inactive SSH must fail closed',
);

const proofWithoutDigest = {
  schema: 'labview-benchmark-actor/ubuntu-golden-base-proof@1',
  source: { commit: '1'.repeat(40) },
  vm: { name: 'lba-golden-proof', uuid: '01234567-89ab-cdef-0123-456789abcdef', disposable: true },
  graphicalLoginPerformed: false,
  natForward: { hostAddress: '127.0.0.1', hostPort: 2222, guestPort: 22 },
  polling: { intervalSeconds: 5, timeoutSeconds: 2700 },
  timings: {
    vmRunningToSshReadyNs: '1256042254600',
    hostMonotonicClockSource: 'System.Diagnostics.Stopwatch',
  },
  definition: {
    vagrantfileSha256: sha256(vagrantfile),
    metadataSha256: sha256(metadataText),
  },
  evidence: { baseBootstrapReceiptSha256: '2'.repeat(64) },
  screenshots: [{ path: 'docs/information-for-users/images/ubuntu-24.04-labview-2026/golden-base-ready.png', sha256: '3'.repeat(64) }],
  cleanup: {
    outcome: 'PASS',
    vmUnregistered: true,
    residualVmPathRemoved: true,
    credentialArtifactsRemoved: true,
  },
  outcome: 'PASS',
  failures: [],
};
const proof = { ...proofWithoutDigest, digest: sha256(JSON.stringify(proofWithoutDigest)) };
assert.equal(validateGoldenBaseProof(proof, { metadataText, vagrantfileText: vagrantfile }).ok, true, 'valid golden proof must pass');
assert.equal(
  validateGoldenBaseProof({ ...proof, graphicalLoginPerformed: true }, { metadataText, vagrantfileText: vagrantfile }).ok,
  false,
  'graphical-login proof must fail closed',
);
assert.equal(
  validateGoldenBaseProof({ ...proof, digest: '4'.repeat(64) }, { metadataText, vagrantfileText: vagrantfile }).ok,
  false,
  'tampered proof digest must fail closed',
);

for (const marker of [
  'Assert-BaseBootstrapReceiptForPackage',
  'base bootstrap receipt validation failed; package is blocked',
  'baseBootstrapReceipt',
  'golden-production-package@2',
  'vagrantfileSha256',
  'metadataSha256',
]) {
  assert.ok(activationCycle.includes(marker), `golden activation cycle must include ${marker}`);
}
const packageCase = activationCycle.indexOf("'Package' {");
const baseGuard = activationCycle.indexOf('$baseBootstrap = Assert-BaseBootstrapReceiptForPackage', packageCase);
const removeExistingBox = activationCycle.indexOf('Remove-Item -LiteralPath $ProductionBoxPath -Force', packageCase);
const haltGuest = activationCycle.indexOf("Invoke-Vagrant -Arguments @('halt', $Vm)", packageCase);
assert.ok(packageCase >= 0 && baseGuard > packageCase, 'package mode must invoke the base receipt guard');
assert.ok(baseGuard < removeExistingBox && baseGuard < haltGuest, 'base receipt guard must run before box deletion or VM halt');

console.log('ubuntu-golden-box tests: PASS');
