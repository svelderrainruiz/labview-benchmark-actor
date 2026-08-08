#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
const workspace = process.cwd();

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspace,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

function standardsReviewPath() {
  const candidates = [
    process.env.REPO_STANDARDS_REVIEW,
    process.platform === 'win32' ? 'C:\\dev\\gl\\svelderrainruiz\\repo-standards-review' : null,
    path.join(os.homedir(), 'dev', 'gl', 'svelderrainruiz', 'repo-standards-review'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(path.join(candidate, '.git'))) ?? null;
}

function agentPreflight() {
  run('lbabus', ['version']);
  run('lbabus', ['selfcheck']);
  run('lbabus', ['capabilities']);
}

function governanceReview() {
  const standards = standardsReviewPath();
  if (!standards) {
    throw new Error(
      'repo-standards-review is required locally. Clone https://gitlab.com/svelderrainruiz/repo-standards-review.git '
      + 'or set REPO_STANDARDS_REVIEW.'
    );
  }
  run('git', ['-C', standards, 'status', '--short']);
  const docker = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { encoding: 'utf8' });
  if (docker.status !== 0 || docker.stdout.trim() !== 'linux') {
    throw new Error('repo-standards-review requires Docker in Linux-container mode.');
  }
  run('docker', [
    'run', '--rm',
    '-v', `${workspace}:/target`,
    'registry.gitlab.com/svelderrainruiz/repo-standards-review/assurance-workbench:main',
    'python3', 'scripts/run_assurance.py', '/target', '--profile', 'release-gate',
  ]);
}

function reviewerReadiness() {
  agentPreflight();
  governanceReview();
}

function releaseCandidate() {
  reviewerReadiness();
  if (!existsSync(path.join(workspace, 'package.json'))) {
    throw new Error('Release Candidate Check must run from a labview-benchmark-actor repository workspace.');
  }
  run('npm', ['test']);
  run(process.execPath, ['experiments/verify-local-gates.mjs']);
  run('npm', ['run', 'package']);
}

const tasks = {
  'agent-preflight': agentPreflight,
  'governance-review': governanceReview,
  'reviewer-readiness': reviewerReadiness,
  'release-candidate': releaseCandidate,
};

if (!tasks[mode]) {
  console.error(`usage: human-task-runner.mjs <${Object.keys(tasks).join('|')}>`);
  process.exit(2);
}

try {
  tasks[mode]();
  console.log(`\nLBA task '${mode}': PASS`);
} catch (error) {
  console.error(`\nLBA task '${mode}': FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
