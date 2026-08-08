import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assessReleaseRisk, verifyGovernedRisk } from '../extension-tasks/release-risk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8'));
}

function text(file) {
  return readFileSync(path.join(root, file), 'utf8');
}

function extract(pattern, value, label, reasons) {
  const match = value.match(pattern);
  if (!match) {
    reasons.push(`cannot read ${label}`);
    return null;
  }
  return match[1];
}

export function verifyReleaseComponents(input) {
  const reasons = [];
  const {
    components,
    packageJson,
    packageLock,
    agentsManifest,
    agentsText,
    lbabusProject,
    humanTasksSource,
    humanTaskRunner,
    changelog,
    releaseWorkflow,
    releaseCli,
    releaseRiskBaseline,
    standardsScoreBaseline,
    artifactExists = () => true,
    experimentGovernanceManifest,
    experimentGovernanceSource,
  } = input;

  if (components.schema !== 'labview-benchmark-actor/release-components@1') {
    reasons.push('release component schema is not supported');
  }
  if (components.canonicalDistribution !== 'github-release') {
    reasons.push('GitHub Release must be the canonical distribution');
  }
  if (components.marketplaceChannel !== 'prerelease') {
    reasons.push('Marketplace must use the prerelease channel');
  }
  if (!/^[0-9a-f]{40}$/.test(components.governance?.standardsReviewCommit || '')) {
    reasons.push('governance standards-review commit must be an exact Git commit');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(components.governance?.workbenchDigest || '')) {
    reasons.push('governance workbench digest must be an exact sha256 digest');
  }
  if (!String(components.governance?.workbenchImage || '').includes('repo-standards-review/assurance-workbench')) {
    reasons.push('governance workbench image is missing');
  }
  if (!/^\d+\.\d+\.\d+$/.test(components.governance?.standardsReviewVersion || '')) {
    reasons.push('governance standards-review version must be exact SemVer');
  }
  const risk = assessReleaseRisk(releaseRiskBaseline, { artifactExists, scoreBaseline: standardsScoreBaseline });
  if (!risk.ok) reasons.push(...risk.reasons.map((reason) => `release risk baseline: ${reason}`));
  if (releaseRiskBaseline?.releaseVersion !== components.extension) {
    reasons.push('release risk baseline version does not match extension version');
  }
  if (
    releaseRiskBaseline?.source?.workbenchVersion !== components.governance?.standardsReviewVersion
    || releaseRiskBaseline?.source?.standardsReviewCommit !== components.governance?.standardsReviewCommit
    || releaseRiskBaseline?.source?.workbenchDigest !== components.governance?.workbenchDigest
  ) {
    reasons.push('release risk baseline does not match the governed standards-review identity');
  }
  if (
    standardsScoreBaseline?.source?.workbenchVersion !== components.governance?.standardsReviewVersion
    || standardsScoreBaseline?.source?.standardsReviewCommit !== components.governance?.standardsReviewCommit
    || standardsScoreBaseline?.source?.workbenchDigest !== components.governance?.workbenchDigest
  ) {
    reasons.push('standards score baseline does not match the governed standards-review identity');
  }
  const governedRisk = verifyGovernedRisk(risk, components.governance?.releaseRisk);
  reasons.push(...governedRisk.reasons.map((reason) => `release risk system state: ${reason}`));
  if (packageJson.version !== components.extension) {
    reasons.push('package.json version does not match release-components.json');
  }
  if (packageLock.version !== components.extension
      || packageLock.packages?.['']?.version !== components.extension) {
    reasons.push('package-lock.json root versions do not match release-components.json');
  }
  if (agentsManifest.version !== components.agents) {
    reasons.push('agents manifest version does not match release-components.json');
  }

  const lbabus = extract(/<Version>([^<]+)<\/Version>/, lbabusProject, 'lbabus version', reasons);
  const tasksSource = extract(/HUMAN_TASKS_VERSION\s*=\s*'([^']+)'/, humanTasksSource, 'human task source version', reasons);
  const tasksRunner = extract(/HUMAN_TASKS_VERSION\s*=\s*'([^']+)'/, humanTaskRunner, 'human task runner version', reasons);
  if (lbabus && lbabus !== components.lbabus) reasons.push('lbabus version does not match release-components.json');
  if (tasksSource && tasksSource !== components.humanTasks) reasons.push('human task source version does not match release-components.json');
  if (tasksRunner && tasksRunner !== components.humanTasks) reasons.push('human task runner version does not match release-components.json');
  if (experimentGovernanceManifest?.version !== components.experimentGovernance) {
    reasons.push('experiment-governance manifest version does not match release-components.json');
  }
  if (!experimentGovernanceSource?.includes(`EXPERIMENT_GOVERNANCE_VERSION = '${components.experimentGovernance}'`)) {
    reasons.push('experiment-governance source version does not match release-components.json');
  }
  if (!agentsText.includes(`exactly \`${components.lbabus}\` for this extension build`)) {
    reasons.push('AGENTS.md does not pin the governed lbabus version');
  }
  if (!agentsText.includes(`bundle v${components.humanTasks}`)) {
    reasons.push('AGENTS.md does not pin the governed human task bundle version');
  }
  if (!changelog.includes(`## [${components.extension}]`)) {
    reasons.push('CHANGELOG.md has no section for the extension version');
  }
  if (!releaseWorkflow.includes('vsce publish --pre-release')) {
    reasons.push('Marketplace workflow does not publish through the prerelease channel');
  }
  if (!releaseCli.includes("'--target', 'main'")) {
    reasons.push('release-cut-github does not target main explicitly');
  }

  return { ok: reasons.length === 0, reasons };
}

