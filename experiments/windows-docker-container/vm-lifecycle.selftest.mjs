import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(path.join(os.tmpdir(), 'lba-vm-lifecycle-'));
const cli = path.join(import.meta.dirname, 'vm-lifecycle.mjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
try {
  const record = path.join(root, 'record.json');
  let result = run('init', '--record', record, '--lifecycle-id', 'selftest-live', '--vm-name', 'actor');
  assert.equal(result.status, 0, result.stderr);
  result = run('checkpoint', '--record', record, '--phase', 'MEDIA-VERIFIED', '--status', 'completed');
  assert.equal(result.status, 0, result.stderr);
  result = run('seal', '--record', record, '--next-phase', 'ACTIVATION-RESUME-START', '--state', 'activation-required');
  assert.equal(result.status, 0, result.stderr);
  result = run('verify', '--record', record);
  assert.equal(result.status, 0, result.stderr);
  const sealed = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(sealed.state, 'sealed');
  assert.ok(sealed.checkpoints.every((checkpoint) => checkpoint.timingTicks64 !== null));

  const resumed = path.join(root, 'resumed.json');
  result = run(
    'resume',
    '--cache', record,
    '--record', resumed,
    '--lifecycle-id', 'selftest-resume',
  );
  assert.equal(result.status, 0, result.stderr);
  const resumeRecord = JSON.parse(readFileSync(resumed, 'utf8'));
  assert.equal(resumeRecord.state, 'open');
  assert.equal(resumeRecord.checkpoints.at(-1).phase, 'ACTIVATION-RESUME-START');
  assert.match(resumeRecord.cache.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(resumeRecord.resume.lock.path), true);
  result = run(
    'resume',
    '--cache', record,
    '--record', path.join(root, 'competing-resume.json'),
    '--lifecycle-id', 'selftest-competing-resume',
  );
  assert.notEqual(result.status, 0, 'exclusive resume lock must reject a competing lifecycle');
  result = run('verify', '--record', resumed, '--allow-open', 'true');
  assert.equal(result.status, 0, result.stderr);
  result = run('seal', '--record', resumed);
  assert.equal(result.status, 0, result.stderr);
  const sealedResume = JSON.parse(readFileSync(resumed, 'utf8'));
  assert.equal(sealedResume.resume.lock.releasedWallTime != null, true);
  assert.equal(existsSync(sealedResume.resume.lock.path), false);
  result = run('release', '--record', resumed);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).released, false);

  result = run('checkpoint', '--record', record, '--phase', 'ACTIVATION-COMPLETE', '--status', 'completed');
  assert.notEqual(result.status, 0, 'sealed cache must reject append');
  console.log('Windows VM lifecycle CLI self-test: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
