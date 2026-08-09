#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnInvocation } from '../extension-tasks/process-command.mjs';
import { verifyManifest as verifyAgentsManifest, agentsSha256, readManifest as readAgentsManifest, AGENTS_MD as EXTENSION_AGENTS_MD } from '../scripts/agentsManifest.mjs';
import { parseCorrespondenceSummary, parseCoverageSummary, parseLocalGateSummary } from '../scripts/local-kpi-core.mjs';
import { buildCloseout, closeoutDigest, validateCloseout } from './release-risk-closeout.mjs';

export const SCHEMA = 'labview-benchmark-actor/continuation-readiness@1';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CONTINUATION_DIR = join(ROOT, '.lba', 'continuation');
const OUTPUT_PATH = join(CONTINUATION_DIR, 'readiness.json');
const TEMP_OUTPUT_PATH = join(CONTINUATION_DIR, 'readiness.json.tmp');
const LBABUS_PATH = 'C:\\lba-tools\\lbabus\\lbabus.exe';
const EXPECTED_NODE = '24.19.0';
const EXPECTED_NPM = '11.17.0';
const EXPECTED_DOTNET = '8.0';
const EXPECTED_GLAB = '1.25';
const EXPECTED_LBABUS = '0.15.8';
const EXPECTED_AGENTS_VERSION = '0.3.13';
const EXPECTED_AGENTS_SHA256 = '02ce9b7b0f69dca6e0297b07940eafc3ffc90681668d590d472bb24dc2f717a9';
const BASELINE_CLOSEOUT_SUMMARY = { present: 12, total: 28, status: 'BLOCKED' };
const POST_RELEASE_CLOSEOUT = {
  present: 28,
  total: 28,
  status: 'READY',
  digest: '44211071bf94c637c82e1b9571c4bee174a4d076bba2c5742153a8b7d1cac36a',
};

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

export function receiptDigest(receipt) {
  const body = JSON.parse(JSON.stringify(receipt));
  delete body.receiptDigest;
  delete body.startedWallTime;
  delete body.finishedWallTime;
  delete body.durationNs;
  if (Array.isArray(body.events)) {
    body.events = body.events.map((event) => ({ ...event, durationNs: undefined }));
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

export function classifyWorktreeState({ trackedChanges = [], untrackedPaths = [], allowedUntrackedPaths = ['AGENTS.md', '.lba/continuation'] } = {}) {
  const normalizedUntracked = untrackedPaths.filter((entry) => entry && entry.trim());
  const trackedWorktreeClean = trackedChanges.length === 0;
  const disallowedUntrackedPaths = normalizedUntracked.filter((entry) => !allowedUntrackedPaths.some((allowed) => entry === allowed || entry.startsWith(`${allowed}/`)));
  return {
    trackedWorktreeClean,
    untrackedPaths: normalizedUntracked,
    disallowedUntrackedPaths,
    ok: trackedWorktreeClean && disallowedUntrackedPaths.length === 0,
  };
}

function normalizeForComparison(receipt) {
  const body = JSON.parse(JSON.stringify(receipt));
  delete body.receiptDigest;
  delete body.startedWallTime;
  delete body.finishedWallTime;
  delete body.durationNs;
  if (Array.isArray(body.events)) {
    body.events = body.events.map((event) => ({ ...event, durationNs: undefined }));
  }
  return body;
}

function compareVersions(actual, expected, { minimum = false } = {}) {
  const normalize = (value) => String(value).trim().replace(/^v/, '');
  const parse = (value) => {
    const match = normalize(value).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!match) return null;
    return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)];
  };
  const actualParts = parse(actual);
  const expectedParts = parse(expected);
  if (!actualParts || !expectedParts) return { ok: false, reason: `unable to compare ${actual} to ${expected}` };
  const compare = (a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if (a[i] > b[i]) return 1;
      if (a[i] < b[i]) return -1;
    }
    return 0;
  };
  const cmp = compare(actualParts, expectedParts);
  const ok = minimum ? cmp >= 0 : cmp === 0;
  return { ok, reason: ok ? null : `expected ${minimum ? '>= ' : '='}${expected} but got ${actual}` };
}

