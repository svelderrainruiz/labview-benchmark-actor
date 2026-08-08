#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveVmPreflight } from './vm-substrate-core.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node verify-vm-substrate-preflight.mjs <preflight.json>');
  process.exitCode = 2;
} else {
  const receipt = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  assert.equal(receipt.schema, 'labview-benchmark-actor/windows-vm-substrate-preflight@1');
  assert.deepEqual(receipt, deriveVmPreflight(receipt.tools));
  assert.equal(receipt.constraints.noDownloadsPerformed, true);
  assert.equal(receipt.constraints.noVmsStartedOrModified, true);
  assert.equal(receipt.constraints.noEulasAccepted, true);
  assert.equal(receipt.constraints.noLicensingChanges, true);
  assert.equal(receipt.recommendedOption, 'virtualbox-vagrant');
  console.log(JSON.stringify({
    ready: receipt.ready,
    recommendedOption: receipt.recommendedOption,
    nextDecisionRequired: receipt.nextDecisionRequired,
  }));
}
