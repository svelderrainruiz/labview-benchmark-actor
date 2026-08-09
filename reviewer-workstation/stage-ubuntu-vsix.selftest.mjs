#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateUbuntuCandidateArtifact,
  validateUbuntuReviewTarget,
  validateUbuntuStageEvidence,
} from './stage-ubuntu-vsix.mjs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const target = {
  component: 'extension',
  version,
  commit: 'a'.repeat(40),
  vsixSha256: 'f'.repeat(64),
};
const vsixBytes = Buffer.from('exact candidate');
const crypto = await import('node:crypto');
target.vsixSha256 = crypto.createHash('sha256').update(vsixBytes).digest('hex');
const manifest = {
  name: 'labview-benchmark-actor',
  publisher: 'svelderrainruiz',
  version,
};
const installedExtensions = [`svelderrainruiz.labview-benchmark-actor@${version}`];

assert.equal(validateUbuntuReviewTarget(target).ok, true);
assert.equal(validateUbuntuReviewTarget({ ...target, commit: 'short' }).ok, false);
assert.equal(validateUbuntuReviewTarget({ ...target, vsixSha256: 'wrong' }).ok, false);
assert.equal(validateUbuntuCandidateArtifact({ target, vsixBytes, manifest }).ok, true);
assert.equal(validateUbuntuCandidateArtifact({
  target: { ...target, vsixSha256: '0'.repeat(64) },
  vsixBytes,
  manifest,
}).ok, false);
assert.equal(validateUbuntuCandidateArtifact({
  target,
  vsixBytes,
  manifest: { ...manifest, version: '0.0.0' },
}).ok, false);
assert.equal(validateUbuntuStageEvidence({ target, vsixBytes, manifest, installedExtensions }).ok, true);
assert.equal(validateUbuntuStageEvidence({
  target: { ...target, vsixSha256: '0'.repeat(64) },
  vsixBytes,
  manifest,
  installedExtensions,
}).ok, false);
assert.equal(validateUbuntuStageEvidence({
  target,
  vsixBytes,
  manifest: { ...manifest, version: '1.4.9' },
  installedExtensions,
}).ok, false);
assert.equal(validateUbuntuStageEvidence({
  target,
  vsixBytes,
  manifest,
  installedExtensions: ['svelderrainruiz.labview-benchmark-actor@1.4.9'],
}).ok, false);

const source = readFileSync(new URL('./stage-ubuntu-vsix.mjs', import.meta.url), 'utf8');
assert(
  source.indexOf('const candidate = validateUbuntuCandidateArtifact') < source.indexOf("execFileSync(code, ['--install-extension'"),
  'candidate bytes and manifest are validated before installation',
);
assert.match(source, /reviewer-station\.json/);
assert.match(source, /handoffReviewTarget/);

console.log('stage-ubuntu-vsix self-test: PASS');
