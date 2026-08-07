import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCHEMA } from './vagrant-box-proof-core.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'lba-vagrant-box-proof-'));
const verifier = path.join(import.meta.dirname, 'verify-vagrant-box-proof.mjs');
const hash = (file) => createHash('sha256').update(file).digest('hex');
try {
  const packagePath = path.join(root, 'actor.box');
  const evidencePath = path.join(root, 'capture.json');
  const receiptPath = path.join(root, 'proof.json');
  writeFileSync(packagePath, 'package');
  writeFileSync(evidencePath, '{"outcome":"passed"}\n');
  const receipt = {
    schema: SCHEMA,
    outcome: 'passed',
    package: {
      name: 'actor/win11-labview2026',
      provider: 'virtualbox',
      path: packagePath,
      size: statSync(packagePath).size,
      sha256: hash('package'),
    },
    registration: {
      name: 'actor/win11-labview2026',
      provider: 'virtualbox',
      persistentVagrantHome: 'D:\\vagrant-home',
      consumerVagrantHome: 'D:\\lba-vagrant-proof\\selftest',
      providerUuid: '11111111-1111-1111-1111-111111111111',
      providerUuidOwnership: 'run-owned',
      exactPackageAdded: true,
      exactPackageSha256: hash('package'),
      addInvocation: {
        command: 'vagrant',
        args: ['box', 'add', '--provider', 'virtualbox', packagePath],
      },
      upInvocation: {
        command: 'vagrant',
        args: ['up', 'default', '--provider', 'virtualbox', '--no-provision'],
        noProvision: true,
      },
    },
    evidence: [{
      path: evidencePath,
      size: statSync(evidencePath).size,
      sha256: hash('{"outcome":"passed"}\n'),
    }],
    proof: {
      winrm: { authenticated: true },
      desktop: {
        interactive: true,
        windowStation: 'WinSta0',
        desktop: 'Default',
        monitorRectangles: [{ left: 0, top: 0, right: 1024, bottom: 768 }],
      },
      labview: { installed: true, activated: true },
      capture: {
        rfb: { authenticated: true, loopbackOnly: true, boundAddress: '127.0.0.1' },
        mprr: {
          passed: true,
          launchMs: 100,
          settleMs: 200,
          resourceSamples: [{ ms: 1, cpuPct: 1, ramMb: 512 }],
        },
      },
      sourceVm: {
        activated: true,
        preserved: true,
        configSha256Before: 'a'.repeat(64),
        configSha256After: 'a'.repeat(64),
      },
      cleanup: {
        runOwnedVmAbsent: true,
        natListenerAbsent: true,
        vncListenerAbsent: true,
        secretsRemoved: true,
        localDotfileRemoved: true,
        consumerVagrantHomeRemoved: true,
        lifecycleLockRemoved: true,
      },
    },
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  let result = spawnSync(process.execPath, [verifier, '--verify', receiptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'passed');

  writeFileSync(evidencePath, '{"outcome":"tampered"}\n');
  result = spawnSync(process.execPath, [verifier, '--verify', receiptPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'tampered evidence must fail verification');

  console.log('Vagrant box proof verifier self-test: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
