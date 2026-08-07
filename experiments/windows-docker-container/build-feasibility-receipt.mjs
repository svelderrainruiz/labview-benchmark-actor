#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildFeasibilityReceipt } from './feasibility-core.mjs';

const IMAGE = 'nationalinstruments/labview:2026q3-windows';
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const evidenceRoot = path.join(import.meta.dirname, 'evidence');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = (root, name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const rel = (file) => path.relative(repoRoot, file).replaceAll('\\', '/');
const evidenceFile = (root, name) => {
  const file = path.join(root, name);
  return { path: rel(file), size: statSync(file).size, sha256: sha256(file) };
};
const evidenceSet = (root, names) => ({
  root: rel(root),
  files: Object.fromEntries(names.map((name) => [name.replace(/\.[^.]+$/, ''), evidenceFile(root, name)])),
});
const cleanupProof = (cleanup) => {
  const checks = {
    containerAbsent: { proven: cleanup.containerAbsent === true, basis: 'cleanup-verification.containerAbsent' },
    relayClosed: cleanup.relayCleanupProven === undefined
      ? { proven: true, basis: 'relay-not-started-or-not-applicable-to-this-row' }
      : { proven: cleanup.relayCleanupProven === true, basis: 'cleanup-verification.relayCleanupProven' },
    secretRemoved: cleanup.secretDirectoryRemoved === undefined
      ? { proven: true, basis: 'probe-only-row-never-created-a-secret' }
      : { proven: cleanup.secretDirectoryRemoved === true, basis: 'cleanup-verification.secretDirectoryRemoved' },
    probeTemporaryStateRemoved: cleanup.probeTemporaryStateRemoved === undefined
      ? {
          proven: cleanup.containerAbsent === true,
          basis: 'legacy-row-probe-was-container-scoped; verified container removal deleted its writable layer',
        }
      : { proven: cleanup.probeTemporaryStateRemoved === true, basis: 'cleanup-verification.probeTemporaryStateRemoved' },
    installerTemporaryStateRemoved: cleanup.containerInstallerRemoved === undefined
      ? {
          proven: cleanup.containerAbsent === true,
          basis: 'legacy-row-installer-state-was container-scoped; verified container removal deleted its writable layer',
        }
      : { proven: cleanup.containerInstallerRemoved === true, basis: 'cleanup-verification.containerInstallerRemoved' },
  };
  return {
    proven: Object.values(checks).every((check) => check.proven === true),
    checks,
    details: cleanup,
  };
};

function processWinSta0Row() {
  const root = path.join(evidenceRoot, '20260807T075339152Z-d5880932bd');
  const failure = readJson(root, 'failure-receipt.json');
  const ready = readJson(root, 'bootstrap-ready.json');
  const cleanup = readJson(root, 'cleanup-verification.json');
  return {
    variantId: 'process-winsta0-standard-gdi',
    evidenceId: failure.environment.runId,
    imageReference: IMAGE,
    imageId: failure.environment.image.id,
    isolation: 'process',
    desktopTarget: 'WinSta0',
    deviceAssignment: 'none',
    session: { id: ready.bootstrap.sessionId, windowStation: 'WinSta0', desktop: 'Default' },
    display: {
      monitorRectangles: [],
      attachedDisplayDevices: { status: 'not-collected', devices: [] },
      activePathCount: null,
      activeModeCount: null,
      usableDisplay: false,
      evidence: 'TightVNC log: The console desktop has 0 displays',
    },
    processWindow: {
      created: true,
      visible: ready.desktopProbe.visible,
      bounds: ready.desktopProbe.window.bounds,
    },
    localComposition: { attempted: false, available: false, result: 'not-tested' },
    rfb: {
      attempted: true,
      transportProven: failure.relay.stats.downstreamToUpstreamBytes > 0
        && failure.relay.stats.upstreamToDownstreamBytes > 0,
      protocolProven: failure.rfb.securityType === 2,
      usableFramebuffer: false,
      result: 'uniform-black',
      width: failure.rfb.width,
      height: failure.rfb.height,
      updateCount: failure.rfb.updateCount,
      securityTypeName: failure.rfb.securityTypeName,
      blackFraction: failure.initialAnalysis.blackFraction,
    },
    labviewVisualBenchmark: 'not-attempted-display-precondition',
    cleanup: cleanupProof(cleanup),
    status: 'tested',
    reason: 'WinSta0 produced authenticated RFB traffic but TightVNC enumerated zero displays and intentionally returned a blank framebuffer.',
    evidence: evidenceSet(root, [
      'manifest.json',
      'failure-receipt.json',
      'bootstrap-ready.json',
      'network-relay.json',
      'network-preflight.json',
      'tvnserver.log',
      'cleanup-verification.json',
    ]),
  };
}

function processInheritedRow(runId, variantId, deviceAssignment) {
  const root = path.join(evidenceRoot, runId);
  const failure = readJson(root, 'failure-receipt.json');
  const display = readJson(root, 'display-diagnostics.json');
  const cleanup = readJson(root, 'cleanup-verification.json');
  const bootstrap = readJson(root, 'bootstrap-failure.json');
  const probeWindow = (bootstrap.windows ?? []).find((window) => window.title === 'LBA-VNC-DESKTOP-PROBE') ?? null;
  return {
    variantId,
    evidenceId: failure.runId,
    imageReference: IMAGE,
    imageId: failure.image.resolvedId,
    isolation: 'process',
    desktopTarget: 'Inherited',
    deviceAssignment,
    session: {
      id: display.sessionId,
      windowStation: display.api.context.windowStation,
      desktop: display.api.context.desktop,
    },
    display: {
      smCmonitors: display.api.smCmonitors,
      primary: { width: display.api.primaryWidth, height: display.api.primaryHeight },
      monitorRectangles: display.api.monitorRectangles,
      attachedDisplayDevices: {
        status: 'collected',
        devices: display.api.displayDevices.filter((device) => device.attachedToDesktop),
      },
      activePathCount: display.api.activePathCount,
      activeModeCount: display.api.activeModeCount,
      queryDisplayConfigResult: display.api.queryDisplayConfigResult,
      usableDisplay: false,
    },
    processWindow: {
      created: Boolean(probeWindow ?? display.desktopProbe?.processId),
      visible: probeWindow?.visible ?? display.desktopProbe?.visible ?? false,
      bounds: probeWindow?.bounds ?? display.desktopProbe?.window?.bounds ?? null,
    },
    localComposition: {
      attempted: Boolean(display.localGdi),
      available: display.localGdi?.analysis?.passed === true,
      result: display.localGdi?.analysis?.reason ?? 'not-tested',
      error: display.localGdi?.error ?? null,
    },
    rfb: {
      attempted: false,
      transportProven: false,
      protocolProven: false,
      usableFramebuffer: false,
      result: 'not-attempted',
    },
    labviewVisualBenchmark: 'not-attempted-display-precondition',
    cleanup: cleanupProof(cleanup),
    status: 'tested',
    reason: deviceAssignment === 'none'
      ? 'Inherited service station had nominal compatibility metrics but zero monitor rectangles/active paths; probe was not visible and BitBlt was access denied.'
      : 'DirectX GPU device assignment did not create monitor rectangles, attached display devices, active paths, or a usable composition surface.',
    evidence: evidenceSet(root, [
      'manifest.json',
      'failure-receipt.json',
      'display-diagnostics.json',
      'bootstrap-failure.json',
      'container-inspect.json',
      'cleanup-verification.json',
    ]),
  };
}

function hypervRow(hypervRoot) {
  const environment = readJson(hypervRoot, 'probe-environment.json');
  const probe = readJson(hypervRoot, 'display-probe.json');
  const display = readJson(hypervRoot, 'display-diagnostics.json');
  const cleanup = readJson(hypervRoot, 'cleanup-verification.json');
  return {
    variantId: 'hyperv-inherited-no-device',
    evidenceId: environment.runId,
    imageReference: IMAGE,
    imageId: environment.image.id,
    isolation: 'hyperv',
    desktopTarget: 'Inherited',
    deviceAssignment: environment.deviceAssignment,
    session: {
      id: display.sessionId,
      windowStation: display.api.context.windowStation,
      desktop: display.api.context.desktop,
    },
    display: {
      smCmonitors: display.api.smCmonitors,
      primary: { width: display.api.primaryWidth, height: display.api.primaryHeight },
      monitorRectangles: display.api.monitorRectangles,
      attachedDisplayDevices: {
        status: 'collected',
        devices: display.api.displayDevices.filter((device) => device.attachedToDesktop),
      },
      activePathCount: display.api.activePathCount,
      activeModeCount: display.api.activeModeCount,
      queryDisplayConfigResult: display.api.queryDisplayConfigResult,
      videoControllerCount: display.videoControllers.length,
      usableDisplay: false,
    },
    processWindow: {
      created: Boolean(display.desktopProbe?.processId),
      visible: display.desktopProbe?.visible ?? false,
      bounds: display.desktopProbe?.window?.bounds ?? null,
    },
    localComposition: {
      attempted: Boolean(display.localGdi),
      available: display.localGdi?.analysis?.passed === true,
      result: display.localGdi?.analysis?.reason ?? 'not-tested',
      error: display.localGdi?.error ?? null,
    },
    rfb: {
      attempted: false,
      transportProven: false,
      protocolProven: false,
      usableFramebuffer: false,
      result: 'not-attempted',
    },
    labviewVisualBenchmark: 'not-attempted-display-precondition',
    cleanup: cleanupProof(cleanup),
    status: 'tested',
    reason: `Hyper-V isolation produced zero monitor rectangles/devices/active paths and no usable local composition surface (${probe.classification}).`,
    evidence: evidenceSet(hypervRoot, [
      'manifest.json',
      'probe-environment.json',
      'display-probe.json',
      'display-diagnostics.json',
      'container-inspect.json',
      'cleanup-verification.json',
    ]),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`invalid argument '${argv[i] ?? ''}'`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args['hyperv-run'] || !args.output) {
  console.error('Usage: node build-feasibility-receipt.mjs --hyperv-run <evidence-dir> --output <receipt.json>');
  process.exitCode = 2;
} else {
  const officialSources = [
    {
      url: 'https://learn.microsoft.com/en-us/virtualization/windowscontainers/quick-start/lift-shift-to-containers',
      publisher: 'Microsoft',
      claims: ['interactive-gui-unsupported', 'desktop-applications-unsupported', 'rdp-interactive-session-unsupported'],
    },
    {
      url: 'https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/hardware-devices-in-containers',
      publisher: 'Microsoft',
      claims: ['device-list-limited', 'unsupported-guids-undefined', 'hyperv-device-sharing-unsupported'],
    },
    {
      url: 'https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/gpu-acceleration',
      publisher: 'Microsoft',
      claims: ['directx-only', 'hyperv-gpu-unsupported', 'gpu-does-not-assert-interactive-display'],
    },
    {
      url: 'https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview',
      publisher: 'Microsoft',
      claims: ['idd-is-host-session-zero-driver', 'no-container-display-sharing-claim'],
    },
    {
      url: 'https://github.com/microsoft/Windows-driver-samples/tree/main/video/IndirectDisplay',
      publisher: 'Microsoft',
      claims: ['sample-is-simplistic', 'production-critical-todos', 'inf-requires-customization'],
    },
  ];
  const rows = [
    processWinSta0Row(),
    processInheritedRow('20260807T085910357Z-5b3fd61a35', 'process-inherited-no-device', 'none'),
    processInheritedRow('20260807T084403463Z-8bb9b4643f', 'process-inherited-directx-gpu', 'directx-gpu-class'),
    hypervRow(path.resolve(args['hyperv-run'])),
  ];
  const receipt = buildFeasibilityReceipt({ rows, officialSources, generatedWallTime: new Date().toISOString() });
  const output = path.resolve(args.output);
  mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temp, output);
  console.log(`feasibility receipt -> ${output}`);
}
