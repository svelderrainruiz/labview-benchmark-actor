/**
 * Capture markers shared by every marker kind (#134 slice 3): the agent cue (`kind: 'agent-cue'`), added by the
 * `add_capture_marker` MCP tool or automatically from GPU edges, uses the SAME nearest-frame grab as the
 * operator's user-click marker (`resolveMarkerImageGrab`, media/markerImageGrab.mjs, staged from
 * experiments/resource-usage-correlation), so its `imageGrab` { toleranceMs, nearestFrameIndex,
 * nearestCaptureEpochMs, deltaMs, admitted, imageRef } means exactly what a click's does.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { GpuCue } from './gpuSamples';

export const AGENT_CUE_KIND = 'agent-cue';
export const MAX_MARKER_LABEL_LENGTH = 80;
export const DEFAULT_MARKER_TOLERANCE_MS = 200;
const RUN_DIRECTORY = /^run-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface MarkerImageGrab {
  nearestFrameIndex: number | null;
  nearestCaptureEpochMs: number | null;
  deltaMs: number | null;
  admitted: boolean;
  imageRef: string | null;
}
export type MarkerImageGrabFn = (
  epochMs: number,
  frames: ReadonlyArray<{ index: number; captureEpochMs: number; image?: string | null }>,
  toleranceMs?: number
) => MarkerImageGrab;

export interface CaptureRecordLike {
  frames: Array<Record<string, unknown>>;
  markers?: unknown;
  startMs?: unknown;
  [k: string]: unknown;
}

const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<Record<string, unknown>>;

/** Load the shared nearest-frame grab from `<extensionRoot>/media/markerImageGrab.mjs`. */
export async function loadMarkerImageGrab(extensionRoot: string): Promise<MarkerImageGrabFn> {
  const mod = await dynamicImport(pathToFileURL(path.join(extensionRoot, 'media', 'markerImageGrab.mjs')).href);
  if (typeof mod.resolveMarkerImageGrab !== 'function') {
    throw new Error('media/markerImageGrab.mjs does not export resolveMarkerImageGrab');
  }
  return mod.resolveMarkerImageGrab as MarkerImageGrabFn;
}

/** A marker label: non-empty after trimming, at most 80 characters. */
export function validateMarkerLabel(label: unknown): string {
  if (typeof label !== 'string' || label.trim().length === 0) throw new Error('label must be a non-empty string');
  const trimmed = label.trim();
  if (trimmed.length > MAX_MARKER_LABEL_LENGTH) throw new Error(`label must be at most ${MAX_MARKER_LABEL_LENGTH} characters`);
  return trimmed;
}

export interface AgentCueRequest {
  /** Instant on the capture's frame time axis (ms since frame 0, the axis user-click markers use). */
  instantMs?: number;
  /** Or a frame index; the instant is that frame's tMs. */
  frameIndex?: number;
  label: string;
  createdAt?: string;
  toleranceMs?: number;
}

/**
 * Build an agent-cue marker (pure). The grab runs over the capture's frames on the frame time axis
 * (`captureEpochMs` = frame tMs), exactly as the correlator resolves a user click.
 */
export function buildAgentCueMarker(record: CaptureRecordLike, request: AgentCueRequest, grab: MarkerImageGrabFn): Record<string, unknown> {
  const frames = Array.isArray(record.frames) ? record.frames : [];
  if (frames.length === 0) throw new Error('the capture has no frames');
  const label = validateMarkerLabel(request.label);
  const hasInstant = request.instantMs !== undefined;
  const hasFrame = request.frameIndex !== undefined;
  if (hasInstant === hasFrame) throw new Error('give exactly one of instantMs or frameIndex');
  let instantMs: number;
  if (hasFrame) {
    const frameIndex = Number(request.frameIndex);
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frames.length) {
      throw new Error(`frameIndex must be an integer between 0 and ${frames.length - 1}`);
    }
    instantMs = Number(frames[frameIndex].tMs);
  } else {
    instantMs = Number(request.instantMs);
  }
  if (!Number.isFinite(instantMs)) throw new Error('instantMs must be a finite number');
  const toleranceMs = request.toleranceMs ?? DEFAULT_MARKER_TOLERANCE_MS;
  const imageGrab = grab(
    instantMs,
    frames.map((f) => ({ index: Number(f.index), captureEpochMs: Number(f.tMs), image: typeof f.image === 'string' ? f.image : null })),
    toleranceMs
  );
  const seq = (Array.isArray(record.markers) ? record.markers.length : 0) + 1;
  return {
    id: `cue-${Math.round(instantMs)}-${seq}`,
    kind: AGENT_CUE_KIND,
    label,
    instantMs,
    frameIndex: imageGrab.nearestFrameIndex ?? (hasFrame ? Number(request.frameIndex) : null),
    createdAt: request.createdAt ?? new Date().toISOString(),
    imageGrab: { toleranceMs, ...imageGrab }
  };
}

