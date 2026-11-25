#!/usr/bin/env node
/**
 * Clip between two markers (#134 slice 1): encode the frames of ONE capture between two markers (or two frame
 * indices) into an MP4 (H.264, yuv420p, even dimensions) inside that capture's own directory
 * (`clips/clip-<from>-<to>.mp4`) plus a receipt JSON next to it. Frames are held for their real recorded
 * interval, so playback time equals capture time even for a slow desktop capture (one frame every N s).
 *
 * The clip never leaves the machine that holds the capture: callers (the CLI, the `export_capture_clip` MCP
 * tool, the "Export Clip Between Markers" command) only receive the receipt -- metadata and a SHA-256, never
 * pixels. ffmpeg runs through execFile with an argument array, never a shell string.
 *
 * CLI: node out/captureClip.js --dir <captureDir> [--from-marker <i|id> --to-marker <i|id> |
 *      --from-frame <n> --to-frame <n>] [--crop x,y,w,h | --monitor <n>] [--ffmpeg <path>]
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { captureIdOf, DEFAULT_MARKER_TOLERANCE_MS } from './captureMarkers';

export const CLIP_RECEIPT_SCHEMA = 'labview-benchmark-actor/capture-clip@v1';
export const MISSING_FFMPEG_MESSAGE =
  'ffmpeg was not found. Set the "labviewBenchmarkActor.ffmpegPath" setting (or LBA_FFMPEG_PATH / --ffmpeg for the CLI and MCP server) to an ffmpeg executable.';

export type MarkerRef = number | string;
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ClipOptions {
  fromMarker?: MarkerRef;
  toMarker?: MarkerRef;
  fromFrame?: number;
  toFrame?: number;
  monitor?: number;
  crop?: CropRect;
}

/** A rejected clip request (bad selection, crop, capture or missing ffmpeg); the message is for the caller. */
export class ClipError extends Error {}

interface Frame {
  index?: unknown;
  tMs?: unknown;
  image?: unknown;
}
interface Marker {
  id?: unknown;
  kind?: unknown;
  label?: unknown;
  instantMs?: unknown;
  frameIndex?: unknown;
  captureId?: unknown;
  runId?: unknown;
  imageGrab?: { toleranceMs?: unknown; nearestFrameIndex?: unknown; deltaMs?: unknown; admitted?: unknown } | null;
}
export interface ClipCapture {
  fps?: unknown;
  frames?: unknown;
  markers?: unknown;
  screen?: unknown;
}

export interface ClipMarkerReceipt {
  role: 'start' | 'end';
  markerIndex: number;
  id: string | null;
  kind: string | null;
  label?: string;
  instantMs: number | null;
  frameIndex: number;
  frameSource: 'imageGrab.nearestFrameIndex' | 'frameIndex';
  imageGrab: { toleranceMs: number; nearestFrameIndex: number | null; deltaMs: number | null; admitted: boolean };
}
export interface ClipPlan {
  captureId: string;
  selection: 'latest-markers' | 'markers' | 'frames';
  markers: ClipMarkerReceipt[] | null;
  from: number;
  to: number;
  images: string[];
  durationsMs: number[];
  crop: { mode: 'full' | 'rect' | 'monitor'; monitor?: number; x: number; y: number; width: number; height: number; frameWidth: number; frameHeight: number };
  captureFps: number;
  outputFps: number;
  frameHoldMs: number;
  realDurationMs: number;
}

