import os from 'node:os';

export const VM_LIFECYCLE_SCHEMA = 'labview-benchmark-actor/windows-vm-lifecycle@1';

export const PHASE_ORDER = Object.freeze([
  'LIFECYCLE-OPEN',
  'MEDIA-VERIFIED',
  'VM-CREATE-START',
  'WINDOWS-PROVISION-START',
  'WINDOWS-INTERACTIVE-READY',
  'PRE-LABVIEW-SNAPSHOT',
  'LABVIEW-INSTALL-START',
  'LABVIEW-INSTALLED',
  'CAPTURE-PATH-READY',
  'DIAGNOSTIC-CAPTURE-START',
  'LABVIEW-SPLASH-VISIBLE',
  'ACTIVATION-REQUIRED',
  'CACHE-SEALED',
  'ACTIVATION-RESUME-START',
  'ACTIVATION-COMPLETE',
  'POST-ACTIVATION-CAPTURE-START',
  'LABVIEW-IDE-SETTLED',
  'REVIEWER-VSIX-STAGE-START',
  'REVIEWER-VSIX-INSTALLED',
  'REVIEWER-VSIX-RESTAGE-START',
  'REVIEWER-VSIX-RESTAGED',
  'REVIEWER-CACHE-SNAPSHOT',
  'REVIEWER-CACHE-READY',
  'BOX-PACKAGE-START',
  'BOX-REGISTERED',
  'LIFECYCLE-SEALED',
]);

export function hostClockSnapshot({
  wallNow = Date.now(),
  monotonicNs = process.hrtime.bigint(),
  uptimeSec = os.uptime(),
} = {}) {
  return {
    wallTime: new Date(wallNow).toISOString(),
    monotonicNs: monotonicNs.toString(),
    hostBootEpochMsApprox: Math.round((wallNow - uptimeSec * 1000) / 1000) * 1000,
    source: 'host process.hrtime.bigint + Date.now + os.uptime',
  };
}

export function createHistoricalLifecycle({ lifecycleId, vmName, detail }) {
  if (!lifecycleId || !vmName) throw new Error('lifecycleId and vmName are required');
  return {
    schema: VM_LIFECYCLE_SCHEMA,
    lifecycleId,
    vmName,
    createdWallTime: null,
    updatedWallTime: null,
    state: 'open',
    clockSegments: [],
    checkpoints: [historicalCheckpoint({
      phase: 'LIFECYCLE-OPEN',
      status: 'not-observed',
      detail,
    })],
    spans: [],
    cache: null,
    visualCapture: null,
    resume: null,
    completion: null,
    historicalCoverage: {
      preProvisionMonotonicStartObserved: false,
      note: detail,
    },
  };
}

export function sameHostBoot(a, b, toleranceMs = 5000) {
  return Math.abs(a.hostBootEpochMsApprox - b.hostBootEpochMsApprox) <= toleranceMs;
}

function phaseIndex(phase) {
  const index = PHASE_ORDER.indexOf(phase);
  if (index < 0) throw new Error(`unsupported VM lifecycle phase '${phase}'`);
  return index;
}

export function createLifecycle({
  lifecycleId,
  vmName,
  createdClock = hostClockSnapshot(),
  createdWallTime = createdClock.wallTime,
}) {
  if (!lifecycleId || !vmName) throw new Error('lifecycleId and vmName are required');
  const segment = {
    id: 'clock-0',
    t0WallTime: createdClock.wallTime,
    t0MonotonicNs: createdClock.monotonicNs,
    hostBootEpochMsApprox: createdClock.hostBootEpochMsApprox,
    clock: 'host-monotonic-100ns',
  };
  return {
    schema: VM_LIFECYCLE_SCHEMA,
    lifecycleId,
    vmName,
    createdWallTime,
    updatedWallTime: createdWallTime,
    state: 'open',
    clockSegments: [segment],
    checkpoints: [{
      phase: 'LIFECYCLE-OPEN',
      status: 'started',
      authority: 'live-dual-clock',
      wallTime: createdClock.wallTime,
      clockSegmentId: segment.id,
      monotonicNs: createdClock.monotonicNs,
      timingTicks64: '0',
      detail: 'Lifecycle opened before provisioning/cloning action.',
      evidence: [],
    }],
    spans: [],
    cache: null,
    visualCapture: null,
    resume: null,
    completion: null,
    historicalCoverage: {
      preProvisionMonotonicStartObserved: true,
      note: null,
    },
  };
}

