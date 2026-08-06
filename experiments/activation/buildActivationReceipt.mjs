#!/usr/bin/env node
// activation-receipt@1 builder + validator (LBA-REQ-038, realizes ADR-0023 Phase 1). Turns a raw
// activation-capture (from probe-activation.sh running `LabVIEWCLI -OperationName RunVI` on the shipped
// known-answer AddTwoNumbers.vi) into a deterministic activation receipt, and validates the verdict.
//
// The confirmation is FUNCTIONAL, not license-file parsing: LabVIEW is ACTIVATED iff it actually executed
// the probe VI and returned the known answer (inputs A B -> A+B) with a clean exit. That is the robust
// signal chosen in ADR-0023: an unactivated / broken install cannot return the correct sum.
//
// Deterministic by construction: the digest covers only the verdict-bearing fields (inputs, expected +
// parsed output, exit code, operation success, VI name, LabVIEW version), NOT volatile capture facts
// (wall time, temp-log path, TCP port), so a committed receipt replays offline byte-stably in CI.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/activation-receipt@1';

// Parse the LabVIEWCLI RunVI stdout: the numeric "Operation output:" value + the success line + LV version.
export function parseProbeOutput(text) {
  const t = String(text || '');
  const outMatch = t.match(/Operation output:\s*\r?\n\s*(-?\d+)/);
  const succeeded = /RunVI operation succeeded\./i.test(t);
  const lvMatch = t.match(/LabVIEW-(\d{4})-\d+/) || t.match(/LabVIEW[ :]+"?[^"\n]*LabVIEW-(\d{4})/);
  return {
    parsedOutput: outMatch ? Number(outMatch[1]) : null,
    operationSucceeded: succeeded,
    labviewVersion: lvMatch ? lvMatch[1] : null,
  };
}

