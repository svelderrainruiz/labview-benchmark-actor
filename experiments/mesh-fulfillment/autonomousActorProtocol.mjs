#!/usr/bin/env node

import { bundleDigest, signBundle, verifyWitnessAttestation } from '../acg-provenance/attest.mjs';

export const REQUEST_SCHEMA = 'labview-benchmark-actor/autonomous-actor-request@1';
export const RESPONSE_SCHEMA = 'labview-benchmark-actor/autonomous-actor-response@1';
export const WORKLOAD_ID = 'labviewcli-known-answer-v1';
export const RESPONSE_STATUSES = new Set(['SUCCESS', 'REJECTED', 'BUSY', 'FAILED']);

const isDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isCommit = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function buildActorRequest({
  dispatchId,
  taskId,
  plane,
  requesterId,
  nonce,
  issuedAt,
  expiresAt,
  candidate,
  workload = { id: WORKLOAD_ID, parameters: {} },
  privateKeyPem,
} = {}) {
  const request = {
    schema: REQUEST_SCHEMA,
    dispatchId: dispatchId ?? null,
    taskId: taskId ?? null,
    plane: plane ?? null,
    requesterId: requesterId ?? null,
    nonce: nonce ?? null,
    issuedAt: issuedAt ?? null,
    expiresAt: expiresAt ?? null,
    candidate: candidate ?? null,
    workload,
  };
  return {
    request,
    attestation: signBundle(request, { privateKeyPem, identity: requesterId }),
  };
}

export function validateActorRequest(envelope, {
  requesterKeys = {},
  allowedWorkloads = [WORKLOAD_ID],
  now = new Date(),
  seenNonces = new Set(),
  expectedPlane,
} = {}) {
  const findings = [];
  const request = envelope?.request;
  if (request?.schema !== REQUEST_SCHEMA) findings.push(`schema must be ${REQUEST_SCHEMA}`);
  if (typeof request?.dispatchId !== 'string' || !request.dispatchId) findings.push('dispatchId is required');
  if (typeof request?.taskId !== 'string' || !request.taskId) findings.push('taskId is required');
  if (!['LINUX', 'WIN'].includes(request?.plane)) findings.push('plane must be LINUX or WIN');
  if (expectedPlane && request?.plane !== expectedPlane) findings.push(`request plane does not match actor plane ${expectedPlane}`);
  if (typeof request?.requesterId !== 'string' || !request.requesterId) findings.push('requesterId is required');
  if (typeof request?.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(request.nonce)) findings.push('nonce must be 16-128 URL-safe characters');
  if (!isTimestamp(request?.issuedAt) || !isTimestamp(request?.expiresAt)) findings.push('issuedAt and expiresAt must be timestamps');
  const issuedMs = Date.parse(request?.issuedAt);
  const expiresMs = Date.parse(request?.expiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (Number.isFinite(issuedMs) && Number.isFinite(expiresMs)) {
    if (expiresMs <= issuedMs) findings.push('expiresAt must be after issuedAt');
    if (expiresMs - issuedMs > 15 * 60 * 1000) findings.push('request lifetime exceeds 15 minutes');
    if (issuedMs > nowMs + 60 * 1000) findings.push('request is issued too far in the future');
    if (expiresMs <= nowMs) findings.push('request has expired');
  }
  const replayKey = `${request?.requesterId ?? ''}:${request?.nonce ?? ''}`;
  if (seenNonces.has(replayKey)) findings.push('request nonce was already accepted');
  if (!allowedWorkloads.includes(request?.workload?.id)) findings.push('workload is not allowlisted');
  if (request?.workload?.parameters == null || typeof request.workload.parameters !== 'object' || Array.isArray(request.workload.parameters)) findings.push('workload parameters must be an object');
  if (!isCommit(request?.candidate?.sourceCommit)) findings.push('candidate sourceCommit must be 40 lowercase hex characters');
  if (!isCommit(request?.candidate?.sourceTree)) findings.push('candidate sourceTree must be 40 lowercase hex characters');
  if (!isDigest(request?.candidate?.bundleSha256)) findings.push('candidate bundleSha256 must be 64 lowercase hex characters');
  const signature = verifyWitnessAttestation(request, envelope?.attestation, { allowlist: requesterKeys });
  if (!signature.ok) findings.push(`request signature: ${signature.reasons.join('; ')}`);
  return {
    ok: findings.length === 0,
    findings,
    requestDigest: request && typeof request === 'object' ? bundleDigest(request) : null,
    replayKey,
  };
}

export function buildActorResponse({
  request,
  actorId,
  plane,
  status,
  startedAt,
  completedAt,
  result = null,
  artifacts = [],
  failure = null,
  privateKeyPem,
} = {}) {
  const response = {
    schema: RESPONSE_SCHEMA,
    dispatchId: request?.dispatchId ?? null,
    taskId: request?.taskId ?? null,
    requestDigest: request ? bundleDigest(request) : null,
    actorId: actorId ?? null,
    plane: plane ?? null,
    status: status ?? null,
    startedAt: startedAt ?? null,
    completedAt: completedAt ?? null,
    result,
    artifacts: artifacts.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes })),
    failure,
  };
  return {
    response,
    attestation: signBundle(response, { privateKeyPem, identity: actorId }),
  };
}

