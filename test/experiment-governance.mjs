#!/usr/bin/env node

import assert from 'node:assert/strict';
import { evaluateExperimentGovernance } from '../experiments/experiment-governance.mjs';

const base = {
  directoryNames: ['active', 'prototype', 'superseded'],
  rtmText: 'LBA-REQ-001,experiments/active/file.mjs\nLBA-REQ-097',
  overrides: {
    schema: 'labview-benchmark-actor/experiment-governance-overrides@1',
    version: '1.0.0',
    overrides: {
      prototype: {
        status: 'prototype',
        productionUse: 'prohibited',
        owner: 'test',
        requirements: ['LBA-REQ-097'],
        exitCriteria: 'Adopt before production.',
      },
      superseded: {
        status: 'superseded',
        productionUse: 'prohibited',
        owner: 'test',
        requirements: ['LBA-REQ-097'],
        supersededBy: 'active',
        exitCriteria: 'Remove when evidence expires.',
      },
    },
  },
  productionTexts: { 'src/app.ts': '' },
  pathExists: () => true,
};

assert.equal(evaluateExperimentGovernance(base).ok, true);
assert.equal(evaluateExperimentGovernance({
  ...base,
  directoryNames: [...base.directoryNames, 'unknown'],
}).ok, false);
assert.equal(evaluateExperimentGovernance({
  ...base,
  productionTexts: { 'src/app.ts': 'experiments/prototype/run.mjs' },
}).ok, false);
assert.equal(evaluateExperimentGovernance({
  ...base,
  overrides: {
    ...base.overrides,
    overrides: {
      ...base.overrides.overrides,
      prototype: { ...base.overrides.overrides.prototype, productionUse: 'allowed' },
    },
  },
}).ok, false);

console.log('experiment-governance: PASS');
