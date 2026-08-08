#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from '../manual-procedure-record/capture-adapter.mjs';
import { deriveTransportReplay, validateTransportReplay } from './transport-replay-core.mjs';
import { analyzePixels } from './experiment-core.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const defaultRunRoot = path.join(
  import.meta.dirname,
  'evidence',
  '20260807T235142020Z-dfc7f09404',
);
const defaultOutput = path.join(
  import.meta.dirname,
  'decisions',
  'windows-container-rfb-transport-replay.json',
);
const runRoot = path.resolve(process.argv[2] ?? defaultRunRoot);
const output = path.resolve(process.argv[3] ?? defaultOutput);

const sourceFiles = {
  manifest: 'manifest.json',
  failureReceipt: 'failure-receipt.json',
  networkPreflight: 'network-preflight.json',
  networkRelay: 'network-relay.json',
  cleanupVerification: 'cleanup-verification.json',
  tightVncLog: 'tvnserver.log',
  rfbImage: 'frames/transport-baseline-rfb.png',
  lbabusHostStage: 'lbabus-host-stage.json',
  lbabusContainer: 'lbabus-container.json',
};

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sourceRef(file, role) {
  const bytes = readFileSync(file);
  return {
    role,
    path: path.relative(repoRoot, file).replaceAll('\\', '/'),
    size: statSync(file).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const absolute = Object.fromEntries(
  Object.entries(sourceFiles).map(([role, name]) => [role, path.join(runRoot, name)]),
);
const sources = Object.fromEntries(
  Object.entries(absolute).map(([role, file]) => [role, sourceRef(file, role)]),
);
const tightLogBytes = readFileSync(absolute.tightVncLog);
const tightVncLog = tightLogBytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
  ? tightLogBytes.subarray(2).toString('utf16le')
  : tightLogBytes.toString('utf8');
const rfbImageDecoded = decodePng(readFileSync(absolute.rfbImage));

const record = deriveTransportReplay({
  manifest: readJson(absolute.manifest),
  failureReceipt: readJson(absolute.failureReceipt),
  networkPreflight: readJson(absolute.networkPreflight),
  networkRelay: readJson(absolute.networkRelay),
  cleanupVerification: readJson(absolute.cleanupVerification),
  tightVncLog,
  rfbImage: {
    width: rfbImageDecoded.width,
    height: rfbImageDecoded.height,
    rgbaSha256: createHash('sha256').update(rfbImageDecoded.rgba).digest('hex'),
    analysis: analyzePixels(rfbImageDecoded.rgba, rfbImageDecoded.width, rfbImageDecoded.height),
  },
  lbabusHostStage: readJson(absolute.lbabusHostStage),
  lbabusContainer: readJson(absolute.lbabusContainer),
  sources,
});
validateTransportReplay(record);

const temporary = `${output}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
renameSync(temporary, output);
console.log(JSON.stringify({
  output,
  outcome: record.benchmarkOutcome,
  markers: record.mprr.markers.length,
  totalRelayBytes: record.transport.totalRelayBytes,
  visualFramesEncoded: record.mprr.visualFramesEncoded,
  diagnosticImageSha256: record.framebuffer.diagnosticImage.pngSha256,
}));
