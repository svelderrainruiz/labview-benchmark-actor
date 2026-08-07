import assert from 'node:assert/strict';
import {
  appendCheckpoint,
  createLifecycle,
  historicalCheckpoint,
  sealLifecycle,
  validateLifecycle,
} from './vm-lifecycle-core.mjs';

const clock = (wallTime, monotonicNs, hostBootEpochMsApprox = 1000) => ({
  wallTime, monotonicNs: String(monotonicNs), hostBootEpochMsApprox, source: 'fake',
});
const record = createLifecycle({
  lifecycleId: 'selftest',
  vmName: 'actor',
  createdClock: clock('2026-08-07T00:00:00.000Z', 1000000n),
});
appendCheckpoint(record, {
  phase: 'MEDIA-VERIFIED',
  status: 'completed',
  clock: clock('2026-08-07T00:00:01.000Z', 1001000000n),
});
assert.equal(record.checkpoints[1].timingTicks64, '10000000');
assert.equal(record.spans[0].ms, 1000);
assert.throws(() => appendCheckpoint(record, {
  phase: 'LIFECYCLE-OPEN',
  status: 'completed',
  clock: clock('2026-08-07T00:00:02.000Z', 2001000000n),
}), /regressed/);

const rebootCheckpoint = appendCheckpoint(record, {
  phase: 'VM-CREATE-START',
  status: 'started',
  clock: clock('2026-08-08T00:00:00.000Z', 5000n, 86401000),
});
assert.equal(rebootCheckpoint.timingTicks64, '0');
assert.equal(record.clockSegments.length, 2);

const historical = historicalCheckpoint({
  phase: 'WINDOWS-PROVISION-START',
  evidence: [{ path: 'evidence.json', sha256: 'a'.repeat(64) }],
});
assert.equal(historical.monotonicNs, null);
assert.equal(historical.timingTicks64, null);
assert.throws(() => validateLifecycle({
  ...record,
  checkpoints: [...record.checkpoints, { ...historical, monotonicNs: '1' }],
}, { allowOpen: true }), /invented monotonic timing/);

sealLifecycle(record, {
  cache: { artifacts: [{ path: 'cache.json', sha256: 'b'.repeat(64) }] },
  visualCapture: { outcome: 'blocked-activation' },
  resume: { nextPhase: 'ACTIVATION-RESUME-START' },
  clock: clock('2026-08-08T00:00:01.000Z', 1000005000n, 86401000),
});
assert.equal(record.state, 'sealed');
assert.equal(record.completion.complete, false);
assert.equal(validateLifecycle(record), true);
assert.throws(() => validateLifecycle({
  ...record,
  completion: { ...record.completion, complete: true },
}), /completion metadata is contradictory/);
assert.throws(() => appendCheckpoint(record, {
  phase: 'ACTIVATION-RESUME-START',
  status: 'started',
  clock: clock('2026-08-08T00:00:02.000Z', 2000005000n, 86401000),
}), /sealed/);

const resumedLifecycle = createLifecycle({
  lifecycleId: 'resumed',
  vmName: 'actor',
  createdClock: clock('2026-08-09T00:00:00.000Z', 1000n, 172801000),
});
appendCheckpoint(resumedLifecycle, {
  phase: 'ACTIVATION-RESUME-START',
  status: 'started',
  clock: clock('2026-08-09T00:00:01.000Z', 1000001000n, 172801000),
});
appendCheckpoint(resumedLifecycle, {
  phase: 'ACTIVATION-COMPLETE',
  status: 'completed',
  clock: clock('2026-08-09T00:00:02.000Z', 2000001000n, 172801000),
});
sealLifecycle(resumedLifecycle, {
  cache: { artifacts: [] },
  visualCapture: { outcome: 'passed' },
  resume: { state: 'complete', nextPhase: null },
  clock: clock('2026-08-09T00:00:03.000Z', 3000001000n, 172801000),
});
assert.equal(resumedLifecycle.checkpoints.at(-1).phase, 'LIFECYCLE-SEALED');
assert.equal(resumedLifecycle.completion.completedThrough, 'ACTIVATION-COMPLETE');
assert.equal(resumedLifecycle.completion.complete, false);

const reviewerCacheLifecycle = createLifecycle({
  lifecycleId: 'reviewer-cache',
  vmName: 'actor-reviewer-local',
  createdClock: clock('2026-08-10T00:00:00.000Z', 1000n, 259201000),
});
for (const [index, phase] of [
  'VM-CREATE-START',
  'WINDOWS-INTERACTIVE-READY',
  'ACTIVATION-REQUIRED',
  'ACTIVATION-RESUME-START',
  'ACTIVATION-COMPLETE',
  'POST-ACTIVATION-CAPTURE-START',
  'LABVIEW-IDE-SETTLED',
  'REVIEWER-VSIX-STAGE-START',
  'REVIEWER-VSIX-INSTALLED',
  'REVIEWER-CACHE-SNAPSHOT',
  'REVIEWER-CACHE-READY',
].entries()) {
  appendCheckpoint(reviewerCacheLifecycle, {
    phase,
    status: 'completed',
    clock: clock(
      `2026-08-10T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
      BigInt(index + 1) * 1000000000n + 1000n,
      259201000,
    ),
  });
}
sealLifecycle(reviewerCacheLifecycle, {
  cache: { artifacts: [] },
  visualCapture: { outcome: 'passed' },
  resume: { state: 'reviewer-cache-ready', nextPhase: null },
  clock: clock('2026-08-10T00:00:20.000Z', 20000001000n, 259201000),
});
assert.equal(reviewerCacheLifecycle.completion.completedThrough, 'REVIEWER-CACHE-READY');
assert.equal(reviewerCacheLifecycle.completion.complete, true);
assert.equal(validateLifecycle(reviewerCacheLifecycle), true);

console.log('Windows VM lifecycle core self-test: PASS');