function currentInput() {
  return {
    components: readJson('release-components.json'),
    packageJson: readJson('package.json'),
    packageLock: readJson('package-lock.json'),
    agentsManifest: readJson('extension-agents/agents.manifest.json'),
    agentsText: text('extension-agents/AGENTS.md'),
    lbabusProject: text('tools/collab-cli/LbaBus.csproj'),
    humanTasksSource: text('src/humanTasks.ts'),
    humanTaskRunner: text('extension-tasks/human-task-runner.mjs'),
    changelog: text('CHANGELOG.md'),
    releaseWorkflow: text('.github/workflows/extension-release.yml'),
    releaseCli: text('scripts/lba.mjs'),
    releaseRiskBaseline: readJson('release-risk-baseline.json'),
    standardsScoreBaseline: readJson('standards-score-baseline.json'),
    artifactExists: (artifact) => existsSync(path.join(root, artifact)),
    experimentGovernanceManifest: readJson('experiments/governance-overrides.json'),
    experimentGovernanceSource: text('experiments/experiment-governance.mjs'),
  };
}

export function verifyStagedReleaseMetadata({ staged, unstaged, previous, current }) {
  const reasons = [];
  const changed = (prefixes) => staged.some((file) => prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
  const agentsChanged = changed(['extension-agents', 'release-risk-baseline.json', 'standards-score-baseline.json']);
  const lbabusChanged = changed(['tools/collab-cli']);
  const tasksChanged = changed(['extension-tasks', 'src/humanTasks.ts']);
  const experimentsChanged = changed([
    'experiments/experiment-governance.mjs',
    'experiments/governance-overrides.json',
    'scripts/local-continuous-kpi.mjs',
  ]);
  const componentChanged = agentsChanged || lbabusChanged || tasksChanged || experimentsChanged;

  if (agentsChanged && previous.agents === current.agents) reasons.push('AGENTS component changed without an agents version bump');
  if (lbabusChanged && previous.lbabus === current.lbabus) reasons.push('lbabus component changed without an lbabus version bump');
  if (tasksChanged && previous.humanTasks === current.humanTasks) reasons.push('human task component changed without a humanTasks version bump');
  if (experimentsChanged && previous.experimentGovernance === current.experimentGovernance) reasons.push('experiment governance changed without an experimentGovernance version bump');

  if (componentChanged) {
    if (previous.extension === current.extension) reasons.push('governed component changed without an extension version bump');
    for (const file of ['package.json', 'package-lock.json', 'release-components.json', 'CHANGELOG.md']) {
      if (!staged.includes(file)) reasons.push(`${file} must be staged with a governed component change`);
    }
    for (const file of [
      '.githooks/pre-commit',
      '.github/workflows/extension-release.yml',
      'CHANGELOG.md',
      'extension-agents/AGENTS.md',
      'extension-agents/agents.manifest.json',
      'extension-tasks/human-task-runner.mjs',
      'extension-tasks/release-risk.mjs',
      'package.json',
      'package-lock.json',
      'release-components.json',
      'release-risk-baseline.json',
      'scripts/install-git-hooks.mjs',
      'scripts/lba.mjs',
      'scripts/release-components.mjs',
      'src/humanTasks.ts',
      'standards-score-baseline.json',
      'tools/collab-cli/LbaBus.csproj',
    ]) {
      if (unstaged.includes(file)) reasons.push(`${file} has unstaged edits; governed release inputs must match the staged index`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function gitLines(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function previousComponents() {
  try {
    return JSON.parse(execFileSync('git', ['show', 'HEAD:release-components.json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    const fromHead = (file) => execFileSync('git', ['show', `HEAD:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const previousPackage = JSON.parse(fromHead('package.json'));
    const previousAgents = JSON.parse(fromHead('extension-agents/agents.manifest.json'));
    const previousLbabus = fromHead('tools/collab-cli/LbaBus.csproj')
      .match(/<Version>([^<]+)<\/Version>/)?.[1] ?? '';
    const previousTasks = fromHead('src/humanTasks.ts')
      .match(/HUMAN_TASKS_VERSION\s*=\s*'([^']+)'/)?.[1] ?? '';
    return {
      extension: previousPackage.version,
      agents: previousAgents.version,
      lbabus: previousLbabus,
      humanTasks: previousTasks,
    };
  }
}

export function main(args = process.argv.slice(2)) {
  const check = verifyReleaseComponents(currentInput());
  const reasons = [...check.reasons];
  if (args.includes('--precommit')) {
    const stagedCheck = verifyStagedReleaseMetadata({
      staged: gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR']),
      unstaged: gitLines(['diff', '--name-only', '--diff-filter=ACMR']),
      previous: previousComponents(),
      current: readJson('release-components.json'),
    });
    reasons.push(...stagedCheck.reasons);
  }
  if (reasons.length) {
    for (const reason of reasons) console.error(`release-components: FAIL: ${reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`release-components: PASS (${readJson('release-components.json').extension})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
