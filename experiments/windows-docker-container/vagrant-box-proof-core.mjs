import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'labview-benchmark-actor/windows-vagrant-box-consumer@1';

const SHA256_RE = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);

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

export function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address).toLowerCase());
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

export function parseMachineReadable(textValue) {
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

function normalizeEvidenceRef(ref, label) {
  if (!isRecord(ref)) fail(label, 'must be an object');
  return {
    path: absolutePath(ref.path, `${label}.path`),
    size: integer(ref.size, `${label}.size`, 1),
    sha256: sha256(ref.sha256, `${label}.sha256`),
    name: ref.name === undefined ? null : text(ref.name, `${label}.name`),
    provider: ref.provider === undefined ? null : text(ref.provider, `${label}.provider`).toLowerCase(),
    version: ref.version === undefined ? null : text(ref.version, `${label}.version`),
    role: ref.role === undefined ? null : text(ref.role, `${label}.role`),
  };
}

function normalizeEvidenceRefs(receipt) {
  const refs = [];
  if (receipt.package) refs.push(normalizeEvidenceRef(receipt.package, 'package'));
  if (Array.isArray(receipt.evidence)) {
    receipt.evidence.forEach((ref, index) => refs.push(normalizeEvidenceRef(ref, `evidence[${index}]`)));
  }
  if (refs.length === 0) fail('evidence', 'at least one immutable evidence ref is required');
  const deduped = new Map();
  for (const ref of refs) deduped.set(`${ref.path}\u0000${ref.sha256}`, ref);
  return [...deduped.values()];
}

function normalizeRegistration(receipt, packageRef) {
  if (!isRecord(receipt)) fail('registration', 'is required');
  const name = text(receipt.name, 'registration.name');
  const provider = text(receipt.provider, 'registration.provider').toLowerCase();
  const persistentVagrantHome = absolutePath(receipt.persistentVagrantHome, 'registration.persistentVagrantHome');
  const consumerVagrantHome = absolutePath(receipt.consumerVagrantHome, 'registration.consumerVagrantHome');
  const providerUuid = uuid(receipt.providerUuid, 'registration.providerUuid');
  const providerUuidOwnership = text(receipt.providerUuidOwnership, 'registration.providerUuidOwnership');
  const exactPackageAdded = bool(receipt.exactPackageAdded, 'registration.exactPackageAdded');
  const exactPackageSha256 = sha256(receipt.exactPackageSha256, 'registration.exactPackageSha256');
  const addInvocation = isRecord(receipt.addInvocation)
    ? receipt.addInvocation
    : fail('registration.addInvocation', 'is required');
  const addCommand = text(addInvocation.command, 'registration.addInvocation.command');
  const addArgs = Array.isArray(addInvocation.args)
    ? addInvocation.args.map((value, index) => text(value, `registration.addInvocation.args[${index}]`))
    : [];
  const upInvocation = isRecord(receipt.upInvocation)
    ? receipt.upInvocation
    : fail('registration.upInvocation', 'is required');
  const upCommand = text(upInvocation.command, 'registration.upInvocation.command');
  const upArgs = Array.isArray(upInvocation.args)
    ? upInvocation.args.map((value, index) => text(value, `registration.upInvocation.args[${index}]`))
    : [];
  const noProvision = bool(upInvocation.noProvision, 'registration.upInvocation.noProvision');

  if (provider !== 'virtualbox') fail('registration.provider', 'must be virtualbox');
  if (packageRef.name !== name) fail('registration.name', 'must match package.name');
  if ((packageRef.provider ?? provider) !== provider) fail('registration.provider', 'must match package.provider');
  if (!exactPackageAdded || exactPackageSha256 !== packageRef.sha256) {
    fail('registration.exactPackageSha256', 'must prove the consumed package SHA-256');
  }
  if (!/vagrant(?:\.exe)?$/i.test(addCommand) || addArgs[0] !== 'box' || addArgs[1] !== 'add') {
    fail('registration.addInvocation', 'must record vagrant box add');
  }
  if (!addArgs.includes(packageRef.path) || !addArgs.includes('--provider') || !addArgs.includes('virtualbox')) {
    fail('registration.addInvocation.args', 'must add the exact package for VirtualBox');
  }
  if (!/vagrant(?:\.exe)?$/i.test(upCommand) || upArgs[0] !== 'up') {
    fail('registration.upInvocation', 'must record vagrant up');
  }
  if (!noProvision || !upArgs.includes('--no-provision')) {
    fail('registration.upInvocation.args', 'must include --no-provision');
  }
  if (!upArgs.includes('--provider') || !upArgs.includes('virtualbox')) {
    fail('registration.upInvocation.args', 'must select VirtualBox');
  }
  if (providerUuidOwnership !== 'run-owned') fail('registration.providerUuidOwnership', 'must be run-owned');

  return {
    name,
    provider,
    persistentVagrantHome,
    consumerVagrantHome,
    providerUuid,
    providerUuidOwnership,
    exactPackageAdded,
    exactPackageSha256,
    addInvocation: {
      command: addCommand,
      args: addArgs,
    },
    upInvocation: {
      command: upCommand,
      args: upArgs,
      noProvision,
    },
  };
}

function normalizeProof(proof) {
  if (proof === undefined || proof === null) return null;
  if (!isRecord(proof)) fail('proof', 'must be an object');
  return proof;
}

function classifyProof(proof) {
  if (!proof || Object.keys(proof).length === 0) {
    return { status: 'unverified', reason: 'missing-proof' };
  }

  const support = proof.support ?? proof.platform ?? null;
  if (support?.supported === false || support?.outcome === 'unsupported' || support?.status === 'unsupported') {
    return { status: 'unsupported', reason: support.reason ?? 'platform-unsupported' };
  }

  const winrm = proof.winrm;
  if (!isRecord(winrm) || winrm.authenticated !== true) {
    return { status: 'unverified', reason: 'missing-winrm-proof' };
  }

  const desktop = proof.desktop;
  if (!isRecord(desktop) || desktop.interactive !== true) {
    return { status: 'unverified', reason: 'missing-interactive-desktop-proof' };
  }
  if (desktop.windowStation !== 'WinSta0' || desktop.desktop !== 'Default') {
    return { status: 'unverified', reason: 'contradictory-evidence' };
  }
  if (!Array.isArray(desktop.monitorRectangles) || desktop.monitorRectangles.length === 0) {
    return { status: 'unverified', reason: 'missing-interactive-desktop-proof' };
  }

  const labview = proof.labview;
  if (!isRecord(labview) || labview.installed !== true) {
    return { status: 'unverified', reason: 'missing-labview-proof' };
  }
  const activationRequired = labview.activated !== true;
  if (activationRequired && labview.activationRequired !== true) {
    return { status: 'unverified', reason: 'missing-labview-proof' };
  }

  const capture = proof.capture;
  if (!isRecord(capture)) {
    return { status: 'unverified', reason: 'missing-capture-proof' };
  }
  const rfb = capture.rfb;
  if (!isRecord(rfb) || rfb.authenticated !== true) {
    return { status: 'unverified', reason: 'missing-capture-proof' };
  }
  const loopbackAddress = rfb.boundAddress ?? rfb.address ?? rfb.host;
  if (!rfb.loopbackOnly || !isLoopbackAddress(loopbackAddress)) {
    return { status: 'unverified', reason: 'wrong-loopback' };
  }
  let launchMs = null;
  let settleMs = null;
  let blockerFrames = null;
  let blockerResourceSamples = null;
  if (activationRequired) {
    const blocker = capture.blocker;
    if (!isRecord(blocker) || blocker.classification !== 'labview-activation-required') {
      return { status: 'unverified', reason: 'missing-activation-blocker-proof' };
    }
    blockerFrames = integer(blocker.frameCount, 'capture.blocker.frameCount', 1);
    blockerResourceSamples = integer(blocker.resourceSampleCount, 'capture.blocker.resourceSampleCount', 1);
  } else {
    const mprr = capture.mprr;
    if (!isRecord(mprr) || mprr.passed !== true) {
      return { status: 'unverified', reason: 'missing-mprr-proof' };
    }
    launchMs = finiteNumber(mprr.launchMs, 'capture.mprr.launchMs', 0);
    settleMs = finiteNumber(mprr.settleMs, 'capture.mprr.settleMs', 0);
    if (settleMs < launchMs) return { status: 'unverified', reason: 'contradictory-evidence' };
    if (!Array.isArray(mprr.resourceSamples) || mprr.resourceSamples.length === 0) {
      return { status: 'unverified', reason: 'missing-resource-data' };
    }
    for (const [index, sample] of mprr.resourceSamples.entries()) {
      if (!isRecord(sample)) return { status: 'unverified', reason: 'missing-resource-data' };
      finiteNumber(sample.ms, `capture.mprr.resourceSamples[${index}].ms`, 0);
      finiteNumber(sample.cpuPct, `capture.mprr.resourceSamples[${index}].cpuPct`, 0);
      finiteNumber(sample.ramMb, `capture.mprr.resourceSamples[${index}].ramMb`, 0);
      if (sample.diskPct !== undefined && sample.diskPct !== null) {
        finiteNumber(sample.diskPct, `capture.mprr.resourceSamples[${index}].diskPct`, 0);
      }
    }
  }

  const sourceVm = proof.sourceVm;
  if (!isRecord(sourceVm) || sourceVm.activated !== true || sourceVm.preserved !== true) {
    return { status: 'unverified', reason: 'source-vm-not-preserved' };
  }
  if (
    !SHA256_RE.test(sourceVm.configSha256Before ?? '')
    || sourceVm.configSha256Before !== sourceVm.configSha256After
  ) {
    return { status: 'unverified', reason: 'source-vm-not-preserved' };
  }

  const cleanup = proof.cleanup;
  if (!isRecord(cleanup)) return { status: 'unverified', reason: 'cleanup-failed' };
  const cleanupFlags = [
    cleanup.runOwnedVmAbsent,
    cleanup.natListenerAbsent,
    cleanup.vncListenerAbsent,
    cleanup.secretsRemoved,
    cleanup.localDotfileRemoved,
    cleanup.consumerVagrantHomeRemoved,
    cleanup.lifecycleLockRemoved,
  ];
  if (cleanupFlags.some((flag) => flag !== true)) return { status: 'unverified', reason: 'cleanup-failed' };

  return activationRequired
    ? {
        status: 'activation-required',
        reason: 'new-vm-identity-requires-ni-activation',
        details: {
          frameCount: blockerFrames,
          resourceSampleCount: blockerResourceSamples,
        },
      }
    : {
        status: 'passed',
        reason: 'all-required-proofs-present',
        details: {
          launchMs,
          settleMs,
        },
      };
}

export function validateVagrantBoxConsumerProofStructure(receipt) {
  if (!isRecord(receipt)) fail('receipt', 'must be an object');
  if (receipt.schema !== SCHEMA) fail('schema', `must be ${SCHEMA}`);
  const packageRef = normalizeEvidenceRef(receipt.package, 'package');
  if (!packageRef.name) fail('package.name', 'is required');
  if (!packageRef.provider) fail('package.provider', 'is required');
  const registration = normalizeRegistration(receipt.registration, packageRef);
  const evidenceRefs = normalizeEvidenceRefs(receipt);
  const proof = normalizeProof(receipt.proof);
  return {
    ...receipt,
    package: packageRef,
    registration,
    evidenceRefs,
    proof,
  };
}

export function evaluateVagrantBoxConsumerProof(receipt) {
  const normalized = validateVagrantBoxConsumerProofStructure(receipt);
  const classification = classifyProof(normalized.proof);
  if (receipt.outcome !== undefined && receipt.outcome !== classification.status) {
    fail('outcome', `contradicts derived status '${classification.status}'`);
  }
  return {
    ...classification,
    schema: SCHEMA,
    package: normalized.package,
    registration: normalized.registration,
    evidenceRefs: normalized.evidenceRefs,
  };
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

export function verifyLiveChecks(receipt) {
  const live = receipt.liveChecks;
  if (!isRecord(live)) return [];

  const checks = [];
  const env = { VAGRANT_HOME: receipt.registration.persistentVagrantHome };

  if (live.vagrantBox !== false) {
    const boxes = parseVagrantBoxList(runCommand('vagrant', ['box', 'list'], env));
    const match = boxes.find((box) => box.name === receipt.registration.name && box.provider.toLowerCase() === receipt.registration.provider);
    if (!match) fail('liveChecks.vagrantBox', 'registered box is absent from the requested VAGRANT_HOME');
    if (receipt.registration.provider !== match.provider.toLowerCase()) {
      fail('liveChecks.vagrantBox', 'registered provider does not match');
    }
    checks.push({ type: 'vagrant-box', name: match.name, provider: match.provider, version: match.version });
  }

  if (isRecord(live.runOwnedVm)) {
    const vms = parseVBoxManageListVms(runCommand('VBoxManage', ['list', 'vms']));
    const found = vms.find((vm) => vm.name === live.runOwnedVm.name || vm.uuid === uuid(live.runOwnedVm.uuid, 'liveChecks.runOwnedVm.uuid'));
    if (live.runOwnedVm.absent === true && found) fail('liveChecks.runOwnedVm', 'run-owned VM still exists');
    if (live.runOwnedVm.absent !== true && !found) fail('liveChecks.runOwnedVm', 'run-owned VM is absent');
    checks.push({ type: 'run-owned-vm', absent: live.runOwnedVm.absent === true, found: found ?? null });
  }

  if (isRecord(live.sourceVm) && live.sourceVm.name) {
    const info = parseMachineReadable(runCommand('VBoxManage', ['showvminfo', live.sourceVm.name, '--machinereadable']));
    if (live.sourceVm.uuid && String(info.UUID ?? '').replaceAll('"', '').toLowerCase() !== uuid(live.sourceVm.uuid, 'liveChecks.sourceVm.uuid')) {
      fail('liveChecks.sourceVm', 'source VM UUID does not match');
    }
    if (live.sourceVm.preserved === true && !info.UUID) fail('liveChecks.sourceVm', 'source VM is not preserved');
    if (live.sourceVm.state && info.VMState !== live.sourceVm.state) {
      fail('liveChecks.sourceVm', `source VM state is '${info.VMState}', expected '${live.sourceVm.state}'`);
    }
    if (live.sourceVm.snapshotUuid) {
      const snapshots = runCommand('VBoxManage', ['snapshot', live.sourceVm.name, 'list', '--machinereadable']);
      if (!snapshots.includes(uuid(live.sourceVm.snapshotUuid, 'liveChecks.sourceVm.snapshotUuid'))) {
        fail('liveChecks.sourceVm', 'source VM snapshot is absent');
      }
    }
    checks.push({ type: 'source-vm', name: live.sourceVm.name, uuid: info.UUID ?? null });
  }

  if (Array.isArray(live.pathsAbsent)) {
    for (const [index, item] of live.pathsAbsent.entries()) {
      const absentPath = absolutePath(item, `liveChecks.pathsAbsent[${index}]`);
      if (existsSync(absentPath)) fail(`liveChecks.pathsAbsent[${index}]`, 'path still exists');
      checks.push({ type: 'path-absent', path: absentPath });
    }
  }

  return checks;
}
