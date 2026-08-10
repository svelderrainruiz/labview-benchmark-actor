#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyReleaseComponents, verifyStagedReleaseMetadata } from '../scripts/release-components.mjs';

const releaseRiskBaseline = JSON.parse(readFileSync(new URL('../release-risk-baseline.json', import.meta.url), 'utf8'));
const standardsScoreBaseline = JSON.parse(readFileSync(new URL('../standards-score-baseline.json', import.meta.url), 'utf8'));
const releaseComponents = JSON.parse(readFileSync(new URL('../release-components.json', import.meta.url), 'utf8'));
const extensionVersion = releaseRiskBaseline.releaseVersion;
const base = {
  components: {
    ...releaseComponents,
    governance: {
      standardsReviewVersion: releaseRiskBaseline.source.workbenchVersion,
      standardsReviewCommit: releaseRiskBaseline.source.standardsReviewCommit,
      workbenchImage: 'registry.gitlab.com/example/repo-standards-review/assurance-workbench',
      workbenchDigest: releaseRiskBaseline.source.workbenchDigest,
      standardsRootDefault: 'C:\\design\\standards',
      releaseRisk: { present: 12, total: 28, status: 'BLOCKED' },
    },
  },
  packageJson: { version: extensionVersion, scripts: { package: 'vsce package --out labview-benchmark-actor.vsix' } },
  packageLock: { version: extensionVersion, packages: { '': { version: extensionVersion } } },
  agentsManifest: { version: releaseComponents.agents },
  agentsText: `exactly \`${releaseComponents.lbabus}\` for this extension build\nbundle v${releaseComponents.humanTasks}`,
  lbabusProject: `<Version>${releaseComponents.lbabus}</Version>`,
  humanTasksSource: `HUMAN_TASKS_VERSION = '${releaseComponents.humanTasks}'`,
  humanTaskRunner: `HUMAN_TASKS_VERSION = '${releaseComponents.humanTasks}'`,
  changelog: `## [${extensionVersion}]`,
  releaseWorkflow: 'vsce publish --packagePath',
  releaseCli: "['--target', 'main']",
  releaseRiskBaseline,
  standardsScoreBaseline,
  artifactExists: () => true,
  experimentGovernanceManifest: { version: releaseComponents.experimentGovernance },
  experimentGovernanceSource: `EXPERIMENT_GOVERNANCE_VERSION = '${releaseComponents.experimentGovernance}'`,
};

assert.equal(verifyReleaseComponents(base).ok, true);
assert.equal(verifyReleaseComponents({
  ...base,
  components: { ...base.components, marketplaceChannel: 'prerelease' },
}).ok, false);
assert.equal(verifyReleaseComponents({
  ...base,
  packageJson: { ...base.packageJson, scripts: { package: 'vsce package --pre-release --out labview-benchmark-actor.vsix' } },
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
assert.equal(verifyStagedReleaseMetadata({
  staged: ['extension-tasks/release-risk.mjs'],
  unstaged: [],
  previous: base.components,
  current: base.components,
}).ok, false);
for (const stagedMediaTask of ['media/process-command.mjs', 'media/release-risk.mjs']) {
  assert.equal(verifyStagedReleaseMetadata({
    staged: [stagedMediaTask],
    unstaged: [],
    previous: base.components,
    current: base.components,
  }).ok, false);
}

console.log('release-components: PASS');
