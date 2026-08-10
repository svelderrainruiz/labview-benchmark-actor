#!/usr/bin/env node

import assert from 'node:assert/strict';
import { generateEnrolledKeypair } from '../acg-provenance/attest.mjs';
import {
  WORKLOAD_ID,
  buildActorRequest,
  buildActorResponse,
  validateActorRequest,
  validateActorResponse,
} from './autonomousActorProtocol.mjs';

const requester = generateEnrolledKeypair();
const actor = generateEnrolledKeypair();
const requesterId = 'controller@host';
const actorId = 'linux-actor-01';
const requesterKeys = { [requesterId]: requester.publicKeyPem };
const actorKeys = { [actorId]: actor.publicKeyPem };
const now = new Date('2026-08-10T13:00:00.000Z');
const requestEnvelope = buildActorRequest({
  dispatchId: 'parent-integration-n3-20260810',
  taskId: 'parent-integration-n3-20260810::LINUX',
  plane: 'LINUX',
  requesterId,
  nonce: 'nonce-20260810-0001',
  issuedAt: '2026-08-10T12:59:00.000Z',
  expiresAt: '2026-08-10T13:09:00.000Z',
  candidate: { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), bundleSha256: 'c'.repeat(64) },
  workload: { id: WORKLOAD_ID, parameters: {} },
  privateKeyPem: requester.privateKeyPem,
});

const clone = (value) => structuredClone(value);
const requestOptions = { requesterKeys, now, expectedPlane: 'LINUX' };
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
};

test('accepts an enrolled signed allowlisted request bound to the candidate', () => {
  assert.equal(validateActorRequest(requestEnvelope, requestOptions).ok, true);
});

test('rejects an expired request', () => {
  assert.match(validateActorRequest(requestEnvelope, { ...requestOptions, now: new Date('2026-08-10T13:10:00.000Z') }).findings.join('\n'), /expired/);
});

test('rejects a replayed requester nonce', () => {
  assert.match(validateActorRequest(requestEnvelope, { ...requestOptions, seenNonces: new Set([`${requesterId}:nonce-20260810-0001`]) }).findings.join('\n'), /already accepted/);
});

test('rejects a workload outside the local allowlist', () => {
  const altered = clone(requestEnvelope);
  altered.request.workload.id = 'shell';
  assert.match(validateActorRequest(altered, requestOptions).findings.join('\n'), /not allowlisted/);
});

test('rejects request tampering under a valid enrolled requester identity', () => {
  const altered = clone(requestEnvelope);
  altered.request.candidate.bundleSha256 = 'd'.repeat(64);
  assert.match(validateActorRequest(altered, requestOptions).findings.join('\n'), /subject digest/);
});

test('rejects a valid signature from an unenrolled requester', () => {
  assert.match(validateActorRequest(requestEnvelope, { ...requestOptions, requesterKeys: {} }).findings.join('\n'), /not enrolled/);
});

const successEnvelope = buildActorResponse({
  request: requestEnvelope.request,
  actorId,
  plane: 'LINUX',
  status: 'SUCCESS',
  startedAt: '2026-08-10T13:00:01.000Z',
  completedAt: '2026-08-10T13:00:03.000Z',
  result: { operation: 'AddTwoNumbers.vi', observed: 3, expected: 3, verdict: 'PASS' },
  artifacts: [{ name: 'known-answer.json', sha256: 'e'.repeat(64), bytes: 128 }],
  privateKeyPem: actor.privateKeyPem,
});

test('accepts an enrolled actor-signed success bound to the exact request', () => {
  assert.equal(validateActorResponse(successEnvelope, { request: requestEnvelope.request, actorKeys, expectedActorId: actorId, expectedPlane: 'LINUX' }).ok, true);
});

test('rejects a success response rebound to another request', () => {
  const other = { ...requestEnvelope.request, nonce: 'nonce-20260810-0002' };
  assert.match(validateActorResponse(successEnvelope, { request: other, actorKeys }).findings.join('\n'), /requestDigest/);
});

test('rejects actor response tampering', () => {
  const altered = clone(successEnvelope);
  altered.response.result.observed = 4;
  assert.match(validateActorResponse(altered, { request: requestEnvelope.request, actorKeys }).findings.join('\n'), /subject digest/);
});

test('accepts a signed bounded BUSY response', () => {
  const busy = buildActorResponse({
    request: requestEnvelope.request,
    actorId,
    plane: 'LINUX',
    status: 'BUSY',
    startedAt: '2026-08-10T13:00:01.000Z',
    completedAt: '2026-08-10T13:00:01.000Z',
    failure: { code: 'ACTOR_BUSY' },
    privateKeyPem: actor.privateKeyPem,
  });
  assert.equal(validateActorResponse(busy, { request: requestEnvelope.request, actorKeys }).ok, true);
});

test('rejects an unsigned or unbounded failure response', () => {
  const altered = clone(successEnvelope);
  altered.response.status = 'FAILED';
  altered.response.result = null;
  altered.response.failure = { detail: 'arbitrary log data is not a bounded code' };
  assert.match(validateActorResponse(altered, { request: requestEnvelope.request, actorKeys }).findings.join('\n'), /bounded failure code/);
});

console.log(`# autonomous actor protocol selftest ${passed}/11 passed`);