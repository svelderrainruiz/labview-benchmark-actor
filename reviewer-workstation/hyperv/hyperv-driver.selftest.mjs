#!/usr/bin/env node
// hyperv-driver.selftest.mjs -- proves the Hyper-V reviewer driver (#124) offline. The PowerShell steps run in
// dry-run mode, which records the plan instead of touching Hyper-V, the firewall or the network, so the command
// order, the firewall open/close, the guest paths and the fail-closed exits are asserted without a hypervisor.
// The pwsh cases are skipped (and reported as skipped) when pwsh is not installed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix as pathPosix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewTarget, parseEvidence } from '../build-review-target.mjs';
import { buildStageSender, stageIdentity } from '../release-stage-win.mjs';
import { expectedAssetNames } from '../../scripts/lbabus-pin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const attestationPath = join(root, 'experiments', 'acg-quorum', 'cross-plane-attestation-receipt.json');
const attestation = JSON.parse(readFileSync(attestationPath, 'utf8'));
const commit = attestation.provenance.commit;
const havePwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
const vmId = '11111111-2222-3333-4444-555555555555';

const work = mkdtempSync(join(tmpdir(), 'lba-hyperv-'));
const components = JSON.parse(readFileSync(join(root, 'release-components.json'), 'utf8'));
const version = components.extension;
components.reviewerInfrastructure = { schema: 'reviewer-infrastructure@1', baseline: 'v0.1.0', receiptSha256: 'a'.repeat(64) };
// The tooling and evidence rule files the stage driver compares with the candidate, copied so the fixture agrees.
const compareList = JSON.parse(readFileSync(join(here, 'tooling-compare.json'), 'utf8'));
const COMPARED = compareList.compared;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const lbabusAsset = expectedAssetNames(components.lbabus)['win-x64'];
components.lbabusRelease = { ...(components.lbabusRelease ?? {}), assets: { ...(components.lbabusRelease?.assets ?? {}), [lbabusAsset]: sha('fake lbabus') } };
const candidate = join(work, 'candidate repo'); // a space in the path, as a real checkout may have
mkdirSync(join(candidate, 'reviewer-workstation'), { recursive: true });
copyFileSync(join(root, 'package.json'), join(candidate, 'package.json'));
writeFileSync(join(candidate, 'release-components.json'), JSON.stringify(components));
for (const f of COMPARED) { mkdirSync(dirname(join(candidate, f)), { recursive: true }); copyFileSync(join(root, f), join(candidate, f)); }
writeFileSync(join(work, 'candidate.vsix'), 'fake vsix');
writeFileSync(join(work, 'visual.pem'), 'fake key');
writeFileSync(join(work, 'lbabus.exe'), 'fake lbabus');

function ps(script, args) {
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(here, script), ...args], { encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('LBA_PLAN_JSON='));
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, plan: line ? JSON.parse(line.slice('LBA_PLAN_JSON='.length)) : null };
}
const ops = (plan) => plan.map((s) => s.op);
const indexOfOp = (plan, op, from = 0) => plan.findIndex((s, i) => i >= from && s.op === op);

const stageArgs = ['-VMId', vmId, '-Version', version, '-Commit', commit, '-Vsix', join(work, 'candidate.vsix'), '-Attestation', attestationPath, '-CandidateRepo', candidate,
  '-VisualKey', join(work, 'visual.pem'), '-HostAddress', '172.20.0.1', '-LbabusExe', join(work, 'lbabus.exe'), '-Share', join(work, 'share'), '-WhatIf'];

const cases = [];
const test = (id, name, fn, { needsPwsh = false, needsPosix = false } = {}) => cases.push({ id, name, fn, needsPwsh, needsPosix });

test('H1', 'the sender keeps the VirtualBox NAT host by default and takes a Hyper-V host and port', () => {
  const base = { taskId: 't', commit, version, vsixSha256: 'a'.repeat(64), evidence: [] };
  assert.match(buildStageSender(base), /10\.0\.2\.2/);
  assert.match(buildStageSender({ ...base, host: '172.20.0.1', tcp: 7421 }), /172\.20\.0\.1/);
  for (const bad of [{ host: "1.2.3.4'; rm" }, { tcp: 0 }, { tcp: 70000 }, { tcp: 'x' }]) assert.throws(() => buildStageSender({ ...base, ...bad }));
});

test('H2', 'the stage identity is shared with the VirtualBox driver and needs the candidate release-components', () => {
  const id = stageIdentity({ version, commit, vsix: join(work, 'candidate.vsix'), attestation: attestationPath, components }, (p, e) => readFileSync(p, e));
  assert.equal(id.taskId, `stage-${version}-${commit.slice(0, 7)}-json`);
  assert.ok(id.evidence.includes(`reviewer-infrastructure-receipt-sha256:${'a'.repeat(64)}`));
  const { reviewerInfrastructure, ...without } = components;
  assert.ok(reviewerInfrastructure);
  assert.throws(() => stageIdentity({ version, commit, vsix: join(work, 'candidate.vsix'), attestation: attestationPath, components: without }, (p, e) => readFileSync(p, e)), /reviewerInfrastructure/);
});

