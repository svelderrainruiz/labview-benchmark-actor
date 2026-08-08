# labview-benchmark-actor — Agent Instructions (extension users)

These are the agent instructions shipped **inside** the `labview-benchmark-actor` VS Code extension. They
are versioned on their **own** semver (see `agents.manifest.json`), independent of the extension build and of
the `collab-cli` (`lbabus`) coordination instructions. Materialize this file into your workspace with the
command **"LabVIEW Benchmark Actor: Write Agent Instructions"** so your coding agent picks it up.

You are an AI coding agent working in a workspace where the **labview-benchmark-actor** extension is
installed. This file tells you how to leverage it.

## Next-agent prerequisite contract

Treat this as an executable agent preflight, not optional human setup prose. Run **Show Host Capabilities** and
`lbabus selfcheck` before proposing work; stop and remediate a missing required tool rather than guessing.

| Tool | Required/validated version | Agent action |
| --- | --- | --- |
| VS Code | `>=1.101.0` | Required for the extension and contributed MCP server. |
| `lbabus` | **exactly `0.15.4` for this extension build** | Run `lbabus version`. Reviewer staging installs this version at `C:\lba-tools\lbabus\lbabus.exe`; extension commands, MCP, and human tasks resolve that path explicitly so a stale Explorer/VS Code PATH cannot hide it. Else install with `dotnet tool install --global LabVIEWBenchmarkActor.CollabBus --version 0.15.4`. |
| Node.js | **exactly `24.19.0` for source-checkout repository/release work** | Match the repository `.nvmrc`; packaging is Node-version-bound. Evidence-only reviewer workspaces use VS Code's bundled runtime and do not require a separate Node installation. |
| .NET runtime | `>=8.0` | Required to execute the framework-dependent `lbabus` payload. |
| .NET SDK | `>=8.0` when building/staging `lbabus` | Required for `dotnet build/publish`; runtime-only hosts can consume but not rebuild it. |
| Git / Git for Windows | `>=2.30` | Required for provenance, worktrees, release lineage, and patch evidence. |
| ripgrep (`rg`) | `>=13.0` | Required by `lbabus grep` and repository search gates. |
| GitHub CLI (`gh`) | `>=2.20` | Required for GitHub workflow/artifact/release operations. |
| GitLab CLI (`glab`) | `>=1.25` for a fully green `lbabus selfcheck` | Install when running the complete pinned collaboration-toolchain gate. |
| Standards corpus | Eight governed PDFs under `C:\design\standards` (or `STANDARDS_ROOT`) | Required by **LBA: Governance Review**: ISO 10007, 12207, 15289, 29119-2/3, 29148, 42010, and 26514. The task mounts this local corpus read-only; never commit or redistribute it. |

Optional substrate versions used by this release's validated Windows reviewer lane are **Vagrant 2.4.9**,
**VirtualBox 7.2.8**, **LabVIEW 2026 Q3** (32-bit and/or 64-bit as the workload requires), and **TightVNC
2.8.81**. Docker, Vagrant, VirtualBox, VMware, LabVIEW, FFmpeg, and VIPM are workload-specific: their absence
must be reported explicitly by capabilities, never silently treated as available.

## Compound human tasks — bundle v1.0.4

Open **Terminal: Run Task**. These tasks are contributed by the installed extension, so downloaded Marketplace
users receive them without a repository `.vscode/tasks.json`:

- **LBA: Agent Preflight** — `lbabus version`, `selfcheck`, and host capabilities.
- **LBA: Governance Review** — local `repo-standards-review` checkout plus the published Linux
  `assurance-workbench:main` `release-gate` profile and the local standards corpus.
- **LBA: Reviewer Mesh Readiness (compound)** — preflight, then governance.
- **LBA: Release Candidate Check (compound)** — reviewer readiness, tests, local gates, and packaging.

Governance requires the standards PDFs at `C:\design\standards` (or `STANDARDS_ROOT`) and mounts them read-only at
`/standards`; the PDFs remain local and are never packaged. `release-components.json` pins the exact
`repo-standards-review` commit and published workbench image digest used by this extension build.

## Standards scorecard and forward risk baseline

This build uses **repo-standards-review 0.2.19** at commit
`d44f210ded557cda6d4598cdaffe938da51d873e`, workbench digest
`sha256:0fbb71c193ab71dae4b37a2f012fd5369632ff80c47b807c09c86d7a2877cb94`, score schema 1.2.0,
profile `release-gate`, depth `deep`.

