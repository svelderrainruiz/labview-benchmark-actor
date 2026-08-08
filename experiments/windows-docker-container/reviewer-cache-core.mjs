#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'labview-benchmark-actor/windows-vagrant-reviewer-cache@1';

const SHA256_RE = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(label, 'is required');
  return value.trim();
}

function bool(value, label) {
  if (typeof value !== 'boolean') fail(label, 'must be a boolean');
  return value;
}

function integer(value, label, min = 0) {
  if (!Number.isInteger(value) || value < min) fail(label, `must be an integer >= ${min}`);
  return value;
}

function finiteNumber(value, label, min = Number.NEGATIVE_INFINITY) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(label, `must be a finite number >= ${min}`);
  return value;
}

function sha256(value, label) {
  const normalized = text(value, label).toLowerCase();
  if (!SHA256_RE.test(normalized)) fail(label, 'must be a SHA-256 hex digest');
  return normalized;
}

function uuid(value, label) {
  const normalized = text(value, label).toLowerCase();
  if (!UUID_RE.test(normalized)) fail(label, 'must be a UUID');
  return normalized;
}

function absolutePath(value, label) {
  const normalized = text(value, label);
  if (!path.win32.isAbsolute(normalized) && !path.posix.isAbsolute(normalized)) {
    fail(label, 'must be an absolute path');
  }
  return normalized;
}

function normalizeFileRef(ref, label) {
  if (!isRecord(ref)) fail(label, 'must be an object');
  return {
    path: text(ref.path, `${label}.path`),
    size: integer(ref.size, `${label}.size`, 1),
    sha256: sha256(ref.sha256, `${label}.sha256`),
    role: ref.role === undefined || ref.role === null ? null : text(ref.role, `${label}.role`),
    name: ref.name === undefined || ref.name === null ? null : text(ref.name, `${label}.name`),
    provider: ref.provider === undefined || ref.provider === null ? null : text(ref.provider, `${label}.provider`).toLowerCase(),
    version: ref.version === undefined || ref.version === null ? null : text(ref.version, `${label}.version`),
  };
}

function normalizeInvocation(invocation, label) {
  if (!isRecord(invocation)) fail(label, 'is required');
  const command = text(invocation.command, `${label}.command`);
  const args = Array.isArray(invocation.args)
    ? invocation.args.map((value, index) => text(value, `${label}.args[${index}]`))
    : fail(`${label}.args`, 'is required');
  return { command, args };
}

function normalizeEvidenceList(list, label) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail(label, 'must be an array');
  return list.map((entry, index) => normalizeFileRef(entry, `${label}[${index}]`));
}

function normalizePackage(receipt) {
  const file = normalizeFileRef(receipt.package, 'package');
  const name = text(receipt.package.name, 'package.name');
  const provider = text(receipt.package.provider, 'package.provider').toLowerCase();
  const version = receipt.package.version === undefined ? null : text(receipt.package.version, 'package.version');
  const role = receipt.package.role === undefined ? 'box-package' : text(receipt.package.role, 'package.role');
  if (role !== 'box-package') fail('package.role', 'must be box-package');
  return { ...file, name, provider, version, role };
}

