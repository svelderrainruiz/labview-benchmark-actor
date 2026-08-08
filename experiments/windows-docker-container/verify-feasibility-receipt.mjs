#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveFeasibilityDecision, REQUIRED_VARIANTS } from './feasibility-core.mjs';

const receiptPath = process.argv[2];
if (!receiptPath) {
  console.error('Usage: node verify-feasibility-receipt.mjs <receipt.json>');
  process.exitCode = 2;
} else {
  const absolute = path.resolve(receiptPath);
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const receipt = JSON.parse(readFileSync(absolute, 'utf8'));
  assert.equal(receipt.schema, 'labview-benchmark-actor/windows-container-gui-feasibility@1');
  assert.deepEqual(receipt.aggregate, deriveFeasibilityDecision(receipt.rows, receipt.officialSources));
  assert.deepEqual(receipt.rows.map((row) => row.variantId), REQUIRED_VARIANTS);
  for (const row of receipt.rows) {
    for (const entry of Object.values(row.evidence.files)) {
      const file = path.join(repoRoot, entry.path);
      assert.equal(readFileSync(file).length, entry.size, `${entry.path} size mismatch`);
      assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), entry.sha256, `${entry.path} hash mismatch`);
    }
  }
  assert.equal(receipt.aggregate.decision, 'unsupported-by-windows-container-platform');
  assert.equal(receipt.aggregate.capabilities.networkRelay, 'supported-and-proven');
  assert.equal(receipt.aggregate.capabilities.rfbProtocolAndAuthentication, 'supported-and-proven');
  assert.match(receipt.stopCondition, /Do not retry Windows-container GUI/);
  console.log(JSON.stringify({
    decision: receipt.aggregate.decision,
    rows: receipt.rows.length,
    immutableEvidenceFiles: receipt.rows.reduce((sum, row) => sum + Object.keys(row.evidence.files).length, 0),
  }));
}
