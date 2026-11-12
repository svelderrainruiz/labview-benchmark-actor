import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

export const ACTIVE_CAPTURE_SESSION_SCHEMA = 'labview-benchmark-actor/active-capture-session@1';
export const ACTIVE_CAPTURE_STATES = ['capturing', 'finalizing', 'stopped', 'failed'] as const;

export type ActiveCaptureState = (typeof ACTIVE_CAPTURE_STATES)[number];
export type ActiveCapturePlane = 'WIN' | 'LINUX';

export interface ActiveCaptureSession {
  schema: typeof ACTIVE_CAPTURE_SESSION_SCHEMA;
  runId: string;
  workload: 'labview-launch';
  state: ActiveCaptureState;
  plane: ActiveCapturePlane;
  source: string;
  startedAt: string;
  stoppedAt: string | null;
  availableEvidence: ['frames', 'resource-samples'];
  updatedAt: string;
}

export function newCaptureRunId(): string {
  return randomUUID();
}

export function buildActiveCaptureSession(options: {
  runId: string;
  state: ActiveCaptureState;
  plane: ActiveCapturePlane;
  source: string;
  startedAt: string;
  stoppedAt?: string;
  updatedAt?: string;
}): ActiveCaptureSession {
  return {
    schema: ACTIVE_CAPTURE_SESSION_SCHEMA,
    runId: options.runId,
    workload: 'labview-launch',
    state: options.state,
    plane: options.plane,
    source: options.source,
    startedAt: options.startedAt,
    stoppedAt: options.stoppedAt ?? null,
    availableEvidence: ['frames', 'resource-samples'],
    updatedAt: options.updatedAt ?? new Date().toISOString()
  };
}

export function validateActiveCaptureSession(value: unknown, expectedRunId?: string): ActiveCaptureSession | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== ACTIVE_CAPTURE_SESSION_SCHEMA) return null;
  if (typeof record.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.runId)) return null;
  if (expectedRunId && record.runId !== expectedRunId) return null;
  if (record.workload !== 'labview-launch') return null;
  if (!ACTIVE_CAPTURE_STATES.includes(record.state as ActiveCaptureState)) return null;
  if (record.plane !== 'WIN' && record.plane !== 'LINUX') return null;
  if (typeof record.source !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(record.source)) return null;
  if (typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) return null;
  if (record.stoppedAt !== null && (typeof record.stoppedAt !== 'string' || !Number.isFinite(Date.parse(record.stoppedAt)))) return null;
  if ((record.state === 'stopped' || record.state === 'failed') !== (record.stoppedAt !== null)) return null;
  if (!Array.isArray(record.availableEvidence) || record.availableEvidence.length !== 2 ||
      record.availableEvidence[0] !== 'frames' || record.availableEvidence[1] !== 'resource-samples') return null;
  if (typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) return null;
  return {
    schema: ACTIVE_CAPTURE_SESSION_SCHEMA,
    runId: record.runId,
    workload: 'labview-launch',
    state: record.state as ActiveCaptureState,
    plane: record.plane,
    source: record.source,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt as string | null,
    availableEvidence: ['frames', 'resource-samples'],
    updatedAt: record.updatedAt
  };
}

export function writeActiveCaptureSession(directory: string, session: ActiveCaptureSession): void {
  const target = path.join(directory, 'active-capture-session.json');
  const temporary = path.join(directory, `.active-capture-session-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(session)}\n`, { flag: 'wx' });
  renameSync(temporary, target);
}