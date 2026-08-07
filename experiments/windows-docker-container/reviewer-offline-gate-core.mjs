#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const SCHEMA = 'labview-benchmark-actor/windows-reviewer-offline-gate@1';

const REQUIRED_CASE_IDS = ['TC-00', 'TC-01', 'TC-02', 'TC-03', 'TC-06', 'TC-08', 'TC-09', 'TC-10'];
const ALLOWED_NOT_RUN_CASE_IDS = ['TC-04', 'TC-05', 'TC-07', 'TC-11'];
const ALL_CASE_IDS = [...REQUIRED_CASE_IDS, ...ALLOWED_NOT_RUN_CASE_IDS];
const ALLOWED_NOT_RUN_REASONS = new Set(['GitHub auth/bus', 'lbabus', 'Copilot agent auth']);
const VALID_CASE_STATUSES = new Set(['PASS', 'FAIL', 'NOT-RUN']);
const VALID_AGGREGATES = new Set(['PASS', 'PASS-WITH-NOTES', 'FAIL']);
const VALID_VERDICT_LOCATIONS = new Set(['host', 'host-and-guest', 'guest']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

function ruleFail(code, label, message) {
  throw new Error(`${code}: ${label}: ${message}`);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(label, 'is required');
  return value.trim();
}

function optionalText(value, label) {
  if (value === undefined || value === null) return null;
  return requiredText(value, label);
}

function bool(value, label) {
  if (typeof value !== 'boolean') fail(label, 'must be a boolean');
  return value;
}

function integer(value, label, min = 0) {
  if (!Number.isInteger(value) || value < min) fail(label, `must be an integer >= ${min}`);
  return value;
}

function finiteNumber(value, label, min = Number.NEGATIVE_INFINITY) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    fail(label, `must be a finite number >= ${min}`);
  }
  return value;
}

function uuid(value, label) {
  const normalized = requiredText(value, label).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    fail(label, 'must be a UUID');
  }
  return normalized;
}

function isoTime(value, label) {
  const normalized = requiredText(value, label);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) fail(label, 'must be an ISO-8601 timestamp');
  return new Date(parsed).toISOString();
}

function isoDate(value, label) {
  const normalized = requiredText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) fail(label, 'must be YYYY-MM-DD');
  return normalized;
}

function absolutePath(value, label) {
  const normalized = requiredText(value, label);
  if (!path.win32.isAbsolute(normalized) && !path.posix.isAbsolute(normalized)) {
    fail(label, 'must be an absolute path');
  }
  return normalized;
}

function compareIso(a, b) {
  return Date.parse(a) - Date.parse(b);
}

function normalizeArtifactRef(ref, label) {
  if (!isRecord(ref)) fail(label, 'must be an object');
  return {
    path: requiredText(ref.path, `${label}.path`),
    size: integer(ref.size, `${label}.size`, 1),
    sha256: requiredText(ref.sha256, `${label}.sha256`).toLowerCase(),
    role: ref.role === undefined || ref.role === null ? null : requiredText(ref.role, `${label}.role`),
  };
}

function normalizeArtifactRefs(list, label) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail(label, 'must be an array');
  return list.map((ref, index) => normalizeArtifactRef(ref, `${label}[${index}]`));
}

