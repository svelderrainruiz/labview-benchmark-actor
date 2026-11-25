# ADR-0095: Correlate GPU samples, agent cues and clips on the capture's time base; clips stay local

- Status: Accepted
- Date: 2026-11-25
- Owner: LINUX
- Traces to: LBA-REQ-105, LBA-REQ-106

## Context

A local model that drives a workload needs to see what the GPU did, where it acted and what the screen
showed between two instants. A capture already aligns frames, CPU/RAM/disk samples and user-click markers
on one wall clock (#134). Measurements on a Windows laptop and a LINUX workstation showed that
`utilization.gpu` lags real compute by about 0.45 s on Windows and 0.18-0.38 s on LINUX, that a short
generation can peak below 20%, and that a looping `nvidia-smi -lms` writer loses its buffered tail when killed.

## Decision

Sample GPUs with one `nvidia-smi --query-gpu=timestamp,...` call per tick at the existing cadence and use its
`timestamp` column as the sample time. Record the GPU index and name once. When nvidia-smi is missing or no
sample succeeds, record the series as unavailable with the reason, never as zeros.

Agent cues are markers of kind `agent-cue` placed through the same `resolveMarkerImageGrab` as a user click,
so `imageGrab` (toleranceMs, nearestFrameIndex, deltaMs, admitted) means the same for both. Two automatic
cues mark a debounced rise of GPU memory above the first sample (model load, the primary edge) and of
utilization through a configurable threshold (compute, default 10%); each records the platform's measured lag.

A clip between two markers is encoded with ffmpeg's concat demuxer, holding each frame for its real interval
and capping the output at the real duration, into `clips/` inside the capture on the machine that holds it.
The MCP tools return the receipt (instants, grab fields, frame range, frame rate, SHA-256, size, duration)
and never pixels. They are not enabled by default for the Ollama bridge.

## Consequences

GPU evidence depends on an NVIDIA driver; other GPUs are reported unavailable. Sample times rely on the host's
local clock and time zone, as the CPU samples already do. A clip at a slow desktop cadence plays at real time,
so it is mostly held frames. Monitor crops need a recorded screen layout, which captures do not have yet, so
only a rectangle crop works today.

## Addendum: the local-model loop (slice 4)

The same capture runs without VS Code in one command, `node out/mcp/localModelLoop.js`, on the machine that
holds the screen. It reuses the extension's code paths rather than a second implementation: the ffmpeg
arguments of `capturePlatform.ts` (gdigrab, x11grab, plus a lavfi `testsrc` source for headless checks), the
resource samplers, `assembleCaptureFromDir` (moved with the ffmpeg lookup into vscode-free modules), the
slice-2 GPU sampler and cues, the slice-3 agent-cue grab and the slice-1 clip export. The run directory goes
under the extension's globalStorage `captures` folder by default, so the installed extension's correlator can
open it.

The prompt goes through the MCP bridge (`runBridge`) with a streamed `/api/chat`, so the first content chunk
gives the first-token instant and the `done` chunk the response-done instant. Tools are offered only from the
bridge's allow-list plus `--allow-tool`, and only to a model that reports the `tools` capability. The bridge
CLI itself keeps its non-streamed request. "prompt sent", "first token" and "response done" are agent cues;
they and the GPU cues are stored in time order. The clip runs from the earliest of prompt sent and the first
GPU cue minus 1 s to response done plus 1 s. `--cold` unloads the model first so the model-load cue appears.

The loop prints one receipt (also written next to the clip) with metadata only: hashes, instants, grab fields,
GPU edges with their offsets from prompt sent, the model digest, and at most 200 characters of the answer.
Each prerequisite failure has its own message and exit code, a capture without frames is marked failed, and a
missing nvidia-smi leaves the loop running with the GPU series unavailable. Desktop capture needs Windows or an
Xorg session; elsewhere only `--source test` runs.
