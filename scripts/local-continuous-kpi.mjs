#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessReleaseRisk, verifyGovernedRisk } from '../extension-tasks/release-risk.mjs';
import { loadExperimentGovernance } from '../experiments/experiment-governance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');
const startedWallTime = new Date().toISOString();
const startedNs = process.hrtime.bigint();
const events = [];

function run(name, command, args) {
  const before = process.hrtime.bigint();
  console.log(`\n[KPI ${events.length + 1}] ${name}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, env: process.env });
  const event = {
    index: events.length + 1,
    name,
    exitCode: result.status,
    durationNs: (process.hrtime.bigint() - before).toString(),
  };
  events.push(event);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} exited ${result.status}`);
}

function node(name, relative, args = []) {
  run(name, process.execPath, [relative, ...args]);
}

function npm(name, args) {
  if (!process.env.npm_execpath) throw new Error('Run the KPI through npm so npm_execpath is pinned.');
  run(name, process.execPath, [process.env.npm_execpath, ...args]);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  return result.stdout.trim();
}

let outcome = 'PASS';
let failure = null;
let packageProof = null;
try {
  const expectedNode = readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  if (process.version !== `v${expectedNode}`) {
    throw new Error(`Local CI requires Node ${expectedNode}; running ${process.version}.`);
  }
  node('release-components', 'scripts/release-components.mjs');
  node('agents-manifest', 'scripts/agentsManifest.mjs');
  node('experiment-governance', 'experiments/experiment-governance.mjs');
  node('release-risk', 'test/release-risk.mjs');
  node('traceability-current', 'experiments/reqs-coverage/generate-traceability.mjs', ['--check']);
  node('test-report-current', 'experiments/reqs-coverage/generate-test-report.selftest.mjs');

  if (!quick) {
    const status = capture('git', ['status', '--short']);
    if (status) throw new Error('Full local CI requires a clean worktree; run --quick while editing.');
    npm('coverage', ['run', 'test:coverage']);
    node('local-gates', 'experiments/verify-local-gates.mjs');
    node('correspondence', 'experiments/reqs-coverage/verify-correspondences.mjs');
    npm('package-first', ['run', 'package']);
    const first = sha256(path.join(root, 'labview-benchmark-actor.vsix'));
    npm('package-second', ['run', 'package']);
    const second = sha256(path.join(root, 'labview-benchmark-actor.vsix'));
    if (first !== second) throw new Error('Repeated normalized VSIX builds differ.');
    packageProof = { firstSha256: first, secondSha256: second, identical: true };
    const finalStatus = capture('git', ['status', '--short']);
    if (finalStatus) {
      throw new Error(`Full local CI changed the candidate worktree:\n${finalStatus}`);
    }
  }
} catch (error) {
  outcome = 'FAIL';
  failure = error instanceof Error ? error.message : String(error);
  console.error(`local-continuous-kpi: FAIL: ${failure}`);
}

const components = JSON.parse(readFileSync(path.join(root, 'release-components.json'), 'utf8'));
const riskBaseline = JSON.parse(readFileSync(path.join(root, 'release-risk-baseline.json'), 'utf8'));
const scoreBaseline = JSON.parse(readFileSync(path.join(root, 'standards-score-baseline.json'), 'utf8'));
const risk = assessReleaseRisk(riskBaseline, {
  artifactExists: (artifact) => path.isAbsolute(artifact) ? false : readFileExists(path.join(root, artifact)),
  scoreBaseline,
});
const governedRisk = verifyGovernedRisk(risk, components.governance.releaseRisk);
const experiments = loadExperimentGovernance();
if (!risk.ok || !governedRisk.ok || !experiments.ok) outcome = 'FAIL';

const receipt = {
  schema: 'labview-benchmark-actor/local-continuous-kpi@1',
  mode: quick ? 'quick' : 'full',
  version: components.extension,
  experimentGovernanceVersion: components.experimentGovernance,
  startedWallTime,
  finishedWallTime: new Date().toISOString(),
  monotonicClockSource: 'process.hrtime.bigint',
  durationNs: (process.hrtime.bigint() - startedNs).toString(),
  outcome,
  failure,
  kpi: {
    changelogAndSystemVersion: events.some((event) => event.name === 'release-components' && event.exitCode === 0) ? 'PASS' : 'FAIL',
    experiments: experiments.kpi,
    releaseEvidence: {
      present: risk.present,
      total: risk.total,
      completionPercent: risk.completionPercent,
      status: risk.status,
      governed: governedRisk.ok,
    },
    package: packageProof,
  },
  events,
};

const receiptRoot = path.join(root, '.lba', 'local-ci');
mkdirSync(receiptRoot, { recursive: true });
const timestamp = startedWallTime.replace(/[:.]/g, '-');
writeFileSync(path.join(receiptRoot, `${timestamp}-${quick ? 'quick' : 'full'}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
writeFileSync(path.join(receiptRoot, 'latest.json'), `${JSON.stringify(receipt, null, 2)}\n`);

console.log(
  `\nLOCAL CONTINUOUS KPI: ${outcome}; experiments ${experiments.kpi.governed}/${experiments.kpi.total}; `
  + `ungoverned=${experiments.kpi.ungoverned}; forbiddenProductionRefs=${experiments.kpi.forbiddenProductionReferences}; `
  + `releaseEvidence=${risk.present}/${risk.total} ${risk.status}; receipt=.lba/local-ci/latest.json`
);
if (outcome !== 'PASS') process.exitCode = 1;

function readFileExists(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}
