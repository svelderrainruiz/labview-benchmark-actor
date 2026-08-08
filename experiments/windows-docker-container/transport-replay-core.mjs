import { createHash } from 'node:crypto';
import { encodeCaptureFrame, decodeCaptureFrame, PACKET_BYTES } from '../mprr-capture-ring/capture-ring.mjs';

export const TRANSPORT_REPLAY_SCHEMA =
  'labview-benchmark-actor/windows-container-rfb-transport-replay@1';

export const TRANSPORT_MILESTONES = Object.freeze({
  5: 'DIRECT-PROBE-COMPLETE',
  6: 'RELAY-READY',
  7: 'RFB-TRAVERSED',
  8: 'FRAMEBUFFER-CLASSIFIED',
  9: 'RELAY-CLOSED',
  10: 'CLEANUP-PROVEN',
});

const REQUIRED_SOURCE_ROLES = Object.freeze([
  'manifest',
  'failureReceipt',
  'networkPreflight',
  'networkRelay',
  'cleanupVerification',
  'tightVncLog',
  'rfbImage',
  'lbabusHostStage',
  'lbabusContainer',
]);
const SOURCE_FILE_BY_ROLE = Object.freeze({
  manifest: 'manifest.json',
  failureReceipt: 'failure-receipt.json',
  networkPreflight: 'network-preflight.json',
  networkRelay: 'network-relay.json',
  cleanupVerification: 'cleanup-verification.json',
  tightVncLog: 'tvnserver.log',
  rfbImage: 'frames/transport-baseline-rfb.png',
  lbabusHostStage: 'lbabus-host-stage.json',
  lbabusContainer: 'lbabus-container.json',
});

