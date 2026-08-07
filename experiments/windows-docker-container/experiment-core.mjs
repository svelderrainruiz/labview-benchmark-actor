import { dhash64FromRgba, hammingHex } from '../manual-procedure-record/fingerprint.mjs';
import { buildLaunchCapture } from '../mprr-capture-ring/launch-capture.mjs';
import { detectSettle } from '../mprr-capture-ring/settle-detect.mjs';
import { buildWorkloadRecord } from '../mprr-capture-ring/workload-benchmark.mjs';
import { assertUsableContainerIpv4 } from './tcp-relay.mjs';

const MB = 1024 * 1024;

export async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertFramebuffer(rgba, width, height) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('framebuffer dimensions must be positive integers');
  }
  if (!ArrayBuffer.isView(rgba) || rgba.byteLength !== width * height * 4) {
    throw new Error(`RGBA buffer must contain exactly ${width * height * 4} bytes`);
  }
}

function clippedRoi(width, height, roi) {
  if (!roi) return { x: 0, y: 0, width, height };
  const left = Math.max(0, Math.floor(roi.left ?? roi.x ?? 0));
  const top = Math.max(0, Math.floor(roi.top ?? roi.y ?? 0));
  const right = Math.min(width, Math.ceil(roi.right ?? left + (roi.width ?? 0)));
  const bottom = Math.min(height, Math.ceil(roi.bottom ?? top + (roi.height ?? 0)));
  if (right <= left || bottom <= top) throw new Error('window bounds do not intersect the framebuffer');
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function desktopTargetContract(mode) {
  if (!['Inherited', 'WinSta0'].includes(mode)) throw new Error(`unsupported desktop target '${mode}'`);
  return {
    mode,
    changesProcessWindowStation: mode === 'WinSta0',
    explicitStartupDesktop: mode === 'WinSta0' ? 'WinSta0\\Default' : null,
  };
}

export function validateChildDesktopMatch({
  bootstrapContext,
  childContext,
  parentSessionId,
  childSessionId,
  window,
  childProcessId,
}) {
  if (!bootstrapContext || !childContext) throw new Error('bootstrap and child desktop contexts are required');
  if (bootstrapContext.mode !== childContext.mode) throw new Error('child desktop mode differs from bootstrap');
  if (bootstrapContext.qualifiedDesktop !== childContext.qualifiedDesktop) {
    throw new Error('child resolved desktop differs from bootstrap');
  }
  if (parentSessionId !== childSessionId) throw new Error('child session differs from parent');
  if (window) {
    if (window.processId !== childProcessId) throw new Error('desktop window belongs to another process');
    if (window.desktop !== childContext.qualifiedDesktop) throw new Error('desktop window belongs to another desktop');
  }
  return true;
}

export function classifyDisplayProof({ display, localGdi, rfbAnalysis, probeMatch } = {}) {
  if (!display?.api?.getDcSucceeded) return { passed: false, classification: 'desktop-screen-dc-unavailable' };
  if (!Array.isArray(display.api.monitorRectangles) || display.api.monitorRectangles.length === 0) {
    return { passed: false, classification: 'desktop-has-zero-displays' };
  }
  if (!localGdi?.analysis?.passed) return { passed: false, classification: 'desktop-local-gdi-capture-black' };
  if (!rfbAnalysis?.passed) return { passed: false, classification: 'rfb-black-despite-local-gdi' };
  if (!probeMatch?.passed) return { passed: false, classification: 'rfb-probe-mismatch' };
  return { passed: true, classification: 'rfb-probe-visible' };
}

function cropRgba(rgba, width, height, roi) {
  assertFramebuffer(rgba, width, height);
  const region = clippedRoi(width, height, roi);
  const cropped = new Uint8Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y += 1) {
    const sourceStart = ((region.y + y) * width + region.x) * 4;
    cropped.set(rgba.subarray(sourceStart, sourceStart + region.width * 4), y * region.width * 4);
  }
  return { rgba: cropped, width: region.width, height: region.height, roi: region };
}

function histogram64(rgba) {
  const bins = new Array(64).fill(0);
  for (let i = 0; i < rgba.length; i += 4) {
    const index = (rgba[i] >> 6) * 16 + (rgba[i + 1] >> 6) * 4 + (rgba[i + 2] >> 6);
    bins[index] += 1;
  }
  return bins;
}