function normalizeRegistration(receipt, packageRef) {
  const registration = isRecord(receipt.registration) ? receipt.registration : fail('registration', 'is required');
  const name = text(registration.name, 'registration.name');
  const provider = text(registration.provider, 'registration.provider').toLowerCase();
  const pinnedVagrantHome = absolutePath(registration.pinnedVagrantHome, 'registration.pinnedVagrantHome');
  const persistentVagrantDotfilePath = absolutePath(
    registration.persistentVagrantDotfilePath,
    'registration.persistentVagrantDotfilePath',
  );
  const providerVm = isRecord(registration.providerVm) ? registration.providerVm : fail('registration.providerVm', 'is required');
  const providerVmName = text(providerVm.name, 'registration.providerVm.name');
  const providerVmUuid = uuid(providerVm.uuid, 'registration.providerVm.uuid');
  const providerVmHardwareUuid = uuid(providerVm.hardwareUuid, 'registration.providerVm.hardwareUuid');
  const providerVmOwnership = text(providerVm.ownership, 'registration.providerVm.ownership');
  const providerVmState = text(providerVm.state, 'registration.providerVm.state').toLowerCase();
  const addInvocation = normalizeInvocation(registration.addInvocation, 'registration.addInvocation');
  const upInvocation = normalizeInvocation(registration.upInvocation, 'registration.upInvocation');

  if (name !== packageRef.name) fail('registration.name', 'must match package.name');
  if (provider !== packageRef.provider) fail('registration.provider', 'must match package.provider');
  if (providerVmOwnership !== 'run-owned') fail('registration.providerVm.ownership', 'must be run-owned');
  if (!/vagrant(?:\.exe)?$/i.test(addInvocation.command) || addInvocation.args[0] !== 'box' || addInvocation.args[1] !== 'add') {
    fail('registration.addInvocation', 'must record vagrant box add');
  }
  if (
    !addInvocation.args.includes('--force')
    || !addInvocation.args.includes('--name')
    || !addInvocation.args.includes(name)
    || !addInvocation.args.includes('--provider')
    || !addInvocation.args.includes(provider)
    || !addInvocation.args.includes(packageRef.path)
  ) {
    fail('registration.addInvocation.args', 'must add the exact package for the requested box identity');
  }
  if (!/vagrant(?:\.exe)?$/i.test(upInvocation.command) || upInvocation.args[0] !== 'up') {
    fail('registration.upInvocation', 'must record vagrant up');
  }
  if (
    !upInvocation.args.includes('--provider')
    || !upInvocation.args.includes(provider)
    || !upInvocation.args.includes('--no-provision')
  ) {
    fail('registration.upInvocation.args', 'must use the explicit provider and --no-provision');
  }

  return {
    name,
    provider,
    pinnedVagrantHome,
    persistentVagrantDotfilePath,
    providerVm: {
      name: providerVmName,
      uuid: providerVmUuid,
      hardwareUuid: providerVmHardwareUuid,
      ownership: providerVmOwnership,
      state: providerVmState,
    },
    addInvocation,
    upInvocation,
  };
}

function normalizeProvenance(receipt, packageRef) {
  const provenance = isRecord(receipt.provenance) ? receipt.provenance : fail('provenance', 'is required');
  const sourceBox = normalizeFileRef(provenance.sourceBox, 'provenance.sourceBox');
  const sourceVm = isRecord(provenance.sourceVm) ? provenance.sourceVm : fail('provenance.sourceVm', 'is required');
  const sourceVmConfigFile = normalizeFileRef(sourceVm.configFile, 'provenance.sourceVm.configFile');
  const worktree = isRecord(provenance.worktree) ? provenance.worktree : fail('provenance.worktree', 'is required');

  const sourceVmName = text(sourceVm.name, 'provenance.sourceVm.name');
  const sourceVmUuid = uuid(sourceVm.uuid, 'provenance.sourceVm.uuid');
  const sourceVmHardwareUuid = uuid(sourceVm.hardwareUuid, 'provenance.sourceVm.hardwareUuid');
  const sourceSnapshotUuid = uuid(sourceVm.snapshotUuid, 'provenance.sourceVm.snapshotUuid');
  const worktreePath = absolutePath(worktree.path, 'provenance.worktree.path');
  const worktreeRef = {
    path: worktreePath,
    commit: worktree.commit === undefined ? null : text(worktree.commit, 'provenance.worktree.commit'),
    branch: worktree.branch === undefined ? null : text(worktree.branch, 'provenance.worktree.branch'),
    repository: worktree.repository === undefined ? null : text(worktree.repository, 'provenance.worktree.repository'),
  };

  if (sourceBox.name !== packageRef.name || sourceBox.provider !== packageRef.provider) {
    fail('provenance.sourceBox', 'must match the exact box/package identity');
  }
  if (sourceBox.sha256 !== packageRef.sha256) fail('provenance.sourceBox.sha256', 'must match package.sha256');

  return {
    sourceBox,
    sourceVm: {
      name: sourceVmName,
      uuid: sourceVmUuid,
      hardwareUuid: sourceVmHardwareUuid,
      snapshotUuid: sourceSnapshotUuid,
      configFile: sourceVmConfigFile,
    },
    worktree: worktreeRef,
  };
}

