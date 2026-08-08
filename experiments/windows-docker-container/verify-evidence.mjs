#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from '../manual-procedure-record/capture-adapter.mjs';
import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';
import { bootBenchmarkDiff } from '../mprr-boot-benchmark/boot-benchmark-diff.mjs';
import { analyzePixels, validateMonotonicFrames } from './experiment-core.mjs';

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

function walk(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(root, full);
    return [path.relative(root, full).replaceAll('\\', '/')];
  });
}

function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
}

function tightVncDriverEvidence(root, display) {
  const logPath = path.join(root, 'tvnserver.log');
  if (!existsSync(logPath)) return null;
  const text = readFileSync(logPath).toString('utf16le').replace(/^\ufeff/, '');
  const patterns = [
    /D3D driver usage is (?:allowed|disallowed)[^\r\n]*/g,
    /Mirror driver usage is (?:allowed|disallowed)[^\r\n]*/g,
    /Using the standart screen driver[^\r\n]*/g,
    /Win8ScreenDriver creating new Win8ScreenDriverImpl[^\r\n]*/g,
    /The Win8 duplication api can't be used:[^\r\n]*/g,
  ];
  const statements = [...new Set(patterns.flatMap((pattern) => text.match(pattern) ?? []))];
  const actual = text.includes('Using the standart screen driver')
    ? 'StandardGdi'
    : text.includes('Win8ScreenDriver creating new Win8ScreenDriverImpl')
      ? 'D3d'
      : 'Unknown';
  return {
    requested: display?.tightVncCaptureMode ?? null,
    actual,
    statements,
  };
}

function finalize(root) {
  const summary = readJson(root, 'capture-summary.json');
  const failurePath = path.join(root, 'failure-receipt.json');
  const failure = existsSync(failurePath) ? readJson(root, 'failure-receipt.json') : null;
  const network = existsSync(path.join(root, 'network-preflight.json')) ? readJson(root, 'network-preflight.json') : null;
  const relay = existsSync(path.join(root, 'network-relay.json')) ? readJson(root, 'network-relay.json') : summary.relay;
  const display = existsSync(path.join(root, 'display-diagnostics.json')) ? readJson(root, 'display-diagnostics.json') : summary.display;
  const tightVncDriver = tightVncDriverEvidence(root, display);
  const representativeByPath = new Map(
    Object.values(summary.representatives ?? {}).map((item) => [item.path, item]),
  );
  const files = walk(root)
    .filter((relative) => relative !== 'manifest.json' && !relative.endsWith('.tmp'))
    .sort()
    .map((relative) => {
      const full = path.join(root, relative);
      const stat = statSync(full);
      const representative = representativeByPath.get(relative);
      return {
        path: relative,
        size: stat.size,
        sha256: sha256(full),
        modifiedWallTime: stat.mtime.toISOString(),
        frameIndex: representative?.frameIndex ?? null,
        role: representative?.role ?? null,
      };
    });
  const manifest = {
    schema: 'labview-benchmark-actor/windows-docker-evidence-manifest@1',
    runId: summary.environment?.runId ?? summary.runId ?? null,
    outcome: failure?.outcome ?? summary.outcome,
    generatedWallTime: new Date().toISOString(),
    desktop: display ? {
      target: display.desktopTarget,
      context: display.api?.context ?? null,
      monitorRectangles: display.api?.monitorRectangles ?? [],
      localGdi: display.localGdi ?? null,
      desktopProbe: display.desktopProbe ?? null,
    } : null,
    tightVncDriver,
    network: network?.target ?? summary.network?.target ?? summary.network ?? null,
    relay: relay ? {
      processId: relay.processId,
      bound: relay.bound,
      upstream: relay.upstream,
      stats: relay.stats,
      cleanup: relay.cleanup,
    } : null,
    files,
  };
  atomicJson(path.join(root, 'manifest.json'), manifest);
  return manifest;
}

