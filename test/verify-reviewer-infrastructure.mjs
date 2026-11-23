import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  buildReviewerVerdict, generateEnrolledKeypair, signReviewerVerdict,
} from '../experiments/handoff-beacon/reviewerVerdict.mjs';
import {
  beforeRequiredVersion, parseUniqueJson, readJson, verifyReviewerInfrastructure as verify,
} from '../scripts/verify-reviewer-infrastructure.mjs';

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

test('release boundary compares integer components where locale collation disagrees', () => {
  // Plain collation orders 1.6.10 before 1.6.9; ICU numeric collation splits digit runs longer than 254.
  const ten254 = `1.6.1${'0'.repeat(254)}`;
  const nines254 = `1.6.${'9'.repeat(254)}`;
  for (const [earlier, later] of [['1.6.9', '1.6.10'], ['1.9.0', '1.10.0'], ['1.6.6', '1.6.7'], [nines254, ten254]]) {
    assert.equal(beforeRequiredVersion(earlier, later), true, `${earlier.length}-char ${earlier.slice(0, 8)} before ${later.slice(0, 8)}`);
    assert.equal(beforeRequiredVersion(later, earlier), false, `${later.length}-char ${later.slice(0, 8)} not before ${earlier.slice(0, 8)}`);
  }
  assert.equal(beforeRequiredVersion('1.6.7', '1.6.7'), false);
  assert.equal(beforeRequiredVersion('1.6.6'), true);
  assert.equal(beforeRequiredVersion('1.6.7'), false);
  for (const bad of ['1.6.7-rc.1', '01.6.7', '1.6', undefined]) assert.throws(() => beforeRequiredVersion(bad), /not a stable X\.Y\.Z version/);
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

// Every run: value, inline or block scalar, with all of its more-indented continuation lines.
function runBodies(yaml) {
  const lines = yaml.split('\n');
  return lines.flatMap((line, i) => {
    const match = /^(\s*(?:-\s+)?)run:(?:\s+(.*))?$/.exec(line);
    if (!match) return [];
    const head = match[2] ?? '';
    const rest = [];
    for (let j = i + 1; j < lines.length && !(lines[j].trim() && lines[j].search(/\S/) <= match[1].length); j++) {
      rest.push(lines[j]);
    }
    const pad = Math.min(...rest.filter(l => l.trim()).map(l => l.search(/\S/)));
    const body = /^[|>][-+1-9]*\s*(?:#.*)?$/.test(head) ? [] : [head];
    return [[...body, ...rest.map(l => l.slice(pad))].join('\n')];
  });
}

// Every workflow file the release procedure names, plus every composite action.
function releasePathFiles() {
  const named = new Set([...read('../docs/release/release-procedure.md').matchAll(/[\w.-]+\.ya?ml\b/g)].map(m => m[0]));
  const workflows = [...named].map(name => `.github/workflows/${name}`).filter(f => existsSync(new URL(`../${f}`, import.meta.url)));
  const actions = readdirSync(new URL('../.github/actions/', import.meta.url), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => ['action.yml', 'action.yaml'].map(f => `.github/actions/${d.name}/${f}`))
    .filter(f => existsSync(new URL(`../${f}`, import.meta.url)));
  return [...workflows, ...actions];
}

test('release-path workflows and composite actions never interpolate expressions into run bodies', () => {
  const files = releasePathFiles();
  for (const required of ['.github/workflows/extension-release.yml', '.github/workflows/acg-keyless-attest.yml', '.github/actions/keyless-attest/action.yml']) {
    assert.ok(files.includes(required), `the scan covers ${required}`);
  }
  for (const file of files) {
    const bodies = runBodies(read(`../${file}`));
    assert.ok(bodies.length > 0, `${file} has run bodies to scan`);
    for (const body of bodies) assert.doesNotMatch(body, /\$\{\{/, `${file} interpolates an expression into a run body`);
  }
  for (const expression of ['${{ inputs.tag }}', '${{ github.event.inputs.bundle }}']) {
    for (const yaml of [
      `run: echo "${expression}"`,
      `run: |\n  echo "${expression}"`,
      `run: | # note\n  echo "${expression}"`,
      `run: |2\n    echo "${expression}"`,
      `- run: >-\n    echo "${expression}"`,
      `run: echo one\n  "${expression}"`,
      `steps:\n  - shell: bash\n    run: |\n      dir="${expression}"`,
    ]) assert.ok(runBodies(yaml).some(body => body.includes(expression)), yaml);
  }
  assert.deepEqual(runBodies('env:\n  TAG: ${{ inputs.tag }}\nrun: echo "$TAG"\nname: next'), ['echo "$TAG"']);

  const workflow = read('../.github/workflows/extension-release.yml');
  assert.ok(runBodies(workflow).length > 10);
  assert.equal((workflow.match(/- name: Derive version/g) || []).length, 1);
  assert.match(workflow, /DISPATCH_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(workflow, /VERSION: \$\{\{ needs\.agreement\.outputs\.version \}\}/);
  const attest = read('../.github/workflows/acg-keyless-attest.yml');
  assert.deepEqual(attest.match(/\$\{\{[^}]*inputs\.[^}]*\}\}/g), ['${{ inputs.bundle }}', '${{ inputs.tag }}']);
  assert.match(attest, /DISPATCH_BUNDLE: \$\{\{ inputs\.bundle \}\}\n\s+DISPATCH_TAG: \$\{\{ inputs\.tag \}\}\n\s+LC_ALL: C\n/);
  assert.match(attest, /BUNDLE: \$\{\{ steps\.validated\.outputs\.bundle \}\}/);
  assert.match(attest, /TAG: \$\{\{ steps\.validated\.outputs\.tag \}\}/);
});

test('keyless attest workflow validates the dispatch bundle and tag as data', () => {
  const script = runBodies(read('../.github/workflows/acg-keyless-attest.yml')).find(body => body.includes('DISPATCH_BUNDLE'));
  assert.ok(script);
  const fallback = 'experiments/acg-transparency/release-provenance-bundle.json';
  const scratch = mkdtempSync(join(tmpdir(), 'keyless-inputs-'));
  const output = join(scratch, 'inputs-output');
  try {
    mkdirSync(join(scratch, 'experiments', 'acg-transparency'), { recursive: true });
    for (const file of [fallback, 'other.json', 'a..b.json']) writeFileSync(join(scratch, file), '{}');
    mkdirSync(join(scratch, 'dir.json'));
    const run = (bundle, tag) => {
      rmSync(output, { force: true });
      const result = spawnSync('bash', ['-c', script], {
        cwd: scratch, encoding: 'utf8',
        env: { ...process.env, DISPATCH_BUNDLE: bundle, DISPATCH_TAG: tag, LC_ALL: 'C', GITHUB_OUTPUT: 'inputs-output' },
      });
      assert.ifError(result.error);
      const written = existsSync(output) ? readFileSync(output, 'utf8').replaceAll('\r\n', '\n') : '';
      return { ...result, written };
    };
    for (const [bundle, tag, expected] of [
      ['', '', `bundle=${fallback}\ntag=\n`],
      [fallback, 'acg-attest-v0.0.3', `bundle=${fallback}\ntag=acg-attest-v0.0.3\n`],
      ['other.json', 'acg-attest-v1.10.0', 'bundle=other.json\ntag=acg-attest-v1.10.0\n'],
      ['a..b.json', '', 'bundle=a..b.json\ntag=\n'],
    ]) {
      const result = run(bundle, tag);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.written, expected);
    }
    const badBundles = ['../other.json', '/etc/other.json', '-x.json', './other.json', 'a/../other.json', 'experiments//x.json',
      'other.json; id', '$(id).json', 'other.json\nx.json', 'other .json', 'other.txt', 'missing.json', 'dir.json'];
    if (process.platform !== 'win32') {
      symlinkSync('other.json', join(scratch, 'link.json'));
      badBundles.push('link.json');
    }
    const badTags = ['acg-attest-v01.0.0', 'v1.0.0', 'acg-attest-v1.0.0-rc.1', 'acg-attest-v1.0.0; id', 'acg-attest-v1.0.0\nx', '$(id)', ' acg-attest-v1.0.0'];
    for (const [bundle, tag] of [...badBundles.map(b => [b, '']), ...badTags.map(t => ['', t])]) {
      const result = run(bundle, tag);
      assert.equal(result.status, 1, `${JSON.stringify([bundle, tag])}: ${result.stderr}`);
      assert.equal(result.written, '');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
