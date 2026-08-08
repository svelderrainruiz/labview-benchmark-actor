#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(path.join(tmpdir(), 'lba-human-task-'));
try {
  const result = spawnSync(process.execPath, ['extension-tasks/human-task-runner.mjs', 'not-a-task'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      LBA_TASK_EVIDENCE_ROOT: root,
      LBA_EXTENSION_VERSION: '1.4.5',
    },
    input: '',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^\[0001\] wall=.* monotonicNs=\d+ clock=process\.hrtime\.bigint TASK-START /m);
  assert.match(result.stdout, /^\[0002\] wall=.* monotonicNs=\d+ clock=process\.hrtime\.bigint TASK-END /m);
  assert.match(result.stdout, /^\[0003\] wall=.* monotonicNs=\d+ clock=process\.hrtime\.bigint RECEIPT /m);

  const files = readdirSync(root);
  assert.equal(files.length, 1);
  const receipt = JSON.parse(readFileSync(path.join(root, files[0]), 'utf8'));
  assert.equal(receipt.schema, 'labview-benchmark-actor/human-task-receipt@1');
  assert.equal(receipt.taskBundleVersion, '1.0.4');
  assert.equal(receipt.extensionVersion, '1.4.5');
  assert.equal(receipt.monotonicClockSource, 'process.hrtime.bigint');
  assert.equal(receipt.outcome, 'FAIL');
  assert.deepEqual(receipt.events.map((event) => event.index), [1, 2, 3]);
  assert.equal(receipt.events[2].detail.file, path.join(root, files[0]));
  assert.match(receipt.events[0].wallTime, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(receipt.events[0].monotonicNs, /^\d+$/);
  console.log('human-task-runner: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