function normalizeReceiptCase(raw) {
  if (!isRecord(raw)) fail('cases[]', 'must be an object');
  const id = requiredText(raw.id, 'cases[].id');
  const status = requiredText(raw.status, `cases[${id}].status`).toUpperCase();
  if (!VALID_CASE_STATUSES.has(status)) {
    ruleFail('unsupported-unverified-distinction', `cases[${id}].status`, 'must be PASS, FAIL, or NOT-RUN');
  }
  const startedAt = isoTime(raw.startedAt, `cases[${id}].startedAt`);
  const finishedAt = isoTime(raw.finishedAt, `cases[${id}].finishedAt`);
  if (compareIso(finishedAt, startedAt) < 0) fail(`cases[${id}].finishedAt`, 'must be on or after startedAt');
  const visual = bool(raw.visual, `cases[${id}].visual`);
  const notes = raw.notes === undefined || raw.notes === null
    ? ''
    : typeof raw.notes === 'string'
      ? raw.notes.trim()
      : fail(`cases[${id}].notes`, 'must be a string');
  const evidenceRefs = normalizeArtifactRefs(raw.evidenceRefs, `cases[${id}].evidenceRefs`);
  const screenshotRefs = normalizeArtifactRefs(raw.screenshotRefs, `cases[${id}].screenshotRefs`);
  const prerequisiteReason = raw.prerequisiteReason === undefined || raw.prerequisiteReason === null
    ? null
    : requiredText(raw.prerequisiteReason, `cases[${id}].prerequisiteReason`);
  const details = raw.details === undefined || raw.details === null
    ? null
    : isRecord(raw.details)
      ? raw.details
      : fail(`cases[${id}].details`, 'must be an object');

  if (REQUIRED_CASE_IDS.includes(id)) {
    if (status !== 'PASS' && status !== 'FAIL') {
      ruleFail('invalid-not-run', `cases[${id}].status`, 'required cases must be PASS or FAIL');
    }
    if (prerequisiteReason !== null) {
      ruleFail('invalid-not-run', `cases[${id}].prerequisiteReason`, 'required cases must not declare a not-run reason');
    }
    if (evidenceRefs.length === 0) {
      ruleFail('missing-required-case', `cases[${id}].evidenceRefs`, 'required cases need immutable evidence refs');
    }
  } else if (ALLOWED_NOT_RUN_CASE_IDS.includes(id)) {
    if (status !== 'NOT-RUN') {
      ruleFail('invalid-not-run', `cases[${id}].status`, 'allowed not-run cases must be NOT-RUN');
    }
    if (!ALLOWED_NOT_RUN_REASONS.has(prerequisiteReason)) {
      ruleFail('invalid-not-run', `cases[${id}].prerequisiteReason`, 'must be GitHub auth/bus, lbabus, or Copilot agent auth');
    }
  } else {
    fail(`cases[${id}].id`, 'is not permitted');
  }

  if (visual && screenshotRefs.length === 0) {
    ruleFail('missing-screenshot', `cases[${id}].screenshotRefs`, 'visual cases need at least one screenshot ref');
  }

  return {
    id,
    status,
    startedAt,
    finishedAt,
    visual,
    notes,
    evidenceRefs,
    screenshotRefs,
    prerequisiteReason,
    details,
  };
}

function normalizeSignoff(raw) {
  if (!isRecord(raw)) fail('signoff', 'is required');
  const identity = requiredText(raw.identity, 'signoff.identity');
  const date = isoDate(raw.date, 'signoff.date');
  const provider = requiredText(raw.provider, 'signoff.provider');
  const windows = requiredText(raw.windows, 'signoff.windows');
  const extension = requiredText(raw.extension, 'signoff.extension');
  const labview = requiredText(raw.labview, 'signoff.labview');
  const aggregate = requiredText(raw.aggregate, 'signoff.aggregate').toUpperCase();
  const timestamp = isoTime(raw.timestamp, 'signoff.timestamp');
  const notes = raw.notes === undefined || raw.notes === null
    ? ''
    : typeof raw.notes === 'string'
      ? raw.notes.trim()
      : fail('signoff.notes', 'must be a string');
  if (!VALID_AGGREGATES.has(aggregate)) fail('signoff.aggregate', 'must be PASS, PASS-WITH-NOTES, or FAIL');
  if (date !== timestamp.slice(0, 10)) {
    fail('signoff.date', 'must match the date portion of signoff.timestamp');
  }
  return {
    identity,
    date,
    provider,
    windows,
    extension,
    labview,
    aggregate,
    timestamp,
    notes,
  };
}

function normalizeVerdict(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) fail('verdict', 'must be an object when present');
  const status = requiredText(raw.status, 'verdict.status').toUpperCase();
  if (!VALID_AGGREGATES.has(status)) {
    ruleFail('unsupported-unverified-distinction', 'verdict.status', 'must be PASS, PASS-WITH-NOTES, or FAIL');
  }
  const location = raw.location === undefined || raw.location === null
    ? 'host'
    : requiredText(raw.location, 'verdict.location');
  if (!VALID_VERDICT_LOCATIONS.has(location)) fail('verdict.location', 'must be host, host-and-guest, or guest');
  const evidenceRefs = normalizeArtifactRefs(raw.evidenceRefs, 'verdict.evidenceRefs');
  if (evidenceRefs.length === 0) fail('verdict.evidenceRefs', 'must contain at least one immutable evidence ref');
  return { status, location, evidenceRefs };
}