function normalizeVsix(receipt, provenance) {
  if (!isRecord(receipt.vsix)) return null;
  const vsix = receipt.vsix;
  const file = normalizeFileRef(vsix, 'vsix');
  const version = text(vsix.version, 'vsix.version');
  const sourceArtifactRetained = vsix.sourceArtifactRetained === undefined
    ? true
    : bool(vsix.sourceArtifactRetained, 'vsix.sourceArtifactRetained');
  const installedSnapshotProof = sourceArtifactRetained
    ? null
    : (() => {
        const proof = isRecord(vsix.installedSnapshotProof)
          ? vsix.installedSnapshotProof
          : fail('vsix.installedSnapshotProof', 'is required when the source VSIX was not retained');
        return {
          sourceVmUuid: uuid(proof.sourceVmUuid, 'vsix.installedSnapshotProof.sourceVmUuid'),
          sourceSnapshotUuid: uuid(
            proof.sourceSnapshotUuid,
            'vsix.installedSnapshotProof.sourceSnapshotUuid',
          ),
          extensionId: text(proof.extensionId, 'vsix.installedSnapshotProof.extensionId').toLowerCase(),
          version: text(proof.version, 'vsix.installedSnapshotProof.version'),
          manifest: normalizeFileRef(proof.manifest, 'vsix.installedSnapshotProof.manifest'),
          archive: normalizeFileRef(proof.archive, 'vsix.installedSnapshotProof.archive'),
        };
      })();
  const worktree = isRecord(vsix.worktree) ? vsix.worktree : fail('vsix.worktree', 'is required');
  const installProof = isRecord(vsix.installProof) ? vsix.installProof : fail('vsix.installProof', 'is required');

  const worktreePath = absolutePath(worktree.path, 'vsix.worktree.path');
  const installWorktreePath = absolutePath(installProof.worktreePath, 'vsix.installProof.worktreePath');
  const profile = text(installProof.profile, 'vsix.installProof.profile').toLowerCase();
  const command = text(installProof.command, 'vsix.installProof.command');
  const owner = installProof.owner === undefined ? null : text(installProof.owner, 'vsix.installProof.owner');
  const installed = bool(installProof.installed, 'vsix.installProof.installed');
  if (worktreePath !== provenance.worktree.path) fail('vsix.worktree.path', 'must match provenance.worktree.path');
  if (installWorktreePath !== provenance.worktree.path) fail('vsix.installProof.worktreePath', 'must match provenance.worktree.path');
  return {
    ...file,
    version,
    sourceArtifactRetained,
    installedSnapshotProof,
    worktree: {
      path: worktreePath,
      commit: worktree.commit === undefined ? null : text(worktree.commit, 'vsix.worktree.commit'),
      branch: worktree.branch === undefined ? null : text(worktree.branch, 'vsix.worktree.branch'),
      repository: worktree.repository === undefined ? null : text(worktree.repository, 'vsix.worktree.repository'),
    },
    installProof: {
      profile,
      command,
      owner,
      installed,
      worktreePath: installWorktreePath,
    },
  };
}

function normalizeActivation(receipt, registration) {
  if (!isRecord(receipt.proof?.activation)) return null;
  const activation = receipt.proof.activation;
  const exactProviderVmUuid = uuid(activation.exactProviderVmUuid, 'proof.activation.exactProviderVmUuid');
  const challengeVmUuid = uuid(activation.challengeVmUuid, 'proof.activation.challengeVmUuid');
  const activated = bool(activation.activated, 'proof.activation.activated');
  const liveProof = isRecord(activation.liveProof) ? activation.liveProof : fail('proof.activation.liveProof', 'is required');
  const liveVmUuid = uuid(liveProof.vmUuid, 'proof.activation.liveProof.vmUuid');
  const liveHardwareUuid = uuid(liveProof.hardwareUuid, 'proof.activation.liveProof.hardwareUuid');
  const liveProfile = liveProof.profile === undefined ? null : text(liveProof.profile, 'proof.activation.liveProof.profile');
  const exactUuidObserved = liveProof.exactUuidObserved === undefined
    ? null
    : bool(liveProof.exactUuidObserved, 'proof.activation.liveProof.exactUuidObserved');
  const mprr = isRecord(activation.mprr) ? activation.mprr : fail('proof.activation.mprr', 'is required');
  const mprrActivated = bool(mprr.activated, 'proof.activation.mprr.activated');
  const passed = bool(mprr.passed, 'proof.activation.mprr.passed');
  const launchMs = finiteNumber(mprr.launchMs, 'proof.activation.mprr.launchMs', 0);
  const settleMs = finiteNumber(mprr.settleMs, 'proof.activation.mprr.settleMs', 0);
  if (settleMs < launchMs) fail('proof.activation.mprr.settleMs', 'must be >= launchMs');
  const resourceSamples = Array.isArray(mprr.resourceSamples)
    ? mprr.resourceSamples
    : fail('proof.activation.mprr.resourceSamples', 'is required');
  if (resourceSamples.length === 0) fail('proof.activation.mprr.resourceSamples', 'must not be empty');
  for (const [index, sample] of resourceSamples.entries()) {
    if (!isRecord(sample)) fail(`proof.activation.mprr.resourceSamples[${index}]`, 'must be an object');
    finiteNumber(sample.ms, `proof.activation.mprr.resourceSamples[${index}].ms`, 0);
    finiteNumber(sample.cpuPct, `proof.activation.mprr.resourceSamples[${index}].cpuPct`, 0);
    finiteNumber(sample.ramMb, `proof.activation.mprr.resourceSamples[${index}].ramMb`, 0);
    if (sample.diskPct !== undefined && sample.diskPct !== null) {
      finiteNumber(sample.diskPct, `proof.activation.mprr.resourceSamples[${index}].diskPct`, 0);
    }
  }
  const evidence = normalizeEvidenceList(mprr.evidence, 'proof.activation.mprr.evidence');
  if (evidence.length === 0) fail('proof.activation.mprr.evidence', 'must contain at least one immutable artifact');

  return {
    exactProviderVmUuid,
    challengeVmUuid,
    activated,
    liveProof: {
      vmUuid: liveVmUuid,
      hardwareUuid: liveHardwareUuid,
      profile: liveProfile,
      exactUuidObserved,
    },
    mprr: {
      activated: mprrActivated,
      passed,
      launchMs,
      settleMs,
      resourceSamples,
      evidence,
      activationState: mprr.activationState === undefined ? null : text(mprr.activationState, 'proof.activation.mprr.activationState'),
    },
  };
}

