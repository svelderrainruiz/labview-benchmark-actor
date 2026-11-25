# Command Reference

> Every **LabVIEW Benchmark Actor** command contributed to the VS Code Command
> Palette, grouped by task. Aligns to **ISO/IEC/IEEE 26514:2022 §5** (reference
> information). This surface is kept **complete** by the `information-for-users-26514`
> gate, which fails closed if a contributed command is missing here.
> Command IDs are prefixed `labviewBenchmarkActor.`.

## Host and coordination bus

| Command | ID | What it does |
| --- | --- | --- |
| **Show Host Capabilities** | `showCapabilities` | Report what the actor sees on this host (local only). |
| **Poll Coordination Bus** | `pollBus` | Read recent messages from the `lbabus` coordination bus. |
| **Post Coordination Note** | `postNote` | Post an inter-actor note to the bus (communication only; never run data). |

## Benchmark capture and review

| Command | ID | What it does |
| --- | --- | --- |
| **Capture LabVIEW Launch** | `captureLaunch` | Record the operator-visible actor desktop while LabVIEW launches: Windows uses ffmpeg `gdigrab`; Ubuntu Xorg uses `x11grab`; Ubuntu Wayland keeps a persistent `gjs` client connected to GNOME Shell's native recorder, so LabVIEW opens on the visible desktop and operators can interact with it to introduce benchmark variations. Stop finalizes the Wayland video and extracts PNG evidence at exactly 12 FPS before assembly. Linux also records CPU/RAM plus `/proc/diskstats` throughput/utilization samples. **Requires `ffmpeg`**; Ubuntu Wayland requires `gjs`, while Xorg requires `xdpyinfo` from `x11-utils` (the maintained VM provisioner installs all of them). Set `labviewBenchmarkActor.labviewPath` only when the normal LabVIEW path is not correct. Stop from the status bar to assemble the evidence and open the correlator. |
| **Capture LabVIEW Launch (mprr, cross-platform VM)** | `captureLaunchMprr` | Benchmark a separate target VirtualBox VM through the mprr visual ring (SSH-trigger + VBox-VNC capture). Use this when the target LabVIEW desktop is not the current Windows or Ubuntu graphical session. Configure `mprrSshPort`/`mprrVncPort`/`mprrVncPassword`/`mprrIterations`. |
| **Capture Desktop** | `captureDesktop` | Record a standalone Windows desktop without locating or launching LabVIEW. Requires ffmpeg; `desktopCaptureIntervalSeconds` selects an integer frame interval from 1 through 120 seconds (default 60). The shared stop command finalizes `desktop-capture` evidence with the actual cadence and timestamps. |
| **Stop LabVIEW Capture** | `stopCapture` | Stop the active LabVIEW or desktop capture and assemble its record. |
| **Export Clip Between Markers** | `exportClip` | Encode the latest capture's frames between two markers (default the latest two; an exact twin of a marker counts once) or two frame indices into an H.264 MP4 under that capture's `clips/` folder, at real time, with an optional `x,y,w,h` crop. Writes a receipt with the SHA-256; nothing leaves the machine. Requires ffmpeg (`ffmpegPath`). Captures record NVIDIA GPU samples when `nvidia-smi` is present; `gpuCueThresholdPct` (default 10) sets the utilization cue. |
| **Open Benchmark Frame Correlator** | `openFrameCorrelator` | Scrub a time cursor across the metric curves + the captured screenshot at each frame. |
| **Open Benchmark Viewer** | `openViewer` | Open the time-cursor benchmark viewer on the shipped series. |
| **Open Benchmark Run** | `openBenchmarkRun` | Render one captured LabVIEW-launch run. |
| **Open Benchmark Trend** | `openBenchmarkTrend` | Render the multi-run launch trend. |

## Handoff Beacon (agent&#8596;human)

> When the agent asks you to perform a manual step in the reviewer VM (run a VI,
> activate LabVIEW, click Stop), it surfaces as a notification with **Mark step
> done** / **Skip** buttons; these commands do the same from the palette. Your
> answer is written as a machine-readable `op-done` beacon the agent awaits, so it
> resumes without re-asking (LBA-REQ-056, ADR-0036).

| Command | ID | What it does |
| --- | --- | --- |
| **Mark Handoff Step Done** | `markStepDone` | Answer the agent's pending handoff request as done (writes the op-done beacon the agent awaits); prompts for an optional note. |
| **Skip Handoff Step** | `skipStep` | Decline the agent's pending handoff request (writes an op-done beacon with a `skipped` outcome). |
| **Render Reviewer Verdict** | `renderReviewerVerdict` | Record + Ed25519-sign your visual PASS / CHANGES / FAIL of the release candidate under review, using the enrolled reviewer key (`reviewerId` + `reviewerKeyPath`). Writes a signed reviewer verdict that gates the release. |

## Cross-plane and resource

| Command | ID | What it does |
| --- | --- | --- |
| **Open Cross-Plane Benchmark Trend** | `openCrossPlaneTrend` | Compare the launch trend across the WIN and LINUX planes. |
| **Open Benchmark Resource Profile** | `openResourceProfile` | Show the CPU/RAM/disk resource correlation for a run. |
| **Open Cross-Plane Resource Agreement** | `openCrossPlaneResource` | Show how the two planes agree on resource cost. |