function normalizeHostFinalization(raw) {
  if (!isRecord(raw)) ruleFail('missing-host-finalization-proof', 'hostFinalization', 'is required');
  const completedAt = isoTime(raw.completedAt, 'hostFinalization.completedAt');
  const cacheRestoredAt = isoTime(raw.cacheRestoredAt, 'hostFinalization.cacheRestoredAt');
  const lockReleasedAt = isoTime(raw.lockReleasedAt, 'hostFinalization.lockReleasedAt');
  const snapshotRestoredAt = isoTime(raw.snapshotRestoredAt, 'hostFinalization.snapshotRestoredAt');
  const cacheRestored = bool(raw.cacheRestored, 'hostFinalization.cacheRestored');
  const lockReleased = bool(raw.lockReleased, 'hostFinalization.lockReleased');
  const evidenceRefs = normalizeArtifactRefs(raw.evidenceRefs, 'hostFinalization.evidenceRefs');
  if (evidenceRefs.length === 0) {
    ruleFail('missing-host-finalization-proof', 'hostFinalization.evidenceRefs', 'must contain at least one immutable proof ref');
  }
  if (!cacheRestored || !lockReleased) {
    ruleFail('missing-host-finalization-proof', 'hostFinalization', 'cacheRestored and lockReleased must both be true');
  }
  const vmName = raw.vmName === undefined || raw.vmName === null ? null : requiredText(raw.vmName, 'hostFinalization.vmName');
  const vmUuid = raw.vmUuid === undefined || raw.vmUuid === null ? null : uuid(raw.vmUuid, 'hostFinalization.vmUuid');
  const hardwareUuid = raw.hardwareUuid === undefined || raw.hardwareUuid === null
    ? null
    : uuid(raw.hardwareUuid, 'hostFinalization.hardwareUuid');
  const snapshotUuid = raw.snapshotUuid === undefined || raw.snapshotUuid === null
    ? null
    : uuid(raw.snapshotUuid, 'hostFinalization.snapshotUuid');
  const cachePath = raw.cachePath === undefined || raw.cachePath === null ? null : absolutePath(raw.cachePath, 'hostFinalization.cachePath');
  const lockPath = raw.lockPath === undefined || raw.lockPath === null ? null : absolutePath(raw.lockPath, 'hostFinalization.lockPath');

  if (compareIso(snapshotRestoredAt, completedAt) < 0) {
    ruleFail('snapshot-restored-before-host-finalization', 'hostFinalization.snapshotRestoredAt', 'must not be earlier than hostFinalization.completedAt');
  }
  if (compareIso(cacheRestoredAt, completedAt) < 0 || compareIso(lockReleasedAt, completedAt) < 0) {
    ruleFail('missing-host-finalization-proof', 'hostFinalization', 'cache and lock release timestamps must follow finalization');
  }

  return {
    completedAt,
    cacheRestoredAt,
    lockReleasedAt,
    snapshotRestoredAt,
    cacheRestored,
    lockReleased,
    evidenceRefs,
    vmName,
    vmUuid,
    hardwareUuid,
    snapshotUuid,
    cachePath,
    lockPath,
  };
}

function normalizeLiveChecks(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return {};
  if (!isRecord(raw)) fail('liveChecks', 'must be an object or false when present');
  return {
    vmName: raw.vmName === undefined || raw.vmName === null ? null : requiredText(raw.vmName, 'liveChecks.vmName'),
    vmUuid: raw.vmUuid === undefined || raw.vmUuid === null ? null : uuid(raw.vmUuid, 'liveChecks.vmUuid'),
    hardwareUuid: raw.hardwareUuid === undefined || raw.hardwareUuid === null ? null : uuid(raw.hardwareUuid, 'liveChecks.hardwareUuid'),
    snapshotUuid: raw.snapshotUuid === undefined || raw.snapshotUuid === null ? null : uuid(raw.snapshotUuid, 'liveChecks.snapshotUuid'),
    cachePath: raw.cachePath === undefined || raw.cachePath === null ? null : absolutePath(raw.cachePath, 'liveChecks.cachePath'),
    lockPath: raw.lockPath === undefined || raw.lockPath === null ? null : absolutePath(raw.lockPath, 'liveChecks.lockPath'),
  };
}

