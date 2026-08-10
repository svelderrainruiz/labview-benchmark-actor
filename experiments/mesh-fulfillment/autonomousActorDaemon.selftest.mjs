#!/usr/bin/env node

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEnrolledKeypair } from '../acg-provenance/attest.mjs';
import { WORKLOAD_ID, buildActorRequest } from './autonomousActorProtocol.mjs';
import { createAutonomousActorService } from './autonomousActorService.mjs';
import {
  BUS_SCHEMA,
  CURSOR_SCHEMA,
  DAEMON_CONFIG_SCHEMA,
  createBusLogPump,
  createLbabusSender,
  loadDaemonConfig,
  parseBusRequest,
  startAutonomousActorDaemon,
} from './autonomousActorDaemon.mjs';

const requester = generateEnrolledKeypair();
const actor = generateEnrolledKeypair();
const requesterId = 'controller@host';
const actorId = 'linux-actor-01';
const candidate = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), bundleSha256: 'c'.repeat(64) };
const now = new Date('2026-08-10T15:00:00.000Z');
let sequence = 0;

function requestEnvelope() {
  sequence += 1;
  return buildActorRequest({
    dispatchId: 'parent-integration-n3-20260810',
    taskId: `parent-integration-n3-20260810::LINUX::daemon-${sequence}`,
    plane: 'LINUX',
    requesterId,
    nonce: `daemon-nonce-${String(sequence).padStart(4, '0')}`,
    issuedAt: '2026-08-10T14:59:00.000Z',
    expiresAt: '2026-08-10T15:09:00.000Z',
    candidate,
    workload: { id: WORKLOAD_ID, parameters: {} },
    privateKeyPem: requester.privateKeyPem,
  });
}

function busEnvelope(request, overrides = {}) {
  return {
    schema: BUS_SCHEMA,
    sessionId: 'autonomous-actors',
    senderId: request.request.requesterId,
    seq: sequence,
    ts: { wall: now.toISOString(), run: sequence },
    type: 'CLAIM',
    task: request.request.taskId,
    payload: JSON.stringify(request),
    ackOf: null,
    ...overrides,
  };
}

