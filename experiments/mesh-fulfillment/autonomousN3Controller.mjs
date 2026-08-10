#!/usr/bin/env node

import { bundleDigest } from '../acg-provenance/attest.mjs';
import { randomUUID } from 'node:crypto';
import { buildActorRequest, validateActorRequest, validateActorResponse, WORKLOAD_ID } from './autonomousActorProtocol.mjs';

export const DECISION_SCHEMA = 'labview-benchmark-actor/autonomous-n3-decision@1';

const candidateOk = (candidate) => /^[0-9a-f]{40}$/.test(candidate?.sourceCommit)
  && /^[0-9a-f]{40}$/.test(candidate?.sourceTree)
  && /^[0-9a-f]{64}$/.test(candidate?.bundleSha256);
const candidatesMatch = (left, right) => candidateOk(left) && candidateOk(right) && bundleDigest(left) === bundleDigest(right);

export function buildAutonomousN3Dispatch({
  dispatchId,
  requesterId,
  privateKeyPem,
  candidate,
  actors,
  issuedAt = new Date().toISOString(),
  expiresAt = new Date(Date.parse(issuedAt) + 15 * 60 * 1000).toISOString(),
  nonce = () => randomUUID().replaceAll('-', ''),
} = {}) {
  if (!Array.isArray(actors) || actors.length < 3) throw new Error('at least three actors are required');
  const ids = new Set(actors.map((actor) => actor.id));
  if (ids.size !== actors.length || actors.some((actor) => !actor.id || !['LINUX', 'WIN'].includes(actor.plane))) {
    throw new Error('actors require unique ids and a LINUX or WIN plane');
  }
  const planes = new Set(actors.map((actor) => actor.plane));
  if (!planes.has('LINUX') || !planes.has('WIN')) throw new Error('actors must span LINUX and WIN');

  return {
    dispatchId,
    candidate,
    actors: actors.map((actor) => ({ id: actor.id, plane: actor.plane })),
    requests: actors.map((actor) => buildActorRequest({
      dispatchId,
      taskId: `${dispatchId}::${actor.id}`,
      plane: actor.plane,
      requesterId,
      nonce: nonce(actor),
      issuedAt,
      expiresAt,
      candidate,
      workload: { id: WORKLOAD_ID, parameters: {} },
      privateKeyPem,
    })),
  };
}

export function decideAutonomousN3({ dispatch, responses, requesterKeys = {}, actorKeys = {}, sealedCandidate } = {}) {
  const findings = [];
  const actors = Array.isArray(dispatch?.actors) ? dispatch.actors : [];
  const requests = Array.isArray(dispatch?.requests) ? dispatch.requests : [];
  const envelopes = Array.isArray(responses) ? responses : [];
  const candidateMatchesSealedDescriptor = candidatesMatch(dispatch?.candidate, sealedCandidate);
  if (!candidateMatchesSealedDescriptor) findings.push('candidate does not match the sealed descriptor');
  if (actors.length < 3 || new Set(actors.map((actor) => actor.id)).size !== actors.length) findings.push('dispatch requires at least three distinct actors');
  if (!actors.some((actor) => actor.plane === 'LINUX') || !actors.some((actor) => actor.plane === 'WIN')) findings.push('dispatch must span LINUX and WIN');
  if (requests.length !== actors.length) findings.push('dispatch must contain one request per actor');

  const outcomes = actors.map((actor) => {
    const requestEnvelope = requests.find((entry) => entry?.request?.taskId === `${dispatch?.dispatchId}::${actor.id}`);
    const matching = envelopes.filter((entry) => entry?.response?.taskId === requestEnvelope?.request?.taskId);
    const actorFindings = [];
    if (!requestEnvelope) actorFindings.push('actor request is missing');
    if (requestEnvelope) {
      const requestValidation = validateActorRequest(requestEnvelope, {
        requesterKeys,
        expectedPlane: actor.plane,
        now: new Date(requestEnvelope.request.issuedAt),
      });
      actorFindings.push(...requestValidation.findings);
      if (!candidatesMatch(requestEnvelope.request.candidate, dispatch.candidate)) actorFindings.push('request candidate does not match the dispatch candidate');
    }
    if (matching.length !== 1) actorFindings.push(`expected one response, received ${matching.length}`);
    const envelope = matching[0];
    const validation = requestEnvelope && envelope
      ? validateActorResponse(envelope, { request: requestEnvelope.request, actorKeys, expectedActorId: actor.id, expectedPlane: actor.plane })
      : { ok: false, findings: [], responseDigest: null };
    actorFindings.push(...validation.findings);
    if (envelope?.response?.status !== 'SUCCESS') actorFindings.push('actor did not return SUCCESS');
    if (envelope?.response?.status === 'SUCCESS') {
      const result = envelope.response.result;
      if (result?.observed !== 3 || result?.expected !== 3 || result?.verdict !== 'PASS') actorFindings.push('actor result does not prove the known answer');
    }
    return {
      id: actor.id,
      plane: actor.plane,
      ok: actorFindings.length === 0,
      status: envelope?.response?.status ?? null,
      result: envelope?.response?.result ?? null,
      findings: actorFindings,
      responseDigest: validation.responseDigest,
    };
  });

  const knownTasks = new Set(requests.map((entry) => entry?.request?.taskId));
  if (envelopes.some((entry) => !knownTasks.has(entry?.response?.taskId))) findings.push('received a response for an unknown task');
  if (outcomes.some((outcome) => !outcome.ok)) findings.push('one or more actor outcomes failed validation');
  return {
    schema: DECISION_SCHEMA,
    dispatchId: dispatch?.dispatchId ?? null,
    candidate: dispatch?.candidate ?? null,
    candidateMatchesSealedDescriptor,
    consume: findings.length === 0,
    findings,
    actors: outcomes,
  };
}