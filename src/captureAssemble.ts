/**
 * Capture assembly shared by the extension and the vscode-free local-model loop CLI (#134 slice 4): the PNG
 * frames + CPU/RAM/disk samples + GPU series of one capture directory become capture.json (launch-capture@1,
 * built by media/launch-capture.mjs), with the automatic GPU agent cues on the shared marker grab.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { CAPTURE_SOURCES, CaptureMetadata, captureFpsOf, captureMetadataForPlatform, CaptureWorkload } from './capturePlatform';
import { gpuCueMarkers, MarkerImageGrabFn } from './captureMarkers';
import { attachGpuSeries, gpuCues, GpuCueOptions, readGpuSeries } from './gpuSamples';

export interface CaptureBuilder {
  buildLaunchCapture(input: unknown): LaunchCaptureRecord;
}
export interface LaunchCaptureRecord {
  frameCount: number;
  frames: Array<Record<string, unknown>>;
  workload?: CaptureWorkload;
  fps?: number;
  [k: string]: unknown;
}

function normalizeResourceSample(sample: Record<string, unknown>): Record<string, unknown> {
  const ms = Number(sample.ms);
  if (Number.isFinite(ms) && ms >= 1e15) return { ...sample, ms: Math.round(ms / 1e6) };
  return sample;
}

/** Parse a capture's resources.jsonl into the raw sample array (skipping blank/partial lines). */
export function readResourceSamples(dir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const resFile = path.join(dir, 'resources.jsonl');
  if (!existsSync(resFile)) return out;
  for (const line of readFileSync(resFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(normalizeResourceSample(JSON.parse(t) as Record<string, unknown>)); } catch { /* skip partial */ }
  }
  return out;
}

/** Optional #134 assembly extras: the shared marker grab (for automatic GPU agent cues) + the cue thresholds. */
export interface AssembleCaptureExtras {
  grab?: MarkerImageGrabFn;
  gpuCue?: GpuCueOptions;
}

// Assemble the captured PNG frames + resource samples in `dir` into a launch-capture@1 record (mprr dual-packet)
// and write capture.json. Split out from the cleanroom-gated ffmpeg CAPTURE that PRODUCES the frames, so this
// pure file-assembly around the unit-tested builder is itself directly unit-testable with fixture frames.
export function assembleCaptureFromDir(dir: string, builder: CaptureBuilder, extras: AssembleCaptureExtras = {}): LaunchCaptureRecord {
  const frameFiles = readdirSync(dir)
    .filter((f) => /^frame-\d+\.png$/.test(f))
    .sort();
  if (frameFiles.length === 0) {
    throw new Error('no frames were captured (is ffmpeg installed + did the capture run long enough?)');
  }
  // Align each frame to REAL wall-clock via its PNG mtime (when ffmpeg wrote it), NOT startMs + i/fps -- that
  // removes ffmpeg's startup lag so every frame takes its true nearest CPU/RAM/disk sample. The mtime and the
  // PowerShell sampler's UnixTimeMilliseconds share the one Windows clock, so they compare directly.
  const frames = frameFiles.map((image, i) => {
    const st = statSync(path.join(dir, image));
    return { index: i, imageFile: image, imageBytes: st.size, ms: st.mtimeMs };
  });
  const firstFrameMs = frames[0].ms;
  const resourceSamples = readResourceSamples(dir);
  let meta: CaptureMetadata = captureMetadataForPlatform('win32');
  const metaFile = path.join(dir, 'capture-meta.json');
  if (existsSync(metaFile)) {
    const parsed = JSON.parse(readFileSync(metaFile, 'utf8')) as Partial<CaptureMetadata>;
    if ((parsed.workload === 'labview-launch' || parsed.workload === 'desktop-capture')
      && ['WIN', 'LINUX'].includes(String(parsed.plane))
      && (CAPTURE_SOURCES as readonly string[]).includes(String(parsed.source))) {
      meta = parsed as CaptureMetadata;
    }
  }
  const record = builder.buildLaunchCapture({
    frames,
    resourceSamples,
    startMs: firstFrameMs,
    fps: captureFpsOf(meta),
    meta,
  });
  // #134: the GPU series (additive; a capture without gpu.json is assembled exactly as before) and the automatic
  // GPU agent cues (memory rise = model load, utilization rise = compute) on the shared marker grab.
  const gpu = readGpuSeries(dir);
  attachGpuSeries(record, gpu);
  if (gpu && gpu.header.available && extras.grab) {
    const cues = gpuCueMarkers(record, gpuCues(gpu.samples, { platform: meta.plane, ...extras.gpuCue }), extras.grab);
    // The builder emits no markers; the correlator's user-click markers are appended later.
    if (cues.length > 0) record.markers = cues;
  }
  writeFileSync(path.join(dir, 'capture.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
