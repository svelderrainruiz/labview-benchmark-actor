#!/usr/bin/env node
// release-stage-win.selftest.mjs -- proves the release phase 7 driver (#73) offline with a fake VBoxManage and a fake
// bus listener: the happy path records a staged frame bound to the candidate, every guest run passes no argv0 and
// no password on the command line, and each broken precondition fails closed before any evidence is written.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildConfigureVisual,
  buildInstallScript,
  buildStageSender,
  evidenceFromAttestation,
  GUEST_POWERSHELL,
  guestRunArgs,
  stagePaths,
  stageTaskId,
  stageWin,
} from './release-stage-win.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const attestation = JSON.parse(readFileSync(join(here, '..', 'experiments', 'acg-quorum', 'cross-plane-attestation-receipt.json'), 'utf8'));
const commit = attestation.provenance.commit;
const version = '1.2.3';
const vsixBytes = Buffer.from('PK\u0003\u0004 fake candidate');
const vsixSha256 = createHash('sha256').update(vsixBytes).digest('hex');
const extensionId = 'pub.ext';
const share = '/share';
const scratchDir = join('/tmp', 'scratch'); // path.join form, so the expectations hold on Windows too

function fakeIo({ vmState = 'running', guestSha = vsixSha256, installed = true, listenerCode = 0, files: extra = {}, portBusy = false, binds = true, senderFails = false } = {}) {
  const files = new Map(Object.entries({
    '/c/candidate.vsix': vsixBytes,
    '/c/attestation.json': JSON.stringify(attestation),
    '/c/visual.pem': 'PRIVATE',
    '/c/vm-pass': 'secret\n',
    ...extra,
  }));
  const calls = [];
  const state = { listening: false, stopped: false };
  const io = {
    calls,
    files,
    state,
    run: (cmd, args, options = {}) => {
      calls.push({ cmd, args, env: options.env });
      if (cmd === 'VBoxManage' && args[0] === 'showvminfo') return { status: 0, stdout: `name="vm"\nVMState="${vmState}"\n`, stderr: '' };
      if (cmd === 'bash') return { status: 0, stdout: '', stderr: '[render-verdict] review target set' };
      const verb = args[6];
      if (verb !== 'run') return { status: 0, stdout: '', stderr: '' };
      const exe = args[8];
      const rest = args.slice(args.indexOf('--') + 1);
      if (exe === GUEST_POWERSHELL && rest.includes('-Command')) return { status: 0, stdout: `${guestSha.toUpperCase()}\r\n`, stderr: '' };
      if (exe === GUEST_POWERSHELL && rest.some((a) => a.endsWith(`lba-install-${version}.ps1`))) {
        return installed ? { status: 0, stdout: `Installing...\r\nINSTALLED=${extensionId}@${version}\r\n`, stderr: '' } : { status: 1, stdout: 'INSTALL_ERROR=not listed', stderr: '' };
      }
      if (exe === GUEST_POWERSHELL) return { status: 0, stdout: 'REVIEWER_KEY=x\r\nSTALE_VERDICT_CLEARED=True\r\n', stderr: '' };
      if (senderFails) return { status: 1, stdout: 'connect refused', stderr: '' };
      return { status: 0, stdout: `sent\nSTAGED_SHA256=${vsixSha256}\n`, stderr: '' };
    },
    startListener: (args) => {
      calls.push({ cmd: 'listener', args });
      const out = args[args.indexOf('--out') + 1];
      const task = args[args.indexOf('--task') + 1];
      const payload = JSON.stringify({ schema: 'labview-benchmark-actor/release-stage@1', candidate: { component: 'extension', version, commit, vsixSha256 } });
      if (listenerCode === 0) {
        files.set(out, JSON.stringify({ matched: true, expected: { type: 'DONE', task }, reply: { senderId: 'WIN', type: 'DONE', task, payload } }));
      }
      state.listening = binds;
      // A real listener releases the port when it exits; `done` settles lazily, when the driver awaits it.
      const done = { then: (resolveDone, rejectDone) => { state.listening = false; return Promise.resolve({ code: senderFails ? 143 : listenerCode }).then(resolveDone, rejectDone); } };
      return { ready: Promise.resolve(true), done, stop: () => { state.stopped = true; state.listening = false; } };
    },
    readFile: (path, encoding) => {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      const v = files.get(path);
      return encoding ? String(v) : Buffer.from(v);
    },
    writeFile: (path, data) => files.set(path, data),
    exists: (path) => files.has(path) || path === scratchDir,
    mkdir: (path) => { files.set(`${path}/`, ''); },
    tempDir: () => scratchDir,
    portInUse: async () => portBusy || state.listening,
    sleep: async () => {},
    remove: (path) => { for (const k of [...files.keys()]) if (k.startsWith(path)) files.delete(k); },
    log: () => {},
  };
  return io;
}

