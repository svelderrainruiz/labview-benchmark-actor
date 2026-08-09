#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnInvocation } from '../extension-tasks/process-command.mjs';

assert.deepEqual(spawnInvocation('npm', ['run', 'ci:local'], { platform: 'linux' }), {
  command: 'npm',
  args: ['run', 'ci:local'],
});
assert.deepEqual(spawnInvocation('npm.cmd', ['run', 'ci:local'], {
  platform: 'win32',
  comspec: 'C:\\Windows\\System32\\cmd.exe',
}), {
  command: 'C:\\Windows\\System32\\cmd.exe',
  args: ['/d', '/s', '/c', 'call npm.cmd run ci:local'],
});
assert.deepEqual(spawnInvocation('C:\\Program Files\\nodejs\\npm.cmd', ['run', 'ci:local'], {
  platform: 'win32',
  comspec: 'C:\\Windows\\System32\\cmd.exe',
}), {
  command: 'C:\\Windows\\System32\\cmd.exe',
  args: ['/d', '/s', '/c', 'call "C:\\Program Files\\nodejs\\npm.cmd" run ci:local'],
});

if (process.platform === 'win32') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lba-cmd-shim-'));
  try {
    const shim = path.join(root, 'proof.cmd');
    const output = path.join(root, 'proof.txt');
    writeFileSync(shim, '@echo off\r\n> \"%~1\" echo %~2\r\n');
    const invocation = spawnInvocation('proof.cmd', [output, 'shim-ok']);
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${root};${process.env.PATH || ''}` },
    });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(output, 'utf8').trim(), 'shim-ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('process-command: PASS');
