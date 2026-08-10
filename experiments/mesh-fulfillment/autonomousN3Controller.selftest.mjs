#!/usr/bin/env node

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { buildActorResponse } from './autonomousActorProtocol.mjs';
import { buildAutonomousN3Dispatch, decideAutonomousN3 } from './autonomousN3Controller.mjs';

const keypair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
};
const requester = keypair();
const actors = [
  { id: 'linux-01', plane: 'LINUX', ...keypair() },
  { id: 'linux-02', plane: 'LINUX', ...keypair() },
  { id: 'win-01', plane: 'WIN', ...keypair() },
];
const candidate = {
  sourceCommit: '1'.repeat(40),
  sourceTree: '2'.repeat(40),
  bundleSha256: '3'.repeat(64),
};
const dispatch = buildAutonomousN3Dispatch({
  dispatchId: 'controller-selftest',
  requesterId: 'controller',
  privateKeyPem: requester.privateKeyPem,
  candidate,
  actors,
  issuedAt: '2026-08-10T12:00:00.000Z',
  nonce: (actor) => `nonce_${actor.id.replaceAll('-', '_')}_0001`,
});
const responses = dispatch.requests.map((requestEnvelope, index) => buildActorResponse({
  request: requestEnvelope.request,
  actorId: actors[index].id,
  plane: actors[index].plane,
  status: 'SUCCESS',
  startedAt: '2026-08-10T12:00:01.000Z',
  completedAt: '2026-08-10T12:00:02.000Z',
  result: { observed: 3, expected: 3, verdict: 'PASS' },
  privateKeyPem: actors[index].privateKeyPem,
}));
const actorKeys = Object.fromEntries(actors.map((actor) => [actor.id, actor.publicKeyPem]));
const requesterKeys = { controller: requester.publicKeyPem };
const decide = (overrides = {}) => decideAutonomousN3({ dispatch, responses, requesterKeys, actorKeys, sealedCandidate: candidate, ...overrides });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

test('builds one signed actor-bound request per distinct cross-plane actor', () => {
  assert.equal(dispatch.requests.length, 3);
  assert.deepEqual(dispatch.requests.map((entry) => entry.request.taskId), [
    'controller-selftest::linux-01',
    'controller-selftest::linux-02',
    'controller-selftest::win-01',
  ]);
});

test('consumes only the complete signed N=3 response set for the sealed candidate', () => {
  const decision = decide();
  assert.equal(decision.consume, true);
  assert.equal(decision.actors.every((actor) => actor.ok), true);
});

test('fails closed on a missing actor response', () => {
  assert.equal(decide({ responses: responses.slice(1) }).consume, false);
});

test('fails closed on a duplicate actor response', () => {
  assert.equal(decide({ responses: [...responses, responses[0]] }).consume, false);
});

test('fails closed on an unknown response task', () => {
  const unknown = structuredClone(responses[0]);
  unknown.response.taskId = 'controller-selftest::unknown';
  assert.equal(decide({ responses: [...responses, unknown] }).consume, false);
});

test('fails closed on candidate drift', () => {
  assert.equal(decide({ sealedCandidate: { ...candidate, bundleSha256: '4'.repeat(64) } }).consume, false);
});

test('fails closed without throwing on a malformed sealed candidate', () => {
  assert.equal(decide({ sealedCandidate: null }).consume, false);
});

test('fails closed on response tampering', () => {
  const tampered = structuredClone(responses);
  tampered[0].response.result.observed = 4;
  assert.equal(decide({ responses: tampered }).consume, false);
});

test('fails closed on a signed wrong known answer', () => {
  const wrong = [...responses];
  wrong[0] = buildActorResponse({
    request: dispatch.requests[0].request,
    actorId: actors[0].id,
    plane: actors[0].plane,
    status: 'SUCCESS',
    startedAt: '2026-08-10T12:00:01.000Z',
    completedAt: '2026-08-10T12:00:02.000Z',
    result: { observed: 4, expected: 3, verdict: 'FAIL' },
    privateKeyPem: actors[0].privateKeyPem,
  });
  assert.equal(decide({ responses: wrong }).consume, false);
});

test('fails closed on requester-envelope tampering', () => {
  const alteredDispatch = structuredClone(dispatch);
  alteredDispatch.requests[0].request.nonce = 'altered_nonce_0000001';
  assert.equal(decide({ dispatch: alteredDispatch }).consume, false);
});

console.log(`1..${passed}`);