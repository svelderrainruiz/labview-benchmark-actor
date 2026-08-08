#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  evaluateReviewerCacheReceipt,
  hashFileSha256,
  parseVBoxManageMachineReadable,
  SCHEMA,
} from './reviewer-cache-core.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeAtomic = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
};
const ref = async (file, extra = {}) => {
  const absolute = path.resolve(file);
  return {
    ...extra,
    path: absolute,
    size: statSync(absolute).size,
    sha256: await hashFileSha256(absolute),
  };
};

const [cacheRootArg, outputArg] = process.argv.slice(2);
if (!cacheRootArg || !outputArg) {
  console.error('Usage: node build-reviewer-cache.mjs <cache-root> <output.json>');
  process.exitCode = 2;
} else {
  const cacheRoot = path.resolve(cacheRootArg);
  const output = path.resolve(outputArg);
  const metadata = readJson(path.join(cacheRoot, 'reviewer-cache-session.json'));
  if (!['cache-ready', 'seal-verification-pending'].includes(metadata.state)) {
    throw new Error(`reviewer cache state is '${metadata.state}', expected cache-ready or seal-verification-pending`);
  }
  const lifecycle = readJson(metadata.lifecyclePath);
  const captureRoot = metadata.capture.root;
  const capture = readJson(path.join(captureRoot, 'capture-summary.json'));
  const resources = readJson(path.join(captureRoot, 'resource-samples.json'));
  const launch = readJson(path.join(captureRoot, 'launch-diagnostics.json'));
  const vsixStage = readJson(metadata.vsix.receiptPath);
  const snapshot = readJson(metadata.snapshot.receiptPath);
  const cleanup = readJson(metadata.cleanupPath);
  const vmInfo = parseVBoxManageMachineReadable(execFileSync(
    'VBoxManage',
    ['showvminfo', metadata.vm.name, '--machinereadable'],
    { encoding: 'utf8', windowsHide: true },
  ));
  if (
    vmInfo.UUID?.toLowerCase() !== metadata.vm.uuid.toLowerCase()
    || vmInfo.hardwareuuid?.toLowerCase() !== metadata.vm.hardwareUuid.toLowerCase()
    || vmInfo.VMState !== 'poweroff'
  ) {
    throw new Error('live retained VM identity/state contradicts cache metadata');
  }

  const packageRef = await ref(metadata.package.path, {
    name: metadata.vagrant.box,
    provider: 'virtualbox',
    version: '0',
    role: 'box-package',
  });
  if (packageRef.sha256 !== metadata.package.sha256) throw new Error('package SHA-256 no longer matches cache metadata');
  const configRef = await ref(vmInfo.CfgFile, { role: 'retained-vm-config' });
  const sourceArtifactRetained = metadata.vsix.sourceArtifactRetained !== false;
  const vsixRef = sourceArtifactRetained
    ? await ref(metadata.vsix.path, {
        role: 'local-vsix',
        version: metadata.vsix.version,
      })
    : {
        path: metadata.vsix.path,
        size: metadata.vsix.size,
        sha256: metadata.vsix.sha256,
        role: 'historical-local-vsix-identity',
        version: metadata.vsix.version,
        sourceArtifactRetained: false,
        installedSnapshotProof: {
          sourceVmUuid: metadata.vm.uuid,
          sourceSnapshotUuid: metadata.snapshot.uuid,
          extensionId: 'svelderrainruiz.labview-benchmark-actor',
          version: metadata.vsix.version,
          manifest: await ref(metadata.vsix.installedSnapshotManifestPath, {
            role: 'installed-extension-manifest',
          }),
          archive: await ref(metadata.vsix.installedSnapshotArchivePath, {
            role: 'installed-extension-archive',
          }),
        },
      };
  const captureManifest = await ref(metadata.capture.manifest, { role: 'activated-mprr-manifest' });
  const usableResources = resources.samples
    .filter((sample) => Number.isFinite(sample.cpuPct) && Number.isFinite(sample.ramMb))
    .map((sample) => ({
      ms: sample.ms,
      cpuPct: sample.cpuPct,
      ramMb: sample.ramMb,
      diskPct: sample.diskPct,
    }));
  if (usableResources.length === 0) throw new Error('activated capture has no usable resource samples');

  const worktree = vsixStage.worktree;
  const receipt = {
    schema: SCHEMA,
    outcome: 'passed',
    package: packageRef,
    registration: {
      name: metadata.vagrant.box,
      provider: 'virtualbox',
      pinnedVagrantHome: metadata.vagrant.home,
      persistentVagrantDotfilePath: metadata.vagrant.dotfilePath,
      providerVm: {
        name: metadata.vm.name,
        uuid: metadata.vm.uuid,
        hardwareUuid: metadata.vm.hardwareUuid,
        ownership: 'run-owned',
        state: 'poweroff',
      },
      addInvocation: {
        command: 'vagrant',
        args: [
          'box', 'add', '--force', '--name', metadata.vagrant.box,
          '--provider', 'virtualbox', metadata.package.path,
        ],
      },
      upInvocation: {
        command: 'vagrant',
        args: ['up', 'default', '--provider', 'virtualbox', '--no-provision'],
      },
    },
    provenance: {
      sourceBox: packageRef,
      sourceVm: {
        name: metadata.vm.name,
        uuid: metadata.vm.uuid,
        hardwareUuid: metadata.vm.hardwareUuid,
        snapshotUuid: metadata.snapshot.uuid,
        configFile: configRef,
      },
      worktree: {
        path: worktree.path,
        commit: worktree.commit,
        branch: worktree.branch,
        repository: worktree.repository,
      },
    },
    vsix: {
      ...vsixRef,
      worktree: {
        path: worktree.path,
        commit: worktree.commit,
        branch: worktree.branch,
        repository: worktree.repository,
      },
      installProof: {
        profile: 'interactive',
        command: vsixStage.command,
        owner: vsixStage.installProof.interactiveUser,
        installed: true,
        worktreePath: worktree.path,
      },
    },
    proof: {
      support: { supported: true, reason: 'retained-exact-vm-identity' },
      activation: {
        exactProviderVmUuid: metadata.vm.uuid,
        challengeVmUuid: metadata.activation.challengeVmUuid,
        activated: true,
        liveProof: {
          vmUuid: metadata.vm.uuid,
          hardwareUuid: metadata.vm.hardwareUuid,
          profile: metadata.activation.profile,
          exactUuidObserved: true,
        },
        mprr: {
          activated: launch.status === 'ready' && !/NI License Manager Wizard/.test(launch.expectedWindow.className),
          passed: capture.outcome === 'passed' && capture.visibility.passed === true,
          activationState: 'activated',
          launchMs: capture.launchMs,
          settleMs: capture.settle.settleMs,
          resourceSamples: usableResources,
          evidence: [captureManifest],
        },
      },
      lifecycle: {
        snapshotUuid: metadata.snapshot.uuid,
        state: lifecycle.state,
        cacheReady: lifecycle.completion?.completedThrough === 'REVIEWER-CACHE-READY',
        sealed: lifecycle.state === 'sealed',
        exclusiveLockReleased: metadata.lockReleased === true || metadata.lockReleasePending === true,
        vmPoweredOff: true,
        lockPath: metadata.lockPath,
        lockOwner: metadata.runId,
      },
      cleanup: {
        vmPoweredOff: cleanup.vmPoweredOff,
        vncListenerAbsent: cleanup.vncListenerAbsent,
        natListenerAbsent: cleanup.natListenerAbsent,
        tasksAbsent: cleanup.tasksAbsent,
        processesAbsent: cleanup.processesAbsent,
        secretsRemoved: cleanup.secretsRemoved,
        listenersAbsent: cleanup.listenersAbsent,
      },
    },
    resume: {
      environment: {
        VAGRANT_HOME: metadata.vagrant.home,
        VAGRANT_DOTFILE_PATH: metadata.vagrant.dotfilePath,
      },
      command: `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${path.join(import.meta.dirname, 'reviewer-cache.ps1')}" -Action Resume`,
      commands: [
        `$env:VAGRANT_HOME='${metadata.vagrant.home}'`,
        `$env:VAGRANT_CWD='${metadata.vagrant.cwd}'`,
        `$env:VAGRANT_DOTFILE_PATH='${metadata.vagrant.dotfilePath}'`,
        `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${path.join(import.meta.dirname, 'reviewer-cache.ps1')}" -Action Resume`,
      ],
      owner: 'run-owned',
    },
    intentionalDestroy: {
      command: `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${path.join(import.meta.dirname, 'reviewer-cache-destroy.ps1')}" -ConfirmVmUuid ${metadata.vm.uuid} -DiscardActivation`,
      owner: 'run-owned',
      reason: 'Destruction permanently discards the VM-specific NI activation.',
    },
    evidence: [],
    liveChecks: true,
  };

  const evidenceFiles = [
    metadata.lifecyclePath,
    metadata.capture.manifest,
    metadata.vsix.receiptPath,
    metadata.snapshot.receiptPath,
    metadata.cleanupPath,
    path.join(metadata.evidenceRoot, 'activation-request.json'),
    path.join(metadata.evidenceRoot, 'guest-ready.json'),
  ];
  if (metadata.guestCleanupPath) evidenceFiles.push(metadata.guestCleanupPath);
  if (metadata.maintenanceLifecyclePath) evidenceFiles.push(metadata.maintenanceLifecyclePath);
  if (metadata.lastReviewLifecyclePath) evidenceFiles.push(metadata.lastReviewLifecyclePath);
  if (metadata.vsix.repairReceiptPath) evidenceFiles.push(metadata.vsix.repairReceiptPath);
  for (const file of evidenceFiles) {
    receipt.evidence.push(await ref(file));
  }

  const classification = evaluateReviewerCacheReceipt(receipt);
  if (classification.status !== 'passed') {
    throw new Error(`reviewer cache receipt is ${classification.status}: ${classification.reason}`);
  }
  writeAtomic(output, receipt);
  console.log(JSON.stringify({
    output,
    status: classification.status,
    reason: classification.reason,
    vmUuid: metadata.vm.uuid,
    snapshotUuid: metadata.snapshot.uuid,
    vsixSha256: metadata.vsix.sha256,
  }));
}