test('H3', 'the review target builder keeps one evidence entry per argument, spaces included', () => {
  assert.deepEqual(parseEvidence(['windows-stage:x', 'note:has spaces: here']), [{ kind: 'windows-stage', ref: 'x' }, { kind: 'note', ref: 'has spaces: here' }]);
  const target = buildReviewTarget({ component: 'extension', version, commit, vsixSha256: 'b'.repeat(64), evidence: ['note:has spaces here'] });
  assert.deepEqual(target.evidence, [{ kind: 'note', ref: 'has spaces here' }]);
});

test('H4', 'win-plane-validate bundles, ships, runs the candidate validator in the guest and writes the receipt', () => {
  const r = ps('win-plane-validate.ps1', ['-VMId', vmId, '-CandidateRepo', here.replace(/reviewer-workstation.*$/, ''), '-Branch', 'release/1.6.7', '-OutFile', join(work, 'w.json'), '-WhatIf']);
  assert.equal(r.status, 0, r.stderr);
  const o = ops(r.plan);
  assert.deepEqual(o.filter((x) => x !== 'guest-run' && x !== 'copy-to-guest').slice(0, 4), ['check-elevation', 'check-vm', 'host-run', 'host-run']);
  assert.match(r.plan.find((s) => s.op === 'host-run').detail, /bundle create .*release\/1\.6\.7/);
  assert.ok(r.plan.some((s) => s.op === 'guest-run' && /-File C:\\lba-validate\\win-plane-validate\.ps1 -Bundle C:\\lba-validate\\rel\.bundle -Branch release\/1\.6\.7/.test(s.detail)));
  assert.equal(o.at(-1), 'host-write');
}, { needsPwsh: true });

test('H5', 'release-stage-win runs in the order verify, stage, firewall open, listen, send, stop, close, record, set target', () => {
  const r = ps('release-stage-win.ps1', stageArgs);
  assert.equal(r.status, 0, r.stderr);
  const p = r.plan;
  const at = (op, from) => { const i = indexOfOp(p, op, from); assert.ok(i >= 0, `${op} missing`); return i; };
  const open = at('firewall-open');
  const start = at('listener-start', open);
  const send = p.findIndex((s) => s.op === 'guest-run' && /send the DONE frame/.test(s.detail));
  const stop = at('listener-stop', send);
  const close = at('firewall-close', stop);
  const record = p.findIndex((s) => s.op === 'host-run' && /record-release-stage\.mjs/.test(s.detail));
  const target = p.findIndex((s) => s.op === 'host-run' && /build-review-target\.mjs/.test(s.detail));
  assert.ok(open < start && start < send && send < stop && stop < close && close < record && record < target, ops(p).join(','));
  assert.match(p[open].detail, /inbound tcp 7420 on 172\.20\.0\.1/);
  assert.ok(p.some((s) => s.op === 'host-check' && /pinned lbabus-.*-win-x64\.exe [0-9a-f]{64}/.test(s.detail)));
}, { needsPwsh: true });

test('H6', 'the guest account comes from the credential/-GuestUser and the key, install and target paths follow it', () => {
  const r = ps('release-stage-win.ps1', [...stageArgs, '-GuestUser', 'alice']);
  assert.equal(r.status, 0, r.stderr);
  const text = JSON.stringify(r.plan);
  assert.ok(text.includes('C:\\\\Users\\\\alice\\\\.config\\\\lba\\\\reviewer\\\\' + version));
  assert.ok(text.includes('C:\\\\Users\\\\alice\\\\AppData\\\\Roaming\\\\Code\\\\User\\\\globalStorage'));
  assert.ok(!text.includes('vagrant'));
}, { needsPwsh: true });

test('H7', 'release-stage-win fails closed: no host address, a bad host, a bad commit, an existing staged frame', () => {
  const without = (flag) => { const i = stageArgs.indexOf(flag); return [...stageArgs.slice(0, i), ...stageArgs.slice(i + 2)]; };
  assert.equal(ps('release-stage-win.ps1', without('-HostAddress')).status, 2);
  const bad = stageArgs.map((a) => (a === '172.20.0.1' ? "1.2.3.4'; rm" : a));
  assert.equal(ps('release-stage-win.ps1', bad).status, 2);
  assert.equal(ps('release-stage-win.ps1', stageArgs.map((a) => (a === commit ? 'abc' : a))).status, 2);
  mkdirSync(join(work, 'share'), { recursive: true });
  writeFileSync(join(work, 'share', `staged-frame-WIN-${version}.json`), '{}');
  const r = ps('release-stage-win.ps1', stageArgs);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to overwrite/);
  assert.equal(ps('release-stage-win.ps1', [...stageArgs, '-Force']).status, 0);
  rmSync(join(work, 'share'), { recursive: true });
}, { needsPwsh: true });

