#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  buildCandidateProof,
  parseCorrespondenceSummary,
  parseCoverageSummary,
  parseLocalGateSummary,
} from '../scripts/local-kpi-core.mjs';

const coverage = parseCoverageSummary(`
Statements : 96.2% ( 962/1000 )
Branches   : 95.1% ( 951/1000 )
Functions  : 97% ( 97/100 )
Lines      : 96% ( 960/1000 )
`);
assert.equal(coverage.branches.percent, 95.1);
assert.deepEqual(parseLocalGateSummary('203/203 checks passed'), { passed: 203, total: 203 });
assert.deepEqual(
  parseCorrespondenceSummary('governed-tests=178\nall correspondence rules PASS'),
  { passed: 178, total: 178, graphConformant: true },
);
assert.throws(() => parseCoverageSummary('missing'), /Statements/);
assert.throws(() => parseLocalGateSummary('202 checks'), /Local-gate/);
assert.throws(() => parseCorrespondenceSummary('governed-tests=1\nFAIL'), /not conformant/);
assert.equal(buildCandidateProof({
  sourceCommit: 'a'.repeat(40),
  branch: 'hotfix/1.4.1',
  vsixSha256: 'b'.repeat(64),
  vsixSize: 100,
  cleanBefore: true,
  cleanAfter: true,
}).worktreeCleanAfter, true);
assert.throws(() => buildCandidateProof({
  sourceCommit: 'bad',
  branch: '',
  vsixSha256: 'b'.repeat(64),
  vsixSize: 1,
  cleanBefore: true,
  cleanAfter: true,
}), /Git SHA/);
assert.throws(() => buildCandidateProof({
  sourceCommit: 'a'.repeat(40),
  branch: '',
  vsixSha256: 'bad',
  vsixSize: 1,
  cleanBefore: true,
  cleanAfter: true,
}), /SHA-256/);
assert.throws(() => buildCandidateProof({
  sourceCommit: 'a'.repeat(40),
  branch: '',
  vsixSha256: 'b'.repeat(64),
  vsixSize: 1,
  cleanBefore: false,
  cleanAfter: true,
}), /clean/);

console.log('local-kpi-core: PASS');
