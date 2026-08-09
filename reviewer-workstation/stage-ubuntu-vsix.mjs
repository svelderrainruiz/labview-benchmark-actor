#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_ID = 'svelderrainruiz.labview-benchmark-actor';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateUbuntuReviewTarget(target) {
  const failures = [];
  if (target?.component !== 'extension') failures.push('target component must be extension');
  if (!/^\d+\.\d+\.\d+$/.test(target?.version ?? '')) failures.push('target version must be SemVer X.Y.Z');
  if (!/^[a-f0-9]{40}$/i.test(target?.commit ?? '')) failures.push('target commit must be 40-hex');
  if (!/^[a-f0-9]{64}$/i.test(target?.vsixSha256 ?? '')) failures.push('target vsixSha256 must be 64-hex');
  return { ok: failures.length === 0, failures };
}

export function validateUbuntuStageEvidence({ target, vsixBytes, manifest, installedExtensions }) {
  const failures = [...validateUbuntuReviewTarget(target).failures];
  const actualSha256 = sha256(vsixBytes);
  if (actualSha256 !== String(target?.vsixSha256 ?? '').toLowerCase()) failures.push('VSIX SHA-256 does not match target');
  if (manifest?.name !== 'labview-benchmark-actor'
      || manifest?.publisher !== 'svelderrainruiz'
      || manifest?.version !== target?.version) {
    failures.push('VSIX manifest identity does not match target');
  }
  const expectedInstalled = `${EXTENSION_ID}@${target?.version ?? ''}`.toLowerCase();
  if (!installedExtensions.map((item) => item.trim().toLowerCase()).includes(expectedInstalled)) {
    failures.push(`installed extension list does not contain ${expectedInstalled}`);
  }
  return {
    ok: failures.length === 0,
    failures,
    actualSha256,
    expectedInstalled,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values[name.slice(2)] = value;
    index += 1;
  }
  return values;
}

function main() {
  if (process.platform !== 'linux') throw new Error('Ubuntu candidate staging must run inside the Linux reviewer VM');
  const args = parseArgs(process.argv.slice(2));
  for (const name of ['vsix', 'target', 'workspace', 'receipt']) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  const code = args.code || 'code';
  const vsixPath = resolve(args.vsix);
  const targetPath = resolve(args.target);
  const workspace = resolve(args.workspace);
  const receiptPath = resolve(args.receipt);
  const target = JSON.parse(readFileSync(targetPath, 'utf8'));
  const targetShape = validateUbuntuReviewTarget(target);
  if (!targetShape.ok) throw new Error(targetShape.failures.join('; '));
  const vsixBytes = readFileSync(vsixPath);
  const manifest = JSON.parse(execFileSync('unzip', ['-p', vsixPath, 'extension/package.json'], { encoding: 'utf8' }));
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  execFileSync(code, ['--install-extension', vsixPath, '--force'], { stdio: 'inherit' });
  const installedExtensions = execFileSync(code, ['--list-extensions', '--show-versions'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const evidence = validateUbuntuStageEvidence({ target, vsixBytes, manifest, installedExtensions });
  if (!evidence.ok) throw new Error(evidence.failures.join('; '));
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const stagedVsix = join(workspace, basename(vsixPath));
  const stagedTarget = join(workspace, 'review-target.json');
  copyFileSync(vsixPath, stagedVsix);
  copyFileSync(targetPath, stagedTarget);
  const finishedNs = process.hrtime.bigint();
  const receipt = {
    schema: 'labview-benchmark-actor/ubuntu-review-stage@1',
    candidate: {
      ...target,
      vsixSha256: evidence.actualSha256,
    },
    station: 'UBUNTU_VM',
    platform: {
      os: process.platform,
      arch: process.arch,
    },
    artifacts: {
      vsix: stagedVsix,
      reviewTarget: stagedTarget,
    },
    installedExtension: evidence.expectedInstalled,
    timing: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationNs: String(finishedNs - startedNs),
      monotonicClockSource: 'process.hrtime.bigint',
    },
    outcome: 'PASS',
    failures: [],
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`ubuntu reviewer candidate staged: ${receipt.installedExtension} ${receipt.candidate.vsixSha256}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`stage-ubuntu-vsix: ${error.message}`);
    process.exitCode = 1;
  }
}