function normalizeReceipt(receipt) {
  if (!isRecord(receipt)) fail('receipt', 'must be an object');
  if (receipt.schema !== SCHEMA) fail('schema', `must be ${SCHEMA}`);

  const signoff = normalizeSignoff(receipt.signoff);
  const verdict = normalizeVerdict(receipt.verdict);
  const hostFinalization = normalizeHostFinalization(receipt.hostFinalization);
  const liveChecks = normalizeLiveChecks(receipt.liveChecks);
  const vm = isRecord(receipt.vm) ? receipt.vm : fail('vm', 'is required');
  const vmExactUuid = uuid(vm.exactUuid, 'vm.exactUuid');
  const vmHardwareUuid = uuid(vm.hardwareUuid, 'vm.hardwareUuid');
  const vmName = vm.name === undefined || vm.name === null ? null : requiredText(vm.name, 'vm.name');

  const cases = Array.isArray(receipt.cases) ? receipt.cases.map(normalizeReceiptCase) : fail('cases', 'is required');
  const caseMap = new Map();
  for (const item of cases) {
    if (caseMap.has(item.id)) fail(`cases[${item.id}]`, 'duplicate case id');
    caseMap.set(item.id, item);
  }
  for (const id of ALL_CASE_IDS) {
    if (!caseMap.has(id)) {
      ruleFail('missing-required-case', 'cases', `must include ${id}`);
    }
  }

  const orderedCases = ALL_CASE_IDS.map((id) => caseMap.get(id));
  const materialNotes = orderedCases
    .filter((item) => REQUIRED_CASE_IDS.includes(item.id))
    .some((item) => item.notes.trim().length > 0) || signoff.notes.trim().length > 0;
  const requiredFailures = orderedCases.filter((item) => REQUIRED_CASE_IDS.includes(item.id) && item.status === 'FAIL').map((item) => item.id);
  const requiredPasses = orderedCases.filter((item) => REQUIRED_CASE_IDS.includes(item.id) && item.status === 'PASS').map((item) => item.id);

  const tc09 = caseMap.get('TC-09');
  const tc10 = caseMap.get('TC-10');
  if (tc09.status === 'PASS') validateTc09(tc09, { vmExactUuid, vmHardwareUuid });
  if (tc10.status === 'PASS') validateTc10(tc10);

  if (verdict?.location === 'guest') {
    ruleFail('verdict-stored-only-in-guest', 'verdict.location', 'must not be guest-only');
  }
  if (verdict && verdict.status !== signoff.aggregate) {
    ruleFail('contradictory-verdict', 'verdict.status', 'must match signoff.aggregate');
  }

  const derivedAggregate = requiredFailures.length > 0
    ? 'FAIL'
    : materialNotes
      ? 'PASS-WITH-NOTES'
      : 'PASS';
  if (signoff.aggregate !== derivedAggregate) {
    ruleFail('contradictory-aggregate', 'signoff.aggregate', `must be ${derivedAggregate}`);
  }

  if (hostFinalization.completedAt > signoff.timestamp
    || hostFinalization.cacheRestoredAt > signoff.timestamp
    || hostFinalization.lockReleasedAt > signoff.timestamp
    || hostFinalization.snapshotRestoredAt > signoff.timestamp) {
    ruleFail('evidence-after-signoff', 'hostFinalization', 'host finalization evidence must not be after signoff');
  }
  for (const item of orderedCases) {
    if (item.finishedAt > signoff.timestamp) {
      ruleFail('evidence-after-signoff', `cases[${item.id}].finishedAt`, 'case evidence must not be after signoff');
    }
  }

  return {
    schema: SCHEMA,
    signoff,
    verdict,
    hostFinalization,
    liveChecks,
    vm: {
      exactUuid: vmExactUuid,
      hardwareUuid: vmHardwareUuid,
      name: vmName,
    },
    cases: orderedCases,
    requiredFailures,
    requiredPasses,
    materialNotes,
    derivedAggregate,
  };
}

