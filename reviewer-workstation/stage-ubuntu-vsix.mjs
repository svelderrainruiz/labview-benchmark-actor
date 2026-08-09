#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_ID = 'svelderrainruiz.labview-benchmark-actor';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateUbuntuReviewTarget(target) {
  const failures = [];
  if (target?.component !== 'extension') failures.push('target component must be extension');
  if (!/^\d+\.\d+\.\d+$/.test(target?.version ?? '')) failures.push('target version must be SemVer X.Y.Z');
  if (!/^[a-f0-9]{40}$/i.test(target?.commit ?? '')) failures.push('target commit must be 40-hex');
  if (!/^[a-f0-9]{64}$/i.test(target?.vsixSha256 ?? '')) failures.push('target vsixSha256 must be 64-hex');
  return { ok: failures.length === 0, failures };
}

export function validateUbuntuCandidateArtifact({ target, vsixBytes, manifest }) {
  const failures = [...validateUbuntuReviewTarget(target).failures];
  const actualSha256 = sha256(vsixBytes);
  if (actualSha256 !== String(target?.vsixSha256 ?? '').toLowerCase()) failures.push('VSIX SHA-256 does not match target');
  if (manifest?.name !== 'labview-benchmark-actor'
      || manifest?.publisher !== 'svelderrainruiz'
      || manifest?.version !== target?.version) {
    failures.push('VSIX manifest identity does not match target');
  }
  return { ok: failures.length === 0, failures, actualSha256 };
}

export function validateUbuntuStageEvidence({ target, vsixBytes, manifest, installedExtensions }) {
  const artifact = validateUbuntuCandidateArtifact({ target, vsixBytes, manifest });
  const failures = [...artifact.failures];
  const expectedInstalled = `${EXTENSION_ID}@${target?.version ?? ''}`.toLowerCase();
  if (!installedExtensions.map((item) => item.trim().toLowerCase()).includes(expectedInstalled)) {
    failures.push(`installed extension list does not contain ${expectedInstalled}`);
  }
  return {
    ok: failures.length === 0,
    failures,
    actualSha256: artifact.actualSha256,
    expectedInstalled,
  };
}

export function validateUbuntuKpiReceipt({ target, kpi, vsixBytes, coverageFloors }) {
  const failures = [];
  const candidate = kpi?.kpi?.candidate;
  const localGates = kpi?.kpi?.localGates;
  const pkg = kpi?.kpi?.package;
  const coverage = kpi?.kpi?.coverage;
  const correspondences = kpi?.kpi?.correspondences;
  const actualSha256 = sha256(vsixBytes);
  if (kpi?.schema !== 'labview-benchmark-actor/local-continuous-kpi@1'
      || kpi?.mode !== 'full'
      || kpi?.outcome !== 'PASS') {
    failures.push('candidate KPI must be a passing full local-continuous-kpi@1 receipt');
  }
  if (kpi?.version !== target?.version) failures.push('candidate KPI version does not match target');
  if (String(candidate?.sourceCommit ?? '').toLowerCase() !== String(target?.commit ?? '').toLowerCase()) {
    failures.push('candidate KPI commit does not match target');
  }
  if (String(candidate?.vsixSha256 ?? '').toLowerCase() !== actualSha256
      || String(target?.vsixSha256 ?? '').toLowerCase() !== actualSha256) {
    failures.push('candidate KPI VSIX SHA-256 does not match target bytes');
  }
  if (candidate?.vsixSize !== vsixBytes.length) failures.push('candidate KPI VSIX size does not match target bytes');
  if (candidate?.worktreeCleanBefore !== true || candidate?.worktreeCleanAfter !== true) {
    failures.push('candidate KPI must attest a clean worktree before and after');
  }
  if (!Number.isInteger(localGates?.total)
      || localGates.total < 1
      || localGates?.passed !== localGates.total) {
    failures.push('candidate KPI local gates must all pass');
  }
  if (pkg?.identical !== true
      || String(pkg?.firstSha256 ?? '').toLowerCase() !== actualSha256
      || String(pkg?.secondSha256 ?? '').toLowerCase() !== actualSha256) {
    failures.push('candidate KPI must attest byte-identical packages for the target VSIX');
  }
  for (const metric of ['lines', 'statements', 'functions', 'branches']) {
    const floor = coverageFloors?.[metric];
    const percent = coverage?.[metric]?.percent;
    if (!Number.isFinite(floor) || !Number.isFinite(percent) || percent < floor) {
      failures.push(`candidate KPI ${metric} coverage does not meet the governed floor`);
    }
  }
  if (!Number.isInteger(correspondences?.total)
      || correspondences.total < 1
      || correspondences?.passed !== correspondences.total
      || correspondences?.graphConformant !== true) {
    failures.push('candidate KPI correspondences must all pass with a conformant graph');
  }
  return { ok: failures.length === 0, failures, actualSha256 };
}

