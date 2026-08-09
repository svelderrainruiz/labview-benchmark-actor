#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildCloseout, validateCloseout } from './release-risk-closeout.mjs';

const baseline = {
  releaseVersion: '1.2.3',
  releaseEvidence: [
    { proofs: [{ id: 'already', status: 'present' }, { id: 'later', status: 'missing' }] },
  ],
};
const input = {
  releaseVersion: '1.2.3',
  candidate: { version: '1.2.3', commit: 'a'.repeat(40), vsixSha256: 'b'.repeat(64) },
  summary: { beforePresent: 1, afterPresent: 2, total: 2, completionPercent: 100, status: 'READY' },
  resolutions: [{ id: 'later', status: 'present', evidence: 'proof', artifacts: ['https://example.invalid/proof'] }],
  release: { immutable: true },
  marketplace: { published: true },
  lineage: { shared: true },
};
const closeout = buildCloseout(input);
assert.equal(validateCloseout(closeout, baseline).ok, true);
assert.equal(validateCloseout({ ...closeout, digest: '0'.repeat(64) }, baseline).ok, false);
assert.equal(validateCloseout(buildCloseout({ ...input, resolutions: [] }), baseline).ok, false);
assert.equal(validateCloseout(buildCloseout({
  ...input,
  resolutions: [{ ...input.resolutions[0], id: 'wrong' }],
}), baseline).ok, false);
console.log('release-risk-closeout: PASS');
