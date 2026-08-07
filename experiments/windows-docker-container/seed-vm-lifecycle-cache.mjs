#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createHistoricalLifecycle,
  historicalCheckpoint,
  sealLifecycle,
} from './vm-lifecycle-core.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const captureRoot = path.join(import.meta.dirname, 'evidence', 'vm-20260807T122440763Z');
const decisionRoot = path.join(import.meta.dirname, 'decisions');
const provisioningPath = path.join(decisionRoot, 'windows-vm-provisioning-receipt.json');
const preflightPath = path.join(decisionRoot, 'windows-vm-substrate-preflight.json');
const output = path.join(decisionRoot, 'windows-vm-lifecycle-cache.json');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const hashSmall = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const repoRef = (file) => ({
  path: path.relative(repoRoot, file).replaceAll('\\', '/'),
  size: statSync(file).size,
  sha256: hashSmall(file),
});
const externalRef = (entry) => ({ path: entry.file, size: entry.size, sha256: entry.sha256 });

const provisioning = readJson(provisioningPath);
const preflight = readJson(preflightPath);
const failure = readJson(path.join(captureRoot, 'failure-receipt.json'));
const benchmark = readJson(path.join(captureRoot, 'benchmark.json'));
const launchCapture = readJson(path.join(captureRoot, 'launch-capture.json'));
const launchTrigger = readJson(path.join(captureRoot, 'launch-trigger.json'));
const resourceRecord = readJson(path.join(captureRoot, 'resource-samples.json'));
const round4 = (value) => Math.round(value * 10000) / 10000;
const representativeFrame = (role) => {
  const frame = launchCapture.frames.find((candidate) => candidate.image?.startsWith(`frames/${role}-`));
  if (!frame) throw new Error(`missing ${role} representative frame`);
  return {
    frameIndex: frame.index,
    monotonicMs: launchCapture.startMs + frame.tMs,
    dhashHex: frame.dhashHex,
    path: frame.image,
  };
};
const representatives = {
  initial: representativeFrame('initial'),
  transition: representativeFrame('transition'),
  settled: representativeFrame('settled'),
};
const vmInfo = execFileSync('VBoxManage', ['showvminfo', provisioning.vm.name, '--machinereadable'], { encoding: 'utf8' });
if (!new RegExp(`^UUID="${provisioning.vm.uuid}"$`, 'm').test(vmInfo) || !/^VMState="poweroff"$/m.test(vmInfo)) {
  throw new Error('retained VM identity/state does not match provisioning receipt');
}
const snapshots = execFileSync('VBoxManage', ['snapshot', provisioning.vm.name, 'list', '--machinereadable'], { encoding: 'utf8' });
for (const uuid of Object.values(provisioning.vm.snapshots)) {
  if (!snapshots.includes(uuid)) throw new Error(`retained snapshot ${uuid} is missing`);
}

const refs = {
  provisioning: repoRef(provisioningPath),
  preflight: repoRef(preflightPath),
  captureManifest: repoRef(path.join(captureRoot, 'manifest.json')),
  failure: repoRef(path.join(captureRoot, 'failure-receipt.json')),
  benchmark: repoRef(path.join(captureRoot, 'benchmark.json')),
  launchCapture: repoRef(path.join(captureRoot, 'launch-capture.json')),
  resources: repoRef(path.join(captureRoot, 'resource-samples.json')),
  guestCleanup: repoRef(path.join(captureRoot, 'guest-cleanup-verification.json')),
  initialPng: repoRef(path.join(captureRoot, representatives.initial.path)),
  transitionPng: repoRef(path.join(captureRoot, representatives.transition.path)),
  settledPng: repoRef(path.join(captureRoot, representatives.settled.path)),
  vmConfig: {
    path: 'D:\\VirtualBox VMs\\lba-win11-labview2026-build\\lba-win11-labview2026-build.vbox',
  },
  windowsIso: externalRef(provisioning.sources.windows),
  labviewIso: externalRef(provisioning.sources.labview),
};
refs.vmConfig.size = statSync(refs.vmConfig.path).size;
refs.vmConfig.sha256 = hashSmall(refs.vmConfig.path);