The raw static baseline is REQ/ARCH/TEST/CM/DOC **5/5** (25/25) and coverage/CM/REQ/ARCH/DOC/DoD
**PASS**. Its Missing Proof cells are `-`. Here, `-` means only that the workbench found no missing repository
artifact for that static rule; it does **not** mean the exact release candidate has no residual risk.

The governed release-evidence overlay in `release-risk-baseline.json` currently proves **12/28 (42.9%)** items and is
**BLOCKED**:

| Gate | Static workbench | Release proof | Missing proof/risk | Detailed next action |
| --- | --- | --- | --- | --- |
| coverage | PASS / High | 2/4 AT_RISK | hosted CI and cross-plane final-candidate proof | Run hosted CI plus Linux/Windows reproducibility and corroboration for the final commit. |
| cm | PASS / High | 1/5 AT_RISK | immutable candidate receipt, remote reviewed head, canonical GitHub Release, shared main/develop lineage | Seal the final local commit/package, then after signed PASS publish and review the head, merge with ancestry, release to `main`, and back-merge. |
| req | PASS / High | 2/3 AT_RISK | signed human acceptance | Have the reviewer explicitly accept or reject this scorecard/AGENTS behavior in the signed verdict. |
| arch | PASS / High | 2/3 AT_RISK | signed acceptance of ADR-0078 through ADR-0080 | Review the release decisions in the exact candidate and bind the result to the signed verdict. |
| doc | PASS / High | 2/4 AT_RISK | hosted link check and human AGENTS usability | Run hosted links and have the reviewer execute these forward actions without hidden setup. |
| dod | PASS / Med | 3/9 BLOCKED | reproducible candidate receipt, full local-CI KPI receipt, signed PASS, cross-plane composite, canonical release, Marketplace prerelease closeout | Do not publish; seal the package and full KPI, then complete the human, machine, canonical-release, and secondary-distribution gates in order. |

Agent rule: read `release-risk-baseline.json` before release work. Report an ordered action list for every missing proof
with its expected artifact and blocker. Never convert `missing` to `present` from inference, a static PASS, or prose;
require evidence for this exact version/candidate. Prioritize DoD blockers, then CM/coverage, then doc/req/arch risks.

### Human visual verdict boundary

A signed visual **PASS** means the exact commit/VSIX receipt, installed behavior, generated AGENTS workflow, and
reviewed architecture are acceptable. It does **not** authorize publication and does not require downstream hosted,
cross-plane, canonical-release, lineage, or Marketplace proofs to exist yet. Those proofs must remain `missing` and
the final release must remain BLOCKED until later phases produce them. Request changes only for a candidate defect,
an unbound candidate/KPI receipt, a failed reviewer preflight, or unusable reviewer/agent behavior—not merely because
correctly ordered downstream release proofs are still pending.

Reviewer staging places `candidate.vsix` and `candidate-receipt.json` in the evidence workspace. The receipt must be
full-mode PASS, name the exact Git commit, carry the same VSIX hash/size, show clean-before/clean-after, expose
coverage/local-gate/correspondence counters, and prove two package hashes identical. Hash the physical VSIX and compare
it to the receipt before recommending the visual verdict.

### Experiment lifecycle and local continuous KPI

Experiment-governance/KPI bundle **v1.0.1** applies to this extension build.
Every immediate `experiments/` directory must be referenced by the RTM or listed in
`experiments/governance-overrides.json` as active, prototype, superseded, or retired. Prototype/superseded/retired
experiments are prohibited from production surfaces; superseded entries name a resolvable active replacement.

While editing, update `CHANGELOG.md` in the same increment and run:

```text
npm run ci:local:quick
```

Before requesting a verdict, commit the candidate and run from a clean worktree:

```text
npm run ci:local
```

The full KPI is acceptable only when system version + CHANGELOG PASS, experiments are **62/62 governed** with
**0 ungoverned** and **0 forbidden production references**, line/statement coverage is at least **95%**, function
coverage is at least **96%**, branch coverage is at least **95%**, and **203/203** local gates pass,
**178/178** correspondences pass, and two normalized VSIX hashes match. Its receipt is
`.lba/local-ci/latest.json`; collect it with the pre-verdict evidence. Release evidence may still be BLOCKED, in which
case follow the detailed missing-proof actions above rather than treating local CI as a release verdict.

