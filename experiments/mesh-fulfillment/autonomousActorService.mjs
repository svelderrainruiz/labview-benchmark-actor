#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { bundleDigest } from '../acg-provenance/attest.mjs';
import {
  WORKLOAD_ID,
  buildActorResponse,
  validateActorRequest,
} from './autonomousActorProtocol.mjs';

export const SERVICE_STATE_SCHEMA = 'labview-benchmark-actor/autonomous-actor-state@1';
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

const execFileAsync = promisify(execFileCallback);
const sameCandidate = (left, right) =>
  left?.sourceCommit === right?.sourceCommit
  && left?.sourceTree === right?.sourceTree
  && left?.bundleSha256 === right?.bundleSha256;

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function initialState(actorId, plane) {
  return {
    schema: SERVICE_STATE_SCHEMA,
    actorId,
    plane,
    seenNonces: [],
    outcomes: {},
    active: null,
  };
}

function loadState(path, actorId, plane) {
  if (!existsSync(path)) return initialState(actorId, plane);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state?.schema !== SERVICE_STATE_SCHEMA) throw new Error(`actor state schema must be ${SERVICE_STATE_SCHEMA}`);
  if (state.actorId !== actorId || state.plane !== plane) throw new Error('actor state identity does not match the configured actor');
  if (!Array.isArray(state.seenNonces) || state.outcomes == null || typeof state.outcomes !== 'object') throw new Error('actor state is malformed');
  return state;
}

function boundedResult(result) {
  const bytes = Buffer.byteLength(JSON.stringify(result ?? null), 'utf8');
  if (bytes > MAX_RESULT_BYTES) throw Object.assign(new Error('workload result exceeds the bounded response size'), { code: 'RESULT_TOO_LARGE' });
  return result;
}

function storeArtifacts(artifactDir, artifacts = []) {
  mkdirSync(artifactDir, { recursive: true });
  return artifacts.map((artifact) => {
    if (typeof artifact?.name !== 'string' || !artifact.name || artifact.name !== artifact.name.split(/[\\/]/).pop()) {
      throw Object.assign(new Error('artifact name must be a basename'), { code: 'INVALID_ARTIFACT' });
    }
    const content = Buffer.isBuffer(artifact.content) ? artifact.content : Buffer.from(String(artifact.content ?? ''), 'utf8');
    if (content.length > MAX_ARTIFACT_BYTES) throw Object.assign(new Error('artifact exceeds the local CAS size limit'), { code: 'ARTIFACT_TOO_LARGE' });
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = join(artifactDir, sha256);
    if (!existsSync(path)) writeFileSync(path, content, { mode: 0o600 });
    return { name: artifact.name, sha256, bytes: content.length };
  });
}

function failureCode(error) {
  const code = String(error?.code ?? 'WORKLOAD_FAILED');
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'WORKLOAD_FAILED';
}

export function createCommandWorkloadAdapter({ executable, args = [], cwd, timeoutMs = 180_000 } = {}, { execFile = execFileAsync } = {}) {
  if (typeof executable !== 'string' || !executable) throw new Error('workload adapter executable is required');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('workload adapter args must be fixed strings');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60 * 1000) throw new Error('workload adapter timeoutMs must be 1..900000');
  return async () => {
    const { stdout, stderr } = await execFile(executable, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_ARTIFACT_BYTES,
      windowsHide: true,
      shell: false,
    });
    let result;
    try { result = JSON.parse(String(stdout).trim()); }
    catch { throw Object.assign(new Error('workload helper stdout must be one JSON result'), { code: 'INVALID_WORKLOAD_RESULT' }); }
    const artifacts = [{ name: 'workload-stdout.json', content: String(stdout) }];
    if (stderr) artifacts.push({ name: 'workload-stderr.txt', content: String(stderr) });
    return { result, artifacts };
  };
}