/** Width/height from a PNG's IHDR chunk. */
export function readPngSize(file: string): { width: number; height: number } {
  const header = Buffer.alloc(24);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, header, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  if (header.readUInt32BE(0) !== 0x89504e47 || header.toString('latin1', 12, 16) !== 'IHDR') {
    throw new ClipError(`${path.basename(file)} is not a PNG frame`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function markerReceipt(marker: Marker, markerIndex: number, role: 'start' | 'end'): ClipMarkerReceipt {
  const grab = marker.imageGrab && typeof marker.imageGrab === 'object' ? marker.imageGrab : {};
  const admitted = grab.admitted === true;
  let frameIndex: number;
  let frameSource: ClipMarkerReceipt['frameSource'];
  if (admitted && isIndex(grab.nearestFrameIndex)) {
    frameIndex = grab.nearestFrameIndex;
    frameSource = 'imageGrab.nearestFrameIndex';
  } else if (isIndex(marker.frameIndex)) {
    frameIndex = marker.frameIndex;
    frameSource = 'frameIndex';
  } else {
    throw new ClipError(`marker ${markerIndex} has no frame index`);
  }
  return {
    role,
    markerIndex,
    id: typeof marker.id === 'string' ? marker.id : null,
    kind: typeof marker.kind === 'string' ? marker.kind : null,
    ...(typeof marker.label === 'string' ? { label: marker.label } : {}),
    instantMs: finiteOrNull(marker.instantMs),
    frameIndex,
    frameSource,
    imageGrab: {
      // A correlator click marker stores no toleranceMs; it was resolved with the correlator default (200 ms).
      toleranceMs: finiteOrNull(grab.toleranceMs) ?? DEFAULT_MARKER_TOLERANCE_MS,
      nearestFrameIndex: isIndex(grab.nearestFrameIndex) ? grab.nearestFrameIndex : null,
      deltaMs: finiteOrNull(grab.deltaMs),
      admitted
    }
  };
}

function pickMarker(markers: Marker[], ref: MarkerRef, captureId: string): { marker: Marker; index: number } {
  const index = typeof ref === 'number' ? ref : markers.findIndex((m) => m && m.id === ref);
  if (!Number.isInteger(index) || index < 0 || index >= markers.length) {
    throw new ClipError(`marker ${JSON.stringify(ref)} is not in capture ${captureId} (it has ${markers.length} markers)`);
  }
  const marker = markers[index];
  const owner = marker.captureId ?? marker.runId;
  if (owner !== undefined && owner !== captureId) {
    throw new ClipError(`marker ${JSON.stringify(ref)} belongs to capture ${String(owner)}, not ${captureId}`);
  }
  return { marker, index };
}

function cropOf(record: ClipCapture, options: ClipOptions, frame: { width: number; height: number }, captureId: string): ClipPlan['crop'] {
  const base = { frameWidth: frame.width, frameHeight: frame.height };
  let mode: ClipPlan['crop']['mode'] = 'full';
  let rect: CropRect = { x: 0, y: 0, w: frame.width, h: frame.height };
  if (options.monitor !== undefined) {
    const monitors = (record.screen as { monitors?: unknown } | null | undefined)?.monitors;
    const monitor = Array.isArray(monitors) ? (monitors[options.monitor] as Record<string, unknown> | undefined) : undefined;
    if (!monitor) {
      throw new ClipError(`capture ${captureId} records no monitor ${options.monitor} in its screen layout; pass a crop rectangle x,y,w,h instead`);
    }
    mode = 'monitor';
    rect = { x: Number(monitor.x), y: Number(monitor.y), w: Number(monitor.width), h: Number(monitor.height) };
  } else if (options.crop) {
    mode = 'rect';
    rect = options.crop;
  }
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every((v) => Number.isInteger(v)) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > frame.width || y + h > frame.height) {
    throw new ClipError(`crop ${x},${y},${w},${h} is outside the ${frame.width}x${frame.height} frame`);
  }
  // H.264 yuv420p needs even dimensions: trim one pixel column/row when odd.
  const width = w - (w % 2);
  const height = h - (h % 2);
  if (width < 2 || height < 2) throw new ClipError(`crop ${w}x${h} is too small for an H.264 clip (needs at least 2x2)`);
  return { mode, ...(mode === 'monitor' ? { monitor: options.monitor } : {}), x, y, width, height, ...base };
}

/** Validate a clip request against one capture and plan it (frame range, crop, real-time durations). */
export function planClip(record: ClipCapture, dir: string, options: ClipOptions = {}, readSize = readPngSize): ClipPlan {
  const captureId = captureIdOf(dir);
  const frames = (Array.isArray(record.frames) ? record.frames : []) as Frame[];
  if (frames.length === 0) throw new ClipError(`capture ${captureId} has no frames; a clip needs at least 1 frame`);
  const markers = (Array.isArray(record.markers) ? record.markers : []) as Marker[];
  const byMarker = options.fromMarker !== undefined || options.toMarker !== undefined;
  const byFrame = options.fromFrame !== undefined || options.toFrame !== undefined;
  if (byMarker && byFrame) throw new ClipError('select the clip by markers or by frames, not both');
  if (options.monitor !== undefined && options.crop) throw new ClipError('give a monitor or a crop rectangle, not both');

  let selection: ClipPlan['selection'];
  let markerReceipts: ClipMarkerReceipt[] | null = null;
  let from: number;
  let to: number;
  if (byFrame) {
    if (options.fromFrame === undefined || options.toFrame === undefined) throw new ClipError('give both a start and an end frame');
    selection = 'frames';
    from = options.fromFrame;
    to = options.toFrame;
  } else {
    let start: { marker: Marker; index: number };
    let end: { marker: Marker; index: number };
    if (byMarker) {
      if (options.fromMarker === undefined || options.toMarker === undefined) throw new ClipError('give both a start and an end marker');
      selection = 'markers';
      start = pickMarker(markers, options.fromMarker, captureId);
      end = pickMarker(markers, options.toMarker, captureId);
    } else {
      if (markers.length < 2) {
        throw new ClipError(`capture ${captureId} has ${markers.length} marker(s); add two markers or select frames`);
      }
      selection = 'latest-markers';
      start = pickMarker(markers, markers.length - 2, captureId);
      end = pickMarker(markers, markers.length - 1, captureId);
    }
    let startReceipt = markerReceipt(start.marker, start.index, 'start');
    let endReceipt = markerReceipt(end.marker, end.index, 'end');
    if (selection === 'latest-markers' && endReceipt.frameIndex < startReceipt.frameIndex) {
      [startReceipt, endReceipt] = [{ ...endReceipt, role: 'start' }, { ...startReceipt, role: 'end' }];
    }
    markerReceipts = [startReceipt, endReceipt];
    from = startReceipt.frameIndex;
    to = endReceipt.frameIndex;
  }
  for (const [name, value] of [['start', from], ['end', to]] as const) {
    if (!isIndex(value) || value >= frames.length) {
      throw new ClipError(`${name} frame ${String(value)} is not a frame of capture ${captureId} (0..${frames.length - 1})`);
    }
  }
  if (to < from) throw new ClipError(`the end (frame ${to}) is before the start (frame ${from})`);

  const images = frames.slice(from, to + 1).map((frame, i) => {
    const image = typeof frame.image === 'string' ? frame.image : '';
    if (!image || path.basename(image) !== image || !existsSync(path.join(dir, image))) {
      throw new ClipError(`frame ${from + i} image is missing from capture ${captureId}`);
    }
    return image;
  });
  const captureFps = typeof record.fps === 'number' && Number.isFinite(record.fps) && record.fps > 0 ? record.fps : 12;
  const frameHoldMs = 1000 / captureFps;
  const durationsMs = images.map((_, i) => {
    if (i === images.length - 1) return frameHoldMs;
    const gap = Number(frames[from + i + 1].tMs) - Number(frames[from + i].tMs);
    return Number.isFinite(gap) ? Math.max(0, gap) : frameHoldMs;
  });
  const realDurationMs = durationsMs.reduce((sum, d) => sum + d, 0);
  const crop = cropOf(record, options, readSize(path.join(dir, images[0])), captureId);
  return {
    captureId,
    selection,
    markers: markerReceipts,
    from,
    to,
    images,
    durationsMs,
    crop,
    captureFps,
    outputFps: captureFps >= 1 ? captureFps : 1,
    frameHoldMs,
    realDurationMs
  };
}

/** The ffconcat list (relative to `<capture>/clips/`): each frame held for its real interval, last file repeated. */
export function concatList(plan: Pick<ClipPlan, 'images' | 'durationsMs'>): string {
  const quote = (image: string): string => `'../${image.replace(/'/g, "'\\''")}'`;
  const lines = ['ffconcat version 1.0'];
  plan.images.forEach((image, i) => {
    lines.push(`file ${quote(image)}`, `duration ${(plan.durationsMs[i] / 1000).toFixed(6)}`);
  });
  // The concat demuxer drops the last duration unless the last file is listed again.
  lines.push(`file ${quote(plan.images[plan.images.length - 1])}`);
  return `${lines.join('\n')}\n`;
}

/** ffmpeg argv (never a shell string). `-t` caps the repeated last file's overshoot at the real duration. */
export function clipFfmpegArgs(plan: ClipPlan, listFile: string, outFile: string): string[] {
  const { crop } = plan;
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},fps=${plan.outputFps}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-t', (plan.realDurationMs / 1000).toFixed(3),
    outFile
  ];
}