function normalizeLifecycle(receipt, registration, provenance) {
  if (!isRecord(receipt.proof?.lifecycle)) return null;
  const lifecycle = receipt.proof.lifecycle;
  const snapshotUuid = uuid(lifecycle.snapshotUuid, 'proof.lifecycle.snapshotUuid');
  const state = text(lifecycle.state, 'proof.lifecycle.state').toLowerCase();
  const cacheReady = bool(lifecycle.cacheReady, 'proof.lifecycle.cacheReady');
  const sealed = bool(lifecycle.sealed, 'proof.lifecycle.sealed');
  const exclusiveLockReleased = bool(lifecycle.exclusiveLockReleased, 'proof.lifecycle.exclusiveLockReleased');
  if (!['sealed', 'cache-ready'].includes(state)) fail('proof.lifecycle.state', 'must be sealed or cache-ready');
  return {
    snapshotUuid,
    state,
    cacheReady,
    sealed,
    exclusiveLockReleased,
    vmPoweredOff: lifecycle.vmPoweredOff === undefined ? null : bool(lifecycle.vmPoweredOff, 'proof.lifecycle.vmPoweredOff'),
    lockPath: lifecycle.lockPath === undefined ? null : absolutePath(lifecycle.lockPath, 'proof.lifecycle.lockPath'),
    lockOwner: lifecycle.lockOwner === undefined ? null : text(lifecycle.lockOwner, 'proof.lifecycle.lockOwner'),
  };
}

function normalizeCleanup(receipt) {
  if (!isRecord(receipt.proof?.cleanup)) return null;
  const cleanup = receipt.proof.cleanup;
  return {
    vmPoweredOff: bool(cleanup.vmPoweredOff, 'proof.cleanup.vmPoweredOff'),
    vncListenerAbsent: bool(cleanup.vncListenerAbsent, 'proof.cleanup.vncListenerAbsent'),
    natListenerAbsent: bool(cleanup.natListenerAbsent, 'proof.cleanup.natListenerAbsent'),
    tasksAbsent: bool(cleanup.tasksAbsent, 'proof.cleanup.tasksAbsent'),
    processesAbsent: bool(cleanup.processesAbsent, 'proof.cleanup.processesAbsent'),
    secretsRemoved: bool(cleanup.secretsRemoved, 'proof.cleanup.secretsRemoved'),
    listenersAbsent: bool(cleanup.listenersAbsent, 'proof.cleanup.listenersAbsent'),
  };
}

function normalizeResume(receipt, registration) {
  const resume = isRecord(receipt.resume) ? receipt.resume : fail('resume', 'is required');
  const environment = isRecord(resume.environment) ? resume.environment : fail('resume.environment', 'is required');
  const commands = Array.isArray(resume.commands)
    ? resume.commands.map((command, index) => text(command, `resume.commands[${index}]`))
    : fail('resume.commands', 'is required');
  if (commands.length === 0) fail('resume.commands', 'must not be empty');
  const command = text(resume.command, 'resume.command');
  const owner = resume.owner === undefined ? null : text(resume.owner, 'resume.owner');
  const vagrantHome = absolutePath(environment.VAGRANT_HOME, 'resume.environment.VAGRANT_HOME');
  const vagrantDotfilePath = absolutePath(environment.VAGRANT_DOTFILE_PATH, 'resume.environment.VAGRANT_DOTFILE_PATH');
  if (vagrantHome !== registration.pinnedVagrantHome) {
    fail('resume.environment.VAGRANT_HOME', 'must match registration.pinnedVagrantHome');
  }
  if (vagrantDotfilePath !== registration.persistentVagrantDotfilePath) {
    fail('resume.environment.VAGRANT_DOTFILE_PATH', 'must match registration.persistentVagrantDotfilePath');
  }
  return {
    environment: {
      VAGRANT_HOME: vagrantHome,
      VAGRANT_DOTFILE_PATH: vagrantDotfilePath,
    },
    command,
    commands,
    owner,
  };
}

