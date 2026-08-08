#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { assessReleaseRisk, riskSummaryLines, verifyGovernedRisk } from './release-risk.mjs';

const mode = process.argv[2];
const workspace = process.cwd();
const HUMAN_TASKS_VERSION = '1.0.4';
const startedNs = process.hrtime.bigint();
const startedWallTime = new Date().toISOString();
const events = [];
let eventIndex = 0;
const releaseComponents = JSON.parse(readFileSync(new URL('../release-components.json', import.meta.url), 'utf8'));
const governance = releaseComponents.governance;
const lbabusExecutable = String(process.env.LBA_LBABUS_PATH || '').trim() || 'lbabus';
const releaseRiskBaseline = JSON.parse(readFileSync(new URL('../release-risk-baseline.json', import.meta.url), 'utf8'));
const standardsScoreBaseline = JSON.parse(readFileSync(new URL('../standards-score-baseline.json', import.meta.url), 'utf8'));
const REQUIRED_STANDARD_FILES = [
  'ISO_10007_2017(en).pdf',
  '12207-2017.pdf',
  '15289-2019.pdf',
  '29119-2-2021.pdf',
  '29119-3-2021.pdf',
  '29148-2018.pdf',
  '42010-2022.pdf',
  'ISO_IEC_IEEE_26514_2022(en).pdf',
];

function event(type, message, detail = {}) {
  eventIndex += 1;
  const item = {
    index: eventIndex,
    wallTime: new Date().toISOString(),
    monotonicNs: (process.hrtime.bigint() - startedNs).toString(),
    clockSource: 'process.hrtime.bigint',
    type,
    message,
    detail,
  };
  events.push(item);
  console.log(
    `[${String(item.index).padStart(4, '0')}] wall=${item.wallTime} monotonicNs=${item.monotonicNs} `
    + `clock=${item.clockSource} ${type.toUpperCase()} ${message}`,
  );
}

