#!/usr/bin/env node

import assert from 'node:assert/strict';
import { verifyReleaseComponents, verifyStagedReleaseMetadata } from '../scripts/release-components.mjs';

const base = {
  components: {
    schema: 'labview-benchmark-actor/release-components@1',
    extension: '1.4.2',
    agents: '0.3.6',
    lbabus: '0.15.1',
    humanTasks: '1.0.1',
    canonicalDistribution: 'github-release',
    marketplaceChannel: 'prerelease',
    governance: {
      standardsReviewCommit: 'd'.repeat(40),
      workbenchImage: 'registry.gitlab.com/example/repo-standards-review/assurance-workbench',
      workbenchDigest: `sha256:${'a'.repeat(64)}`,
      standardsRootDefault: 'C:\\design\\standards',
    },
  },
  packageJson: { version: '1.4.2' },
  packageLock: { version: '1.4.2', packages: { '': { version: '1.4.2' } } },
  agentsManifest: { version: '0.3.6' },
  agentsText: 'exactly `0.15.1` for this extension build\nbundle v1.0.1',
  lbabusProject: '<Version>0.15.1</Version>',
  humanTasksSource: "HUMAN_TASKS_VERSION = '1.0.1'",
  humanTaskRunner: "HUMAN_TASKS_VERSION = '1.0.1'",
  changelog: '## [1.4.2]',
  releaseWorkflow: 'vsce publish --pre-release',
  releaseCli: "['--target', 'main']",
};

assert.equal(verifyReleaseComponents(base).ok, true);
assert.equal(verifyReleaseComponents({
  ...base,
  components: { ...base.components, marketplaceChannel: 'stable' },
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
  previous: { extension: '1.4.1', agents: '0.3.6', lbabus: '0.15.1', humanTasks: '1.0.0' },
  current: base.components,
}).ok, true);
assert.equal(verifyStagedReleaseMetadata({
  staged,
  unstaged: ['CHANGELOG.md'],
  previous: { extension: '1.4.1', agents: '0.3.6', lbabus: '0.15.1', humanTasks: '1.0.0' },
  current: base.components,
}).ok, false);
assert.equal(verifyStagedReleaseMetadata({
  staged,
  unstaged: [],
  previous: { extension: '1.4.2', agents: '0.3.6', lbabus: '0.15.1', humanTasks: '1.0.1' },
  current: base.components,
}).ok, false);

console.log('release-components: PASS');
