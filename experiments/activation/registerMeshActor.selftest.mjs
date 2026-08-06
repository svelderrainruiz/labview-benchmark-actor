// Self-test for registerMeshActor.mjs -- mesh-actor registration gated on activation (LBA-REQ-039,
// realizes the ADR-0023 invariant: confirm activation BEFORE registering the VM as a mesh actor).
// Proves (a) the committed REAL activated receipt registers a golden mesh row, (b) registration is
// idempotent (re-register replaces, never duplicates), and (c) it FAILS CLOSED -- an unactivated or
// tampered receipt is REFUSED and leaves the registry untouched.
// Run: node registerMeshActor.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildActivationReceipt } from './buildActivationReceipt.mjs';
import { describeActivationEvidence, registerGoldenActor, REGISTRY_HEADER } from './registerMeshActor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'activation-receipt.json'), 'utf8'));
const capture = JSON.parse(readFileSync(join(here, 'fixtures', 'activation-capture.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

const goldenRows = (csv) => csv.split(/\r?\n/).filter((l) => l.startsWith('golden,'));

// 1. an ACTIVATED receipt registers exactly one golden mesh-actor row
{
  const r = registerGoldenActor({ receipt, registry: '' });
  assert.ok(r.ok && !r.refused, `expected registration to succeed; findings: ${r.findings.join('; ')}`);
  assert.ok(r.csv.includes(REGISTRY_HEADER), 'writes the registry header');
  assert.equal(goldenRows(r.csv).length, 1, 'exactly one golden row');
  assert.match(r.csv, /^golden,golden,actor,actor,192\.168\.56\.10,7420,7421,both,AGENT_GENERATED$/m, 'golden row matches the schema with the placeholder password');
  ok('activated receipt registers the golden VM as a mesh actor');
}

// 2. idempotent: re-registering replaces the golden row, never duplicates; preserves mesh rows
{
  const seed = `${REGISTRY_HEADER}\ngolden,golden,actor,actor,192.168.56.10,7420,7421,both,OLD\nmesh,1,actor1,actor,192.168.56.11,7420,7421,both,AGENT_GENERATED`;
  const r = registerGoldenActor({ receipt, registry: seed });
  assert.equal(goldenRows(r.csv).length, 1, 're-registration does not duplicate the golden row');
  assert.ok(r.csv.includes('mesh,1,actor1'), 'existing mesh rows are preserved');
  assert.ok(!r.csv.includes(',OLD'), 'the stale golden row is replaced');
  ok('registration is idempotent (replace golden, preserve mesh rows)');
}

// 3. fail-closed: an unactivated receipt is REFUSED and leaves the registry untouched
{
  const denied = JSON.parse(JSON.stringify(receipt));
  denied.result.exitCode = 1;
  denied.verdict.activated = false;
  const seed = `${REGISTRY_HEADER}\nmesh,1,actor1,actor,192.168.56.11,7420,7421,both,AGENT_GENERATED`;
  const r = registerGoldenActor({ receipt: denied, registry: seed });
  assert.equal(r.ok, false, 'an unactivated receipt must be refused');
  assert.equal(r.refused, true, 'registration is refused');
  assert.equal(r.csv, seed, 'the registry is left untouched');
  assert.ok(r.findings.some((f) => /activation not confirmed/i.test(f)), 'explains the refusal');
  ok('fail-closed: unactivated receipt is refused, registry untouched');
}

// 4. fail-closed: a tampered (digest-broken) receipt is refused
{
  const tampered = { ...receipt, digest: '0'.repeat(64) };
  const r = registerGoldenActor({ receipt: tampered, registry: '' });
  assert.equal(r.ok, false, 'a tampered receipt must be refused');
  ok('fail-closed: tampered receipt is refused');
}

// 5. Evidence outcomes distinguish a crash from ordinary unconfirmed activation and stay non-enrollable.
{
  const crashed = buildActivationReceipt({ ...capture, exitCode: 139 });
  const guidance = describeActivationEvidence(crashed);
  assert.equal(guidance.eligible, false, 'a crashed probe cannot enroll an actor');
  assert.equal(guidance.status, 'probe-crashed', 'a crash gets distinct actionable guidance');
  assert.match(guidance.nextStep, /Do not enroll or retry automatically/, 'guidance prevents unsafe retry behavior');
  ok('crashed probes are distinct, actionable, and non-enrollable');
}

// 6. CLI: a valid receipt writes the local registry, while no password option is accepted.
{
  const temp = mkdtempSync(join(tmpdir(), 'lba-register-'));
  const receiptPath = join(temp, 'activation-receipt.json');
  const registryPath = join(temp, 'mesh-actors.csv');
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  try {
    const run = spawnSync(process.execPath, [join(here, 'registerMeshActor.mjs'), '--receipt', receiptPath, '--registry', registryPath], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(registryPath, 'utf8'), /^golden,golden,actor,actor,192\.168\.56\.10,7420,7421,both,AGENT_GENERATED$/m);
    const noPassword = spawnSync(process.execPath, [join(here, 'registerMeshActor.mjs'), '--receipt', receiptPath, '--registry', registryPath, '--password', 'NOT_A_SECRET'], { encoding: 'utf8' });
    assert.equal(noPassword.status, 2, 'the enrollment CLI rejects password arguments');
    ok('CLI registers only from a valid receipt and never accepts a password');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// 7. CLI: an unconfirmed receipt preserves the existing registry byte-for-byte.
{
  const temp = mkdtempSync(join(tmpdir(), 'lba-register-refuse-'));
  const receiptPath = join(temp, 'unconfirmed.json');
  const registryPath = join(temp, 'mesh-actors.csv');
  const unconfirmed = buildActivationReceipt({ ...capture, exitCode: 1 });
  const seed = `${REGISTRY_HEADER}\nmesh,1,actor1,actor,192.168.56.11,7420,7421,both,AGENT_GENERATED\n`;
  writeFileSync(receiptPath, `${JSON.stringify(unconfirmed)}\n`);
  writeFileSync(registryPath, seed);
  try {
    const run = spawnSync(process.execPath, [join(here, 'registerMeshActor.mjs'), '--receipt', receiptPath, '--registry', registryPath], { encoding: 'utf8' });
    assert.equal(run.status, 1, 'unconfirmed activation is refused by the CLI');
    assert.equal(readFileSync(registryPath, 'utf8'), seed, 'refusal leaves the local registry untouched');
    assert.match(run.stderr, /Complete the user-only LabVIEW\/VIPM activation/, 'refusal names the next safe step');
    ok('CLI refusal preserves the registry and explains the human activation next step');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

console.log(`\nregisterMeshActor.selftest: ${passed}/${passed} checks passed`);