const round4 = (value) => Math.round(value * 10000) / 10000;
const ticksFromMs = (value) => BigInt(Math.round(value * 10000));
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireFinite(value, label, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${label} must be a finite number >= ${minimum}`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireIso(value, label) {
  const timestamp = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return { value, timestamp };
}

function wallOffsetMs(origin, value, label) {
  const point = requireIso(value, label);
  const offset = point.timestamp - origin.timestamp;
  if (offset < 0) throw new Error(`${label} precedes the replay origin`);
  return round4(offset);
}

function sourceRef(entry, role) {
  requireObject(entry, `sources.${role}`);
  if (typeof entry.path !== 'string' || !entry.path) throw new Error(`sources.${role}.path is required`);
  if (!Number.isInteger(entry.size) || entry.size < 1) throw new Error(`sources.${role}.size is invalid`);
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error(`sources.${role}.sha256 is invalid`);
  return { role, path: entry.path, size: entry.size, sha256: entry.sha256 };
}

function buildMarker({ milestoneId, frameIndex, offsetMs }) {
  const packet = encodeCaptureFrame({
    timingTicks64: ticksFromMs(offsetMs),
    frameIndex,
    milestoneId,
  });
  const decoded = decodeCaptureFrame(packet);
  if (decoded.dhash64 !== 0n || decoded.caseId !== null) {
    throw new Error('transport replay milestone unexpectedly carries a visual frame or pinned boot case');
  }
  return {
    milestoneId,
    name: TRANSPORT_MILESTONES[milestoneId],
    frameIndex,
    wallOffsetMs: offsetMs,
    timingTicks64: decoded.timingTicks64.toString(),
    packetBytes: PACKET_BYTES,
    packetHex: hex(packet),
    packetSha256: sha256(packet),
    visualFrame: false,
  };
}

export function deriveTransportReplay({
  manifest,
  failureReceipt,
  networkPreflight,
  networkRelay,
  cleanupVerification,
  tightVncLog,
  rfbImage,
  lbabusHostStage,
  lbabusContainer,
  sources,
}) {
  requireObject(manifest, 'manifest');
  requireObject(failureReceipt, 'failureReceipt');
  requireObject(networkPreflight, 'networkPreflight');
  requireObject(networkRelay, 'networkRelay');
  requireObject(cleanupVerification, 'cleanupVerification');
  requireObject(rfbImage, 'rfbImage');
  requireObject(lbabusHostStage, 'lbabusHostStage');
  requireObject(lbabusContainer, 'lbabusContainer');
  requireObject(sources, 'sources');
  if (typeof tightVncLog !== 'string' || tightVncLog.length === 0) {
    throw new Error('tightVncLog is required');
  }

  const sourceRefs = REQUIRED_SOURCE_ROLES.map((role) => sourceRef(sources[role], role));
  const runId = manifest.runId;
  if (!runId || failureReceipt.environment?.runId !== runId) throw new Error('source run identities disagree');
  for (const source of sourceRefs) {
    const expected = `experiments/windows-docker-container/evidence/${runId}/${SOURCE_FILE_BY_ROLE[source.role]}`;
    if (source.path !== expected) {
      throw new Error(`sources.${source.role}.path must be '${expected}'`);
    }
  }
  if (manifest.outcome !== 'inconclusive' || failureReceipt.outcome !== 'inconclusive') {
    throw new Error('historical source outcome must remain inconclusive');
  }
  if (failureReceipt.failedGate !== 3 || failureReceipt.classification !== 'black-or-uniform-framebuffer') {
    throw new Error('source must be the preserved Gate 3 black-frame result');
  }
  if (failureReceipt.transportOnly !== true || failureReceipt.labviewLaunchTriggered !== false) {
    throw new Error('source must preserve the transport-only no-LabVIEW boundary');
  }

  const image = failureReceipt.environment?.image;
  if (
    image?.reference !== 'nationalinstruments/labview:2026q3-windows'
    || image.id !== image.expectedId
    || image.os !== 'windows'
    || image.architecture !== 'amd64'
  ) {
    throw new Error('exact Windows image proof is missing or contradictory');
  }
  if (failureReceipt.environment?.container?.isolation !== 'process') {
    throw new Error('transport replay source must use process isolation');
  }

  if (
    networkPreflight.status !== 'passed'
    || networkPreflight.containerId !== failureReceipt.environment.container.id
    || networkPreflight.directProbe?.connected !== true
  ) {
    throw new Error('direct container-network reachability proof is missing');
  }
  if (
    !Array.isArray(networkPreflight.dockerPublishedPorts)
    || networkPreflight.dockerPublishedPorts.length !== 0
    || !Array.isArray(failureReceipt.environment.container.dockerPublishedPorts)
    || failureReceipt.environment.container.dockerPublishedPorts.length !== 0
  ) {
    throw new Error('Docker port publication must be absent');
  }

  if (
    networkRelay.status !== 'rfb-traversed'
    || networkRelay.bound?.address !== '127.0.0.1'
    || networkRelay.bound?.family !== 'IPv4'
    || !Array.isArray(networkRelay.listenerBindings)
    || networkRelay.listenerBindings.length < 1
    || networkRelay.listenerBindings.some((binding) => binding.localAddress !== '127.0.0.1')
  ) {
    throw new Error('loopback-only relay proof is missing or contradictory');
  }
  if (
    networkRelay.upstream?.host !== networkPreflight.target?.ipAddress
    || networkRelay.upstream?.port !== 5900
  ) {
    throw new Error('relay upstream does not match the inspected container endpoint');
  }

  const rfb = failureReceipt.rfb;
  if (
    rfb?.rfbVersion !== '3.8'
    || rfb.securityType !== 2
    || rfb.securityTypeName !== 'VNC Authentication'
  ) {
    throw new Error('authenticated RFB 3.8 proof is missing');
  }
  const stats = networkRelay.stats;
  const downstreamBytes = requirePositiveInteger(
    stats?.downstreamToUpstreamBytes,
    'relay downstreamToUpstreamBytes',
  );
  const upstreamBytes = requirePositiveInteger(
    stats?.upstreamToDownstreamBytes,
    'relay upstreamToDownstreamBytes',
  );
  if (
    stats.acceptedConnections < 1
    || stats.successfulUpstreamConnections < 1
    || stats.upstreamConnectionFailures !== 0
    || stats.serverErrors !== 0
    || stats.downstreamErrors !== 0
  ) {
    throw new Error('relay connection/error counters are contradictory');
  }

  const analysis = failureReceipt.initialAnalysis;
  const expectedPixels = rfb.width * rfb.height;
  if (
    analysis?.passed !== false
    || analysis.reason !== 'single-color-or-single-luminance-population'
    || analysis.pixels !== expectedPixels
    || analysis.blackFraction !== 1
    || analysis.meaningfulLumaPopulations !== 1
  ) {
    throw new Error('black framebuffer classification is missing or contradictory');
  }
  const acquisition = requireObject(failureReceipt.imageAcquisition, 'failureReceipt.imageAcquisition');
  const imageSource = sources.rfbImage;
  const imageManifest = manifest.files?.find((entry) => entry.path === acquisition.path);
  if (
    acquisition.schema !== 'labview-benchmark-actor/windows-container-rfb-image@1'
    || acquisition.status !== 'acquired-but-unusable'
    || acquisition.usable !== false
    || acquisition.visualClaim !== false
    || acquisition.source !== 'run-owned-container-tightvnc-rfb'
    || acquisition.sourceContainerId !== failureReceipt.environment.container.id
    || acquisition.upstreamEndpoint?.host !== networkPreflight.target.ipAddress
    || acquisition.upstreamEndpoint?.port !== 5900
    || acquisition.hostRelayEndpoint?.address !== '127.0.0.1'
    || acquisition.hostRelayEndpoint?.port !== networkRelay.bound.port
    || acquisition.rfb?.version !== rfb.rfbVersion
    || acquisition.rfb.securityType !== rfb.securityType
    || acquisition.rfb.width !== rfb.width
    || acquisition.rfb.height !== rfb.height
    || acquisition.rfb.updateCountAtSample < 1
    || acquisition.rfb.updateCountAtSample > rfb.updateCount
    || acquisition.framePollCount !== failureReceipt.frameCount
    || acquisition.path !== SOURCE_FILE_BY_ROLE.rfbImage
    || acquisition.size !== imageSource.size
    || acquisition.pngSha256 !== imageSource.sha256
    || imageManifest?.size !== imageSource.size
    || imageManifest?.sha256 !== imageSource.sha256
    || rfbImage.width !== rfb.width
    || rfbImage.height !== rfb.height
    || rfbImage.rgbaSha256 !== acquisition.rgbaSha256
    || rfbImage.analysis?.passed !== false
    || rfbImage.analysis.blackFraction !== 1
    || rfbImage.analysis.meaningfulLumaPopulations !== 1
    || rfbImage.analysis.reason !== 'single-color-or-single-luminance-population'
  ) {
    throw new Error('retained container RFB image proof is missing or contradictory');
  }
  if (
    lbabusHostStage.schema !== 'labview-benchmark-actor/windows-container-lbabus-stage@1'
    || lbabusContainer.schema !== 'labview-benchmark-actor/windows-container-lbabus@1'
    || lbabusContainer.status !== 'passed'
    || lbabusContainer.version !== lbabusHostStage.version
    || lbabusContainer.payloadSha256 !== lbabusHostStage.payloadSha256
    || failureReceipt.environment.lbabus?.hostStage?.payloadSha256 !== lbabusHostStage.payloadSha256
    || failureReceipt.environment.lbabus?.containerProbe?.payloadSha256 !== lbabusContainer.payloadSha256
    || !lbabusContainer.capabilities?.some((line) => /\[yes\]\s+labview-cli/i.test(line))
  ) {
    throw new Error('in-container lbabus capability proof is missing or contradictory');
  }
  if (!/console desktop has 0 displays/i.test(tightVncLog)) {
    throw new Error('TightVNC zero-display log proof is missing');
  }
  const tightVncZeroDisplayMode = /sending blank screen/i.test(tightVncLog)
    ? 'blank-screen'
    : (
        /sending NewFBSize/i.test(tightVncLog)
        && /update requested/i.test(tightVncLog)
      )
      ? 'desktop-size-then-black-update'
      : null;
  if (!tightVncZeroDisplayMode) {
    throw new Error('TightVNC zero-display update behavior is missing');
  }

  if (
    manifest.relay?.cleanup?.closed !== true
    || manifest.relay.cleanup.listenerReachable !== false
    || !Array.isArray(manifest.relay.cleanup.listenerBindingsAfterClose)
    || manifest.relay.cleanup.listenerBindingsAfterClose.length !== 0
    || cleanupVerification.containerAbsent !== true
    || cleanupVerification.relayListenerClosed !== true
    || cleanupVerification.relayCleanupProven !== true
    || cleanupVerification.vncPortClosed !== true
    || cleanupVerification.secretDirectoryRemoved !== true
  ) {
    throw new Error('cleanup proof is incomplete');
  }

  const origin = requireIso(networkPreflight.wallTime, 'networkPreflight.wallTime');
  const points = [
    { milestoneId: 5, time: networkPreflight.wallTime },
    { milestoneId: 6, time: networkRelay.readyWallTime },
    { milestoneId: 7, time: networkRelay.rfbTraversedWallTime },
    { milestoneId: 8, time: failureReceipt.wallTime },
    { milestoneId: 9, time: manifest.relay.cleanup.closedWallTime },
    { milestoneId: 10, time: cleanupVerification.wallTime },
  ];
  const markers = points.map((point, frameIndex) => buildMarker({
    milestoneId: point.milestoneId,
    frameIndex,
    offsetMs: wallOffsetMs(origin, point.time, TRANSPORT_MILESTONES[point.milestoneId]),
  }));
  for (let index = 1; index < markers.length; index += 1) {
    if (BigInt(markers[index].timingTicks64) < BigInt(markers[index - 1].timingTicks64)) {
      throw new Error('replay milestone timing regressed');
    }
  }

  const directProbeMs = requireFinite(networkPreflight.directProbe.elapsedMs, 'directProbe.elapsedMs');
  const relayCleanupMs = requireFinite(manifest.relay.cleanup.elapsedMs, 'relay.cleanup.elapsedMs');
  const framePollCount = requirePositiveInteger(failureReceipt.frameCount, 'frameCount');
  const updateCount = requirePositiveInteger(rfb.updateCount, 'rfb.updateCount');

  return {
    schema: TRANSPORT_REPLAY_SCHEMA,
    replayId: `${runId}-transport-replay`,
    sourceRunId: runId,
    sourceOutcome: 'inconclusive',
    benchmarkOutcome: 'transport-supported-framebuffer-unavailable',
    benchmarkScope: 'windows-container-rfb-transport-only',
    timing: {
      liveMonotonicMetrics: ['directProbeMs', 'relayCleanupMs'],
      replayTimelineAuthority: 'relative UTC evidence ordering encoded as MPRR 100ns ticks',
      replayTimelinePerformanceAuthority: false,
      wallClockProvenancePreserved: true,
    },
    transport: {
      dockerPublishedPorts: 0,
      directEndpoint: networkPreflight.directProbe.endpoint,
      directProbeMs,
      relayBoundAddress: networkRelay.bound.address,
      relayHostPortAssigned: networkRelay.bound.port,
      relayUpstream: `${networkRelay.upstream.host}:${networkRelay.upstream.port}`,
      acceptedConnections: stats.acceptedConnections,
      successfulUpstreamConnections: stats.successfulUpstreamConnections,
      downstreamToUpstreamBytes: downstreamBytes,
      upstreamToDownstreamBytes: upstreamBytes,
      totalRelayBytes: downstreamBytes + upstreamBytes,
      upstreamDownstreamByteRatio: round4(upstreamBytes / downstreamBytes),
      relayCleanupMs,
      relayClosed: true,
    },
    rfb: {
      version: rfb.rfbVersion,
      securityType: rfb.securityType,
      securityTypeName: rfb.securityTypeName,
      width: rfb.width,
      height: rfb.height,
      updateCount,
      observedFramePollCount: framePollCount,
      retainedVisualFrameCount: 0,
      retainedDiagnosticFrameCount: 1,
      authenticated: true,
      traversedLoopbackRelay: true,
    },
    framebuffer: {
      payloadBytesDelivered: upstreamBytes > 0,
      blackFraction: analysis.blackFraction,
      meaningfulLumaPopulations: analysis.meaningfulLumaPopulations,
      classification: 'uniform-black-zero-display-surface',
      tightVncZeroDisplayMode,
      interactiveDisplayAvailable: false,
      screenshotBenchmarkAvailable: false,
      diagnosticImage: {
        acquiredFromContainerRfb: true,
        usable: false,
        visualClaim: false,
        path: acquisition.path,
        size: acquisition.size,
        pngSha256: acquisition.pngSha256,
        rgbaSha256: acquisition.rgbaSha256,
      },
    },
    capabilities: {
      networkRelay: 'supported-and-proven',
      rfbProtocolAndAuthentication: 'supported-and-proven',
      framebufferPayloadTransport: 'supported-and-proven',
      containerRfbImageAcquisition: 'supported-but-unusable-black-frame',
      lbabusInContainer: 'supported-and-proven',
      interactiveWindowsContainerDisplay: 'unsupported-by-windows-container-platform',
      labviewVisualLaunchBenchmark: 'unsupported-by-windows-container-platform',
    },
    forbiddenClaims: {
      labviewLaunchMs: null,
      visualSettleMs: null,
      screenshotFingerprint: null,
      interactiveDesktop: false,
    },
    mprr: {
      schema: 'labview-benchmark-actor/capture-ring-packet@v1',
      packetBytes: PACKET_BYTES,
      ticksPerMs: 10000,
      visualFramesEncoded: 0,
      markers,
    },
    sources: sourceRefs,
  };
}

export function validateTransportReplay(record) {
  requireObject(record, 'record');
  if (record.schema !== TRANSPORT_REPLAY_SCHEMA) throw new Error('invalid transport replay schema');
  if (record.benchmarkOutcome !== 'transport-supported-framebuffer-unavailable') {
    throw new Error('transport replay benchmark outcome is contradictory');
  }
  if (
    record.capabilities?.interactiveWindowsContainerDisplay
      !== 'unsupported-by-windows-container-platform'
    || record.capabilities.labviewVisualLaunchBenchmark
      !== 'unsupported-by-windows-container-platform'
  ) {
    throw new Error('transport replay weakens the platform conclusion');
  }
  if (
    record.forbiddenClaims?.labviewLaunchMs !== null
    || record.forbiddenClaims.visualSettleMs !== null
    || record.forbiddenClaims.screenshotFingerprint !== null
    || record.forbiddenClaims.interactiveDesktop !== false
  ) {
    throw new Error('transport replay contains a forbidden GUI/visual benchmark claim');
  }
  if (record.mprr?.visualFramesEncoded !== 0 || record.rfb?.retainedVisualFrameCount !== 0) {
    throw new Error('transport replay invented retained visual frames');
  }
  if (!Array.isArray(record.mprr?.markers) || record.mprr.markers.length !== 6) {
    throw new Error('transport replay MPRR markers are incomplete');
  }
  for (const [index, marker] of record.mprr.markers.entries()) {
    if (marker.name !== TRANSPORT_MILESTONES[marker.milestoneId] || marker.frameIndex !== index) {
      throw new Error('transport replay MPRR marker identity is invalid');
    }
    const bytes = Buffer.from(marker.packetHex, 'hex');
    if (bytes.length !== PACKET_BYTES || sha256(bytes) !== marker.packetSha256) {
      throw new Error('transport replay MPRR packet digest is invalid');
    }
    const decoded = decodeCaptureFrame(bytes);
    if (
      decoded.milestoneId !== marker.milestoneId
      || decoded.frameIndex !== marker.frameIndex
      || decoded.timingTicks64.toString() !== marker.timingTicks64
      || decoded.dhash64 !== 0n
    ) {
      throw new Error('transport replay MPRR packet round-trip failed');
    }
  }
  if (
    record.transport?.relayBoundAddress !== '127.0.0.1'
    || record.transport.dockerPublishedPorts !== 0
    || record.transport.downstreamToUpstreamBytes < 1
    || record.transport.upstreamToDownstreamBytes < 1
    || record.transport.relayClosed !== true
  ) {
    throw new Error('transport replay relay proof is invalid');
  }
  if (
    record.rfb?.authenticated !== true
    || record.rfb.securityType !== 2
    || record.framebuffer?.interactiveDisplayAvailable !== false
    || record.framebuffer.blackFraction !== 1
    || !['blank-screen', 'desktop-size-then-black-update'].includes(
      record.framebuffer.tightVncZeroDisplayMode,
    )
    || record.framebuffer.diagnosticImage?.acquiredFromContainerRfb !== true
    || record.framebuffer.diagnosticImage.usable !== false
    || record.framebuffer.diagnosticImage.visualClaim !== false
    || record.rfb.retainedDiagnosticFrameCount !== 1
    || record.capabilities?.containerRfbImageAcquisition !== 'supported-but-unusable-black-frame'
    || record.capabilities?.lbabusInContainer !== 'supported-and-proven'
  ) {
    throw new Error('transport replay RFB/framebuffer boundary is invalid');
  }
  if (
    !Array.isArray(record.sources)
    || REQUIRED_SOURCE_ROLES.some((role) => !record.sources.some((source) => source.role === role))
  ) {
    throw new Error('transport replay immutable sources are incomplete');
  }
  for (const source of record.sources) {
    const expected =
      `experiments/windows-docker-container/evidence/${record.sourceRunId}/${SOURCE_FILE_BY_ROLE[source.role]}`;
    if (source.path !== expected) {
      throw new Error(`transport replay source path must be '${expected}'`);
    }
  }
  return true;
}