export type ClipRunner = (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export const execFileRunner: ClipRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The ffmpeg to use outside VS Code: an explicit path, then LBA_FFMPEG_PATH, then `ffmpeg` on PATH. */
export function clipFfmpegCommand(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit?.trim() || String(env.LBA_FFMPEG_PATH ?? '').trim() || 'ffmpeg';
}

export interface ExportClipDeps {
  ffmpeg: string | null;
  run?: ClipRunner;
  now?: () => Date;
}

/** Plan, encode and hash a clip; writes `clips/clip-<from>-<to>.mp4` + `.json` in `dir` and returns the receipt. */
export async function exportCaptureClip(dir: string, options: ClipOptions, deps: ExportClipDeps): Promise<Record<string, unknown>> {
  const capturePath = path.join(dir, 'capture.json');
  if (!existsSync(capturePath)) throw new ClipError(`${dir} holds no capture.json`);
  const record = JSON.parse(readFileSync(capturePath, 'utf8')) as ClipCapture;
  const plan = planClip(record, dir, options);
  const run = deps.run ?? execFileRunner;
  if (!deps.ffmpeg) throw new ClipError(MISSING_FFMPEG_MESSAGE);
  try {
    await run(deps.ffmpeg, ['-hide_banner', '-version']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ClipError(MISSING_FFMPEG_MESSAGE);
    throw new ClipError(`ffmpeg (${deps.ffmpeg}) is not runnable: ${(error as Error).message}`);
  }
  const clipsDir = path.join(dir, 'clips');
  mkdirSync(clipsDir, { recursive: true });
  const stem = `clip-${plan.from}-${plan.to}`;
  const listFile = path.join(clipsDir, `${stem}.ffconcat`);
  const outFile = path.join(clipsDir, `${stem}.mp4`);
  writeFileSync(listFile, concatList(plan));
  try {
    await run(deps.ffmpeg, clipFfmpegArgs(plan, listFile, outFile));
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    throw new ClipError(`ffmpeg failed to encode the clip: ${stderr.split('\n').pop() || (error as Error).message}`);
  } finally {
    rmSync(listFile, { force: true });
  }
  const bytes = readFileSync(outFile);
  const receipt = {
    schema: CLIP_RECEIPT_SCHEMA,
    captureId: plan.captureId,
    selection: plan.selection,
    markers: plan.markers,
    frameRange: { from: plan.from, to: plan.to, count: plan.to - plan.from + 1 },
    crop: plan.crop,
    timing: {
      captureFps: plan.captureFps,
      outputFps: plan.outputFps,
      mode: 'real-interval',
      frameHoldMs: plan.frameHoldMs,
      realDurationMs: plan.realDurationMs
    },
    clip: {
      file: `clips/${stem}.mp4`,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: statSync(outFile).size,
      durationMs: Math.round(plan.realDurationMs)
    },
    createdAt: (deps.now ?? (() => new Date()))().toISOString()
  };
  writeFileSync(path.join(clipsDir, `${stem}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function intArg(flag: string, value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new ClipError(`${flag} needs a non-negative integer`);
  return Number(value);
}

/** Parse the clip CLI flags (also used by the VS Code command's option box). */
export function parseClipArgs(argv: readonly string[]): { dir?: string; ffmpeg?: string; options: ClipOptions } {
  const parsed: { dir?: string; ffmpeg?: string; options: ClipOptions } = { options: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--dir':
      case '--ffmpeg':
        if (!value) throw new ClipError(`${flag} needs a value`);
        parsed[flag === '--dir' ? 'dir' : 'ffmpeg'] = value;
        break;
      case '--from-marker':
      case '--to-marker':
        if (!value) throw new ClipError(`${flag} needs a marker index or id`);
        parsed.options[flag === '--from-marker' ? 'fromMarker' : 'toMarker'] = /^\d+$/.test(value) ? Number(value) : value;
        break;
      case '--from-frame':
      case '--to-frame':
      case '--monitor':
        parsed.options[flag === '--from-frame' ? 'fromFrame' : flag === '--to-frame' ? 'toFrame' : 'monitor'] = intArg(flag, value);
        break;
      case '--crop': {
        const parts = String(value ?? '').split(',');
        if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p.trim()))) throw new ClipError('--crop needs x,y,w,h (non-negative integers)');
        const [x, y, w, h] = parts.map(Number);
        parsed.options.crop = { x, y, w, h };
        break;
      }
      default:
        throw new ClipError(`unknown option: ${flag}`);
    }
    i += 1;
  }
  return parsed;
}

export const CLIP_USAGE =
  'usage: node out/captureClip.js --dir <captureDir> [--from-marker <i|id> --to-marker <i|id> | --from-frame <n> --to-frame <n>] [--crop x,y,w,h | --monitor <n>] [--ffmpeg <path>]';

/** CLI entry: prints the receipt JSON (metadata + SHA-256 only); returns the exit code. */
export async function runClipCli(argv: readonly string[], io: { out(text: string): void; err(text: string): void }, deps: Partial<ExportClipDeps> = {}): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      io.out(CLIP_USAGE);
      return 0;
    }
    const { dir, ffmpeg, options } = parseClipArgs(argv);
    if (!dir) throw new ClipError('--dir <captureDir> is required');
    const receipt = await exportCaptureClip(path.resolve(dir), options, { ffmpeg: clipFfmpegCommand(ffmpeg), ...deps });
    io.out(JSON.stringify(receipt, null, 2));
    return 0;
  } catch (error) {
    io.err(`export-clip: ${(error as Error).message}`);
    return error instanceof ClipError ? 2 : 1;
  }
}

if (require.main === module) {
  void runClipCli(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t) }).then((code) => {
    process.exitCode = code;
  });
}