function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

function runCommand(command, args, { cwd = ROOT, allowFailure = false } = {}) {
  const invocation = spawnInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  const stdout = stripAnsi(result.stdout ?? '');
  const stderr = stripAnsi(result.stderr ?? '');
  if (!allowFailure && result.error) {
    throw result.error;
  }
  return {
    command: invocation.command,
    args: invocation.args,
    status: result.status,
    stdout,
    stderr,
    error: result.error ? String(result.error.message) : null,
  };
}

function resolveExecutablePath(command) {
  if (/\.cmd$/i.test(command) || /\.bat$/i.test(command)) {
    return command;
  }
  if (process.platform === 'win32') {
    const { stdout } = runCommand('where.exe', [command], { allowFailure: true });
    const first = (stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (first) return first;
    const fallbackCandidates = [];
    if (command === 'glab' || command === 'glab.exe') {
      const localApp = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'glab', 'glab.exe') : null;
      if (localApp) fallbackCandidates.push(localApp);
    }
    return fallbackCandidates.find((candidate) => existsSync(candidate)) || null;
  }
  const { stdout } = runCommand('which', [command], { allowFailure: true });
  const first = (stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  return first || null;
}

function probeCommand(command, args, { name, expectedVersion, minimum = false, required = true } = {}) {
  const resolvedCommand = resolveExecutablePath(command) || command;
  const probe = runCommand(resolvedCommand, args, { allowFailure: true });
  const available = !probe.error && probe.status === 0;
  const versionText = available ? stripAnsi((probe.stdout || probe.stderr || '').trim()) : '';
  const extracted = versionText.match(/(\d+\.\d+(?:\.\d+)?)/);
  const version = extracted ? extracted[1] : null;
  const versionCheck = version && expectedVersion ? compareVersions(version, expectedVersion, { minimum }) : null;
  return {
    name,
    command,
    args,
    path: available ? resolvedCommand : null,
    available,
    version,
    versionText,
    expected: expectedVersion,
    minimum,
    required,
    ok: available && (!expectedVersion || !versionCheck || versionCheck.ok),
    failure: available && expectedVersion && versionCheck && !versionCheck.ok ? versionCheck.reason : available ? null : `${name} probe failed`,
  };
}

export function buildReadinessReceipt(opts = {}) {
  const startedWallTime = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const failures = [];
  const receipt = {
    schema: SCHEMA,
    startedWallTime,
    finishedWallTime: null,
    monotonicClockSource: 'process.hrtime.bigint',
    durationNs: null,
    branch: null,
    head: null,
    upstream: null,
    originDevelop: null,
    mergeBase: null,
    headEqualsOriginDevelop: false,
    headIsAncestorOfOriginDevelop: false,
    originDevelopIsAncestorOfHead: false,
    trackedWorktreeClean: false,
    untrackedPaths: [],
    trackedChanges: [],
    agents: {
      rootMaterialized: false,
      canonicalMatch: false,
      version: null,
      sha256: null,
      expectedVersion: EXPECTED_AGENTS_VERSION,
      expectedSha256: EXPECTED_AGENTS_SHA256,
      rootPath: join(ROOT, 'AGENTS.md'),
      canonicalPath: EXTENSION_AGENTS_MD,
      manifestPath: join(ROOT, 'extension-agents', 'agents.manifest.json'),
      manifestVersion: null,
      manifestSha256: null,
    },
    tools: {},
    lbabus: {
      stablePath: LBABUS_PATH,
      stablePathExists: false,
      version: null,
      versionText: null,
      selfcheck: null,
      capabilities: null,
      selfcheckOk: false,
      capabilitiesOk: false,
    },
    capabilities: {
      available: [],
      unavailable: [],
    },
    baseline: {
      present: BASELINE_CLOSEOUT_SUMMARY.present,
      total: BASELINE_CLOSEOUT_SUMMARY.total,
      status: BASELINE_CLOSEOUT_SUMMARY.status,
      label: 'candidate-time 12/28 BLOCKED',
    },
    closeout: {
      present: POST_RELEASE_CLOSEOUT.present,
      total: POST_RELEASE_CLOSEOUT.total,
      status: POST_RELEASE_CLOSEOUT.status,
      digest: POST_RELEASE_CLOSEOUT.digest,
      label: 'post-release 28/28 READY',
    },
    localGates: null,
    correspondences: null,
    quickKpi: null,
    releaseSigning: { status: 'closed' },
    outcome: 'FAIL',
    failures,
    receiptDigest: null,
    receiptPath: OUTPUT_PATH,
  };

  const gitStatus = runCommand('git', ['status', '--short', '--branch', '--untracked-files=all'], { allowFailure: true });
  const branch = gitStatus.stdout.split(/\r?\n/).find((line) => line.startsWith('## '))?.replace(/^##\s*/, '') || null;
  const head = runCommand('git', ['rev-parse', 'HEAD'], { allowFailure: true }).stdout.trim();
  const originDevelop = runCommand('git', ['rev-parse', '--verify', 'origin/develop'], { allowFailure: true }).stdout.trim();
  const mergeBase = originDevelop ? runCommand('git', ['merge-base', 'HEAD', 'origin/develop'], { allowFailure: true }).stdout.trim() : null;
  const upstream = runCommand('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true }).stdout.trim();
  const statusLines = gitStatus.stdout.split(/\r?\n/).filter(Boolean).filter((line) => !line.startsWith('## '));
  const trackedChanges = statusLines.filter((line) => !line.startsWith('?? '));
  const untrackedPaths = statusLines.filter((line) => line.startsWith('?? ')).map((line) => line.replace(/^\?\?\s+/, ''));
  const worktreeState = classifyWorktreeState({ trackedChanges, untrackedPaths });
  receipt.branch = branch;
  receipt.head = head;
  receipt.upstream = upstream || null;
  receipt.originDevelop = originDevelop || null;
  receipt.mergeBase = mergeBase || null;
  receipt.headEqualsOriginDevelop = head && originDevelop && head === originDevelop;
  receipt.headIsAncestorOfOriginDevelop = !!(head && originDevelop && mergeBase && mergeBase === head);
  receipt.originDevelopIsAncestorOfHead = !!(head && originDevelop && mergeBase && mergeBase === originDevelop);
  receipt.trackedWorktreeClean = worktreeState.trackedWorktreeClean;
  receipt.untrackedPaths = worktreeState.untrackedPaths;
  receipt.trackedChanges = trackedChanges;
  if (!receipt.headEqualsOriginDevelop && !receipt.originDevelopIsAncestorOfHead) {
    failures.push(`HEAD ${head || '(missing)'} is neither equal to nor based on origin/develop ${originDevelop || '(missing)'}`);
  }
  if (!worktreeState.trackedWorktreeClean) failures.push('tracked worktree is not clean');
  if (worktreeState.disallowedUntrackedPaths.length > 0) failures.push(`disallowed untracked paths: ${worktreeState.disallowedUntrackedPaths.join(', ')}`);

  const manifest = readAgentsManifest();
  const agentsManifest = verifyAgentsManifest();
  const agentsFile = existsSync(join(ROOT, 'AGENTS.md')) ? readFileSync(join(ROOT, 'AGENTS.md'), 'utf8') : null;
  const rootAgentsSha = agentsFile ? agentsSha256(agentsFile) : null;
  const canonicalAgents = readFileSync(EXTENSION_AGENTS_MD, 'utf8');
  const canonicalSha = agentsSha256(canonicalAgents);
  const manifestVersion = manifest.version || null;
  const manifestSha = manifest.sha256 || null;
  receipt.agents.rootMaterialized = existsSync(join(ROOT, 'AGENTS.md'));
  receipt.agents.canonicalMatch = !!agentsFile && rootAgentsSha === canonicalSha && rootAgentsSha === manifestSha;
  receipt.agents.version = manifestVersion;
  receipt.agents.sha256 = rootAgentsSha;
  receipt.agents.manifestVersion = manifestVersion;
  receipt.agents.manifestSha256 = manifestSha;
  if (!agentsManifest.ok) failures.push(...agentsManifest.errors.map((error) => `AGENTS manifest: ${error}`));
  if (receipt.agents.version !== EXPECTED_AGENTS_VERSION) failures.push(`AGENTS version ${receipt.agents.version || '(missing)'} does not match ${EXPECTED_AGENTS_VERSION}`);
  if (receipt.agents.sha256 !== EXPECTED_AGENTS_SHA256) failures.push(`AGENTS SHA-256 ${receipt.agents.sha256 || '(missing)'} does not match ${EXPECTED_AGENTS_SHA256}`);
  if (!receipt.agents.rootMaterialized) failures.push('root AGENTS.md is missing');
  if (!receipt.agents.canonicalMatch) failures.push('root AGENTS.md does not match the canonical shipped AGENTS.md');

  const nodeProbe = probeCommand(process.execPath, ['--version'], { name: 'Node.js', expectedVersion: EXPECTED_NODE, required: true });
  const npmProbe = probeCommand('npm.cmd', ['--version'], { name: 'npm', expectedVersion: EXPECTED_NPM, required: true });
  const dotnetProbe = probeCommand('dotnet', ['--version'], { name: '.NET SDK', expectedVersion: EXPECTED_DOTNET, minimum: true, required: true });
  const glabProbe = probeCommand('glab', ['--version'], { name: 'glab', expectedVersion: EXPECTED_GLAB, minimum: true, required: true });
  const lbabusVersionProbe = probeCommand(LBABUS_PATH, ['version'], { name: 'lbabus', expectedVersion: EXPECTED_LBABUS, required: true });
  receipt.tools.node = nodeProbe;
  receipt.tools.npm = npmProbe;
  receipt.tools.dotnet = dotnetProbe;
  receipt.tools.glab = glabProbe;
  receipt.tools.lbabus = lbabusVersionProbe;
  if (!nodeProbe.ok) failures.push(nodeProbe.failure || 'Node.js probe failed');
  if (!npmProbe.ok) failures.push(npmProbe.failure || 'npm probe failed');
  if (!dotnetProbe.ok) failures.push(dotnetProbe.failure || '.NET SDK probe failed');
  if (!glabProbe.ok) failures.push(glabProbe.failure || 'glab probe failed');
  if (!lbabusVersionProbe.ok) failures.push(lbabusVersionProbe.failure || 'lbabus version probe failed');

  const lbabusSelfcheck = runCommand(LBABUS_PATH, ['selfcheck'], { allowFailure: true });
  const lbabusCapabilities = runCommand(LBABUS_PATH, ['capabilities'], { allowFailure: true });
  receipt.lbabus.stablePathExists = existsSync(LBABUS_PATH);
  receipt.lbabus.version = lbabusVersionProbe.version;
  receipt.lbabus.versionText = lbabusVersionProbe.versionText;
  receipt.lbabus.selfcheck = {
    command: LBABUS_PATH,
    args: ['selfcheck'],
    status: lbabusSelfcheck.status,
    stdout: lbabusSelfcheck.stdout.trim(),
    stderr: lbabusSelfcheck.stderr.trim(),
    error: lbabusSelfcheck.error,
  };
  receipt.lbabus.capabilities = {
    command: LBABUS_PATH,
    args: ['capabilities'],
    status: lbabusCapabilities.status,
    stdout: lbabusCapabilities.stdout.trim(),
    stderr: lbabusCapabilities.stderr.trim(),
    error: lbabusCapabilities.error,
  };
  receipt.lbabus.selfcheckOk = !lbabusSelfcheck.error && lbabusSelfcheck.status === 0;
  receipt.lbabus.capabilitiesOk = !lbabusCapabilities.error && lbabusCapabilities.status === 0;
  if (!receipt.lbabus.selfcheckOk) failures.push('lbabus selfcheck failed');
  if (!receipt.lbabus.capabilitiesOk) failures.push('lbabus capabilities probe failed');

  const capabilityNames = ['docker', 'vagrant', 'virtualbox', 'vmware', 'tightvnc', 'labview', 'labviewcli', 'vipm', 'ffmpeg', 'git', 'rg', 'gh', 'signing-key'];
  const capabilityEntries = capabilityNames.map((name) => {
    let probe;
    if (name === 'signing-key') {
      probe = { available: false, version: null, versionText: '', reason: 'not evidenced in this host probe' };
    } else if (name === 'git') {
      probe = probeCommand('git', ['--version'], { name, required: false });
    } else if (name === 'rg') {
      probe = probeCommand('rg', ['--version'], { name, required: false });
    } else if (name === 'gh') {
      probe = probeCommand('gh', ['--version'], { name, required: false });
    } else if (name === 'labview') {
      probe = probeCommand('labview.exe', ['--version'], { name, required: false });
    } else if (name === 'labviewcli') {
      probe = probeCommand('labviewcli.exe', ['--version'], { name, required: false });
    } else if (name === 'virtualbox') {
      probe = probeCommand('virtualbox', ['--help'], { name, required: false });
    } else if (name === 'vmware') {
      probe = probeCommand('vmrun', ['-v'], { name, required: false });
    } else if (name === 'tightvnc') {
      probe = probeCommand('tightvnc', ['--version'], { name, required: false });
    } else if (name === 'signing-key') {
      probe = { available: false, version: null, versionText: '', reason: 'not evidenced in this host probe' };
    } else {
      probe = probeCommand(name, ['--version'], { name, required: false });
    }
    return probe;
  });
  receipt.capabilities.available = capabilityEntries.filter((entry) => entry.available).map((entry) => ({ name: entry.name, path: entry.path, version: entry.version }));
  receipt.capabilities.unavailable = capabilityEntries.filter((entry) => !entry.available).map((entry) => ({ name: entry.name, reason: entry.failure || 'not available' }));

  const baselinePath = join(ROOT, 'release-risk-baseline.json');
  const closeoutPath = join(ROOT, 'release-risk-closeout.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const closeout = JSON.parse(readFileSync(closeoutPath, 'utf8'));
  const closeoutResult = validateCloseout(closeout, baseline, { root: ROOT });
  const closeoutDigestValue = closeoutDigest(closeout);
  if (!closeoutResult.ok) failures.push(...closeoutResult.findings.map((finding) => `release closeout: ${finding}`));
  if (closeoutDigestValue !== POST_RELEASE_CLOSEOUT.digest) failures.push(`post-release closeout digest ${closeoutDigestValue} does not match ${POST_RELEASE_CLOSEOUT.digest}`);
  if (closeout?.summary?.status !== 'READY') failures.push('release-risk-closeout summary is not READY');

  const gateResult = runCommand(process.execPath, ['experiments/verify-local-gates.mjs'], { allowFailure: true });
  const localGateSummary = gateResult.stdout.match(/(\d+)\/(\d+) checks passed/);
  if (gateResult.status !== 0 || !localGateSummary) {
    failures.push(`local gates failed: ${gateResult.stdout || gateResult.stderr || 'no summary line'}`);
  }
  receipt.localGates = {
    command: process.execPath,
    args: ['experiments/verify-local-gates.mjs'],
    status: gateResult.status,
    stdout: gateResult.stdout.trim(),
    stderr: gateResult.stderr.trim(),
    summary: localGateSummary ? { passed: Number(localGateSummary[1]), total: Number(localGateSummary[2]) } : null,
  };
  if (receipt.localGates.summary) {
    receipt.localGates.summary.ok = receipt.localGates.summary.passed === receipt.localGates.summary.total;
  }

  const correspondenceResult = runCommand(process.execPath, ['experiments/reqs-coverage/verify-correspondences.mjs'], { allowFailure: true });
  let correspondenceSummary = null;
  try {
    correspondenceSummary = parseCorrespondenceSummary(correspondenceResult.stdout + '\n' + correspondenceResult.stderr);
  } catch (error) {
    failures.push(`correspondence verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (correspondenceResult.status !== 0 || !correspondenceSummary?.graphConformant) {
    failures.push(`correspondence verification failed: ${correspondenceResult.stdout || correspondenceResult.stderr || 'no summary'}`);
  }
  receipt.correspondences = {
    command: process.execPath,
    args: ['experiments/reqs-coverage/verify-correspondences.mjs'],
    status: correspondenceResult.status,
    stdout: correspondenceResult.stdout.trim(),
    stderr: correspondenceResult.stderr.trim(),
    summary: correspondenceSummary,
  };

  const quickKpiResult = runCommand(process.execPath, [join(ROOT, 'scripts', 'local-continuous-kpi.mjs'), '--quick'], { allowFailure: true });
  let quickKpiReceipt = null;
  const latestQuickKpiPath = join(ROOT, '.lba', 'local-ci', 'latest.json');
  if (existsSync(latestQuickKpiPath)) {
    quickKpiReceipt = JSON.parse(readFileSync(latestQuickKpiPath, 'utf8'));
  }
  receipt.quickKpi = {
    command: process.execPath,
    args: [join(ROOT, 'scripts', 'local-continuous-kpi.mjs'), '--quick'],
    status: quickKpiResult.status,
    stdout: quickKpiResult.stdout.trim(),
    stderr: quickKpiResult.stderr.trim(),
    latestReceiptPath: latestQuickKpiPath,
    latestReceipt: quickKpiReceipt,
  };
  if (quickKpiResult.status !== 0 || !quickKpiReceipt || quickKpiReceipt.outcome !== 'PASS') {
    failures.push(`quick KPI failed: ${quickKpiResult.stdout || quickKpiResult.stderr || 'no receipt'}`);
  }
  if (quickKpiReceipt?.kpi?.localGates?.passed && quickKpiReceipt?.kpi?.correspondences?.passed) {
    receipt.quickKpi.summary = {
      outcome: quickKpiReceipt.outcome,
      localGates: quickKpiReceipt.kpi.localGates,
      correspondences: quickKpiReceipt.kpi.correspondences,
      experiments: quickKpiReceipt.kpi.experiments,
      coverage: quickKpiReceipt.kpi.coverage,
      package: quickKpiReceipt.kpi.package,
    };
  }

  const uniqueFailures = [...new Set(failures)].filter(Boolean);
  receipt.failures = uniqueFailures;
  receipt.outcome = uniqueFailures.length === 0 ? 'PASS' : 'FAIL';
  receipt.finishedWallTime = new Date().toISOString();
  receipt.durationNs = (process.hrtime.bigint() - startedNs).toString();
  receipt.receiptDigest = receiptDigest(receipt);
  return receipt;
}

export function findSecretBearingFields(value, path = '$') {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findSecretBearingFields(entry, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  const findings = [];
  for (const [key, child] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (/(token|password|secret|private|keyMaterial|privateKeyPath)/i.test(key)) {
      findings.push(nextPath);
    }
    findings.push(...findSecretBearingFields(child, nextPath));
  }
  return findings;
}

export function validateReceipt(receipt) {
  const failures = [];
  if (receipt.schema !== SCHEMA) failures.push(`schema must be ${SCHEMA}`);
  if (!receipt.startedWallTime) failures.push('startedWallTime is required');
  if (!receipt.finishedWallTime) failures.push('finishedWallTime is required');
  if (!receipt.monotonicClockSource || receipt.monotonicClockSource !== 'process.hrtime.bigint') failures.push('monotonicClockSource must be process.hrtime.bigint');
  if (!receipt.durationNs) failures.push('durationNs is required');
  if (!receipt.branch) failures.push('branch is required');
  if (!receipt.head) failures.push('head is required');
  if (!receipt.originDevelop) failures.push('origin/develop is required');
  if (!receipt.agents || !receipt.agents.rootMaterialized) failures.push('root AGENTS.md materialization is required');
  if (!receipt.agents || receipt.agents.version !== EXPECTED_AGENTS_VERSION) failures.push(`AGENTS version must be ${EXPECTED_AGENTS_VERSION}`);
  if (!receipt.agents || receipt.agents.sha256 !== EXPECTED_AGENTS_SHA256) failures.push(`AGENTS SHA-256 must be ${EXPECTED_AGENTS_SHA256}`);
  if (!receipt.tools?.node?.ok) failures.push('Node.js probe must pass');
  if (!receipt.tools?.npm?.ok) failures.push('npm probe must pass');
  if (!receipt.tools?.dotnet?.ok) failures.push('.NET SDK probe must pass');
  if (!receipt.tools?.glab?.ok) failures.push('glab probe must pass');
  if (!receipt.tools?.lbabus?.ok) failures.push('lbabus version probe must pass');
  if (!receipt.lbabus?.selfcheckOk) failures.push('lbabus selfcheck must pass');
  if (!receipt.lbabus?.capabilitiesOk) failures.push('lbabus capabilities must pass');
  if (!receipt.trackedWorktreeClean) failures.push('tracked worktree must be clean');
  if (!receipt.headEqualsOriginDevelop && !receipt.originDevelopIsAncestorOfHead) failures.push('HEAD must equal origin/develop or be based on it');
  if (receipt.baseline?.status !== 'BLOCKED' || receipt.baseline?.present !== 12 || receipt.baseline?.total !== 28) failures.push('baseline must remain 12/28 BLOCKED');
  if (receipt.closeout?.status !== 'READY' || receipt.closeout?.present !== 28 || receipt.closeout?.total !== 28) failures.push('closeout must remain 28/28 READY');
  if (receipt.outcome !== 'PASS') failures.push('overall outcome must be PASS');
  if (receipt.releaseSigning?.status !== 'closed') failures.push('release/signing status must be closed');
  if (!receipt.localGates?.summary || receipt.localGates.summary.passed !== receipt.localGates.summary.total) failures.push('local gates must be fully green');
  if (!receipt.correspondences?.summary?.graphConformant) failures.push('correspondences must be graph-conformant');
  if (!receipt.quickKpi?.latestReceipt || receipt.quickKpi.latestReceipt.outcome !== 'PASS') failures.push('quick KPI receipt must be PASS');
  if (findSecretBearingFields(receipt).length > 0) failures.push('secret-bearing fields are not allowed');
  if (receipt.receiptDigest !== receiptDigest(receipt)) failures.push('receipt digest is invalid');
  return { ok: failures.length === 0, failures };
}

function writeReceiptAtomically(receipt) {
  mkdirSync(CONTINUATION_DIR, { recursive: true });
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(TEMP_OUTPUT_PATH, content);
  renameSync(TEMP_OUTPUT_PATH, OUTPUT_PATH);
}

function ensureOutputPathIgnored() {
  if (!existsSync(join(ROOT, '.gitignore'))) return;
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  if (!gitignore.includes('.lba/')) {
    writeFileSync(join(ROOT, '.gitignore'), `${gitignore}\n.lba/\n`);
  }
}

function main() {
  const checkMode = process.argv.includes('--check');
  if (checkMode) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error(`continuation-readiness: missing receipt ${OUTPUT_PATH}`);
      process.exit(1);
    }
    const stored = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
    const current = buildReadinessReceipt();
    const normalizedStored = normalizeForComparison(stored);
    const normalizedCurrent = normalizeForComparison(current);
    const currentJson = JSON.stringify(normalizedCurrent);
    const storedJson = JSON.stringify(normalizedStored);
    const validation = validateReceipt(current);
    if (!validation.ok) {
      console.error('continuation-readiness: receipt validation failed');
      for (const failure of validation.failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    if (storedJson !== currentJson) {
      console.error('continuation-readiness: receipt drift detected');
      process.exit(1);
    }
    console.log(`continuation-readiness: receipt OK ${OUTPUT_PATH}`);
    return;
  }
  const receipt = buildReadinessReceipt();
  const validation = validateReceipt(receipt);
  if (!validation.ok) {
    console.error('continuation-readiness: FAIL');
    for (const failure of validation.failures) console.error(`  - ${failure}`);
    writeReceiptAtomically(receipt);
    process.exit(1);
  }
  ensureOutputPathIgnored();
  writeReceiptAtomically(receipt);
  console.log(`continuation-readiness: PASS ${OUTPUT_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
