import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveTransportReplay } from './transport-replay-core.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'lba-transport-replay-'));
const evidenceRoot = path.join(
  root,
  'experiments',
  'windows-docker-container',
  'evidence',
  'selftest',
);
mkdirSync(evidenceRoot, { recursive: true });
const verifier = path.join(import.meta.dirname, 'verify-transport-replay.mjs');
const writeJson = (name, value) => {
  const file = path.join(evidenceRoot, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
const ref = (file, role) => {
  const bytes = readFileSync(file);
  return {
    role,
    path: path.relative(root, file).replaceAll('\\', '/'),
    size: statSync(file).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

try {
  const manifest = {
    runId: 'selftest',
    outcome: 'inconclusive',
    relay: {
      cleanup: {
        closed: true,
        listenerReachable: false,
        elapsedMs: 1,
        listenerBindingsAfterClose: [],
        closedWallTime: '2026-08-07T00:00:05.000Z',
      },
    },
  };
  const failureReceipt = {
    outcome: 'inconclusive',
    failedGate: 3,
    classification: 'black-or-uniform-framebuffer',
    wallTime: '2026-08-07T00:00:04.000Z',
    environment: {
      runId: 'selftest',
      image: {
        reference: 'nationalinstruments/labview:2026q3-windows',
        id: `sha256:${'2'.repeat(64)}`,
        expectedId: `sha256:${'2'.repeat(64)}`,
        os: 'windows',
        architecture: 'amd64',
      },
      container: { id: 'c1', isolation: 'process', dockerPublishedPorts: [] },
    },
    rfb: {
      width: 2,
      height: 2,
      rfbVersion: '3.8',
      securityType: 2,
      securityTypeName: 'VNC Authentication',
      updateCount: 1,
    },
    frameCount: 1,
    initialAnalysis: {
      passed: false,
      pixels: 4,
      blackFraction: 1,
      meaningfulLumaPopulations: 1,
      reason: 'single-color-or-single-luminance-population',
    },
  };
  const networkPreflight = {
    status: 'passed',
    containerId: 'c1',
    wallTime: '2026-08-07T00:00:01.000Z',
    target: { ipAddress: '172.20.0.2' },
    dockerPublishedPorts: [],
    directProbe: { connected: true, elapsedMs: 1, endpoint: '172.20.0.2:5900' },
  };
  const networkRelay = {
    status: 'rfb-traversed',
    readyWallTime: '2026-08-07T00:00:02.000Z',
    rfbTraversedWallTime: '2026-08-07T00:00:03.000Z',
    bound: { address: '127.0.0.1', family: 'IPv4', port: 49152 },
    upstream: { host: '172.20.0.2', port: 5900 },
    listenerBindings: [{ localAddress: '127.0.0.1', localPort: 49152 }],
    stats: {
      acceptedConnections: 1,
      successfulUpstreamConnections: 1,
      upstreamConnectionFailures: 0,
      downstreamErrors: 0,
      downstreamToUpstreamBytes: 1,
      upstreamToDownstreamBytes: 4,
      serverErrors: 0,
    },
  };
  const cleanupVerification = {
    wallTime: '2026-08-07T00:00:06.000Z',
    containerAbsent: true,
    relayListenerClosed: true,
    relayCleanupProven: true,
    vncPortClosed: true,
    secretDirectoryRemoved: true,
  };
  const files = {
    manifest: writeJson('manifest.json', manifest),
    failureReceipt: writeJson('failure-receipt.json', failureReceipt),
    networkPreflight: writeJson('network-preflight.json', networkPreflight),
    networkRelay: writeJson('network-relay.json', networkRelay),
    cleanupVerification: writeJson('cleanup-verification.json', cleanupVerification),
  };
  files.tightVncLog = path.join(evidenceRoot, 'tvnserver.log');
  writeFileSync(
    files.tightVncLog,
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(
        'The console desktop has 0 displays\nDesktop resize is disabled, sending blank screen\n',
        'utf16le',
      ),
    ]),
  );
  const sources = Object.fromEntries(
    Object.entries(files).map(([role, file]) => [role, ref(file, role)]),
  );
  const record = deriveTransportReplay({
    manifest,
    failureReceipt,
    networkPreflight,
    networkRelay,
    cleanupVerification,
    tightVncLog: 'The console desktop has 0 displays\nDesktop resize is disabled, sending blank screen\n',
    sources,
  });
  const receipt = writeJson('transport-replay.json', record);
  let result = spawnSync(process.execPath, [verifier, receipt, '--repo-root', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).visualFramesEncoded, 0);

  writeFileSync(files.cleanupVerification, '{}\n');
  result = spawnSync(process.execPath, [verifier, receipt, '--repo-root', root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'tampered evidence must fail verification');
  console.log('Windows container transport replay verifier self-test: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