test('H8', 'a live run without -Credential, and a VM given by both id and name, exit 2 before touching anything', () => {
  const live = stageArgs.filter((a) => a !== '-WhatIf');
  const r = ps('release-stage-win.ps1', live);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /LBA_FAIL=LBA_USAGE: -Credential is required/);
  assert.equal(ps('release-stage-win.ps1', [...stageArgs, '-VMName', 'x']).status, 2);
}, { needsPwsh: true });

test('H9', 'render-verdict guards and sets the target (guard first), and collect reads the verdict path', () => {
  const v = ['-VMId', vmId, '-Version', version, '-Commit', commit, '-VsixSha256', 'c'.repeat(64), '-CandidateRepo', candidate, '-Evidence', 'windows-stage:t', '-GuestUser', 'alice', '-WhatIf'];
  const r = ps('render-verdict.ps1', ['set-target', ...v]);
  assert.equal(r.status, 0, r.stderr);
  const g = r.plan.findIndex((s) => /verify-staged-vsix\.mjs/.test(s.detail));
  const t = r.plan.findIndex((s) => /build-review-target\.mjs/.test(s.detail));
  const c = r.plan.findIndex((s) => s.op === 'copy-to-guest' && /handoff\\review-target\.json$/.test(s.detail));
  assert.ok(g > 0 && g < t && t < c);
  const col = ps('render-verdict.ps1', ['collect', '-VMId', vmId, '-Version', version, '-GuestUser', 'alice', '-Out', join(work, 'v.json'), '-WhatIf']);
  assert.equal(col.status, 0, col.stderr);
  assert.ok(col.plan.some((s) => s.op === 'copy-from-guest' && s.detail.includes(`handoff\\verdicts\\extension-${version}.json`)));
  assert.equal(ps('render-verdict.ps1', ['collect', '-VMId', vmId, '-Version', version, '-WhatIf']).status, 2);
  assert.equal(ps('render-verdict.ps1', ['set-target', ...v.map((x) => (x === 'c'.repeat(64) ? 'zz' : x))]).status, 2);
}, { needsPwsh: true });

test('H10', 'render-quorum stages, signs in the guest with the guest key, collects, then verifies on the host', () => {
  const r = ps('render-quorum.ps1', ['all', '-VMId', vmId, '-Version', version, '-Attestation', attestationPath, '-CandidateRepo', candidate, '-Out', join(work, 'q.json'), '-WhatIf']);
  assert.equal(r.status, 0, r.stderr);
  const p = r.plan;
  const stage = p.findIndex((s) => s.op === 'copy-to-guest');
  const sign = p.findIndex((s) => /sign-release-quorum\.mjs --key C:\\lba-review\\reviewer-vitech\.pem .* --station WINDOWS_VM --quorum C:\\lba-review\\attestation-/.test(s.detail));
  const collect = p.findIndex((s) => s.op === 'copy-from-guest');
  const verify = p.findIndex((s) => /verify-quorum-signoff\.mjs .*--allowlist .*reviewer-allowlist\.json/.test(s.detail));
  assert.ok(stage > 0 && stage < sign && sign < collect && collect < verify, ops(p).join(','));
  assert.ok(!p.some((s) => s.op === 'copy-to-guest' && /\.pem/.test(s.detail)), 'the private key is never copied');
}, { needsPwsh: true });

test('H11', 'render-quorum verify rejects a sign-off the verifier refuses with the gate exit code', () => {
  writeFileSync(join(work, 'bad.json'), '{}');
  const r = ps('render-quorum.ps1', ['verify', '-Version', version, '-Attestation', attestationPath, '-Signoff', join(work, 'bad.json'), '-CandidateRepo', root]);
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /LBA_FAIL=LBA_GATE/);
}, { needsPwsh: true });

test('H12', 'a guest call that outlives its bound is stopped and fails with the timeout exit code naming the step', () => {
  const script = `Import-Module '${join(here, 'LbaHyperV.psm1')}' -Force; Start-LbaPlan; Invoke-LbaMain { Invoke-LbaJob -Name 'slow guest step' -TimeoutSec 1 -Start { Start-Job { Start-Sleep 30 } } }`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /LBA_FAIL=LBA_TIMEOUT: slow guest step did not finish within 1 s/);
}, { needsPwsh: true });

test('H13', 'a firewall rule that survives its removal is reported, and a missing rule name is a no-op', () => {
  const script = `Import-Module '${join(here, 'LbaHyperV.psm1')}' -Force; Start-LbaPlan
function Remove-NetFirewallRule { param($DisplayName, $ErrorAction) }
function Get-NetFirewallRule { param($DisplayName, $ErrorAction) 'still here' }
Close-LbaListener -Name ''
Invoke-LbaMain { Close-LbaListener -Name 'lba-stage-x' }`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(r.status, 6);
  assert.match(r.stderr, /firewall rule lba-stage-x is still present/);
}, { needsPwsh: true });

