# Windows Docker + TightVNC + MPRR experiment

This local-only experiment tests whether TightVNC application mode can expose the
same Windows-container desktop on which the LabVIEW 2026 IDE renders. It uses the
repository's plane-neutral RFB client, dHash-64 fingerprinting, settle detector,
PNG encoder/decoder, workload record, and MPRR dual-packet assembler.

The script fails closed. A running `LabVIEW.exe` process is not a passing result.
Outcomes before a process-matched LabVIEW window is observed in changing RFB
pixels are written as `inconclusive` with a nonzero exit code.

## Prerequisites

- Windows host with Docker running in Windows-container mode.
- Local image `nationalinstruments/labview:2026q3-windows`.
- The expected immutable image ID:
  `sha256:f45c639a201f51875465a0d02aa69e65a3630054e564c8724c105f2e1b5eee30`.
- Node.js available as `node`.
- .NET 8 SDK available as `dotnet`. The host publishes the repository's
  `lbabus` project into the ephemeral read-only container mount; the pinned image
  already contains the .NET 8 runtime.
- Windows PowerShell 5.1 or PowerShell 7.
- Enough free space for the disposable container and run evidence.
- LabVIEW must already be installed in the image. This experiment does not
  install, activate, or accept licensing terms for LabVIEW.

TightVNC is pinned to 2.8.81. The official installer URL is:

`https://www.tightvnc.com/download/2.8.81/tightvnc-2.8.81-gpl-setup-64bit.msi`

Pinned SHA-256:

`0d6402e530a563c90040d7c07b98ab68670d3669e4cc573ad24056ff960c9dcb`

TightVNC does not publish an official checksum manifest. This hash was computed
from the versioned installer fetched over HTTPS directly from `tightvnc.com` and
is documented and enforced here. A local cached installer is preferred.

## Usage

With a verified local installer:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\run-experiment.ps1 `
  -TightVncInstaller C:\path\to\tightvnc-2.8.81-gpl-setup-64bit.msi
```

Without `-TightVncInstaller`, the container downloads only the pinned official
HTTPS URL and verifies the same SHA-256 before execution:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\run-experiment.ps1
```

Defaults are process isolation, the inherited container GUI context, TightVNC's
standard GDI driver, 12 fps, a 60-second post-trigger capture, the existing
settle window of 8 frames, and dHash Hamming tolerance 2.

The console is intentionally verbose. Timestamped lines expose Docker command
boundaries, `lbabus` publication and in-container capabilities, desktop/display
diagnostics, TightVNC readiness, relay endpoints, RFB negotiation, sampled frame
dimensions/update counts, retained image hashes, and cleanup. Secret values are
never printed.

Useful experiment controls:

```powershell
.\experiments\windows-docker-container\run-experiment.ps1 `
  -CaptureDurationSeconds 90 -RfbTimeoutSeconds 45 `
  -LaunchWindowTimeoutSeconds 90 -LaunchAliveSeconds 10 `
  -DesktopTarget Inherited -TightVncCaptureMode StandardGdi
```

If the bounded LabVIEW launch check lasts longer than the requested capture
duration, capture remains active until that check completes; the actual duration
is recorded separately.

`-AllowUnexpectedImageId` is the explicit image-ID override. It never changes
the required image reference, and the resolved ID and override are recorded in
evidence. Do not use it without approving the local image difference.

`-DesktopTarget Inherited` leaves the container's process window station and
thread desktop unchanged, resolves their live names, and launches TightVNC, the
probe, and LabVIEW with `STARTUPINFO.lpDesktop = null`. `-DesktopTarget WinSta0`
preserves the earlier explicit `WinSta0\\Default` diagnostic baseline.

`-TightVncCaptureMode D3d` is a bounded variant for the same selected desktop;
it is justified only when local GDI is non-black but standard-GDI RFB remains
black. `-AssignGpuDevice` adds Docker's process-scoped Microsoft display-device
class assignment. It is absent by default and should be tested only as a
single-variable A/B after an inherited no-device failure.

## Proof gates

1. Docker reports `OSType=windows`, the exact local image is `windows/amd64`,
   its ID is accepted, and a process-isolated smoke container exits.
2. TightVNC 2.8.81 installs server-only without a service or firewall change,
   remains alive, and listens on container port 5900. Before TightVNC starts,
   the selected GUI context must expose a screen DC, at least one
   `EnumDisplayMonitors` rectangle, nondegenerate screen metrics, and a non-black
   local GDI capture of the deterministic probe. Docker publishes no port.
   The host freshly inspects the run-owned container's Windows NAT IPv4 address,
   proves direct private-network reachability, and starts an in-process TCP relay
   on an OS-assigned `127.0.0.1` port. Gate 2 passes only after the RFB client
   traverses that relay with nonzero byte counts in both directions.

Container-side readiness uses a bounded local TCP connection to
`127.0.0.1:5900`; `Get-NetTCPConnection` can return no rows in this Windows
container even when TightVNC's own log reports a successful bind. The later host
private-network probe independently proves the listener is reachable off-box.

Before host capture, the bootstrap compiles a tiny built-in .NET Windows Forms
probe and launches its run-owned window titled
`LBA-VNC-DESKTOP-PROBE` on `WinSta0\\Default`. This deterministic, non-secret
marker makes an empty black desktop distinguishable from a capture path that
cannot see desktop pixels. It is stopped during bootstrap cleanup and is not
used as LabVIEW-visibility evidence. If the process cannot produce a visible
window, bootstrap records that fact but lets the RFB pixel proof classify Gate 3.
3. The existing RFB stack negotiates authentication, receives a full nonzero
   framebuffer, and the initial frame is non-black/non-uniform. Its known probe
   ROI must match the local GDI probe ROI by dHash and quantized color histogram.
   The probe is then stopped before LabVIEW timing starts.
