// Self-test for buildActivationReceipt.mjs -- the LabVIEW activation-confirmation contract (LBA-REQ-038,
// realizes ADR-0023 Phase 1). Proves (a) the committed REAL capture deterministically rebuilds the committed
// receipt (offline replay -- no LabVIEW in CI), (b) the committed receipt validates as ACTIVATED, and
// (c) the confirmation is a genuine functional check that FAILS CLOSED -- a non-zero exit, the wrong
// known-answer value, a missing success line, a tampered digest, or a contradicted verdict all deny
// activation. Run: node buildActivationReceipt.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildActivationReceipt, validateActivationReceipt, parseProbeOutput, digestReceipt, RECEIPT_SCHEMA,
} from './buildActivationReceipt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const capture = JSON.parse(readFileSync(join(here, 'fixtures', 'activation-capture.json'), 'utf8'));
const committed = JSON.parse(readFileSync(join(here, 'fixtures', 'activation-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 1. the REAL committed capture deterministically rebuilds the committed receipt (offline replay)
{
  const rebuilt = buildActivationReceipt(capture);
  assert.equal(rebuilt.schema, RECEIPT_SCHEMA, 'schema is activation-receipt@1');
  assert.deepEqual(rebuilt, committed, 'rebuilding the receipt from the committed capture is byte-stable');
  assert.equal(rebuilt.digest, digestReceipt(committed), 'digest is reproducible from the verdict-bearing fields');
  ok(`deterministic offline replay: capture -> receipt (digest ${rebuilt.digest.slice(0, 12)}…)`);
}

// 2. the committed receipt is a REAL activation confirmation (LabVIEW 2026 returned the known answer)
{
  const v = validateActivationReceipt(committed);
  assert.ok(v.ok && v.activated, `expected ACTIVATED; findings: ${v.findings.join('; ')}`);
  assert.equal(committed.result.parsedOutput, committed.probe.expectedOutput, 'the probe returned the known answer');
  assert.equal(committed.result.exitCode, 0, 'RunVI exited cleanly');
  assert.equal(committed.host.labviewVersion, '2026', 'confirmed on LabVIEW 2026');
  ok(`committed receipt confirms activation: ${committed.probe.inputs.join(' + ')} = ${committed.result.parsedOutput} on LabVIEW ${committed.host.labviewVersion}`);
}

// 3. parseProbeOutput extracts the numeric output + success + version from the real CLI stdout
{
  const p = parseProbeOutput(capture.output);
  assert.equal(p.parsedOutput, capture.expectedOutput, 'parses the numeric Operation output');
  assert.equal(p.operationSucceeded, true, 'detects "RunVI operation succeeded."');
  assert.equal(p.labviewVersion, '2026', 'parses the LabVIEW version');
  ok('parseProbeOutput reads the real RunVI stdout (value + success + version)');
}

// 4. fail-closed: each way an install can be un-activated denies the verdict
{
  const bad = [
    { name: 'non-zero exit', mut: (c) => ({ ...c, exitCode: 1 }) },
    { name: 'wrong known-answer value', mut: (c) => ({ ...c, output: c.output.replace('\n42\n', '\n41\n') }) },
    { name: 'missing success line', mut: (c) => ({ ...c, output: c.output.replace('RunVI operation succeeded.', 'RunVI operation FAILED.') }) },
  ];
  for (const { name, mut } of bad) {
    const r = buildActivationReceipt(mut(capture));
    assert.equal(r.verdict.activated, false, `must DENY activation on: ${name}`);
    const v = validateActivationReceipt(r);
    assert.equal(v.activated, false, `validation denies activation on: ${name}`);
  }
  ok('fail-closed: non-zero exit / wrong value / missing success line all DENY activation');
}

// 5. fail-closed: a tampered digest or a contradicted verdict is rejected by validation
{
  const tamperedDigest = { ...committed, digest: '0'.repeat(64) };
  assert.equal(validateActivationReceipt(tamperedDigest).ok, false, 'a tampered digest is rejected');
  const forged = JSON.parse(JSON.stringify(committed));
  forged.result.exitCode = 1;                 // make the result bad but keep verdict.activated = true
  const v = validateActivationReceipt(forged);
  assert.equal(v.ok, false, 'a verdict contradicting the result rule is rejected');
  assert.ok(v.findings.some((f) => /contradicts the rule|digest/.test(f)), 'names the contradiction / digest tamper');
  ok('fail-closed: tampered digest and forged verdict are both rejected');
}

// 6. The CLI writes the same receipt and gives a non-zero status for an unconfirmed probe.
{
  const temp = mkdtempSync(join(tmpdir(), 'lba-activation-cli-'));
  try {
    const output = join(temp, 'receipt.json');
    const run = spawnSync(process.execPath, [join(here, 'buildActivationReceipt.mjs'), join(here, 'fixtures', 'activation-capture.json'), output], { encoding: 'utf8' });
    assert.equal(run.status, 0, `activation receipt CLI succeeds for a valid capture: ${run.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), committed, 'activation receipt CLI writes the deterministic receipt');
    const validate = spawnSync(process.execPath, [join(here, 'buildActivationReceipt.mjs'), '--validate', output], { encoding: 'utf8' });
    assert.equal(validate.status, 0, `activation receipt validation CLI accepts an activated receipt: ${validate.stderr}`);
    const unconfirmed = join(temp, 'unconfirmed.json');
    writeFileSync(unconfirmed, `${JSON.stringify(buildActivationReceipt({ ...capture, exitCode: 1 }))}\n`);
    const reject = spawnSync(process.execPath, [join(here, 'buildActivationReceipt.mjs'), '--validate', unconfirmed], { encoding: 'utf8' });
    assert.equal(reject.status, 1, 'activation receipt validation CLI refuses an unconfirmed receipt');
    ok('activation receipt CLI writes the same deterministic receipt from a valid capture');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// 7. Public actor identity is digest-bound when supplied, while malformed receipt objects fail closed.
{
  const bound = buildActivationReceipt({ ...capture, actor: { actorId: 'golden', hostname: 'actor', ip: '192.168.56.10' } });
  assert.deepEqual(bound.actor, { actorId: 'golden', hostname: 'actor', ip: '192.168.56.10' });
  assert.ok(validateActivationReceipt(bound).ok, 'a bound public actor identity validates');
  const tamperedActor = { ...bound, actor: { ...bound.actor, ip: '192.168.56.99' } };
  assert.equal(validateActivationReceipt(tamperedActor).ok, false, 'changing the bound actor identity breaks the digest');
  const malformed = { probe: bound.probe, result: bound.result, verdict: bound.verdict, digest: bound.digest };
  assert.doesNotThrow(() => validateActivationReceipt(malformed), 'missing digest-bearing objects never throw');
  assert.equal(validateActivationReceipt(malformed).ok, false, 'a structurally incomplete receipt is invalid evidence');
  const probeScript = readFileSync(join(here, 'probe-activation.sh'), 'utf8');
  const python = probeScript.match(/<<'PY'\n([\s\S]*?)\nPY\n/)?.[1] ?? '';
  assert.match(python, /^actor_fields = \{/m, 'actor identity capture begins at Python top level');
  assert.doesNotMatch(python, /^\s+actor_fields = \{/m, 'actor identity capture is not accidentally indented');
  assert.match(python, /actual_hostname = socket\.gethostname\(\)/, 'actor hostname is measured from the probed guest');
  assert.match(python, /actor_fields\["hostname"\] != actual_hostname/, 'requested hostname is verified against the probed guest');
  assert.match(python, /actor_fields\["ip"\] not in actual_ips/, 'requested IP is verified against guest interfaces');
  assert.match(python, /record\["freshness"\] = \{"challenge": activation_challenge\}/, 'a persisted host challenge is included in the raw capture');
  assert.match(probeScript, /LBA_ACTIVATION_CHALLENGE must be 32 lowercase hexadecimal characters/, 'the probe validates the host challenge format');
  assert.match(probeScript, /\/var\/lib\/lba-golden-activation\/challenge/, 'a successful probe persists the challenge outside the pre-activation snapshot');
  ok('actor identity is digest-bound and malformed receipt structures fail closed');
}

// 8. A guest boot ID is normalized, digest-bound, and format-validated when the probe supplies it.
{
  const bootId = '11111111-2222-3333-4444-555555555555';
  const bound = buildActivationReceipt({ ...capture, host: { ...capture.host, bootId } });
  assert.equal(bound.host.bootId, bootId, 'preserves the guest boot ID');
  assert.ok(validateActivationReceipt(bound).ok, 'a UUID boot ID validates');
  const tampered = { ...bound, host: { ...bound.host, bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } };
  assert.equal(validateActivationReceipt(tampered).ok, false, 'boot ID changes break the digest');
  const malformed = { ...bound, host: { ...bound.host, bootId: 'not-a-boot-id' } };
  malformed.digest = digestReceipt(malformed);
  assert.equal(validateActivationReceipt(malformed).ok, false, 'a malformed boot ID is rejected even if resealed');
  ok('guest boot identity is digest-bound and format-validated');
}

// 9. A post-confirmation host challenge is digest-bound and rejects malformed or tampered values.
{
  const challenge = '0123456789abcdef0123456789abcdef';
  const fresh = buildActivationReceipt({ ...capture, freshness: { challenge } });
  assert.equal(fresh.freshness.challenge, challenge, 'preserves the host-generated challenge');
  assert.ok(validateActivationReceipt(fresh).ok, 'a valid freshness challenge validates');
  const tampered = { ...fresh, freshness: { challenge: 'fedcba9876543210fedcba9876543210' } };
  assert.equal(validateActivationReceipt(tampered).ok, false, 'changing the challenge breaks the digest');
  const malformed = { ...fresh, freshness: { challenge: 'not-a-challenge' } };
  malformed.digest = digestReceipt(malformed);
  assert.equal(validateActivationReceipt(malformed).ok, false, 'a malformed challenge is rejected even if resealed');
  ok('post-confirmation host challenges are digest-bound and format-validated');
}

console.log(`\nbuildActivationReceipt.selftest: ${passed}/${passed} checks passed`);
