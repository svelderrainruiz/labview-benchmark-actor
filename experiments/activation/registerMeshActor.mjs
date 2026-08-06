#!/usr/bin/env node
// Mesh-actor registration, gated on activation (LBA-REQ-039, realizes ADR-0023 Phase 1). ADR-0023's
// onboarding invariant is: confirm LabVIEW activation BEFORE registering the VM as a mesh actor. This module
// enforces that fail-closed -- it will only emit a golden mesh-actors.csv row when the activation-receipt@1
// validates as ACTIVATED (buildActivationReceipt.mjs). An unactivated / tampered receipt is REFUSED.
//
// Registry schema (cleanroom/ubuntu-labview/mesh-actors.csv):
//   role,actor_id,hostname,username,ip,tcp_port,udp_port,node_type,password
// The real mesh-actors.csv is gitignored and its passwords are AGENT-generated locally; this module only
// composes the row deterministically (password stays the AGENT_GENERATED placeholder). The CLI additionally
// challenges the current Vagrant guest boot/hostname/IP plus a post-confirmation challenge before it writes the
// registry, so an old receipt from a reverted or recreated actor cannot be replayed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validateActivationReceipt } from './buildActivationReceipt.mjs';

export const REGISTRY_HEADER = 'role,actor_id,hostname,username,ip,tcp_port,udp_port,node_type,password';
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_PATH = join(here, '..', '..', 'cleanroom', 'ubuntu-labview', 'mesh-actors.csv');
export const DEFAULT_VAGRANT_ROOT = join(here, '..', '..', 'cleanroom', 'ubuntu-labview', 'mesh');
export const ACTIVATION_CHALLENGE_PATH = '/var/lib/lba-golden-activation/challenge';
export const GOLDEN_DEFAULTS = {
  role: 'golden', actor_id: 'golden', hostname: 'actor', username: 'actor',
  ip: '192.168.56.10', tcp_port: '7420', udp_port: '7421', node_type: 'both', password: 'AGENT_GENERATED',
};
const COLS = ['role', 'actor_id', 'hostname', 'username', 'ip', 'tcp_port', 'udp_port', 'node_type', 'password'];

export function parseCurrentGuestIdentity(output) {
  const values = Object.fromEntries(String(output || '').split(/\r?\n/)
    .map((line) => line.split(/=(.*)/s))
    .filter(([key, value]) => key && value !== undefined)
    .map(([key, value]) => [key.trim(), value.trim()]));
  return {
    bootId: String(values.bootId || '').toLowerCase(),
    hostname: String(values.hostname || ''),
    ips: String(values.ips || '').split(/\s+/).filter(Boolean),
    activationChallenge: String(values.activationChallenge || '').toLowerCase(),
  };
}

export function verifyCurrentGuestIdentity({ receipt, guest } = {}) {
  const expected = receipt?.actor;
  const bootId = receipt?.host?.bootId;
  const activationChallenge = receipt?.freshness?.challenge;
  const findings = [];
  if (!expected || !bootId || !activationChallenge) findings.push('receipt lacks the guest identity, boot proof, or snapshot-resistant activation challenge required for enrollment');
  if (expected && guest?.hostname !== expected.hostname) findings.push('current guest hostname does not match the activation receipt');
  if (expected && !guest?.ips?.includes(expected.ip)) findings.push('current guest IP does not match the activation receipt');
  if (bootId && guest?.bootId !== bootId) findings.push('current guest boot ID does not match the activation receipt; run a fresh confirmation');
  if (activationChallenge && guest?.activationChallenge !== activationChallenge) findings.push('current guest activation challenge does not match the activation receipt; run a fresh confirmation');
  return { ok: findings.length === 0, findings };
}