function activeSegment(record, clock) {
  const latest = record.clockSegments.at(-1);
  if (latest && sameHostBoot(latest, clock)) return latest;
  const segment = {
    id: `clock-${record.clockSegments.length}`,
    t0WallTime: clock.wallTime,
    t0MonotonicNs: clock.monotonicNs,
    hostBootEpochMsApprox: clock.hostBootEpochMsApprox,
    clock: 'host-monotonic-100ns',
  };
  record.clockSegments.push(segment);
  return segment;
}

export function appendCheckpoint(record, {
  phase,
  status,
  detail = null,
  evidence = [],
  clock = hostClockSnapshot(),
}) {
  validateLifecycle(record, { allowOpen: true });
  if (record.state !== 'open') throw new Error('cannot append to a sealed lifecycle');
  const prior = record.checkpoints.at(-1);
  if (phaseIndex(phase) < phaseIndex(prior.phase)) {
    throw new Error(`lifecycle phase regressed from ${prior.phase} to ${phase}`);
  }
  const segment = activeSegment(record, clock);
  const deltaNs = BigInt(clock.monotonicNs) - BigInt(segment.t0MonotonicNs);
  if (deltaNs < 0n) throw new Error('host monotonic clock regressed');
  const checkpoint = {
    phase,
    status,
    authority: 'live-dual-clock',
    wallTime: clock.wallTime,
    clockSegmentId: segment.id,
    monotonicNs: clock.monotonicNs,
    timingTicks64: (deltaNs / 100n).toString(),
    detail,
    evidence,
  };
  record.checkpoints.push(checkpoint);
  record.updatedWallTime = clock.wallTime;
  if (prior.authority === 'live-dual-clock' && prior.clockSegmentId === checkpoint.clockSegmentId) {
    const ms = Number(BigInt(checkpoint.monotonicNs) - BigInt(prior.monotonicNs)) / 1e6;
    record.spans.push({
      id: `${prior.phase}->${checkpoint.phase}`,
      from: prior.phase,
      to: checkpoint.phase,
      clock: 'host',
      clockSegmentId: checkpoint.clockSegmentId,
      scope: 'within-host-boot',
      ms,
    });
  }
  return checkpoint;
}

export function historicalCheckpoint({ phase, status = 'completed', detail = null, evidence = [] }) {
  phaseIndex(phase);
  return {
    phase,
    status,
    authority: 'historical-state-proof',
    wallTime: null,
    clockSegmentId: null,
    monotonicNs: null,
    timingTicks64: null,
    detail,
    evidence,
  };
}