const record = createHistoricalLifecycle({
  lifecycleId: 'windows-vm-provisioning-20260807',
  vmName: provisioning.vm.name,
  detail: 'Provisioning began before lifecycle checkpointing existed; pre-provision monotonic duration is unavailable and must not be estimated.',
});
const checkpoints = [
  ['MEDIA-VERIFIED', 'completed', 'Official Windows and NI Q3 ISO hashes verified.', [refs.windowsIso, refs.labviewIso]],
  ['VM-CREATE-START', 'completed', 'VirtualBox VM was created; historical start timestamp was not captured by this lifecycle.', [refs.provisioning]],
  ['WINDOWS-PROVISION-START', 'completed', 'Windows 11 Pro unattended provisioning began; historical monotonic time unavailable.', [refs.provisioning]],
  ['WINDOWS-INTERACTIVE-READY', 'completed', 'Windows interactive desktop and Guest Additions became available.', [refs.provisioning]],
  ['PRE-LABVIEW-SNAPSHOT', 'completed', `Snapshot ${provisioning.vm.snapshots.preLabview} retained.`, [refs.provisioning]],
  ['LABVIEW-INSTALL-START', 'completed', 'NI Q3 x64 installation began; historical monotonic time unavailable.', [refs.provisioning]],
  ['LABVIEW-INSTALLED', 'completed', `${provisioning.sources.labview.package} ${provisioning.sources.labview.packageVersion} installed.`, [refs.provisioning]],
  ['CAPTURE-PATH-READY', 'completed', 'TightVNC authenticated RFB plus DesktopSize interoperability proved.', [refs.captureManifest]],
  ['DIAGNOSTIC-CAPTURE-START', 'completed', 'MPRR VM capture started before the LabVIEW scheduled task.', [refs.captureManifest]],
  ['LABVIEW-SPLASH-VISIBLE', 'completed', 'LabVIEW Q3 splash was captured in the transition long packet.', [refs.transitionPng]],
  ['ACTIVATION-REQUIRED', 'blocked', 'NI License Manager Wizard was the stable process-matched window.', [refs.failure, refs.settledPng]],
];
for (const [phase, status, detail, evidence] of checkpoints) {
  record.checkpoints.push(historicalCheckpoint({ phase, status, detail, evidence }));
}

const workloadStartMs = launchTrigger.hostMonotonicMs;
const transition = representatives.transition;
const settled = representatives.settled;
const launchSpan = benchmark.spans.find((span) => span.id === 'launchMs');
const visualCapture = {
  outcome: 'blocked-activation',
  diagnosticOnly: true,
  evidenceRoot: path.relative(repoRoot, captureRoot).replaceAll('\\', '/'),
  captureClock: 'host process.hrtime.bigint',
  workloadStartMs,
  splash: {
    frameIndex: transition.frameIndex,
    hostMonotonicMs: transition.monotonicMs,
    msFromLaunchTrigger: round4(transition.monotonicMs - workloadStartMs),
    fingerprint: transition.dhashHex,
    png: refs.transitionPng,
  },
  activationWizardSettled: {
    frameIndex: settled.frameIndex,
    hostMonotonicMs: settled.monotonicMs,
    msFromLaunchTrigger: round4(settled.monotonicMs - workloadStartMs),
    benchmarkLaunchMsRaw: launchSpan.ms,
    timingRoundingDeltaMs: round4((settled.monotonicMs - workloadStartMs) - launchSpan.ms),
    stableTailFrames: benchmark.sourceDetail.stableTailFrames,
    fingerprint: settled.dhashHex,
    png: refs.settledPng,
  },
  frameCount: launchCapture.frameCount,
  authoritativeLongPackets: launchCapture.dualPacket.authoritativeFrames,
  uniqueFingerprintCount: new Set(launchCapture.frames.map((frame) => frame.dhashHex)).size,
  visualTransitionCount: launchCapture.frames.slice(1).filter(
    (frame, index) => frame.dhashHex !== launchCapture.frames[index].dhashHex,
  ).length,
  resourceSampleCount: resourceRecord.samples.length,
  classification: failure.classification,
  warning: 'launchMs measures launch-to-stable License Manager wizard, not activated IDE readiness.',
};

const cache = {
  state: 'verified-poweroff-activation-required',
  vm: {
    name: provisioning.vm.name,
    uuid: provisioning.vm.uuid,
    provider: provisioning.provider,
    state: 'poweroff',
    os: provisioning.vm.os,
    labviewPackage: provisioning.sources.labview.package,
    labviewVersion: provisioning.sources.labview.packageVersion,
    labviewFileVersion: provisioning.sources.labview.fileVersion,
    activation: 'required',
    boxRegistered: false,
    lockPath: 'D:\\VirtualBox VMs\\lba-win11-labview2026-build\\.lba-lifecycle-resume.lock',
  },
  snapshots: provisioning.vm.snapshots,
  artifacts: Object.values(refs),
};
const resume = {
  state: 'activation-required',
  nextPhase: 'ACTIVATION-RESUME-START',
  nextAction: 'Start the retained VM, open a lifecycle resume record before mutation, complete NI activation interactively, then rerun VM capture.',
  command: `node experiments/windows-docker-container/vm-lifecycle.mjs resume --cache experiments/windows-docker-container/decisions/windows-vm-lifecycle-cache.json --record experiments/windows-docker-container/evidence/<resume-run>/vm-lifecycle.json --lifecycle-id <resume-run>`,
  reusableCache: [
    'Windows 11 Pro + Guest Additions VM',
    'LabVIEW 2026 Q3 Community x64 installation',
    'pre-LabVIEW and installed-unactivated snapshots',
    'verified Windows/NI media',
    'TightVNC/RFB/DesktopSize/MPRR capture implementation',
  ],
};
sealLifecycle(record, { cache, visualCapture, resume });
const temporary = `${output}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
renameSync(temporary, output);
console.log(`VM lifecycle cache -> ${output}`);