function normalizeIntentionalDestroy(receipt) {
  const destroy = isRecord(receipt.intentionalDestroy) ? receipt.intentionalDestroy : fail('intentionalDestroy', 'is required');
  const command = text(destroy.command, 'intentionalDestroy.command');
  const owner = text(destroy.owner, 'intentionalDestroy.owner');
  if (!/destroy/i.test(command)) fail('intentionalDestroy.command', 'must describe an intentional destroy command');
  if (owner !== 'run-owned') fail('intentionalDestroy.owner', 'must be run-owned');
  return {
    command,
    owner,
    reason: destroy.reason === undefined ? null : text(destroy.reason, 'intentionalDestroy.reason'),
  };
}

function collectEvidenceRefs(normalized, receipt) {
  const refs = [normalized.package, normalized.provenance.sourceBox, normalized.provenance.sourceVm.configFile];
  if (normalized.vsix?.sourceArtifactRetained) {
    refs.push(normalized.vsix);
  } else if (normalized.vsix?.installedSnapshotProof) {
    refs.push(normalized.vsix.installedSnapshotProof.manifest, normalized.vsix.installedSnapshotProof.archive);
  }
  if (normalized.proof?.activation?.mprr?.evidence) refs.push(...normalized.proof.activation.mprr.evidence);
  if (Array.isArray(receipt.evidence)) refs.push(...normalizeEvidenceList(receipt.evidence, 'evidence'));
  const deduped = new Map();
  for (const ref of refs) {
    if (!ref) continue;
    deduped.set(`${ref.path}\u0000${ref.sha256}`, ref);
  }
  return [...deduped.values()];
}

export function parseVagrantBoxList(textValue) {
  const clean = String(textValue).trim();
  if (!clean || /There are no installed boxes!/i.test(clean)) return [];
  return clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(.+?)\s+\(([^,]+),\s*([^,()]+?)(?:,\s*\(([^)]+)\))?\)$/.exec(line);
    if (!match) throw new Error(`malformed Vagrant box row '${line}'`);
    return {
      name: match[1].trim(),
      provider: match[2].trim(),
      version: match[3].trim(),
      architecture: match[4]?.trim() ?? null,
    };
  });
}

export function parseVBoxManageListVms(textValue) {
  const clean = String(textValue).trim();
  if (!clean) return [];
  return clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^"(.+)"\s+\{([0-9a-f-]{36})\}$/i.exec(line);
    if (!match) throw new Error(`malformed VBoxManage VM row '${line}'`);
    return { name: match[1], uuid: match[2].toLowerCase() };
  });
}

export function parseVBoxManageMachineReadable(textValue) {
  const values = {};
  for (const line of String(textValue).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = /^([^=]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    values[match[1]] = value;
  }
  return values;
}

function lookupMachineReadable(values, ...keys) {
  const lowered = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lowered.get(key.toLowerCase());
    if (value !== undefined) return value;
  }
  return undefined;
}

export async function hashFileSha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function validateReviewerCacheReceiptStructure(receipt) {
  if (!isRecord(receipt)) fail('receipt', 'must be an object');
  if (receipt.schema !== SCHEMA) fail('schema', `must be ${SCHEMA}`);
  const packageRef = normalizePackage(receipt);
  const registration = normalizeRegistration(receipt, packageRef);
  const provenance = normalizeProvenance(receipt, packageRef);
  const vsix = normalizeVsix(receipt, provenance);
  const proof = receipt.proof === undefined || receipt.proof === null ? null : {
    support: receipt.proof.support === undefined
      ? null
      : {
          supported: bool(receipt.proof.support.supported, 'proof.support.supported'),
          reason: receipt.proof.support.reason === undefined ? null : text(receipt.proof.support.reason, 'proof.support.reason'),
        },
    activation: normalizeActivation(receipt, registration),
    lifecycle: normalizeLifecycle(receipt, registration, provenance),
    cleanup: normalizeCleanup(receipt),
  };
  const resume = normalizeResume(receipt, registration);
  const intentionalDestroy = normalizeIntentionalDestroy(receipt);
  const evidenceRefs = collectEvidenceRefs({ package: packageRef, provenance, vsix, proof }, receipt);
  return {
    ...receipt,
    package: packageRef,
    registration,
    provenance,
    vsix,
    proof,
    resume,
    intentionalDestroy,
    evidenceRefs,
  };
}