export function validateLifecycle(record, { allowOpen = false } = {}) {
  if (record?.schema !== VM_LIFECYCLE_SCHEMA) throw new Error('invalid VM lifecycle schema');
  if (!record.lifecycleId || !record.vmName) throw new Error('VM lifecycle identity is missing');
  if (!Array.isArray(record.checkpoints) || record.checkpoints.length === 0) throw new Error('VM lifecycle checkpoints are missing');
  let priorIndex = -1;
  const segments = new Map(record.clockSegments.map((segment) => [segment.id, segment]));
  for (const [index, checkpoint] of record.checkpoints.entries()) {
    const currentIndex = phaseIndex(checkpoint.phase);
    if (currentIndex < priorIndex) throw new Error(`checkpoint order regressed at ${checkpoint.phase}`);
    priorIndex = currentIndex;
    if (checkpoint.authority === 'live-dual-clock') {
      if (!checkpoint.wallTime || !checkpoint.clockSegmentId || checkpoint.monotonicNs == null || checkpoint.timingTicks64 == null) {
        throw new Error(`${checkpoint.phase}: incomplete live dual-clock checkpoint`);
      }
      const segment = segments.get(checkpoint.clockSegmentId);
      if (!segment) throw new Error(`${checkpoint.phase}: unknown clock segment`);
      const expected = (BigInt(checkpoint.monotonicNs) - BigInt(segment.t0MonotonicNs)) / 100n;
      if (expected.toString() !== checkpoint.timingTicks64) throw new Error(`${checkpoint.phase}: timingTicks64 mismatch`);
    } else if (checkpoint.authority === 'historical-state-proof') {
      if ([checkpoint.monotonicNs, checkpoint.timingTicks64, checkpoint.clockSegmentId].some((value) => value !== null)) {
        throw new Error(`${checkpoint.phase}: historical checkpoint invented monotonic timing`);
      }
    } else {
      throw new Error(`${checkpoint.phase}: unsupported authority`);
    }
    for (const entry of checkpoint.evidence ?? []) {
      if (!entry.path || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) {
        throw new Error(`${checkpoint.phase}: malformed immutable evidence`);
      }
    }
    if (index > 0 && record.checkpoints[index - 1].phase === checkpoint.phase && record.checkpoints[index - 1].status === checkpoint.status) {
      throw new Error(`${checkpoint.phase}: duplicate checkpoint status`);
    }
  }
  for (const span of record.spans) {
    if (!Number.isFinite(span.ms) || span.ms < 0) throw new Error(`invalid lifecycle span ${span.id}`);
  }
  if (record.state === 'sealed') {
    if (!record.completion?.completedThrough || typeof record.completion.complete !== 'boolean') {
      throw new Error('sealed VM lifecycle completion metadata is missing');
    }
    const expectedComplete = ['BOX-REGISTERED', 'REVIEWER-CACHE-READY'].includes(record.completion.completedThrough);
    if (record.completion.complete !== expectedComplete) throw new Error('VM lifecycle completion metadata is contradictory');
  }
  if (!allowOpen && record.state !== 'sealed') throw new Error('VM lifecycle is not sealed');
  return true;
}

export function sealLifecycle(record, { resume, cache, visualCapture, clock = hostClockSnapshot() }) {
  const completedThrough = record.checkpoints.at(-1).phase;
  const finalPhase = phaseIndex(record.checkpoints.at(-1).phase) <= phaseIndex('CACHE-SEALED')
    ? 'CACHE-SEALED'
    : 'LIFECYCLE-SEALED';
  appendCheckpoint(record, {
    phase: finalPhase,
    status: 'completed',
    detail: finalPhase === 'CACHE-SEALED'
      ? 'Verified VM cache sealed for future activation/capture/package resume.'
      : 'VM lifecycle sealed after resumed activation/capture/package work.',
    evidence: cache?.artifacts ?? [],
    clock,
  });
  record.cache = cache;
  record.visualCapture = visualCapture;
  record.resume = resume;
  record.completion = {
    completedThrough,
    complete: ['BOX-REGISTERED', 'REVIEWER-CACHE-READY'].includes(completedThrough),
    reason: completedThrough === 'BOX-REGISTERED'
      ? 'Lifecycle completed through box registration.'
      : completedThrough === 'REVIEWER-CACHE-READY'
        ? 'Lifecycle completed through retained reviewer cache readiness.'
      : `Lifecycle sealed at ${completedThrough}; later phases remain incomplete.`,
  };
  record.state = 'sealed';
  record.updatedWallTime = clock.wallTime;
  validateLifecycle(record);
  return record;
}