async function run(command, args, options = {}) {
  const step = eventIndex + 1;
  event('command-start', `${command} ${args.join(' ')}`, { step });
  const child = spawn(command, args, {
    cwd: options.cwd ?? workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: process.env,
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  for (const [stream, type] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    readline.createInterface({ input: stream }).on('line', (line) => event(type, line, { step }));
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      event('command-error', `${command} could not start: ${error.message}`, { step });
      reject(error);
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  event('command-end', `${command} exited ${exitCode.code}`, { step, exitCode: exitCode.code, signal: exitCode.signal });
  if (exitCode.code !== 0) throw new Error(`${command} exited ${exitCode.code}`);
  return stdout;
}

function standardsReviewPath() {
  const candidates = [
    process.env.REPO_STANDARDS_REVIEW,
    process.platform === 'win32' ? 'C:\\dev\\gl\\svelderrainruiz\\repo-standards-review' : null,
    path.join(os.homedir(), 'dev', 'gl', 'svelderrainruiz', 'repo-standards-review'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(path.join(candidate, '.git'))) ?? null;
}

function standardsRoot() {
  const candidates = [
    process.env.STANDARDS_ROOT,
    process.platform === 'win32' ? governance.standardsRootDefault : null,
    '/mnt/c/design/standards',
  ].filter(Boolean);
  return candidates.find((candidate) => (
    existsSync(candidate)
    && REQUIRED_STANDARD_FILES.every((file) => existsSync(path.join(candidate, file)))
  )) ?? null;
}

async function agentPreflight() {
  await run(lbabusExecutable, ['version']);
  await run(lbabusExecutable, ['selfcheck']);
  await run(lbabusExecutable, ['capabilities']);
}

async function governanceReview() {
  const standards = standardsReviewPath();
  if (!standards) {
    throw new Error(
      'repo-standards-review is required locally. Clone https://gitlab.com/svelderrainruiz/repo-standards-review.git '
      + 'or set REPO_STANDARDS_REVIEW.'
    );
  }
  const corpus = standardsRoot();
  if (!corpus) {
    throw new Error(
      'The governed standards PDF corpus is required. Set STANDARDS_ROOT or populate C:\\design\\standards '
      + `with: ${REQUIRED_STANDARD_FILES.join(', ')}.`
    );
  }
  event('standards-corpus', `Using standards corpus ${corpus}`, {
    root: corpus,
    files: REQUIRED_STANDARD_FILES,
    containerMount: '/standards:ro',
    standardsReviewCommit: governance.standardsReviewCommit,
    workbench: `${governance.workbenchImage}@${governance.workbenchDigest}`,
  });
  await run('git', ['-C', standards, 'status', '--short']);
  const standardsCommit = (await run('git', ['-C', standards, 'rev-parse', 'HEAD'])).trim();
  if (standardsCommit !== governance.standardsReviewCommit) {
    throw new Error(
      `repo-standards-review commit ${standardsCommit} does not match governed commit ${governance.standardsReviewCommit}.`
    );
  }
  const dockerOs = await run('docker', ['info', '--format', '{{.OSType}}']);
  if (dockerOs.trim() !== 'linux') {
    throw new Error('repo-standards-review requires Docker in Linux-container mode.');
  }
  await run('docker', [
    'run', '--rm',
    '-v', `${workspace}:/target`,
    '-v', `${corpus}:/standards:ro`,
    '-e', 'STANDARDS_ROOT=/standards',
    `${governance.workbenchImage}@${governance.workbenchDigest}`,
    'python3', 'scripts/run_assurance.py', '/target', '--profile', 'release-gate',
  ]);
  const risk = assessReleaseRisk(releaseRiskBaseline, {
    artifactExists: (artifact) => existsSync(path.join(workspace, artifact)),
    scoreBaseline: standardsScoreBaseline,
  });
  if (!risk.ok) throw new Error(`Release risk baseline is invalid: ${risk.reasons.join('; ')}`);
  const governedRisk = verifyGovernedRisk(risk, governance.releaseRisk);
  if (!governedRisk.ok) {
    throw new Error(`Release risk does not match the governed system state: ${governedRisk.reasons.join('; ')}`);
  }
  for (const [index, line] of riskSummaryLines(risk).entries()) {
    event(index === 0 ? 'release-risk-score' : 'release-risk-gate', line, index === 0 ? {
      present: risk.present,
      missing: risk.missing,
      total: risk.total,
      completionPercent: risk.completionPercent,
      status: risk.status,
    } : risk.rows[index - 1]);
  }
  return risk;
}

async function reviewerReadiness() {
  await agentPreflight();
  return governanceReview();
}

async function releaseCandidate() {
  const risk = await reviewerReadiness();
  if (!existsSync(path.join(workspace, 'package.json'))) {
    throw new Error('Release Candidate Check must run from a labview-benchmark-actor repository workspace.');
  }
  await run('npm', ['run', 'ci:local']);
  if (risk.status !== 'READY') {
    throw new Error(
      `Release evidence is ${risk.status} at ${risk.present}/${risk.total}; complete the printed missing proofs.`
    );
  }
}

const tasks = {
  'agent-preflight': agentPreflight,
  'governance-review': governanceReview,
  'reviewer-readiness': reviewerReadiness,
  'release-candidate': releaseCandidate,
};

try {
  event('task-start', `LBA governed human task bundle v${HUMAN_TASKS_VERSION}`, {
    task: mode,
    extensionVersion: process.env.LBA_EXTENSION_VERSION || null,
    startedWallTime,
  });
  if (!tasks[mode]) {
    throw new Error(`usage: human-task-runner.mjs <${Object.keys(tasks).join('|')}>`);
  }
  await tasks[mode]();
  event('task-end', `LBA task '${mode}': PASS`, { outcome: 'PASS' });
} catch (error) {
  event('task-end', `LBA task '${mode}': FAIL — ${error instanceof Error ? error.message : String(error)}`, {
    outcome: 'FAIL',
  });
  process.exitCode = 1;
} finally {
  const root = process.env.LBA_TASK_EVIDENCE_ROOT;
  if (root) {
    mkdirSync(root, { recursive: true });
    const timestamp = startedWallTime.replace(/[:.]/g, '-');
    const file = path.join(root, `${timestamp}-${mode || 'unknown'}.json`);
    event('receipt', `Finalizing task receipt at ${file}`, { file });
    writeFileSync(file, `${JSON.stringify({
      schema: 'labview-benchmark-actor/human-task-receipt@1',
      taskBundleVersion: HUMAN_TASKS_VERSION,
      extensionVersion: process.env.LBA_EXTENSION_VERSION || null,
      task: mode,
      startedWallTime,
      monotonicClockSource: 'process.hrtime.bigint',
      outcome: process.exitCode ? 'FAIL' : 'PASS',
      events,
    }, null, 2)}\n`);
  }
}
