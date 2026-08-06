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
import { describeActivationEvidence, enrollCurrentGoldenActor, parseCurrentGuestIdentity, readCurrentGuestIdentity, registerGoldenActor, REGISTRY_HEADER, verifyCurrentGuestIdentity } from './registerMeshActor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'activation-receipt.json'), 'utf8'));
const capture = JSON.parse(readFileSync(join(here, 'fixtures', 'activation-capture.json'), 'utf8'));
const actorIdentity = { actorId: 'golden', hostname: 'actor', ip: '192.168.56.10' };
const bootId = '11111111-2222-3333-4444-555555555555';
const activationChallenge = '0123456789abcdef0123456789abcdef';
const boundReceipt = buildActivationReceipt({ ...capture, host: { ...capture.host, bootId }, actor: actorIdentity, freshness: { challenge: activationChallenge } });
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

const goldenRows = (csv) => csv.split(/\r?\n/).filter((l) => l.startsWith('golden,'));

const currentGuestOutput = `bootId=${bootId}\nhostname=actor\nips=192.168.198.180 192.168.56.10\nactivationChallenge=${activationChallenge}\n`;
const currentGuestRun = (command, args, options) => {
  assert.equal(command, 'vagrant');
  assert.deepEqual(args.slice(0, 3), ['ssh', 'actor1', '-c']);
  assert.equal(options.cwd, '/test/mesh');
  return currentGuestOutput;
};

// 1. an ACTIVATED receipt registers exactly one golden mesh-actor row
{
  const r = registerGoldenActor({ receipt: boundReceipt, registry: '' });
  assert.ok(r.ok && !r.refused, `expected registration to succeed; findings: ${r.findings.join('; ')}`);
  assert.ok(r.csv.includes(REGISTRY_HEADER), 'writes the registry header');
  assert.equal(goldenRows(r.csv).length, 1, 'exactly one golden row');
  assert.match(r.csv, /^golden,golden,actor,actor,192\.168\.56\.10,7420,7421,both,AGENT_GENERATED$/m, 'golden row matches the schema with the placeholder password');
  ok('activated receipt registers the golden VM as a mesh actor');
}

// 2. idempotent: re-registering replaces the golden row, never duplicates; preserves mesh rows
{
  const seed = `${REGISTRY_HEADER}\ngolden,golden,actor,actor,192.168.56.10,7420,7421,both,OLD\nmesh,1,actor1,actor,192.168.56.11,7420,7421,both,AGENT_GENERATED`;
  const r = registerGoldenActor({ receipt: boundReceipt, registry: seed });
  assert.equal(goldenRows(r.csv).length, 1, 're-registration does not duplicate the golden row');
  assert.ok(r.csv.includes('mesh,1,actor1'), 'existing mesh rows are preserved');
  assert.ok(!r.csv.includes(',OLD'), 'the stale golden row is replaced');
  ok('registration is idempotent (replace golden, preserve mesh rows)');
}

// 3. fail-closed: an unactivated receipt is REFUSED and leaves the registry untouched
{
  const denied = buildActivationReceipt({ ...capture, actor: actorIdentity, exitCode: 1 });
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
  const tampered = { ...boundReceipt, digest: '0'.repeat(64) };
  const r = registerGoldenActor({ receipt: tampered, registry: '' });
  assert.equal(r.ok, false, 'a tampered receipt must be refused');
  ok('fail-closed: tampered receipt is refused');
}