export function createAutonomousActorService({
  actorId,
  plane,
  privateKeyPem,
  requesterKeys,
  expectedCandidate,
  statePath,
  artifactDir,
  workloads,
  now = () => new Date(),
} = {}) {
  if (typeof actorId !== 'string' || !actorId) throw new Error('actorId is required');
  if (!['LINUX', 'WIN'].includes(plane)) throw new Error('plane must be LINUX or WIN');
  if (typeof privateKeyPem !== 'string' || !privateKeyPem) throw new Error('actor private key is required');
  if (!statePath || !artifactDir) throw new Error('statePath and artifactDir are required');
  if (!expectedCandidate?.sourceCommit || !expectedCandidate?.sourceTree || !expectedCandidate?.bundleSha256) throw new Error('expectedCandidate is required');
  if (workloads == null || typeof workloads !== 'object') throw new Error('workloads registry is required');

  const state = loadState(statePath, actorId, plane);
  const persist = () => atomicJson(statePath, state);
  const sign = ({ request, status, startedAt, result = null, artifacts = [], code = null }) => buildActorResponse({
    request,
    actorId,
    plane,
    status,
    startedAt,
    completedAt: now().toISOString(),
    result,
    artifacts,
    failure: code ? { code } : null,
    privateKeyPem,
  });
  const remember = (replayKey, requestDigest, envelope) => {
    if (!state.seenNonces.includes(replayKey)) state.seenNonces.push(replayKey);
    state.outcomes[replayKey] = { requestDigest, envelope };
    if (state.active?.replayKey === replayKey) state.active = null;
    persist();
    return envelope;
  };

  async function handleRequest(envelope) {
    const request = envelope?.request;
    const requestDigest = request && typeof request === 'object' ? bundleDigest(request) : null;
    const replayKey = `${request?.requesterId ?? ''}:${request?.nonce ?? ''}`;
    const previous = state.outcomes[replayKey];
    if (previous?.requestDigest === requestDigest) return previous.envelope;

    const startedAt = now().toISOString();
    const validation = validateActorRequest(envelope, {
      requesterKeys,
      allowedWorkloads: Object.keys(workloads),
      now: now(),
      seenNonces: new Set(state.seenNonces),
      expectedPlane: plane,
    });
    if (!validation.ok) return sign({ request, status: 'REJECTED', startedAt, code: 'INVALID_REQUEST' });
    if (!sameCandidate(request.candidate, expectedCandidate)) {
      return remember(replayKey, requestDigest, sign({ request, status: 'REJECTED', startedAt, code: 'CANDIDATE_MISMATCH' }));
    }
    if (state.active) {
      return remember(replayKey, requestDigest, sign({ request, status: 'BUSY', startedAt, code: 'ACTOR_BUSY' }));
    }

    state.active = { replayKey, requestDigest, request };
    state.seenNonces.push(replayKey);
    persist();
    try {
      const output = await workloads[request.workload.id]({ request, artifactDir });
      const result = boundedResult(output?.result);
      const artifacts = storeArtifacts(artifactDir, output?.artifacts);
      return remember(replayKey, requestDigest, sign({ request, status: 'SUCCESS', startedAt, result, artifacts }));
    } catch (error) {
      return remember(replayKey, requestDigest, sign({ request, status: 'FAILED', startedAt, code: failureCode(error) }));
    }
  }

  function recoverInterrupted() {
    if (!state.active) return null;
    const { replayKey, requestDigest, request } = state.active;
    const timestamp = now().toISOString();
    return remember(replayKey, requestDigest, sign({ request, status: 'FAILED', startedAt: timestamp, code: 'ACTOR_INTERRUPTED' }));
  }

  function inspect() {
    return {
      actorId,
      plane,
      active: state.active?.requestDigest ?? null,
      seenNonces: state.seenNonces.length,
      outcomes: Object.keys(state.outcomes).length,
      allowedWorkloads: Object.keys(workloads),
      workloadId: WORKLOAD_ID,
    };
  }

  return { handleRequest, recoverInterrupted, inspect };
}