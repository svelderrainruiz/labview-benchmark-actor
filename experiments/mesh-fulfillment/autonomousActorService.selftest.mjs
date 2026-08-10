#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEnrolledKeypair } from '../acg-provenance/attest.mjs';
import {
  WORKLOAD_ID,
  buildActorRequest,
  validateActorResponse,
} from './autonomousActorProtocol.mjs';
import {
  MAX_RESULT_BYTES,
  createAutonomousActorService,
  createCommandWorkloadAdapter,
} from './autonomousActorService.mjs';

const requester = generateEnrolledKeypair();
const actor = generateEnrolledKeypair();
const requesterId = 'controller@host';
const actorId = 'linux-actor-01';
const candidate = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), bundleSha256: 'c'.repeat(64) };
const now = new Date('2026-08-10T14:00:00.000Z');
let nonceSequence = 0;

function requestEnvelope(overrides = {}) {
  nonceSequence += 1;
  return buildActorRequest({
    dispatchId: 'parent-integration-n3-20260810',
    taskId: `parent-integration-n3-20260810::LINUX::${nonceSequence}`,
    plane: 'LINUX',
    requesterId,
    nonce: `service-nonce-${String(nonceSequence).padStart(4, '0')}`,
    issuedAt: '2026-08-10T13:59:00.000Z',
    expiresAt: '2026-08-10T14:09:00.000Z',
    candidate,
    workload: { id: WORKLOAD_ID, parameters: { ignoredByAdapter: 'never-an-argument' } },
    privateKeyPem: requester.privateKeyPem,
    ...overrides,
  });
}

function harness(execute, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lba-autonomous-actor-'));
  const options = {
    actorId,
    plane: 'LINUX',
    privateKeyPem: actor.privateKeyPem,
    requesterKeys: { [requesterId]: requester.publicKeyPem },
    expectedCandidate: candidate,
    statePath: join(root, 'state', 'actor.json'),
    artifactDir: join(root, 'cas'),
    workloads: { [WORKLOAD_ID]: execute },
    now: () => now,
    ...overrides,
  };
  return { root, options, service: createAutonomousActorService(options) };
}