export function matchDesktopProbe({
  localRgba,
  rfbRgba,
  width,
  height,
  bounds,
  virtualOrigin = { x: 0, y: 0 },
  maxHamming = 4,
  maxHistogramDistance = 0.08,
}) {
  const roi = {
    left: bounds.left - (virtualOrigin.x ?? 0),
    top: bounds.top - (virtualOrigin.y ?? 0),
    right: bounds.right - (virtualOrigin.x ?? 0),
    bottom: bounds.bottom - (virtualOrigin.y ?? 0),
  };
  const local = cropRgba(localRgba, width, height, roi);
  const rfb = cropRgba(rfbRgba, width, height, roi);
  const localAnalysis = analyzePixels(local.rgba, local.width, local.height);
  const rfbAnalysis = analyzePixels(rfb.rgba, rfb.width, rfb.height);
  const localDhash = dhash64FromRgba(local.rgba, local.width, local.height);
  const rfbDhash = dhash64FromRgba(rfb.rgba, rfb.width, rfb.height);
  const hamming = hammingHex(localDhash, rfbDhash);
  const localHistogram = histogram64(local.rgba);
  const rfbHistogram = histogram64(rfb.rgba);
  const pixels = local.width * local.height;
  const histogramDistance = localHistogram.reduce(
    (sum, count, index) => sum + Math.abs(count - rfbHistogram[index]),
    0,
  ) / (2 * pixels);
  const passed = localAnalysis.passed
    && rfbAnalysis.passed
    && hamming <= maxHamming
    && histogramDistance <= maxHistogramDistance;
  return {
    passed,
    roi: local.roi,
    localAnalysis,
    rfbAnalysis,
    localDhash,
    rfbDhash,
    hamming,
    maxHamming,
    histogramDistance,
    maxHistogramDistance,
    reason: passed ? null : 'RFB probe ROI does not match the local GDI probe ROI',
  };
}

export function analyzePixels(rgba, width, height, { roi } = {}) {
  assertFramebuffer(rgba, width, height);
  const region = clippedRoi(width, height, roi);
  const lumaBins = new Array(16).fill(0);
  let black = 0;
  let transparent = 0;
  let pixels = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const i = (y * width + x) * 4;
      const luma = (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2]) >> 8;
      lumaBins[Math.min(15, luma >> 4)] += 1;
      if (luma <= 8) black += 1;
      if (rgba[i + 3] <= 8) transparent += 1;
      pixels += 1;
    }
  }
  const meaningfulThreshold = Math.max(4, Math.ceil(pixels * 0.001));
  const meaningfulLumaPopulations = lumaBins.filter((count) => count >= meaningfulThreshold).length;
  const blackFraction = black / pixels;
  const transparentFraction = transparent / pixels;
  const passed = meaningfulLumaPopulations > 1 && blackFraction < 0.99 && transparentFraction < 0.99;
  return {
    passed,
    pixels,
    roi: region,
    meaningfulThreshold,
    meaningfulLumaPopulations,
    blackFraction,
    transparentFraction,
    lumaBins,
    reason: passed
      ? null
      : meaningfulLumaPopulations <= 1
        ? 'single-color-or-single-luminance-population'
        : blackFraction >= 0.99
          ? 'uniformly-black'
          : 'uniformly-transparent',
  };
}

export function changedPixelRatio(before, after, width, height, { roi, lumaThreshold = 12 } = {}) {
  assertFramebuffer(before, width, height);
  assertFramebuffer(after, width, height);
  const region = clippedRoi(width, height, roi);
  let changed = 0;
  let pixels = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const i = (y * width + x) * 4;
      const beforeLuma = (77 * before[i] + 150 * before[i + 1] + 29 * before[i + 2]) >> 8;
      const afterLuma = (77 * after[i] + 150 * after[i + 1] + 29 * after[i + 2]) >> 8;
      if (Math.abs(afterLuma - beforeLuma) >= lumaThreshold) changed += 1;
      pixels += 1;
    }
  }
  return { changed, pixels, ratio: changed / pixels, roi: region, lumaThreshold };
}