export function validateUbuntuVmIdentity({ identity, expectedProvider, expectedMachineId }) {
  const failures = [];
  if (expectedProvider !== 'oracle') failures.push('Ubuntu reviewer VM provider must be oracle');
  if (!/^[a-f0-9]{32}$/i.test(expectedMachineId ?? '')) failures.push('expected Ubuntu reviewer machine id must be 32-hex');
  if (identity?.provider !== expectedProvider) failures.push('detected virtualization provider does not match expected provider');
  if (String(identity?.machineId ?? '').toLowerCase() !== String(expectedMachineId ?? '').toLowerCase()) {
    failures.push('detected Ubuntu reviewer machine id does not match expected machine id');
  }
  if (!/^VirtualBox$/i.test(String(identity?.productName ?? '').trim())) {
    failures.push('detected Ubuntu reviewer product must be VirtualBox');
  }
  return { ok: failures.length === 0, failures };
}

export function validateUbuntuStageHost({ runningCodePids }) {
  const failures = [];
  if (String(runningCodePids ?? '').trim()) {
    failures.push('fully close every VS Code process before staging the Ubuntu reviewer candidate');
  }
  return { ok: failures.length === 0, failures };
}

export function validateUbuntuKpiInventories({ kpi, localGateOutput, correspondenceOutput }) {
  const failures = [];
  const gateSummary = /(\d+)\/(\d+) checks passed/.exec(String(localGateOutput ?? ''));
  const correspondenceSummary = /governed-tests=(\d+)/.exec(String(correspondenceOutput ?? ''));
  const correspondencePass = /all correspondence rules PASS \(graph conformant\)/.test(String(correspondenceOutput ?? ''));
  const expectedGateTotal = gateSummary ? Number(gateSummary[2]) : null;
  const expectedCorrespondenceTotal = correspondenceSummary ? Number(correspondenceSummary[1]) : null;
  if (!gateSummary || gateSummary[1] !== gateSummary[2]) failures.push('exact local gate inventory did not pass');
  if (!correspondenceSummary || !correspondencePass) failures.push('exact correspondence inventory did not pass');
  if (kpi?.kpi?.localGates?.passed !== expectedGateTotal
      || kpi?.kpi?.localGates?.total !== expectedGateTotal) {
    failures.push('candidate KPI local gate inventory does not match the exact source');
  }
  if (kpi?.kpi?.correspondences?.passed !== expectedCorrespondenceTotal
      || kpi?.kpi?.correspondences?.total !== expectedCorrespondenceTotal) {
    failures.push('candidate KPI correspondence inventory does not match the exact source');
  }
  return {
    ok: failures.length === 0,
    failures,
    expectedGateTotal,
    expectedCorrespondenceTotal,
  };
}

function selectedCodeExecutables(codeCommand) {
  const commandPath = codeCommand.includes('/')
    ? realpathSync(resolve(codeCommand))
    : realpathSync(execFileSync('which', [codeCommand], { encoding: 'utf8' }).trim());
  const executables = new Set([commandPath]);
  if (basename(dirname(commandPath)) === 'bin') {
    const productExecutable = join(dirname(dirname(commandPath)), basename(commandPath));
    if (existsSync(productExecutable)) executables.add(realpathSync(productExecutable));
  }
  return executables;
}

function runningCodeProcessIds(codeCommand) {
  const executables = selectedCodeExecutables(codeCommand);
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)
    .filter((entry) => {
      try {
        return executables.has(readlinkSync(join('/proc', entry, 'exe')));
      } catch {
        return false;
      }
    })
    .join('\n');
}