// ---- live paths: the real script and module code run with the Hyper-V, firewall and network cmdlets stubbed ----
// A wrapper dot-defines function stubs (a function shadows a cmdlet) and runs the step script with a fake credential;
// the stubs log every call to calls.log, keep firewall state in fw.state and read their answers from T_* variables.
const posix = process.platform !== 'win32';
const stageEnvSha = sha('fake vsix');
const WRAPPER = (stage, dir) => `$ErrorActionPreference = 'Stop'
$d = $env:T_DIR
function Write-Call($m) { Add-Content -LiteralPath "$d/calls.log" -Value $m }
function Get-VM { param($Id, [Parameter(ValueFromRemainingArguments)]$rest) Write-Call 'Get-VM'; [pscustomobject]@{ Id = [guid]$env:T_VMID; Name = 'vm'; State = 'Running' } }
function Get-VMIntegrationService { param($VM, $Name, $ErrorAction) [pscustomobject]@{ Enabled = ($env:T_GSI -ne '0') } }
function Get-VMNetworkAdapter { param($VM, $ErrorAction) [pscustomobject]@{ IPAddresses = @($env:T_GUEST_IPS -split ',') } }
function whoami.exe { if ($env:T_ELEVATED -eq '0') { '"lab\\u","User","S-1-5-32-544","Group used for deny only"' } else { '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Mandatory group, Enabled by default, Enabled group, Group owner"' } }
function Get-NetIPAddress { param($IPAddress, $InterfaceAlias, $AddressFamily, $ErrorAction) [pscustomobject]@{ IPAddress = '172.20.0.1'; InterfaceAlias = 'vEthernet (Lab)'; PrefixLength = 24 } }
function Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction) if ($env:T_BUSY -eq '1' -or (Test-Path "$d/listening")) { [pscustomobject]@{ LocalPort = $LocalPort } } }
function New-NetFirewallRule { param($DisplayName, $Direction, $Action, $Protocol, $LocalPort, $LocalAddress, $InterfaceAlias, $RemoteAddress, $Profile, $ErrorAction)
  Write-Call "New-NetFirewallRule $DisplayName"; Add-Content -LiteralPath "$d/rules.log" -Value ($PSBoundParameters | ConvertTo-Json -Compress -Depth 3); Add-Content -LiteralPath "$d/fw.state" -Value $DisplayName }
function Remove-NetFirewallRule { param($DisplayName, $ErrorAction)
  Write-Call "Remove-NetFirewallRule $DisplayName"; $keep = @(Get-Content -LiteralPath "$d/fw.state" -ErrorAction SilentlyContinue | Where-Object { $_ -ne $DisplayName }); Set-Content -LiteralPath "$d/fw.state" -Value $keep }
function Get-NetFirewallRule { param($DisplayName, $ErrorAction) Get-Content -LiteralPath "$d/fw.state" -ErrorAction SilentlyContinue | Where-Object { $_ -like $DisplayName } | ForEach-Object { [pscustomobject]@{ DisplayName = $_ } } }
function taskkill.exe { Write-Call "taskkill $($args -join ' ')"; Stop-Process -Id ([int]$args[1]) -Force -ErrorAction SilentlyContinue }
function Copy-VMFile { param($VM, $SourcePath, $DestinationPath, [switch]$CreateFullPath, $FileSource, [switch]$Force, [switch]$AsJob) Write-Call "Copy-VMFile $DestinationPath"; Start-Job { 1 } }
function Invoke-Command { param($VMId, $Credential, $ScriptBlock, $ArgumentList, [switch]$AsJob)
  $a = @($ArgumentList); $out = @()
  if ($ScriptBlock.ToString() -match 'Get-FileHash') {
    Write-Call "Invoke-Command sha256 $($a[0])"
    if ($a[0] -like '*lbabus.exe') { $out = @($env:T_GUEST_LBABUS_SHA) } elseif ($a[0] -like '*candidate.vsix') { $out = @($env:T_GUEST_VSIX_SHA) }
  } elseif ($ScriptBlock.ToString() -match 'taskkill') {
    Write-Call "Invoke-Command program $($a[1])"
    $exit = 'LBA_EXIT=0'
    if ($env:T_EXIT_ALL) { $exit = $env:T_EXIT_ALL }
    if ($a[1] -match 'lba-install') { $out = @("INSTALLED=$($env:T_EXT_ID)@$($env:T_VERSION)") }
    elseif ($a[1] -match 'lba-configure') { $out = @('STALE_VERDICT_CLEARED=True') }
    elseif ($a[1] -match 'lba-send-stage' -and $env:T_SENDER_OK -eq '1') { $out = @("STAGED_SHA256=$($env:T_VSIX_SHA)") }
    $out += $exit
  } else { Write-Call 'Invoke-Command other' }
  Start-Job -ScriptBlock { param($o) $o } -ArgumentList (,@($out))
}
$p = ConvertFrom-Json -AsHashtable (Get-Content -Raw -LiteralPath "$d/params.json")
$p.Credential = [pscredential]::new('lab\\\\reviewer', (ConvertTo-SecureString 'x' -AsPlainText -Force))
& '${stage}' @p
exit $LASTEXITCODE
`;