const options = (overrides = {}) => ({
  components: { extension: version },
  version, vm: 'reviewer', commit, vsix: '/c/candidate.vsix', attestation: '/c/attestation.json', share,
  visualKey: '/c/visual.pem', passwordFile: '/c/vm-pass', extensionId, ...overrides,
});

const savedPass = process.env.LBA_VM_PASS;
delete process.env.LBA_VM_PASS;
let passed = 0;
const ok = (name) => { passed += 1; console.log(`  PASS  ${name}`); };

// Pure builders.
const task = stageTaskId({ version, commit });
assert.equal(task, `stage-${version}-${commit.slice(0, 7)}-json`);
const sender = buildStageSender({ version, commit, vsixSha256 });
assert.ok(sender.includes(`'--task', "${task}"`) && sender.includes(`const expected = "${vsixSha256}";`) && sender.includes('"10.0.2.2"'));
assert.ok(buildInstallScript({ extensionId, version }).includes("$ErrorActionPreference = 'Continue'"));
assert.ok(buildInstallScript({ extensionId, version }).includes(`INSTALLED=${extensionId}@${version}`));
assert.ok(buildInstallScript({ extensionId, version }).includes('if ($installExit -ne 0)'), 'a failed install fails even if an older build of the version is listed');
assert.ok(buildConfigureVisual({ extensionId, version, reviewerId: 'r@x.y' }).includes(`reviewer\\${version}\\reviewer-visual.pem`));
const runArgs = guestRunArgs({ vm: 'vm', user: 'u', passwordFile: '/p', exe: 'C:\\node.exe', args: ['C:\\s.mjs'] });
assert.deepEqual(runArgs.slice(runArgs.indexOf('--') + 1), ['C:\\s.mjs']);
assert.ok(!runArgs.includes('--password') && runArgs.includes('--passwordfile'));
assert.deepEqual(evidenceFromAttestation(attestation, { commit, taskId: task }), [
  `cross-plane-run:${attestation.provenance.runId}`, `attestation-sha256:${attestation.digest}`, `windows-stage:${task}`,
]);
assert.throws(() => evidenceFromAttestation(attestation, { commit: 'f'.repeat(40), taskId: task }), /not the candidate/);
assert.throws(() => evidenceFromAttestation({ ...attestation, digest: '0'.repeat(64) }, { commit, taskId: task }), /does not validate/);
ok('builders: task id, sender identity, PS5-tolerant install, per-version key, no argv0, password file only, attestation evidence');