function validateTc09(caseObj, { vmExactUuid, vmHardwareUuid }) {
  const details = caseObj.details;
  if (!isRecord(details)) ruleFail('missing-mprr', 'cases[TC-09].details', 'is required');
  const activation = isRecord(details.activation) ? details.activation : ruleFail('missing-mprr', 'cases[TC-09].details.activation', 'is required');
  const mprr = isRecord(details.mprr) ? details.mprr : ruleFail('missing-mprr', 'cases[TC-09].details.mprr', 'is required');
  const evidenceRoles = new Set(caseObj.evidenceRefs.map((ref) => ref.role));
  if (!evidenceRoles.has('mprr-receipt') || !evidenceRoles.has('mprr-manifest')) {
    ruleFail('missing-mprr', 'cases[TC-09].evidenceRefs', 'must include immutable receipt and manifest refs');
  }

  const exactVmUuid = uuid(activation.exactVmUuid, 'cases[TC-09].details.activation.exactVmUuid');
  const hardwareUuid = uuid(activation.hardwareUuid, 'cases[TC-09].details.activation.hardwareUuid');
  const fresh = bool(activation.fresh, 'cases[TC-09].details.activation.fresh');
  if (!fresh) ruleFail('missing-mprr', 'cases[TC-09].details.activation.fresh', 'must be true');
  if (exactVmUuid !== vmExactUuid || hardwareUuid !== vmHardwareUuid) {
    ruleFail('stale-vm-uuid', 'cases[TC-09].details.activation', 'must use the fresh exact VM UUID and hardware UUID');
  }

  const receipt = isRecord(mprr.receipt) ? mprr.receipt : ruleFail('missing-mprr', 'cases[TC-09].details.mprr.receipt', 'is required');
  const manifest = isRecord(mprr.manifest) ? mprr.manifest : ruleFail('missing-mprr', 'cases[TC-09].details.mprr.manifest', 'is required');
  for (const [label, value] of [['receipt', receipt], ['manifest', manifest]]) {
    const vmUuid = uuid(value.vmUuid, `cases[TC-09].details.mprr.${label}.vmUuid`);
    const hwUuid = uuid(value.hardwareUuid, `cases[TC-09].details.mprr.${label}.hardwareUuid`);
    const activated = bool(value.activated, `cases[TC-09].details.mprr.${label}.activated`);
    const freshRecord = bool(value.fresh, `cases[TC-09].details.mprr.${label}.fresh`);
    const launchMs = finiteNumber(value.launchMs, `cases[TC-09].details.mprr.${label}.launchMs`, 0);
    const settleMs = finiteNumber(value.settleMs, `cases[TC-09].details.mprr.${label}.settleMs`, 0);
    if (settleMs < launchMs) fail(`cases[TC-09].details.mprr.${label}.settleMs`, 'must be on or after launchMs');
    const resourceSamples = Array.isArray(value.resourceSamples)
      ? value.resourceSamples
      : fail(`cases[TC-09].details.mprr.${label}.resourceSamples`, 'must be an array');
    if (resourceSamples.length === 0) ruleFail('missing-mprr', `cases[TC-09].details.mprr.${label}.resourceSamples`, 'must not be empty');
    for (const [index, sample] of resourceSamples.entries()) {
      if (!isRecord(sample)) fail(`cases[TC-09].details.mprr.${label}.resourceSamples[${index}]`, 'must be an object');
      finiteNumber(sample.ms, `cases[TC-09].details.mprr.${label}.resourceSamples[${index}].ms`, 0);
      finiteNumber(sample.cpuPct, `cases[TC-09].details.mprr.${label}.resourceSamples[${index}].cpuPct`, 0);
      finiteNumber(sample.ramMb, `cases[TC-09].details.mprr.${label}.resourceSamples[${index}].ramMb`, 0);
      if (sample.diskPct !== undefined && sample.diskPct !== null) {
        finiteNumber(sample.diskPct, `cases[TC-09].details.mprr.${label}.resourceSamples[${index}].diskPct`, 0);
      }
    }
    if (!activated || !freshRecord) {
      ruleFail('missing-mprr', `cases[TC-09].details.mprr.${label}`, 'receipt/manifest must be fresh and activated');
    }
    if (vmUuid !== vmExactUuid || hwUuid !== vmHardwareUuid) {
      ruleFail('stale-vm-uuid', `cases[TC-09].details.mprr.${label}`, 'must match the fresh exact VM UUID');
    }
  }
}

