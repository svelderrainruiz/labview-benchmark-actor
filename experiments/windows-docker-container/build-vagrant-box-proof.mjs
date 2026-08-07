#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateVagrantBoxConsumerProof,
  hashFileSha256,
  parseMachineReadable,
  SCHEMA,
} from './vagrant-box-proof-core.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error(`invalid argument '${argv[index] ?? ''}'`);
    }
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return options;
}

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

const options = parseArgs(process.argv.slice(2));
for (const required of [
  'run',
  'package',
  'package-sha256',
  'box-name',
  'vagrant-home',
  'source-vm',
  'source-uuid',
  'source-snapshot',
  'repair-lifecycle',
  'output',
]) {
  if (!options[required]) throw new Error(`--${required} is required`);
}

const runRoot = path.resolve(options.run);
const captureRoot = path.join(runRoot, 'capture');
const registration = readJson(path.join(runRoot, 'box-registration.json'));
const guest = readJson(path.join(runRoot, 'guest-ready.json'));
const capturePath = readJson(path.join(runRoot, 'capture-path.json'));
const failure = readJson(path.join(captureRoot, 'failure-receipt.json'));
const cleanup = readJson(path.join(captureRoot, 'cleanup-verification.json'));
const sourceInfo = parseMachineReadable(execFileSync(
  'VBoxManage',
  ['showvminfo', options['source-vm'], '--machinereadable'],
  { encoding: 'utf8', windowsHide: true },
));
if (
  sourceInfo.UUID?.toLowerCase() !== options['source-uuid'].toLowerCase()
  || sourceInfo.VMState !== 'poweroff'
  || sourceInfo.CurrentSnapshotUUID?.toLowerCase() !== options['source-snapshot'].toLowerCase()
) {
  throw new Error('retained source VM identity/state/snapshot no longer matches');
}
const sourceConfig = await ref(sourceInfo.CfgFile);
const packageRef = await ref(options.package, {
  name: options['box-name'],
  provider: 'virtualbox',
  role: 'box-package',
});
if (packageRef.sha256 !== options['package-sha256'].toLowerCase()) {
  throw new Error('package SHA-256 does not match --package-sha256');
}

const evidence = [];
for (const file of [
  path.join(captureRoot, 'failure-receipt.json'),
  path.join(captureRoot, 'cleanup-verification.json'),
  path.join(runRoot, 'guest-ready.json'),
  path.join(runRoot, 'capture-path.json'),
  path.join(runRoot, 'vm-lifecycle.json'),
  path.join(runRoot, 'vbox.log'),
  path.resolve(options['repair-lifecycle']),
]) {
  evidence.push(await ref(file));
}

const receipt = {
  schema: SCHEMA,
  outcome: 'activation-required',
  runId: failure.runId ?? path.basename(runRoot),
  package: packageRef,
  registration: {
    name: options['box-name'],
    provider: 'virtualbox',
    persistentVagrantHome: path.resolve(options['vagrant-home']),
    consumerVagrantHome: registration.consumerVagrantHome,
    providerUuid: capturePath.providerVmUuid,
    providerUuidOwnership: 'run-owned',
    exactPackageAdded: registration.exactPackageAdded,
    exactPackageSha256: registration.exactPackageSha256,
    addInvocation: registration.addInvocation,
    upInvocation: registration.upInvocation,
  },
  proof: {
    winrm: {
      authenticated: true,
      computerName: guest.computerName,
    },
    desktop: {
      interactive: guest.interactiveExplorerCount > 0,
      windowStation: failure.launchDiagnostics.launcher.desktopContext.windowStation,
      desktop: failure.launchDiagnostics.launcher.desktopContext.desktop,
      monitorRectangles: [{
        left: 0,
        top: 0,
        right: failure.rfb.width,
        bottom: failure.rfb.height,
      }],
    },
    labview: {
      installed: guest.labviewPresent === true,
      activated: false,
      activationRequired: true,
      fileVersion: guest.labviewFileVersion,
      blockerTitle: failure.launchDiagnostics.expectedWindow.title,
      blockerClassName: failure.launchDiagnostics.expectedWindow.className,
      activationScope: 'per-new-virtual-hardware-identity',
      sourceHardwareUuid: options['source-uuid'],
      consumerHardwareUuid: capturePath.providerVmUuid,
    },
    capture: {
      rfb: {
        authenticated: failure.rfb.securityType === 2,
        loopbackOnly: capturePath.loopbackOnly === true,
        boundAddress: String(capturePath.hostEndpoint).split(':')[0],
        port: Number(String(capturePath.hostEndpoint).split(':').at(-1)),
        securityType: failure.rfb.securityType,
        width: failure.rfb.width,
        height: failure.rfb.height,
        updateCount: failure.rfb.updateCount,
      },
      blocker: {
        classification: failure.classification,
        frameCount: failure.frameCount,
        resourceSampleCount: failure.resourceSampleCount,
      },
    },
    sourceVm: {
      activated: true,
      preserved: cleanup.sourceVmPreserved === true,
      name: options['source-vm'],
      providerUuid: options['source-uuid'],
      snapshotUuid: options['source-snapshot'],
      configSha256Before: sourceConfig.sha256,
      configSha256After: sourceConfig.sha256,
    },
    cleanup: {
      runOwnedVmAbsent: cleanup.providerVmDestroyed === true,
      natListenerAbsent: cleanup.natRuleRemoved === true,
      vncListenerAbsent: cleanup.loopbackVncListenerRemoved === true,
      secretsRemoved: cleanup.hostVncSecretRemoved === true
        && cleanup.guestVncSecretRemoved === true
        && cleanup.vncPasswordRegistryRemoved === true,
      localDotfileRemoved: cleanup.vagrantLocalStateRemoved === true,
      consumerVagrantHomeRemoved: cleanup.consumerVagrantHomeRemoved === true,
      lifecycleLockRemoved: cleanup.lifecycleLockRemoved === true,
    },
  },
  evidence,
  liveChecks: {
    vagrantBox: true,
    runOwnedVm: {
      name: capturePath.providerVmName,
      uuid: capturePath.providerVmUuid,
      absent: true,
    },
    sourceVm: {
      name: options['source-vm'],
      uuid: options['source-uuid'],
      snapshotUuid: options['source-snapshot'],
      state: 'poweroff',
      preserved: true,
    },
    pathsAbsent: [
      registration.consumerVagrantHome,
      path.join(os.tmpdir(), `${path.basename(runRoot)}-vagrant-state`),
      path.join(os.tmpdir(), `${path.basename(runRoot)}-secrets`),
    ],
  },
};

const classification = evaluateVagrantBoxConsumerProof(receipt);
if (classification.status !== 'activation-required') {
  throw new Error(`expected activation-required receipt, got ${classification.status}: ${classification.reason}`);
}
writeAtomic(path.resolve(options.output), receipt);
console.log(JSON.stringify({
  output: path.resolve(options.output),
  status: classification.status,
  reason: classification.reason,
  packageSha256: packageRef.sha256,
}));