function detectUbuntuVmIdentity() {
  let provider;
  try {
    provider = execFileSync('systemd-detect-virt', ['--vm'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Ubuntu reviewer staging requires a detected virtual machine');
  }
  return {
    provider,
    machineId: readFileSync('/etc/machine-id', 'utf8').trim(),
    productName: readFileSync('/sys/class/dmi/id/product_name', 'utf8').trim(),
  };
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values[name.slice(2)] = value;
    index += 1;
  }
  return values;
}

function main() {
  if (process.platform !== 'linux') throw new Error('Ubuntu candidate staging must run inside the Linux reviewer VM');
  const args = parseArgs(process.argv.slice(2));
  for (const name of ['vsix', 'target', 'kpi', 'workspace', 'receipt', 'handoff', 'vm-provider', 'vm-id']) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  const code = args.code || 'code';
  const vsixPath = resolve(args.vsix);
  const targetPath = resolve(args.target);
  const kpiPath = resolve(args.kpi);
  const workspace = resolve(args.workspace);
  const receiptPath = resolve(args.receipt);
  const handoff = resolve(args.handoff);
  const target = JSON.parse(readFileSync(targetPath, 'utf8'));
  const kpi = JSON.parse(readFileSync(kpiPath, 'utf8'));
  const coverageFloors = JSON.parse(readFileSync(join(ROOT, 'coverage-thresholds.json'), 'utf8')).floor;
  const targetShape = validateUbuntuReviewTarget(target);
  if (!targetShape.ok) throw new Error(targetShape.failures.join('; '));
  const vsixBytes = readFileSync(vsixPath);
  const manifest = JSON.parse(execFileSync('unzip', ['-p', vsixPath, 'extension/package.json'], { encoding: 'utf8' }));
  const candidate = validateUbuntuCandidateArtifact({ target, vsixBytes, manifest });
  if (!candidate.ok) throw new Error(candidate.failures.join('; '));
  const kpiEvidence = validateUbuntuKpiReceipt({ target, kpi, vsixBytes, coverageFloors });
  if (!kpiEvidence.ok) throw new Error(kpiEvidence.failures.join('; '));
  const localGateOutput = execFileSync(
    process.execPath,
    [join(ROOT, 'experiments', 'verify-local-gates.mjs')],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const correspondenceOutput = execFileSync(
    process.execPath,
    [join(ROOT, 'experiments', 'reqs-coverage', 'verify-correspondences.mjs')],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const inventoryEvidence = validateUbuntuKpiInventories({ kpi, localGateOutput, correspondenceOutput });
  if (!inventoryEvidence.ok) throw new Error(inventoryEvidence.failures.join('; '));
  const vmIdentity = detectUbuntuVmIdentity();
  const vmEvidence = validateUbuntuVmIdentity({
    identity: vmIdentity,
    expectedProvider: args['vm-provider'],
    expectedMachineId: args['vm-id'],
  });
  if (!vmEvidence.ok) throw new Error(vmEvidence.failures.join('; '));
  const hostEvidence = validateUbuntuStageHost({ runningCodePids: runningCodeProcessIds(code) });
  if (!hostEvidence.ok) throw new Error(hostEvidence.failures.join('; '));
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  mkdirSync(handoff, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  execFileSync(code, ['--install-extension', vsixPath, '--force'], { stdio: 'inherit' });
  const installedExtensions = execFileSync(code, ['--list-extensions', '--show-versions'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const evidence = validateUbuntuStageEvidence({ target, vsixBytes, manifest, installedExtensions });
  if (!evidence.ok) throw new Error(evidence.failures.join('; '));
  const stagedVsix = join(workspace, basename(vsixPath));
  const stagedTarget = join(workspace, 'review-target.json');
  const stagedKpi = join(workspace, 'local-kpi.json');
  const stagedMarker = join(workspace, 'reviewer-station.json');
  const handoffTarget = join(handoff, 'review-target.json');
  const handoffMarker = join(handoff, 'reviewer-station.json');
  copyFileSync(vsixPath, stagedVsix);
  copyFileSync(targetPath, stagedTarget);
  copyFileSync(kpiPath, stagedKpi);
  const stationMarker = {
    schema: 'labview-benchmark-actor/reviewer-station@1',
    station: 'UBUNTU_VM',
    target: {
      component: target.component,
      version: target.version,
      commit: target.commit,
      vsixSha256: evidence.actualSha256,
    },
    stagedAt: new Date().toISOString(),
    virtualization: vmIdentity,
  };
  writeJsonAtomic(stagedMarker, stationMarker);
  writeJsonAtomic(handoffTarget, target);
  writeJsonAtomic(handoffMarker, stationMarker);
  const finishedNs = process.hrtime.bigint();
  const receipt = {
    schema: 'labview-benchmark-actor/ubuntu-review-stage@1',
    candidate: {
      ...target,
      vsixSha256: evidence.actualSha256,
    },
    station: 'UBUNTU_VM',
    platform: {
      os: process.platform,
      arch: process.arch,
      virtualization: vmIdentity,
    },
    artifacts: {
      vsix: stagedVsix,
      reviewTarget: stagedTarget,
      localKpi: stagedKpi,
      reviewerStation: stagedMarker,
      handoffReviewTarget: handoffTarget,
      handoffReviewerStation: handoffMarker,
    },
    installedExtension: evidence.expectedInstalled,
    verifiedInventories: {
      localGates: inventoryEvidence.expectedGateTotal,
      correspondences: inventoryEvidence.expectedCorrespondenceTotal,
    },
    timing: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationNs: String(finishedNs - startedNs),
      monotonicClockSource: 'process.hrtime.bigint',
    },
    outcome: 'PASS',
    extensionHostWasStopped: true,
    failures: [],
  };
  writeJsonAtomic(receiptPath, receipt);
  console.log(`ubuntu reviewer candidate staged: ${receipt.installedExtension} ${receipt.candidate.vsixSha256}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`stage-ubuntu-vsix: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