function classifyReviewerCacheProof(normalized) {
  const proof = normalized.proof;
  if (!proof || Object.values(proof).every((section) => section === null)) {
    return { status: 'unverified', reason: 'missing-proof' };
  }
  if (proof.support?.supported === false) {
    return { status: 'unsupported', reason: proof.support.reason ?? 'platform-unsupported' };
  }
  if (!proof.activation) return { status: 'unverified', reason: 'missing-activation-proof' };
  if (proof.activation.activated !== true) return { status: 'unverified', reason: 'missing-activation-proof' };
  if (proof.activation.exactProviderVmUuid !== normalized.registration.providerVm.uuid) {
    return { status: 'unverified', reason: 'stale-activation-challenge' };
  }
  if (proof.activation.challengeVmUuid !== normalized.registration.providerVm.uuid) {
    return { status: 'unverified', reason: 'stale-activation-challenge' };
  }
  if (
    proof.activation.liveProof.vmUuid !== normalized.registration.providerVm.uuid
    || proof.activation.liveProof.hardwareUuid !== normalized.registration.providerVm.hardwareUuid
  ) {
    return { status: 'unverified', reason: 'identity-mismatch' };
  }
  if (proof.activation.liveProof.exactUuidObserved !== null && proof.activation.liveProof.exactUuidObserved !== true) {
    return { status: 'unverified', reason: 'identity-mismatch' };
  }
  if (proof.activation.liveProof.profile !== null && proof.activation.liveProof.profile.toLowerCase() !== 'interactive') {
    return { status: 'unverified', reason: 'wrong-interactive-profile' };
  }
  if (proof.activation.mprr.activationState !== null && proof.activation.mprr.activationState.toLowerCase() !== 'activated') {
    return { status: 'unverified', reason: 'missing-activated-mprr-proof' };
  }
  if (proof.activation.mprr.activated !== true || proof.activation.mprr.passed !== true) {
    return { status: 'unverified', reason: 'missing-activated-mprr-proof' };
  }
  if (!Array.isArray(proof.activation.mprr.resourceSamples) || proof.activation.mprr.resourceSamples.length === 0) {
    return { status: 'unverified', reason: 'missing-activated-mprr-proof' };
  }
  if (!normalized.vsix) return { status: 'unverified', reason: 'missing-vsix-proof' };
  if (!normalized.vsix.installProof.installed) return { status: 'unverified', reason: 'missing-vsix-proof' };
  if (normalized.vsix.installProof.profile !== 'interactive') {
    return { status: 'unverified', reason: 'wrong-interactive-profile' };
  }
  if (normalized.vsix.installProof.worktreePath !== normalized.provenance.worktree.path) {
    return { status: 'unverified', reason: 'wrong-worktree-provenance' };
  }
  if (!proof.lifecycle) return { status: 'unverified', reason: 'missing-lifecycle-proof' };
  if (!normalized.vsix.sourceArtifactRetained) {
    const snapshotProof = normalized.vsix.installedSnapshotProof;
    if (
      !snapshotProof
      || snapshotProof.sourceVmUuid !== normalized.registration.providerVm.uuid
      || snapshotProof.sourceSnapshotUuid !== proof.lifecycle.snapshotUuid
      || snapshotProof.version !== normalized.vsix.version
      || snapshotProof.extensionId !== 'svelderrainruiz.labview-benchmark-actor'
    ) {
      return { status: 'unverified', reason: 'invalid-installed-snapshot-proof' };
    }
  }
  if (proof.lifecycle.snapshotUuid !== normalized.provenance.sourceVm.snapshotUuid) {
    return { status: 'unverified', reason: 'snapshot-mismatch' };
  }
  if (proof.lifecycle.state !== 'sealed' || proof.lifecycle.cacheReady !== true || proof.lifecycle.sealed !== true) {
    return { status: 'unverified', reason: 'lifecycle-not-sealed' };
  }
  if (proof.lifecycle.exclusiveLockReleased !== true) {
    return { status: 'unverified', reason: 'lock-unreleased' };
  }
  if (!proof.cleanup) return { status: 'unverified', reason: 'cleanup-failed' };
  if (normalized.registration.providerVm.state !== 'poweroff' || proof.lifecycle.vmPoweredOff !== true) {
    return { status: 'unverified', reason: 'vm-not-powered-off' };
  }
  if (proof.cleanup.vmPoweredOff !== true) return { status: 'unverified', reason: 'vm-not-powered-off' };
  if (
    proof.cleanup.vncListenerAbsent !== true
    || proof.cleanup.natListenerAbsent !== true
    || proof.cleanup.listenersAbsent !== true
  ) {
    return { status: 'unverified', reason: 'listener-failure' };
  }
  if (
    proof.cleanup.tasksAbsent !== true
    || proof.cleanup.processesAbsent !== true
    || proof.cleanup.secretsRemoved !== true
  ) {
    return { status: 'unverified', reason: 'cleanup-failed' };
  }
  if (normalized.resume.environment.VAGRANT_HOME !== normalized.registration.pinnedVagrantHome) {
    return { status: 'unverified', reason: 'resume-environment-mismatch' };
  }
  if (normalized.resume.environment.VAGRANT_DOTFILE_PATH !== normalized.registration.persistentVagrantDotfilePath) {
    return { status: 'unverified', reason: 'resume-environment-mismatch' };
  }
  if (normalized.intentionalDestroy.owner !== 'run-owned') {
    return { status: 'unverified', reason: 'destroy-command-ownership-mismatch' };
  }
  return { status: 'passed', reason: 'reviewer-cache-ready' };
}

