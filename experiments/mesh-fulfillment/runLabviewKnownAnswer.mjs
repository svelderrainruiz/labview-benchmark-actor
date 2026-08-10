#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildActivationReceipt, validateActivationReceipt } from '../activation/buildActivationReceipt.mjs';

const execFileAsync = promisify(execFile);
const capturePath = join(tmpdir(), `lba-autonomous-known-answer-${process.pid}.json`);
const probePath = new URL('../activation/probe-activation.sh', import.meta.url).pathname;

try {
  await execFileAsync('bash', [probePath, '1', '2', capturePath], {
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LBA_ACTOR_ID: '' },
  });
  const receipt = buildActivationReceipt(JSON.parse(readFileSync(capturePath, 'utf8')));
  const validation = validateActivationReceipt(receipt);
  if (!validation.activated) {
    throw Object.assign(new Error(`known-answer receipt rejected: ${validation.findings.join('; ')}`), { code: 'KNOWN_ANSWER_FAILED' });
  }
  process.stdout.write(`${JSON.stringify({
    operation: receipt.probe.viName,
    observed: receipt.result.parsedOutput,
    expected: receipt.probe.expectedOutput,
    verdict: 'PASS',
    receiptDigest: receipt.digest,
    wallMs: receipt.result.wallMs,
  })}\n`);
} finally {
  rmSync(capturePath, { force: true });
}