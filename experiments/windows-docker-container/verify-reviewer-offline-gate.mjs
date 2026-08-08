#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyReviewerOfflineGateReceipt } from './reviewer-offline-gate-core.mjs';

const receiptPath = process.argv[2];
if (!receiptPath) {
  console.error('Usage: node verify-reviewer-offline-gate.mjs <receipt.json>');
  process.exitCode = 2;
} else {
  try {
    const absolute = path.resolve(receiptPath);
    const receipt = JSON.parse(readFileSync(absolute, 'utf8'));
    const result = await verifyReviewerOfflineGateReceipt(receipt, {
      baseDir: path.dirname(absolute),
      live: receipt.liveChecks !== false && receipt.liveChecks !== null && receipt.liveChecks !== undefined,
    });
    console.log(JSON.stringify({
      schema: result.schema,
      status: result.status,
      reason: result.reason,
      requiredFailures: result.requiredFailures.length,
      requiredPasses: result.requiredPasses.length,
      materialNotes: result.materialNotes,
      artifacts: result.artifacts.length,
      liveChecks: result.liveChecks.length,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