4. LabVIEW remains alive, a visible process-matched `LabVIEW` window is
   enumerated on `WinSta0\Default`, and that window's framebuffer region is
   non-uniform and changes from the pre-launch frame.
5. The existing settle detector passes without relaxed thresholds, `launchMs`
   is positive, resource samples exist, and benchmark/MPRR records verify.
6. Logs and inspection data are retained, the exact labeled container is
   removed, the loopback relay listener is closed, and ephemeral password
   material is deleted.

The Gate 4 pixel/window-region proof is intentionally narrow. If the window
cannot be matched reliably, the run is `inconclusive`; it is never promoted from
a process-only observation.

## Output

Each run writes an ignored directory:

`experiments/windows-docker-container/evidence/<run-id>/`

A passing run contains:

- `host-orchestration.log`
- `container.log`
- `docker-info.json`, `image-inspect.json`, `container-inspect.json`
- `environment.json`, `bootstrap-ready.json`, `launch-diagnostics.json`
- `display-diagnostics.json`, `local-gdi-capture.png`, `probe-stopped.json`
- `container-inspect-pre-relay.json`, `network-preflight.json`,
  `network-relay.json`
- `launch-trigger.json`, `capture-summary.json`
- `benchmark.json` (`boot-benchmark-v1`)
- `launch-capture.json` (`launch-capture@1`, including every short packet)
- `resource-samples.json`
- `frames/initial-*.png`, `frames/transition-*.png`, `frames/settled-*.png`
- `cleanup-verification.json`
- `manifest.json`

Long-packet capacity affects representative PNG admission only. Every sampled
short packet remains in `launch-capture.json`, even when a long screenshot is
absent. Resource samples distinguish host-observed Docker stats from
in-container CIM data and use nearest-sample alignment without interpolation.

An unsuccessful run contains `failure-receipt.json` with the failed gate,
classification, diagnostics, image provenance, and cleanup receipt. Early
platform failures may not have framebuffer or benchmark files.

A transport-only run also retains:

- `lbabus-host-stage.json` and `lbabus-container.json`, proving the exact
  repository-built `lbabus` payload executed inside the container;
- `container-debug.log`, the container-side verbose trace streamed into the
  host console;
- `frames/transport-baseline-rfb.png`, the PNG encoded from bytes received from
  the run-owned container's TightVNC RFB endpoint.

That diagnostic PNG is verified by size, PNG SHA-256, decoded-RGBA SHA-256,
negotiated dimensions, update count, source container ID, private upstream
endpoint, and loopback relay endpoint. If its pixels are black or uniform it is
recorded as `usable=false` and `visualClaim=false`; retaining a valid PNG does
not turn it into LabVIEW or interactive-desktop evidence.

## Validation

Deterministic checks:

```powershell
node .\experiments\windows-docker-container\experiment-core.selftest.mjs
node .\experiments\windows-docker-container\tcp-relay.selftest.mjs
node .\experiments\windows-docker-container\verify-evidence.selftest.mjs
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\orchestration-core.selftest.ps1
node .\experiments\mprr-capture-ring\vmware-vnc-source.selftest.mjs
node .\experiments\mprr-capture-ring\vbox-vnc-source.selftest.mjs
node .\experiments\mprr-capture-ring\fiducial-capture.selftest.mjs
node .\experiments\mprr-capture-ring\verify-workload-benchmark.mjs
node .\experiments\mprr-capture-ring\verify-launch-capture.mjs
```

Re-verify an existing evidence directory:

```powershell
node .\experiments\windows-docker-container\verify-evidence.mjs `
  --verify .\experiments\windows-docker-container\evidence\<run-id>
```

The verifier parses all JSON, checks manifest sizes and SHA-256 hashes, decodes
PNGs, validates dimensions and pixel populations, recomputes the settled
fingerprint, checks monotonic frame indices/times and `launchMs`, self-diffs the
workload record, checks desktop/display/local-GDI/probe-relay evidence, and
requires successful cleanup evidence.

## Security posture

- Docker publishes no VNC port. A process-local Node relay requests port `0` and
  binds explicitly to IPv4 `127.0.0.1`; it forwards only to the freshly
  re-inspected run-owned container IP on port 5900.
- VNC authentication remains enabled.
- The eight-character VNC secret is generated per run, stored only in a
  restricted temporary mount, never printed, and removed during cleanup.
- `lbabus` is used in-container only for version and capability evidence. No
  bus listener is opened, no coordination message is sent, and image bytes
  remain in the run evidence mount.
- Application-mode password encoding and registry names are taken from the
  official TightVNC 2.8.81 GPL source (`VncPassCrypt.cpp`,
  `Configurator.cpp`, and `NamingDefs.cpp`).
- The MSI installs only the server feature, does not register a service, does
  not add a firewall exception, and disables file transfer.
- TightVNC 2.8.81 application mode refuses to start while its HKLM
  `Server\\ServiceOnly` marker exists. If the server-only MSI leaves that marker,
  the bootstrap records and removes only that key inside the disposable
  container after proving no TightVNC service exists.
- No Docker engine pipe, public tunnel, remote forwarding, host firewall
  change, HNS change, `portproxy`, service, scheduled task, external upload, or
  host-wide cleanup is used.
- Only the container carrying the current run's ownership label is stopped or
  removed.
- Dynamic service-window-station names are obtained through
  `GetProcessWindowStation`, `GetThreadDesktop`, and
  `GetUserObjectInformation(UOI_NAME)` and are recorded as data. They are never
  hardcoded or interpolated into a shell command.

## Cleanup

Cleanup runs from `finally` after both passing and failing captures. The host
first preserves `docker logs` and inspection metadata, requests a graceful
bootstrap stop so the encrypted registry password is removed, then removes the
exact run-owned container. It verifies that the container no longer exists and
that the relay listener is absent. The relay runs in the capture process, tracks
all active socket pairs, destroys them during bounded shutdown, closes its
server, and records an empty post-close listener query.
The bootstrap also records removal of the exact probe process/executable,
downloaded installer, and encrypted password value.

If the host process itself is terminated before `finally`, inspect the label
before any manual action:

```powershell
docker container inspect <container-name> `
  --format '{{index .Config.Labels "org.labview-benchmark-actor.windows-docker-run"}}'
```