function verify(root) {
  const manifest = readJson(root, 'manifest.json');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest must list evidence files');
  for (const entry of manifest.files) {
    const full = path.join(root, entry.path);
    const stat = statSync(full);
    assert.equal(stat.size, entry.size, `size mismatch for ${entry.path}`);
    assert.equal(sha256(full), entry.sha256, `SHA-256 mismatch for ${entry.path}`);
    if (entry.path.endsWith('.json')) JSON.parse(readFileSync(full, 'utf8'));
  }
  const summary = readJson(root, 'capture-summary.json');
  const cleanup = readJson(root, 'cleanup-verification.json');
  assert.equal(cleanup.containerAbsent, true, 'run-owned container remains after cleanup');
  assert.equal(cleanup.vncPortClosed, true, 'VNC transport listener remains reachable after cleanup');
  assert.equal(cleanup.secretDirectoryRemoved, true, 'ephemeral secret directory remains after cleanup');
  assert.equal(cleanup.relayListenerClosed ?? true, true, 'loopback relay listener remains after cleanup');
  assert.equal(cleanup.relayCleanupProven ?? true, true, 'loopback relay cleanup was not proven');
  assert.equal(cleanup.probeTemporaryStateRemoved ?? true, true, 'desktop probe temporary state remains');
  assert.equal(cleanup.containerInstallerRemoved ?? true, true, 'container installer temporary state remains');

  if (existsSync(path.join(root, 'failure-receipt.json'))) {
    const failure = readJson(root, 'failure-receipt.json');
    assert.ok(['inconclusive', 'blocked'].includes(failure.outcome), 'failure outcome must be inconclusive or blocked');
    assert.ok(Number.isInteger(failure.failedGate) && failure.failedGate >= 1 && failure.failedGate <= 6, 'failure receipt needs a failed proof gate');
    const hasRelayEvidence = existsSync(path.join(root, 'network-preflight.json'))
      && existsSync(path.join(root, 'network-relay.json'));
    if (failure.failedGate >= 3 && hasRelayEvidence) {
      const network = readJson(root, 'network-preflight.json');
      const relay = readJson(root, 'network-relay.json');
      assert.equal(network.status, 'passed', 'Gate 3+ failure requires a passing private-network preflight');
      assert.deepEqual(network.dockerPublishedPorts, [], 'Gate 3+ failure had Docker-published ports');
      assert.deepEqual(network.dockerPortOutput, [], 'Gate 3+ failure had docker port output');
      assert.equal(network.directProbe.connected, true, 'Gate 3+ failure lacked direct private-network reachability');
      assert.equal(relay.bound.address, '127.0.0.1', 'Gate 3+ failure relay was not loopback-only');
      assert.equal(relay.bound.requestedPort, 0, 'Gate 3+ failure relay did not request an ephemeral port');
      assert.equal(relay.upstream.host, network.target.ipAddress, 'Gate 3+ failure relay used a stale upstream');
      assert.ok(relay.stats.downstreamToUpstreamBytes > 0 && relay.stats.upstreamToDownstreamBytes > 0, 'Gate 3+ failure relay lacked bidirectional traffic');
      assert.equal(relay.cleanup.closed, true, 'Gate 3+ failure relay did not close');
      assert.deepEqual(relay.cleanup.listenerBindingsAfterClose, [], 'Gate 3+ failure relay listener remained after close');
      assert.equal(manifest.relay.bound.port, relay.bound.port, 'Gate 3+ failure manifest relay disagrees with evidence');
      assert.equal(manifest.relay.cleanup.closed, true, 'Gate 3+ failure manifest lacks final relay cleanup');
    }
    if (existsSync(path.join(root, 'display-diagnostics.json'))) {
      const display = readJson(root, 'display-diagnostics.json');
      assert.ok(['Inherited', 'WinSta0'].includes(display.desktopTarget), 'display evidence has an invalid desktop target');
      assert.equal(manifest.desktop.target, display.desktopTarget, 'manifest desktop target disagrees with display evidence');
      assert.equal(manifest.desktop.context.qualifiedDesktop, display.api.context.qualifiedDesktop);
      if (existsSync(path.join(root, 'tvnserver.log'))) {
        assert.notEqual(manifest.tightVncDriver.actual, 'Unknown', 'TightVNC log did not prove the actual capture driver');
      }
      if (display.localGdi?.path) {
        const localPng = path.join(root, display.localGdi.path);
        const local = decodePng(readFileSync(localPng));
        assert.equal(local.width, display.localGdi.analysis.width, 'local GDI PNG width mismatch');
        assert.equal(local.height, display.localGdi.analysis.height, 'local GDI PNG height mismatch');
        assert.equal(sha256(localPng), display.localGdi.sha256, 'local GDI PNG hash mismatch');
        assert.equal(analyzePixels(local.rgba, local.width, local.height).passed, display.localGdi.analysis.passed);
      }
    }
    if (failure.transportOnly === true) {
      const acquisition = failure.imageAcquisition;
      const lbabusStage = readJson(root, 'lbabus-host-stage.json');
      const lbabusContainer = readJson(root, 'lbabus-container.json');
      assert.equal(failure.environment?.container?.transportOnly, true, 'transport-only failure environment disagrees');
      assert.equal(failure.environment?.container?.desktopTarget, 'WinSta0', 'transport-only image must come from WinSta0 baseline');
      assert.equal(failure.labviewLaunchTriggered, false, 'transport-only image acquisition launched LabVIEW');
      assert.ok(failure.frameCount > 0, 'transport-only image acquisition has no frame polls');
      assert.equal(failure.rfb?.securityType, 2, 'transport-only image acquisition lacked VNC authentication');
      assert.ok(failure.rfb?.updateCount > 0, 'transport-only image acquisition has no RFB updates');
      assert.equal(acquisition?.schema, 'labview-benchmark-actor/windows-container-rfb-image@1');
      assert.ok(
        ['acquired-but-unusable', 'acquired-nonuniform-but-not-interpreted'].includes(acquisition.status),
        'transport-only image acquisition status is invalid',
      );
      assert.equal(acquisition.usable, false, 'transport-only diagnostic image cannot be marked usable');
      assert.equal(acquisition.visualClaim, false, 'transport-only diagnostic image cannot make a visual claim');
      assert.equal(acquisition.source, 'run-owned-container-tightvnc-rfb');
      assert.equal(acquisition.sourceContainerId, failure.environment.container.id, 'image source container identity mismatch');
      assert.equal(acquisition.upstreamEndpoint.host, failure.network.target.ipAddress, 'image upstream host mismatch');
      assert.equal(acquisition.upstreamEndpoint.port, 5900, 'image upstream port mismatch');
      assert.equal(acquisition.hostRelayEndpoint.address, '127.0.0.1', 'image did not traverse the loopback relay');
      assert.equal(acquisition.hostRelayEndpoint.port, failure.relay.bound.port, 'image relay port mismatch');
      assert.equal(acquisition.rfb.version, failure.rfb.rfbVersion, 'image RFB protocol mismatch');
      assert.equal(acquisition.rfb.version, '3.8', 'image RFB protocol is not 3.8');
      assert.equal(acquisition.rfb.securityType, failure.rfb.securityType, 'image RFB security mismatch');
      assert.ok(acquisition.rfb.updateCountAtSample > 0, 'retained image predates the first RFB update');
      assert.equal(acquisition.path, 'frames/transport-baseline-rfb.png', 'unexpected transport image path');
      const imagePath = path.join(root, acquisition.path);
      const imageManifest = manifest.files.find((entry) => entry.path === acquisition.path);
      assert.ok(imageManifest, 'transport image is absent from the evidence manifest');
      assert.equal(statSync(imagePath).size, acquisition.size, 'transport image size mismatch');
      assert.equal(sha256(imagePath), acquisition.pngSha256, 'transport image PNG hash mismatch');
      assert.equal(imageManifest.sha256, acquisition.pngSha256, 'manifest transport image hash mismatch');
      const decoded = decodePng(readFileSync(imagePath));
      assert.equal(decoded.width, acquisition.rfb.width, 'transport image width mismatch');
      assert.equal(decoded.height, acquisition.rfb.height, 'transport image height mismatch');
      assert.equal(decoded.width, failure.rfb.width, 'transport image width disagrees with RFB negotiation');
      assert.equal(decoded.height, failure.rfb.height, 'transport image height disagrees with RFB negotiation');
      assert.equal(sha256Bytes(decoded.rgba), acquisition.rgbaSha256, 'transport image RGBA hash mismatch');
      assert.deepEqual(
        analyzePixels(decoded.rgba, decoded.width, decoded.height),
        acquisition.analysis,
        'transport image pixel analysis mismatch',
      );
      assert.equal(acquisition.analysis.passed, false, 'transport-only diagnostic image unexpectedly passed visual proof');
      assert.equal(lbabusStage.schema, 'labview-benchmark-actor/windows-container-lbabus-stage@1');
      assert.equal(lbabusContainer.schema, 'labview-benchmark-actor/windows-container-lbabus@1');
      assert.equal(lbabusContainer.status, 'passed', 'container lbabus capability probe did not pass');
      assert.equal(lbabusContainer.version, lbabusStage.version, 'container lbabus version mismatch');
      assert.equal(lbabusContainer.payloadSha256, lbabusStage.payloadSha256, 'container lbabus payload hash mismatch');
      assert.equal(failure.environment.lbabus.hostStage.payloadSha256, lbabusStage.payloadSha256);
      assert.equal(failure.environment.lbabus.containerProbe.payloadSha256, lbabusContainer.payloadSha256);
      assert.ok(
        lbabusContainer.capabilities.some((line) => /\[yes\]\s+labview-cli/i.test(line)),
        'container lbabus capability evidence did not detect LabVIEWCLI',
      );
    }
    return { outcome: failure.outcome, failedGate: failure.failedGate, files: manifest.files.length };
  }

  const required = [
    'host-orchestration.log',
    'container.log',
    'docker-info.json',
    'image-inspect.json',
    'container-inspect.json',
    'container-inspect-pre-relay.json',
    'bootstrap-ready.json',
    'display-diagnostics.json',
    'local-gdi-capture.png',
    'probe-stopped.json',
    'environment.json',
    'network-preflight.json',
    'network-relay.json',
    'capture-summary.json',
    'benchmark.json',
    'launch-capture.json',
    'resource-samples.json',
  ];
  const listed = new Set(manifest.files.map((entry) => entry.path));
  for (const relative of required) assert.ok(listed.has(relative), `required evidence missing: ${relative}`);

  const benchmark = readJson(root, 'benchmark.json');
  const launchCapture = readJson(root, 'launch-capture.json');
  const resources = readJson(root, 'resource-samples.json');
  const display = readJson(root, 'display-diagnostics.json');
  const network = readJson(root, 'network-preflight.json');
  const relay = readJson(root, 'network-relay.json');
  assert.equal(benchmark.schema, 'labview-benchmark-actor/boot-benchmark-v1');
  assert.equal(benchmark.plane, 'WIN');
  assert.equal(bootBenchmarkDiff(benchmark, benchmark).verdict, 'PASS', 'benchmark self-verification failed');
  assert.equal(launchCapture.frameCount, summary.frameCount, 'capture frame count disagrees with summary');
  assert.equal(launchCapture.frames.length, summary.frameCount, 'launch-capture frames disagree with summary');
  assert.equal(launchCapture.dualPacket.frameCount, summary.frameCount, 'dual-packet short continuity disagrees with summary');
  assert.equal(launchCapture.dualPacket.authoritativeFrames, summary.authoritativeFrameCount);
  assert.equal(benchmark.sourceDetail.rfbUpdateCount, summary.rfb.updateCount);
  assert.equal(summary.rfb.securityType, 2, 'RFB did not negotiate VNC Authentication');
  assert.ok(['Inherited', 'WinSta0'].includes(display.desktopTarget));
  assert.equal(display.api.getDcSucceeded, true, 'selected desktop screen DC was unavailable');
  assert.ok(display.api.monitorRectangles.length > 0, 'selected desktop had zero monitors');
  assert.equal(display.localGdi.analysis.passed, true, 'local GDI proof did not pass');
  assert.notEqual(manifest.tightVncDriver?.actual, 'Unknown', 'TightVNC actual capture driver is unknown');
  assert.equal(summary.probeMatch.passed, true, 'RFB did not match the deterministic desktop probe');
  assert.equal(summary.probeStop.stopped, true, 'desktop probe was not stopped before LabVIEW');
  assert.equal(network.status, 'passed', 'private container-network preflight did not pass');
  assert.deepEqual(network.dockerPublishedPorts, [], 'Docker-published ports were present');
  assert.deepEqual(network.dockerPortOutput, [], 'docker port reported a publication');
  assert.equal(network.directProbe.connected, true, 'host could not reach the private container listener');
  assert.equal(relay.bound.address, '127.0.0.1', 'relay was not bound to IPv4 loopback');
  assert.equal(relay.bound.family, 'IPv4');
  assert.equal(relay.bound.requestedPort, 0, 'relay did not request an ephemeral port');
  assert.equal(relay.upstream.host, network.target.ipAddress, 'relay upstream did not match the current container IP');
  assert.equal(relay.upstream.port, 5900);
  assert.ok(relay.stats.acceptedConnections > 0, 'relay accepted no RFB connection');
  assert.ok(relay.stats.downstreamToUpstreamBytes > 0, 'relay sent no bytes to TightVNC');
  assert.ok(relay.stats.upstreamToDownstreamBytes > 0, 'relay returned no bytes from TightVNC');
  assert.ok(relay.listenerBindings.length > 0 && relay.listenerBindings.every((binding) => binding.localAddress === '127.0.0.1'));
  assert.equal(relay.cleanup.closed, true, 'relay did not close');
  assert.deepEqual(relay.cleanup.listenerBindingsAfterClose, [], 'relay listener remained after close');
  assert.equal(manifest.relay.bound.port, relay.bound.port, 'manifest relay endpoint disagrees with relay evidence');
  assert.equal(benchmark.sourceDetail.uniqueFingerprintCount, summary.fingerprintSummary.uniqueFingerprintCount);
  assert.ok(Array.isArray(resources.samples) && resources.samples.length === summary.resourceSampleCount && resources.samples.length > 0);
  validateMonotonicFrames(launchCapture.frames.map((frame) => ({
    index: frame.index,
    ms: launchCapture.startMs + frame.tMs,
  })));

  const launchSpan = benchmark.spans.find((span) => span.id === 'launchMs');
  assert.ok(Number.isFinite(launchSpan?.ms) && launchSpan.ms > 0, 'launchMs must be finite and positive');
  assert.equal(
    launchSpan.ms,
    benchmark.sourceDetail.settleMs - benchmark.sourceDetail.workloadStartMs,
    'launchMs does not match trigger-to-settle timestamps',
  );
  assert.equal(launchSpan.ms, summary.launchMs, 'launchMs disagrees with capture summary');

  for (const role of ['initial', 'transition', 'settled']) {
    const representative = summary.representatives[role];
    assert.ok(representative, `${role} representative missing`);
    const png = path.join(root, representative.path);
    const decoded = decodePng(readFileSync(png));
    assert.equal(decoded.width, summary.rfb.width, `${role} PNG width mismatch`);
    assert.equal(decoded.height, summary.rfb.height, `${role} PNG height mismatch`);
    assert.equal(analyzePixels(decoded.rgba, decoded.width, decoded.height).passed, true, `${role} PNG pixel proof failed`);
    assert.equal(sha256(png), representative.sha256, `${role} PNG hash disagrees with summary`);
    if (role === 'settled') {
      assert.equal(dhash64FromRgba(decoded.rgba, decoded.width, decoded.height), representative.dhashHex, 'settled PNG fingerprint mismatch');
      assert.equal(representative.dhashHex, benchmark.frames[0].perceptualFingerprint, 'settled benchmark fingerprint mismatch');
    }
  }
  assert.ok(summary.representatives.transition.frameIndex >= 0);
  assert.ok(summary.representatives.settled.monotonicMs > summary.workloadStartMs);
  return {
    outcome: 'passed',
    files: manifest.files.length,
    frameCount: summary.frameCount,
    launchMs: summary.launchMs,
  };
}

const [command, runDirectory] = process.argv.slice(2);
if (!['--finalize-and-verify', '--verify'].includes(command) || !runDirectory) {
  console.error('Usage: node verify-evidence.mjs <--finalize-and-verify|--verify> <run-directory>');
  process.exitCode = 2;
} else {
  const root = path.resolve(runDirectory);
  if (command === '--finalize-and-verify') finalize(root);
  const result = verify(root);
  console.log(JSON.stringify(result));
}
