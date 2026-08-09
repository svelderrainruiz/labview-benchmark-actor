#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultVagrantfile = join(repoRoot, 'cleanroom', 'ubuntu-labview', 'production-golden-box.Vagrantfile');
const defaultMetadata = join(repoRoot, 'cleanroom', 'ubuntu-labview', 'production-golden-box.metadata.json');
const defaultProof = join(repoRoot, 'cleanroom', 'ubuntu-labview', 'production-golden-base-proof.json');

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function validateBaseBootstrapReceipt(receipt) {
  const failures = [];
  if (receipt?.schema !== 'labview-benchmark-actor/ubuntu-base-bootstrap@1') failures.push('base receipt schema is invalid');
  if (receipt?.outcome !== 'PASS') failures.push('base receipt outcome must be PASS');
  if (!Array.isArray(receipt?.failures) || receipt.failures.length !== 0) failures.push('base receipt failures must be empty');
  if (receipt?.os?.version !== '24.04') failures.push('base receipt must identify Ubuntu 24.04');
  if (!receipt?.vm?.name || !receipt?.vm?.uuid) failures.push('base receipt VM identity is incomplete');
  const requiredTools = [
    ['git', '/usr/bin/git'],
    ['sshd', '/usr/sbin/sshd'],
    ['virtualBoxGuestService', '/usr/sbin/VBoxService'],
  ];
  for (const [name, expectedPath] of requiredTools) {
    const tool = receipt?.tools?.[name];
    if (tool?.path !== expectedPath || !tool?.version) failures.push(`base receipt tool is invalid: ${name}`);
  }
  for (const name of ['ssh', 'virtualBoxGuestUtils']) {
    const service = receipt?.services?.[name];
    if (service?.activeState !== 'active' || service?.enabledState !== 'enabled') {
      failures.push(`base receipt service is not active and enabled: ${name}`);
    }
  }
  for (const name of ['install', 'firstBootValidation']) {
    const timing = receipt?.timings?.[name];
    if (!/^\d+$/.test(timing?.durationNs ?? '') || timing?.monotonicClockSource !== 'python.time.monotonic_ns') {
      failures.push(`base receipt timing is invalid: ${name}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function validateGoldenBoxDefinition({ metadata, vagrantfile }) {
  const failures = [];
  if (metadata?.schema !== 'labview-benchmark-actor/ubuntu-production-golden-definition@1') {
    failures.push('golden metadata schema is invalid');
  }
  if (metadata?.definition?.path !== 'cleanroom/ubuntu-labview/production-golden-box.Vagrantfile') {
    failures.push('golden metadata definition path is invalid');
  }
  if (metadata?.definition?.sha256 !== sha256(vagrantfile)) failures.push('golden Vagrantfile digest does not match metadata');
  if (metadata?.guest?.os !== 'ubuntu-24.04'
      || metadata?.guest?.communicator !== 'ssh'
      || metadata?.guest?.username !== 'actor'
      || metadata?.guest?.insertKey !== true) {
    failures.push('golden guest contract is invalid');
  }
  if (metadata?.bootstrap?.receiptPath !== '/var/lib/lba-cleanroom/base-bootstrap-receipt.json'
      || metadata?.bootstrap?.receiptSchema !== 'labview-benchmark-actor/ubuntu-base-bootstrap@1') {
    failures.push('golden bootstrap receipt contract is invalid');
  }
  const requiredGuards = ['baseBootstrap', 'consoleReadiness', 'activation', 'identityFreshness'];
  if (!requiredGuards.every((guard) => metadata?.packageGuards?.includes(guard))) {
    failures.push('golden package guards are incomplete');
  }
  const requiredVagrantMarkers = [
    'config.vm.communicator = "ssh"',
    'config.vm.guest = :ubuntu',
    'config.vm.boot_timeout = 1800',
    'config.ssh.username = "actor"',
    'config.ssh.insert_key = true',
    'verify-lba-base',
    '/var/lib/lba-cleanroom/base-bootstrap-receipt.json',
    'systemctl is-active --quiet ssh.service',
    'systemctl is-enabled --quiet virtualbox-guest-utils.service',
    'LBA Ubuntu base receipt is missing or stale',
  ];
  for (const marker of requiredVagrantMarkers) {
    if (!vagrantfile.includes(marker)) failures.push(`golden Vagrantfile marker is missing: ${marker}`);
  }
  if (/password|token|private.?key/i.test(JSON.stringify(metadata))) failures.push('golden metadata must not contain secret-bearing fields');
  return { ok: failures.length === 0, failures };
}

function canonicalProof(proof) {
  const { digest: _digest, ...canonical } = proof;
  return canonical;
}

export function validateGoldenBaseProof(proof, { metadataText, vagrantfileText }) {
  const failures = [];
  if (proof?.schema !== 'labview-benchmark-actor/ubuntu-golden-base-proof@1') failures.push('golden proof schema is invalid');
  if (!/^[a-f0-9]{40}$/.test(proof?.source?.commit ?? '')) failures.push('golden proof source commit is invalid');
  if (proof?.vm?.disposable !== true || !proof?.vm?.name || !proof?.vm?.uuid) failures.push('golden proof VM identity is invalid');
  if (proof?.graphicalLoginPerformed !== false) failures.push('golden proof must not perform a graphical login');
  if (proof?.natForward?.hostAddress !== '127.0.0.1'
      || !Number.isInteger(proof?.natForward?.hostPort)
      || proof.natForward.hostPort < 1024
      || proof.natForward.hostPort > 65535
      || proof?.natForward?.guestPort !== 22) {
    failures.push('golden proof NAT forward is invalid');
  }
  if (!Number.isInteger(proof?.polling?.intervalSeconds)
      || proof.polling.intervalSeconds < 1
      || !Number.isInteger(proof?.polling?.timeoutSeconds)
      || proof.polling.timeoutSeconds < proof.polling.intervalSeconds) {
    failures.push('golden proof bounded polling contract is invalid');
  }
  if (!/^\d+$/.test(proof?.timings?.vmRunningToSshReadyNs ?? '')
      || proof?.timings?.hostMonotonicClockSource !== 'System.Diagnostics.Stopwatch') {
    failures.push('golden proof host monotonic timing is invalid');
  }
  if (proof?.definition?.vagrantfileSha256 !== sha256(vagrantfileText)
      || proof?.definition?.metadataSha256 !== sha256(metadataText)) {
    failures.push('golden proof definition hashes are invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(proof?.evidence?.baseBootstrapReceiptSha256 ?? '')) {
    failures.push('golden proof base receipt digest is invalid');
  }
  if (!Array.isArray(proof?.screenshots) || proof.screenshots.length === 0
      || proof.screenshots.some((item) => !item.path || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ''))) {
    failures.push('golden proof screenshot index is invalid');
  }
  if (proof?.cleanup?.outcome !== 'PASS'
      || proof?.cleanup?.vmUnregistered !== true
      || proof?.cleanup?.residualVmPathRemoved !== true
      || proof?.cleanup?.credentialArtifactsRemoved !== true) {
    failures.push('golden proof cleanup is incomplete');
  }
  if (proof?.outcome !== 'PASS' || !Array.isArray(proof?.failures) || proof.failures.length !== 0) {
    failures.push('golden proof outcome is not PASS');
  }
  if (proof?.digest !== sha256(JSON.stringify(canonicalProof(proof)))) failures.push('golden proof digest is invalid');
  return { ok: failures.length === 0, failures };
}

function report(label, result) {
  if (result.ok) {
    console.log(`${label}: PASS`);
    return;
  }
  console.error(`${label}: FAIL`);
  for (const failure of result.failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--base-receipt') {
    if (!args[1]) throw new Error('--base-receipt requires a path');
    report('ubuntu base bootstrap receipt', validateBaseBootstrapReceipt(JSON.parse(readFileSync(resolve(args[1]), 'utf8'))));
    return;
  }
  const metadataText = readFileSync(defaultMetadata, 'utf8');
  const vagrantfileText = readFileSync(defaultVagrantfile, 'utf8');
  report('ubuntu production golden definition', validateGoldenBoxDefinition({
    metadata: JSON.parse(metadataText),
    vagrantfile: vagrantfileText,
  }));
  if (existsSync(defaultProof)) {
    report('ubuntu production golden base proof', validateGoldenBaseProof(JSON.parse(readFileSync(defaultProof, 'utf8')), {
      metadataText,
      vagrantfileText,
    }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
