#!/usr/bin/env node
// release-stage-win.mjs -- release phase 7 in one command (#73). Stages the candidate VSIX on the WIN reviewer VM,
// proves the VM holds the exact bytes, installs it, configures the per-version visual reviewer key, captures the VM's
// correlated DONE frame over `lbabus net`, records staged-frame-WIN-<v>.json, and binds the review target to the
// candidate and its corroboration evidence. It composes the existing pieces (await-agent-reply.mjs,
// record-release-stage.mjs, render-verdict.sh set-target) rather than re-implementing them.
//
// Usage:
//   node reviewer-workstation/release-stage-win.mjs <X.Y.Z> --vm <name> --commit <sha> --vsix <path> \
//        --attestation <attestation-X.Y.Z.json> [--share ~/lba-vm-share] [--visual-key <pem>] \
//        [--password-file ~/.config/lba/vm-pass] [--reviewer reviewer@vi-tech.nl] [--timeout 300] \
//        [--no-set-target] [--force] [--dry-run] [--host <address the guest reaches the host on, default 10.0.2.2>] \
//        [--candidate-root <checkout of the candidate, default this repository>]
//
// The VM password comes from --password-file (default ~/.config/lba/vm-pass) or LBA_VM_PASS. VBoxManage receives it
// as a --passwordfile, never on a command line, and it is never printed. Guest runs pass no argv0 after `--`: this
// VBoxManage build treats the first argument after `--` as the program's first real argument.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateReceipt as validateAttestation } from '../experiments/acg-quorum/cross-plane-attestation.mjs';
import { buildReleaseStage } from './record-release-stage.mjs';
import { reviewerInfrastructureEvidence } from '../scripts/verify-reviewer-infrastructure.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

export const GUEST_DIR = 'C:\\lba-review';
export const GUEST_VSIX = `${GUEST_DIR}\\candidate.vsix`;
export const GUEST_LBABUS = 'C:\\lba-tools\\lbabus\\lbabus.exe';
export const GUEST_NODE = 'C:\\Program Files\\nodejs\\node.exe';
export const GUEST_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const NAT_HOST = '10.0.2.2'; // the VirtualBox NAT address of the host, as seen from the guest
export const BUS_TCP = 7420;

const SEMVER = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function need(condition, message) {
  if (!condition) throw new Error(message);
}

export function stageTaskId({ version, commit } = {}) {
  need(SEMVER.test(String(version)), `invalid version: ${version}`);
  need(COMMIT.test(String(commit)), `invalid commit: ${commit}`);
  return `stage-${version}-${String(commit).slice(0, 7)}-json`;
}

