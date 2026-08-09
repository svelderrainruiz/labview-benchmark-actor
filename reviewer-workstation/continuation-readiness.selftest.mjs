#!/usr/bin/env node

import assert from 'node:assert/strict';
import { classifyWorktreeState, findSecretBearingFields, receiptDigest, validateReceipt } from './continuation-readiness.mjs';

function makeReceipt(overrides = {}) {
  const base = {
    schema: 'labview-benchmark-actor/continuation-readiness@1',
    startedWallTime: '2026-08-09T00:00:00.000Z',
    finishedWallTime: '2026-08-09T00:00:01.000Z',
    monotonicClockSource: 'process.hrtime.bigint',
    durationNs: '12345',
    branch: 'agents/continue-labview-benchmark-actor',
    head: 'd4fcaa123d62c5ffdec606d19c30d89ffefacfd7',
    upstream: 'origin/develop',
    originDevelop: 'd4fcaa123d62c5ffdec606d19c30d89ffefacfd7',
    mergeBase: 'd4fcaa123d62c5ffdec606d19c30d89ffefacfd7',
    headEqualsOriginDevelop: true,
    headIsAncestorOfOriginDevelop: true,
    originDevelopIsAncestorOfHead: true,
    trackedWorktreeClean: true,
    untrackedPaths: ['AGENTS.md'],
    trackedChanges: [],
    agents: {
      rootMaterialized: true,
      canonicalMatch: true,
      version: '0.3.13',
      sha256: '02ce9b7b0f69dca6e0297b07940eafc3ffc90681668d590d472bb24dc2f717a9',
      expectedVersion: '0.3.13',
      expectedSha256: '02ce9b7b0f69dca6e0297b07940eafc3ffc90681668d590d472bb24dc2f717a9',
      manifestVersion: '0.3.13',
      manifestSha256: '02ce9b7b0f69dca6e0297b07940eafc3ffc90681668d590d472bb24dc2f717a9',
    },
    tools: {
      node: { ok: true },
      npm: { ok: true },
      dotnet: { ok: true },
      glab: { ok: true },
      lbabus: { ok: true },
    },
    lbabus: {
      selfcheckOk: true,
      capabilitiesOk: true,
    },
    capabilities: { available: [{ name: 'git', path: 'C:/git/git.exe' }], unavailable: [{ name: 'vmware', reason: 'not available' }] },
    baseline: { present: 12, total: 28, status: 'BLOCKED' },
    closeout: { present: 28, total: 28, status: 'READY' },
    localGates: { summary: { passed: 204, total: 204 } },
    correspondences: { summary: { graphConformant: true } },
    quickKpi: { latestReceipt: { outcome: 'PASS' } },
    releaseSigning: { status: 'closed' },
    outcome: 'PASS',
    failures: [],
    receiptDigest: null,
    receiptPath: '.lba/continuation/readiness.json',
  };
  const result = { ...base, ...overrides, agents: { ...base.agents, ...(overrides.agents || {}) }, tools: { ...base.tools, ...(overrides.tools || {}) }, lbabus: { ...base.lbabus, ...(overrides.lbabus || {}) }, capabilities: { ...base.capabilities, ...(overrides.capabilities || {}) }, baseline: { ...base.baseline, ...(overrides.baseline || {}) }, closeout: { ...base.closeout, ...(overrides.closeout || {}) }, localGates: { ...base.localGates, ...(overrides.localGates || {}) }, correspondences: { ...base.correspondences, ...(overrides.correspondences || {}) }, quickKpi: { ...base.quickKpi, ...(overrides.quickKpi || {}) }, releaseSigning: { ...base.releaseSigning, ...(overrides.releaseSigning || {}) } };
  result.receiptDigest = receiptDigest(result);
  return result;
}

const allGreen = makeReceipt();
assert.equal(validateReceipt(allGreen).ok, true, 'all-green receipt should validate');

const wrongVersions = makeReceipt({ tools: { node: { ok: false }, npm: { ok: false }, dotnet: { ok: true }, glab: { ok: true }, lbabus: { ok: false } } });
assert.equal(validateReceipt(wrongVersions).ok, false, 'wrong versions should fail');

const missingDotnetGlab = makeReceipt({ tools: { node: { ok: true }, npm: { ok: true }, dotnet: { ok: false }, glab: { ok: false }, lbabus: { ok: true } } });
assert.equal(validateReceipt(missingDotnetGlab).ok, false, 'missing dotnet/glab should fail');

const agentsDrift = makeReceipt({ agents: { rootMaterialized: false, canonicalMatch: false, version: '0.3.12', sha256: 'deadbeef' } });
assert.equal(validateReceipt(agentsDrift).ok, false, 'AGENTS drift should fail');

const worktreeState = classifyWorktreeState({ trackedChanges: ['M file.txt'], untrackedPaths: ['AGENTS.md'] });
assert.equal(worktreeState.trackedWorktreeClean, false, 'tracked changes should not be clean');
assert.equal(worktreeState.disallowedUntrackedPaths.length, 0, 'AGENTS.md should be allowed');

const conflatedBaseline = makeReceipt({ baseline: { present: 28, total: 28, status: 'READY' } });
assert.equal(validateReceipt(conflatedBaseline).ok, false, 'baseline must remain BLOCKED');

const failedSelfcheck = makeReceipt({ lbabus: { selfcheckOk: false, capabilitiesOk: true } });
assert.equal(validateReceipt(failedSelfcheck).ok, false, 'selfcheck failures should fail');

const failedGates = makeReceipt({ localGates: { summary: { passed: 203, total: 204 } } });
assert.equal(validateReceipt(failedGates).ok, false, 'failed gates should fail');

const failedKpi = makeReceipt({ quickKpi: { latestReceipt: { outcome: 'FAIL' } } });
assert.equal(validateReceipt(failedKpi).ok, false, 'failed KPI should fail');

const tampered = makeReceipt();
const tamperedDigest = { ...tampered, receiptDigest: '0'.repeat(64) };
assert.equal(validateReceipt(tamperedDigest).ok, false, 'tampered digest should fail');

const secrets = makeReceipt({ capabilities: { available: [{ name: 'git', path: 'C:/git/git.exe' }], unavailable: [] }, releaseSigning: { status: 'closed', privateKeyPath: 'C:/secrets/key.pem' } });
assert.equal(findSecretBearingFields(secrets).length > 0, true, 'secret-bearing fields should be detected');
assert.equal(validateReceipt(secrets).ok, false, 'secret-bearing fields should fail');

console.log('continuation-readiness: PASS');
