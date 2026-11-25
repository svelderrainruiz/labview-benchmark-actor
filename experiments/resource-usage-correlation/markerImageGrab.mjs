// labview-benchmark-actor -- the nearest-frame image grab shared by every capture marker kind
// (LBA-REQ-011 user-click markers and the #134 agent cues).
//
// Pure, dependency-free ESM (Node >= 18) with no imports, so scripts/stage-media.mjs can stage it verbatim
// into the extension's media/ directory, where the extension host, the MCP server and the clip CLI import it.
// frameMarkers.mjs re-exports both symbols unchanged.

export const DEFAULT_MARKER_TOLERANCE_MS = 200;

/**
 * Grab the captured frame nearest an instant, admitting the grab ONLY within tolerance.
 *
 * @param {number} epochMs marker instant on the shared host epoch-ms axis.
 * @param {Array<{index:number, captureEpochMs:number, image?:string|null}>} frames captured frames.
 * @param {number} [toleranceMs=200] max |captureEpochMs - epochMs| that still admits the grab.
 * @returns {{nearestFrameIndex:number|null, nearestCaptureEpochMs:number|null, deltaMs:number|null, admitted:boolean, imageRef:string|null}}
 */
export function resolveMarkerImageGrab(epochMs, frames, toleranceMs = DEFAULT_MARKER_TOLERANCE_MS) {
  const miss = { nearestFrameIndex: null, nearestCaptureEpochMs: null, deltaMs: null, admitted: false, imageRef: null };
  if (!(Number.isFinite(toleranceMs) && toleranceMs >= 0)) {
    throw new Error('resolveMarkerImageGrab requires a finite toleranceMs >= 0.');
  }
  if (!Number.isFinite(epochMs) || !Array.isArray(frames) || frames.length === 0) {
    return miss;
  }
  let best = null;
  for (const f of frames) {
    if (!f || !Number.isFinite(f.captureEpochMs)) continue;
    const delta = Math.abs(f.captureEpochMs - epochMs);
    // Deterministic tie-break: strictly-smaller delta wins; on an exact tie keep the EARLIER frame.
    if (best === null || delta < best.delta || (delta === best.delta && f.captureEpochMs < best.frame.captureEpochMs)) {
      best = { delta, frame: f };
    }
  }
  if (best === null) return miss;
  const admitted = best.delta <= toleranceMs;
  return {
    nearestFrameIndex: Number.isInteger(best.frame.index) ? best.frame.index : null,
    nearestCaptureEpochMs: best.frame.captureEpochMs,
    deltaMs: best.delta,
    admitted,
    imageRef: admitted ? (best.frame.image ?? null) : null
  };
}