// The in-guest sender: re-hashes the staged VSIX and sends the structured release-stage@1 identity as a DONE frame.
export function buildStageSender({ version, commit, vsixSha256, guestVsix = GUEST_VSIX, lbabusExe = GUEST_LBABUS, host = NAT_HOST, tcp = BUS_TCP } = {}) {
  need(SHA256.test(String(vsixSha256)), `invalid VSIX sha256: ${vsixSha256}`);
  need(/^[A-Za-z0-9.:-]+$/.test(String(host)), `invalid host address: ${host}`);
  need(Number.isInteger(tcp) && tcp > 0 && tcp < 65536, `invalid tcp port: ${tcp}`);
  const task = stageTaskId({ version, commit });
  const lit = (value) => JSON.stringify(value);
  return [
    "import { createHash } from 'node:crypto';",
    "import { readFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    '',
    `const expected = ${lit(vsixSha256)};`,
    `const actual = createHash('sha256').update(readFileSync(${lit(guestVsix)})).digest('hex');`,
    'if (actual !== expected) throw new Error(`staged VSIX hash mismatch: ${actual}`);',
    'const payload = JSON.stringify({',
    "  schema: 'labview-benchmark-actor/release-stage@1',",
    `  candidate: { component: 'extension', version: ${lit(version)}, commit: ${lit(commit)}, vsixSha256: actual },`,
    '});',
    `const result = spawnSync(${lit(lbabusExe)}, [`,
    `  'net', 'send', '--hosts', ${lit(host)}, '--tcp', ${lit(String(tcp))},`,
    `  '--session', ${lit(`release-${version}`)}, '--seq', '2', '--type', 'DONE',`,
    `  '--task', ${lit(task)}, '--message', payload,`,
    "  '--await', '2', '--retries', '10', '--retry-ms', '500',",
    "], { encoding: 'utf8' });",
    "process.stdout.write(result.stdout ?? '');",
    "process.stderr.write(result.stderr ?? '');",
    'if (result.status !== 0) process.exit(result.status ?? 1);',
    'console.log(`STAGED_SHA256=${actual}`);',
    '',
  ].join('\n');
}

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Installs the staged VSIX with the VM's VS Code CLI and confirms the exact id@version is listed. code.cmd prints
// Node deprecation warnings on stderr, which Windows PowerShell 5 turns into terminating errors under 'Stop', so the
// native calls run under 'Continue' and success is decided by the listing, not by the stream.
export function buildInstallScript({ extensionId, version, guestVsix = GUEST_VSIX, user = 'vagrant' } = {}) {
  need(/^[a-z0-9-]+\.[a-z0-9-]+$/i.test(String(extensionId)), `invalid extension id: ${extensionId}`);
  need(SEMVER.test(String(version)), `invalid version: ${version}`);
  const want = `${extensionId}@${version}`;
  return [
    "$ErrorActionPreference = 'Continue'",
    '$candidates = @(',
    `  ${psQuote(`C:\\Users\\${user}\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd`)},`,
    "  'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'",
    ')',
    '$code = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1',
    "if (-not $code) { Write-Output 'INSTALL_ERROR=code.cmd not found'; exit 1 }",
    `& $code --install-extension ${psQuote(guestVsix)} --force 2>&1 | ForEach-Object { "$_" }`,
    '$installExit = $LASTEXITCODE',
    // A failed install can leave an older build of the same version listed, so the exit status must also be clean.
    'if ($installExit -ne 0) { Write-Output "INSTALL_ERROR=code --install-extension exited $installExit"; exit 1 }',
    '$listed = @(& $code --list-extensions --show-versions 2>$null)',
    `if ($listed -contains ${psQuote(want)}) { Write-Output ${psQuote(`INSTALLED=${want}`)}; exit 0 }`,
    `Write-Output ${psQuote(`INSTALL_ERROR=${want} is not listed after install`)}`,
    'exit 1',
    '',
  ].join('\r\n');
}