Remove only the container whose label equals the run ID in its evidence path.

## Troubleshooting

- **Docker reports Linux mode:** switch Docker Desktop to Windows containers.
  The run stops at Gate 1 without creating the experiment container.
- **Image missing or ID mismatch:** load the verified local image. The script
  does not pull, retag, rebuild, or substitute an image.
- **Installer hash mismatch:** discard the installer. Do not bypass the pinned
  hash or use a mirror.
- **Container network target unavailable:** inspect
  `container-inspect-pre-relay.json` and `network-preflight.json`. Exactly one
  usable IPv4 target is required; `nat` is the deterministic choice when the
  container has multiple attachments.
- **Private route unavailable:** `network-preflight.json` records the bounded
  host probe to `<container-ip>:5900`. Inspect Docker/HNS state read-only before
  considering any approved host change.
- **Relay failure:** inspect `network-relay.json` for the exact loopback bind,
  current upstream, listener ownership, connection failures, byte counts, and
  cleanup. The script never falls back to Docker publication or a non-loopback
  listener.
- **RFB timeout/authentication failure:** check TightVNC liveness, port evidence,
  and RFB security metadata in `failure-receipt.json`.
- **Black or uniform framebuffer:** this is a Gate 3 result, not a screenshot
  success. Review `display-diagnostics.json` first:
  - `desktop-has-zero-displays`: selected context has no monitor surface;
  - `desktop-screen-dc-unavailable`: `GetDC(NULL)` failed;
  - `desktop-local-gdi-capture-black`: monitor metadata exists but GDI cannot
    read composed pixels;
  - `rfb-black-despite-local-gdi`: local GDI works and TightVNC is the remaining
    layer;
  - `rfb-probe-mismatch`: RFB is non-black but does not contain the known probe.
- **LabVIEW process without a matching window:** inspect
  `launch-diagnostics.json` for activation, licensing, first-run, or desktop
  blockers. The experiment does not answer prompts.
- **UI never settles:** increase capture duration, not the settle tolerance.

## Known Windows-container GUI limitations

Windows process-isolated containers commonly run in session 0 without a normal
interactively composited desktop. The default test keeps the inherited dynamic
service window station instead of assuming `WinSta0\\Default`. Both child
session IDs and process-matched windows are verified on the resolved desktop.

In the explicit `WinSta0` baseline, PowerShell can already own GUI resources
before bootstrap code runs, causing
`SetThreadDesktop` to return `ERROR_BUSY` (170). The experiment records that
result rather than treating it as a successful thread attach. TightVNC and
LabVIEW are launched with `CreateProcess` and an explicit
`STARTUPINFO.lpDesktop = "WinSta0\\Default"`, then validated by process-matched
window enumeration on that desktop.

TightVNC's official documentation does not claim support for Windows containers
or session-0 capture. Application-mode MSI settings are not supported directly,
so the experiment configures HKCU values using TightVNC's official GPL source
as the authority. If application mode cannot expose a real framebuffer, the
run stops as `inconclusive`; it does not register a service, capture the host
desktop, fabricate frames, or treat a launched process as visible UI.

Standard-GDI mode disables TightVNC's D3D/Desktop Duplication and mirror
drivers. Desktop Duplication can
initialize in a Windows container while returning only black pixels; using the
standard driver is the narrow capture-method correction for this experiment,
not a weakened pixel acceptance threshold.

The earlier baseline proved that a probe window can be enumerated on
`WinSta0\\Default` while that context has zero displays and both Desktop
Duplication and standard GDI produce a
uniformly black RFB framebuffer, the run is `inconclusive` at Gate 3. This is
evidence of the Windows-container session/display limitation, not permission to
substitute a host-desktop capture or weaken the pixel proof.

## Display diagnostics and capture matrix

`display-diagnostics.json` records the bootstrap PID/session, resolved station
and desktop, `SM_CMONITORS`, primary and virtual metrics, `GetDC(NULL)`,
`EnumDisplayMonitors` rectangles, screen-DC depth, `EnumDisplayDevices` flags
and current modes, `QueryDisplayConfig` status/counts, and CIM video/monitor
identity. Empty API results are failures, not success-shaped defaults.

The local control image is captured with
`GetDC(NULL) + BitBlt(SRCCOPY|CAPTUREBLT) + GetDIBits`. The host re-decodes that
PNG using the repository decoder and applies the same luminance-population
rules. Passing local pixels do not imply RFB success.

The bounded matrix is:

1. `Inherited + StandardGdi`, no GPU device;
2. only if local GDI passes but RFB is black: `Inherited + D3d`;
3. only if a no-device inherited run fails and a device A/B is justified:
   repeat one mode with `-AssignGpuDevice`.

The experiment does not install an obsolete mirror driver.