function live(name, { env = {}, params = {}, script = 'release-stage-win.ps1', fw = [], extra = {}, bare = false } = {}) {
  const dir = join(work, `live-${name}`);
  mkdirSync(dir, { recursive: true });
  const fake = join(dir, 'node');
  writeFileSync(fake, `#!/bin/sh
case "$1" in
  *await-agent-reply.mjs)
    printf '%s\\n' "$@" > "$T_DIR/listener.argv"
    echo $$ > "$T_DIR/listener.pid"
    echo listening >&2
    : > "$T_DIR/listening"
    exec sleep 20 ;;
  *) exec "${process.execPath}" "$@" ;;
esac
`);
  chmodSync(fake, 0o755);
  writeFileSync(join(dir, 'fw.state'), fw.map((x) => `${x}\n`).join(''));
  writeFileSync(join(dir, 'params.json'), JSON.stringify(bare ? { VMId: vmId, ...params } : {
    VMId: vmId, Version: version, Commit: commit, Vsix: join(work, 'candidate.vsix'), Attestation: attestationPath, CandidateRepo: candidate,
    VisualKey: join(work, 'visual.pem'), HostAddress: '172.20.0.1', LbabusExe: join(work, 'lbabus.exe'), Share: join(dir, 'share'), Node: fake, TimeoutSec: 20, ...params,
  }));
  writeFileSync(join(dir, 'wrapper.ps1'), WRAPPER(join(here, script), dir));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(dir, 'wrapper.ps1')], {
    encoding: 'utf8',
    env: {
      ...process.env, T_DIR: dir, T_VMID: vmId, T_GSI: '1', T_ELEVATED: '1', T_GUEST_IPS: 'fe80::1,172.20.0.5,10.9.9.9', T_GUEST_LBABUS_SHA: sha('fake lbabus'),
      T_GUEST_VSIX_SHA: stageEnvSha, T_VSIX_SHA: stageEnvSha, T_SENDER_OK: '0', T_EXT_ID: `${pkg.publisher}.${pkg.name}`, T_VERSION: version, ...env,
    },
  });
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  const pid = Number(read('listener.pid').trim());
  if (pid) { try { process.kill(pid); } catch { /* already stopped */ } }
  return { ...r, calls: read('calls.log'), rules: read('rules.log').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), fwState: read('fw.state').trim(), argv: read('listener.argv').trim().split('\n').filter(Boolean), dir };
}
const noGuestChange = (r) => assert.ok(!/Invoke-Command (program|other)|Copy-VMFile|New-NetFirewallRule/.test(r.calls), r.calls);
const liveTest = (id, name, fn) => test(id, name, fn, { needsPwsh: true, needsPosix: true });

liveTest('H14', 'a failure after the listener starts closes the firewall rule and stops the listener (the finally path)', () => {
  const r = live('fail-after-open');
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /the in-guest sender did not report the staged hash/);
  assert.match(r.calls, /New-NetFirewallRule lba-stage-7420-/);
  assert.match(r.calls, /Remove-NetFirewallRule lba-stage-7420-/, 'the firewall rule is removed on failure');
  assert.equal(r.fwState, '', 'no rule is left behind');
  assert.match(r.calls, new RegExp(`taskkill /PID ${r.argv.length ? '\\d+' : 'x'} /T /F`), 'the listener is stopped on failure');
  assert.ok(r.calls.indexOf('taskkill') > r.calls.indexOf('New-NetFirewallRule'));
});

liveTest('H15', 'the firewall rule is scoped by local address, interface, local port and the guest address read from the VM', () => {
  const r = live('rule-scope');
  assert.equal(r.rules.length, 1, r.stderr);
  const rule = r.rules[0];
  assert.equal(rule.LocalAddress, '172.20.0.1');
  assert.equal(rule.InterfaceAlias, 'vEthernet (Lab)');
  assert.equal(rule.LocalPort, 7420);
  assert.deepEqual([].concat(rule.RemoteAddress), ['172.20.0.5'], 'only the guest address on the host subnet');
  assert.equal(rule.Direction, 'Inbound');
  assert.equal(rule.Action, 'Allow');
  const given = live('rule-scope-given', { params: { GuestAddress: '172.20.0.9' } });
  assert.deepEqual([].concat(given.rules[0].RemoteAddress), ['172.20.0.9']);
});

