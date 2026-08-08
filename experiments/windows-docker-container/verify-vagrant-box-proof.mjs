#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { evaluateVagrantBoxConsumerProof, hashFileSha256, verifyLiveChecks } from './vagrant-box-proof-core.mjs';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function resolvePath(baseDir, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

async function verifyArtifact(ref, baseDir) {
  const absolute = resolvePath(baseDir, ref.path);
  const stat = statSync(absolute);
  if (stat.size !== ref.size) {
    throw new Error(`${ref.path}: size mismatch (expected ${ref.size}, got ${stat.size})`);
  }
  const actual = await hashFileSha256(absolute);
  if (actual !== ref.sha256) {
    throw new Error(`${ref.path}: SHA-256 mismatch`);
  }
  return { path: ref.path, size: stat.size, sha256: actual };
}

async function verifyReceipt(receiptFile) {
  const absoluteReceipt = path.resolve(receiptFile);
  const baseDir = path.dirname(absoluteReceipt);
  const receipt = readJson(absoluteReceipt);
  const proof = evaluateVagrantBoxConsumerProof(receipt);
  if (!['passed', 'activation-required'].includes(proof.status)) {
    throw new Error(`Vagrant box consumer proof is ${proof.status}: ${proof.reason}`);
  }
  const artifacts = [];
  for (const ref of proof.evidenceRefs) artifacts.push(await verifyArtifact(ref, baseDir));
  const liveChecks = receipt.liveChecks ? verifyLiveChecks(receipt) : [];
  return {
    schema: proof.schema,
    status: proof.status,
    reason: proof.reason,
    package: proof.package,
    registration: proof.registration,
    artifacts,
    liveChecks,
  };
}

const [command, receiptFile] = process.argv.slice(2);
if (!['--verify', '--finalize-and-verify'].includes(command) || !receiptFile) {
  console.error('Usage: node verify-vagrant-box-proof.mjs <--verify|--finalize-and-verify> <receipt.json>');
  process.exitCode = 2;
} else {
  try {
    const result = await verifyReceipt(receiptFile);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