// Canonical, deterministic verdict-bearing view (the digest input) — no wall time / port / temp paths.
function canonical(receipt) {
  const p = receipt?.probe, r = receipt?.result, h = receipt?.host;
  return JSON.stringify({
    schema: receipt?.schema,
    probe: { viName: p?.viName, inputs: p?.inputs, expectedOutput: p?.expectedOutput, knownAnswer: p?.knownAnswer },
    result: { exitCode: r?.exitCode, operationSucceeded: r?.operationSucceeded, parsedOutput: r?.parsedOutput },
    host: { os: h?.os, labviewVersion: h?.labviewVersion, ...(h?.bootId ? { bootId: h.bootId } : {}) },
    ...(receipt?.actor ? { actor: receipt.actor } : {}),
    ...(receipt?.freshness !== undefined ? { freshness: { challenge: receipt?.freshness?.challenge } } : {}),
    verdict: { activated: receipt?.verdict?.activated },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// The verdict rule: ACTIVATED iff the known-answer probe executed cleanly and returned the expected sum.
export function decideActivated({ exitCode, operationSucceeded, parsedOutput, expectedOutput, knownAnswer }) {
  return knownAnswer === true && exitCode === 0 && operationSucceeded === true &&
    parsedOutput != null && parsedOutput === expectedOutput;
}

// Build an activation-receipt@1 from a raw activation-capture@1 (or equivalent fields).
export function buildActivationReceipt(capture) {
  const inputs = capture.inputs || [];
  const expectedOutput = capture.expectedOutput ?? inputs.reduce((a, b) => a + b, 0);
  const parsed = parseProbeOutput(capture.output);
  const viName = basename(capture.probeVi || 'AddTwoNumbers.vi');
  const os = capture.host?.os || 'linux';
  const labviewVersion = parsed.labviewVersion || capture.labviewVersion || null;
  const bootId = typeof capture.host?.bootId === 'string' && capture.host.bootId.trim() ? capture.host.bootId.trim().toLowerCase() : null;
  const activationChallenge = capture.freshness?.challenge;
  const freshness = activationChallenge === undefined ? undefined : { challenge: String(activationChallenge).trim().toLowerCase() };
  const actor = capture.actor && ['actorId', 'hostname', 'ip'].every((field) => typeof capture.actor[field] === 'string' && capture.actor[field].trim());
  const result = {
    exitCode: capture.exitCode,
    operationSucceeded: parsed.operationSucceeded,
    parsedOutput: parsed.parsedOutput,
  };
  const activated = decideActivated({
    exitCode: result.exitCode, operationSucceeded: result.operationSucceeded,
    parsedOutput: result.parsedOutput, expectedOutput, knownAnswer: true,
  });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    probe: {
      operation: 'LabVIEWCLI -OperationName RunVI',
      viName, inputs, expectedOutput, knownAnswer: true,
    },
    result,
    host: { os, labviewVersion, ...(bootId ? { bootId } : {}) },
    ...(actor ? { actor: { actorId: capture.actor.actorId.trim(), hostname: capture.actor.hostname.trim(), ip: capture.actor.ip.trim() } } : {}),
    ...(freshness ? { freshness } : {}),
    verdict: {
      activated,
      reason: activated
        ? `RunVI executed the known-answer probe ${viName} (${inputs.join(' + ')}) and returned ${result.parsedOutput} with exit 0`
        : 'the known-answer probe did not execute cleanly or returned the wrong value — LabVIEW is not confirmed activated',
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed receipt: schema, digest integrity, and that the verdict matches the rule.
export function validateActivationReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  const p = receipt?.probe, r = receipt?.result, h = receipt?.host;
  if (!p || !r || !h || !receipt?.verdict) return { ok: false, activated: false, findings: findings.concat('missing probe/result/host/verdict') };
  if (p.knownAnswer !== true) findings.push('probe.knownAnswer must be true (functional activation proof)');
  if (h.bootId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(h.bootId))) {
    findings.push('host.bootId must be a Linux boot UUID when present');
  }
  if (receipt.actor !== undefined && (!receipt.actor || ['actorId', 'hostname', 'ip'].some((field) => typeof receipt.actor[field] !== 'string' || !receipt.actor[field].trim()))) {
    findings.push('actor identity must contain non-empty actorId, hostname, and ip strings');
  }
  if (receipt.freshness !== undefined && (!receipt.freshness || !/^[a-f0-9]{32}$/.test(String(receipt.freshness.challenge)))) {
    findings.push('freshness.challenge must be a 32-character lowercase hexadecimal host challenge when present');
  }
  const expectedVerdict = decideActivated({
    exitCode: r.exitCode, operationSucceeded: r.operationSucceeded,
    parsedOutput: r.parsedOutput, expectedOutput: p.expectedOutput, knownAnswer: p.knownAnswer,
  });
  if (receipt.verdict.activated !== expectedVerdict) findings.push(`verdict.activated=${receipt.verdict.activated} contradicts the rule (${expectedVerdict})`);
  try {
    if (receipt.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  } catch {
    findings.push('receipt digest-bearing fields are malformed');
  }
  return { ok: findings.length === 0, activated: !!receipt.verdict.activated && findings.length === 0, findings };
}

function main() {
  const [, , ...args] = process.argv;
  if (args[0] === '--validate') {
    if (args.length !== 2) {
      console.error('usage: node buildActivationReceipt.mjs --validate <receipt.json>');
      process.exit(2);
    }
    let receipt;
    try {
      receipt = JSON.parse(readFileSync(args[1], 'utf8'));
    } catch (error) {
      console.error(`activation receipt: cannot read ${args[1]}: ${error.message}`);
      process.exit(1);
    }
    const result = validateActivationReceipt(receipt);
    if (!result.ok) {
      console.error(`activation receipt: INVALID: ${result.findings.join('; ')}`);
      process.exit(1);
    }
    console.log(`activation receipt: ${result.activated ? 'ACTIVATED' : 'UNCONFIRMED'}`);
    process.exit(result.activated ? 0 : 1);
  }
  const [capturePath, receiptPath] = args;
  if (!capturePath || !receiptPath) {
    console.error('usage: node buildActivationReceipt.mjs <capture.json> <receipt.json> | --validate <receipt.json>');
    process.exit(2);
  }
  const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  if (capture.schema !== 'labview-benchmark-actor/activation-capture@1') {
    console.error('activation receipt: unsupported capture schema');
    process.exit(1);
  }
  const receipt = buildActivationReceipt(capture);
  const result = validateActivationReceipt(receipt);
  if (!result.ok) {
    console.error(`activation receipt: invalid generated receipt: ${result.findings.join('; ')}`);
    process.exit(1);
  }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`activation receipt: ${result.activated ? 'ACTIVATED' : 'UNCONFIRMED'}`);
  process.exit(result.activated ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
