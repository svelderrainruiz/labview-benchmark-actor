import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildReviewerVerdict, generateEnrolledKeypair, signReviewerVerdict,
} from '../experiments/handoff-beacon/reviewerVerdict.mjs';
import { verifyReviewerInfrastructure as verify } from '../scripts/verify-reviewer-infrastructure.mjs';

const version = '1.6.7';
const reviewer = 'test-signer';
const keys = generateEnrolledKeypair();
const receiptSha256 = 'a'.repeat(64);
const entry = { kind: 'reviewer-infrastructure-receipt-sha256', ref: receiptSha256 };
const candidate = { component: 'extension', version, commit: 'b'.repeat(40), vsixSha256: 'c'.repeat(64) };

function fixture(evidence = [entry], target = candidate) {
  const verdict = buildReviewerVerdict({ verdict: 'pass', reviewer, target, evidence });
  const record = { verdict, signOff: signReviewerVerdict(verdict, { ...keys, reviewer }) };
  const plane = { agreed: true, reviewedCommit: target.commit };
  const release = { signoffs: { WIN: { ...plane }, LINUX: { ...plane } }, visualReview: record };
  return {
    version,
    components: { extension: version, reviewerInfrastructure: { schema: 'reviewer-infrastructure@1', baseline: 'v0.1.0', receiptSha256 } },
    agreement: { components: { extension: { releases: { [version]: release } } } },
    composite: { candidate: { ...target }, visual: structuredClone(record) },
    allowlist: { [reviewer]: [{ publicKeyPem: keys.publicKeyPem, validFrom: version, validThrough: version, purposes: ['visual'] }] },
  };
}

test('accepts the signed digest alongside other evidence', () => {
  verify(fixture([{ kind: 'note', ref: 'sample' }, entry]));
});

test('permits a missing field before the first required release', () => {
  verify({ version: '1.6.6', components: { extension: '1.6.6' } });
});

test('rejects a missing field at the boundary and beyond', () => {
  for (const v of [version, '1.6.10', '1.10.0', '2.0.0']) {
    assert.throws(() => verify({ version: v, components: { extension: v } }), /reviewerInfrastructure is required/);
  }
});

for (const [name, patch, reason] of [
  ['extra key', { extra: 'unexpected' }, /exactly schema, baseline, receiptSha256/],
  ['bad schema', { schema: 'unknown' }, /reviewerInfrastructure\.schema/],
  ['bad baseline', { baseline: '0.1' }, /reviewerInfrastructure\.baseline/],
  ['short digest', { receiptSha256: 'a'.repeat(63) }, /reviewerInfrastructure\.receiptSha256/],
  ['upper-case digest', { receiptSha256: 'A'.repeat(64) }, /reviewerInfrastructure\.receiptSha256/],
  ['non-hex digest', { receiptSha256: 'g'.repeat(64) }, /reviewerInfrastructure\.receiptSha256/],
  ['non-string digest', { receiptSha256: [receiptSha256] }, /reviewerInfrastructure\.receiptSha256/],
]) {
  test(`rejects ${name}`, () => {
    const f = fixture();
    Object.assign(f.components.reviewerInfrastructure, patch);
    assert.throws(() => verify(f), reason);
  });
}

for (const [name, evidence, reason] of [
  ['missing evidence entry', [], /exactly one/],
  ['duplicate evidence entry', [entry, entry], /exactly one/],
  ['different evidence digest', [{ ...entry, ref: 'd'.repeat(64) }], /ref equal to receiptSha256/],
]) {
  test(`rejects ${name}`, () => assert.throws(() => verify(fixture(evidence)), reason));
}

const agreementRelease = f => f.agreement.components.extension.releases[version];
test('rejects a bad signature', () => {
  const f = fixture();
  agreementRelease(f).visualReview.signOff.signature = Buffer.alloc(64).toString('base64');
  assert.throws(() => verify(f), /signature does not verify/);
});

test('rejects evidence inserted after signing', () => {
  const f = fixture([]);
  agreementRelease(f).visualReview.verdict.evidence.push(entry);
  assert.throws(() => verify(f), /sign-off does not match this verdict/);
});

for (const [name, patch] of [
  ['another version', { validFrom: '1.6.8', validThrough: '1.6.8' }],
  ['another purpose', { purposes: ['quorum'] }],
]) {
  test(`rejects a key enrolled for ${name}`, () => {
    const f = fixture();
    Object.assign(f.allowlist[reviewer][0], patch);
    assert.throws(() => verify(f), /no visual key enrolled for version/);
  });
}

test('rejects unscoped legacy keys', () => {
  const f = fixture();
  f.allowlist[reviewer] = keys.publicKeyPem;
  assert.throws(() => verify(f), /no visual key enrolled for version/);
});

test('rejects a different composite candidate', () => {
  for (const field of Object.keys(candidate)) {
    const f = fixture();
    f.composite.candidate[field] = 'different';
    assert.throws(() => verify(f), /composite candidate must match/);
  }
});

test('rejects an agreement plane that reviewed a different candidate', () => {
  for (const plane of ['WIN', 'LINUX']) {
    const f = fixture();
    agreementRelease(f).signoffs[plane].reviewedCommit = 'e'.repeat(40);
    assert.throws(() => verify(f), /agreement reviewedCommit must match/);
  }
});

test('rejects an agreement verdict for a different release', () => {
  assert.throws(() => verify(fixture([entry], { ...candidate, version: '1.6.8' })), /agreement verdict must name the requested candidate/);
});

test('rejects a different signed verdict for the same candidate', () => {
  const f = fixture();
  f.composite.visual = fixture([entry, { kind: 'note', ref: 'other' }]).composite.visual;
  assert.throws(() => verify(f), /same signed visual verdict/);
});

test('pre-flight and agreement job run the same verifier for the requested version', () => {
  const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const cli = read('../scripts/lba.mjs').split("  'release-preflight': {")[1].split("\n  'release': {")[0];
  assert.match(cli, /\['reviewer infrastructure record', 'scripts\/verify-reviewer-infrastructure\.mjs'\]/);
  assert.match(cli, /execFileSync\(process\.execPath, \[join\(repoRoot, rel\), '--component', 'extension', version\]/);
  const workflow = read('../.github/workflows/extension-release.yml');
  const job = workflow.split('\n  agreement:\n')[1].split('\n  release:\n')[0];
  assert.match(job, /VERSION: \$\{\{ steps\.ver\.outputs\.version \}\}\s+run: node scripts\/verify-reviewer-infrastructure\.mjs --component extension "\$VERSION"/);
  assert.match(workflow, /\n  release:\n    needs: \[build, agreement\]/);
});