function assertSigned(response, request, expectedStatus, expectedCode = null, expectedPlane = 'LINUX') {
  assert.equal(response.response.status, expectedStatus);
  assert.equal(response.response.failure?.code ?? null, expectedCode);
  assert.equal(validateActorResponse(response, {
    request: request.request,
    actorKeys: { [actorId]: actor.publicKeyPem },
    expectedActorId: actorId,
    expectedPlane,
  }).ok, true);
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

await test('persists an accepted nonce and stores bounded artifacts by content digest', async () => {
  const h = harness(async () => ({ result: { verdict: 'PASS', observed: 3 }, artifacts: [{ name: 'known-answer.json', content: '{"observed":3}\n' }] }));
  try {
    const request = requestEnvelope();
    const response = await h.service.handleRequest(request);
    assertSigned(response, request, 'SUCCESS');
    assert.equal(response.response.artifacts.length, 1);
    assert.equal(existsSync(join(h.options.artifactDir, response.response.artifacts[0].sha256)), true);
    const state = JSON.parse(readFileSync(h.options.statePath, 'utf8'));
    assert.equal(state.seenNonces.length, 1);
    assert.equal(state.active, null);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('returns the cached signed outcome after restart without re-executing', async () => {
  let executions = 0;
  const h = harness(async () => { executions += 1; return { result: { verdict: 'PASS' } }; });
  try {
    const request = requestEnvelope();
    const first = await h.service.handleRequest(request);
    const restarted = createAutonomousActorService(h.options);
    const replay = await restarted.handleRequest(request);
    assert.deepEqual(replay, first);
    assert.equal(executions, 1);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('rejects a signed request for a candidate not staged on the actor', async () => {
  let executed = false;
  const h = harness(async () => { executed = true; return { result: {} }; });
  try {
    const request = requestEnvelope({ candidate: { ...candidate, bundleSha256: 'd'.repeat(64) } });
    const response = await h.service.handleRequest(request);
    assertSigned(response, request, 'REJECTED', 'CANDIDATE_MISMATCH');
    assert.equal(executed, false);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('returns a signed BUSY outcome for a second valid request while one task runs', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const h = harness(async () => { await blocker; return { result: { verdict: 'PASS' } }; });
  try {
    const firstRequest = requestEnvelope();
    const firstPromise = h.service.handleRequest(firstRequest);
    const busyRequest = requestEnvelope();
    const busy = await h.service.handleRequest(busyRequest);
    assertSigned(busy, busyRequest, 'BUSY', 'ACTOR_BUSY');
    const stillBusyRequest = requestEnvelope();
    assertSigned(await h.service.handleRequest(stillBusyRequest), stillBusyRequest, 'BUSY', 'ACTOR_BUSY');
    assert.notEqual(h.service.inspect().active, null);
    release();
    assertSigned(await firstPromise, firstRequest, 'SUCCESS');
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('recovers a task left active by a process interruption as a signed failure', async () => {
  const never = new Promise(() => {});
  const h = harness(async () => never);
  const request = requestEnvelope();
  void h.service.handleRequest(request);
  const restarted = createAutonomousActorService(h.options);
  const recovered = restarted.recoverInterrupted();
  assertSigned(recovered, request, 'FAILED', 'ACTOR_INTERRUPTED');
  rmSync(h.root, { recursive: true, force: true });
});

await test('maps an oversized result to a bounded signed failure', async () => {
  const h = harness(async () => ({ result: { value: 'x'.repeat(MAX_RESULT_BYTES) } }));
  try {
    const request = requestEnvelope();
    const response = await h.service.handleRequest(request);
    assertSigned(response, request, 'FAILED', 'RESULT_TOO_LARGE');
    assert.equal(response.response.result, null);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('does not consume a nonce when an invalid signature is rejected', async () => {
  let executions = 0;
  const h = harness(async () => { executions += 1; return { result: { verdict: 'PASS' } }; });
  try {
    const valid = requestEnvelope();
    const tampered = structuredClone(valid);
    tampered.request.candidate.sourceTree = 'e'.repeat(40);
    assertSigned(await h.service.handleRequest(tampered), tampered, 'REJECTED', 'INVALID_REQUEST');
    assertSigned(await h.service.handleRequest(valid), valid, 'SUCCESS');
    assert.equal(executions, 1);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('signs a wrong-target rejection with the actor actual plane', async () => {
  const h = harness(async () => ({ result: {} }), { plane: 'WIN' });
  try {
    const request = requestEnvelope();
    const response = await h.service.handleRequest(request);
    assertSigned(response, request, 'REJECTED', 'INVALID_REQUEST', 'WIN');
    assert.equal(response.response.plane, 'WIN');
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

await test('fixed-command adapter never turns request parameters into argv', async () => {
  let invocation;
  const adapter = createCommandWorkloadAdapter({ executable: 'known-answer-helper', args: ['--fixed'], cwd: '/activated-user' }, {
    execFile: async (executable, args, options) => {
      invocation = { executable, args, options };
      return { stdout: '{"verdict":"PASS","observed":3}\n', stderr: '' };
    },
  });
  const output = await adapter({ request: requestEnvelope().request });
  assert.deepEqual(invocation.args, ['--fixed']);
  assert.equal(invocation.options.shell, false);
  assert.equal(output.result.observed, 3);
  assert.equal(output.artifacts[0].name, 'workload-stdout.json');
});

await test('fixed-command adapter rejects non-JSON helper output', async () => {
  const adapter = createCommandWorkloadAdapter({ executable: 'known-answer-helper' }, {
    execFile: async () => ({ stdout: 'RunVI operation succeeded, but this is not the governed helper contract', stderr: '' }),
  });
  await assert.rejects(() => adapter(), (error) => error.code === 'INVALID_WORKLOAD_RESULT');
});

console.log(`# autonomous actor service selftest ${passed}/10 passed`);