// Fail-closed controls for the pinned-lbabus consumption (labview-benchmark-actor#57 slice 3): the pin-vs-AGENTS
// contract and the fetch helper, against a local HTTP server and a local git repository (no network).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutSource, fetchBinary } from '../scripts/fetch-lbabus.mjs';
import { expectedAssetNames, verifyPinContract } from '../scripts/lbabus-pin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const real = JSON.parse(readFileSync(join(root, 'release-components.json'), 'utf8'));
const agentsText = readFileSync(join(root, 'extension-agents', 'AGENTS.md'), 'utf8');
const rejects = async (promise, pattern) => assert.rejects(promise, pattern);

// 1. The pin-vs-AGENTS contract.
const consumers = [{ name: 'clean-room manifest', tag: real.lbabusRelease.tag, commit: real.lbabusRelease.commit }];
assert.equal(verifyPinContract({ components: real, agentsText, consumers, inTreeCopyPaths: [] }).ok, true);
const wrongCommit = verifyPinContract({ components: real, agentsText, consumers: [{ ...consumers[0], commit: 'a'.repeat(40) }] });
assert.equal(wrongCommit.ok, false);
assert.match(wrongCommit.reasons.join(';'), /pins commit/);
assert.equal(verifyPinContract({ components: real, agentsText, consumers: [{ ...consumers[0], tag: 'v0.0.1' }] }).ok, false);
assert.equal(verifyPinContract({ components: { ...real, lbabus: '0.0.1' }, agentsText, consumers }).ok, false);
assert.equal(verifyPinContract({ components: real, agentsText: agentsText.replace(`exactly \`${real.lbabus}\``, 'exactly `0.0.1`'), consumers }).ok, false);
assert.equal(verifyPinContract({ components: { ...real, lbabusRelease: { ...real.lbabusRelease, assets: { ...real.lbabusRelease.assets, [expectedAssetNames(real.lbabus)['linux-x64']]: 'xyz' } } }, agentsText, consumers }).ok, false);
assert.equal(verifyPinContract({ components: real, agentsText, consumers, inTreeCopyPaths: ['tools/collab-cli'] }).ok, false);

// 2. The fetch helper, binary mode: right digest passes; a wrong digest fails and leaves nothing behind.
const version = '9.9.9';
const names = expectedAssetNames(version);
const payload = Buffer.from('not a real binary');
const digest = createHash('sha256').update(payload).digest('hex');
const server = createServer((request, response) => { response.end(payload); });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const work = mkdtempSync(join(tmpdir(), 'fetch-lbabus-test-'));
const pinFor = (overrides = {}) => ({
  lbabus: version,
  lbabusRelease: { repository: real.lbabusRelease.repository, tag: `v${version}`, tagObject: 'b'.repeat(40), commit: 'c'.repeat(40),
    assets: { [names.package]: digest, [names['linux-x64']]: digest, [names['win-x64']]: digest, [names.sums]: digest }, ...overrides },
});
try {
  const out = join(work, 'lbabus');
  await fetchBinary({ components: pinFor(), rid: 'linux-x64', out, repository: `${base}/lbabus` });
  assert.equal(readFileSync(out, 'utf8'), payload.toString());
  const wrongOut = join(work, 'wrong');
  const bad = pinFor({ assets: { [names.package]: digest, [names['linux-x64']]: '0'.repeat(64), [names['win-x64']]: digest, [names.sums]: digest } });
  await rejects(fetchBinary({ components: bad, rid: 'linux-x64', out: wrongOut, repository: base }), /SHA-256 mismatch/);
  assert.equal(existsSync(wrongOut), false, 'a failed download must not leave the file');
  await rejects(fetchBinary({ components: pinFor(), rid: 'package', out: wrongOut, repository: base }), /unknown runtime identifier/);
} finally {
  server.close();
}

// 3. Source mode: the right tag object and commit pass; a wrong commit or tag object fails; tampering fails.
const repo = join(work, 'origin');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8' }).trim();
execFileSync('git', ['init', '-q', repo]);
writeFileSync(join(repo, 'file.txt'), 'one\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'one');
git(repo, 'tag', '-a', `v${version}`, '-m', 'release');
const commit = git(repo, 'rev-parse', 'HEAD');
const tagObject = git(repo, 'rev-parse', `refs/tags/v${version}`);
const sourcePin = (overrides) => pinFor({ commit, tagObject, ...overrides });
const dir = checkoutSource({ components: sourcePin(), repository: repo, cacheDir: join(work, 'ok') });
assert.equal(readFileSync(join(dir, 'file.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\n');
assert.throws(() => checkoutSource({ components: sourcePin({ commit: 'd'.repeat(40) }), repository: repo, cacheDir: join(work, 'bad-commit') }), /not the pinned d{40}/);
assert.equal(existsSync(join(work, 'bad-commit', `src-${'d'.repeat(40)}`)), false, 'a failed checkout must not be cached');
assert.throws(() => checkoutSource({ components: sourcePin({ tagObject: 'e'.repeat(40) }), repository: repo, cacheDir: join(work, 'bad-tag') }), /not the pinned e{40}/);
writeFileSync(join(dir, 'file.txt'), 'tampered\n');
assert.throws(() => checkoutSource({ components: sourcePin(), repository: repo, cacheDir: join(work, 'ok') }), /local changes/);

console.log('lbabus pin contract and fetch helper: fail-closed controls passed');