export function proveLabviewVisibility({
  initialRgba,
  candidateRgba,
  width,
  height,
  initialFingerprint,
  candidateFingerprint,
  labviewPid,
  window,
  expectedDesktop = 'WinSta0\\Default',
  minChangedRatio = 0.02,
  transitionToleranceHamming = 2,
}) {
  const checks = {
    processMatched: Number.isInteger(labviewPid) && window?.processId === labviewPid,
    titleMatched: typeof window?.title === 'string' && /labview/i.test(window.title),
    visible: window?.visible === true && window?.minimized !== true,
    capturedDesktopMatched: window?.desktop === expectedDesktop,
    fingerprintTransition: typeof initialFingerprint === 'string'
      && typeof candidateFingerprint === 'string'
      && hammingHex(initialFingerprint, candidateFingerprint) > transitionToleranceHamming,
  };
  let roiAnalysis = null;
  let difference = null;
  try {
    roiAnalysis = analyzePixels(candidateRgba, width, height, { roi: window?.bounds });
    difference = changedPixelRatio(initialRgba, candidateRgba, width, height, { roi: window?.bounds });
  } catch (error) {
    return { status: 'inconclusive', passed: false, reason: error.message, checks, roiAnalysis, difference };
  }
  checks.windowRegionNonUniform = roiAnalysis.passed;
  checks.windowRegionChanged = difference.ratio >= minChangedRatio;
  const passed = Object.values(checks).every(Boolean);
  return {
    status: passed ? 'passed' : 'inconclusive',
    passed,
    reason: passed ? null : 'process-matched LabVIEW window was not proven in the captured framebuffer',
    checks,
    roiAnalysis,
    difference,
    minChangedRatio,
    transitionToleranceHamming,
  };
}

export function selectRepresentativeFrames(frames, workloadStartMs, settleOptions = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('representative selection requires frames');
  if (!Number.isFinite(workloadStartMs)) throw new Error('representative selection requires workloadStartMs');
  const prelaunch = frames.filter((frame) => frame.ms < workloadStartMs);
  if (prelaunch.length === 0) throw new Error('no pre-launch frame was captured');
  const initial = frames[0];
  const baseline = prelaunch.at(-1);
  const tolerance = settleOptions.toleranceHamming ?? 2;
  const transition = frames.find((frame) => (
    frame.ms >= workloadStartMs && hammingHex(frame.dhashHex, baseline.dhashHex) > tolerance
  ));
  if (!transition) throw new Error('no visual launch transition was captured');
  const settle = detectSettle(frames, {
    window: settleOptions.window ?? 8,
    toleranceHamming: tolerance,
  });
  if (!settle.settled) throw new Error(`UI did not settle: ${settle.reason}`);
  if (!(settle.settleMs > workloadStartMs)) throw new Error('settle frame did not occur after the launch trigger');
  const settled = frames[settle.settleFrameIndex];
  return { initial, baseline, transition, settled, settle };
}

export function summarizeFingerprints(frames) {
  const unique = new Set(frames.map((frame) => frame.dhashHex));
  let transitions = 0;
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i].dhashHex !== frames[i - 1].dhashHex) transitions += 1;
  }
  return { uniqueFingerprintCount: unique.size, visualTransitionCount: transitions };
}

export function parseDockerStats(stats) {
  if (!stats || typeof stats !== 'object') throw new Error('Docker stats object required');
  const cpuPct = parsePercent(stats.CPUPerc);
  const ramMb = parseFirstSizeMb(stats.MemUsage);
  const [blockReadMb, blockWriteMb] = parseSizePairMb(stats.BlockIO);
  if (![cpuPct, ramMb, blockReadMb, blockWriteMb].every(Number.isFinite)) {
    throw new Error('Docker stats missing CPU, memory, or block I/O data');
  }
  return { cpuPct, ramMb, blockReadMb, blockWriteMb };
}

function parsePercent(value) {
  const match = /^\s*([\d.]+)%\s*$/.exec(String(value ?? ''));
  return match ? Number(match[1]) : Number.NaN;
}

function sizeMb(value) {
  const match = /^\s*([\d.]+)\s*([kmgt]?i?b)\s*$/i.exec(String(value ?? ''));
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factors = { b: 1 / MB, kb: 1e3 / MB, kib: 1 / 1024, mb: 1e6 / MB, mib: 1, gb: 1e9 / MB, gib: 1024, tb: 1e12 / MB, tib: 1024 * 1024 };
  return amount * factors[unit];
}

