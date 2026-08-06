#!/usr/bin/env node
// Mesh-actor registration, gated on activation (LBA-REQ-039, realizes ADR-0023 Phase 1). ADR-0023's
// onboarding invariant is: confirm LabVIEW activation BEFORE registering the VM as a mesh actor. This module
// enforces that fail-closed -- it will only emit a golden mesh-actors.csv row when the activation-receipt@1
// validates as ACTIVATED (buildActivationReceipt.mjs). An unactivated / tampered receipt is REFUSED.
//
// Registry schema (cleanroom/ubuntu-labview/mesh-actors.csv):
//   role,actor_id,hostname,username,ip,tcp_port,udp_port,node_type,password
// The real mesh-actors.csv is gitignored and its passwords are AGENT-generated locally; this module only
// composes the row deterministically (password stays the AGENT_GENERATED placeholder).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validateActivationReceipt } from './buildActivationReceipt.mjs';

export const REGISTRY_HEADER = 'role,actor_id,hostname,username,ip,tcp_port,udp_port,node_type,password';
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_PATH = join(here, '..', '..', 'cleanroom', 'ubuntu-labview', 'mesh-actors.csv');
export const GOLDEN_DEFAULTS = {
  role: 'golden', actor_id: 'golden', hostname: 'actor', username: 'actor',
  ip: '192.168.56.10', tcp_port: '7420', udp_port: '7421', node_type: 'both', password: 'AGENT_GENERATED',
};
const COLS = ['role', 'actor_id', 'hostname', 'username', 'ip', 'tcp_port', 'udp_port', 'node_type', 'password'];

export function describeActivationEvidence(receipt) {
  const validation = validateActivationReceipt(receipt);
  if (!validation.ok) {
    return {
      eligible: false,
      status: 'invalid-receipt',
      nextStep: 'Do not enroll. Rebuild the activation receipt from the current raw capture, then rerun enrollment.',
      findings: validation.findings,
    };
  }
  if (validation.activated) {
    return {
      eligible: true,
      status: 'activated',
      nextStep: 'Activation is confirmed. Enrollment may write the local mesh actor registry.',
      findings: [],
    };
  }
  const result = receipt.result || {};
  if (result.exitCode === 139) {
    return {
      eligible: false,
      status: 'probe-crashed',
      nextStep: 'Do not enroll or retry automatically. Repair public headless prerequisites, reboot the VM if needed, then run one new confirmation probe.',
      findings: [],
    };
  }
  if (result.exitCode !== 0) {
    return {
      eligible: false,
      status: 'activation-unconfirmed',
      nextStep: 'Do not enroll. Complete the user-only LabVIEW/VIPM activation in the VM, then run a new functional confirmation probe.',
      findings: [],
    };
  }
  if (result.operationSucceeded !== true) {
    return {
      eligible: false,
      status: 'probe-incomplete',
      nextStep: 'Do not enroll. The probe did not report RunVI success; inspect LabVIEWCLI and VI Server readiness, then rebuild evidence from a new probe.',
      findings: [],
    };
  }
  return {
    eligible: false,
    status: 'known-answer-mismatch',
    nextStep: 'Do not enroll. The functional known-answer result was not confirmed; repair the LabVIEW installation before a new probe.',
    findings: [],
  };
}

// Register the golden VM as a mesh actor -- ONLY if its activation receipt confirms activation.
// Idempotent: re-registering the same role+actor_id replaces the row rather than duplicating it.
export function registerGoldenActor({ receipt, registry = '', actor = {} } = {}) {
  const evidence = describeActivationEvidence(receipt);
  if (!evidence.eligible) {
    return {
      ok: false, refused: true, csv: registry, row: null,
      findings: ['activation not confirmed — refusing to register the golden VM as a mesh actor', evidence.nextStep, ...evidence.findings],
    };
  }
  const row = { ...GOLDEN_DEFAULTS, ...actor };
  const cells = COLS.map((c) => String(row[c]));

  const lines = String(registry).split(/\r?\n/);
  const comments = lines.filter((l) => l.trim().startsWith('#'));
  const data = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
  const rows = data
    .filter((l) => !l.startsWith('role,actor_id'))            // drop any existing header
    .map((l) => l.split(','))
    .filter((c) => `${c[0]}/${c[1]}` !== `${row.role}/${row.actor_id}`); // dedup by role+actor_id
  rows.push(cells);
  // deterministic order: golden first, then mesh rows by numeric actor_id
  rows.sort((a, b) => (a[0] === b[0] ? String(a[1]).localeCompare(String(b[1]), undefined, { numeric: true }) : a[0] === 'golden' ? -1 : 1));

  const csv = [...comments, REGISTRY_HEADER, ...rows.map((c) => c.join(','))].join('\n') + '\n';
  return { ok: true, refused: false, csv, row, findings: [] };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) args[key] = true;
    else { args[key] = value; index += 1; }
  }
  return args;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(`registration refused: ${error.message}`);
    process.exit(2);
  }
  if (args.help) {
    console.log('usage: node registerMeshActor.mjs --receipt <activation-receipt.json> [--registry <mesh-actors.csv>] [--role golden] [--actor-id golden] [--hostname actor] [--username actor] [--ip 192.168.56.10] [--tcp-port 7420] [--udp-port 7421] [--node-type both]');
    console.log('The command never accepts a password; the local provisioning flow generates it separately.');
    process.exit(0);
  }
  const allowed = new Set(['help', 'receipt', 'registry', 'role', 'actor-id', 'hostname', 'username', 'ip', 'tcp-port', 'udp-port', 'node-type']);
  const unknown = Object.keys(args).find((key) => !allowed.has(key));
  if (unknown) {
    console.error(`registration refused: unsupported --${unknown}; enrollment never accepts credentials or passwords`);
    process.exit(2);
  }
  if (typeof args.receipt !== 'string' || !args.receipt) {
    console.error('usage: node registerMeshActor.mjs --receipt <activation-receipt.json> [--registry <mesh-actors.csv>]');
    process.exit(2);
  }

  const receiptPath = resolve(args.receipt);
  const registryPath = typeof args.registry === 'string' ? resolve(args.registry) : DEFAULT_REGISTRY_PATH;
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch (error) {
    console.error(`registration refused: cannot read activation receipt ${receiptPath}: ${error.message}`);
    process.exit(1);
  }
  let registry = '';
  try { if (existsSync(registryPath)) registry = readFileSync(registryPath, 'utf8'); } catch (error) {
    console.error(`registration refused: cannot read local registry ${registryPath}: ${error.message}`);
    process.exit(1);
  }
  const actor = {
    ...(typeof args.role === 'string' ? { role: args.role } : {}),
    ...(typeof args['actor-id'] === 'string' ? { actor_id: args['actor-id'] } : {}),
    ...(typeof args.hostname === 'string' ? { hostname: args.hostname } : {}),
    ...(typeof args.username === 'string' ? { username: args.username } : {}),
    ...(typeof args.ip === 'string' ? { ip: args.ip } : {}),
    ...(typeof args['tcp-port'] === 'string' ? { tcp_port: args['tcp-port'] } : {}),
    ...(typeof args['udp-port'] === 'string' ? { udp_port: args['udp-port'] } : {}),
    ...(typeof args['node-type'] === 'string' ? { node_type: args['node-type'] } : {}),
  };
  const result = registerGoldenActor({ receipt, registry, actor });
  if (!result.ok) {
    console.error(`registration refused: ${result.findings.join('; ')}`);
    process.exit(1);
  }
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, result.csv);
  console.log(`golden actor registered locally: ${result.row.actor_id} -> ${registryPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