On the verified 2026-08-07 host, inherited no-device and process-scoped GPU
device A/B runs both reported `SM_CMONITORS=1` and `1024x768` metrics but zero
`EnumDisplayMonitors(GetDC(NULL))` rectangles, zero active display-config paths,
and `QueryDisplayConfig=ERROR_ACCESS_DENIED (5)`. The probe process/window
object existed on the dynamic inherited station but was not visible, and local
`BitBlt` failed with `ERROR_ACCESS_DENIED (5)`. The bootstrap therefore stopped
before TightVNC/RFB as `desktop-has-zero-displays`; changing TightVNC drivers
cannot address a display surface that fails before TightVNC starts.

## Formal Windows-container GUI feasibility closure

The machine-readable closure is
[decisions/windows-container-gui-feasibility.json](decisions/windows-container-gui-feasibility.json),
schema `labview-benchmark-actor/windows-container-gui-feasibility@1`.
Regenerate and verify it with:

```powershell
node .\experiments\windows-docker-container\build-feasibility-receipt.mjs `
  --hyperv-run .\experiments\windows-docker-container\evidence\<formal-hyperv-probe> `
  --output .\experiments\windows-docker-container\decisions\windows-container-gui-feasibility.json
node .\experiments\windows-docker-container\verify-feasibility-receipt.mjs `
  .\experiments\windows-docker-container\decisions\windows-container-gui-feasibility.json
```

It preserves four independently verifiable rows:

| Variant | Display/composition result | TightVNC/RFB result |
| --- | --- | --- |
| Process + `WinSta0` + standard GDI | TightVNC reported zero displays | Authenticated RFB/relay proven; framebuffer uniformly black |
| Process + inherited + no device | Zero monitor rectangles/active paths; probe not visible; `BitBlt=ACCESS_DENIED` | Not started after display precondition failed |
| Process + inherited + DirectX GPU class | Zero monitor rectangles/devices/active paths | Not started after display precondition failed |
| Hyper-V + inherited + no device | Zero monitor rectangles/devices/paths; no video controller; local capture unavailable | Probe-only: no TightVNC, relay, or secret |

The aggregate decision is
`unsupported-by-windows-container-platform`. This does **not** mean the relay,
RFB client, TightVNC authentication, evidence model, or MPRR pipeline failed:
those are reusable proven components. It means a real LabVIEW visual benchmark
cannot satisfy its interactive-display precondition on the tested Windows
container substrates.

Historical run receipts remain `inconclusive` and are never rewritten. The
aggregate closure adds the platform-support decision without changing them.

### Microsoft support basis

- [Lift and shift to containers](https://learn.microsoft.com/en-us/virtualization/windowscontainers/quick-start/lift-shift-to-containers)
  states that Windows containers support server-side applications that do not
  require an interactive session, applications requiring a desktop cannot be
  moved because containers do not support GUI, and RDP is unsupported because
  it requires an interactive session.
- [Devices in Windows containers](https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/hardware-devices-in-containers)
  lists supported device classes, warns that unlisted GUIDs have undefined
  behavior, and states device sharing is unsupported for Hyper-V-isolated
  Windows containers. Monitor/display-path assignment is not listed.
- [GPU acceleration in Windows containers](https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/gpu-acceleration)
  supports DirectX acceleration for process-isolated Windows containers; it
  does not create or promise an interactive monitor/display path and explicitly
  excludes Hyper-V-isolated containers.
- [Indirect Display Driver model](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview)
  describes a third-party host Session-0 UMDF display driver, not a supported
  method to expose a host interactive display path inside a Windows container.
- Microsoft's [Indirect Display sample](https://github.com/microsoft/Windows-driver-samples/tree/main/video/IndirectDisplay)
  says the sample is simplistic, contains production-critical TODOs, and
  requires INF customization. It is not installed by this experiment.

**Stop condition:** do not retry Windows-container GUI/display variants unless
new authoritative Microsoft or vendor documentation explicitly supports an
interactive display path inside the container session. Do not install a
speculative virtual-display driver, share an undocumented display GUID, enable
test-signing, or change Secure Boot.

## CI-safe TightVNC/RFB transport replay

The platform-negative display result does not prevent deterministic CI
benchmarking of the proven transport layer. The committed replay receipt is
[decisions/windows-container-rfb-transport-replay.json](decisions/windows-container-rfb-transport-replay.json),
schema `labview-benchmark-actor/windows-container-rfb-transport-replay@1`.

Build and verify it without Docker, Windows, a VNC listener, or a secret:

```powershell
node .\experiments\windows-docker-container\build-transport-replay.mjs
node .\experiments\windows-docker-container\verify-transport-replay.mjs `
  .\experiments\windows-docker-container\decisions\windows-container-rfb-transport-replay.json
```

The replay hashes and re-derives the retained live transport-only evidence,
including the source-bound diagnostic PNG and in-container `lbabus` records,
then encodes six milestone-only MPRR capture-ring packets:

1. direct container-network probe complete;
2. loopback relay ready;
3. authenticated RFB traversed;
4. framebuffer classified;
5. relay closed;
6. cleanup proven.

The MPRR packets carry `dhash64=0`, encode **zero visual frames**, and use the
workload marker range (`milestoneId` 5–10). Their 100 ns ticks are reconstructed
from relative UTC evidence ordering for deterministic replay; they are not a
live monotonic performance authority. Only `directProbeMs` and
`relayCleanupMs` retain their original host-monotonic timing authority.

Current replay metrics:

- direct private-network probe: `1.4808 ms`;
- relay cleanup: `1.0411 ms`;
- authenticated RFB `3.8`, VNC security type `2`;
- relay bytes: `102` downstream-to-upstream and `6,291,575`
  upstream-to-downstream (`6,291,677` total);
