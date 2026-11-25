# labview-benchmark-actor — MCP tools

> GENERATED from the MCP tool registry (`src/mcp/benchmarkActorMcpServer.ts`). Do not hand-edit;
> regenerate with `node scripts/mcpToolDoc.mjs --write docs/mcp-tools.md`. Drift is gated by `npm test`.

The extension contributes a Model Context Protocol server (provider `labviewBenchmarkActor`, server `labview-benchmark-actor`, protocol `2025-06-18`) exposing the following tools to Copilot agent mode. The server is a dependency-free stdio JSON-RPC process launched by the extension; the tools that shell `lbabus` degrade gracefully when the CLI is absent.

## Using the tools from a local Ollama model

With Ollama running and a tool-capable model installed, use plain Node from the project root.
For the capability probe, put `lbabus` on PATH or set `LBA_LBABUS_PATH` to its executable.
These commands work in Windows PowerShell 5.1 and PowerShell 7:

```powershell
npm.cmd ci
npm.cmd run compile
node out/mcp/ollamaMcpBridge.js --model qwen3 --self-test
$LASTEXITCODE
```

Use `--prompt "Show the benchmark series"` for a normal chat; `--json` prints a receipt instead of the final text.
The bridge connects to `http://127.0.0.1:11434` by default (`--ollama` overrides `OLLAMA_HOST`).
Tool results go to that endpoint, so use a model service you trust. No listener or editor is needed.

Enabled by default: `get_host_capabilities`, `get_benchmark_series`, `poll_coordination_bus`.
Use repeated `--allow-tool <name>` options to enable other listed tools, including the bus write.
The server inherits the usual bus configuration. A denied call returns an error to the model.
The capture tools `add_capture_marker` and `export_capture_clip` are opt-in the same way, for example
`--allow-tool export_capture_clip`. They act only on captures under `LBA_CAPTURE_ROOT` on this machine and
return metadata (markers, receipts, SHA-256), never pixels: screen frames and clips stay on the machine.

`--self-test` asks for a capability probe. Its JSON receipt lists all discovered tool names, the model and
Ollama version, each call name, SHA-256 of its JSON arguments and success flag, the SHA-256 of the final
text, and the exit code. A name the server did not list is recorded as `unlisted` with `nameSha256`, never
as text. It contains no raw arguments, results or environment. Exit 0 means at least one call and all
succeeded; 1 means no call, a failed call, or an Ollama reply that was read in full and decoded but is
unusable: any non-2xx status (redirects are never followed), a body that is not JSON, or JSON of the wrong
shape (for example a missing model); 2 means the MCP server failed, or an Ollama reply could not be read in
full or decoded (refused, DNS, timeout, a connection dropped mid-body, or any gzip, brotli or deflate
failure).
`--max-turns` bounds chat requests (default 8). At the limit the last calls are
still counted; if there was no final reply, the final text hash is that of the empty string.

## Active capture resources

The same server lists bounded, pathless `lba-capture://session/{runId}` metadata resources and supports `resources/read` for session state, ordered frame/sample batches, and explicitly requested PNG frames. Batch and frame URI templates are listed by `resources/templates/list`; frame reads require the SHA-256 returned by a batch. The extension passes its Global Storage root only through the stdio process environment. Reads never control capture. See ADR-0084 / LBA-REQ-101.

The registry publishes 15 tools: 6 core tools and 9 folded corroboration grid tools.

## `get_host_capabilities`

Report what the current host can actually run for LabVIEW benchmarking (LabVIEW runtime + bitness, Docker engine, etc.) via the lbabus capabilities probe. Run this before proposing benchmark work.

**Arguments:**

_(no arguments)_

## `get_benchmark_series`

Return the deterministic mprr ring-buffer benchmark metric series the extension's viewer renders, as ordered {t,v} points plus a stable content hash (seriesHash). Reproduce this series; do not re-derive it. Pass runId to also get that local capture's GPU series (nvidia-smi utilization/memory/power, or the reason it is unavailable).

**Arguments:**

- `runId` (string, optional) — Optional capture run id (uuid) or "latest": adds that capture's GPU series (metadata only).

## `poll_coordination_bus`

Read the latest cross-plane (WIN <-> LINUX) coordination-bus messages from the live-only lbabus net bus (net poll of the local receive-log). The bus is the authoritative "what is next" channel.

