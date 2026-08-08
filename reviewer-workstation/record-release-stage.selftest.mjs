#!/usr/bin/env node
// Focused regression coverage: only a WIN DONE release-stage@1 payload may bind a release candidate.

import assert from 'node:assert/strict';
import { buildReleaseStage } from './record-release-stage.mjs';

const candidate = { component: 'extension', version: '1.2.0', commit: 'c'.repeat(40), vsixSha256: 'd'.repeat(64) };
const readback = (payload) => ({
  matched: true,
  expected: { type: 'DONE', task: 'stage-1.2.0' },
  reply: { type: 'DONE', task: 'stage-1.2.0', senderId: 'WIN', payload },
});
let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

ok('derives the staged candidate from a matching structured WIN DONE payload', () => {
  const staged = buildReleaseStage({ candidate, readback: readback(JSON.stringify({ schema: 'labview-benchmark-actor/release-stage@1', candidate })) });
  assert.deepEqual(staged.candidate, candidate);
});

ok('rejects a stale commit before constructing a staged artifact', () => {
  assert.throws(() => buildReleaseStage({ candidate, readback: readback(JSON.stringify({ schema: 'labview-benchmark-actor/release-stage@1', candidate: { ...candidate, commit: 'f'.repeat(40) } })) }), /component, version, commit, and vsix hash/);
});

ok('rejects a stale VSIX hash before constructing a staged artifact', () => {
  assert.throws(() => buildReleaseStage({ candidate, readback: readback(JSON.stringify({ schema: 'labview-benchmark-actor/release-stage@1', candidate: { ...candidate, vsixSha256: 'a'.repeat(64) } })) }), /component, version, commit, and vsix hash/);
});

ok('rejects prose or a malformed stage payload', () => {
  assert.throws(() => buildReleaseStage({ candidate, readback: readback('extension 1.2.0 staged') }), /release-stage@1/);
});

ok('rejects empty, uncorrelated, or non-terminal readbacks', () => {
  const validPayload = JSON.stringify({ schema: 'labview-benchmark-actor/release-stage@1', candidate });
  assert.throws(() => buildReleaseStage({ candidate, readback: readback('') }));
  assert.throws(() => buildReleaseStage({ candidate, readback: { ...readback(validPayload), matched: false } }));
  assert.throws(() => buildReleaseStage({ candidate, readback: { ...readback(validPayload), reply: { ...readback(validPayload).reply, type: 'PROGRESS' } } }));
  assert.throws(() => buildReleaseStage({ candidate, readback: { ...readback(validPayload), reply: { ...readback(validPayload).reply, task: 'different-task' } } }));
});

console.log(`# record-release-stage selftest ${passed}/5 passed`);