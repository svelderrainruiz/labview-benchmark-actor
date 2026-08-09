#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  validateUbuntuReviewTarget,
  validateUbuntuStageEvidence,
} from './stage-ubuntu-vsix.mjs';

const target = {
  component: 'extension',
  version: '1.4.10',
  commit: 'a'.repeat(40),
  vsixSha256: 'f'.repeat(64),
};
const vsixBytes = Buffer.from('exact candidate');
const crypto = await import('node:crypto');
target.vsixSha256 = crypto.createHash('sha256').update(vsixBytes).digest('hex');
const manifest = {
  name: 'labview-benchmark-actor',
  publisher: 'svelderrainruiz',
  version: '1.4.10',
};
const installedExtensions = ['svelderrainruiz.labview-benchmark-actor@1.4.10'];

assert.equal(validateUbuntuReviewTarget(target).ok, true);
assert.equal(validateUbuntuReviewTarget({ ...target, commit: 'short' }).ok, false);
assert.equal(validateUbuntuReviewTarget({ ...target, vsixSha256: 'wrong' }).ok, false);
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

console.log('stage-ubuntu-vsix self-test: PASS');
