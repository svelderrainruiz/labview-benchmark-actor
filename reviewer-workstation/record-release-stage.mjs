#!/usr/bin/env node
// Convert a correlated WIN await-agent-reply receipt into the exact staging artifact required by composite release assembly.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stagedOk } from './release-with-review-drive.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

export function buildReleaseStage({ candidate, readback, drive = 'await-agent-reply', vm = 'reviewer-vm' } = {}) {
  const expected = readback?.expected;
  const reply = readback?.reply;
  if (readback?.matched !== true || expected?.type !== 'DONE' || typeof expected.task !== 'string' || !expected.task
    || reply?.type !== 'DONE' || reply.task !== expected.task) {
    throw new Error('readback must contain a matched expected DONE with the same non-empty task as its reply');
  }
  const staged = {
    drive,
    vm,
    matched: true,
    candidate,
    frame: reply,
  };
  if (!stagedOk(staged, candidate)) {
    throw new Error('readback is not a matched WIN net frame with task, payload, and the requested candidate component/version');
  }
  return staged;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(`record-release-stage: ${error.message}`);
    process.exit(2);
  }
  for (const key of ['component', 'version', 'commit', 'vsix256', 'readback', 'out']) {
    if (!args[key]) {
      console.error('usage: node reviewer-workstation/record-release-stage.mjs --component extension --version X.Y.Z --commit <sha> --vsix256 <sha256> --readback <await-agent-reply.json> --out <staged-frame.json>');
      process.exit(2);
    }
  }
  try {
    const readback = JSON.parse(readFileSync(args.readback, 'utf8'));
    const staged = buildReleaseStage({
      candidate: { component: args.component, version: args.version, commit: args.commit, vsixSha256: args.vsix256 },
      readback,
    });
    writeFileSync(args.out, `${JSON.stringify(staged, null, 2)}\n`);
    console.log(`record-release-stage: wrote ${args.out} for ${staged.candidate.component} ${staged.candidate.version}`);
  } catch (error) {
    console.error(`record-release-stage: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();