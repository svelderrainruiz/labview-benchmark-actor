#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyReviewerCacheReceipt } from './reviewer-cache-core.mjs';

const receiptPath = process.argv[2];
if (!receiptPath) {
  console.error('Usage: node verify-reviewer-cache.mjs <receipt.json>');
  process.exitCode = 2;
} else {
  try {
    const absolute = path.resolve(receiptPath);
    const receipt = JSON.parse(readFileSync(absolute, 'utf8'));
    const result = await verifyReviewerCacheReceipt(receipt, {
      baseDir: path.dirname(absolute),
      live: receipt.liveChecks !== false,
    });
    if (result.status !== 'passed') {
      throw new Error(`Reviewer cache proof is ${result.status}: ${result.reason}`);
    }
    console.log(JSON.stringify({
      schema: result.schema,
      status: result.status,
      reason: result.reason,
      artifacts: result.artifacts.length,
      liveChecks: result.liveChecks.length,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