export function evaluateReviewerCacheReceipt(receipt) {
  const normalized = validateReviewerCacheReceiptStructure(receipt);
  const classification = classifyReviewerCacheProof(normalized);
  if (receipt.outcome !== undefined && receipt.outcome !== classification.status) {
    fail('outcome', `contradicts derived status '${classification.status}'`);
  }
  return {
    ...classification,
    schema: SCHEMA,
    package: normalized.package,
    registration: normalized.registration,
    provenance: normalized.provenance,
    vsix: normalized.vsix,
    resume: normalized.resume,
    intentionalDestroy: normalized.intentionalDestroy,
    evidenceRefs: normalized.evidenceRefs,
  };
}

function resolvePath(baseDir, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

async function verifyArtifact(ref, baseDir) {
  const absolute = resolvePath(baseDir, ref.path);
  const stat = statSync(absolute);
  if (stat.size !== ref.size) {
    throw new Error(`${ref.path}: size mismatch (expected ${ref.size}, got ${stat.size})`);
  }
  const actual = await hashFileSha256(absolute);
  if (actual !== ref.sha256) {
    throw new Error(`${ref.path}: SHA-256 mismatch`);
  }
  return { path: ref.path, size: stat.size, sha256: actual, role: ref.role };
}

function normalizeLiveCheckTargets(normalized, liveChecks) {
  if (liveChecks === true) {
    return {
      vagrantBox: {
        name: normalized.package.name,
        provider: normalized.package.provider,
        version: normalized.package.version,
      },
      providerVm: {
        name: normalized.registration.providerVm.name,
        uuid: normalized.registration.providerVm.uuid,
        hardwareUuid: normalized.registration.providerVm.hardwareUuid,
        state: 'poweroff',
      },
      snapshot: {
        vmName: normalized.registration.providerVm.name,
        snapshotUuid: normalized.proof.lifecycle.snapshotUuid,
      },
    };
  }
  if (!isRecord(liveChecks)) return null;
  return {
    vagrantBox: liveChecks.vagrantBox === undefined ? null : liveChecks.vagrantBox,
    providerVm: liveChecks.providerVm === undefined ? null : liveChecks.providerVm,
    snapshot: liveChecks.snapshot === undefined ? null : liveChecks.snapshot,
  };
}

function verifyVagrantBox(live, normalized, env) {
  const boxes = parseVagrantBoxList(runCommand('vagrant', ['box', 'list'], env));
  const target = live === true || live === undefined || live === null
    ? {
        name: normalized.package.name,
        provider: normalized.package.provider,
        version: normalized.package.version,
      }
    : live;
  if (target === false) return null;
  const name = text(target.name, 'liveChecks.vagrantBox.name');
  const provider = text(target.provider, 'liveChecks.vagrantBox.provider').toLowerCase();
  const match = boxes.find((box) => box.name === name && box.provider.toLowerCase() === provider);
  if (!match) fail('liveChecks.vagrantBox', 'registered box is absent from the requested VAGRANT_HOME');
  if (target.version !== undefined && target.version !== null && String(match.version) !== String(target.version)) {
    fail('liveChecks.vagrantBox', 'registered box version does not match');
  }
  return { type: 'vagrant-box', name: match.name, provider: match.provider, version: match.version };
}

function verifyProviderVm(live, normalized) {
  const target = live === true || live === undefined || live === null
    ? {
        name: normalized.registration.providerVm.name,
        uuid: normalized.registration.providerVm.uuid,
        hardwareUuid: normalized.registration.providerVm.hardwareUuid,
        state: 'poweroff',
      }
    : live;
  if (target === false) return null;
  const vmName = text(target.name, 'liveChecks.providerVm.name');
  const expectedUuid = uuid(target.uuid, 'liveChecks.providerVm.uuid');
  const info = parseVBoxManageMachineReadable(runCommand('VBoxManage', ['showvminfo', vmName, '--machinereadable']));
  const actualUuid = text(lookupMachineReadable(info, 'UUID', 'uuid'), 'liveChecks.providerVm.UUID').replaceAll('"', '').toLowerCase();
  const actualHardwareUuid = text(
    lookupMachineReadable(info, 'HardwareUUID', 'hardwareuuid', 'HWUUID'),
    'liveChecks.providerVm.HardwareUUID',
  ).replaceAll('"', '').toLowerCase();
  const actualState = text(lookupMachineReadable(info, 'VMState', 'vmstate'), 'liveChecks.providerVm.VMState').toLowerCase();
  if (actualUuid !== expectedUuid) fail('liveChecks.providerVm', 'provider VM UUID does not match');
  if (actualHardwareUuid !== uuid(target.hardwareUuid, 'liveChecks.providerVm.hardwareUuid')) {
    fail('liveChecks.providerVm', 'provider VM hardware UUID does not match');
  }
  if (target.state && actualState !== target.state.toLowerCase()) {
    fail('liveChecks.providerVm', `provider VM state is '${actualState}', expected '${target.state}'`);
  }
  return { type: 'provider-vm', name: vmName, uuid: actualUuid, hardwareUuid: actualHardwareUuid, state: actualState };
}

function verifySnapshot(live, normalized) {
  const target = live === true || live === undefined || live === null
    ? {
        vmName: normalized.registration.providerVm.name,
        snapshotUuid: normalized.proof.lifecycle.snapshotUuid,
      }
    : live;
  if (target === false) return null;
  const vmName = text(target.vmName, 'liveChecks.snapshot.vmName');
  const snapshotUuid = uuid(target.snapshotUuid, 'liveChecks.snapshot.snapshotUuid');
  const raw = runCommand('VBoxManage', ['snapshot', vmName, 'list', '--machinereadable']);
  const parsed = parseVBoxManageMachineReadable(raw);
  const values = Object.values(parsed).map((value) => String(value).toLowerCase());
  if (!values.includes(snapshotUuid)) fail('liveChecks.snapshot', 'snapshot UUID is absent');
  return { type: 'snapshot', vmName, snapshotUuid };
}

export function runCommand(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${String(result.stderr ?? result.stdout ?? '').trim() || `exit ${result.status}`}`);
  }
  return String(result.stdout ?? '');
}

export async function verifyReviewerCacheReceipt(receipt, { baseDir = process.cwd(), live = true } = {}) {
  const normalized = validateReviewerCacheReceiptStructure(receipt);
  const classification = classifyReviewerCacheProof(normalized);
  if (receipt.outcome !== undefined && receipt.outcome !== classification.status) {
    fail('outcome', `contradicts derived status '${classification.status}'`);
  }
  const artifacts = [];
  for (const ref of normalized.evidenceRefs) artifacts.push(await verifyArtifact(ref, baseDir));
  const liveCheckTargets = live ? normalizeLiveCheckTargets(normalized, receipt.liveChecks) : null;
  const liveChecks = [];
  if (liveCheckTargets) {
    const env = {
      VAGRANT_HOME: normalized.registration.pinnedVagrantHome,
      VAGRANT_DOTFILE_PATH: normalized.registration.persistentVagrantDotfilePath,
    };
    if (liveCheckTargets.vagrantBox !== false && liveCheckTargets.vagrantBox !== null) {
      liveChecks.push(verifyVagrantBox(liveCheckTargets.vagrantBox, normalized, env));
    }
    if (liveCheckTargets.providerVm !== false && liveCheckTargets.providerVm !== null) {
      liveChecks.push(verifyProviderVm(liveCheckTargets.providerVm, normalized));
    }
    if (liveCheckTargets.snapshot !== false && liveCheckTargets.snapshot !== null) {
      liveChecks.push(verifySnapshot(liveCheckTargets.snapshot, normalized));
    }
  }
  return {
    schema: SCHEMA,
    status: classification.status,
    reason: classification.reason,
    package: normalized.package,
    registration: normalized.registration,
    provenance: normalized.provenance,
    vsix: normalized.vsix,
    resume: normalized.resume,
    intentionalDestroy: normalized.intentionalDestroy,
    artifacts,
    liveChecks,
  };
}