Task bundle **v1.0.4** is noninteractive, fails on the first nonzero child command, prefixes every command/output
event with a stable index, UTC wall timestamp, monotonic nanoseconds, and clock source, and writes a machine-readable
receipt under extension global storage. Before deleting a disposable human-review VM,
the operator must run the maintained raw-data collector so the next agent receives the target, candidate hash,
installed commands/tasks, AGENTS hash/version, `lbabus capabilities`, safe reviewer settings, VM identity, and
screenshot.

## What the extension provides

The extension surfaces the LabVIEW benchmark-actor's cross-plane benchmark data and coordination inside VS
Code:

- **Benchmark viewer** — renders a deterministic mprr ring-buffer series (the same series the screenshot
  harness captures), so you can inspect the benchmark result the actor produced rather than re-deriving it.
- **Host capabilities** — reports what the current host can actually run (LabVIEW runtime, Docker, etc.).
- **Coordination bus** — read and post notes on the cross-plane coordination bus (the WIN ⟷ LINUX channel).
- **MCP tools (agent mode)** — the extension contributes a Model Context Protocol server so you can call its
  tools directly in agent mode: `get_host_capabilities`, `get_benchmark_series`, `poll_coordination_bus`, and
  `post_coordination_note` — the same surfaces as the commands, callable programmatically.

## Commands (Command Palette)

| Command | When to use |
| --- | --- |
| `LabVIEW Benchmark Actor: Show Host Capabilities` | Learn the host's real runtime before proposing benchmark work. |
| `LabVIEW Benchmark Actor: Poll Coordination Bus` | Read the latest cross-plane coordination messages. |
| `LabVIEW Benchmark Actor: Post Coordination Note` | Post a coordination note to the bus. |
| `LabVIEW Benchmark Actor: Open Benchmark Viewer` | Show the rendered mprr benchmark series. |
| `LabVIEW Benchmark Actor: Open Benchmark Run` | Inspect the bundled launch-capture run. |
| `LabVIEW Benchmark Actor: Open Benchmark Trend` | Compare the bundled launch trend across iterations. |
| `LabVIEW Benchmark Actor: Open Benchmark Frame Correlator` | Correlate visual frames with timing and milestone data. |
| `LabVIEW Benchmark Actor: Open Cross-Plane Benchmark Trend` | Inspect Linux/Windows benchmark agreement. |
| `LabVIEW Benchmark Actor: Open Benchmark Resource Profile` | Inspect CPU, RAM, and disk correlation for a run. |
| `LabVIEW Benchmark Actor: Open Cross-Plane Resource Agreement` | Inspect resource-metric agreement across planes. |
| `LabVIEW Benchmark Actor: Open Mesh-Stress Calibration` | Review calibrated throughput/stress limits. |
| `LabVIEW Benchmark Actor: Open Concurrent Mesh Board` | Inspect concurrent actor status and results. |
| `LabVIEW Benchmark Actor: Capture LabVIEW Launch` | Record a real Windows LabVIEW launch with FFmpeg plus CPU/RAM/disk samples. |
| `LabVIEW Benchmark Actor: Capture LabVIEW Launch (mprr, cross-platform VM)` | Capture a VM LabVIEW launch through the mprr visual ring. |
| `LabVIEW Benchmark Actor: Stop LabVIEW Capture` | Stop the active launch capture and finalize available evidence. |
| `LabVIEW Benchmark Actor: Mark Handoff Step Done` | Complete the active human-assisted handoff step. |
| `LabVIEW Benchmark Actor: Skip Handoff Step` | Explicitly skip the active handoff step with recorded intent. |
| `LabVIEW Benchmark Actor: Render Reviewer Verdict` | Render and sign PASS/CHANGES/FAIL for the bound release candidate. |
| `LabVIEW Benchmark Actor: Write Agent Instructions` | Materialize this AGENTS.md into the workspace. |
| `LabVIEW Benchmark Actor: Show Agent Instructions` | Open the shipped canonical AGENTS.md read-only. |
| `LabVIEW Benchmark Actor: Check Agent Instructions` | Verify a workspace copy matches the shipped canonical. |
| `LabVIEW Benchmark Actor: Create Cleanroom Worker VM` | Create the supported cleanroom worker from a POSIX host. |
| `LabVIEW Benchmark Actor: Bootstrap LabVIEW Authoring Lane (Windows)` | Bootstrap the Windows ActiveX authoring lane and prerequisites. |
| `LabVIEW Benchmark Actor: Run Corroboration Grid` | Run the multi-plane corroboration grid for the current candidate. |
| `LabVIEW Benchmark Actor: Verify Release Provenance` | Verify release inclusion, signatures, and candidate provenance before use. |
| `LabVIEW Benchmark Actor: Run Throughput-to-Disk Ladder` | Measure sustained throughput-to-disk across the governed ladder. |

