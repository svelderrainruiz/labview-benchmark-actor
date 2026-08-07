#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { deriveTransportReplay, validateTransportReplay } from './transport-replay-core.mjs';

const file = process.argv[2];
const repoRootOption = process.argv.indexOf('--repo-root');
const explicitRepoRoot = repoRootOption >= 0 ? process.argv[repoRootOption + 1] : null;
if (!file) {
  console.error('Usage: node verify-transport-replay.mjs <transport-replay.json> [--repo-root <path>]');
  process.exitCode = 2;
} else {
  if (repoRootOption >= 0 && !explicitRepoRoot) throw new Error('--repo-root requires a path');
  const repoRoot = explicitRepoRoot
    ? path.resolve(explicitRepoRoot)
    : path.resolve(import.meta.dirname, '..', '..');
  const record = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  validateTransportReplay(record);
  const sources = Object.fromEntries(record.sources.map((source) => [source.role, source]));
  const bytesByRole = {};
  for (const source of record.sources) {
    const absolute = path.isAbsolute(source.path) ? source.path : path.join(repoRoot, source.path);
    const bytes = readFileSync(absolute);
    assert.equal(statSync(absolute).size, source.size, `${source.path}: size mismatch`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      source.sha256,
      `${source.path}: SHA-256 mismatch`,
    );
    bytesByRole[source.role] = bytes;
  }
  const json = (role) => JSON.parse(bytesByRole[role].toString('utf8'));
  const logBytes = bytesByRole.tightVncLog;
  const tightVncLog = logBytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
    ? logBytes.subarray(2).toString('utf16le')
    : logBytes.toString('utf8');
  const derived = deriveTransportReplay({
    manifest: json('manifest'),
    failureReceipt: json('failureReceipt'),
    networkPreflight: json('networkPreflight'),
    networkRelay: json('networkRelay'),
    cleanupVerification: json('cleanupVerification'),
    tightVncLog,
    sources,
  });
  assert.deepEqual(record, derived, 'transport replay drifted from immutable evidence');
  console.log(JSON.stringify({
    outcome: record.benchmarkOutcome,
    directProbeMs: record.transport.directProbeMs,
    relayCleanupMs: record.transport.relayCleanupMs,
    totalRelayBytes: record.transport.totalRelayBytes,
    rfbUpdates: record.rfb.updateCount,
    framePolls: record.rfb.observedFramePollCount,
    visualFramesEncoded: record.mprr.visualFramesEncoded,
    interactiveDisplay: record.capabilities.interactiveWindowsContainerDisplay,
  }));
}