function serviceHarness(execute) {
  const root = mkdtempSync(join(tmpdir(), 'lba-autonomous-daemon-'));
  const service = createAutonomousActorService({
    actorId,
    plane: 'LINUX',
    privateKeyPem: actor.privateKeyPem,
    requesterKeys: { [requesterId]: requester.publicKeyPem },
    expectedCandidate: candidate,
    statePath: join(root, 'state.json'),
    artifactDir: join(root, 'cas'),
    workloads: { [WORKLOAD_ID]: execute },
    now: () => now,
  });
  return { root, service, logPath: join(root, 'bus.jsonl'), cursorPath: join(root, 'cursor.json') };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

await test('accepts only CLAIM payloads bound to bus sender and task metadata', () => {
  const request = requestEnvelope();
  const valid = busEnvelope(request);
  assert.deepEqual(parseBusRequest(valid), request);
  assert.deepEqual(parseBusRequest({ ...valid, senderId: valid.senderId.toUpperCase() }), request);
  assert.equal(parseBusRequest({ ...valid, type: 'NOTE' }), null);
  assert.equal(parseBusRequest({ ...valid, senderId: 'spoofed-controller' }), null);
  assert.equal(parseBusRequest({ ...valid, task: 'different-task' }), null);
  assert.equal(parseBusRequest({ ...valid, payload: '{invalid' }), null);
});

await test('waits for a complete JSONL entry before executing and advancing the cursor', async () => {
  let executions = 0;
  const h = serviceHarness(async () => { executions += 1; return { result: { verdict: 'PASS' } }; });
  try {
    const line = JSON.stringify(busEnvelope(requestEnvelope()));
    writeFileSync(h.logPath, line, 'utf8');
    const sent = [];
    const pump = createBusLogPump({ ...h, sendResponse: async (response) => sent.push(response) });
    assert.deepEqual(await pump.pumpOnce(), { processed: 0, offset: 0 });
    appendFileSync(h.logPath, '\n', 'utf8');
    const result = await pump.pumpOnce();
    assert.equal(result.processed, 1);
    assert.equal(result.offset, Buffer.byteLength(`${line}\n`));
    assert.equal(executions, 1);
    assert.equal(sent[0].response.status, 'SUCCESS');
    assert.deepEqual(JSON.parse(readFileSync(h.cursorPath, 'utf8')), { schema: CURSOR_SCHEMA, offset: result.offset });
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('retries a failed send from the unchanged cursor without re-executing', async () => {
  let executions = 0;
  let sends = 0;
  const h = serviceHarness(async () => { executions += 1; return { result: { verdict: 'PASS' } }; });
  try {
    writeFileSync(h.logPath, `${JSON.stringify(busEnvelope(requestEnvelope()))}\n`, 'utf8');
    const pump = createBusLogPump({
      ...h,
      sendResponse: async () => { sends += 1; if (sends === 1) throw new Error('peer unavailable'); },
    });
    await assert.rejects(() => pump.pumpOnce(), /peer unavailable/);
    assert.equal(pump.inspect().offset, 0);
    assert.equal((await pump.pumpOnce()).processed, 1);
    assert.equal(executions, 1);
    assert.equal(sends, 2);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('processes one concurrent task and signs BUSY for the next CLAIM in one batch', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const h = serviceHarness(async () => { await blocker; return { result: { verdict: 'PASS' } }; });
  try {
    const first = busEnvelope(requestEnvelope());
    const second = busEnvelope(requestEnvelope());
    writeFileSync(h.logPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf8');
    const statuses = [];
    const pump = createBusLogPump({ ...h, sendResponse: async (response) => statuses.push(response.response.status) });
    const pending = pump.pumpOnce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(statuses, ['BUSY']);
    release();
    assert.equal((await pending).processed, 2);
    assert.deepEqual(statuses.sort(), ['BUSY', 'SUCCESS']);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('sends a signed response through lbabus message-file with no shell', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lba-autonomous-sender-'));
  let invocation;
  const sender = createLbabusSender({
    lbabusPath: '/opt/lbabus', hosts: '192.168.56.1', tcpPort: 7420,
    session: 'n3', runtimeDir: root, actorId,
  }, {
    execFile: async (executable, args, options) => {
      const messagePath = args[args.indexOf('--message-file') + 1];
      invocation = { executable, args, options, body: JSON.parse(readFileSync(messagePath, 'utf8')), messagePath };
    },
  });
  const response = { response: { status: 'SUCCESS', taskId: 'task-1' }, attestation: { signature: 'public-only' } };
  await sender(response);
  assert.equal(invocation.executable, '/opt/lbabus');
  assert.equal(invocation.args.includes('--message-file'), true);
  assert.equal(invocation.args[invocation.args.indexOf('--type') + 1], 'DONE');
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.body, response);
  assert.equal(existsSync(invocation.messagePath), false);
  rmSync(root, { recursive: true, force: true });
});

await test('loads private material and fixed workload configuration from local paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lba-autonomous-config-'));
  writeFileSync(join(root, 'actor.pem'), actor.privateKeyPem, { mode: 0o600 });
  writeFileSync(join(root, 'requesters.json'), JSON.stringify({ [requesterId]: requester.publicKeyPem }));
  const configPath = join(root, 'actor.json');
  writeFileSync(configPath, JSON.stringify({
    schema: DAEMON_CONFIG_SCHEMA,
    actorId,
    plane: 'LINUX',
    privateKeyPath: 'actor.pem',
    requesterKeysPath: 'requesters.json',
    expectedCandidate: candidate,
    statePath: 'state/actor.json',
    artifactDir: 'artifacts',
    workloads: { [WORKLOAD_ID]: { executable: '/opt/lba-known-answer', args: ['--fixed'], timeoutMs: 1000 } },
    bus: { lbabusPath: 'bin/lbabus', logPath: 'bus/receive.jsonl', cursorPath: 'state/cursor.json', runtimeDir: 'run', hosts: '192.168.56.1' },
  }));
  let helperArgs;
  const loaded = loadDaemonConfig(configPath, { execFile: async (_executable, args) => { helperArgs = args; return { stdout: '{"verdict":"PASS"}', stderr: '' }; } });
  assert.equal(loaded.privateKeyPem, actor.privateKeyPem);
  assert.equal(loaded.statePath, join(root, 'state/actor.json'));
  assert.equal(loaded.bus.logPath, join(root, 'bus/receive.jsonl'));
  await loaded.workloads[WORKLOAD_ID]({ request: { workload: { parameters: { command: 'ignored' } } } });
  assert.deepEqual(helperArgs, ['--fixed']);
  rmSync(root, { recursive: true, force: true });
});

await test('starts and stops the configured lbabus listener without a shell', async () => {
  const h = serviceHarness(async () => ({ result: { verdict: 'PASS' } }));
  let spawnInvocation;
  let cleared = false;
  const listener = { pid: 1234, killed: false, kill() { this.killed = true; } };
  const config = {
    actorId,
    plane: 'LINUX',
    privateKeyPem: actor.privateKeyPem,
    requesterKeys: { [requesterId]: requester.publicKeyPem },
    expectedCandidate: candidate,
    statePath: join(h.root, 'daemon-state.json'),
    artifactDir: join(h.root, 'daemon-cas'),
    workloads: { [WORKLOAD_ID]: async () => ({ result: {} }) },
    bus: { lbabusPath: '/opt/lbabus', logPath: h.logPath, cursorPath: h.cursorPath, runtimeDir: join(h.root, 'run'), hosts: '192.168.56.1', tcpPort: 7420, bind: '0.0.0.0', session: 'n3', pollMs: 250 },
  };
  const daemon = await startAutonomousActorDaemon(config, {
    spawn: (executable, args, options) => { spawnInvocation = { executable, args, options }; return listener; },
    execFile: async () => {},
    setIntervalFn: () => 99,
    clearIntervalFn: (timer) => { assert.equal(timer, 99); cleared = true; },
  });
  assert.equal(spawnInvocation.executable, '/opt/lbabus');
  assert.deepEqual(spawnInvocation.args.slice(0, 2), ['net', 'listen']);
  assert.equal(spawnInvocation.options.shell, false);
  daemon.stop();
  assert.equal(listener.killed, true);
  assert.equal(cleared, true);
  rmSync(h.root, { recursive: true, force: true });
});

console.log(`# autonomous actor daemon selftest ${passed}/7 passed`);