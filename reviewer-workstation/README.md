# Reviewer workstation (#108)

A Windows 11 + LabVIEW 2026 VM where an **expert human reviewer** operates the
`labview-benchmark-actor` VS Code extension and the embedded `AGENTS.md`, then works
through [docs/testing/reviewer-manual-test-plan.md](../docs/testing/reviewer-manual-test-plan.md).

It **repurposes the maintainer-held golden box** (Windows 11 + LabVIEW 2026 + VS Code + Node +
git + LabVIEW fixtures + boot-time WinRM self-heal) and adds only the `labview-benchmark-actor`
bits — the extension `.vsix` (from the gated `ext-v*` Release), the `lbabus` CLI (from the
`collab-cli-v*` Release), and a scratch workspace.

## Providers

Dual-provider by design; pick the one that matches your host. Each provider uses its own
maintainer-held Windows + LabVIEW box (there is **no public LabVIEW box** — licensing):

| Provider | Host lane | Default box | Override |
| --- | --- | --- | --- |
| `virtualbox` | Linux/Ubuntu (LINUX lane; validated here) | `actor/win11-labview2026` | `VIHS_REVIEWER_BOX` |
| `vmware_desktop` | Windows/VMware (WIN lane) | `vihs/labview-cleanroom` | `VIHS_REVIEWER_BOX_VMWARE` |

Reviewers **without** a box build one per the golden-box docs (bring your own **licensed**
LabVIEW, required for the end-to-end LabVIEW case TC-09) and register it under the name above,
or point the override env var at their own box.

The local VirtualBox package is Vagrant-ready but not preactivated. NI
activation from the source VM did not transfer when Vagrant assigned a new
hardware UUID. Every imported VM therefore requires its own NI-supported
activation before TC-09 or an activated-IDE benchmark. The verified local
registration currently lives under `VAGRANT_HOME=D:\vagrant-home`; see
[the committed VM substrate decision](../experiments/windows-docker-container/decisions/windows-vm-substrate-decision.json).
The large machine-local consumer evidence remains ignored by design.

## Bring the box up

```sh
# VirtualBox (Linux host)
VAGRANT_CWD=reviewer-workstation vagrant up --provider virtualbox

# VirtualBox (Windows host, verified local box store)
$env:VAGRANT_HOME = 'D:\vagrant-home'
$env:VAGRANT_CWD = (Resolve-Path .\reviewer-workstation).Path
vagrant up --provider virtualbox

# VMware (Windows host)
VAGRANT_CWD=reviewer-workstation vagrant up --provider vmware_desktop
```

For a box-only smoke test with no private release downloads or provisioning,
append `--no-provision`. Complete NI activation inside that disposable VM
before attempting LabVIEW capture.

### Reuse the retained activated local reviewer

This worktree has one verified local cache whose activation remains tied to its
exact VirtualBox UUID. It is powered off when idle:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\reviewer-cache.ps1 `
  -Action Status

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\reviewer-cache.ps1 `
  -Action Resume
