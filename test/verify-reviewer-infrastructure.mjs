import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  buildReviewerVerdict, generateEnrolledKeypair, signReviewerVerdict,
} from '../experiments/handoff-beacon/reviewerVerdict.mjs';
import { parseUniqueJson, readJson, verifyReviewerInfrastructure as verify } from '../scripts/verify-reviewer-infrastructure.mjs';

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

test('accepts only stable versions without leading zeros', () => {
  for (const v of ['1.6.7-rc.1', '1.6.7+build', '01.6.7', '1.6.7\n']) {
    assert.throws(() => verify({ version: v, components: { extension: v } }), /requested X.Y.Z candidate version/);
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
  ['a range containing the candidate', { validFrom: '1.6.0', validThrough: '1.7.0' }],
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

test('rejects an enrolled EC key labelled ed25519', () => {
  const f = fixture();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const record = agreementRelease(f).visualReview;
  record.signOff = signReviewerVerdict(record.verdict, { privateKeyPem, reviewer });
  f.allowlist[reviewer][0].publicKeyPem = publicKeyPem;
  assert.throws(() => verify(f), /sign-off public key must be ed25519/);
});

test('rejects duplicate receiptSha256 in a raw file', () => {
  assert.throws(() => readJson('test/fixtures/reviewer-infrastructure-duplicate.json'), /duplicate JSON member "receiptSha256"/);
});

test('rejects duplicate JSON names at any depth including escaped spellings', () => {
  for (const text of [
    '{"x":1,"x":2}',
    '{"verdict":{"evidence":[{"ref":"a","ref":"b"}]}}',
    '{"x":1,"\\u0078":2}',
    '{"":1,"":2}',
  ]) assert.throws(() => parseUniqueJson(text), /duplicate JSON member/);
  for (const text of [
    '{"a":[{"ref":"a"},{"ref":"b"}],"b":{"ref":"c"}}',
    '{"quoted\\\"name":"braces {}, comma, colon: and escaped slash \\\\","other":null}',
    '[true,false,null,1,-0.2e3,"text"]',
  ]) assert.deepEqual(parseUniqueJson(text), JSON.parse(text));
  assert.throws(() => parseUniqueJson('{"x":}'), SyntaxError);
});

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
function preflightSource() {
  const source = read('../scripts/lba.mjs');
  const start = source.indexOf("  'release-preflight': {");
  const end = source.indexOf('\n  release: {', start);
  assert.ok(start >= 0 && end > start, 'bound the actual pre-flight command only');
  return source.slice(start, end);
}

test('pre-flight and agreement job run the same verifier for the requested version', () => {
  const cli = preflightSource();
  assert.match(cli, /\['reviewer infrastructure record', 'scripts\/verify-reviewer-infrastructure\.mjs'\]/);
  assert.match(cli, /execFileSync\(process\.execPath, \[join\(repoRoot, rel\), '--component', 'extension', version\]/);
  const workflow = read('../.github/workflows/extension-release.yml');
  const job = workflow.split('\n  agreement:\n')[1].split('\n  release:\n')[0];
  assert.match(job, /VERSION: \$\{\{ steps\.ver\.outputs\.version \}\}\s+run: node scripts\/verify-reviewer-infrastructure\.mjs --component extension "\$VERSION"/);
  assert.match(workflow, /\n  release:\n    needs: \[build, agreement\]/);
});

test('pre-flight exits nonzero when only the infrastructure verifier fails', () => {
  for (const fails of [false, true]) {
    const calls = [];
    const exits = [];
    const commands = runInNewContext(`({${preflightSource()}})`, {
      releasePreflightStatic: () => [],
      read: () => JSON.stringify({ version, candidate: { version } }),
      repoRoot: '.', join: (...parts) => parts.join('/'),
      execFileSync: (_node, args) => {
        calls.push(args);
        if (fails && args[0].endsWith('/verify-reviewer-infrastructure.mjs')) throw new Error('fixture gate failure');
      },
      discoverSigningStation: () => ({}), readReviewerAllowlist: () => ({}),
      signingStatus: () => ({ ok: true, station: 'UNKNOWN' }),
      STATIONS: { UNKNOWN: 'UNKNOWN' },
      console: { log() {}, error() {} },
      process: { execPath: 'node', version: 'v24.19.0', exit: code => exits.push(code) },
    });
    commands['release-preflight'].run([version]);
    assert.equal(calls.length, 4);
    assert.equal(calls.filter(args => args[0].endsWith('/verify-reviewer-infrastructure.mjs')).length, 1);
    assert.deepEqual(exits, fails ? [1] : []);
  }
});

function runBodies(workflow) {
  const lines = workflow.split('\n');
  return lines.flatMap((line, i) => {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!match) return [];
    if (!/^[|>][-+]?$/.test(match[2])) return [match[2]];
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= match[1].length) break;
      body.push(lines[j].slice(match[1].length + 2));
    }
    return [body.join('\n')];
  });
}

test('release workflow never interpolates expressions into run bodies', () => {
  const workflow = read('../.github/workflows/extension-release.yml');
  const bodies = runBodies(workflow);
  assert.ok(bodies.length > 10);
  for (const body of bodies) assert.doesNotMatch(body, /\$\{\{/);
  for (const expression of ['${{ inputs.version }}', '${{ github.event.inputs.version }}']) {
    for (const yaml of [`run: echo "${expression}"`, `run: |\n  echo "${expression}"`]) {
      assert.ok(runBodies(yaml).some(body => /\$\{\{/.test(body)));
    }
  }
  assert.equal((workflow.match(/- name: Derive version/g) || []).length, 1);
  assert.match(workflow, /DISPATCH_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(workflow, /VERSION: \$\{\{ needs\.agreement\.outputs\.version \}\}/);
});

test('release workflow derives one fully validated stable version', () => {
  const script = runBodies(read('../.github/workflows/extension-release.yml')).find(body => body.includes('DISPATCH_VERSION'));
  assert.ok(script);
  const scratch = mkdtempSync(join(tmpdir(), 'reviewer-version-'));
  const output = join(scratch, 'version-output');
  try {
    const run = (input, ref) => {
      rmSync(output, { force: true });
      const result = spawnSync('bash', ['-c', script], {
        cwd: scratch, encoding: 'utf8',
        env: { ...process.env, DISPATCH_VERSION: input, GITHUB_REF_NAME: ref, GITHUB_OUTPUT: 'version-output' },
      });
      assert.ifError(result.error);
      const written = existsSync(output) ? readFileSync(output, 'utf8').replaceAll('\r\n', '\n') : '';
      return { ...result, written };
    };
    for (const input of ['1.6.7', '1.6.10', '1.10.0', '1.6.7-rc.1', '01.6.7', '1.6.7\n2.0.0', '1.6.7; true']) {
      const result = run(input, 'feature');
      const good = ['1.6.7', '1.6.10', '1.10.0'].includes(input);
      assert.equal(result.status, good ? 0 : 1, result.stderr);
      assert.equal(result.written, good ? `version=${input}\n` : '');
    }
    const tag = run('', 'ext-v1.6.7');
    assert.equal(tag.status, 0, tag.stderr);
    assert.equal(tag.written, 'version=1.6.7\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