**Arguments:**

- `tail` (integer, optional, range 1..100) — How many of the most recent messages to read (default 10).

## `post_coordination_note`

Post a NOTE to the cross-plane coordination bus over the live-only lbabus net bus (net send).

**Arguments:**

- `message` (string, required) — ASCII coordination note body.

## `export_capture_clip`

Encode the frames of one local capture between two markers (default: the latest two) or two frame indices into an H.264 MP4 inside that capture's clips/ directory, held at real time. Returns the receipt only (marker instants, deltaMs/admitted, frame range, fps, SHA-256, size, duration); the clip never leaves the machine.

**Arguments:**

- `runId` (string, optional) — Capture run id (uuid) or "latest" (default).
- `fromMarker` (integer, optional, range 0..) — Start marker: index into the capture markers[].
- `toMarker` (integer, optional, range 0..) — End marker: index into the capture markers[].
- `fromFrame` (integer, optional, range 0..) — Start frame index (instead of markers).
- `toFrame` (integer, optional, range 0..) — End frame index, inclusive (instead of markers).
- `monitor` (integer, optional, range 0..) — Crop to this monitor of the recorded screen layout.
- `crop` (object, optional) — Crop rectangle in frame pixels (must lie inside the frame).

## `add_capture_marker`

Add an agent-cue marker to one local capture at an instant (ms since frame 0) or a frame index. It uses the same nearest-frame grab as a user click (imageGrab: nearestFrameIndex, deltaMs, admitted within toleranceMs).

**Arguments:**

- `runId` (string, optional) — Capture run id (uuid) or "latest" (default).
- `instantMs` (number, optional) — Instant on the capture time axis (ms since frame 0).
- `frameIndex` (integer, optional, range 0..) — Or a frame index (its tMs is the instant).
- `label` (string, required) — What the agent observed (<= 80 characters).

---

## Corroboration grid tools (folded)

The same single server also folds in the Actor Corroboration Grid tools (ADR-0020 / LBA-REQ-029), so an agent can orchestrate release corroboration directly. Signing and recording stay operator/CI steps.

### `spin_up_witness`

Return the provisioning plan for a corroboration-grid witness of a given plane (CODESPACE|VBOX|WIN). Live execution is the operator step.

**Arguments:**

- `plane` (string, required) —

### `run_quorum`

Run the corroboration quorum (ADR-0015) over a set of witness bundles and return the graded-majority verdict.

**Arguments:**

- `bundles` (array, required) —
- `threshold` (number, optional) —

### `get_confidence`

Return just the quorum verdict + graded confidence for a set of witness bundles.

**Arguments:**

- `bundles` (array, required) —
- `threshold` (number, optional) —

### `verify_attestation`

Verify-before-consume (ADR-0016): given attested witnesses + an enrolled allowlist, decide whether the release is consumable.

**Arguments:**

- `witnesses` (array, required) —
- `allowlist` (object, optional) —

### `check_independence`

Assess witness independence (ADR-0017): whether the witnesses span distinct enrolled environments with recorded identities.

**Arguments:**

- `witnesses` (array, required) —
- `enrollment` (object, optional) —

### `assemble_witness`

Assemble a witness bundle (ADR-0014) from its gate/screenshot/capability receipts, failing closed on a missing anchor.

**Arguments:**

- `plane` (string, required) —
- `gate` (object, required) —
- `screenshot` (object, required) —
- `capability` (object, optional) —
- `os` (string, optional) —
- `ubuntu` (string, optional) —

### `verify_inclusion`

Transparency-log inclusion (ADR-0022): verify a witness attestation is included in the Ed25519-signed Merkle transparency log, reconstructing the signed root from the inclusion proof.

**Arguments:**

- `attestation` (object, required) —
- `inclusion` (object, required) —
- `signedTreeHead` (object, required) —
- `logPublicKeyPem` (string, optional) —

### `verify_before_install`

Verify-before-install (ADR-0022, LBA-REQ-031): given a release-provenance bundle, decide whether the release is installable -- at least quorumMin witnesses each enrolled-signed AND included in the signed transparency log.

**Arguments:**

- `provenance` (object, required) —

### `teardown`

Return the teardown plan for a corroboration-grid witness of a given plane. Live execution is the operator step.

**Arguments:**

- `plane` (string, required) —
- `id` (string, optional) —