// Points the extension at the per-version visual key and clears any stale verdict for this version.
export function buildConfigureVisual({ extensionId, version, reviewerId, user = 'vagrant' } = {}) {
  need(SEMVER.test(String(version)), `invalid version: ${version}`);
  need(/^[^\s'"]+@[^\s'"]+$/.test(String(reviewerId)), `invalid reviewer id: ${reviewerId}`);
  const keyDir = `C:\\Users\\${user}\\.config\\lba\\reviewer\\${version}`;
  const verdict = `C:\\Users\\${user}\\AppData\\Roaming\\Code\\User\\globalStorage\\${String(extensionId).toLowerCase()}\\handoff\\verdicts\\extension-${version}.json`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$keyPath = ${psQuote(`${keyDir}\\reviewer-visual.pem`)}`,
    `$settingsDir = ${psQuote(`C:\\Users\\${user}\\AppData\\Roaming\\Code\\User`)}`,
    "$settingsPath = Join-Path $settingsDir 'settings.json'",
    `$verdictPath = ${psQuote(verdict)}`,
    'if (-not (Test-Path $keyPath)) { throw "visual key missing: $keyPath" }',
    `& icacls.exe $keyPath /inheritance:r /grant:r ${psQuote(`${user}:(R,W)`)} 2>&1 | Out-Null`,
    'if ($LASTEXITCODE -ne 0) { throw "icacls failed on $keyPath" }',
    'New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null',
    '$settings = [ordered]@{}',
    'if (Test-Path $settingsPath) {',
    '  $raw = Get-Content -Raw $settingsPath',
    '  if (-not [string]::IsNullOrWhiteSpace($raw)) { ($raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $settings[$_.Name] = $_.Value } }',
    '}',
    `$settings['labviewBenchmarkActor.reviewerId'] = ${psQuote(reviewerId)}`,
    "$settings['labviewBenchmarkActor.reviewerKeyPath'] = $keyPath",
    "$settings['security.workspace.trust.enabled'] = $false",
    '$settings | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $settingsPath',
    'Remove-Item -Force -ErrorAction SilentlyContinue $verdictPath',
    'Write-Output "REVIEWER_KEY=$keyPath"',
    'Write-Output "STALE_VERDICT_CLEARED=$(-not (Test-Path $verdictPath))"',
    '',
  ].join('\r\n');
}

export function guestArgs({ vm, user, passwordFile, verb, rest = [] } = {}) {
  need(vm && user && passwordFile && verb, 'guestcontrol needs a VM, a user, a password file, and a verb');
  return ['guestcontrol', vm, '--username', user, '--passwordfile', passwordFile, verb, ...rest];
}

export function guestRunArgs({ exe, args = [], ...rest } = {}) {
  return guestArgs({ ...rest, verb: 'run', rest: ['--exe', exe, '--wait-stdout', '--wait-stderr', '--', ...args] });
}

// The review-target evidence: the corroboration run and attestation digest come from a valid attestation for this
// exact candidate commit, plus the WIN stage task. Fails closed on an invalid or mismatched attestation.
export function evidenceFromAttestation(attestation, { commit, taskId } = {}) {
  const check = validateAttestation(attestation);
  need(check.ok === true, `attestation does not validate: ${(check.findings || []).join('; ') || 'invalid'}`);
  need(attestation?.verdict?.crossPlaneCorroborated === true, 'attestation is not cross-plane corroborated');
  need(attestation?.provenance?.commit === commit, `attestation commit ${attestation?.provenance?.commit} is not the candidate ${commit}`);
  need(/^\d+$/.test(String(attestation?.provenance?.runId ?? '')), 'attestation has no corroboration run id');
  need(SHA256.test(String(attestation?.digest ?? '')), 'attestation has no digest');
  return [`cross-plane-run:${attestation.provenance.runId}`, `attestation-sha256:${attestation.digest}`, `windows-stage:${taskId}`];
}

// What the stage must prove and bind, independent of the hypervisor: the task id, the VSIX hash and the review-target
// evidence. Both the VirtualBox driver and the Hyper-V driver take it from here so the rules live in one place.
export function stageIdentity({ version, commit, vsix, attestation, components, setTarget = true } = {}, readFile = readFileSync) {
  const vsixSha256 = createHash('sha256').update(readFile(vsix)).digest('hex');
  const taskId = stageTaskId({ version, commit });
  const evidence = evidenceFromAttestation(JSON.parse(readFile(attestation, 'utf8')), { commit, taskId });
  if (setTarget) {
    const entry = reviewerInfrastructureEvidence(version, components);
    if (entry) evidence.push(`${entry.kind}:${entry.ref}`);
  }
  return { vsixSha256, taskId, evidence };
}

export function stagePaths({ share, version } = {}) {
  return {
    readback: join(share, `stage-readback-${version}.json`),
    stagedFrame: join(share, `staged-frame-WIN-${version}.json`),
  };
}

export function buildStagePlan({ version, vm, commit, vsixSha256, share, evidence, setTarget = true } = {}) {
  const taskId = stageTaskId({ version, commit });
  const paths = stagePaths({ share, version });
  return [
    `check that VM ${vm} is running`,
    `copy the VSIX (sha256 ${vsixSha256}) to ${GUEST_VSIX} and verify its sha256 inside the VM`,
    `install extension ${version} in the VM's VS Code and confirm it is listed`,
    `copy the ${version} visual key into the VM and point labviewBenchmarkActor.reviewerKeyPath at it`,
    `listen on tcp ${BUS_TCP} for DONE ${taskId}, then run the in-VM sender`,
    `record ${paths.readback} and ${paths.stagedFrame}`,
    setTarget ? `set the review target with evidence ${evidence.join(', ')}` : 'skip set-target (--no-set-target)',
  ];
}

// ---- live driver ----------------------------------------------------------------------------------------------
function defaultIo() {
  return {
    // Output goes through files: Node's child pipes are sockets, and VBoxManage guestcontrol cannot relay guest
    // output into a socket ("Error getting stdout handle: VERR_NOT_IMPLEMENTED"), which silently empties stdout.
    run: (cmd, args, options = {}) => {
      const dir = mkdtempSync(join(tmpdir(), 'lba-run-'));
      const outPath = join(dir, 'stdout');
      const errPath = join(dir, 'stderr');
      const out = openSync(outPath, 'w');
      const err = openSync(errPath, 'w');
      try {
        const r = spawnSync(cmd, args, { ...options, stdio: ['ignore', out, err] });
        return {
          status: r.status ?? (r.error ? 127 : 1),
          stdout: readFileSync(outPath, 'utf8'),
          stderr: readFileSync(errPath, 'utf8') + (r.error ? r.error.message : ''),
        };
      } finally {
        closeSync(out);
        closeSync(err);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // The listener stays in the terminal's process group, so Ctrl+C also reaches it; stop() relies on
    // await-agent-reply forwarding SIGTERM to the lbabus child that holds the TCP port.
    startListener: (args, env) => {
      const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let markReady;
      const ready = new Promise((resolveReady) => { markReady = resolveReady; });
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; if (/listening/.test(stderr)) markReady(true); });
      const done = new Promise((resolveDone) => child.on('close', (code) => { markReady(false); resolveDone({ code, stdout, stderr }); }));
      return { ready, done, stop: () => child.kill('SIGTERM') };
    },
    // True when a socket is in LISTEN state on the port. On Linux this reads the kernel tables without touching the
    // port, so the readiness poll cannot race the listener's own bind; elsewhere it falls back to a bind probe.
    portInUse: (port) => {
      const hex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
      const tables = ['/proc/net/tcp', '/proc/net/tcp6'].filter((table) => existsSync(table));
      if (tables.length) {
        return Promise.resolve(tables.some((table) => readFileSync(table, 'utf8').split('\n').slice(1)
          .some((line) => { const cols = line.trim().split(/\s+/); return cols[1]?.endsWith(hex) && cols[3] === '0A'; })));
      }
      return new Promise((resolvePort) => {
        const server = createServer();
        server.once('error', (error) => resolvePort(error.code === 'EADDRINUSE'));
        server.once('listening', () => server.close(() => resolvePort(false)));
        server.listen({ port, host: '0.0.0.0', exclusive: true });
      });
    },
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    readFile: (path, encoding) => readFileSync(path, encoding),
    writeFile: (path, data, mode) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data, mode ? { mode } : undefined); },
    exists: (path) => existsSync(path),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    tempDir: () => mkdtempSync(join(tmpdir(), 'lba-stage-win-')),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    log: (line) => console.log(line),
  };
}

