#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodePng, encodePng } from '../manual-procedure-record/capture-adapter.mjs';
import { createStreamingFramebuffer, sampleDescriptor } from '../mprr-capture-ring/vnc-source.mjs';
import {
  analyzePixels,
  buildDockerExecArgs,
  buildExperimentRecords,
  classifyDisplayProof,
  classifyRfbStartFailure,
  matchDesktopProbe,
  parseDockerStats,
  proveLabviewVisibility,
  selectContainerNetworkTarget,
  selectRepresentativeFrames,
  summarizeFingerprints,
  validateLoopbackListenerBindings,
  validateChildDesktopMatch,
  validateMonotonicFrames,
  withTimeout,
} from './experiment-core.mjs';
import { createLoopbackTcpRelay } from './tcp-relay.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message, details) => {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  console.log(`${new Date().toISOString()} [host-capture] ${message}${suffix}`);
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function parseJsonLine(stdout, label) {
  const line = stdout.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1);
  if (!line) throw new Error(`${label} returned no JSON`);
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function startGovernedSampler({ fps, tick, nowMs }) {
  const periodMs = 1000 / fps;
  const startMs = nowMs();
  let active = true;
  let ordinal = 0;
  const done = (async () => {
    tick(startMs, 0);
    while (active) {
      ordinal += 1;
      const targetMs = startMs + ordinal * periodMs;
      await sleep(Math.max(0, targetMs - nowMs()));
      if (!active) break;
      const actualMs = nowMs();
      tick(actualMs, actualMs - targetMs);
    }
  })();
  return {
    startMs,
    stop: async () => { active = false; await done; },
  };
}

