// labview-benchmark-actor -- frame markers: click-to-label on the raw benchmark data with a
// +/-200 ms image-grab tolerance (LBA-REQ-011, extended per performance-counter-schema.json).
//
// Pure, dependency-free ESM (Node >= 18). A pointer CLICK on the raw-data chart resolves to an
// epoch-ms instant and writes a MARKER into the launch metadata; post-processing grabs the captured
// frame image nearest that instant, admitting the grab ONLY when it lands within toleranceMs
// (default 200). Outside the tolerance NO image is attached -- a marker never gets a wrong-frame image.
// Deterministic: same input -> same output, so it is a re-runnable local-gate artifact.

import { frameIndexOf } from './resourceUsageCorrelation.mjs';
// The nearest-frame grab lives in its own import-free module so the extension can stage it (agent cues, #134).
import { DEFAULT_MARKER_TOLERANCE_MS, resolveMarkerImageGrab } from './markerImageGrab.mjs';

export const FRAME_MARKER_SCHEMA = 'labview-benchmark-actor/frame-marker@v2';
export { DEFAULT_MARKER_TOLERANCE_MS, resolveMarkerImageGrab };
export { frameIndexOf };

/**
 * Build a marker from a click on the raw data. The chart maps click-x -> epochMs (the same shared
 * axis the time cursor uses); a CLICK (not a scrub drag) calls this to write a marker into metadata.
 *
 * @param {number} epochMs click instant (host axis).
 * @param {object} opts
 * @param {number} opts.epochMsAtFrameZero capture clock origin.
 * @param {number} opts.frameIntervalMs 1000/frameRateHz (12 FPS -> 83.333..).
 * @param {Array} [opts.frames=[]] captured frames (see resolveMarkerImageGrab).
 * @param {string} [opts.label] operator label; defaults to `marker <seq>`.
 * @param {string} [opts.kind='user-click']
 * @param {number} [opts.seq=1] 1-based marker sequence (for id + default label).
 * @param {number} [opts.toleranceMs=200]
 * @param {number} [opts.now=Date.now()] click wall-clock ms for createdAt.
 * @returns {object} a frame-marker@v2 marker.
 */
export function buildMarker(epochMs, opts = {}) {
  const {
    epochMsAtFrameZero, frameIntervalMs, frames = [], label, kind = 'user-click',
    seq = 1, toleranceMs = DEFAULT_MARKER_TOLERANCE_MS, now = Date.now()
  } = opts;
  if (!Number.isFinite(epochMs)) throw new Error('buildMarker requires a finite epochMs.');
  if (!Number.isFinite(epochMsAtFrameZero) || !(Number.isFinite(frameIntervalMs) && frameIntervalMs > 0)) {
    throw new Error('buildMarker requires a finite epochMsAtFrameZero and a positive frameIntervalMs.');
  }
  const frameIndex = frameIndexOf(epochMs, epochMsAtFrameZero, frameIntervalMs);
  const imageGrab = resolveMarkerImageGrab(epochMs, frames, toleranceMs);
  return {
    schema: FRAME_MARKER_SCHEMA,
    id: `m-${Math.round(epochMs)}-${seq}`,
    epochMs,
    frameIndex,
    label: typeof label === 'string' && label.length ? label : `marker ${seq}`,
    kind,
    createdAt: new Date(now).toISOString(),
    imageGrab: { toleranceMs, ...imageGrab }
  };
}

/**
 * Classify a pointer gesture on the raw-data chart as a marker CLICK vs a cursor scrub DRAG.
 * A click (movement below clickSlopPx) writes a marker; a drag moves the time cursor.
 * @param {{downX:number, upX:number, downY:number, upY:number}} g pointer down/up positions (px).
 * @param {number} [clickSlopPx=4] max pixel movement that still counts as a click.
 * @returns {'click'|'drag'}
 */
export function classifyPointerGesture(g, clickSlopPx = 4) {
  if (!g || ![g.downX, g.upX, g.downY, g.upY].every(Number.isFinite)) return 'drag';
  const moved = Math.hypot(g.upX - g.downX, g.upY - g.downY);
  return moved <= clickSlopPx ? 'click' : 'drag';
}
