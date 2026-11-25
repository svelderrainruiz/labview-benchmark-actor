# ADR-0095: Correlate GPU samples, agent cues and clips on the capture's time base; clips stay local

- Status: Accepted
- Date: 2026-11-25
- Owner: LINUX
- Traces to: LBA-REQ-105

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