function parseFirstSizeMb(value) {
  return sizeMb(String(value ?? '').split('/')[0].trim());
}

function parseSizePairMb(value) {
  const parts = String(value ?? '').split('/');
  return parts.length === 2 ? parts.map((part) => sizeMb(part.trim())) : [Number.NaN, Number.NaN];
}

export function buildDockerExecArgs(containerId, action, extraArgs = []) {
  if (!/^[a-f0-9]{12,64}$/i.test(containerId)) throw new Error('valid container ID required');
  if (!/^[A-Za-z]+$/.test(action)) throw new Error('valid bootstrap action required');
  return [
    'exec',
    containerId,
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\experiment\\container-bootstrap.ps1',
    '-Action',
    action,
    ...extraArgs.map(String),
  ];
}

function dockerPublishedPorts(ports) {
  if (ports == null) return [];
  if (typeof ports !== 'object' || Array.isArray(ports)) throw new Error('container NetworkSettings.Ports is malformed');
  return Object.entries(ports).flatMap(([containerPort, bindings]) => {
    if (bindings == null) return [];
    if (!Array.isArray(bindings)) throw new Error(`container port bindings for ${containerPort} are malformed`);
    return bindings.filter(Boolean).map((binding) => ({
      containerPort,
      hostIp: String(binding.HostIp ?? ''),
      hostPort: String(binding.HostPort ?? ''),
    }));
  });
}

export function selectContainerNetworkTarget(inspection, { expectedContainerId, expectedTarget } = {}) {
  if (!inspection || typeof inspection !== 'object') throw new Error('container inspection object is required');
  const containerId = inspection.Id;
  if (!/^[a-f0-9]{64}$/i.test(containerId ?? '')) throw new Error('container inspection has a malformed immutable ID');
  if (expectedContainerId && containerId !== expectedContainerId) {
    throw new Error(`container inspection is stale or belongs to another container (${containerId})`);
  }
  if (inspection.State?.Running !== true) throw new Error('container is not running during network inspection');
  const publishedPorts = dockerPublishedPorts(inspection.NetworkSettings?.Ports);
  if (publishedPorts.length !== 0) throw new Error('container has Docker-published ports');
  const networks = inspection.NetworkSettings?.Networks;
  if (!networks || typeof networks !== 'object' || Array.isArray(networks)) {
    throw new Error('container inspection has no network map');
  }
  const candidates = [];
  const rejected = [];
  for (const [networkName, value] of Object.entries(networks)) {
    try {
      if (!value || typeof value !== 'object') throw new Error('network attachment is malformed');
      const ipAddress = assertUsableContainerIpv4(value.IPAddress);
      const gateway = assertUsableContainerIpv4(value.Gateway);
      if (!/^[a-f0-9]{64}$/i.test(value.NetworkID ?? '')) throw new Error('network ID is malformed');
      if (!/^[a-f0-9]{64}$/i.test(value.EndpointID ?? '')) throw new Error('endpoint ID is malformed');
      candidates.push({
        containerId,
        networkName,
        networkId: value.NetworkID,
        endpointId: value.EndpointID,
        ipAddress,
        ipPrefixLength: Number.isInteger(value.IPPrefixLen) ? value.IPPrefixLen : null,
        gateway,
      });
    } catch (error) {
      rejected.push({ networkName, error: error.message });
    }
  }
  if (candidates.length === 0) {
    throw new Error(`container has no usable IPv4 network target (${rejected.map((item) => `${item.networkName}: ${item.error}`).join('; ') || 'no attachments'})`);
  }
  const natCandidates = candidates.filter((candidate) => candidate.networkName.toLowerCase() === 'nat');
  const target = candidates.length === 1 ? candidates[0] : natCandidates.length === 1 ? natCandidates[0] : null;
  if (!target) {
    throw new Error(`container network target is ambiguous (${candidates.map((candidate) => candidate.networkName).join(', ')})`);
  }
  if (expectedTarget) {
    for (const key of ['containerId', 'networkName', 'networkId', 'endpointId', 'ipAddress', 'gateway']) {
      if (target[key] !== expectedTarget[key]) throw new Error(`container network target changed at '${key}'`);
    }
  }
  return { containerId, target, publishedPorts, rejectedNetworks: rejected };
}