## Mesh-stress analysis

| Command | ID | What it does |
| --- | --- | --- |
| **Open Mesh-Stress Calibration** | `openMeshCalibration` | Render the stress-ladder calibration curve + invariants + inverse-read. |
| **Open Concurrent Mesh Board** | `openMeshBoard` | Render a live board of N simultaneously-stressed actors and their inferred stress. |

## Agent instructions

| Command | ID | What it does |
| --- | --- | --- |
| **Write Agent Instructions** | `writeAgents` | Materialize the extension-embedded `AGENTS.md`. |
| **Show Agent Instructions** | `showAgents` | Open the embedded agent instructions read-only. |
| **Check Agent Instructions** | `checkAgents` | Verify the embedded `AGENTS.md` integrity manifest. |

## Provisioning

| Command | ID | What it does |
| --- | --- | --- |
| **Create Cleanroom Worker VM** | `createCleanroom` | Scaffold a cleanroom worker VM for delegated work. |
| **Bootstrap LabVIEW Authoring Lane (Windows)** | `bootstrapAuthoringLane` | Bootstrap the Windows LabVIEW authoring lane. |

## Release corroboration

| Command | ID | What it does |
| --- | --- | --- |
| **Run Corroboration Grid** | `runCorroborationGrid` | Run the multi-witness Actor Corroboration Grid end-to-end. |
| **Verify Release Provenance** | `verifyReleaseProvenance` | Verify the attestation chain before installing a release. |
| **Run Throughput-to-Disk Ladder** | `runThroughputLadder` | Run the C# `tpd` disk-throughput ladder and record a per-rung MBps receipt for best-effort cross-witness corroboration (no LabVIEW). |

## Local-model loop (CLI, no editor)

`node out/mcp/localModelLoop.js` runs the whole #134 loop in one command on the machine that holds the
screen: it starts a capture, prompts a local Ollama model through the MCP bridge, marks the GPU rise and
exports a clip around it. VS Code is not needed while it runs.

1. Checks that ffmpeg is found (`--ffmpeg`, `LBA_FFMPEG_PATH`, PATH, WinGet), that Ollama answers at
   `--ollama` (default `http://127.0.0.1:11434`) and that `--model` (default `qwen2.5vl:3b`) is pulled.
2. Creates `run-<uuid>/` under `--captures-dir` and records frames at `--fps` (default 4): `gdigrab` on
   Windows, `x11grab` on an Xorg session, or ffmpeg's lavfi `testsrc` with `--source test`. The CPU/RAM/disk
   sampler and the nvidia-smi GPU sampler run alongside.
3. Waits `--lead-ms` (default 2000), adds the cue "prompt sent", streams `--prompt` (and `--image <png>` for a
   vision model) to the model, and adds "first token" and "response done" from the stream. Tools are offered
   as the bridge does: its read-only defaults plus each `--allow-tool <name>`, and only when the model
   reports the `tools` capability.
4. Keeps recording `--tail-ms` (default 3000), stops, adds the automatic GPU cues (memory rise = model load,
   utilization through `--gpu-threshold-pct`, default 10% = compute, with the platform lag) and writes
   `capture.json` with all markers in time order.
5. Exports `clips/clip-<from>-<to>.mp4` from the earliest of prompt sent and the first GPU cue minus 1 s to
   response done plus 1 s, and writes `clips/loop-<from>-<to>.json`, the receipt it prints.

The receipt is metadata only: capture id and directory, model name, digest, size and capabilities, prompt
and answer SHA-256 with at most 200 characters of the answer, first-token latency, each cue's instantMs,
offset from prompt sent and imageGrab (deltaMs, admitted, toleranceMs), the GPU edges, the GPU series
availability or reason, the frame count and the clip's SHA-256, size and duration. Frames and clips stay on
the machine.

Use `--cold` to unload the model first, so that the capture also shows the model load. Without nvidia-smi the
loop still completes and the receipt marks the GPU unavailable with the reason.

| Exit | Meaning |
| --- | --- |
| 0 | Loop done; the receipt is on stdout and in `clips/`. |
| 2 | Bad arguments (the usage is printed). |
| 3 | Missing prerequisite: ffmpeg, Ollama unreachable, model not pulled, no desktop to record, `--cold` unload failed. No capture is created. |
| 4 | The capture yielded no frames; the run is marked failed in `capture-status.json` and `active-capture-session.json`. |
| 5 | The model failed or gave no complete answer; the capture is kept and `loop-receipt.json` is written. |
| 6 | The clip failed; the capture is kept and `loop-receipt.json` is written. |
| 7 | Reference mode: the reference run failed (HTTP error, invalid or incomplete stream, endpoint unreachable during the run); the capture is kept and `loop-receipt.json` is written. The local phase is skipped. |
| 8 | Reference mode: the reference timed out (`--reference-timeout-ms`); as for 7. |

Default captures folder (the installed extension's `globalStorage`, so **Open Benchmark Frame Correlator**
can open the run):

