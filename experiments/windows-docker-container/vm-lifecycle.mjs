#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  appendCheckpoint,
  createLifecycle,
  hostClockSnapshot,
  sealLifecycle,
  validateLifecycle,
} from './vm-lifecycle-core.mjs';

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`invalid argument '${argv[i] ?? ''}'`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return { command, options };
}
const readJson = (file) => JSON.parse(readFileSync(path.resolve(file), 'utf8'));
const writeAtomic = (file, value) => {
  const absolute = path.resolve(file);
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, absolute);
};
const fileRef = async (file) => {
  const absolute = path.resolve(file);
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(absolute);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { path: absolute, size: statSync(absolute).size, sha256: hash.digest('hex') };
};
const releaseResumeLock = (record, recordFile) => {
  const lock = record.resume?.lock;
  if (!lock || lock.releasedWallTime) return false;
  const absoluteRecord = path.resolve(recordFile);
  const lockPath = path.resolve(lock.path);
  if (!existsSync(lockPath)) {
    if (!lock.releasePendingWallTime) throw new Error(`VM lifecycle resume lock '${lockPath}' is unexpectedly absent`);
  } else {
    const receipt = readJson(lockPath);
    if (
      receipt.schema !== 'labview-benchmark-actor/windows-vm-lifecycle-resume-lock@1'
      || receipt.lifecycleId !== record.lifecycleId
      || typeof receipt.record !== 'string'
      || path.resolve(receipt.record) !== absoluteRecord
    ) {
      throw new Error(`refusing to release VM lifecycle lock '${lockPath}' owned by another record`);
    }
    lock.releasePendingWallTime = new Date().toISOString();
    writeAtomic(absoluteRecord, record);
    unlinkSync(lockPath);
  }
  lock.releasedWallTime = new Date().toISOString();
  delete lock.releasePendingWallTime;
  writeAtomic(absoluteRecord, record);
  return true;
};

const { command, options } = parseArgs(process.argv.slice(2));
if (command === 'init') {
  const clock = hostClockSnapshot();
  const record = createLifecycle({
    lifecycleId: options['lifecycle-id'],
    vmName: options['vm-name'],
    createdClock: clock,
  });
  writeAtomic(options.record, record);
  console.log(JSON.stringify({ record: path.resolve(options.record), phase: 'LIFECYCLE-OPEN', clock }));
} else if (command === 'checkpoint') {
  const record = readJson(options.record);
  const evidence = options.evidence ? [await fileRef(options.evidence)] : [];
  const checkpoint = appendCheckpoint(record, {
    phase: options.phase,
    status: options.status,
    detail: options.detail ?? null,
    evidence,
  });
  writeAtomic(options.record, record);
  console.log(JSON.stringify(checkpoint));
} else if (command === 'resume') {
  const cacheFile = path.resolve(options.cache);
  const recordFile = path.resolve(options.record);
  const cache = readJson(cacheFile);
  validateLifecycle(cache);
  if (cache.resume?.state !== 'activation-required') throw new Error('cache is not waiting for activation');
  if (existsSync(recordFile)) throw new Error('resume record already exists');
  if (cache.cache?.state === 'verified-poweroff-activation-required') {
    const vmInfo = execFileSync('VBoxManage', ['showvminfo', cache.vmName, '--machinereadable'], { encoding: 'utf8' });
    if (!new RegExp(`^UUID="${cache.cache.vm.uuid}"$`, 'm').test(vmInfo)) throw new Error('cached VM UUID no longer matches');
    if (!/^VMState="poweroff"$/m.test(vmInfo)) throw new Error('cached VM must be powered off before resume');
    const snapshots = execFileSync('VBoxManage', ['snapshot', cache.vmName, 'list', '--machinereadable'], { encoding: 'utf8' });
    for (const uuid of Object.values(cache.cache.snapshots)) {
      if (!snapshots.includes(uuid)) throw new Error(`cached snapshot ${uuid} is missing`);
    }
  }
  const cacheRef = await fileRef(cacheFile);
  const lockPath = path.resolve(cache.cache?.vm?.lockPath ?? `${cacheFile}.resume.lock`);
  let lockFd;
  const lockReceipt = {
    schema: 'labview-benchmark-actor/windows-vm-lifecycle-resume-lock@1',
    lifecycleId: options['lifecycle-id'],
    record: recordFile,
    cache: cacheRef,
    openedWallTime: new Date().toISOString(),
  };
  try {
    lockFd = openSync(lockPath, 'wx');
    writeFileSync(lockFd, `${JSON.stringify(lockReceipt, null, 2)}\n`);
    closeSync(lockFd);
    lockFd = null;
  } catch (error) {
    if (lockFd != null) closeSync(lockFd);
    throw new Error(`cannot acquire exclusive VM lifecycle resume lock '${lockPath}': ${error.message}`);
  }
  const record = createLifecycle({
    lifecycleId: options['lifecycle-id'],
    vmName: cache.vmName,
  });
  record.cache = {
    sourceLifecycleId: cache.lifecycleId,
    source: cacheRef,
    vm: cache.cache.vm,
    snapshots: cache.cache.snapshots,
  };
  record.visualCapture = cache.visualCapture;
  record.resume = {
    ...cache.resume,
    resumedFrom: cacheRef,
    lock: {
      path: lockPath,
      acquiredWallTime: lockReceipt.openedWallTime,
      releasedWallTime: null,
    },
  };
  appendCheckpoint(record, {
    phase: 'ACTIVATION-RESUME-START',
    status: 'started',
    detail: 'Activation resume session opened before any guest or VM mutation.',
    evidence: [cacheRef],
  });
  try {
    writeAtomic(recordFile, record);
  } catch (error) {
    unlinkSync(lockPath);
    throw error;
  }
  console.log(JSON.stringify({ record: recordFile, cache: cacheRef, phase: 'ACTIVATION-RESUME-START' }));
} else if (command === 'seal') {
  const record = readJson(options.record);
  const resume = options['next-phase']
    ? {
        ...record.resume,
        state: options.state ?? 'ready',
        nextPhase: options['next-phase'],
        detail: options.detail ?? null,
      }
    : record.resume;
  sealLifecycle(record, {
    cache: record.cache ?? { artifacts: [] },
    visualCapture: record.visualCapture,
    resume,
  });
  writeAtomic(options.record, record);
  releaseResumeLock(record, options.record);
  console.log(JSON.stringify({ record: path.resolve(options.record), state: record.state, nextPhase: record.resume?.nextPhase ?? null }));
} else if (command === 'release') {
  const record = readJson(options.record);
  validateLifecycle(record);
  const released = releaseResumeLock(record, options.record);
  console.log(JSON.stringify({ record: path.resolve(options.record), released }));
} else if (command === 'verify') {
  const record = readJson(options.record);
  validateLifecycle(record, { allowOpen: options['allow-open'] === 'true' });
  console.log(JSON.stringify({
    lifecycleId: record.lifecycleId,
    state: record.state,
    checkpoints: record.checkpoints.length,
    spans: record.spans.length,
    nextPhase: record.resume?.nextPhase ?? null,
  }));
} else {
  console.error('Usage: vm-lifecycle.mjs <init|checkpoint|resume|seal|release|verify> [options]');
  process.exitCode = 2;
}