async function dockerJson(args, timeout = 15_000) {
  const { stdout } = await execFileAsync('docker', args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  return parseJsonLine(stdout, `docker ${args[0]}`);
}

async function dockerInspect(containerId) {
  const { stdout } = await execFileAsync('docker', ['container', 'inspect', containerId], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('docker inspect did not return exactly one container');
  return parsed[0];
}

async function hostListenerBindings(port) {
  const script = `$items=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess); ConvertTo-Json -InputObject $items -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], { timeout: 10_000, windowsHide: true });
  const parsed = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map((binding) => ({
    localAddress: binding.LocalAddress,
    localPort: Number(binding.LocalPort),
    owningProcess: Number(binding.OwningProcess),
  }));
}

async function sampleResources(containerId, ms, wallTime) {
  const [dockerRaw, container] = await Promise.all([
    dockerJson(['stats', '--no-stream', '--format', '{{json .}}', containerId]),
    dockerJson(buildDockerExecArgs(containerId, 'ResourceSample')),
  ]);
  const docker = parseDockerStats(dockerRaw);
  return {
    ms,
    wallTime,
    cpuPct: docker.cpuPct,
    ramMb: docker.ramMb,
    diskPct: null,
    counters: {
      dockerBlockReadMb: docker.blockReadMb,
      dockerBlockWriteMb: docker.blockWriteMb,
      containerAvailableMemoryMb: container.os?.availableMemoryMb ?? null,
      containerCommittedMemoryMb: container.os?.committedMemoryMb ?? null,
      labviewCpuSeconds: container.labview?.cpuSeconds ?? null,
      labviewWorkingSetMb: container.labview?.workingSetMb ?? null,
      labviewPrivateMemoryMb: container.labview?.privateMemoryMb ?? null,
      labviewReadMb: container.labview?.readMb ?? null,
      labviewWriteMb: container.labview?.writeMb ?? null,
      containerSystemDriveFreeMb: container.disk?.freeMb ?? null,
    },
    sources: {
      hostObserved: 'docker stats --no-stream',
      containerObserved: 'Win32_Process, Win32_OperatingSystem, Win32_LogicalDisk',
      sampleClock: 'host process.hrtime.bigint',
      containerWallTime: container.wallTime,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceDir = path.resolve(args['evidence-dir'] ?? '');
  const environmentFile = path.resolve(args['environment-json'] ?? '');
  const networkPreflightFile = path.resolve(args['network-preflight-json'] ?? '');
  const bootstrapReadyFile = path.resolve(args['bootstrap-ready-json'] ?? '');
  const passwordFile = path.resolve(args['password-file'] ?? '');
  const containerId = args['container-id'];
  const fps = Number(args.fps ?? 12);
  const durationMs = Number(args['duration-ms'] ?? 60_000);
  const readinessTimeoutMs = Number(args['rfb-timeout-ms'] ?? 30_000);
  const settleOptions = {
    window: Number(args['settle-window'] ?? 8),
    toleranceHamming: Number(args['settle-tolerance'] ?? 2),
  };
  const launchWindowTimeoutSeconds = Number(args['launch-window-timeout-seconds'] ?? 45);
  const launchAliveSeconds = Number(args['launch-alive-seconds'] ?? 10);
  const capacityBytes = Number(args['long-capacity-bytes'] ?? 64 * 1024 * 1024);
  if (!evidenceDir || !environmentFile || !networkPreflightFile || !bootstrapReadyFile || !passwordFile || !containerId) {
    throw new Error('capture requires evidence-dir, environment-json, network-preflight-json, bootstrap-ready-json, password-file, and container-id');
  }
  if (!(fps > 0) || !(durationMs > 0) || !(readinessTimeoutMs > 0)) throw new Error('capture cadence and timeouts must be positive');

  mkdirSync(evidenceDir, { recursive: true });
  const frameDir = path.join(evidenceDir, 'frames');
  const cacheDir = path.join(evidenceDir, '.frame-cache');
  mkdirSync(frameDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  const environment = JSON.parse(readFileSync(environmentFile, 'utf8'));
  const networkPreflight = JSON.parse(readFileSync(networkPreflightFile, 'utf8'));
  const bootstrapReady = JSON.parse(readFileSync(bootstrapReadyFile, 'utf8'));
  const transportOnly = environment.container?.transportOnly === true;
  if (networkPreflight.status !== 'passed' || networkPreflight.containerId !== containerId) {
    throw new Error('capture requires a passing, current network preflight record');
  }
  if (bootstrapReady.status !== 'ready' || bootstrapReady.bootstrap?.desktopContext?.mode !== environment.container?.desktopTarget) {
    throw new Error('capture requires matching bootstrap desktop-target evidence');
  }
  if (bootstrapReady.transportOnly !== transportOnly) {
    throw new Error('capture transport-only mode disagrees with bootstrap evidence');
  }
  if (transportOnly && environment.container.desktopTarget !== 'WinSta0') {
    throw new Error('capture transport-only mode is restricted to the explicit WinSta0 baseline');
  }
  const password = readFileSync(passwordFile, 'utf8').trim();
  if (!password) throw new Error('VNC password file is empty');
  log('capture initialized', {
    runId: environment.runId,
    containerId,
    transportOnly,
    desktopTarget: environment.container.desktopTarget,
    fps,
    readinessTimeoutMs,
  });

  const processOrigin = process.hrtime.bigint();
  const nowMs = () => Number(process.hrtime.bigint() - processOrigin) / 1e6;
  const captureWallStart = new Date().toISOString();
  const frames = [];
  const resourceSamples = [];
  const resourceErrors = [];
  let stream;
  let relay;
  let relayRecord = {
    schema: 'labview-benchmark-actor/windows-docker-loopback-relay@1',
    status: 'not-started',
    processId: process.pid,
    containerId,
    network: networkPreflight.target,
    directProbe: networkPreflight.directProbe,
    dockerPublishedPorts: networkPreflight.dockerPublishedPorts,
    dockerPortOutput: networkPreflight.dockerPortOutput,
    bound: null,
    upstream: null,
    listenerBindings: [],
    stats: null,
    cleanup: { closed: false, listenerBindingsAfterClose: null },
  };
  let relayCleanupCompleted = false;
  let sampler;
  let resourceActive = false;
  let resourceLoop;
  let workloadStartMs = null;
  let workloadStartWall = null;
  let connectionInfo = null;
  let classification = 'no-rfb-connection';
  let failedGate = 3;
  let framePhaseErrorMaxMs = 0;
  let probeMatch = null;
  let probeStop = null;
  const display = bootstrapReady.display;
  let localGdiDecoded = null;
  let localGdiAnalysis = null;
  const relayEvidencePath = path.join(evidenceDir, 'network-relay.json');
  const writeRelayEvidence = () => atomicJson(relayEvidencePath, relayRecord);
  writeRelayEvidence();

  const closeRelay = async () => {
    if (!relay || relayCleanupCompleted) return;
    try {
      const cleanup = await relay.close({ timeoutMs: 5000 });
      const listenerBindingsAfterClose = relayRecord.bound
        ? await hostListenerBindings(relayRecord.bound.port)
        : [];
      if (listenerBindingsAfterClose.length !== 0) {
        throw new Error(`relay TCP listener remained after close: ${JSON.stringify(listenerBindingsAfterClose)}`);
      }
      relayRecord = {
        ...relayRecord,
        stats: relay.stats(),
        cleanup: { ...cleanup, listenerBindingsAfterClose, closedWallTime: new Date().toISOString() },
      };
      relayCleanupCompleted = true;
      writeRelayEvidence();
      log('loopback relay closed', {
        bound: relayRecord.bound,
        bytes: relayRecord.stats?.totalBytes,
        listenerBindingsAfterClose,
      });
    } catch (error) {
      relayRecord = {
        ...relayRecord,
        status: 'cleanup-failed',
        stats: relay.stats(),
        cleanup: { closed: false, error: error.message, wallTime: new Date().toISOString() },
      };
      writeRelayEvidence();
      throw error;
    }
  };

  const writeFailure = (error, extra = {}) => {
    const recommendations = {
      'no-rfb-connection': 'Verify TightVNC application-mode liveness and the loopback-only host endpoint.',
      'rfb-no-framebuffer-update': 'Test whether the session-0 WinSta0 desktop produces framebuffer updates.',
      'rfb-authentication-not-negotiated': 'Correct TightVNC application-mode authentication configuration before retrying.',
      'black-or-uniform-framebuffer': 'Test an explicitly interactive container desktop; do not substitute host-desktop capture.',
      'tightvnc-desktop-labview-absent': 'Inspect activation, first-run prompts, and the process-matched window-station diagnostics.',
      'labview-visible-changing': 'Increase capture duration without weakening the existing settle tolerance.',
      'container-network-target-changed': 'Inspect the live container network attachment; never proxy to stale evidence.',
      'relay-bind-failure': 'Inspect the process-local IPv4 loopback bind failure; do not use a non-loopback fallback.',
      'relay-upstream-failure': 'Re-check the current container IP and private-network reachability.',
      'rfb-handshake-failure': 'Inspect TightVNC authentication and RFB negotiation without changing relay bytes.',
      'desktop-has-zero-displays': 'Use the inherited display-bearing station or inspect the selected display context.',
      'desktop-screen-dc-unavailable': 'Inspect the selected station desktop and Win32 screen-DC diagnostics.',
      'desktop-local-gdi-capture-black': 'The selected desktop has no usable local GDI composition surface.',
      'rfb-black-despite-local-gdi': 'Local GDI works; test the next bounded TightVNC capture mode on the same inherited desktop.',
      'rfb-probe-mismatch': 'Inspect TightVNC capture configuration; unrelated non-black pixels cannot satisfy the probe gate.',
    };
    const receipt = {
      schema: 'labview-benchmark-actor/windows-docker-tightvnc-failure@1',
      outcome: 'inconclusive',
      failedGate,
      classification,
      error: error instanceof Error ? error.message : String(error),
      wallTime: new Date().toISOString(),
      environment,
      rfb: connectionInfo ? { ...connectionInfo, updateCount: stream?.updateCount() ?? 0 } : null,
      network: networkPreflight,
      relay: { ...relayRecord, stats: relay?.stats() ?? relayRecord.stats },
      display,
      probeMatch,
      probeStop,
      frameCount: frames.length,
      resourceSampleCount: resourceSamples.length,
      resourceErrors,
      recommendedNextHypothesis: recommendations[classification] ?? 'Inspect the preserved proof-gate diagnostics.',
      clockSources: {
        capture: 'host process.hrtime.bigint',
        wall: 'host Date.toISOString',
      },
      ...extra,
    };
    atomicJson(path.join(evidenceDir, 'failure-receipt.json'), receipt);
    atomicJson(path.join(evidenceDir, 'capture-summary.json'), receipt);
  };

  try {
    try {
      if (!display?.api?.getDcSucceeded) {
        classification = 'desktop-screen-dc-unavailable';
        throw new Error(`selected desktop screen DC is unavailable (Win32 ${display?.api?.getDcError ?? 'unknown'})`);
      }
      if (!Array.isArray(display.api.monitorRectangles) || display.api.monitorRectangles.length === 0) {
        if (transportOnly && display.localGdi?.analysis?.passed === false) {
          localGdiAnalysis = display.localGdi.analysis;
          classification = 'desktop-has-zero-displays';
          // This is the explicit transport baseline: retain the failed display
          // evidence and continue only far enough to exercise authenticated RFB.
          log('retaining failed display precondition for transport-only probe', {
            qualifiedDesktop: display.api.context?.qualifiedDesktop,
            monitorCount: 0,
            localGdiReason: localGdiAnalysis?.reason,
          });
        } else {
          classification = 'desktop-has-zero-displays';
          throw new Error('selected desktop has zero EnumDisplayMonitors rectangles');
        }
      } else if (transportOnly) {
        classification = 'transport-only-display-precondition-changed';
        throw new Error('transport-only WinSta0 baseline unexpectedly has a display');
      }
      if (!transportOnly) {
        const localGdiPath = path.join(evidenceDir, display.localGdi?.path ?? '');
        localGdiDecoded = decodePng(readFileSync(localGdiPath));
        localGdiAnalysis = analyzePixels(localGdiDecoded.rgba, localGdiDecoded.width, localGdiDecoded.height);
        if (
          localGdiDecoded.width !== display.localGdi.analysis.width
          || localGdiDecoded.height !== display.localGdi.analysis.height
        ) throw new Error('local GDI PNG dimensions disagree with container diagnostics');
        if (!localGdiAnalysis.passed || display.localGdi.analysis.passed !== true) {
          classification = 'desktop-local-gdi-capture-black';
          throw new Error(`local GDI capture failed pixel proof: ${localGdiAnalysis.reason ?? display.localGdi.analysis.reason}`);
        }
      }
    } catch (error) {
      failedGate = 3;
      writeFailure(error, { localGdiAnalysis });
      return 3;
    }

    let selectedNetwork;
    try {
      const liveInspection = await dockerInspect(containerId);
      selectedNetwork = selectContainerNetworkTarget(liveInspection, {
        expectedContainerId: containerId,
        expectedTarget: networkPreflight.target,
      });
      log('live container network target verified', selectedNetwork.target);
    } catch (error) {
      classification = 'container-network-target-changed';
      failedGate = 2;
      writeFailure(error);
      return 2;
    }
    relayRecord = { ...relayRecord, status: 'binding', network: selectedNetwork.target };
    writeRelayEvidence();
    try {
      relay = createLoopbackTcpRelay({
        upstreamHost: selectedNetwork.target.ipAddress,
        upstreamPort: 5900,
      });
      const bound = await withTimeout(relay.ready, 10_000, 'loopback relay bind timed out after 10000 ms');
      const listenerBindings = await hostListenerBindings(bound.port);
      validateLoopbackListenerBindings(listenerBindings, { port: bound.port, processId: process.pid });
      relayRecord = {
        ...relayRecord,
        status: 'ready',
        readyWallTime: new Date().toISOString(),
        bound,
        upstream: relay.upstream(),
        listenerBindings,
        stats: relay.stats(),
      };
      writeRelayEvidence();
      log('loopback relay ready', {
        bound,
        upstream: relayRecord.upstream,
        listenerBindings,
      });
    } catch (error) {
      classification = 'relay-bind-failure';
      failedGate = 2;
      writeFailure(error);
      return 2;
    }

    stream = createStreamingFramebuffer({
      host: relayRecord.bound.address,
      port: relayRecord.bound.port,
      password,
      connect: ({ host: connectHost, port: connectPort }) => net.connect({ host: connectHost, port: connectPort }),
    });
    try {
      connectionInfo = await withTimeout(
        stream.ready,
        readinessTimeoutMs,
        `RFB full framebuffer update timed out after ${readinessTimeoutMs} ms`,
      );
      log('RFB framebuffer ready', connectionInfo);
    } catch (error) {
      const relayStats = relay.stats();
      ({ classification, failedGate } = classifyRfbStartFailure(error, relayStats));
      writeFailure(error);
      return failedGate;
    }
    const relayStats = relay.stats();
    if (
      relayStats.acceptedConnections < 1
      || relayStats.successfulUpstreamConnections < 1
      || relayStats.downstreamToUpstreamBytes < 1
      || relayStats.upstreamToDownstreamBytes < 1
    ) {
      classification = 'relay-upstream-failure';
      failedGate = 2;
      writeFailure(new Error(`relay did not prove bidirectional RFB traffic: ${JSON.stringify(relayStats)}`));
      return 2;
    }
    relayRecord = {
      ...relayRecord,
      status: 'rfb-traversed',
      rfbTraversedWallTime: new Date().toISOString(),
      stats: relayStats,
    };
    writeRelayEvidence();
    log('bidirectional RFB traffic proven', relayStats);
    if (connectionInfo.securityType !== 2) {
      classification = 'rfb-authentication-not-negotiated';
      failedGate = 3;
      writeFailure(new Error(`RFB negotiated security type ${connectionInfo.securityType}, expected VNC Authentication (2)`));
      return 3;
    }
    classification = 'rfb-framebuffer-received';

    let previousDhash = null;
    let previousCacheFile = null;
    let previousCacheFrameIndex = null;
    let lastLoggedSecond = -1;
    sampler = startGovernedSampler({
      fps,
      nowMs,
      tick: (ms, phaseErrorMs) => {
        const current = stream.current();
        if (!current) return;
        const { width, height } = stream.dims();
        if (current.length !== width * height * 4) {
          throw new Error(`live RFB buffer length ${current.length} disagrees with ${width}x${height}`);
        }
        framePhaseErrorMaxMs = Math.max(framePhaseErrorMaxMs, Math.abs(phaseErrorMs));
        const snapshot = Uint8Array.from(current);
        const desc = sampleDescriptor(snapshot, width, height, {
          frameIndex: frames.length,
          t0Ms: 0,
          nowMs: ms,
        });
        let cacheFile = previousCacheFile;
        let cacheFrameIndex = previousCacheFrameIndex;
        if (desc.dhash64 !== previousDhash) {
          cacheFile = path.join(cacheDir, `frame-${String(frames.length).padStart(6, '0')}.png`);
          writeFileSync(cacheFile, encodePng(snapshot, width, height));
          cacheFrameIndex = frames.length;
        }
        frames.push({
          index: frames.length,
          ms,
          wallTime: new Date().toISOString(),
          timingTicks64: desc.timingTicks64.toString(),
          dhashHex: desc.dhash64,
          rfbUpdateCount: stream.updateCount(),
          phaseErrorMs,
          width,
          height,
          cacheFile,
          cacheFrameIndex,
        });
        const elapsedSecond = Math.floor(ms / 1000);
        if (frames.length === 1 || elapsedSecond > lastLoggedSecond || desc.dhash64 !== previousDhash) {
          lastLoggedSecond = elapsedSecond;
          log('RFB frame acquired from container endpoint', {
            frameIndex: frames.length - 1,
            width,
            height,
            rgbaBytes: snapshot.length,
            dhashHex: desc.dhash64,
            rfbUpdateCount: stream.updateCount(),
            phaseErrorMs,
          });
        }
        previousDhash = desc.dhash64;
        previousCacheFile = cacheFile;
        previousCacheFrameIndex = cacheFrameIndex;
      },
    });

    resourceActive = true;
    resourceLoop = (async () => {
      while (resourceActive) {
        const started = nowMs();
        try {
          resourceSamples.push(await sampleResources(containerId, started, new Date().toISOString()));
        } catch (error) {
          resourceErrors.push({ ms: started, wallTime: new Date().toISOString(), error: error.message });
        }
        await sleep(Math.max(0, 1000 - (nowMs() - started)));
      }
    })();

    const baselineDeadline = nowMs() + 10_000;
    const minimumBaselineFrames = Math.max(3, Math.ceil(fps));
    while ((frames.length < minimumBaselineFrames || resourceSamples.length < 1) && nowMs() < baselineDeadline) await sleep(25);
    if (frames.length < minimumBaselineFrames) throw new Error('capture did not produce the required pre-launch baseline frames');
    log('pre-launch acquisition baseline complete', {
      framePolls: frames.length,
      rfbUpdates: stream.updateCount(),
      resourceSamples: resourceSamples.length,
    });

    const initialDecoded = decodePng(readFileSync(frames[0].cacheFile));
    const initialAnalysis = analyzePixels(initialDecoded.rgba, initialDecoded.width, initialDecoded.height);
    if (transportOnly) {
      const relativeImagePath = 'frames/transport-baseline-rfb.png';
      const retainedImagePath = path.join(evidenceDir, relativeImagePath);
      copyFileSync(frames[0].cacheFile, retainedImagePath);
      const retainedPng = readFileSync(retainedImagePath);
      const retainedDecoded = decodePng(retainedPng);
      const retainedAnalysis = analyzePixels(retainedDecoded.rgba, retainedDecoded.width, retainedDecoded.height);
      const imageAcquisition = {
        schema: 'labview-benchmark-actor/windows-container-rfb-image@1',
        status: retainedAnalysis.passed ? 'acquired-nonuniform-but-not-interpreted' : 'acquired-but-unusable',
        usable: false,
        visualClaim: false,
        source: 'run-owned-container-tightvnc-rfb',
        sourceContainerId: containerId,
        upstreamEndpoint: {
          host: selectedNetwork.target.ipAddress,
          port: 5900,
          networkName: selectedNetwork.target.networkName,
        },
        hostRelayEndpoint: relayRecord.bound,
        rfb: {
          version: connectionInfo.rfbVersion,
          securityType: connectionInfo.securityType,
          width: retainedDecoded.width,
          height: retainedDecoded.height,
          updateCountAtSample: frames[0].rfbUpdateCount,
        },
        frameIndex: frames[0].index,
        framePollCount: frames.length,
        monotonicMs: frames[0].ms,
        wallTime: frames[0].wallTime,
        dhashHex: frames[0].dhashHex,
        path: relativeImagePath,
        size: statSync(retainedImagePath).size,
        pngSha256: sha256(retainedImagePath),
        rgbaSha256: createHash('sha256').update(retainedDecoded.rgba).digest('hex'),
        analysis: retainedAnalysis,
      };
      log('retained container RFB image evidence', {
        path: imageAcquisition.path,
        size: imageAcquisition.size,
        pngSha256: imageAcquisition.pngSha256,
        dimensions: `${retainedDecoded.width}x${retainedDecoded.height}`,
        blackFraction: retainedAnalysis.blackFraction,
        usable: imageAcquisition.usable,
      });
      classification = initialAnalysis.passed
        ? 'transport-only-nonuniform-framebuffer'
        : 'black-or-uniform-framebuffer';
      failedGate = 3;
      writeFailure(new Error(
        initialAnalysis.passed
          ? 'transport-only mode received a non-uniform framebuffer; visual interpretation and LabVIEW launch are forbidden'
          : `initial framebuffer failed pixel proof: ${initialAnalysis.reason}`,
      ), {
        initialAnalysis,
        localGdiAnalysis,
        imageAcquisition,
        transportOnly: true,
        labviewLaunchTriggered: false,
      });
      log('transport-only boundary reached; LabVIEW launch suppressed', {
        classification,
        labviewLaunchTriggered: false,
        imageStatus: imageAcquisition.status,
      });
      return 3;
    }
    if (initialDecoded.width === localGdiDecoded.width && initialDecoded.height === localGdiDecoded.height) {
      probeMatch = matchDesktopProbe({
        localRgba: localGdiDecoded.rgba,
        rfbRgba: initialDecoded.rgba,
        width: initialDecoded.width,
        height: initialDecoded.height,
        bounds: bootstrapReady.desktopProbe.window.bounds,
        virtualOrigin: { x: display.api.virtualLeft, y: display.api.virtualTop },
      });
    }
    const displayProof = classifyDisplayProof({
      display,
      localGdi: { analysis: localGdiAnalysis },
      rfbAnalysis: initialAnalysis,
      probeMatch,
    });
    classification = displayProof.classification;
    if (!displayProof.passed) {
      failedGate = 3;
      writeFailure(new Error(
        classification === 'rfb-black-despite-local-gdi'
          ? `RFB framebuffer failed while local GDI passed: ${initialAnalysis.reason}`
          : probeMatch?.reason ?? `display proof failed: ${classification}`,
      ), { initialAnalysis, localGdiAnalysis, probeMatch });
      return 3;
    }
    classification = 'rfb-probe-visible';

    probeStop = await dockerJson(buildDockerExecArgs(containerId, 'StopProbe'));
    if (probeStop.stopped !== true || probeStop.executableRemoved !== true) {
      throw new Error('desktop probe cleanup did not complete before the LabVIEW launch');
    }
    const postProbeStartCount = frames.length;
    const postProbeDeadline = nowMs() + 10_000;
    while (
      (frames.length < postProbeStartCount + Math.max(3, Math.ceil(fps))
        || frames.at(-1)?.dhashHex === frames[0].dhashHex)
      && nowMs() < postProbeDeadline
    ) await sleep(25);
    if (frames.at(-1)?.dhashHex === frames[0].dhashHex) {
      throw new Error('desktop probe removal produced no framebuffer transition');
    }

    workloadStartMs = nowMs();
    workloadStartWall = new Date().toISOString();
    atomicJson(path.join(evidenceDir, 'launch-trigger.json'), {
      hostMonotonicMs: workloadStartMs,
      wallTime: workloadStartWall,
      clock: 'host process.hrtime.bigint',
    });
    const launchArgs = buildDockerExecArgs(containerId, 'LaunchLabVIEW', [
      '-OutputPath',
      'C:\\evidence\\launch-diagnostics.json',
      '-WindowTimeoutSeconds',
      String(launchWindowTimeoutSeconds),
      '-AliveHoldSeconds',
      String(launchAliveSeconds),
      '-DesktopTarget',
      environment.container.desktopTarget,
    ]);
    let launchSettled = false;
    const launchPromise = execFileAsync('docker', launchArgs, {
      timeout: Math.max(durationMs + 30_000, (launchWindowTimeoutSeconds + launchAliveSeconds + 30) * 1000),
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }).then(() => null).catch((error) => error).finally(() => { launchSettled = true; });

    const captureEnd = workloadStartMs + durationMs;
    while (nowMs() < captureEnd || !launchSettled) await sleep(100);
    const launchError = await launchPromise;
    await sampler.stop();
    sampler = null;
    resourceActive = false;
    await resourceLoop;
    resourceLoop = null;
    stream.close();
    await closeRelay();

    validateMonotonicFrames(frames);
    if (frames.some((frame) => frame.width !== frames[0].width || frame.height !== frames[0].height)) {
      throw new Error('RFB dimensions changed during the governed capture; mixed-size evidence is rejected');
    }
    connectionInfo = { ...stream.info(), updateCount: stream.updateCount() };
    const launchDiagnosticsPath = path.join(evidenceDir, 'launch-diagnostics.json');
    let launchDiagnostics = null;
    try {
      launchDiagnostics = JSON.parse(readFileSync(launchDiagnosticsPath, 'utf8'));
    } catch (error) {
      classification = 'tightvnc-desktop-labview-absent';
      failedGate = 4;
      writeFailure(launchError ?? new Error(`LabVIEW diagnostics unavailable: ${error.message}`));
      return 4;
    }
    if (launchError || launchDiagnostics.status !== 'ready') {
      classification = 'tightvnc-desktop-labview-absent';
      failedGate = 4;
      writeFailure(launchError ?? new Error(launchDiagnostics.error ?? 'LabVIEW did not become ready'), { launchDiagnostics });
      return 4;
    }
    try {
      validateChildDesktopMatch({
        bootstrapContext: bootstrapReady.bootstrap.desktopContext,
        childContext: launchDiagnostics.launcher.desktopContext,
        parentSessionId: bootstrapReady.bootstrap.sessionId,
        childSessionId: launchDiagnostics.labviewSessionId,
        window: launchDiagnostics.expectedWindow,
        childProcessId: launchDiagnostics.labviewPid,
      });
    } catch (error) {
      classification = 'tightvnc-desktop-labview-absent';
      failedGate = 4;
      writeFailure(error, { launchDiagnostics });
      return 4;
    }

    let selected;
    try {
      selected = selectRepresentativeFrames(frames, workloadStartMs, settleOptions);
    } catch (error) {
      classification = /settle/i.test(error.message) ? 'labview-visible-changing' : 'tightvnc-desktop-labview-absent';
      failedGate = /settle/i.test(error.message) ? 5 : 4;
      writeFailure(error, { launchDiagnostics, fingerprintSummary: summarizeFingerprints(frames) });
      return failedGate;
    }

    const representatives = {};
    for (const [role, frame] of Object.entries({ initial: selected.initial, transition: selected.transition, settled: selected.settled })) {
      const relative = path.join('frames', `${role}-frame-${String(frame.index).padStart(6, '0')}.png`);
      const destination = path.join(evidenceDir, relative);
      copyFileSync(frame.cacheFile, destination);
      const decoded = decodePng(readFileSync(destination));
      if (decoded.width !== connectionInfo.width || decoded.height !== connectionInfo.height) {
        throw new Error(`${role} PNG dimensions do not match negotiated framebuffer`);
      }
      const analysis = analyzePixels(decoded.rgba, decoded.width, decoded.height);
      if (!analysis.passed) throw new Error(`${role} PNG failed pixel proof: ${analysis.reason}`);
      representatives[role] = {
        role,
        frameIndex: frame.index,
        sourceFrameIndex: frame.cacheFrameIndex,
        monotonicMs: frame.ms,
        wallTime: frame.wallTime,
        dhashHex: frame.dhashHex,
        path: relative.replaceAll('\\', '/'),
        size: statSync(destination).size,
        sha256: sha256(destination),
        analysis,
      };
    }

    const settledDecoded = decodePng(readFileSync(path.join(evidenceDir, representatives.settled.path)));
    const expectedWindow = launchDiagnostics.expectedWindow;
    const baselineDecoded = decodePng(readFileSync(selected.baseline.cacheFile));
    const visibility = proveLabviewVisibility({
      initialRgba: baselineDecoded.rgba,
      candidateRgba: settledDecoded.rgba,
      width: connectionInfo.width,
      height: connectionInfo.height,
      initialFingerprint: representatives.initial.dhashHex,
      candidateFingerprint: representatives.settled.dhashHex,
      labviewPid: launchDiagnostics.labviewPid,
      window: expectedWindow,
      expectedDesktop: bootstrapReady.bootstrap.desktopContext.qualifiedDesktop,
    });
    if (!visibility.passed) {
      classification = 'tightvnc-desktop-labview-absent';
      failedGate = 4;
      writeFailure(new Error(visibility.reason), { launchDiagnostics, visibility, representatives });
      return 4;
    }

    const completeResources = resourceSamples.filter((sample) => (
      Number.isFinite(sample.cpuPct)
      && Number.isFinite(sample.ramMb)
      && Number.isFinite(sample.counters?.dockerBlockReadMb)
      && Number.isFinite(sample.counters?.dockerBlockWriteMb)
    ));
    if (completeResources.length === 0) {
      classification = 'labview-visible-changing';
      failedGate = 5;
      writeFailure(new Error('required CPU, memory, and disk resource samples are missing'), {
        launchDiagnostics,
        visibility,
        representatives,
      });
      return 5;
    }

    const metadata = {
      runId: environment.runId,
      plane: 'WIN',
      hypervisor: 'docker-windows-tightvnc',
      substrate: 'windows-container-vnc',
      imageReference: environment.image.reference,
      imageId: environment.image.id,
      containerId,
      isolation: environment.container.isolation,
      hostOs: environment.hostOs,
      containerOs: environment.containerOs,
      network: networkPreflight,
      relay: relayRecord,
      display,
      probeMatch,
      probeStop,
      rfb: connectionInfo,
      capture: {
        fps,
        governedPeriodMs: 1000 / fps,
        requestedDurationMs: durationMs,
        actualDurationMs: frames.at(-1).ms - workloadStartMs,
        maximumPhaseErrorMs: framePhaseErrorMaxMs,
        launchWindowTimeoutSeconds,
        launchAliveSeconds,
        clock: 'host process.hrtime.bigint',
        wallStart: captureWallStart,
      },
      resources: {
        cadenceMs: 1000,
        sampleCount: resourceSamples.length,
        completeSampleCount: completeResources.length,
        clock: 'host process.hrtime.bigint',
        alignment: 'nearest resource sample to each capture frame; no interpolation',
        sources: ['host-observed docker stats', 'in-container Win32 CIM counters'],
      },
      visibility,
      representatives,
    };
    const { benchmark, launchCapture } = buildExperimentRecords({
      frames,
      resourceSamples,
      workloadStartMs,
      fps,
      capacityBytes,
      representatives,
      metadata,
      settleOptions,
    });
    const launchMs = benchmark.spans.find((span) => span.id === 'launchMs')?.ms;
    if (!Number.isFinite(launchMs) || launchMs <= 0) throw new Error('launchMs is not finite and positive');
    classification = 'labview-visible-settled';
    failedGate = null;
    atomicJson(path.join(evidenceDir, 'resource-samples.json'), {
      schema: 'labview-benchmark-actor/windows-docker-resources@1',
      clock: 'host process.hrtime.bigint',
      cadenceMs: 1000,
      alignment: 'nearest sample; no interpolation',
      samples: resourceSamples,
      errors: resourceErrors,
    });
    atomicJson(path.join(evidenceDir, 'launch-capture.json'), launchCapture);
    atomicJson(path.join(evidenceDir, 'benchmark.json'), benchmark);
    atomicJson(path.join(evidenceDir, 'capture-summary.json'), {
      schema: 'labview-benchmark-actor/windows-docker-tightvnc-capture@1',
      outcome: 'passed',
      classification,
      gates: { rfbFramebuffer: 'passed', labviewVisibility: 'passed', benchmarkCompletion: 'passed' },
      workloadStartMs,
      workloadStartWall,
      launchMs,
      frameCount: frames.length,
      authoritativeFrameCount: launchCapture.dualPacket.authoritativeFrames,
      rfb: connectionInfo,
      network: networkPreflight,
      relay: relayRecord,
      display,
      probeMatch,
      probeStop,
      fingerprintSummary: summarizeFingerprints(frames),
      settle: selected.settle,
      resourceSampleCount: resourceSamples.length,
      completeResourceSampleCount: completeResources.length,
      representatives,
      visibility,
      clocks: {
        durations: 'host process.hrtime.bigint',
        provenance: 'host Date.toISOString',
      },
    });
    return 0;
  } catch (error) {
    writeFailure(error);
    return failedGate ?? 5;
  } finally {
    if (sampler) await sampler.stop();
    resourceActive = false;
    if (resourceLoop) await resourceLoop;
    stream?.close();
    let relayCleanupError = null;
    try {
      await closeRelay();
    } catch (error) {
      failedGate = 6;
      classification = 'relay-cleanup-failure';
      writeFailure(error);
      relayCleanupError = error;
    }
    rmSync(cacheDir, { recursive: true, force: true });
    if (relayCleanupError) throw relayCleanupError;
  }
}

const exitCode = await main().catch((error) => {
  console.error(`capture: ${error.message}`);
  return 1;
});
process.exitCode = exitCode;
