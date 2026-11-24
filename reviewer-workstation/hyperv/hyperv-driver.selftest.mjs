#!/usr/bin/env node
// hyperv-driver.selftest.mjs -- proves the Hyper-V reviewer driver (#124) offline. The PowerShell steps run in
// dry-run mode, which records the plan instead of touching Hyper-V, the firewall or the network, so the command
// order, the firewall open/close, the guest paths and the fail-closed exits are asserted without a hypervisor.
// The pwsh cases are skipped (and reported as skipped) when pwsh is not installed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewTarget, parseEvidence } from '../build-review-target.mjs';
import { buildStageSender, stageIdentity } from '../release-stage-win.mjs';

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
const candidate = join(work, 'candidate');
mkdirSync(join(candidate, 'reviewer-workstation'), { recursive: true });
copyFileSync(join(root, 'package.json'), join(candidate, 'package.json'));
writeFileSync(join(candidate, 'release-components.json'), JSON.stringify(components));
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
const test = (id, name, fn, { needsPwsh = false } = {}) => cases.push({ id, name, fn, needsPwsh });

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
  assert.deepEqual(o.filter((x) => x !== 'guest-run' && x !== 'copy-to-guest').slice(0, 3), ['check-vm', 'host-run', 'host-run']);
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

let passed = 0;
let skipped = 0;
try {
  for (const c of cases) {
    if (c.needsPwsh && !havePwsh) { skipped += 1; console.log(`skip ${c.id} ${c.name} (pwsh not installed)`); continue; }
    try { c.fn(); passed += 1; console.log(`ok ${c.id} ${c.name}`); } catch (error) { console.log(`FAIL ${c.id} ${c.name}\n${error.stack}`); process.exitCode = 1; }
  }
} finally { rmSync(work, { recursive: true, force: true }); }
console.log(`hyperv-driver selftest: ${passed}/${cases.length - skipped} passed${skipped ? `, ${skipped} skipped (no pwsh)` : ''}`);