```

The retained VM is `actor-reviewer-local`, UUID
`f296a95b-7470-496a-bab7-791c973efd37`, with local VSIX `1.3.0` installed in
the interactive profile. Its state is isolated under
`D:\lba-vagrant-instances\actor-reviewer-local`, while its VirtualBox VM files
live under `D:\VirtualBox VMs\actor-reviewer-local`.

Do not run `vagrant destroy` against this cache: reimporting the box creates a
new hardware UUID and NI activation must then be completed again. After every
resume or snapshot restore, re-probe activation before relying on the cached
state.

The first offline review found two issues: missing FFmpeg restart/duplicate
install guidance and a stale global MCP reset-command name. Both were
remediated. The superseding offline reviewer verdict is **PASS**:

- TC-00/01/02/03/06/08/09/10 passed;
- TC-04/05/07/11 were not run because network/auth dependencies were excluded.

AGENTS.md `0.3.1` now documents the capture/restart flow, same-session capture
attempts cannot trigger duplicate FFmpeg installs, and TC-10 uses
**MCP: List Servers** → **LabVIEW Benchmark Actor: MCP tools** → **Restart
Server**, followed by a full VS Code restart.

Superseding evidence is under
`experiments/windows-docker-container/evidence/reviewer-cache-resume-20260807T202743398Z-cb1a928f/`.
The historical FAIL remains under
`experiments/windows-docker-container/evidence/reviewer-cache-resume-20260807T193416615Z-eac6c074/`.

Post-review feedback is staged in the current cache as AGENTS.md `0.3.2` /
VSIX SHA-256
`48074c046a03b69d1c83d5608ecc40560074059d69fab3668cb92adeb6e3fb03`.
The FFmpeg restart guard now permits explicit setup retry after a failed or
cancelled install without allowing accidental duplicate installation. Evidence
and the current snapshot are under
`experiments/windows-docker-container/evidence/reviewer-cache-resume-20260807T213425759Z-13591007/`.

Then, inside the guest, open the scratch workspace in VS Code (the extension is already installed):

```powershell
code C:\lba-review
```

Follow [docs/testing/reviewer-manual-test-plan.md](../docs/testing/reviewer-manual-test-plan.md)
from the Command Palette (`Ctrl+Shift+P` → `LabVIEW Benchmark Actor: ...`). The bus and
capabilities commands require `gh auth login` first (reviewer-supplied).

## Continuation host readiness

Use the maintained continuation-host readiness command from the clean continuation branch to probe the live host, verify the canonical AGENTS materialization, run the governed gates/KPI, and emit a deterministic receipt under `.lba/continuation/readiness.json`:

```powershell
node reviewer-workstation/continuation-readiness.mjs
node reviewer-workstation/continuation-readiness.mjs --check
```

The default command writes the receipt atomically; `--check` validates the existing receipt against the current repository and host state and fails nonzero on drift. If you are about to run a future full candidate KPI, delete the local root `AGENTS.md` artifact first so the KPI starts from the clean, non-materialized state that the canonical release contract expects.

## Stage a LOCAL candidate (pre-publish last gate)

`provision.ps1` installs a **published** `ext-v*` release. To review the **pre-publish candidate**
built from the current working tree — so a human is the last gate **before** anything reaches the
VS Code Marketplace — use [stage-local-vsix.ps1](stage-local-vsix.ps1) against an already-running VM:

```powershell
# VM already up (vagrant up ...), then from the repo root on the host:
pwsh -File reviewer-workstation/stage-local-vsix.ps1
# or install a prebuilt .vsix without rebuilding:
pwsh -File reviewer-workstation/stage-local-vsix.ps1 -SkipBuild -Vsix .\labview-benchmark-actor.vsix
```

It builds + packages the candidate (`npm test` + `vsce package`), **guards the `.vsix` size** (a fat
`.vsix` means `.vscodeignore` leaked non-runtime content such as the VM disk under `.vagrant/`),
`vagrant upload`s it, installs it with `code --install-extension --force`, verifies the `id@version`
by listing extensions, and drops `C:\lba-review\REVIEW-CHECKLIST.txt` for the reviewer. Then open VS
Code in the VM and inspect the Extensions-view README page (the Marketplace listing), the command
surface, and the benchmark viewer. Nothing is published until the reviewer approves.

### Stage an exact candidate on Ubuntu 24.04

The governed Ubuntu visual-review lane uses a fresh graphical Ubuntu 24.04 VM built from the stock
ISO. Provision LabVIEW without activation, let the operator activate in the VM console, and then copy
the exact candidate VSIX, `review-target.json`, repository checkout, and fresh version-scoped visual
private key into the disposable guest. Inside the guest run:

```bash
node reviewer-workstation/stage-ubuntu-vsix.mjs \
  --vsix /home/actor/lba-review/labview-benchmark-actor.vsix \
  --target /home/actor/lba-review/review-target.json \
  --kpi /home/actor/lba-review/local-kpi.json \
  --workspace /home/actor/lba-review/workspace \
  --receipt /home/actor/lba-review/ubuntu-review-stage.json \
  --handoff "$HOME/.config/Code/User/globalStorage/svelderrainruiz.labview-benchmark-actor/handoff" \
  --vm-provider oracle \
  --vm-id '<host-observed /etc/machine-id>'