## How to work with the extension

1. Before proposing benchmark work, run **Show Host Capabilities** to learn the host's real runtime instead of
   assuming it.
2. Use the **Benchmark Viewer** to inspect the deterministic series; do not re-derive a result the actor has
   already produced.
3. Treat the **coordination bus** as the authoritative "what is next" channel. Its timestamps are the GitHub
   server `createdAt` — a single authoritative clock. Never reason from a message's embedded local `ts` (a
   sender's machine clock can drift); the tool surfaces a clock-skew note when it does.

## Conventions

- The benchmark series is **deterministic**: the same fixture yields the same series and the same screenshot
  hash. Reproduce, do not re-invent.
- Cross-plane results are compared by a content **digest** (a `resultHash` / `seriesHash`) that MUST match
  across planes. Do not treat a benchmark as agreed until the digests match on both planes.

## Windows notes

Windows-specific guidance for agents using this extension on a Windows host:

- **LabVIEW runtime & bitness.** Run **Show Host Capabilities** first — a Windows host often has *both* 32-bit
  and 64-bit LabVIEW installed. Match the bitness to the target VIs. The
  [`ni/labview-icon-editor`](https://github.com/ni/labview-icon-editor) repository is a VI/LabVIEW Project that
  uses LUnit: install and activate VI Package Manager first, then apply
  `C:\dev\gh\labview-icon-editor\icon-editor-developer.vipc` for each LabVIEW 2026 Q3 bitness you intend to run
  (32-bit and/or 64-bit). Do not benchmark it as provisioned until those VIPC dependencies succeed. When a
  LabVIEW CLI operation (such as VI Analyzer) cold-launches LabVIEW and fails with `-350000`
  ("failed to establish a connection with LabVIEW"), the VI Server TCP port does not match: the CLI defaults to
  port **3363**, so pass the matching `-LabVIEWPath <the intended bitness>` and `-PortNumber 3363` (or enable
  VI Server / align `server.tcp.port` in that LabVIEW's `.ini`).
- **FFmpeg capture prerequisite.** **Capture LabVIEW Launch** uses FFmpeg `gdigrab`. On a fresh machine, choose
  **Install ffmpeg (winget)** when prompted and let the install finish, then fully close every VS Code window
  and reopen VS Code before running the capture again. The extension host can retain its pre-install
  environment; without a full restart it can show the install prompt again even though FFmpeg is present. Do
  not reinstall repeatedly. If the winget install failed or was cancelled, choose **Retry ffmpeg setup...**;
  otherwise restart VS Code. If restart is undesirable, set `labviewBenchmarkActor.ffmpegPath` explicitly to
  the installed `ffmpeg.exe`.
- **Docker engine.** Windows containers require Docker Desktop's **Windows** engine (Hyper-V isolation); Linux
  containers require its **Linux** engine — you switch between them, they are not both active at once. On
  Hyper-V Windows containers, `docker run -p` port publishing can fail with `hnsCall ... 0x490`; reach the
  container directly at its NAT IP (`docker inspect`) instead.
- **Paths & line endings.** Prefer the extension commands over hard-coded paths. Windows uses `\`, but
  normalize to `/` before computing any cross-plane digest so a `resultHash`/`seriesHash` matches Linux. This
  file is stored with **LF**; the drift check canonicalizes CRLF→LF, so a Windows checkout never false-drifts.
  Watch for 8.3 short paths under `%TEMP%` when stripping path prefixes.
- **Remote / WSL.** The **Write / Check Agent Instructions** commands use the VS Code workspace filesystem API,
  so they work in WSL, Remote-SSH, and virtual workspaces, not just local disk.

---

Materialize with **"LabVIEW Benchmark Actor: Write Agent Instructions"**; verify with **"LabVIEW Benchmark
Actor: Check Agent Instructions"**. This file's version and integrity hash live in `agents.manifest.json`.
