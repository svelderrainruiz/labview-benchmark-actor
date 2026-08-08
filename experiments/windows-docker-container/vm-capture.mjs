#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodePng, encodePng } from '../manual-procedure-record/capture-adapter.mjs';
import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';
import { buildLaunchCapture } from '../mprr-capture-ring/launch-capture.mjs';
import { createStreamingFramebuffer, sampleDescriptor } from '../mprr-capture-ring/vnc-source.mjs';
import { buildWorkloadRecord } from '../mprr-capture-ring/workload-benchmark.mjs';
import {
  analyzePixels,
  proveLabviewVisibility,
  selectRepresentativeFrames,
  summarizeFingerprints,
  validateMonotonicFrames,
  withTimeout,
} from './experiment-core.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForFile(file, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await sleep(250);
  }
  throw new Error(`${label} timed out`);
}

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`invalid argument '${argv[i] ?? ''}'`);
    result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}
const atomicJson = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function powershellJson(script, timeout = 15000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const line = stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error('PowerShell sampler returned no JSON');
  return JSON.parse(line);
}

async function main() {
  const options = args(process.argv.slice(2));
  const vmName = options['vm-name'];
  const port = Number(options['vnc-port']);
  const password = readFileSync(path.resolve(options['password-file']), 'utf8').trim();
  const evidenceDir = path.resolve(options['evidence-dir']);
  const manualGoFile = options['manual-launch-go-file'] ? path.resolve(options['manual-launch-go-file']) : null;
  const manualDiagnosticsFile = options['manual-launch-diagnostics-file'] ? path.resolve(options['manual-launch-diagnostics-file']) : null;
  const manualLaunch = manualGoFile || manualDiagnosticsFile;
  const vagrantCwd = options['vagrant-cwd'] ? path.resolve(options['vagrant-cwd']) : null;
  const vagrantMachine = options['vagrant-machine'] ?? 'default';
  const vagrantLaunch = vagrantCwd !== null;
  const fps = Number(options.fps ?? 12);
  const durationMs = Number(options['duration-ms'] ?? 90000);
  const dimensionStableMs = Number(options['dimension-stable-ms'] ?? 1000);
  const settle = { window: Number(options['settle-window'] ?? 8), toleranceHamming: Number(options['settle-tolerance'] ?? 2) };
  if (!vmName || !Number.isInteger(port) || !password || !evidenceDir) throw new Error('VM capture arguments are incomplete');
  if ((manualGoFile && !manualDiagnosticsFile) || (!manualGoFile && manualDiagnosticsFile)) {
    throw new Error('manual launch mode requires both --manual-launch-go-file and --manual-launch-diagnostics-file');
  }
  if (manualLaunch && vagrantLaunch) throw new Error('manual launch and Vagrant launch modes are mutually exclusive');
  if (!manualLaunch && !vagrantLaunch && !options['guest-password-file']) {
    throw new Error('guest-password-file is required when not using manual or Vagrant launch mode');
  }
  mkdirSync(evidenceDir, { recursive: true });
  const cache = path.join(evidenceDir, '.cache');
  const frameDir = path.join(evidenceDir, 'frames');
  mkdirSync(cache, { recursive: true }); mkdirSync(frameDir, { recursive: true });

  const origin = process.hrtime.bigint();
  const nowMs = () => Number(process.hrtime.bigint() - origin) / 1e6;
  const frames = [];
  const resources = [];
  let stream;
  let timer;
  let resourceTimer;
  let launchStartMs;
  let launchDiagnostics;
  try {
    const vmInfo = (await execFileAsync('VBoxManage', ['showvminfo', vmName, '--machinereadable'], { windowsHide: true })).stdout;
    const pidMatch = /^VMProcessPID=(\d+)$/m.exec(vmInfo);
    let vmPid = pidMatch ? Number(pidMatch[1]) : null;
    if (!vmPid) {
      const escapedVmName = vmName.replaceAll("'", "''");
      const processIdentity = await powershellJson(`
$matches=@(
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('VBoxHeadless.exe','VirtualBoxVM.exe') -and
    $_.CommandLine -like '"C:\\Program Files\\Oracle\\VirtualBox\\*' -and
    $_.CommandLine -match '--comment ${escapedVmName}(?:\\s|$)'
  }
)
if($matches.Count -ne 1){throw "Expected one VirtualBox VM process for ${escapedVmName}, got $($matches.Count)"}
[pscustomobject]@{processId=[int]$matches[0].ProcessId}|ConvertTo-Json -Compress
`);
      vmPid = processIdentity.processId;
    }
    if (!Number.isInteger(vmPid) || vmPid <= 0) throw new Error('VirtualBox VM process PID is unavailable');
    stream = createStreamingFramebuffer({
      host: '127.0.0.1', port, password,
      connect: ({ host, port: connectPort }) => net.connect({ host, port: connectPort }),
    });
    const connection = await withTimeout(stream.ready, 30000, 'VM RFB full framebuffer timed out');
    const firstAnalysis = analyzePixels(stream.current(), connection.width, connection.height);
    if (!firstAnalysis.passed || connection.securityType !== 2) throw new Error('VM baseline framebuffer/authentication proof failed');

    const sampleFrame = () => {
      const live = stream.current();
      const { width, height } = stream.dims();
      if (live.length !== width * height * 4) {
        throw new Error(`live RFB buffer length ${live.length} disagrees with ${width}x${height}`);
      }
      const snapshot = Uint8Array.from(live);
      const descriptor = sampleDescriptor(snapshot, width, height, {
        frameIndex: frames.length, t0Ms: 0, nowMs: nowMs(),
      });
      let cacheFile = frames.at(-1)?.cacheFile ?? null;
      if (!frames.length || descriptor.dhash64 !== frames.at(-1).dhashHex) {
        cacheFile = path.join(cache, `frame-${String(frames.length).padStart(6, '0')}.png`);
        writeFileSync(cacheFile, encodePng(snapshot, width, height));
      }
      frames.push({
        index: frames.length, ms: nowMs(), wallTime: new Date().toISOString(),
        dhashHex: descriptor.dhash64, timingTicks64: descriptor.timingTicks64.toString(),
        rfbUpdateCount: stream.updateCount(), width, height, cacheFile,
      });
    };
    sampleFrame();
    timer = setInterval(sampleFrame, Math.round(1000 / fps));

    let priorResource = null;
    const sampleResource = async () => {
      const sample = await powershellJson(`
$p=Get-CimInstance Win32_Process -Filter "ProcessId=${vmPid}"
$cpu=[double]$p.KernelModeTime+[double]$p.UserModeTime
[pscustomobject]@{wallTime=[DateTime]::UtcNow.ToString('o');cpu100ns=$cpu;workingSet=[double]$p.WorkingSetSize;readBytes=[double]$p.ReadTransferCount;writeBytes=[double]$p.WriteTransferCount;hostCpuCount=[Environment]::ProcessorCount}|ConvertTo-Json -Compress
`);
      const ms = nowMs();
      const cpuPct = priorResource
        ? Math.max(0, ((sample.cpu100ns - priorResource.cpu100ns) / 1e7) / ((ms - priorResource.ms) / 1000) * 100 / sample.hostCpuCount)
        : null;
      resources.push({
        ms, wallTime: sample.wallTime, cpuPct, ramMb: sample.workingSet / 1024 / 1024, diskPct: null,
        counters: { vmReadMb: sample.readBytes / 1024 / 1024, vmWriteMb: sample.writeBytes / 1024 / 1024 },
        source: 'host Win32_Process VirtualBox VM cumulative counters',
        clock: 'host process.hrtime.bigint',
      });
      priorResource = { ...sample, ms };
    };
    await sampleResource();
    resourceTimer = setInterval(() => sampleResource().catch(() => {}), 1000);

    const dimensionDeadline = Date.now() + 30000;
    let stableStartIndex = 0;
    while (Date.now() < dimensionDeadline) {
      await sleep(100);
      const latest = frames.at(-1);
      if (!latest) continue;
      stableStartIndex = frames.length - 1;
      for (let index = frames.length - 2; index >= 0; index -= 1) {
        if (frames[index].width !== latest.width || frames[index].height !== latest.height) break;
        stableStartIndex = index;
      }
      const stableFrames = frames.slice(stableStartIndex);
      if (
        stableFrames.length >= 2
        && stableFrames.at(-1).ms - stableFrames[0].ms >= dimensionStableMs
        && stableFrames.every((frame) => frame.width === latest.width && frame.height === latest.height)
      ) {
        break;
      }
    }
    if (
      frames.length < 2
      || stableStartIndex < 0
      || frames.at(-1).ms - frames[stableStartIndex].ms < dimensionStableMs
    ) {
      throw new Error(`RFB dimensions did not remain stable for ${dimensionStableMs} ms before launch`);
    }
    if (stableStartIndex > 0) {
      frames.splice(0, stableStartIndex);
      frames.forEach((frame, index) => { frame.index = index; });
    }
    launchStartMs = nowMs();
    atomicJson(path.join(evidenceDir, 'launch-trigger.json'), {
      hostMonotonicMs: launchStartMs, wallTime: new Date().toISOString(), clock: 'host process.hrtime.bigint',
    });
    const launchPromise = manualLaunch
      ? (async () => {
          if (existsSync(manualDiagnosticsFile)) throw new Error('manual launch diagnostics file already exists');
          if (existsSync(manualGoFile)) throw new Error('manual launch trigger file already exists');
          writeFileSync(manualGoFile, `${JSON.stringify({
            schema: 'labview-benchmark-actor/windows-vm-manual-launch-trigger@1',
            wallTime: new Date().toISOString(),
            hostMonotonicMs: launchStartMs,
          }, null, 2)}\n`);
          await waitForFile(manualDiagnosticsFile, 180000, 'manual launch diagnostics');
          return null;
        })().catch((error) => error)
      : vagrantLaunch
        ? execFileAsync('vagrant', [
            'winrm', vagrantMachine, '-c',
            'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\lba-provision\\vm-launch-vagrant.ps1',
          ], {
            cwd: vagrantCwd,
            windowsHide: true,
            timeout: 190000,
            maxBuffer: 8 * 1024 * 1024,
            env: process.env,
          }).then(({ stdout }) => {
            const line = stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith('{')).at(-1);
            if (!line) throw new Error('Vagrant launch adapter returned no diagnostics JSON');
            launchDiagnostics = JSON.parse(line);
            return null;
          }).catch((error) => error)
        : execFileAsync('VBoxManage', [
          'guestcontrol', vmName, 'run',
          '--exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          '--username', 'vagrant', '--passwordfile', options['guest-password-file'],
          '--wait-stdout', '--wait-stderr', '--timeout=180000', '--',
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', 'C:\\lba-provision\\vm-launch.ps1',
          '-OutputPath', 'C:\\lba-provision\\launch-diagnostics.json',
          '-WindowTimeoutSeconds', '90',
        ], { windowsHide: true, timeout: 190000, maxBuffer: 8 * 1024 * 1024 }).catch((error) => error);

    while (nowMs() - launchStartMs < durationMs) await sleep(100);
    const launchError = await launchPromise;
    clearInterval(timer); timer = null;
    clearInterval(resourceTimer); resourceTimer = null;
    await sampleResource();
    stream.close();
    const diagnosticHost = path.join(evidenceDir, 'launch-diagnostics.json');
    if (manualLaunch) {
      launchDiagnostics = JSON.parse(readFileSync(manualDiagnosticsFile, 'utf8'));
      if (manualDiagnosticsFile !== diagnosticHost) {
        copyFileSync(manualDiagnosticsFile, diagnosticHost);
      }
    } else if (vagrantLaunch) {
      if (!launchDiagnostics) {
        throw new Error(launchError?.message ?? 'Vagrant launch diagnostics are unavailable');
      }
      atomicJson(diagnosticHost, launchDiagnostics);
    } else {
      await execFileAsync('VBoxManage', [
        'guestcontrol', vmName, 'copyfrom', '--username', 'vagrant',
        '--passwordfile', options['guest-password-file'],
        'C:\\lba-provision\\launch-diagnostics.json', diagnosticHost,
      ], { windowsHide: true });
      launchDiagnostics = JSON.parse(readFileSync(diagnosticHost, 'utf8'));
    }
    if (launchDiagnostics.status === 'activation-required') {
      const failure = {
        schema: 'labview-benchmark-actor/windows-vm-labview-capture-failure@1',
        outcome: 'blocked',
        failedGate: 4,
        classification: 'labview-activation-required',
        error: launchDiagnostics.error,
        vmName,
        rfb: { ...connection, updateCount: stream.updateCount() },
        frameCount: frames.length,
        resourceSampleCount: resources.length,
        launchDiagnostics,
      };
      atomicJson(path.join(evidenceDir, 'failure-receipt.json'), failure);
      atomicJson(path.join(evidenceDir, 'capture-summary.json'), failure);
      return 4;
    }
    if (launchError instanceof Error || launchDiagnostics.status !== 'ready') {
      throw new Error(launchDiagnostics.error ?? launchError.message);
    }
    validateMonotonicFrames(frames);
    if (frames.some((frame) => frame.width !== frames[0].width || frame.height !== frames[0].height)) {
      const dimensions = [...new Set(frames.map((frame) => `${frame.width}x${frame.height}`))];
      throw new Error(`RFB dimensions changed during the governed VM capture (${dimensions.join(', ')}); mixed-size evidence is rejected`);
    }
    const currentConnection = { ...stream.info(), updateCount: stream.updateCount() };
    const selected = selectRepresentativeFrames(frames, launchStartMs, settle);
    const reps = {};
    for (const [role, frame] of Object.entries({ initial: selected.initial, transition: selected.transition, settled: selected.settled })) {
      const relative = `frames/${role}-${String(frame.index).padStart(6, '0')}.png`;
      const destination = path.join(evidenceDir, relative);
      copyFileSync(frame.cacheFile, destination);
      const decoded = decodePng(readFileSync(destination));
      const analysis = analyzePixels(decoded.rgba, decoded.width, decoded.height);
      if (!analysis.passed) throw new Error(`${role} frame failed pixel proof`);
      reps[role] = {
        role, frameIndex: frame.index, monotonicMs: frame.ms, dhashHex: frame.dhashHex,
        path: relative, size: statSync(destination).size, sha256: sha256(destination), analysis,
      };
    }
    const initial = decodePng(readFileSync(path.join(evidenceDir, reps.initial.path)));
    const settledPng = decodePng(readFileSync(path.join(evidenceDir, reps.settled.path)));
    const visibility = proveLabviewVisibility({
      initialRgba: initial.rgba, candidateRgba: settledPng.rgba,
      width: currentConnection.width, height: currentConnection.height,
      initialFingerprint: reps.initial.dhashHex, candidateFingerprint: reps.settled.dhashHex,
      labviewPid: launchDiagnostics.labviewPid, window: launchDiagnostics.expectedWindow,
      expectedDesktop: 'WinSta0\\Default',
    });
    if (!visibility.passed) throw new Error(visibility.reason);
    const usableResources = resources.filter((sample) => Number.isFinite(sample.cpuPct) && Number.isFinite(sample.ramMb));
    if (!usableResources.length) throw new Error('VM resource samples are missing');

    const workload = buildWorkloadRecord({
      frames, workloadStartMs: launchStartMs,
      meta: {
        workload: 'labview-ide-launch', iteration: path.basename(evidenceDir),
        plane: 'WIN', hypervisor: 'virtualbox-tightvnc', substrate: 'full-windows-vm-interactive',
      },
      settle,
    });
    const representativeByIndex = new Map(Object.values(reps).map((item) => [item.frameIndex, item]));
    const launchCapture = buildLaunchCapture({
      frames: frames.map((frame) => ({
        ms: frame.ms, dhashHex: frame.dhashHex,
        imageFile: representativeByIndex.get(frame.index)?.path ?? null,
        imageBytes: representativeByIndex.get(frame.index)?.size ?? 0,
      })),
      resourceSamples: resources,
      startMs: frames[0].ms,
      fps,
      capacityBytes: 64 * 1024 * 1024,
      meta: {
        workload: 'labview-ide-launch', plane: 'WIN', source: 'virtualbox-tightvnc-rfb',
        screenW: currentConnection.width, screenH: currentConnection.height,
        vmName, vmProcessId: vmPid, resourceSource: 'host Win32_Process VirtualBox VM process',
      },
    });
    const summary = {
      schema: 'labview-benchmark-actor/windows-vm-labview-capture@1',
      outcome: 'passed',
      vmName,
      rfb: currentConnection,
      relay: { endpoint: `127.0.0.1:${port}`, guestEndpoint: 'vm-nat:5900', localOnly: true },
      frameCount: frames.length,
      authoritativeFrameCount: launchCapture.dualPacket.authoritativeFrames,
      fingerprintSummary: summarizeFingerprints(frames),
      workloadStartMs: launchStartMs,
      launchMs: workload.spans.find((span) => span.id === 'launchMs').ms,
      settle: selected.settle,
      representatives: reps,
      visibility,
      resourceSampleCount: resources.length,
      usableResourceSampleCount: usableResources.length,
      resourceClock: 'host process.hrtime.bigint',
    };
    atomicJson(path.join(evidenceDir, 'benchmark.json'), workload);
    atomicJson(path.join(evidenceDir, 'launch-capture.json'), launchCapture);
    atomicJson(path.join(evidenceDir, 'resource-samples.json'), {
      schema: 'labview-benchmark-actor/windows-vm-resources@1', samples: resources,
    });
    atomicJson(path.join(evidenceDir, 'capture-summary.json'), summary);
    console.log(JSON.stringify(summary));
    return 0;
  } finally {
    if (timer) clearInterval(timer);
    if (resourceTimer) clearInterval(resourceTimer);
    stream?.close();
    rmSync(cache, { recursive: true, force: true });
  }
}

process.exitCode = await main().catch((error) => {
  console.error(error.stack ?? error.message);
  return 1;
});
