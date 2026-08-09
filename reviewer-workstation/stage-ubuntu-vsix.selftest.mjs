#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateUbuntuCandidateArtifact,
  validateUbuntuKpiReceipt,
  validateUbuntuKpiInventories,
  validateUbuntuReviewTarget,
  validateUbuntuStageHost,
  validateUbuntuStageEvidence,
  validateUbuntuVmIdentity,
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
const coverageFloors = { lines: 95, statements: 95, functions: 96, branches: 95 };
const kpi = {
  schema: 'labview-benchmark-actor/local-continuous-kpi@1',
  mode: 'full',
  version,
  outcome: 'PASS',
  kpi: {
    candidate: {
      sourceCommit: target.commit,
      worktreeCleanBefore: true,
      worktreeCleanAfter: true,
      vsixSha256: target.vsixSha256,
      vsixSize: vsixBytes.length,
    },
    localGates: { passed: 210, total: 210 },
    coverage: Object.fromEntries(
      Object.entries(coverageFloors).map(([metric, percent]) => [metric, { percent }]),
    ),
    correspondences: { passed: 182, total: 182, graphConformant: true },
    package: {
      firstSha256: target.vsixSha256,
      secondSha256: target.vsixSha256,
      identical: true,
    },
  },
};

assert.equal(validateUbuntuReviewTarget(target).ok, true);
assert.equal(validateUbuntuReviewTarget({ ...target, commit: 'short' }).ok, false);
assert.equal(validateUbuntuReviewTarget({ ...target, vsixSha256: 'wrong' }).ok, false);
assert.equal(validateUbuntuCandidateArtifact({ target, vsixBytes, manifest }).ok, true);
assert.equal(validateUbuntuCandidateArtifact({
  target: { ...target, vsixSha256: '0'.repeat(64) },
  vsixBytes,
  manifest,
}).ok, false);
assert.equal(validateUbuntuKpiReceipt({ target, kpi, vsixBytes, coverageFloors }).ok, true);
assert.equal(validateUbuntuKpiReceipt({
  target,
  kpi: { ...kpi, kpi: { ...kpi.kpi, candidate: { ...kpi.kpi.candidate, sourceCommit: 'b'.repeat(40) } } },
  vsixBytes,
  coverageFloors,
}).ok, false);
const vmIdentity = {
  provider: 'oracle',
  machineId: 'c'.repeat(32),
  productName: 'VirtualBox',
};
assert.equal(validateUbuntuVmIdentity({
  identity: vmIdentity,
  expectedProvider: 'oracle',
  expectedMachineId: vmIdentity.machineId,
}).ok, true);
assert.equal(validateUbuntuVmIdentity({
  identity: { ...vmIdentity, provider: 'wsl', productName: 'Physical Machine' },
  expectedProvider: 'oracle',
  expectedMachineId: vmIdentity.machineId,
}).ok, false);
assert.equal(validateUbuntuStageHost({ runningCodePids: '' }).ok, true);
assert.equal(validateUbuntuStageHost({ runningCodePids: '123\n456' }).ok, false);
const localGateOutput = '210/210 checks passed on linux-x64 (node v24.19.0)';
const correspondenceOutput = [
  'correspondences: requirements=97 governed-tests=182 ADRs=80 information-items=16 dod-outcomes=7',
  'correspondences: all correspondence rules PASS (graph conformant)',
].join('\n');
assert.equal(validateUbuntuKpiInventories({ kpi, localGateOutput, correspondenceOutput }).ok, true);
assert.equal(validateUbuntuKpiInventories({
  kpi: { ...kpi, kpi: { ...kpi.kpi, localGates: { passed: 1, total: 1 } } },
  localGateOutput,
  correspondenceOutput,
}).ok, false);
assert.equal(validateUbuntuKpiInventories({
  kpi: { ...kpi, kpi: { ...kpi.kpi, correspondences: { passed: 1, total: 1, graphConformant: true } } },
  localGateOutput,
  correspondenceOutput,
}).ok, false);
assert.equal(validateUbuntuKpiInventories({ kpi, localGateOutput: 'failed', correspondenceOutput: 'failed' }).ok, false);
assert.equal(validateUbuntuVmIdentity({
  identity: vmIdentity,
  expectedProvider: 'wsl',
  expectedMachineId: 'wrong',
}).ok, false);
assert.equal(validateUbuntuKpiReceipt({
  target,
  kpi: { ...kpi, kpi: { ...kpi.kpi, candidate: { ...kpi.kpi.candidate, worktreeCleanAfter: false } } },
  vsixBytes,
  coverageFloors,
}).ok, false);
assert.equal(validateUbuntuKpiReceipt({
  target,
  kpi: { ...kpi, kpi: { ...kpi.kpi, package: { ...kpi.kpi.package, identical: false } } },
  vsixBytes,
  coverageFloors,
}).ok, false);
assert.equal(validateUbuntuKpiReceipt({
  target,
  kpi: { ...kpi, kpi: { ...kpi.kpi, coverage: undefined } },
  vsixBytes,
  coverageFloors,
}).ok, false);
assert.equal(validateUbuntuKpiReceipt({
  target,
  kpi: { ...kpi, kpi: { ...kpi.kpi, correspondences: { passed: 181, total: 182, graphConformant: false } } },
  vsixBytes,
  coverageFloors,
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
assert(
  source.indexOf('const kpiEvidence = validateUbuntuKpiReceipt') < source.indexOf("execFileSync(code, ['--install-extension'"),
  'candidate commit KPI binding is validated before installation',
);
assert(
  source.indexOf('const vmEvidence = validateUbuntuVmIdentity') < source.indexOf("execFileSync(code, ['--install-extension'"),
  'reviewer virtualization identity is validated before installation',
);
assert(
  source.indexOf('const hostEvidence = validateUbuntuStageHost') < source.indexOf("execFileSync(code, ['--install-extension'"),
  'the extension host is proven stopped before installation',
);
assert(
  source.indexOf('const inventoryEvidence = validateUbuntuKpiInventories') < source.indexOf("execFileSync(code, ['--install-extension'"),
  'exact gate and correspondence inventories are rerun before installation',
);
assert.match(source, /reviewer-station\.json/);
assert.match(source, /handoffReviewTarget/);

console.log('stage-ubuntu-vsix self-test: PASS');