/** Agent-cue markers for automatic GPU cues: each cue's epoch ms is mapped onto the frame axis (ms - startMs). */
export function gpuCueMarkers(record: CaptureRecordLike, cues: readonly GpuCue[], grab: MarkerImageGrabFn, createdAt?: string): Array<Record<string, unknown>> {
  const startMs = typeof record.startMs === 'number' && Number.isFinite(record.startMs) ? record.startMs : 0;
  const markers: Array<Record<string, unknown>> = [];
  for (const cue of cues) {
    const view = { ...record, markers: [...(Array.isArray(record.markers) ? record.markers : []), ...markers] };
    const marker = buildAgentCueMarker(view, { instantMs: cue.ms - startMs, label: cue.label, createdAt }, grab);
    markers.push({
      ...marker,
      source: { kind: 'gpu-edge', edge: cue.edge, gpuIndex: cue.gpuIndex, sampleMs: cue.ms, utilizationLag: cue.utilizationLag }
    });
  }
  return markers;
}

/** Write capture.json atomically in the format the correlator has always used (2-space JSON + newline). */
export function writeCaptureRecord(capturePath: string, record: unknown): void {
  const staging = `${capturePath}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(staging, capturePath);
}

/** Append one marker to `capture.json`'s markers[] (any kind); returns the new marker count. */
export function appendCaptureMarker(capturePath: string, marker: unknown): number {
  const current = JSON.parse(readFileSync(capturePath, 'utf8')) as CaptureRecordLike;
  const markers = Array.isArray(current.markers) ? current.markers : [];
  markers.push(marker);
  current.markers = markers;
  writeCaptureRecord(capturePath, current);
  return markers.length;
}

/**
 * Resolve one capture directory under a captures root: `run-<uuid>` for an explicit run id, or the latest
 * capture (by capture-meta.json/capture.json time) for `latest`/undefined. Only real directories holding a
 * capture.json qualify; symlinks and other names are ignored. Throws a readable error otherwise.
 */
export function resolveCaptureDir(root: string, runId?: string): { dir: string; runId: string } {
  if (!root || !existsSync(root)) throw new Error('no capture root is configured or it does not exist');
  const base = realpathSync(root);
  const candidates = readdirSync(base)
    .map((name) => ({ name, match: RUN_DIRECTORY.exec(name) }))
    .filter(({ name, match }) => {
      if (!match) return false;
      const dir = path.join(base, name);
      return !lstatSync(dir).isSymbolicLink() && lstatSync(dir).isDirectory() && existsSync(path.join(dir, 'capture.json'));
    });
  if (runId !== undefined && runId !== 'latest') {
    const hit = candidates.find(({ match }) => match![1].toLowerCase() === runId.toLowerCase());
    if (!hit) throw new Error(`capture ${runId} not found under the capture root`);
    return { dir: path.join(base, hit.name), runId: hit.match![1] };
  }
  if (candidates.length === 0) throw new Error('no assembled capture (capture.json) under the capture root');
  const timeOf = (name: string): number => {
    const meta = path.join(base, name, 'capture-meta.json');
    return statSync(existsSync(meta) ? meta : path.join(base, name, 'capture.json')).mtimeMs;
  };
  const latest = candidates.sort((a, b) => timeOf(b.name) - timeOf(a.name) || b.name.localeCompare(a.name))[0];
  return { dir: path.join(base, latest.name), runId: latest.match![1] };
}

/** The capture id of a capture directory: the uuid of `run-<uuid>`, else the directory name. */
export function captureIdOf(dir: string): string {
  const name = path.basename(path.resolve(dir));
  return RUN_DIRECTORY.exec(name)?.[1] ?? name;
}
