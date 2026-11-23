import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

// A line-based decoder for run values in workflow and action YAML, without a YAML dependency. It fails
// closed: a run-like key, alias, tag, escape or multi-line flow collection it cannot decode throws.
const blockHeader = /^[|>][-+1-9]*[ \t]*(?:#.*)?$/;
const runKey = /^([ \t]*(?:-[ \t]+)*)(?:"run"|'run'|run)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/i;
const runCandidate = /(?:^|[[{,?])[ \t]*(?:-[ \t]*)*(?:[!&]\S*[ \t]+)*["']?run["']?[ \t]*:/i;
const opaqueKey = /(?:^|[[{,])[ \t]*(?:-[ \t]+)*\?(?:[ \t]|$)|"[^"\n]*\\[^"\n]*"[ \t]*:(?:[ \t]|$)/;
const otherBlock = /^([ \t]*(?:-[ \t]+)*)([^\s#].*?:[ \t]+)?[|>][-+1-9]*[ \t]*(?:#.*)?$/;

function opensMultilineFlow(line) {
  const start = /(?:^[ \t]*(?:-[ \t]+)*|:[ \t]+)(?=[[{])/.exec(line);
  if (!start) return false;
  let depth = 0;
  for (let k = start.index + start[0].length; k < line.length; k++) {
    const c = line[k];
    if ((c === '"' || c === "'") && /[\s[{,:]/.test(line[k - 1])) {
      const quoted = (c === '"' ? /^"(?:[^"\\]|\\.)*"/ : /^'(?:[^']|'')*'/).exec(line.slice(k));
      if (!quoted) return true;
      k += quoted[0].length - 1;
    } else if (c === '#' && /\s/.test(line[k - 1])) break;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth !== 0;
}

function runBodies(yaml, file = 'yaml') {
  const lines = yaml.split('\n');
  const indentOf = l => l.search(/\S/);
  const blockEnd = (from, col) => {
    let j = from;
    while (j < lines.length && !(lines[j].trim() && indentOf(lines[j]) <= col)) j++;
    return j;
  };
  const bodies = [];
  let scalarEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^[ \t]*#/.test(line)) continue;
    const unrecognised = () => new Error(`unrecognised run form at ${file}:${i + 1}`);
    const run = runKey.exec(line);
    if (run) {
      const head = run[2] ?? '';
      const end = blockEnd(i + 1, run[1].length);
      const rest = lines.slice(i + 1, end);
      const value = head || (rest.find(l => l.trim()) ?? '').trim();
      if (/^[*&!{[@`%]/.test(value) || (/^[|>]/.test(value) && !blockHeader.test(value))
          || (value.startsWith('"') && [head, ...rest].join('\n').includes('\\'))) throw unrecognised();
      const pad = Math.min(...rest.filter(l => l.trim()).map(indentOf));
      bodies.push([...(blockHeader.test(head) ? [] : [head]), ...rest.map(l => l.slice(pad))].join('\n'));
      i = end - 1;
      continue;
    }
    if (runCandidate.test(line) || opaqueKey.test(line) || (i >= scalarEnd && opensMultilineFlow(line))) throw unrecognised();
    const scalar = i >= scalarEnd && otherBlock.exec(line);
    if (scalar) scalarEnd = blockEnd(i + 1, scalar[2] ? scalar[1].length : scalar[1].trimEnd().length - 1);
  }
  return bodies;
}

// The workflows the release procedure and runbook name, every composite action, and every
// repository-local `uses: ./...` they reach, transitively.
function releasePathFiles(root = fileURLToPath(new URL('../', import.meta.url))) {
  const exists = rel => existsSync(join(root, rel));
  const text = rel => readFileSync(join(root, rel), 'utf8').replaceAll('\r\n', '\n');
  const queue = [];
  for (const doc of ['docs/release/release-procedure.md', 'docs/release/release-runbook.md']) {
    for (const [name] of text(doc).matchAll(/[\w.-]+\.ya?ml\b/g)) {
      assert.ok(exists(`.github/workflows/${name}`), `${doc} names ${name}, which is not a workflow`);
      queue.push(`.github/workflows/${name}`);
    }
  }
  const actionFile = dir => ['action.yml', 'action.yaml'].map(f => `${dir}/${f}`).find(exists);
  if (exists('.github/actions')) {
    for (const d of readdirSync(join(root, '.github', 'actions'), { withFileTypes: true })) {
      if (d.isDirectory() && actionFile(`.github/actions/${d.name}`)) queue.push(actionFile(`.github/actions/${d.name}`));
    }
  }
  const seen = new Set();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const [, ref] of text(rel).matchAll(/(?:^|[[{,])[ \t]*(?:-[ \t]*)*["']?uses["']?[ \t]*:[ \t]*["']?\.\/([^\s"',}\]#@]*)/gim)) {
      const target = ref.replace(/\/+$/, '');
      const file = /\.ya?ml$/.test(target) ? target : actionFile(target);
      assert.ok(file && exists(file), `${rel} uses ./${ref}, which does not resolve to a workflow or action file`);
      queue.push(file);
    }
  }
  return [...seen].sort();
}

test('release-path workflows and composite actions never interpolate expressions into run bodies', () => {
  const files = releasePathFiles();
  for (const required of [
    '.github/workflows/extension-release.yml', '.github/workflows/acg-keyless-attest.yml',
    '.github/workflows/acg-cross-plane-corroboration.yml', '.github/workflows/vsix-cross-plane-repro.yml',
    '.github/actions/keyless-attest/action.yml',
  ]) {
    assert.ok(files.includes(required), `the scan covers ${required}`);
  }
  for (const file of files) {
    const bodies = runBodies(read(`../${file}`), file);
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

test('run scanner decodes or rejects every run key form and never passes one silently', () => {
  const expression = '${{ inputs.tag }}';
  for (const yaml of [
    `steps:\n  - "run": >-\n      echo "${expression}"`,
    `steps:\n  - 'RUN' : |\n      echo "${expression}"`,
    `steps:\n  - name: x\n    run:\n      echo "${expression}"`,
  ]) {
    const bodies = runBodies(yaml, 'fixture.yml');
    assert.equal(bodies.length, 1, yaml);
    assert.ok(bodies[0].includes(expression), yaml);
  }
  for (const [yaml, line] of [
    [`steps:\n  - { name: x, run: echo "${expression}" }`, 2],
    ['steps:\n  - { name: x, run: echo clean }', 2],
    ['steps:\n  - {run: echo clean}', 2],
    ['steps: [run: echo clean]', 1],
    ['steps:\n  - {\n      name: x,\n      run: echo\n  clean }', 2],
    ['steps:\n  - "\\x72un": echo clean', 2],
    ['steps:\n  - ? run\n    : echo clean', 2],
    ['steps:\n  - !!str run: echo clean', 2],
    ['steps:\n  - &step run: echo clean', 2],
    ['steps:\n  - run: *cmd', 2],
    ['steps:\n  - run:\n      *cmd', 2],
    ['steps:\n  - run: !!str echo clean', 2],
    ['steps:\n  - run: [echo, clean]', 2],
    ['steps:\n  - run: "echo \\x24{{ inputs.tag }}"', 2],
    ['steps:\n  - run: "echo $\\\n      {{ inputs.tag }}"', 2],
    ['steps:\n  - run:x', 2],
  ]) {
    assert.throws(() => runBodies(yaml, 'fixture.yml'), new RegExp(`^Error: unrecognised run form at fixture\\.yml:${line}$`), yaml);
  }
  assert.deepEqual(runBodies('on: [push]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - name: Run it\n        run: echo "a, run: b"'), ['echo "a, run: b"']);
  assert.deepEqual(runBodies('x:\n  script: |\n    if (a) {\n      run: 1\n  - run: echo ok'), ['1', 'echo ok']);
});

test('release-path scan follows repository-local uses references transitively and fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-path-'));
  const put = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  try {
    put('docs/release/release-procedure.md', 'Run `.github/workflows/a.yml`.\n');
    put('docs/release/release-runbook.md', 'Then dispatch `b.yml`.\n');
    put('.github/workflows/a.yml', 'jobs:\n  call:\n    uses: ./.github/workflows/c.yml\n');
    put('.github/workflows/b.yml', 'jobs:\n  x:\n    steps:\n      - uses: "./tools/act/"\n');
    put('.github/workflows/c.yml', 'jobs:\n  x:\n    steps:\n      - {uses: ./.github/actions/d}\n');
    put('.github/actions/d/action.yml', 'runs:\n  using: composite\n  steps:\n    - uses: ./tools/e\n');
    put('tools/act/action.yaml', 'runs:\n  using: composite\n');
    put('tools/e/action.yml', 'runs:\n  using: composite\n');
    put('.github/workflows/unnamed.yml', 'jobs: {}\n');
    assert.deepEqual(releasePathFiles(root), [
      '.github/actions/d/action.yml', '.github/workflows/a.yml', '.github/workflows/b.yml',
      '.github/workflows/c.yml', 'tools/act/action.yaml', 'tools/e/action.yml',
    ]);
    put('tools/e/action.yml', 'runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/missing\n');
    assert.throws(() => releasePathFiles(root), /tools\/e\/action\.yml uses \.\/\.github\/actions\/missing, which does not resolve/);
    put('tools/e/action.yml', 'runs:\n  using: composite\n');
    put('docs/release/release-runbook.md', 'Then dispatch `gone.yml`.\n');
    assert.throws(() => releasePathFiles(root), /release-runbook\.md names gone\.yml, which is not a workflow/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keyless attest workflow validates the dispatch bundle and tag as data', () => {
  const script = runBodies(read('../.github/workflows/acg-keyless-attest.yml')).find(body => body.includes('DISPATCH_BUNDLE'));
  assert.ok(script);
  const fallback = 'experiments/acg-transparency/release-provenance-bundle.json';
  // Long names: the Windows runner temp directory is an 8.3 short name (RUNNER~1) that realpath expands.
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'keyless-inputs-')));
  const outside = mkdtempSync(join(tmpdir(), 'keyless-outside-'));
  const output = join(scratch, 'inputs-output');
  try {
    mkdirSync(join(scratch, 'experiments', 'acg-transparency'), { recursive: true });
    for (const file of [fallback, 'other.json', 'a..b.json']) writeFileSync(join(scratch, file), '{}');
    mkdirSync(join(scratch, 'dir.json'));
    writeFileSync(join(outside, 'x.json'), '{}');
    // The temporary checkout as the workflow's own realpath names it, so Git Bash on Windows compares like with like.
    const workspace = spawnSync('bash', ['-c', 'realpath -e .'], { cwd: scratch, encoding: 'utf8' }).stdout.trim();
    assert.ok(workspace);
    const run = (bundle, tag, env = {}) => {
      rmSync(output, { force: true });
      const result = spawnSync('bash', ['-c', script], {
        cwd: scratch, encoding: 'utf8',
        env: { ...process.env, DISPATCH_BUNDLE: bundle, DISPATCH_TAG: tag, LC_ALL: 'C', GITHUB_OUTPUT: 'inputs-output', GITHUB_WORKSPACE: workspace, ...env },
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
      symlinkSync(outside, join(scratch, 'experiments', 'link'));
      symlinkSync('experiments/acg-transparency', join(scratch, 'inner'));
      badBundles.push('link.json', 'experiments/link/x.json', 'inner/release-provenance-bundle.json');
    }
    const badTags = ['acg-attest-v01.0.0', 'v1.0.0', 'acg-attest-v1.0.0-rc.1', 'acg-attest-v1.0.0; id', 'acg-attest-v1.0.0\nx', '$(id)', ' acg-attest-v1.0.0'];
    for (const [bundle, tag] of [...badBundles.map(b => [b, '']), ...badTags.map(t => ['', t])]) {
      const result = run(bundle, tag);
      assert.equal(result.status, 1, `${JSON.stringify([bundle, tag])}: ${result.stderr}`);
      assert.equal(result.written, '');
    }
    for (const elsewhere of [`${workspace}/experiments`, '']) {
      const result = run('other.json', '', { GITHUB_WORKSPACE: elsewhere });
      assert.equal(result.status, 1, `workspace ${JSON.stringify(elsewhere)}: ${result.stderr}`);
      assert.equal(result.written, '');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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