liveTest('H16', 'a busy port is refused before any guest change, and a leftover rule or a missing guest address too', () => {
  const busy = live('busy', { env: { T_BUSY: '1' } });
  assert.equal(busy.status, 6, busy.stderr);
  assert.match(busy.stderr, /tcp 7420 is already in use/);
  noGuestChange(busy);
  assert.ok(!existsSync(join(busy.dir, 'share')), 'the share is not created before the checks');
  const stale = live('stale-rule', { fw: ['lba-stage-7420-deadbeef'] });
  assert.equal(stale.status, 6, stale.stderr);
  assert.match(stale.stderr, /lba-stage-7420-deadbeef/);
  noGuestChange(stale);
  const none = live('no-guest-address', { env: { T_GUEST_IPS: 'fe80::1,10.9.9.9' } });
  assert.equal(none.status, 2, none.stderr);
  assert.match(none.stderr, /no IPv4 address on the subnet of 172\.20\.0\.1/);
  noGuestChange(none);
  const off = live('no-gsi', { env: { T_GSI: '0' } });
  assert.equal(off.status, 4, off.stderr);
  assert.match(off.stderr, /Guest Service Interface is not enabled.*Enable-VMIntegrationService/);
  noGuestChange(off);
});

liveTest('H17', 'the pinned lbabus is enforced on the host and in the guest before anything is sent', () => {
  writeFileSync(join(work, 'other-lbabus.exe'), 'not the pinned exe');
  const host = live('lbabus-host', { params: { LbabusExe: join(work, 'other-lbabus.exe') } });
  assert.equal(host.status, 5, host.stderr);
  assert.match(host.stderr, /-LbabusExe hashes to/);
  noGuestChange(host);
  const guest = live('lbabus-guest', { env: { T_GUEST_LBABUS_SHA: 'e'.repeat(64) } });
  assert.equal(guest.status, 5, guest.stderr);
  assert.match(guest.stderr, /lbabus in the guest hashes to/);
  assert.ok(!/New-NetFirewallRule/.test(guest.calls), 'no rule is opened for an unpinned guest lbabus');
});