function validateTc10(caseObj) {
  const details = caseObj.details;
  if (!isRecord(details)) ruleFail('stale-cache', 'cases[TC-10].details', 'is required');
  const mcp = isRecord(details.mcp) ? details.mcp : ruleFail('stale-cache', 'cases[TC-10].details.mcp', 'is required');
  const evidenceRoles = new Set(caseObj.evidenceRefs.map((ref) => ref.role));
  if (!evidenceRoles.has('mcp-reset') && !evidenceRoles.has('mcp-server-restart')) {
    ruleFail('missing-tc10-evidence', 'cases[TC-10].evidenceRefs', 'must include mcp-reset or mcp-server-restart');
  }
  for (const role of ['vscode-restart', 'server-discovery', 'tool-discovery', 'benchmark-series-call']) {
    if (!evidenceRoles.has(role)) {
      ruleFail('missing-tc10-evidence', `cases[TC-10].evidenceRefs`, `must include ${role}`);
    }
  }
  const cachedToolsReset = mcp.cachedToolsReset === undefined
    ? false
    : bool(mcp.cachedToolsReset, 'cases[TC-10].details.mcp.cachedToolsReset');
  const serverRestarted = mcp.serverRestarted === undefined
    ? false
    : bool(mcp.serverRestarted, 'cases[TC-10].details.mcp.serverRestarted');
  const fullVscodeRestart = bool(mcp.fullVscodeRestart, 'cases[TC-10].details.mcp.fullVscodeRestart');
  const cacheFresh = bool(mcp.cacheFresh, 'cases[TC-10].details.mcp.cacheFresh');
  if ((!cachedToolsReset && !serverRestarted) || !fullVscodeRestart || !cacheFresh) {
    ruleFail('stale-cache', 'cases[TC-10].details.mcp', 'server/cache refresh, full VS Code restart, and cache freshness are required');
  }
  const serverDiscovery = isRecord(mcp.serverDiscovery) ? mcp.serverDiscovery : ruleFail('missing-tc10-evidence', 'cases[TC-10].details.mcp.serverDiscovery', 'is required');
  const toolDiscovery = isRecord(mcp.toolDiscovery) ? mcp.toolDiscovery : ruleFail('missing-tc10-evidence', 'cases[TC-10].details.mcp.toolDiscovery', 'is required');
  const benchmarkSeriesCall = isRecord(mcp.benchmarkSeriesCall) ? mcp.benchmarkSeriesCall : ruleFail('missing-tc10-evidence', 'cases[TC-10].details.mcp.benchmarkSeriesCall', 'is required');

  const serverItems = Array.isArray(serverDiscovery.items) ? serverDiscovery.items : fail('cases[TC-10].details.mcp.serverDiscovery.items', 'must be an array');
  const toolItems = Array.isArray(toolDiscovery.items) ? toolDiscovery.items : fail('cases[TC-10].details.mcp.toolDiscovery.items', 'must be an array');
  if (serverItems.length === 0 || toolItems.length === 0) {
    ruleFail('missing-tc10-evidence', 'cases[TC-10].details.mcp', 'server/tool discovery must include at least one item');
  }
  const benchmarkSeries = requiredText(benchmarkSeriesCall.series, 'cases[TC-10].details.mcp.benchmarkSeriesCall.series');
  const benchmarkCalled = bool(benchmarkSeriesCall.called, 'cases[TC-10].details.mcp.benchmarkSeriesCall.called');
  if (!benchmarkCalled) ruleFail('missing-tc10-evidence', 'cases[TC-10].details.mcp.benchmarkSeriesCall.called', 'must be true');
  if (benchmarkSeries.length === 0) ruleFail('missing-tc10-evidence', 'cases[TC-10].details.mcp.benchmarkSeriesCall.series', 'must be non-empty');
}