```

The command runs only on Linux and binds the candidate's version, 40-hex commit, 64-hex SHA-256, and
bytes to a passing full local-KPI receipt, then verifies the VSIX manifest **before** installing
anything. It then installs with `code --install-extension --force`,
requires the exact `svelderrainruiz.labview-benchmark-actor@<version>` identity, writes a non-secret
receipt with wall and monotonic timing, and atomically stages the exact target plus a target-bound
`UBUNTU_VM` marker where the extension reads them. The marker is emitted only after
`systemd-detect-virt --vm`, `/etc/machine-id`, and the DMI product name prove the expected
VirtualBox guest identity; physical Ubuntu, WSL, containers, and a different VM fail closed. Follow
[the manual plan](../docs/testing/reviewer-manual-test-plan.md), then use **LabVIEW Benchmark Actor:
Render Reviewer Verdict** inside VS Code. Linux verdict rendering fails closed without the staging
marker or when the marker's provider/product/machine-id differs from the current host; it no longer
infers `UBUNTU_VM` from the operating system alone.

Extract the public record and raw non-secret review evidence before deleting the VM and private key.
The quorum key is distinct and is used only for the later machine-quorum sign-off.

## Validate a release on the WIN plane (auth-free, native Windows)

The bidirectional release-agreement gate
([tools/collab-cli/verify-release-agreement.mjs](../tools/collab-cli/verify-release-agreement.mjs)) needs an
independent **WIN-plane** build/test pass before an `ext-v*` can publish. Run it in the reviewer VM straight
from the host with [win-plane-validate.sh](win-plane-validate.sh):

```sh
# VM already up; from the repo root on the host:
LBA_VM_PASS='<guest-password>' reviewer-workstation/win-plane-validate.sh release/1.0.0
```

It bundles the branch on the host (`git bundle` — **auth-free**, since the private repo cannot be
`gh repo clone`d from the credential-less guest), stages it into the VM, and runs
[win-plane-validate.ps1](win-plane-validate.ps1) there: `npm ci`, a **per-suite** test matrix (each suite run
individually, since the packaged `npm test` `&&` chain stops at the first fail), a **masked-activation**
re-run, and the packaging gate (`agent-last-gate --skip-tests`). It prints a `WINPLANE_JSON` receipt with a
`winPlaneReady` verdict to paste into the release-agreement WIN sign-off.

**The one expected non-green suite on a real-LabVIEW host** is `extension-activation`: its
`captureLaunch surfaces the LabVIEW-not-found guard` assertion is written for the LabVIEW-less Linux CI host,
but the reviewer VM *has* LabVIEW installed, so the guard correctly does not fire. The masked-activation
re-run loads [labview-mask.cjs](labview-mask.cjs) via `node --require` to mask **only** the two `LabVIEW.exe`
candidate paths in `fs.existsSync` (no repo/source/test change), reproducing the LabVIEW-less condition — the
activation suite then passes fully. `winPlaneReady` is `true` when every suite except `extension-activation`
is green, masked activation passes, and the packaging gate passes.

> **Guest gotcha:** `npm` resolves to `npm.ps1`, which the guest PowerShell ExecutionPolicy blocks; the
> validator routes every npm/node call through `cmd /c` (npm.cmd) and must itself be launched with
> `-ExecutionPolicy Bypass` (the driver does this for you).

## Drive it from a Copilot agent (in the VM)

Once the extension is installed in the VM, open VS Code there. The **Get started with LabVIEW Benchmark
Actor** walkthrough opens automatically (or: `Ctrl+Shift+P` → `Welcome: Open Walkthrough...`), and every
panel is under `Ctrl+Shift+P` → `LabVIEW Benchmark Actor: Open ...`.

To review it the **agentic** way, open **Copilot Chat → Agent** mode in the VM and paste:

> Use the LabVIEW Benchmark Actor tools: call #lbaBenchmarkSummary to summarize the captured benchmark
> numbers, then use #lbaBenchmarkPanel to open the trend, the frame correlator, and the cross-plane
> resource agreement panels, and explain what each one shows.

The agent calls the extension's language-model tools — `lba-benchmark-summary` (the real launchMs / trend /
cross-plane / resource numbers) and `lba-open-benchmark-panel` (opens `run` | `trend` | `frameCorrelator` |
`crossPlaneTrend` | `resourceProfile` | `crossPlaneResource`) — so the panels open and the agent explains
them without any menu hunting.

## Configuration (env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `LBA_VM_NAME` | `actor` | VM name shown in VirtualBox / VMware. Set a unique value to run **multiple** reviewer instances side by side. |
| `LBA_VM_HOSTNAME` | = `LBA_VM_NAME` | Guest Windows hostname, sanitized to NetBIOS rules (`<=15` chars, `[A-Za-z0-9-]`). |
| `VIHS_REVIEWER_BOX` | `actor/win11-labview2026` | VirtualBox box name. |
| `VIHS_REVIEWER_BOX_VMWARE` | `vihs/labview-cleanroom` | VMware box name. |
| `VIHS_REVIEWER_MEM` | `8192` | Guest memory (MB). |
| `VIHS_REVIEWER_CPUS` | `4` | Guest vCPUs. |
| `VIHS_REVIEWER_REPO` | `LabVIEW-Community-CI-CD/labview-benchmark-actor` | Release source for the `.vsix` + `lbabus`. |
| `VIHS_REVIEWER_EXT_TAG` | `latest` | `ext-v*` tag to install (`latest` = newest gated release). |
| `VIHS_REVIEWER_LBABUS_TAG` | `latest` | `collab-cli-v*` tag to install (`latest` = newest release). |
| `VAGRANT_HOME` | Vagrant default | Box store. The verified local VirtualBox registration is in `D:\vagrant-home`. |

## What provisioning does

[provision.ps1](provision.ps1) (WinRM, privileged) is additive on top of the golden box:

1. Ensures `code` (VS Code) and `gh` are on `PATH`, winget-installing them when the box lacks
   them (the VirtualBox golden box ships them; the VMware cleanroom box and BYO boxes may not).
2. Downloads and installs the extension `.vsix` from the resolved `ext-v*` Release **into the
   interactive console user's VS Code profile** (resolved from its SID), so the human reviewer — who
   logs in interactively, not as the WinRM `vagrant` provisioning user — actually sees it (#121).
3. Downloads the self-contained `lbabus` (`*win-x64.exe`) from the resolved `collab-cli-v*`
   Release into `C:\lba-bin` and adds it to the machine `PATH`.
4. Creates the `C:\lba-review` scratch workspace.

Re-running is safe (downloads use `--clobber`; installs use `--force`).

## Lane ownership

The `virtualbox` provider block and this README are validated on the **LINUX** lane. The
`vmware_desktop` provider block and the real WinRM run of `provision.ps1` are owned and validated
on the **WIN** lane. See #108.