- Windows: `%APPDATA%\Code\User\globalStorage\svelderrainruiz.labview-benchmark-actor\captures`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Code/User/globalStorage/svelderrainruiz.labview-benchmark-actor/captures`
- macOS (`--source test` only): `~/Library/Application Support/Code/User/globalStorage/svelderrainruiz.labview-benchmark-actor/captures`

**Open Benchmark Frame Correlator** opens the run whose folder name sorts last, which is not necessarily the
newest. Extensions released before this loop (1.6.7 and older) show the frames and CPU/RAM curves but not
the GPU curves or agent cues.

### Run it on Windows

The CLI is not in the 1.6.7 package, so run it from a built checkout of the repository. In PowerShell, from
the checkout, with Ollama serving `qwen2.5vl:3b` on `127.0.0.1:11434`, ffmpeg on PATH (WinGet Links) and
the NVIDIA driver's `nvidia-smi`:

```powershell
npm.cmd ci
npm.cmd run compile
C:\nvm4w\nodejs\node.exe out\mcp\localModelLoop.js --model qwen2.5vl:3b --cold
$LASTEXITCODE
```

Add `--source test` for a dry run that records ffmpeg's test pattern instead of the screen, and
`--prompt "..."`, `--image C:\path\shot.png`, `--fps 8`, `--lead-ms 3000` or `--tail-ms 5000` as needed.
The run is written to
`%APPDATA%\Code\User\globalStorage\svelderrainruiz.labview-benchmark-actor\captures\run-<uuid>\`:
`frame-*.png`, `resources.jsonl`, `gpu.json`, `gpu.jsonl`, `capture.json`, `capture-status.json`,
`active-capture-session.json`, `capture-meta.json`, and in `clips\` the MP4, its clip receipt and the loop
receipt. Progress goes to stderr; stdout holds only the receipt, so
`... | Out-File -Encoding utf8 loop-receipt.json` keeps it.

### Reference mode (Open WebUI)

`--reference openwebui --endpoint <https url> --token-file <path> --reference-model <id>` adds a reference
phase before the local phase in the same capture (#139). The same prompt is streamed through the Open WebUI
chat-completions API (`<endpoint>/api/chat/completions`, OpenAI-compatible SSE) to the model id
`--reference-model` (for example `fast`, `thinking` or `coding`). `--model` stays the local Ollama model, so
the two may differ when a lower local model is documented.

1. Before the capture: the token file is read once, then `<endpoint>/api/models` must accept the token and
   list the model id (otherwise exit 3, no capture).
2. After `--lead-ms`: the cues "reference sent", "reference first token" and "reference done" are added on
   the capture's time axis. The GPU sampler keeps running: the local GPU should stay idle, which is the
   control.
3. After another `--lead-ms`: the local phase runs as without `--reference` (with `--cold` if given).

Both sides use temperature 0, `--seed` (default 42) and `--max-tokens` (default 256; Ollama `num_predict`,
OpenAI `max_tokens`). `--seed` or `--max-tokens` alone also fixes the local decoding; without any of these
flags, the Ollama request is unchanged. The clip starts 1 s before "reference sent".

The receipt gets `decoding`, `reference` (model id, endpoint scheme and SHA-256 rather than the host, answer
SHA-256 and a 200-character excerpt, usage) and one `comparison` block. For each side, `comparison` holds the
first-token latency, total time, output count and tokens per second (from the first token to done). The
reference side also holds `gpuControl`: the local GPU utilization and VRAM during the reference window, and
`idle` (below `--gpu-threshold-pct`, with less than `--gpu-memory-rise-mb` of memory rise). The local side
also holds the VRAM peak. `gpuEdges` lists the GPU edges and whether each fell inside the reference window.
The output count is in `tokens` (the stream's `usage`, or Ollama `eval_count`) or, when no count was
reported, in `chunks` (non-empty stream deltas), and `outputUnit` says which.

Token rules: the token is sent only as the `Authorization: Bearer` header. It never appears in argv, output,
logs, the receipt or `capture.json`, and is redacted from the reference excerpt if the endpoint echoes it.
The file must be non-empty, hold one token of visible ASCII and, on Linux and macOS, be readable by its owner
only (`chmod 600`); otherwise exit 2 with a message that never shows the content. `--endpoint` must be
https; plain http is accepted only for `127.0.0.1` or `localhost` (tests). `--reference-timeout-ms` (default
300000) bounds each reference request.

```powershell
C:\nvm4w\nodejs\node.exe out\mcp\localModelLoop.js --model <local model> --cold `
  --reference openwebui --endpoint https://owui.example.invalid --token-file C:\path\owui.key --reference-model fast
```

## Agent surface

Every panel command above is also openable by an agent through the
`lba-open-benchmark-panel` **language-model tool** (`panel = run | trend |
frameCorrelator | crossPlaneTrend | resourceProfile | crossPlaneResource |
meshCalibration | meshBoard`), and the actor's core tools are exposed over the
Model Context Protocol server. See [`AGENTS.md`](../../extension-agents/AGENTS.md)
and [Delivery Profile](./delivery-profile.md).