function normalizeLiveCheckTargets(normalized, liveChecks) {
  if (liveChecks === true) {
    return {
      vmName: normalized.hostFinalization.vmName ?? normalized.vm.name,
      vmUuid: normalized.hostFinalization.vmUuid ?? normalized.vm.exactUuid,
      hardwareUuid: normalized.hostFinalization.hardwareUuid ?? normalized.vm.hardwareUuid,
      snapshotUuid: normalized.hostFinalization.snapshotUuid,
      cachePath: normalized.hostFinalization.cachePath,
      lockPath: normalized.hostFinalization.lockPath,
    };
  }
  if (!isRecord(liveChecks)) return null;
  return {
    vmName: liveChecks.vmName === undefined ? null : requiredText(liveChecks.vmName, 'liveChecks.vmName'),
    vmUuid: liveChecks.vmUuid === undefined ? null : uuid(liveChecks.vmUuid, 'liveChecks.vmUuid'),
    hardwareUuid: liveChecks.hardwareUuid === undefined ? null : uuid(liveChecks.hardwareUuid, 'liveChecks.hardwareUuid'),
    snapshotUuid: liveChecks.snapshotUuid === undefined ? null : uuid(liveChecks.snapshotUuid, 'liveChecks.snapshotUuid'),
    cachePath: liveChecks.cachePath === undefined ? null : absolutePath(liveChecks.cachePath, 'liveChecks.cachePath'),
    lockPath: liveChecks.lockPath === undefined ? null : absolutePath(liveChecks.lockPath, 'liveChecks.lockPath'),
  };
}

function parseVBoxManageMachineReadable(textValue) {
  const values = {};
  for (const line of String(textValue).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = /^([^=]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    values[match[1]] = value;
  }
  return values;
}

function lookupMachineReadable(values, ...keys) {
  const lowered = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lowered.get(key.toLowerCase());
    if (value !== undefined) return value;
  }
  return undefined;
}