// Happy path.
{
  const io = fakeIo();
  const receiptSha256 = 'c'.repeat(64);
  const result = await stageWin(options({ components: { extension: version, reviewerInfrastructure: {
    schema: 'reviewer-infrastructure@1', baseline: 'v0.1.0', receiptSha256,
  } } }), io);
  const frame = JSON.parse(String(io.files.get(stagePaths({ share, version }).stagedFrame)));
  assert.equal(frame.matched, true);
  assert.deepEqual(frame.candidate, { component: 'extension', version, commit, vsixSha256 });
  assert.equal(result.taskId, task);
  const order = io.calls.map((c) => (c.cmd === 'VBoxManage' ? (c.args[0] === 'showvminfo' ? 'state' : c.args[6]) : c.cmd));
  assert.deepEqual(order, ['state', 'mkdir', 'mkdir', 'rm', 'copyto', 'copyto', 'copyto', 'run', 'run', 'run', 'listener', 'run', 'bash']);
  assert.ok(io.files.has(`${share}/`), 'the share exists before the listener writes its readback');
  for (const c of io.calls.filter((x) => x.cmd === 'VBoxManage' && x.args[0] === 'guestcontrol')) {
    assert.ok(!c.args.includes('--password') && !c.args.includes('secret'), 'no password on a VBoxManage command line');
    assert.equal(c.args[c.args.indexOf('--passwordfile') + 1], join(scratchDir, 'vm-pass'));
    if (c.args[6] === 'run') assert.ok(!/node\.exe$|powershell\.exe$/i.test(c.args[c.args.indexOf('--') + 1]), 'no argv0 after --');
  }
  const target = io.calls.find((c) => c.cmd === 'bash');
  assert.equal(target.env.LBA_VM_PASS, 'secret', 'set-target receives the trimmed password through the environment');
  assert.deepEqual(target.args.filter((a, i) => target.args[i - 1] === '--evidence'), [
    ...evidenceFromAttestation(attestation, { commit, taskId: task }), `reviewer-infrastructure-receipt-sha256:${receiptSha256}`,
  ]);
  assert.ok(![...io.files.keys()].some((k) => k.startsWith(scratchDir)), 'the scratch password copy is removed');
  ok('happy path: ordered staging, staged frame bound to the candidate, evidence-bound set-target, scratch removed');
}

// Fail-closed cases: each must throw and write no staged frame.
const failures = [
  ['VM not running', options(), { vmState: 'saved' }, /is not running/],
  ['VM holds different bytes', options(), { guestSha: 'e'.repeat(64) }, /hashes to/],
  ['install not confirmed', options(), { installed: false }, /did not confirm/],
  ['listener did not correlate', options(), { listenerCode: 1 }, /did not correlate/],
  ['candidate hash mismatch', options({ vsixSha256: 'a'.repeat(64) }), {}, /--vsix hashes to/],
  ['attestation for another commit', options({ commit: 'f'.repeat(40) }), {}, /not the candidate/],
  ['missing visual key', options({ visualKey: '/c/none.pem' }), {}, /enroll the/],
  ['existing staged frame without --force', options(), { files: { [stagePaths({ share, version }).stagedFrame]: '{}' } }, /refusing to overwrite/],
  ['no password', options({ passwordFile: '/c/none' }), {}, /no VM password/],
  ['stale listener already on TCP 7420', options(), { portBusy: true }, /already in use/],
  ['listener never binds TCP 7420', options(), { binds: false }, /did not bind/],
  ['sender fails', options(), { senderFails: true }, /in-VM sender failed/],
  ['invalid timeout', options({ timeout: Number.NaN }), {}, /--timeout must be/],
];
for (const [name, opts, io, pattern] of failures) {
  const fake = fakeIo(io);
  const before = fake.files.get(stagePaths({ share, version }).stagedFrame);
  await assert.rejects(() => stageWin(opts, fake), pattern, name);
  assert.equal(fake.files.get(stagePaths({ share, version }).stagedFrame), before, `${name}: no staged frame written`);
  assert.equal(fake.state.listening, false, `${name}: no listener left holding the port`);
  if (name === 'sender fails') assert.equal(fake.state.stopped, true, 'a failed sender stops the listener');
}
ok(`fail closed: ${failures.map(([n]) => n).join('; ')}`);

// Dry run touches nothing.
{
  const io = fakeIo();
  const result = await stageWin(options({ dryRun: true }), io);
  assert.equal(io.calls.length, 0);
  assert.equal(result.plan.length, 7);
  ok('dry run prints the plan and runs nothing');
}

if (savedPass !== undefined) process.env.LBA_VM_PASS = savedPass;
console.log(`release-stage-win selftest: ${passed}/4 passed`);