- three RFB updates and 18 observed frame polls;
- uniformly black framebuffer, `blackFraction=1`;
- one retained, verified diagnostic RFB PNG with SHA-256
  `6ec227dca4c2663c781fed4748f9f10fedf7290bf7a8fffe2d4e05f81790e4cd`;
- retained MPRR visual frames, usable screenshots, fingerprints, `launchMs`,
  and visual settle metrics: **none**.

The benchmark outcome is
`transport-supported-framebuffer-unavailable`. It proves the relay, RFB
authentication, payload traversal, packet serialization, and cleanup. It
cannot be used to claim an interactive Windows-container desktop or a visual
LabVIEW benchmark.

### Live transport-only demonstration

`-TransportOnly` is an explicit `WinSta0` baseline mode. It bypasses only the
already-proven local display precondition, starts TightVNC, authenticates RFB,
captures enough baseline frames to classify the framebuffer, retains one
source-bound PNG decoded from the RFB stream, and then exits Gate 3 **before any
LabVIEW launch**:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\run-experiment.ps1 `
  -Isolation process `
  -DesktopTarget WinSta0 `
  -TightVncCaptureMode StandardGdi `
  -TransportOnly `
  -TightVncInstaller D:\lba-vm-assets\tightvnc-2.8.81-gpl-setup-64bit.msi
```

The expected script exit is nonzero because the required visual proof remains
unavailable. A valid transport demonstration has:

- `failedGate=3`, `classification=black-or-uniform-framebuffer`;
- authenticated RFB security type `2`;
- positive traffic in both relay directions;
- `transportOnly=true`, `labviewLaunchTriggered=false`;
- `frames/transport-baseline-rfb.png` is present and hash-verified against the
  exact source container/RFB/relay chain;
- `imageAcquisition.usable=false`, `imageAcquisition.visualClaim=false`, and
  `blackFraction=1` for the known zero-display baseline;
- the staged `lbabus` payload executes inside the container and detects
  `LabVIEWCLI`;
- container, relay, VNC listener, installer, and secret cleanup proven.

Live run `20260807T235142020Z-dfc7f09404` demonstrated this path on the exact
image. It ran `lbabus` 0.15.0 inside the container, negotiated RFB `3.8`/VNC
Authentication at `1024x768`, delivered `6,291,677` relay bytes, observed three
RFB updates and 18 frame polls, retained the 4,981-byte diagnostic PNG, encoded
zero replay visual frames, did not launch LabVIEW, and removed all run-owned
state. The PNG's decoded RGBA SHA-256 is
`d2cdb07798b599560e35abad5e4f87f4205ee60e72e14d850b9590f801080978`.
The image-bound replay SHA-256 is
`8737ce0f5e310d4952860d05452a0ccb355826925d9854edcea224b5450ea740`.

## Probe-only isolation evidence

[run-display-probe.ps1](run-display-probe.ps1) runs display diagnostics without
installing/starting TightVNC, generating a VNC secret, or starting the relay:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\run-display-probe.ps1 `
  -Isolation hyperv -DesktopTarget Inherited
```

Both the smoke container and evidence container receive the requested isolation
mode. Hyper-V plus device assignment is rejected before Docker execution.
Probe-only evidence is verified by [verify-display-probe.mjs](verify-display-probe.mjs).

## Supported full-Windows-VM pivot

The read-only host artifact is
[decisions/windows-vm-substrate-preflight.json](decisions/windows-vm-substrate-preflight.json),
schema `labview-benchmark-actor/windows-vm-substrate-preflight@1`:

```powershell
node .\experiments\windows-docker-container\vm-substrate-preflight.mjs
node .\experiments\windows-docker-container\verify-vm-substrate-preflight.mjs `
  .\experiments\windows-docker-container\decisions\windows-vm-substrate-preflight.json