export function validateLoopbackListenerBindings(bindings, { port, processId } = {}) {
  if (!Array.isArray(bindings) || bindings.length === 0) throw new Error('relay listener was not found in host TCP state');
  for (const binding of bindings) {
    if (binding.localAddress !== '127.0.0.1') throw new Error(`relay has a non-loopback listener at ${binding.localAddress}`);
    if (binding.localPort !== port) throw new Error(`relay listener port changed (${binding.localPort})`);
    if (processId != null && binding.owningProcess !== processId) {
      throw new Error(`relay listener is owned by unexpected process ${binding.owningProcess}`);
    }
  }
  return true;
}

export function classifyRfbStartFailure(error, relayStats = {}) {
  if (
    (relayStats.upstreamConnectionFailures ?? 0) > 0
    && (relayStats.successfulUpstreamConnections ?? 0) === 0
  ) {
    return { failedGate: 2, classification: 'relay-upstream-failure' };
  }
  if (/^RFB:/.test(error?.message ?? '')) {
    return { failedGate: 3, classification: 'rfb-handshake-failure' };
  }
  if (/timed out/i.test(error?.message ?? '')) {
    return { failedGate: 3, classification: 'rfb-no-framebuffer-update' };
  }
  return { failedGate: 3, classification: 'no-rfb-connection' };
}

export function buildExperimentRecords({
  frames,
  resourceSamples,
  workloadStartMs,
  fps,
  capacityBytes,
  representatives,
  metadata,
  settleOptions,
}) {
  if (!Array.isArray(resourceSamples) || resourceSamples.length === 0) {
    throw new Error('required resource samples are missing');
  }
  const requiredResources = resourceSamples.filter((sample) => (
    Number.isFinite(sample.cpuPct)
    && Number.isFinite(sample.ramMb)
    && Number.isFinite(sample.counters?.dockerBlockReadMb)
    && Number.isFinite(sample.counters?.dockerBlockWriteMb)
  ));
  if (requiredResources.length === 0) throw new Error('resource samples contain no complete CPU/memory/disk sample');
  const representativeByIndex = new Map(
    Object.values(representatives).map((entry) => [entry.frameIndex, entry]),
  );
  const launchFrames = frames.map((frame) => {
    const representative = representativeByIndex.get(frame.index);
    return {
      index: frame.index,
      ms: frame.ms,
      dhashHex: frame.dhashHex,
      imageFile: representative?.path ?? null,
      imageBytes: representative?.size ?? 0,
    };
  });
  const launchCapture = buildLaunchCapture({
    frames: launchFrames,
    resourceSamples,
    startMs: frames[0].ms,
    fps,
    capacityBytes,
    meta: {
      workload: 'labview-ide-launch',
      plane: 'WIN',
      source: 'docker-windows-tightvnc-rfb',
      screenW: metadata.rfb.width,
      screenH: metadata.rfb.height,
      ...metadata,
    },
  });
  const benchmark = buildWorkloadRecord({
    frames,
    workloadStartMs,
    meta: {
      workload: 'labview-ide-launch',
      iteration: metadata.runId,
      plane: 'WIN',
      hypervisor: 'docker-windows-tightvnc',
      substrate: 'windows-container-vnc',
    },
    settle: settleOptions,
  });
  const fingerprintSummary = summarizeFingerprints(frames);
  benchmark.experiment = metadata;
  benchmark.sourceDetail = {
    ...benchmark.sourceDetail,
    totalCaptureDurationMs: frames.at(-1).ms - frames[0].ms,
    capturedFrameCount: frames.length,
    authoritativeFrameCount: launchCapture.dualPacket.authoritativeFrames,
    rfbUpdateCount: metadata.rfb.updateCount,
    ...fingerprintSummary,
  };
  return { benchmark, launchCapture };
}

export function validateMonotonicFrames(frames) {
  for (let i = 0; i < frames.length; i += 1) {
    if (frames[i].index !== i) throw new Error(`frame index discontinuity at ${i}`);
    if (!Number.isFinite(frames[i].ms)) throw new Error(`frame ${i} has no finite monotonic timestamp`);
    if (i > 0 && frames[i].ms < frames[i - 1].ms) throw new Error(`frame time regressed at ${i}`);
  }
  return true;
}
