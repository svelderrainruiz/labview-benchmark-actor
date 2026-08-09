#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'labview-benchmark-actor/release-risk-closeout@1';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function closeoutDigest(closeout) {
  const { digest: _digest, ...body } = closeout;
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

export function missingProofIds(baseline) {
  return baseline.releaseEvidence.flatMap((gate) =>
    gate.proofs.filter((proof) => proof.status === 'missing').map((proof) => proof.id));
}

export function buildCloseout(input) {
  const closeout = {
    schema: SCHEMA,
    ...input,
  };
  closeout.digest = closeoutDigest(closeout);
  return closeout;
}

export function validateCloseout(closeout, baseline, { root = process.cwd() } = {}) {
  const findings = [];
  const expected = missingProofIds(baseline).sort();
  const resolutions = Array.isArray(closeout?.resolutions) ? closeout.resolutions : [];
  const resolved = resolutions.map((proof) => proof.id).sort();
  if (closeout?.schema !== SCHEMA) findings.push(`schema must be ${SCHEMA}`);
  if (closeout?.releaseVersion !== baseline?.releaseVersion) findings.push('release version must match the candidate-time baseline');
  if (new Set(resolved).size !== resolved.length) findings.push('resolution ids must be unique');
  if (JSON.stringify(resolved) !== JSON.stringify(expected)) findings.push('resolutions must cover every and only candidate-time missing proof id');
  for (const proof of resolutions) {
    if (proof.status !== 'present') findings.push(`${proof.id}: status must be present`);
    if (typeof proof.evidence !== 'string' || !proof.evidence.trim()) findings.push(`${proof.id}: evidence is required`);
    if (!Array.isArray(proof.artifacts) || proof.artifacts.length === 0) findings.push(`${proof.id}: at least one artifact is required`);
    for (const artifact of proof.artifacts ?? []) {
      if (/^https:\/\//.test(artifact)) continue;
      const resolvedPath = isAbsolute(artifact) ? artifact : join(root, artifact);
      if (!existsSync(resolvedPath)) findings.push(`${proof.id}: artifact does not resolve: ${artifact}`);
    }
  }
  const beforePresent = baseline.releaseEvidence.flatMap((gate) => gate.proofs).filter((proof) => proof.status === 'present').length;
  const total = baseline.releaseEvidence.flatMap((gate) => gate.proofs).length;
  if (closeout?.summary?.beforePresent !== beforePresent || closeout?.summary?.total !== total) {
    findings.push('summary baseline counters do not re-derive');
  }
  if (closeout?.summary?.afterPresent !== total || closeout?.summary?.completionPercent !== 100 || closeout?.summary?.status !== 'READY') {
    findings.push('closeout summary must report READY at 100%');
  }
  if (closeout?.candidate?.version !== baseline?.releaseVersion
    || !/^[0-9a-f]{40}$/.test(String(closeout?.candidate?.commit ?? ''))
    || !/^[0-9a-f]{64}$/.test(String(closeout?.candidate?.vsixSha256 ?? ''))) {
    findings.push('candidate identity is incomplete');
  }
  if (closeout?.release?.immutable !== true || closeout?.marketplace?.published !== true || closeout?.lineage?.shared !== true) {
    findings.push('immutable release, Marketplace publication, and shared lineage must all be proven');
  }
  if (closeout?.digest !== closeoutDigest(closeout ?? {})) findings.push('digest does not match closeout content');
  return { ok: findings.length === 0, findings, beforePresent, afterPresent: beforePresent + resolutions.length, total };
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(here, '..');
  const baselinePath = join(root, 'release-risk-baseline.json');
  const closeoutPath = join(root, 'release-risk-closeout.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (process.argv.includes('--seal')) {
    const draft = JSON.parse(readFileSync(closeoutPath, 'utf8'));
    writeFileSync(closeoutPath, `${JSON.stringify(buildCloseout(draft), null, 2)}\n`);
  }
  const closeout = JSON.parse(readFileSync(closeoutPath, 'utf8'));
  const result = validateCloseout(closeout, baseline, { root });
  if (!result.ok) {
    for (const finding of result.findings) console.error(`release-risk-closeout: ${finding}`);
    process.exit(1);
  }
  console.log(`release-risk-closeout: READY ${result.afterPresent}/${result.total} proofs for ${closeout.releaseVersion}`);
}