```

Initial local result:

- VirtualBox `7.2.8` and Vagrant `2.4.9` were available.
- No Vagrant boxes were installed.
- The only pre-existing VirtualBox VM was a powered-off Ubuntu LabVIEW VM.
- Hyper-V PowerShell was installed, but VM management was not permitted to the
  current unelevated user.
- VMware `vmrun` was unavailable.

The recommended path is the existing
[reviewer-workstation/Vagrantfile](../../reviewer-workstation/Vagrantfile) with
the maintainer-held `actor/win11-labview2026` VirtualBox box. It provides a full
Windows 11 interactive session and reuses
[vbox-vnc-source.mjs](../mprr-capture-ring/vbox-vnc-source.mjs),
[win-vbox-labview-trend.mjs](../mprr-capture-ring/win-vbox-labview-trend.mjs),
the shared settle detector, and the existing MPRR record/resource pipeline.

The preflight itself downloads, imports, starts, and changes nothing.

The current decision is recorded in
[decisions/windows-vm-substrate-decision.json](decisions/windows-vm-substrate-decision.json).
The maintainer selected the recommended `actor/win11-labview2026` VirtualBox
path and authorized official Windows 11 Pro and NI LabVIEW 2026 Q3 Community
media/EULA automation. Activation has now been completed in the retained VM.

Provisioning produced the powered-off staging VM
`lba-win11-labview2026-build`:

- Windows 11 Pro 25H2 build `26200.8037`;
- VirtualBox Guest Additions `7.2.8`;
- `ni-labview-2026-community 26.3.0.49795-0+f643` x64, matching the official
  2026 Q3 container;
- TightVNC `2.8.81`.

The shared RFB client added standard `DesktopSize (-223)` negotiation because
TightVNC correctly reported one display but otherwise returned a blank
client-sized frame. After that fix, authenticated RFB captured real desktop and
LabVIEW pixels. The blocked activation run retained 1,089 frames, three unique
fingerprints, two visual transitions, 91 resource samples, and representative
PNG long packets:
[evidence/vm-20260807T122440763Z](evidence/vm-20260807T122440763Z).

That first governed VM run is preserved as a historical blocker:

- stable window: `NI License Manager Wizard`;
- outcome: `blocked / labview-activation-required`;
- evidence: [evidence/vm-20260807T122440763Z](evidence/vm-20260807T122440763Z).

[decisions/windows-vm-provisioning-receipt.json](decisions/windows-vm-provisioning-receipt.json)
records the VM/snapshot/media/package/capture/cleanup identities. The staging VM
retains snapshots `pre-labview-q3`, `labview-q3-installed-unactivated`, and
the new activated snapshot `labview-q3-activated`.

The activated governed capture is:
[evidence/vm-activation-20260807T133232933Z-80e478ed](evidence/vm-activation-20260807T133232933Z-80e478ed).
It passed with:

- authenticated TightVNC RFB `3.8`;
- framebuffer `955x1030`;
- `1092` frames;
- `22` unique fingerprints and `23` visual transitions;
- `launchMs = 82,884.4628`;
- settled activated IDE frame `1005`;
- finalized manifest SHA-256
  `f17b22d424cd962fc3f8eb4ac9a323463fef3b71b6aa028fb34aa2fdd06174fb`.

The resumed activation/package lifecycle is:
[evidence/vm-activation-20260807T133232933Z-80e478ed/vm-lifecycle.json](evidence/vm-activation-20260807T133232933Z-80e478ed/vm-lifecycle.json).
It is sealed complete through `BOX-REGISTERED`.

The source-VM activation is **not portable to a new VirtualBox hardware
identity**. A clean Vagrant consumer changed the hardware UUID from
`3e29a8af-ee1f-442f-8e28-2eaa07832786` to
`f5de7ff5-d858-4f0e-9bab-3b2e252926b5`; LabVIEW then correctly opened NI
License Manager. Do not claim that the registered box is preactivated, and do
not attempt to preserve/spoof a machine-bound identifier to bypass licensing.

The original package is retained only as rollback:

- `D:\lba-vm-assets\actor-win11-labview2026-20260807.box`
- SHA-256
  `3d7e0e8651d87b52b567d327b661347efcdbcca8bf6b6dc6bc2d2aa62bb8a5b6`

The registered Vagrant-ready package is:

- `D:\lba-vm-assets\actor-win11-labview2026-vagrant-ready-20260807.box`
- size `28,450,796,737` bytes
- SHA-256
  `225228f7385033545e57f61ab0fc90bb29c1337072e2bd18209af1aa0c859336`

It adds the public disposable `vagrant / Vagrant1234!` contract, WinRM
Negotiate transport, startup WinRM self-heal, and interactive auto-login. The
repair lifecycle is:
[evidence/vagrant-repair-20260807T151447227Z-a0c3daba/vm-lifecycle.json](evidence/vagrant-repair-20260807T151447227Z-a0c3daba/vm-lifecycle.json).

The exact-package consumer proof is:
[evidence/vagrant-box-20260807T161810446Z-003c1538/vagrant-box-proof.json](evidence/vagrant-box-20260807T161810446Z-003c1538/vagrant-box-proof.json).
Its status is `activation-required`, reason
`new-vm-identity-requires-ni-activation`. It proves:

- the real reviewer Vagrantfile with `--no-provision`;
- successful Vagrant import, boot, WinRM, hostname reboot, and interactive
  desktop;
- authenticated loopback-only TightVNC/RFB (`1280x720`, 521 updates);
- 1,091 captured frames and 91 resource samples before the license blocker;
- complete VM/NAT/listener/secret/local-state cleanup;
- the retained activated source VM remained powered off and unchanged.

Reproduce that box-only proof without reviewer provisioning or downloads:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\run-vagrant-box-proof.ps1 `
  -PackagePath D:\lba-vm-assets\actor-win11-labview2026-vagrant-ready-20260807.box `
  -ExpectedPackageSha256 225228f7385033545e57f61ab0fc90bb29c1337072e2bd18209af1aa0c859336
```

An `activation-required` receipt is a verified expected result for a fresh
hardware identity. Other capture, ownership, transport, evidence, or cleanup
failures remain nonzero.

The local registration currently lives under `VAGRANT_HOME=D:\vagrant-home`:

```powershell
$env:VAGRANT_HOME = 'D:\vagrant-home'
vagrant box list
```

Expected result:

```text
actor/win11-labview2026 (virtualbox, 0, (amd64))
```

Each new Vagrant VM must be activated through an NI-supported mechanism before
an activated-IDE benchmark:

```powershell
$env:VAGRANT_HOME = 'D:\vagrant-home'
$env:VAGRANT_CWD = (Resolve-Path .\reviewer-workstation).Path
vagrant up --provider virtualbox --no-provision
```

After activation in that disposable VM, run the governed capture. Provisioning
the reviewer extension remains a separate operation and may require private
release credentials.

Verify the historical captures and current box contract with:

```powershell
node .\experiments\windows-docker-container\verify-vm-capture.mjs `
  --verify .\experiments\windows-docker-container\evidence\vm-20260807T122440763Z
node .\experiments\windows-docker-container\verify-vm-capture.mjs `
  --verify .\experiments\windows-docker-container\evidence\vm-activation-20260807T133232933Z-80e478ed
node .\experiments\windows-docker-container\verify-vm-provisioning-receipt.mjs `
  .\experiments\windows-docker-container\decisions\windows-vm-provisioning-receipt.json