export function validateActorResponse(envelope, { request, actorKeys = {}, expectedActorId, expectedPlane } = {}) {
  const findings = [];
  const response = envelope?.response;
  if (response?.schema !== RESPONSE_SCHEMA) findings.push(`schema must be ${RESPONSE_SCHEMA}`);
  if (response?.dispatchId !== request?.dispatchId) findings.push('response dispatchId does not match the request');
  if (response?.taskId !== request?.taskId) findings.push('response taskId does not match the request');
  if (response?.requestDigest !== (request ? bundleDigest(request) : null)) findings.push('response requestDigest does not bind the request');
  if (typeof response?.actorId !== 'string' || !response.actorId) findings.push('actorId is required');
  if (expectedActorId && response?.actorId !== expectedActorId) findings.push(`response actorId does not match ${expectedActorId}`);
  if (response?.status === 'SUCCESS' && response?.plane !== request?.plane) findings.push('successful response plane does not match the request');
  if (expectedPlane && response?.plane !== expectedPlane) findings.push(`response plane does not match actor plane ${expectedPlane}`);
  if (!RESPONSE_STATUSES.has(response?.status)) findings.push('response status is invalid');
  if (!isTimestamp(response?.startedAt) || !isTimestamp(response?.completedAt)) findings.push('startedAt and completedAt must be timestamps');
  if (isTimestamp(response?.startedAt) && isTimestamp(response?.completedAt) && Date.parse(response.completedAt) < Date.parse(response.startedAt)) findings.push('completedAt precedes startedAt');
  if (response?.status === 'SUCCESS' && (response.result == null || response.failure != null)) findings.push('SUCCESS requires a result and no failure');
  if (response?.status !== 'SUCCESS' && (typeof response?.failure?.code !== 'string' || !response.failure.code)) findings.push('non-success response requires a bounded failure code');
  for (const [index, artifact] of (response?.artifacts ?? []).entries()) {
    if (typeof artifact?.name !== 'string' || !artifact.name) findings.push(`artifact[${index}] name is required`);
    if (!isDigest(artifact?.sha256)) findings.push(`artifact[${index}] sha256 is invalid`);
    if (!Number.isInteger(artifact?.bytes) || artifact.bytes < 0) findings.push(`artifact[${index}] bytes is invalid`);
  }
  const signature = verifyWitnessAttestation(response, envelope?.attestation, { allowlist: actorKeys });
  if (!signature.ok) findings.push(`actor signature: ${signature.reasons.join('; ')}`);
  return { ok: findings.length === 0, findings, responseDigest: response && typeof response === 'object' ? bundleDigest(response) : null };
}