export function readCurrentGuestIdentity({ vm, vagrantRoot = DEFAULT_VAGRANT_ROOT, run = execFileSync } = {}) {
  if (!vm) throw new Error('a Vagrant VM name is required to verify the current guest');
  const guestCommand = `activation_challenge="$(sudo -n cat ${ACTIVATION_CHALLENGE_PATH} 2>/dev/null || true)"; printf "bootId=%s\\nhostname=%s\\nips=%s\\nactivationChallenge=%s\\n" "$(cat /proc/sys/kernel/random/boot_id)" "$(hostname)" "$(hostname -I)" "$activation_challenge"`;
  const output = run('vagrant', ['ssh', vm, '-c', guestCommand], { cwd: vagrantRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return parseCurrentGuestIdentity(output);
}

export function enrollCurrentGoldenActor({ receipt, registry = '', actor = {}, vm, vagrantRoot = DEFAULT_VAGRANT_ROOT, run = execFileSync } = {}) {
  const evidence = describeActivationEvidence(receipt);
  if (!evidence.eligible) return registerGoldenActor({ receipt, registry, actor });
  const guest = readCurrentGuestIdentity({ vm, vagrantRoot, run });
  const current = verifyCurrentGuestIdentity({ receipt, guest });
  if (!current.ok) {
    return {
      ok: false, refused: true, csv: registry, row: null,
      findings: ['current guest does not satisfy the activation receipt', ...current.findings],
    };
  }
  return registerGoldenActor({ receipt, registry, actor });
}

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
    if (!receipt.actor) {
      return {
        eligible: false,
        status: 'missing-actor-identity',
        nextStep: 'Do not enroll. Run a new confirmation probe with the public LBA_ACTOR_ID, LBA_ACTOR_HOSTNAME, and LBA_ACTOR_IP identity values.',
        findings: [],
      };
    }
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

export function validateGoldenActorRow(row = {}) {
  const findings = [];
  const cellValues = Object.entries(row);
  for (const [field, value] of cellValues) {
    if (/[\r\n,]/.test(String(value))) findings.push(`${field} must not contain CSV delimiters or line breaks`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(String(row.hostname || ''))) findings.push('hostname must be a safe DNS-style value');
  if (!/^[a-z_][a-z0-9_-]*\$?$/.test(String(row.username || ''))) findings.push('username must be a safe Linux account name');
  const ipParts = String(row.ip || '').split('.');
  if (ipParts.length !== 4 || ipParts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) findings.push('ip must be an IPv4 address');
  for (const field of ['tcp_port', 'udp_port']) {
    const value = String(row[field] || '');
    if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) findings.push(`${field} must be a TCP/UDP port from 1 through 65535`);
  }
  if (!['source', 'sink', 'both'].includes(String(row.node_type || ''))) findings.push('node_type must be source, sink, or both');
  if (row.password !== 'AGENT_GENERATED') findings.push('password must remain the local AGENT_GENERATED placeholder');
  return { ok: findings.length === 0, findings };
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
  const identity = receipt.actor;
  const row = { ...GOLDEN_DEFAULTS, hostname: identity.hostname, ip: identity.ip, ...actor };
  if (row.role !== 'golden' || row.actor_id !== 'golden') {
    return {
      ok: false, refused: true, csv: registry, row: null,
      findings: ['golden enrollment only permits role=golden and actor_id=golden'],
    };
  }
  if (row.hostname !== identity.hostname || row.ip !== identity.ip || row.actor_id !== identity.actorId) {
    return {
      ok: false, refused: true, csv: registry, row: null,
      findings: ['receipt actor identity does not match the requested local golden actor'],
    };
  }
  const rowValidation = validateGoldenActorRow(row);
  if (!rowValidation.ok) {
    return {
      ok: false, refused: true, csv: registry, row: null,
      findings: ['golden actor overrides are not valid CSV-safe registry values', ...rowValidation.findings],
    };
  }
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
    console.log('usage: node registerMeshActor.mjs --receipt <activation-receipt.json> --vm <vagrant-vm> [--vagrant-root <mesh-dir>] [--registry <mesh-actors.csv>] [--role golden] [--actor-id golden] [--hostname actor] [--username actor] [--ip 192.168.56.10] [--tcp-port 7420] [--udp-port 7421] [--node-type both]');
    console.log('The requested golden actor identity must exactly match the public actor identity bound into the receipt.');
    console.log('The command never accepts a password; the local provisioning flow generates it separately.');
    process.exit(0);
  }
  const allowed = new Set(['help', 'receipt', 'registry', 'vm', 'vagrant-root', 'role', 'actor-id', 'hostname', 'username', 'ip', 'tcp-port', 'udp-port', 'node-type']);
  const unknown = Object.keys(args).find((key) => !allowed.has(key));
  if (unknown) {
    console.error(`registration refused: unsupported --${unknown}; enrollment never accepts credentials or passwords`);
    process.exit(2);
  }
  if (typeof args.receipt !== 'string' || !args.receipt || typeof args.vm !== 'string' || !args.vm) {
    console.error('usage: node registerMeshActor.mjs --receipt <activation-receipt.json> --vm <vagrant-vm> [--vagrant-root <mesh-dir>] [--registry <mesh-actors.csv>]');
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
  let result;
  try {
    result = enrollCurrentGoldenActor({ receipt, registry, actor, vm: args.vm, vagrantRoot: typeof args['vagrant-root'] === 'string' ? resolve(args['vagrant-root']) : DEFAULT_VAGRANT_ROOT });
  } catch (error) {
    console.error(`registration refused: cannot verify current guest ${args.vm}: ${error.message}`);
    process.exit(1);
  }
  if (!result.ok) {
    console.error(`registration refused: ${result.findings.join('; ')}`);
    process.exit(1);
  }
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, result.csv);
  console.log(`golden actor registered locally: ${result.row.actor_id} -> ${registryPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