liveTest('H18', 'a guest VSIX that is not the candidate bytes is refused before the listener or the firewall are used', () => {
  const r = live('vsix-hash', { env: { T_GUEST_VSIX_SHA: 'f'.repeat(64) } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /the VSIX in the guest hashes to/);
  assert.ok(!/New-NetFirewallRule/.test(r.calls) && r.argv.length === 0, 'no rule and no listener');
});

liveTest('H19', 'the tooling and the candidate must agree on the evidence and pin rule files, else exit 2 naming the file', () => {
  const other = join(work, 'candidate-differs');
  mkdirSync(join(other, 'scripts'), { recursive: true });
  for (const f of ['package.json', 'release-components.json']) copyFileSync(join(candidate, f), join(other, f));
  for (const f of COMPARED) { mkdirSync(dirname(join(other, f)), { recursive: true }); copyFileSync(join(candidate, f), join(other, f)); }
  writeFileSync(join(other, 'scripts', 'lbabus-pin.mjs'), `${readFileSync(join(root, 'scripts', 'lbabus-pin.mjs'), 'utf8')}\n// edited\n`);
  const r = live('candidate-differs', { params: { CandidateRepo: other } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /scripts[\\/]lbabus-pin\.mjs differs between the tooling tree and -CandidateRepo/);
  noGuestChange(r);
  copyFileSync(join(candidate, 'scripts', 'lbabus-pin.mjs'), join(other, 'scripts', 'lbabus-pin.mjs'));
  rmSync(join(other, 'scripts', 'verify-reviewer-infrastructure.mjs'));
  const missing = live('candidate-missing', { params: { CandidateRepo: other } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /verify-reviewer-infrastructure\.mjs is missing from -CandidateRepo/);
  const dry = ps('release-stage-win.ps1', stageArgs.map((a) => (a === candidate ? other : a)));
  assert.equal(dry.status, 2, 'the comparison also runs in dry-run');
});

// The static import graph (relative import/from specifiers and readJson('<file>') literals) of the evidence builders.
function importClosure(base, roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.m?js$/.test(f)) continue;
    const src = readFileSync(join(base, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) queue.push(pathPosix.normalize(pathPosix.join(pathPosix.dirname(f), m[1])));
    for (const m of src.matchAll(/readJson\(\s*'([^']+)'\s*\)/g)) queue.push(m[1]);
  }
  return [...seen].sort();
}

test('H25', 'the compared tooling set covers the import closure of the evidence builders; each exclusion has a reason', () => {
  const excluded = Object.keys(compareList.excluded);
  for (const f of excluded) assert.ok(String(compareList.excluded[f]).length > 20, `${f} needs a reason`);
  assert.deepEqual(COMPARED.filter((f) => excluded.includes(f)), [], 'a file is either compared or excluded');
  const missing = importClosure(root, compareList.roots).filter((f) => !COMPARED.includes(f) && !excluded.includes(f));
  assert.deepEqual(missing, [], `in the closure but neither compared nor excluded: ${missing.join(', ')}`);
  for (const f of COMPARED) assert.ok(existsSync(join(root, f)), `${f} is listed but does not exist`);
});

test('H26', 'a one-byte change in any compared file is refused in dry-run, naming the file', () => {
  const same = ps('release-stage-win.ps1', stageArgs);
  assert.equal(same.status, 0, same.stderr);
  for (const f of COMPARED) {
    const other = join(work, 'candidate-byte');
    rmSync(other, { recursive: true, force: true });
    cpSync(candidate, other, { recursive: true });
    writeFileSync(join(other, f), `${readFileSync(join(candidate, f), 'utf8')} `);
    const r = ps('release-stage-win.ps1', stageArgs.map((a) => (a === candidate ? other : a)));
    assert.equal(r.status, 2, `${f}: ${r.stderr}`);
    assert.ok(r.stderr.replaceAll('\\', '/').includes(`${f} differs between the tooling tree and -CandidateRepo`), r.stderr);
  }
}, { needsPwsh: true });

liveTest('H27', 'every driver refuses a session that is not elevated before any Get-VM; dry-run needs no elevation', () => {
  const cases = [
    ['release-stage-win.ps1', {}],
    ['render-verdict.ps1', { Action: 'set-target', Version: version, Commit: commit, VsixSha256: 'a'.repeat(64) }],
    ['render-quorum.ps1', { Action: 'stage', Version: version, Attestation: attestationPath, CandidateRepo: candidate }],
    ['win-plane-validate.ps1', { CandidateRepo: root, Branch: 'release/1.0.0' }],
  ];
  for (const [script, params] of cases) {
    const r = live(`elevation-${script}`, { script, env: { T_ELEVATED: '0' }, params, bare: script !== 'release-stage-win.ps1' });
    assert.equal(r.status, 6, `${script}: ${r.stderr}`);
    assert.match(r.stderr, /neither an elevated administrator nor a member of Hyper-V Administrators/);
    assert.ok(!/Get-VM/.test(r.calls), `${script} must not reach Get-VM`);
  }
  const ok = live('elevation-ok', { env: { T_ELEVATED: '1', T_BUSY: '1' } });
  assert.doesNotMatch(ok.stderr, /Hyper-V Administrators/);
  const dry = ps('release-stage-win.ps1', stageArgs);
  assert.equal(dry.status, 0, dry.stderr);
});

liveTest('H28', 'only IPv4 addresses are accepted, and a busy port leaves LBABUS untouched', () => {
  const v6 = live('ipv6-host', { params: { HostAddress: '::1' } });
  assert.equal(v6.status, 2, v6.stderr);
  assert.match(v6.stderr, /-HostAddress is not an IP address/);
  const v6g = live('ipv6-guest', { params: { GuestAddress: 'fe80::1' } });
  assert.equal(v6g.status, 2, v6g.stderr);
  const dir = join(work, 'envcheck');
  mkdirSync(dir, { recursive: true });
  const script = `Import-Module '${join(here, 'LbaHyperV.psm1')}' -Force
function Get-NetTCPConnection { [pscustomobject]@{ LocalPort = 1 } }
$env:LBABUS = 'before'
Start-LbaPlan
try { Start-LbaListener -Node 'node' -Script 's' -Lbabus 'x' -TaskId 't' -Port 7420 -TimeoutSec 5 -Out 'o' -LogDir '${dir}' } catch { 'threw' }
$env:LBABUS`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  assert.equal(r.stdout.trim().split('\n').join('|'), 'threw|before', r.stderr);
});

liveTest('H20', 'a guest program that exits non-zero or outlives its guest-side bound fails the step, naming it', () => {
  const bad = live('guest-exit', { env: { T_EXIT_ALL: 'LBA_EXIT=7' } });
  assert.equal(bad.status, 4, bad.stderr);
  assert.match(bad.stderr, /install the extension exited 7/);
  const slow = live('guest-timeout', { env: { T_EXIT_ALL: 'LBA_GUEST_TIMEOUT=1' } });
  assert.equal(slow.status, 3, slow.stderr);
  assert.match(slow.stderr, /install the extension did not finish within 300 s; its process tree was stopped in the guest/);
  const missing = live('guest-no-exit', { env: { T_EXIT_ALL: 'nothing' } });
  assert.equal(missing.status, 4);
  assert.match(missing.stderr, /reported no exit code/);
});

liveTest('H21', 'the guest-side runner reports the exit code, and stops a program that outlives its bound', () => {
  const dir = join(work, 'runner');
  mkdirSync(dir, { recursive: true });
  const script = `Import-Module '${join(here, 'LbaHyperV.psm1')}' -Force
function taskkill.exe { Add-Content -LiteralPath '${join(dir, 'k.log')}' -Value "taskkill $($args -join ' ')"; Stop-Process -Id ([int]$args[1]) -Force }
$m = Get-Module LbaHyperV
(& $m { & $script:GuestRunner 'sh' '-c "echo out; exit 3"' 10 }) -join '|'
(& $m { & $script:GuestRunner 'sleep' '30' 1 }) -join '|'`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const [done, timedOut] = r.stdout.trim().split('\n');
  assert.match(done, /out\|LBA_EXIT=3/, r.stdout + r.stderr);
  assert.match(timedOut, /LBA_GUEST_TIMEOUT=1/);
  assert.match(readFileSync(join(dir, 'k.log'), 'utf8'), /taskkill \/PID \d+ \/T \/F/);
});

test('H22', 'a path with a space reaches the host listener and the guest as one argument', () => {
  const script = `Import-Module '${join(here, 'LbaHyperV.psm1')}' -Force
ConvertTo-LbaArgumentString -Arguments @('C:\\a b\\x.mjs', '--task', 'plain', 'q"uote', 'C:\\dir with space\\', '')`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '"C:\\a b\\x.mjs" --task plain "q\\"uote" "C:\\dir with space\\\\" ""', r.stderr);
  const r2 = live('space-path');
  assert.deepEqual(r2.argv.slice(0, 1), [join(candidate, 'reviewer-workstation', 'await-agent-reply.mjs')], r2.stderr);
}, { needsPwsh: true, needsPosix: true });

test('H23', 'win-plane-validate refuses a branch that git would read as an option or a range; addresses must be IPs; a VM name is exact', () => {
  const v = (branch) => ps('win-plane-validate.ps1', ['-VMId', vmId, '-CandidateRepo', here.replace(/reviewer-workstation.*$/, ''), '-Branch', branch, '-OutFile', join(work, 'w.json'), '-WhatIf']).status;
  assert.equal(v('--output=x'), 2);
  assert.equal(v('a..b'), 2);
  assert.equal(v('release/1.6.7'), 0);
  assert.equal(ps('release-stage-win.ps1', stageArgs.map((a) => (a === '172.20.0.1' ? 'host.example' : a))).status, 2);
  assert.equal(ps('release-stage-win.ps1', [...stageArgs, '-GuestAddress', 'guest.example']).status, 2);
  const script = `Import-Module '${join(here, 'LbaHyperV.psm1')}' -Force; Start-LbaPlan
function Get-VM { param($Name, $ErrorAction) [pscustomobject]@{ Id = [guid]'${vmId}'; Name = 'Lab' }; [pscustomobject]@{ Id = [guid]'aaaaaaaa-2222-3333-4444-555555555555'; Name = 'Lab2' } }
Resolve-LbaVmId -VMName 'Lab'; Invoke-LbaMain { Resolve-LbaVmId -VMName 'la*' }`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.match(r.stdout, new RegExp(vmId));
  assert.equal(r.status, 2, 'a wildcard matches nothing');
}, { needsPwsh: true });

test('H24', 'the release-components extension must equal the candidate version even without a review target', () => {
  const wrong = { ...components, extension: '0.0.1' };
  for (const setTarget of [true, false]) {
    assert.throws(() => stageIdentity({ version, commit, vsix: join(work, 'candidate.vsix'), attestation: attestationPath, components: wrong, setTarget }, (p, e) => readFileSync(p, e)), /is not the candidate version/);
  }
});

test('H29', 'successful host commands may write stderr, while non-zero exits still fail', () => {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const modulePath = quote(join(here, 'LbaHyperV.psm1'));
  const nodePath = quote(process.execPath);
  const okScript = quote('process.stderr.write("benign stderr\\n")');
  const failScript = quote('process.stderr.write("failure stderr\\n"); process.exitCode = 7');
  const script = `Import-Module ${modulePath} -Force
Start-LbaPlan
$ErrorActionPreference = 'Stop'
$out = Invoke-LbaHost -File ${nodePath} -Arguments @('-e', ${okScript})
if (($out -join "\`n") -notmatch 'benign stderr') { throw 'successful stderr was not retained' }
try { [void](Invoke-LbaHost -File ${nodePath} -Arguments @('-e', ${failScript})) } catch {
  if ($_.Exception.Message -match 'LBA_HOST: .*exited 7:.*failure stderr') { 'non-zero check passed'; exit 0 }
  throw
}
throw 'non-zero host exit was accepted'`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /non-zero check passed/);
}, { needsPwsh: true });

let passed = 0;
let skipped = 0;
try {
  for (const c of cases) {
    if ((c.needsPwsh && !havePwsh) || (c.needsPosix && !posix)) { skipped += 1; console.log(`skip ${c.id} ${c.name} (needs pwsh${c.needsPosix ? ' on a POSIX host' : ''})`); continue; }
    try { c.fn(); passed += 1; console.log(`ok ${c.id} ${c.name}`); } catch (error) { console.log(`FAIL ${c.id} ${c.name}\n${error.stack}`); process.exitCode = 1; }
  }
} finally { rmSync(work, { recursive: true, force: true }); }
console.log(`hyperv-driver selftest: ${passed}/${cases.length - skipped} passed${skipped ? `, ${skipped} skipped (no pwsh)` : ''}`);
