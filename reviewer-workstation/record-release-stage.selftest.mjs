#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildReleaseStage } from './record-release-stage.mjs';

const candidate = { component: 'extension', version: '1.2.0', commit: 'a'.repeat(40), vsixSha256: 'b'.repeat(64) };
const readback = {
  matched: true,
  reply: { senderId: 'WIN', type: 'DONE', task: 'stage-1.2.0', payload: 'extension 1.2.0 staged and validated' },
};

const staged = buildReleaseStage({ candidate, readback });
assert.equal(staged.matched, true);
assert.deepEqual(staged.candidate, candidate);
assert.equal(staged.frame.senderId, 'WIN');
assert.throws(() => buildReleaseStage({ candidate, readback: { ...readback, reply: { ...readback.reply, payload: '' } } }));
assert.throws(() => buildReleaseStage({ candidate, readback: { ...readback, matched: false } }));
console.log('record-release-stage selftest: 3/3 passed');