// 5. Evidence outcomes distinguish a crash from ordinary unconfirmed activation and stay non-enrollable.
{
  const crashed = buildActivationReceipt({ ...capture, actor: actorIdentity, exitCode: 139 });
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
  writeFileSync(receiptPath, `${JSON.stringify(boundReceipt)}\n`);
  try {
    const result = enrollCurrentGoldenActor({ receipt: boundReceipt, registry: '', vm: 'actor1', vagrantRoot: '/test/mesh', run: currentGuestRun });
    assert.equal(result.ok, true, result.findings.join('; '));
    assert.match(result.csv, /^golden,golden,actor,actor,192\.168\.56\.10,7420,7421,both,AGENT_GENERATED$/m);
    const noVm = spawnSync(process.execPath, [join(here, 'registerMeshActor.mjs'), '--receipt', receiptPath, '--registry', registryPath], { encoding: 'utf8' });
    assert.equal(noVm.status, 2, 'the enrollment CLI requires a Vagrant VM challenge');
    const noPassword = spawnSync(process.execPath, [join(here, 'registerMeshActor.mjs'), '--receipt', receiptPath, '--registry', registryPath, '--vm', 'actor1', '--password', 'NOT_A_SECRET'], { encoding: 'utf8' });
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
  const unconfirmed = buildActivationReceipt({ ...capture, host: { ...capture.host, bootId }, actor: actorIdentity, exitCode: 1 });
  const seed = `${REGISTRY_HEADER}\nmesh,1,actor1,actor,192.168.56.11,7420,7421,both,AGENT_GENERATED\n`;
  writeFileSync(receiptPath, `${JSON.stringify(unconfirmed)}\n`);
  writeFileSync(registryPath, seed);
  try {
    const result = enrollCurrentGoldenActor({ receipt: unconfirmed, registry: seed, vm: 'actor1', vagrantRoot: '/test/mesh', run: currentGuestRun });
    assert.equal(result.ok, false, 'unconfirmed activation is refused before a current guest check can enroll it');
    assert.equal(result.csv, seed, 'refusal leaves the local registry untouched');
    assert.match(result.findings.join('; '), /Complete the user-only LabVIEW\/VIPM activation/, 'refusal names the next safe step');
    ok('CLI refusal preserves the registry and explains the human activation next step');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// 8. Enrollment cannot substitute a different identity or a mesh role for the identity bound by the probe.
{
  const seed = `${REGISTRY_HEADER}\nmesh,1,actor1,actor,192.168.56.11,7420,7421,both,AGENT_GENERATED\n`;
  const wrongIdentity = registerGoldenActor({ receipt: boundReceipt, registry: seed, actor: { ip: '192.168.56.99' } });
  assert.equal(wrongIdentity.ok, false, 'a different requested IP is refused');
  assert.equal(wrongIdentity.csv, seed, 'identity refusal leaves the registry untouched');
  const wrongRole = registerGoldenActor({ receipt: boundReceipt, registry: seed, actor: { role: 'mesh', actor_id: '1', hostname: 'actor1', ip: '192.168.56.11' } });
  assert.equal(wrongRole.ok, false, 'mesh rows cannot be registered through the golden flow');
  ok('receipt identity and the golden-only role are both enforced');
}

// 9. A verified Vagrant target identity becomes the golden row endpoint without caller-controlled overrides.
{
  const targetIdentity = { actorId: 'golden', hostname: 'actor1', ip: '192.168.56.11' };
  const targetReceipt = buildActivationReceipt({ ...capture, host: { ...capture.host, bootId }, actor: targetIdentity });
  const result = registerGoldenActor({ receipt: targetReceipt, registry: '' });
  assert.equal(result.ok, true, result.findings.join('; '));
  assert.equal(result.row.hostname, 'actor1');
  assert.equal(result.row.ip, '192.168.56.11');
  assert.match(result.csv, /^golden,golden,actor1,actor,192\.168\.56\.11,7420,7421,both,AGENT_GENERATED$/m);
  ok('verified target identity supplies the golden registry endpoint');
}

// 10. Registration challenges the current Vagrant guest boot, hostname, host-only IP, and activation challenge.
{
  const guest = parseCurrentGuestIdentity(currentGuestOutput);
  assert.equal(verifyCurrentGuestIdentity({ receipt: boundReceipt, guest }).ok, true, 'matching current guest accepts the receipt');
  const restarted = { ...guest, bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  const result = verifyCurrentGuestIdentity({ receipt: boundReceipt, guest: restarted });
  assert.equal(result.ok, false, 'a reverted or recreated guest boot is rejected');
  assert.match(result.findings.join('; '), /boot ID/, 'the refusal requires a fresh confirmation');
  const restoredSnapshot = { ...guest, activationChallenge: '' };
  const replay = verifyCurrentGuestIdentity({ receipt: boundReceipt, guest: restoredSnapshot });
  assert.equal(replay.ok, false, 'a pre-confirmation snapshot without the persisted challenge is rejected');
  assert.match(replay.findings.join('; '), /activation challenge/, 'the refusal requires a fresh confirmation');
  ok('current guest challenge rejects replayed activation evidence after snapshot restore');
}

// 11. CLI refuses an activation receipt when the selected current guest was recreated or reverted.
{
  const temp = mkdtempSync(join(tmpdir(), 'lba-register-stale-'));
  const receiptPath = join(temp, 'activation-receipt.json');
  const registryPath = join(temp, 'mesh-actors.csv');
  writeFileSync(receiptPath, `${JSON.stringify(boundReceipt)}\n`);
  try {
    const staleRun = () => `bootId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nhostname=actor\nips=192.168.198.180 192.168.56.10\nactivationChallenge=${activationChallenge}\n`;
    const result = enrollCurrentGoldenActor({ receipt: boundReceipt, registry: '', vm: 'actor1', vagrantRoot: '/test/mesh', run: staleRun });
    assert.equal(result.ok, false, 'the boot-ID mismatch is refused before the registry is written');
    assert.equal(result.csv, '', 'stale confirmation leaves no registry mutation');
    assert.match(result.findings.join('; '), /boot ID does not match/, 'refusal requests a fresh confirmation');
    ok('CLI refuses a replayed receipt after the selected guest boot changes');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// 12. CSV serializers reject delimiter injection and malformed local overrides before writing a registry.
{
  const seed = `${REGISTRY_HEADER}\nmesh,1,actor1,actor,192.168.56.11,7420,7421,both,AGENT_GENERATED\n`;
  const comma = registerGoldenActor({ receipt: boundReceipt, registry: seed, actor: { username: 'actor,extra' } });
  assert.equal(comma.ok, false, 'a comma in an override is refused');
  assert.equal(comma.csv, seed, 'a comma override leaves the registry unchanged');
  const newline = registerGoldenActor({ receipt: boundReceipt, registry: seed, actor: { username: 'actor\nmesh,2' } });
  assert.equal(newline.ok, false, 'a newline in an override is refused');
  assert.equal(newline.csv, seed, 'a newline override leaves the registry unchanged');
  const missingFreshness = buildActivationReceipt({ ...capture, host: { ...capture.host, bootId }, actor: actorIdentity });
  const stale = enrollCurrentGoldenActor({ receipt: missingFreshness, registry: seed, vm: 'actor1', vagrantRoot: '/test/mesh', run: currentGuestRun });
  assert.equal(stale.ok, false, 'legacy evidence without a post-confirmation challenge cannot enroll');
  assert.match(stale.findings.join('; '), /snapshot-resistant activation challenge/, 'missing freshness names the safe next step');
  ok('CSV overrides and legacy evidence are fail-closed before registry mutation');
}

console.log(`\nregisterMeshActor.selftest: ${passed}/${passed} checks passed`);