function guestFail(step, result) {
  const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-4).join(' | ');
  return new Error(`${step} failed (exit ${result.status}): ${tail}`);
}

export async function stageWin(options, io = defaultIo()) {
  const { version, vm, commit, vsix, attestation: attestationPath, share, visualKey, reviewerId = 'reviewer@vi-tech.nl',
    user = 'vagrant', timeout = 300, setTarget = true, force = false, dryRun = false, extensionId, host = NAT_HOST } = options;
  need(SEMVER.test(String(version)), 'usage: release-stage-win <X.Y.Z> --vm <name> --commit <sha> --vsix <path> --attestation <file>');
  need(Number.isInteger(timeout) && timeout > 0, `--timeout must be a positive whole number of seconds, got ${timeout}`);
  need(vm, '--vm <name> is required (or set LBA_REVIEWER_VM)');
  need(COMMIT.test(String(commit)), `--commit must be a full 40-character sha, got ${commit}`);
  need(vsix && io.exists(vsix), `--vsix ${vsix} does not exist`);
  need(attestationPath && io.exists(attestationPath), `--attestation ${attestationPath} does not exist`);
  need(visualKey && io.exists(visualKey), `visual key ${visualKey} does not exist; enroll the ${version} reviewer keys first`);

  const { vsixSha256, taskId, evidence } = stageIdentity({ version, commit, vsix, attestation: attestationPath, components: options.components, setTarget }, io.readFile);
  if (options.vsixSha256) need(options.vsixSha256 === vsixSha256, `--vsix hashes to ${vsixSha256}, not ${options.vsixSha256}`);
  const paths = stagePaths({ share, version });
  need(force || !io.exists(paths.stagedFrame), `${paths.stagedFrame} already exists; refusing to overwrite release evidence (pass --force)`);

  const plan = buildStagePlan({ version, vm, commit, vsixSha256, share, evidence, setTarget });
  if (dryRun) {
    io.log(`release-stage-win ${version} (dry run):`);
    plan.forEach((step, i) => io.log(`  ${i + 1}. ${step}`));
    return { dryRun: true, plan, taskId, vsixSha256, evidence };
  }

  const info = io.run('VBoxManage', ['showvminfo', vm, '--machinereadable']);
  need(info.status === 0 && /^VMState="running"$/m.test(info.stdout), `VM ${vm} is not running; start it with: VBoxManage startvm ${vm}`);

  const scratch = io.tempDir();
  try {
    // VBoxManage may keep a trailing newline as part of the password, so always hand it a trimmed private copy.
    const fromFile = options.passwordFile && io.exists(options.passwordFile) ? String(io.readFile(options.passwordFile, 'utf8')) : '';
    const password = String(process.env.LBA_VM_PASS || fromFile).replace(/\r?\n$/, '');
    need(password, `no VM password: set LBA_VM_PASS or provide ${options.passwordFile}`);
    const passwordFile = join(scratch, 'vm-pass');
    io.writeFile(passwordFile, password, 0o600);
    const g = (verb, rest) => io.run('VBoxManage', guestArgs({ vm, user, passwordFile, verb, rest }));
    const run = (exe, args) => io.run('VBoxManage', guestRunArgs({ vm, user, passwordFile, exe, args }));
    const keyDir = `C:\\Users\\${user}\\.config\\lba\\reviewer\\${version}`;
    const sender = join(scratch, `lba-send-stage-${version}.mjs`);
    const install = join(scratch, `lba-install-${version}.ps1`);
    const configure = join(scratch, `lba-configure-visual-${version}.ps1`);
    io.writeFile(sender, buildStageSender({ version, commit, vsixSha256, host }));
    io.writeFile(install, buildInstallScript({ extensionId, version, user }));
    io.writeFile(configure, buildConfigureVisual({ extensionId, version, reviewerId, user }));

    io.log(`[stage-win] copying the candidate and scripts into ${vm}`);
    for (const dir of [GUEST_DIR, keyDir]) {
      const r = g('mkdir', ['--parents', dir]);
      if (r.status !== 0) throw guestFail(`mkdir ${dir}`, r);
    }
    g('rm', ['--force', GUEST_VSIX]); // copyto does not truncate an existing file; the hash check below is the guard
    for (const [verb, rest] of [
      ['copyto', ['--target-directory', `${GUEST_DIR}\\`, sender, install, configure]],
      ['copyto', [vsix, GUEST_VSIX]],
      ['copyto', [visualKey, `${keyDir}\\reviewer-visual.pem`]],
    ]) {
      const r = g(verb, rest);
      if (r.status !== 0) throw guestFail(verb, r);
    }

    const hashed = run(GUEST_POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-FileHash -Algorithm SHA256 ${psQuote(GUEST_VSIX)}).Hash`]);
    const staged = (hashed.stdout.match(/[0-9a-f]{64}/i) || [''])[0].toLowerCase();
    need(staged === vsixSha256, `the VSIX in the VM hashes to ${staged || 'nothing'}, not ${vsixSha256}`);
    io.log(`[stage-win] the VM holds the candidate: ${vsixSha256}`);

    const psFile = (file) => run(GUEST_POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${GUEST_DIR}\\${file}`]);
    const installed = psFile(`lba-install-${version}.ps1`);
    need(installed.stdout.includes(`INSTALLED=${extensionId}@${version}`), `the VM did not confirm ${extensionId}@${version}: ${installed.stdout.trim().split(/\r?\n/).slice(-2).join(' | ')}`);
    io.log(`[stage-win] installed ${extensionId}@${version} in the VM`);
    const configured = psFile(`lba-configure-visual-${version}.ps1`);
    need(configured.status === 0 && /STALE_VERDICT_CLEARED=True/.test(configured.stdout), `visual key configuration failed: ${configured.stdout.trim()} ${configured.stderr.trim()}`);
    io.log('[stage-win] configured the visual reviewer key');

    io.mkdir(share); // the listener writes its readback straight into the share
    // A stale listener on the port would ACK the sender in place of ours, so the port must start free and then be
    // bound by the new listener before anything is sent.
    need(!(await io.portInUse(BUS_TCP)), `TCP ${BUS_TCP} is already in use on this host; stop the stale listener first (ss -ltnp 'sport = :${BUS_TCP}')`);
    const listener = io.startListener([join(here, 'await-agent-reply.mjs'), '--task', taskId, '--tcp', String(BUS_TCP), '--timeout', String(timeout), '--type', 'DONE', '--out', paths.readback], {});
    let heard = null;
    try {
      need(await listener.ready, 'the host listener did not start');
      let bound = false;
      for (let i = 0; i < 60 && !bound; i += 1) {
        bound = await io.portInUse(BUS_TCP);
        if (!bound) await io.sleep(250);
      }
      need(bound, `the host listener did not bind TCP ${BUS_TCP}`);
      const sent = run(GUEST_NODE, [`${GUEST_DIR}\\lba-send-stage-${version}.mjs`]);
      if (sent.status !== 0 || !sent.stdout.includes(`STAGED_SHA256=${vsixSha256}`)) throw guestFail('the in-VM sender', sent);
      heard = await listener.done;
    } finally {
      if (!heard) {
        listener.stop();
        await listener.done;
      }
    }
    need(heard.code === 0 && io.exists(paths.readback),
      `the host listener did not correlate ${taskId} (exit ${heard.code}): ${String(heard.stderr ?? '').trim().split(/\r?\n/).slice(-2).join(' | ')}`);

    const candidate = { component: 'extension', version, commit, vsixSha256 };
    const stagedFrame = buildReleaseStage({ candidate, readback: JSON.parse(io.readFile(paths.readback, 'utf8')) });
    io.writeFile(paths.stagedFrame, `${JSON.stringify(stagedFrame, null, 2)}\n`);
    io.log(`[stage-win] recorded ${paths.stagedFrame}`);

    if (setTarget) {
      const target = io.run('bash', [join(here, 'render-verdict.sh'), 'set-target', '--vm', vm, '--version', version, '--commit', commit, '--vsix-sha256', vsixSha256,
        ...evidence.flatMap((e) => ['--evidence', e])], { env: { ...process.env, LBA_VM_PASS: password } });
      if (target.status !== 0) throw guestFail('render-verdict.sh set-target', target);
      io.log(`[stage-win] review target set with evidence ${evidence.join(', ')}`);
      io.log('[stage-win] next: in the VM, run "Developer: Reload Window", review, then "Render Reviewer Verdict"; then render-verdict.sh collect');
    }
    return { taskId, vsixSha256, evidence, stagedFramePath: paths.stagedFrame };
  } finally {
    io.remove(scratch);
  }
}

