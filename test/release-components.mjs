#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyReleaseComponents, verifyStagedReleaseMetadata } from '../scripts/release-components.mjs';

const releaseRiskBaseline = JSON.parse(readFileSync(new URL('../release-risk-baseline.json', import.meta.url), 'utf8'));
const standardsScoreBaseline = JSON.parse(readFileSync(new URL('../standards-score-baseline.json', import.meta.url), 'utf8'));
const base = {
  components: {
    schema: 'labview-benchmark-actor/release-components@1',
    extension: '1.4.8',
    agents: '0.3.12',
    lbabus: '0.15.7',
    humanTasks: '1.0.6',
    experimentGovernance: '1.0.1',
    canonicalDistribution: 'github-release',
    marketplaceChannel: 'prerelease',
    governance: {
      standardsReviewVersion: releaseRiskBaseline.source.workbenchVersion,
      standardsReviewCommit: releaseRiskBaseline.source.standardsReviewCommit,
      workbenchImage: 'registry.gitlab.com/example/repo-standards-review/assurance-workbench',
      workbenchDigest: releaseRiskBaseline.source.workbenchDigest,
      standardsRootDefault: 'C:\\design\\standards',
      releaseRisk: { present: 12, total: 28, status: 'BLOCKED' },
    },
  },
  packageJson: { version: '1.4.8' },
  packageLock: { version: '1.4.8', packages: { '': { version: '1.4.8' } } },
  agentsManifest: { version: '0.3.12' },
  agentsText: 'exactly `0.15.7` for this extension build\nbundle v1.0.6',
  lbabusProject: '<Version>0.15.7</Version>',
  humanTasksSource: "HUMAN_TASKS_VERSION = '1.0.6'",
  humanTaskRunner: "HUMAN_TASKS_VERSION = '1.0.6'",
  changelog: '## [1.4.8]',
  releaseWorkflow: 'vsce publish --pre-release',
  releaseCli: "['--target', 'main']",
  releaseRiskBaseline,
  standardsScoreBaseline,
  artifactExists: () => true,
  experimentGovernanceManifest: { version: '1.0.1' },
  experimentGovernanceSource: "EXPERIMENT_GOVERNANCE_VERSION = '1.0.1'",
};

assert.equal(verifyReleaseComponents(base).ok, true);
assert.equal(verifyReleaseComponents({
  ...base,
  components: { ...base.components, marketplaceChannel: 'stable' },
}).ok, false);

const falselyPromoted = structuredClone(releaseRiskBaseline);
for (const row of falselyPromoted.releaseEvidence) {
  for (const proof of row.proofs) {
    if (proof.status === 'missing') {
      proof.status = 'present';
      proof.evidence = 'unreviewed claim';
      proof.artifacts = ['package.json'];
    }
  }
}
assert.equal(verifyReleaseComponents({
  ...base,
  releaseRiskBaseline: falselyPromoted,
}).ok, false);
assert.equal(verifyReleaseComponents({
  ...base,
  humanTaskRunner: "HUMAN_TASKS_VERSION = '1.0.0'",
}).ok, false);

const staged = [
  'extension-tasks/human-task-runner.mjs',
  'src/humanTasks.ts',
  'package.json',
  'package-lock.json',
  'release-components.json',
  'CHANGELOG.md',
];
assert.equal(verifyStagedReleaseMetadata({
  staged,
  unstaged: [],
  previous: { extension: '1.4.2', agents: '0.3.6', lbabus: '0.15.1', humanTasks: '1.0.1' },
  current: base.components,
}).ok, true);
assert.equal(verifyStagedReleaseMetadata({
  staged,
  unstaged: ['CHANGELOG.md'],
  previous: { extension: '1.4.2', agents: '0.3.6', lbabus: '0.15.1', humanTasks: '1.0.1' },
  current: base.components,
}).ok, false);
assert.equal(verifyStagedReleaseMetadata({
  staged,
  unstaged: ['release-risk-baseline.json'],
  previous: { extension: '1.4.2', agents: '0.3.6', lbabus: '0.15.1', humanTasks: '1.0.1' },
  current: base.components,
}).ok, false);
assert.equal(verifyStagedReleaseMetadata({
  staged,
  unstaged: [],
  previous: { extension: '1.4.7', agents: '0.3.11', lbabus: '0.15.6', humanTasks: '1.0.6', experimentGovernance: '1.0.1' },
  current: base.components,
}).ok, false);
assert.equal(verifyStagedReleaseMetadata({
  staged: [
    'reviewer-workstation/composite-release-decision-receipt.json',
    'tools/collab-cli/release-agreement.json',
  ],
  unstaged: [],
  previous: base.components,
  current: base.components,
}).ok, true);
assert.equal(verifyStagedReleaseMetadata({
  staged: ['tools/collab-cli/Program.cs'],
  unstaged: [],
  previous: base.components,
  current: base.components,
}).ok, false);

console.log('release-components: PASS');