function runCommand(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${String(result.stderr ?? result.stdout ?? '').trim() || `exit ${result.status}`}`);
  }
  return String(result.stdout ?? '');
}

function verifyLiveChecks(liveChecks) {
  if (!liveChecks) return [];
  const checks = [];
  if (liveChecks.vmName && liveChecks.vmUuid) {
    const info = parseVBoxManageMachineReadable(runCommand('VBoxManage', ['showvminfo', liveChecks.vmName, '--machinereadable']));
    const actualUuid = requiredText(lookupMachineReadable(info, 'UUID', 'uuid'), 'liveChecks.vmUuid').replaceAll('"', '').toLowerCase();
    const actualHardwareUuid = requiredText(
      lookupMachineReadable(info, 'HardwareUUID', 'hardwareuuid', 'HWUUID'),
      'liveChecks.hardwareUuid',
    ).replaceAll('"', '').toLowerCase();
    const actualState = requiredText(lookupMachineReadable(info, 'VMState', 'vmstate'), 'liveChecks.VMState').toLowerCase();
    if (actualUuid !== liveChecks.vmUuid) ruleFail('stale-vm-uuid', 'liveChecks.vmUuid', 'VM UUID does not match VBoxManage');
    if (liveChecks.hardwareUuid && actualHardwareUuid !== liveChecks.hardwareUuid) {
      ruleFail('stale-vm-uuid', 'liveChecks.hardwareUuid', 'hardware UUID does not match VBoxManage');
    }
    if (actualState !== 'poweroff') fail('liveChecks.vmState', `must be poweroff, got ${actualState}`);
    checks.push({ type: 'provider-vm', vmName: liveChecks.vmName, vmUuid: actualUuid, hardwareUuid: actualHardwareUuid, state: actualState });
  }
  if (liveChecks.vmName && liveChecks.snapshotUuid) {
    const raw = runCommand('VBoxManage', ['snapshot', liveChecks.vmName, 'list', '--machinereadable']);
    const parsed = parseVBoxManageMachineReadable(raw);
    const values = Object.values(parsed).map((value) => String(value).toLowerCase());
    if (!values.includes(liveChecks.snapshotUuid)) {
      ruleFail('stale-cache', 'liveChecks.snapshotUuid', 'snapshot UUID is absent');
    }
    checks.push({ type: 'snapshot', vmName: liveChecks.vmName, snapshotUuid: liveChecks.snapshotUuid });
  }
  if (liveChecks.cachePath) {
    if (!existsSync(liveChecks.cachePath)) {
      ruleFail('missing-host-finalization-proof', 'liveChecks.cachePath', 'cache path must exist when live checking');
    }
    checks.push({ type: 'cache', cachePath: liveChecks.cachePath });
  }
  if (liveChecks.lockPath) {
    if (existsSync(liveChecks.lockPath)) {
      ruleFail('missing-host-finalization-proof', 'liveChecks.lockPath', 'lock path must be absent when live checking');
    }
    checks.push({ type: 'lock', lockPath: liveChecks.lockPath, absent: true });
  }
  return checks;
}

function collectEvidenceRefs(normalized) {
  const refs = [];
  for (const item of normalized.cases) {
    refs.push(...item.evidenceRefs);
    refs.push(...item.screenshotRefs);
  }
  refs.push(...normalized.hostFinalization.evidenceRefs);
  if (normalized.verdict) refs.push(...normalized.verdict.evidenceRefs);
  const deduped = new Map();
  for (const ref of refs) {
    if (!ref) continue;
    deduped.set(`${ref.path}\u0000${ref.sha256}`, ref);
  }
  return [...deduped.values()];
}

async function verifyArtifact(ref, baseDir) {
  const absolute = path.isAbsolute(ref.path) ? ref.path : path.resolve(baseDir, ref.path);
  const stat = statSync(absolute);
  if (stat.size !== ref.size) {
    throw new Error(`${ref.path}: size mismatch (expected ${ref.size}, got ${stat.size})`);
  }
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(absolute);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const actual = hash.digest('hex');
  if (actual !== ref.sha256) throw new Error(`${ref.path}: SHA-256 mismatch`);
  if (ref.path.toLowerCase().endsWith('.json')) {
    JSON.parse(readFileSync(absolute, 'utf8'));
  }
  return { path: ref.path, size: stat.size, sha256: actual, role: ref.role };
}

export function evaluateReviewerOfflineGateReceipt(receipt) {
  const normalized = normalizeReceipt(receipt);
  const hasFailedRequired = normalized.requiredFailures.length > 0;
  if (hasFailedRequired) {
    return {
      schema: SCHEMA,
      status: 'failed',
      reason: 'required-case-failed',
      signoff: normalized.signoff,
      verdict: normalized.verdict,
      hostFinalization: normalized.hostFinalization,
      vm: normalized.vm,
      cases: normalized.cases,
      requiredFailures: normalized.requiredFailures,
      requiredPasses: normalized.requiredPasses,
      materialNotes: normalized.materialNotes,
      liveChecks: [],
    };
  }
  return {
    schema: SCHEMA,
    status: normalized.derivedAggregate === 'PASS-WITH-NOTES' ? 'passed-with-notes' : 'passed',
    reason: normalized.derivedAggregate === 'PASS-WITH-NOTES'
      ? 'reviewer-offline-gate-ready-with-notes'
      : 'reviewer-offline-gate-ready',
    signoff: normalized.signoff,
    verdict: normalized.verdict,
    hostFinalization: normalized.hostFinalization,
    vm: normalized.vm,
    cases: normalized.cases,
    requiredFailures: normalized.requiredFailures,
    requiredPasses: normalized.requiredPasses,
    materialNotes: normalized.materialNotes,
    liveChecks: [],
  };
}

export async function verifyReviewerOfflineGateReceipt(receipt, { baseDir = process.cwd(), live = false } = {}) {
  const normalized = normalizeReceipt(receipt);
  const artifacts = [];
  for (const ref of collectEvidenceRefs(normalized)) {
    artifacts.push(await verifyArtifact(ref, baseDir));
  }
  const liveChecks = live && receipt.liveChecks !== false && receipt.liveChecks !== null
    ? verifyLiveChecks(normalizeLiveCheckTargets(normalized, receipt.liveChecks))
    : [];
  const classification = evaluateReviewerOfflineGateReceipt(receipt);
  return {
    ...classification,
    artifacts,
    liveChecks,
  };
}
