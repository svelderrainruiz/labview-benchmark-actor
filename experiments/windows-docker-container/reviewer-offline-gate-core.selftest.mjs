#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SCHEMA,
  evaluateReviewerOfflineGateReceipt,
  verifyReviewerOfflineGateReceipt,
} from './reviewer-offline-gate-core.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scratchRoot = path.join(import.meta.dirname, 'evidence', 'reviewer-offline-gate-selftest');

const vmExactUuid = 'f296a95b-7470-496a-bab7-791c973efd37';
const hardwareUuid = '3e29a8af-ee1f-442f-8e28-2eaa07832786';
const snapshotUuid = '300812f7-ac50-47f6-b95a-973d7952fa76';

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function makeFile(relative, content) {
  const file = path.join(scratchRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  const raw = Buffer.isBuffer(content)
    ? content
    : typeof content === 'string'
      ? Buffer.from(content)
      : Buffer.from(`${JSON.stringify(content, null, 2)}\n`);
  writeFileSync(file, raw);
  return { file, raw };
}

function ref(relative, content, role) {
  const { file, raw } = makeFile(relative, content);
  return {
    path: file,
    size: raw.length,
    sha256: digest(raw),
    role,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildValidReceipt(overrides = {}) {
  const tc00Screenshot = ref('tc00.png', 'tc00-screenshot', 'screenshot');
  const tc01Screenshot = ref('tc01.png', 'tc01-screenshot', 'screenshot');
  const tc02Screenshot = ref('tc02.png', 'tc02-screenshot', 'screenshot');
  const tc03Screenshot = ref('tc03.png', 'tc03-screenshot', 'screenshot');
  const tc06Evidence = ref('tc06.json', { case: 'TC-06', status: 'PASS' }, 'evidence');
  const tc08Screenshot = ref('tc08.png', 'tc08-screenshot', 'screenshot');
  const tc09Screenshot = ref('tc09.png', 'tc09-screenshot', 'screenshot');
  const tc09ReceiptRef = ref('tc09-mprr-receipt.json', {
    vmUuid: vmExactUuid,
    hardwareUuid,
    activated: true,
    fresh: true,
    launchMs: 18.5,
    settleMs: 42.25,
    resourceSamples: [{ ms: 1, cpuPct: 11.5, ramMb: 512 }],
  }, 'mprr-receipt');
  const tc09ManifestRef = ref('tc09-mprr-manifest.json', {
    vmUuid: vmExactUuid,
    hardwareUuid,
    activated: true,
    fresh: true,
    launchMs: 18.5,
    settleMs: 42.25,
    resourceSamples: [{ ms: 1, cpuPct: 11.5, ramMb: 512 }],
  }, 'mprr-manifest');
  const tc10Screenshot = ref('tc10.png', 'tc10-screenshot', 'screenshot');
  const tc10ResetRef = ref('tc10-reset.json', { cachedToolsReset: true }, 'mcp-reset');
  const tc10RestartRef = ref('tc10-restart.json', { fullVscodeRestart: true }, 'vscode-restart');
  const tc10ServerRef = ref('tc10-server.json', { items: ['server-a'] }, 'server-discovery');
  const tc10ToolRef = ref('tc10-tool.json', { items: ['tool-a'] }, 'tool-discovery');
  const tc10BenchmarkRef = ref('tc10-benchmark.json', { series: 'benchmark-series', called: true }, 'benchmark-series-call');
  const notRun04 = ref('tc04.json', { reason: 'GitHub auth/bus' }, 'prereq-note');
  const notRun05 = ref('tc05.json', { reason: 'lbabus' }, 'prereq-note');
  const notRun07 = ref('tc07.json', { reason: 'Copilot agent auth' }, 'prereq-note');
  const notRun11 = ref('tc11.json', { reason: 'GitHub auth/bus' }, 'prereq-note');
  const verdictRef = ref('verdict.json', { status: 'PASS', location: 'host' }, 'verdict');
  const hostFinalizationRef = ref('host-finalization.json', { completed: true }, 'host-finalization');
  const cacheRestoredRef = ref('cache-restored.json', { cacheRestored: true }, 'host-finalization');
  const lockReleasedRef = ref('lock-released.json', { lockReleased: true }, 'host-finalization');
  const snapshotRestoredRef = ref('snapshot-restored.json', { snapshotRestored: true }, 'host-finalization');

  return {
    schema: SCHEMA,
    vm: {
      name: 'actor-reviewer-local',
      exactUuid: vmExactUuid,
      hardwareUuid,
    },
    signoff: {
      identity: 'Copilot Reviewer',
      date: '2026-08-07',
      provider: 'Copilot CLI',
      windows: 'Windows 11 Pro 25H2',
      extension: 'LabVIEW reviewer extension 1.0',
      labview: 'LabVIEW 2026 Q3',
      aggregate: 'PASS',
      timestamp: '2026-08-07T19:00:00.000Z',
      notes: '',
    },
    verdict: {
      status: 'PASS',
      location: 'host',
      evidenceRefs: [verdictRef],
    },
    hostFinalization: {
      completedAt: '2026-08-07T18:30:00.000Z',
      cacheRestoredAt: '2026-08-07T18:31:00.000Z',
      lockReleasedAt: '2026-08-07T18:32:00.000Z',
      snapshotRestoredAt: '2026-08-07T18:33:00.000Z',
      cacheRestored: true,
      lockReleased: true,
      vmName: 'actor-reviewer-local',
      vmUuid: vmExactUuid,
      hardwareUuid,
      snapshotUuid,
      cachePath: path.join(repoRoot, 'evidence', 'reviewer-offline-gate-selftest-cache'),
      lockPath: path.join(repoRoot, 'locks', 'reviewer-offline-gate-selftest.lock'),
      evidenceRefs: [hostFinalizationRef, cacheRestoredRef, lockReleasedRef, snapshotRestoredRef],
    },
    liveChecks: false,
    cases: [
      {
        id: 'TC-00',
        status: 'PASS',
        startedAt: '2026-08-07T17:00:00.000Z',
        finishedAt: '2026-08-07T17:01:00.000Z',
        visual: true,
        notes: '',
        evidenceRefs: [tc00Screenshot],
        screenshotRefs: [tc00Screenshot],
      },
      {
        id: 'TC-01',
        status: 'PASS',
        startedAt: '2026-08-07T17:02:00.000Z',
        finishedAt: '2026-08-07T17:03:00.000Z',
        visual: true,
        notes: '',
        evidenceRefs: [tc01Screenshot],
        screenshotRefs: [tc01Screenshot],
      },
      {
        id: 'TC-02',
        status: 'PASS',
        startedAt: '2026-08-07T17:04:00.000Z',
        finishedAt: '2026-08-07T17:05:00.000Z',
        visual: true,
        notes: '',
        evidenceRefs: [tc02Screenshot],
        screenshotRefs: [tc02Screenshot],
      },
      {
        id: 'TC-03',
        status: 'PASS',
        startedAt: '2026-08-07T17:06:00.000Z',
        finishedAt: '2026-08-07T17:07:00.000Z',
        visual: true,
        notes: '',
        evidenceRefs: [tc03Screenshot],
        screenshotRefs: [tc03Screenshot],
      },
      {
        id: 'TC-06',
        status: 'PASS',
        startedAt: '2026-08-07T17:08:00.000Z',
        finishedAt: '2026-08-07T17:09:00.000Z',
        visual: false,
        notes: '',
        evidenceRefs: [tc06Evidence],
        screenshotRefs: [],
      },
      {
        id: 'TC-08',
        status: 'PASS',
        startedAt: '2026-08-07T17:10:00.000Z',
        finishedAt: '2026-08-07T17:11:00.000Z',
        visual: true,
        notes: '',
        evidenceRefs: [tc08Screenshot],
        screenshotRefs: [tc08Screenshot],
      },
      {
        id: 'TC-09',
        status: 'PASS',
        startedAt: '2026-08-07T17:12:00.000Z',
        finishedAt: '2026-08-07T17:13:00.000Z',
        visual: true,
        notes: '',
        evidenceRefs: [tc09ReceiptRef, tc09ManifestRef, tc09Screenshot],
        screenshotRefs: [tc09Screenshot],
        details: {
          activation: {
            exactVmUuid: vmExactUuid,
            hardwareUuid,
            fresh: true,
          },
          mprr: {
            receipt: {
              vmUuid: vmExactUuid,
              hardwareUuid,
              activated: true,
              fresh: true,
              launchMs: 18.5,
              settleMs: 42.25,
              resourceSamples: [{ ms: 1, cpuPct: 11.5, ramMb: 512 }],
            },
            manifest: {
              vmUuid: vmExactUuid,
              hardwareUuid,
              activated: true,
              fresh: true,
              launchMs: 18.5,
              settleMs: 42.25,
              resourceSamples: [{ ms: 1, cpuPct: 11.5, ramMb: 512 }],
            },
          },
        },
      },
      {
        id: 'TC-10',
        status: 'PASS',
        startedAt: '2026-08-07T17:14:00.000Z',
        finishedAt: '2026-08-07T17:15:00.000Z',
        visual: true,
        notes: '',
        evidenceRefs: [tc10ResetRef, tc10RestartRef, tc10ServerRef, tc10ToolRef, tc10BenchmarkRef, tc10Screenshot],
        screenshotRefs: [tc10Screenshot],
        details: {
          mcp: {
            cacheFresh: true,
            cachedToolsReset: true,
            fullVscodeRestart: true,
            serverDiscovery: { items: ['server-a'] },
            toolDiscovery: { items: ['tool-a'] },
            benchmarkSeriesCall: { series: 'benchmark-series', called: true },
          },
        },
      },
      {
        id: 'TC-04',
        status: 'NOT-RUN',
        startedAt: '2026-08-07T17:16:00.000Z',
        finishedAt: '2026-08-07T17:16:30.000Z',
        visual: false,
        notes: 'Prerequisite not available.',
        prerequisiteReason: 'GitHub auth/bus',
        evidenceRefs: [notRun04],
        screenshotRefs: [],
      },
      {
        id: 'TC-05',
        status: 'NOT-RUN',
        startedAt: '2026-08-07T17:17:00.000Z',
        finishedAt: '2026-08-07T17:17:30.000Z',
        visual: false,
        notes: 'Prerequisite not available.',
        prerequisiteReason: 'lbabus',
        evidenceRefs: [notRun05],
        screenshotRefs: [],
      },
      {
        id: 'TC-07',
        status: 'NOT-RUN',
        startedAt: '2026-08-07T17:18:00.000Z',
        finishedAt: '2026-08-07T17:18:30.000Z',
        visual: false,
        notes: 'Prerequisite not available.',
        prerequisiteReason: 'Copilot agent auth',
        evidenceRefs: [notRun07],
        screenshotRefs: [],
      },
      {
        id: 'TC-11',
        status: 'NOT-RUN',
        startedAt: '2026-08-07T17:19:00.000Z',
        finishedAt: '2026-08-07T17:19:30.000Z',
        visual: false,
        notes: 'Prerequisite not available.',
        prerequisiteReason: 'GitHub auth/bus',
        evidenceRefs: [notRun11],
        screenshotRefs: [],
      },
    ],
    ...overrides,
  };
}

function mutateCase(receipt, id, fn) {
  const next = clone(receipt);
  const item = next.cases.find((caseItem) => caseItem.id === id);
  fn(item, next);
  return next;
}

try {
  const passReceipt = buildValidReceipt();
  const pass = evaluateReviewerOfflineGateReceipt(passReceipt);
  assert.equal(pass.status, 'passed');
  assert.equal(pass.reason, 'reviewer-offline-gate-ready');
  const verifiedPass = await verifyReviewerOfflineGateReceipt(passReceipt, { baseDir: repoRoot, live: false });
  assert.equal(verifiedPass.status, 'passed');
  assert.equal(verifiedPass.artifacts.length > 0, true);

  const notesReceipt = mutateCase(passReceipt, 'TC-02', (item, next) => {
    item.notes = 'material note';
    next.signoff.aggregate = 'PASS-WITH-NOTES';
  });
  notesReceipt.verdict.status = 'PASS-WITH-NOTES';
  const withNotes = evaluateReviewerOfflineGateReceipt(notesReceipt);
  assert.equal(withNotes.status, 'passed-with-notes');

  const failReceipt = mutateCase(passReceipt, 'TC-06', (item, next) => {
    item.status = 'FAIL';
    next.signoff.aggregate = 'FAIL';
    next.verdict.status = 'FAIL';
  });
  const failed = evaluateReviewerOfflineGateReceipt(failReceipt);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'required-case-failed');

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-08', (item, next) => {
    next.cases = next.cases.filter((caseItem) => caseItem.id !== 'TC-08');
  })), /missing-required-case/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-05', (item) => {
    item.prerequisiteReason = 'GitHub tokens';
  })), /invalid-not-run/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-03', (item) => {
    item.screenshotRefs = [];
  })), /missing-screenshot/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-09', (item) => {
    delete item.details.mprr;
  })), /missing-mprr/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-09', (item, next) => {
    next.vm.exactUuid = 'f5de7ff5-d858-4f0e-9bab-3b2e252926b5';
  })), /stale-vm-uuid/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-10', (item) => {
    item.details.mcp.cachedToolsReset = false;
  })), /stale-cache/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-00', (item, next) => {
    next.verdict.status = 'FAIL';
  })), /contradictory-verdict/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-00', (item, next) => {
    next.signoff.aggregate = 'FAIL';
    next.verdict.status = 'FAIL';
  })), /contradictory-aggregate/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-00', (item, next) => {
    next.verdict.location = 'guest';
  })), /verdict-stored-only-in-guest/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt({
    ...clone(passReceipt),
    hostFinalization: undefined,
  }), /missing-host-finalization-proof/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-00', (item, next) => {
    next.hostFinalization.snapshotRestoredAt = '2026-08-07T18:29:00.000Z';
  })), /snapshot-restored-before-host-finalization/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-00', (item, next) => {
    item.finishedAt = '2026-08-07T19:30:00.000Z';
  })), /evidence-after-signoff/);

  assert.throws(() => evaluateReviewerOfflineGateReceipt(mutateCase(passReceipt, 'TC-01', (item) => {
    item.status = 'UNVERIFIED';
  })), /unsupported-unverified-distinction/);

  const tamperReceipt = buildValidReceipt();
  const tamperPass = await verifyReviewerOfflineGateReceipt(tamperReceipt, { baseDir: repoRoot, live: false });
  assert.equal(tamperPass.status, 'passed');
  writeFileSync(tamperReceipt.cases[0].evidenceRefs[0].path, 'tampered');
  await assert.rejects(
    () => verifyReviewerOfflineGateReceipt(tamperReceipt, { baseDir: repoRoot, live: false }),
    /size mismatch|SHA-256 mismatch/,
  );

  console.log('Windows reviewer offline gate core self-test: PASS');
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}