function parseArgs(argv) {
  const opts = { positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts.positionals.push(a); continue; }
    const key = a.slice(2);
    if (['dry-run', 'force', 'no-set-target'].includes(key)) { opts[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${a}`);
    opts[key] = value;
    i += 1;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const version = a.positionals[0];
  const candidateRoot = a['candidate-root'] ? resolve(a['candidate-root']) : repoRoot;
  const pkg = JSON.parse(readFileSync(join(candidateRoot, 'package.json'), 'utf8'));
  const home = homedir();
  const result = await stageWin({
    version,
    components: JSON.parse(readFileSync(join(candidateRoot, 'release-components.json'), 'utf8')),
    host: a.host || NAT_HOST,
    vm: a.vm || process.env.LBA_REVIEWER_VM,
    commit: a.commit,
    vsix: a.vsix,
    vsixSha256: a['vsix-sha256'],
    attestation: a.attestation,
    share: a.share || process.env.LBA_VM_SHARE || join(home, 'lba-vm-share'),
    visualKey: a['visual-key'] || join(home, '.config', 'lba', 'reviewer', String(version), 'reviewer-visual.pem'),
    passwordFile: a['password-file'] || join(home, '.config', 'lba', 'vm-pass'),
    reviewerId: a.reviewer,
    timeout: a.timeout === undefined ? 300 : (/^\d+$/.test(a.timeout) ? Number(a.timeout) : NaN),
    setTarget: !a['no-set-target'],
    force: !!a.force,
    dryRun: !!a['dry-run'],
    extensionId: `${pkg.publisher}.${pkg.name}`,
  });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`release-stage-win: ${error.message}`);
    process.exit(1);
  });
}
