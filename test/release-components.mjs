#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyReleaseComponents, verifyStagedReleaseMetadata } from '../scripts/release-components.mjs';

const extensionManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const repositoryUrl = 'https://github.com/svelderrainruiz/labview-benchmark-actor';
assert.equal(extensionManifest.name, 'labview-benchmark-actor');
assert.equal(extensionManifest.publisher, 'svelderrainruiz');
assert.equal(extensionManifest.repository.url, repositoryUrl);
assert.equal(extensionManifest.homepage, `${repositoryUrl}#readme`);
assert.equal(extensionManifest.bugs.url, `${repositoryUrl}/issues`);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
assert.ok(readme.includes(`](${repositoryUrl}/issues)`), 'Marketplace README must link to the independent issue tracker');

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
  agentsText: `exactly \`${releaseComponents.lbabus}\` for this extension build. Else install with \`dotnet tool install --global LabViewBenchmarkActor.CollabBus --version ${releaseComponents.lbabus} --add-source <folder>\`.\nbundle v${releaseComponents.humanTasks}`,
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
// The AGENTS install fallback must install the same lbabus version the preflight pins.
assert.equal(verifyReleaseComponents({
  ...base,
  agentsText: base.agentsText.replace(`--version ${releaseComponents.lbabus} `, '--version 0.15.12 '),
}).ok, false);
assert.equal(verifyReleaseComponents({
  ...base,
  agentsText: `exactly \`${releaseComponents.lbabus}\` for this extension build\nbundle v${releaseComponents.humanTasks}`,
}).ok, false);
assert.equal(verifyReleaseComponents({
  ...base,
  components: { ...base.components, marketplaceChannel: 'prerelease' },
}).ok, false);
assert.equal(verifyReleaseComponents({
  ...base,
  packageJson: { ...base.packageJson, scripts: { package: 'vsce package --pre-release --out labview-benchmark-actor.vsix' } },
}).ok, false);
// Trusted Publishing publishes with a pinned vsce over OIDC; that is still the stable channel, a pre-release is not.
assert.equal(verifyReleaseComponents({
  ...base,
  releaseWorkflow: 'npx --yes @vscode/vsce@4.1.1 publish --packagePath "$release_dir/x.vsix" --oidc',
}).ok, true);
assert.equal(verifyReleaseComponents({
  ...base,
  releaseWorkflow: 'npx --yes @vscode/vsce@4.1.1 publish --packagePath "$release_dir/x.vsix" --oidc --pre-release',
}).ok, false);
assert.equal(verifyReleaseComponents({ ...base, releaseWorkflow: 'vsce publish --pre-release' }).ok, false);

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
  // The task bundle version is unchanged from the current one, so the staged task change lacks its bump.
  previous: { extension: '1.4.7', agents: '0.3.11', lbabus: '0.15.6', humanTasks: base.components.humanTasks, experimentGovernance: '1.0.1' },
  current: base.components,
}).ok, false);
assert.equal(verifyStagedReleaseMetadata({
  staged: [
    'reviewer-workstation/composite-release-decision-receipt.json',
    'tools/release-governance/release-agreement.json',
  ],
  unstaged: [],
  previous: base.components,
  current: base.components,
}).ok, true);
// Enrolling a release's reviewer keys is release data, not an lbabus change.
assert.equal(verifyStagedReleaseMetadata({
  staged: ['tools/release-governance/reviewer-allowlist.json'],
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