node .\experiments\windows-docker-container\vm-lifecycle.mjs verify `
  --record .\experiments\windows-docker-container\evidence\vm-activation-20260807T133232933Z-80e478ed\vm-lifecycle.json
node .\experiments\windows-docker-container\vm-lifecycle.mjs verify `
  --record .\experiments\windows-docker-container\evidence\vagrant-repair-20260807T151447227Z-a0c3daba\vm-lifecycle.json
node .\experiments\windows-docker-container\verify-vagrant-box-proof.mjs `
  --verify .\experiments\windows-docker-container\evidence\vagrant-box-20260807T161810446Z-003c1538\vagrant-box-proof.json
```

## Retained activated reviewer cache

Because NI activation is bound to an imported VM identity, the preferred local
activated workflow retains one Vagrant consumer instead of repeatedly
destroying and reimporting it:

- cache root: `D:\lba-vagrant-instances\actor-reviewer-local`;
- VM config/storage:
  `D:\VirtualBox VMs\actor-reviewer-local\actor-reviewer-local.vbox`;
- Vagrant state:
  `D:\lba-vagrant-instances\actor-reviewer-local\.vagrant`;
- VM: `actor-reviewer-local`;
- VM/hardware UUID: `f296a95b-7470-496a-bab7-791c973efd37`;
- powered-off snapshot: `reviewer-activated-vsix-57bd4d44d497`;
- snapshot UUID: `300812f7-ac50-47f6-b95a-973d7952fa76`.

The cache receipt is
[evidence/reviewer-cache-20260807T170315959Z-8fe3fe79/reviewer-cache.json](evidence/reviewer-cache-20260807T170315959Z-8fe3fe79/reviewer-cache.json),
schema `labview-benchmark-actor/windows-vagrant-reviewer-cache@1`. It verifies:

- activated LabVIEW MPRR capture:
  - `launchMs = 57,038.9684`;
  - settle clock `61,254.2993 ms`;
  - 1,115 frames and 94 resource samples;
- local VSIX `1.3.0`:
  - 125,428 bytes;
  - SHA-256
    `57bd4d44d4979345024df6f71a5125e8edf86318133bd4bc04d16532269eed45`;
  - installed in the `ACTOR-REVIEWER\vagrant` interactive profile;
- powered-off VM, released lock, retained snapshot, and zero ephemeral
  VNC/NAT/task/process/secret state.

The powered-off VM was moved from VirtualBox's C: default folder to D: after
sealing, preserving its UUID and snapshot while restoring host-system volume
capacity. The move lifecycle is:
[evidence/reviewer-cache-move-20260807T185418357Z-a2f4598f/vm-lifecycle.json](evidence/reviewer-cache-move-20260807T185418357Z-a2f4598f/vm-lifecycle.json).

Check status without starting the VM:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\reviewer-cache.ps1 `
  -Action Status
```

Resume the exact retained UUID:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\experiments\windows-docker-container\reviewer-cache.ps1 `
  -Action Resume
```

Resume creates a new lifecycle and exclusive lock before `vagrant up`. Treat
activation as untrusted until a fresh exact-UUID activation probe passes.
Never use ordinary `vagrant destroy` for routine cleanup: it permanently
discards this activated hardware identity. Intentional destruction requires the
ownership-checked `reviewer-cache-destroy.ps1`, the exact UUID, and
`-DiscardActivation`.

Official VS Code `1.130.0` was installed machine-wide inside only this retained
VM with maintainer approval. Rollback inside the VM is:

```powershell
winget uninstall --id Microsoft.VisualStudioCode --exact --silent --disable-interactivity
```

### Offline reviewer verdict

The retained VM completed the local/offline subset of
[the expert reviewer plan](../../docs/testing/reviewer-manual-test-plan.md).
The first run produced a verified **FAIL**:

- TC-08 found missing FFmpeg/VS Code restart guidance and repeat-install
  behavior;
- TC-10 found stale instructions for a nonexistent global MCP reset command.

The remediated local candidate:

- ships AGENTS.md `0.3.1` with capture commands and full-restart guidance;
- prevents a duplicate winget install in the same extension session and shows
  a restart-required message;
- documents the visible **LabVIEW Benchmark Actor: MCP tools** server label and
  the VS Code 1.130 **Restart Server** flow;
- has VSIX SHA-256
  `cd08be2dfc6f7e0a8f9ed69d6ddd05faf5adabca468aadb2e47be7705e0e748e`.

The superseding verified verdict is **PASS**:

- PASS: TC-00, TC-01, TC-02, TC-03, TC-06, TC-08, TC-09, TC-10;
- NOT-RUN: TC-04/05 (`GitHub auth/bus`), TC-07 (`lbabus`), TC-11
  (`Copilot agent auth`).

The superseding host-finalized receipt is
[evidence/reviewer-cache-resume-20260807T202743398Z-cb1a928f/offline-review-verdict.json](evidence/reviewer-cache-resume-20260807T202743398Z-cb1a928f/offline-review-verdict.json),
schema `labview-benchmark-actor/windows-reviewer-offline-gate@1`. It includes
the remediated TC-08/TC-10 screenshots, a fresh exact-UUID activated MPRR capture,
programmatic MCP evidence, reviewer `reviewer@vi-tech.nl`, and the explicit
not-run reasons.

The historical FAIL receipt remains at
[evidence/reviewer-cache-resume-20260807T193416615Z-eac6c074/offline-review-verdict.json](evidence/reviewer-cache-resume-20260807T193416615Z-eac6c074/offline-review-verdict.json).

After remediation, the VM was halted and sealed at snapshot
`reviewer-activated-vsix-cd08be2dfc6f-20260807210815`. The old snapshot remains
available as rollback. The powered-off cache receipt verifies and the reviewer
lock is absent.

Post-review feedback added another guarded refinement:

- cache sealing now uses recoverable `seal-verification-pending` state and
  retains its lock until receipt build/verification succeeds;
- intentional destroy derives the supported VM name from cache metadata and
  still requires the exact UUID/hardware UUID;
- a failed/cancelled winget run can choose **Retry ffmpeg setup...**, while
  successful same-session installs remain protected from duplicate install
  attempts.

The current shipped guidance is AGENTS.md `0.3.2`, and the feedback-remediated
VSIX has SHA-256
`48074c046a03b69d1c83d5608ecc40560074059d69fab3668cb92adeb6e3fb03`.
The targeted retained-VM UI check passed and the cache is sealed at snapshot
`reviewer-activated-vsix-48074c046a03-20260807220426`
(`c5d7e440-707d-4522-a06e-f2d358f3e4c3`). Feedback evidence is under
[evidence/reviewer-cache-resume-20260807T213425759Z-13591007](evidence/reviewer-cache-resume-20260807T213425759Z-13591007).

## Resumable MPRR VM lifecycle cache

The sealed cache is
[decisions/windows-vm-lifecycle-cache.json](decisions/windows-vm-lifecycle-cache.json),
schema `labview-benchmark-actor/windows-vm-lifecycle@1`.

It uses the MPRR `timingTicks64` unit (100 ns) and records wall-clock UTC
separately. Each live checkpoint carries:

- host `process.hrtime.bigint` nanoseconds;
- relative `timingTicks64`;
- a host-boot identity;
- UTC provenance;
- immutable evidence hashes.

If the host rebooted, a new clock segment is created and no monotonic span is
computed across boots.

Provisioning predated this logger. The cache deliberately records those phases
as `historical-state-proof` with `monotonicNs=null` and
`timingTicks64=null`; pre-provision duration is unavailable and is never
estimated. The retained diagnostic capture still records deterministic,
capture-clock timings:

- LabVIEW splash: frame 148, `11,453.4 ms` after launch trigger;
- stable NI License Manager wizard: frame 292, `23,508.4 ms` on the
  capture clock;
- raw benchmark `launchMs`: `23,508.0187 ms` (a `0.3813 ms` rounding
  delta);
- stable tail: 797 frames;
- 1,089 total frames, 3 unique fingerprints, 91 resource samples.

These are diagnostic activation-blocker timings, not an activated-IDE
performance result.

Verify the current cache:

```powershell
node .\experiments\windows-docker-container\verify-vm-lifecycle-cache.mjs `
  .\experiments\windows-docker-container\decisions\windows-vm-lifecycle-cache.json
```

### Start before provisioning or cloning

For every future from-scratch build, the **first command**, before `VBoxManage
createvm`, `vagrant up`, clone, import, or provisioning, is:

```powershell
node .\experiments\windows-docker-container\vm-lifecycle.mjs init `
  --record .\experiments\windows-docker-container\evidence\<run-id>\vm-lifecycle.json `
  --lifecycle-id <run-id> --vm-name <vm-name>
```

Checkpoint each expensive phase atomically:

```powershell
node .\experiments\windows-docker-container\vm-lifecycle.mjs checkpoint `
  --record <record> --phase MEDIA-VERIFIED --status completed `
  --evidence <receipt-or-manifest>
```

Supported phases include VM creation, Windows provisioning, interactive
readiness, pre-LabVIEW snapshot, LabVIEW install, capture readiness, splash,
settle, packaging, and box registration. Phase regression, duplicate status,
clock regression, malformed hashes, and writes after sealing fail closed.

### Resume the retained cache

Before the next activation attempt or any VM mutation:

```powershell
node .\experiments\windows-docker-container\vm-lifecycle.mjs resume `
  --cache .\experiments\windows-docker-container\decisions\windows-vm-lifecycle-cache.json `
  --record .\experiments\windows-docker-container\evidence\<resume-run>\vm-lifecycle.json `
  --lifecycle-id <resume-run>
```

That command verifies the sealed source record and retained powered-off VM
identity/snapshots, acquires an exclusive VM-local resume lock, opens a fresh
dual-clock session, writes `ACTIVATION-RESUME-START`, and stores the
source-cache hash.

The retained cache was successfully resumed in
[evidence/vm-activation-20260807T133232933Z-80e478ed/vm-lifecycle.json](evidence/vm-activation-20260807T133232933Z-80e478ed/vm-lifecycle.json),
which completed:

1. interactive NI activation;
2. checkpoint `ACTIVATION-COMPLETE`;
3. checkpoint `POST-ACTIVATION-CAPTURE-START`;
4. governed activated-IDE MPRR capture;
5. checkpoint `LABVIEW-IDE-SETTLED`;
6. activated snapshot `labview-q3-activated`;
7. checkpoint `BOX-PACKAGE-START` and `BOX-REGISTERED`;
8. sealed completed lifecycle with released lock.

For a future rebuild, use the same resume flow; for day-to-day reuse, prefer
the already registered `actor/win11-labview2026` box under
`VAGRANT_HOME=D:\vagrant-home`.

Sealing releases the lock only after writing the sealed record. If interruption
leaves a sealed record with release pending, retry the ownership-checked
release:

```powershell
node .\experiments\windows-docker-container\vm-lifecycle.mjs release `
  --record .\experiments\windows-docker-container\evidence\<resume-run>\vm-lifecycle.json
```

An open/abandoned record cannot release its lock through this command. Inspect
and seal that run first; never delete a VM lifecycle lock blindly.

The reusable cache includes the Windows/LabVIEW installation, verified media,
snapshots, VM config identity, DesktopSize-capable RFB client, representative
capture evidence, provisioning receipts, and guest cleanup proof.
