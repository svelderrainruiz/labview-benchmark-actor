#Requires -Version 5.1
<#
.SYNOPSIS
  Stage the LOCAL labview-benchmark-actor .vsix onto the RUNNING reviewer VM for human visual inspection --
  the "last gate" before publishing to the VS Code Marketplace.

.DESCRIPTION
  Companion to provision.ps1, but for the PRE-PUBLISH candidate. provision.ps1 pulls a PUBLISHED `ext-v*`
  release; THIS script builds the candidate from the current working tree and installs THAT, so a human can
  visually inspect the real extension + its documentation (the Marketplace README page, the command surface,
  the benchmark viewer, the embedded agent instructions) before anything is published.

  Steps (host-side, over the WinRM communicator):
    1. build + package the candidate .vsix on the host (npm test + vsce package), unless -SkipBuild;
    2. guard the .vsix size (a fat .vsix means .vscodeignore leaked non-runtime content, e.g. the VM disk);
    3. `vagrant upload` it into the guest;
    4. `code --install-extension --force` in the guest and verify the id@version;
    5. drop a Marketplace-review checklist into C:\lba-review for the reviewer.

  Re-runnable. Requires the reviewer VM already up:
    VAGRANT_CWD=reviewer-workstation vagrant up --provider vmware_desktop   # (WIN) or --provider virtualbox (LINUX)

.EXAMPLE
  pwsh -File reviewer-workstation/stage-local-vsix.ps1
  pwsh -File reviewer-workstation/stage-local-vsix.ps1 -SkipBuild -Vsix .\labview-benchmark-actor.vsix
#>
[CmdletBinding()]
param(
  [string]$Vsix,
  [switch]$SkipBuild,
  [string]$Machine = 'default',
  [string]$GuestVsixPath = 'C:/lba-review/candidate.vsix'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Step([string]$m) { Write-Host "[stage-local] $m" -ForegroundColor Cyan }

$repoRoot = Split-Path $PSScriptRoot -Parent
$lbabusTemp = $null
Push-Location $repoRoot
try {
  # 1) Build the candidate .vsix from the working tree (unless skipped / supplied prebuilt).
  if (-not $SkipBuild) {
    Step 'npm test (compile + activation + viewer render)'
    npm test
    if ($LASTEXITCODE -ne 0) { throw "npm test failed ($LASTEXITCODE) -- fix before staging a publish candidate." }
    Step 'normalized VSIX package'
    npm run package
    if ($LASTEXITCODE -ne 0) { throw "npm run package failed ($LASTEXITCODE)." }
    $Vsix = Join-Path $repoRoot 'labview-benchmark-actor.vsix'
  }
  if (-not $Vsix) { $Vsix = Join-Path $repoRoot 'labview-benchmark-actor.vsix' }
  if (-not (Test-Path $Vsix)) { throw "No .vsix at '$Vsix'. Build it (omit -SkipBuild) or pass -Vsix <path>." }

  $sizeBytes = (Get-Item $Vsix).Length
  $vsixSha256 = (Get-FileHash $Vsix -Algorithm SHA256).Hash.ToLowerInvariant()
  Step ("candidate: {0} ({1:N1} KB)" -f $Vsix, ($sizeBytes / 1KB))
  # Publish guard: a real extension .vsix is tiny. A multi-MB one means .vscodeignore leaked non-runtime
  # content (VM disk under reviewer-workstation/.vagrant, node_modules, experiments, ...). Fail closed --
  # this is exactly the class of defect the last gate must catch before Marketplace.
  if ($sizeBytes -gt 5MB) {
    throw ("VSIX is {0:N1} MB -- too large to publish; audit .vscodeignore (VM disk / node_modules leak) then rebuild." -f ($sizeBytes / 1MB))
  }
  $candidateReceiptPath = Join-Path $repoRoot '.lba\local-ci\latest.json'
  if (-not (Test-Path $candidateReceiptPath)) {
    throw 'Missing .lba/local-ci/latest.json. Run the clean-worktree `npm run ci:local` before reviewer staging.'
  }
  $candidateReceipt = Get-Content $candidateReceiptPath -Raw | ConvertFrom-Json
  $sourceCommit = (git -C $repoRoot rev-parse HEAD).Trim()
  $worktreeStatus = (git -C $repoRoot status --short | Out-String).Trim()
  if (
    $candidateReceipt.mode -ne 'full' -or
    $candidateReceipt.outcome -ne 'PASS' -or
    $candidateReceipt.kpi.candidate.sourceCommit -ne $sourceCommit -or
    $candidateReceipt.kpi.candidate.vsixSha256 -ne $vsixSha256 -or
    $candidateReceipt.kpi.candidate.vsixSize -ne $sizeBytes -or
    -not $candidateReceipt.kpi.candidate.worktreeCleanBefore -or
    -not $candidateReceipt.kpi.candidate.worktreeCleanAfter -or
    $candidateReceipt.kpi.coverage.branches.percent -lt 95 -or
    $candidateReceipt.kpi.coverage.lines.percent -lt 95 -or
    $candidateReceipt.kpi.coverage.statements.percent -lt 95 -or
    $candidateReceipt.kpi.coverage.functions.percent -lt 96 -or
    $candidateReceipt.kpi.localGates.passed -ne $candidateReceipt.kpi.localGates.total -or
    $candidateReceipt.kpi.localGates.total -le 0 -or
    $candidateReceipt.kpi.correspondences.passed -ne $candidateReceipt.kpi.correspondences.total -or
    $candidateReceipt.kpi.correspondences.total -le 0 -or
    -not $candidateReceipt.kpi.correspondences.graphConformant -or
    -not $candidateReceipt.kpi.package.identical -or
    $candidateReceipt.kpi.package.firstSha256 -ne $vsixSha256 -or
    $candidateReceipt.kpi.package.secondSha256 -ne $vsixSha256 -or
    $worktreeStatus
  ) {
    throw 'The full local-KPI receipt does not bind this clean commit and exact VSIX. Re-run `npm run ci:local`.'
  }

  $env:VAGRANT_CWD = $PSScriptRoot
  # 2) The VM must be up.
  Step 'vagrant status'
  $status = (vagrant status $Machine 2>&1 | Out-String)
  if ($status -notmatch 'running') {
    throw "Reviewer VM '$Machine' is not running. Bring it up first: VAGRANT_CWD=reviewer-workstation vagrant up --provider vmware_desktop"
  }

  # 3) Upload the candidate into the guest (WinRM; no synced folder in this Vagrantfile).
  Step "vagrant upload -> $GuestVsixPath"
  vagrant upload $Vsix $GuestVsixPath $Machine
  if ($LASTEXITCODE -ne 0) { throw "vagrant upload failed ($LASTEXITCODE)." }
  vagrant winrm -c "powershell -NoProfile -Command `"New-Item -ItemType Directory -Path C:\lba-review\workspace -Force | Out-Null`"" $Machine | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not create the guest review workspace ($LASTEXITCODE)." }
  vagrant upload $Vsix 'C:/lba-review/workspace/candidate.vsix' $Machine | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not upload the workspace candidate VSIX ($LASTEXITCODE)." }
  vagrant upload $candidateReceiptPath 'C:/lba-review/workspace/candidate-receipt.json' $Machine | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not upload the candidate KPI receipt ($LASTEXITCODE)." }

  # The reviewer is a real mesh actor, not just a visual shell. Publish a framework-dependent Windows apphost
  # from this exact repository and install it into a stable user-PATH location before exercising capabilities.
  $lbabusTemp = Join-Path ([IO.Path]::GetTempPath()) "lba-reviewer-lbabus-$PID"
  $lbabusPublish = Join-Path $lbabusTemp 'publish'
  $lbabusZip = Join-Path $lbabusTemp 'lbabus-win-x64.zip'
  New-Item -ItemType Directory -Path $lbabusPublish -Force | Out-Null
  Step 'publish reviewer lbabus Windows apphost'
  dotnet publish (Join-Path $repoRoot 'tools\collab-cli\LbaBus.csproj') `
    --configuration Release --runtime win-x64 --self-contained false `
    -p:UseAppHost=true --output $lbabusPublish --nologo --verbosity quiet
  if ($LASTEXITCODE -ne 0) { throw "lbabus publish failed ($LASTEXITCODE)." }
  Compress-Archive -Path (Join-Path $lbabusPublish '*') -DestinationPath $lbabusZip
  vagrant upload $lbabusZip 'C:/Windows/Temp/lbabus-win-x64.zip' $Machine | Out-Null
  vagrant upload (Join-Path $PSScriptRoot 'bin\guest-install-lbabus.ps1') 'C:/Windows/Temp/lba-guest-install-lbabus.ps1' $Machine | Out-Null
  $lbabusInstall = (vagrant winrm -c "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Windows\Temp\lba-guest-install-lbabus.ps1 -PayloadZip C:\Windows\Temp\lbabus-win-x64.zip" 2>&1 | Out-String)
  $lbabusInstall -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host "    $($_.TrimEnd())" } }
  if ($lbabusInstall -notmatch '"version":"0\.15\.6"') {
    throw "Guest lbabus install/verify failed:`n$lbabusInstall"
  }

  Step 'install and verify reviewer prerequisite toolchain'
  $toolchainInstall = (vagrant provision $Machine --provision-with reviewer-toolchain 2>&1 | Out-String)
  $toolchainInstall -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host "    $($_.TrimEnd())" } }
  if ($toolchainInstall -notmatch '"ok":true') {
    throw "Guest reviewer-toolchain install/verify failed:`n$toolchainInstall"
  }
  $selfcheck = (vagrant winrm -c "powershell -NoProfile -Command `"& 'C:\lba-tools\lbabus\lbabus.exe' selfcheck`"" 2>&1 | Out-String)
  $selfcheck -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host "    $($_.TrimEnd())" } }
  if ($selfcheck -notmatch 'selfcheck: PASS') {
    throw "Guest lbabus selfcheck failed after toolchain staging:`n$selfcheck"
  }

  # 4) Install into the INTERACTIVE reviewer's profile (issue #121) + verify by outcome. A guest-side
  #    helper resolves the console user's real profile path (folder name can differ from the username).
  $guestWin = $GuestVsixPath -replace '/', '\'
  Step 'upload guest-install helper'
  vagrant upload (Join-Path $PSScriptRoot 'bin\guest-install.ps1') 'C:/Windows/Temp/lba-guest-install.ps1' $Machine | Out-Null
  Step 'install into the interactive reviewer profile (guest)'
  $install = (vagrant winrm -c "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Windows\Temp\lba-guest-install.ps1 -Vsix $guestWin" 2>&1 | Out-String)
  $install -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host "    $($_.TrimEnd())" } }
  if ($install -notmatch 'verified in target profile') {
    throw "Guest install/verify failed:`n$install"
  }

  # 5) Drop a Marketplace-review checklist next to the scratch workspace for the human last-gate.
  # Surface the agent last gate's verdict + receipt so the human knows they are reviewing an already-
  # pre-vetted candidate and can focus on the judgment/visual checks a machine cannot make.
  $gateHeader = ''
  $gateReceipt = Join-Path $repoRoot 'experiments\agent-last-gate\receipt.json'
  if (Test-Path $gateReceipt) {
    try {
      $r = Get-Content $gateReceipt -Raw | ConvertFrom-Json
      $gateHeader = @"
AGENT LAST GATE: $($r.verdict) ($($r.passed)/$($r.total)) on $($r.platform) at $($r.ranAt)
The automated pre-vet already passed the MECHANICAL checks (packaging allow-set + size, icon >=128px,
CHANGELOG, Marketplace-safe README links, gallery metadata, tests + gates). Full receipt on this VM:
C:\lba-review\agent-last-gate-receipt.json

Your job below is the JUDGMENT the machine can't make: does it LOOK right?

"@
      vagrant upload $gateReceipt 'C:/lba-review/agent-last-gate-receipt.json' $Machine | Out-Null
    } catch { Step "WARN could not read the agent-gate receipt: $($_.Exception.Message)" }
  }
  $checklist = $gateHeader + @'
labview-benchmark-actor -- PRE-PUBLISH visual review (Marketplace last gate)

You are inspecting the LOCAL candidate .vsix (built from the working tree), not a
published release. Install is already done. Open VS Code in THIS VM and inspect:

A. Marketplace listing surface (the README page)
   - Extensions view (Ctrl+Shift+X) -> "LabVIEW Benchmark Actor" -> Details tab.
   - Confirm: display name, description, version, publisher, README renders with no
     broken images/links, categories look right. This is what Marketplace visitors see.

B. Command surface (Ctrl+Shift+P -> "LabVIEW Benchmark Actor:")
   - Open Benchmark Viewer        -> the mprr metric series renders with a draggable time cursor.
   - Show Agent Instructions      -> the embedded AGENTS.md opens.
   - Write Agent Instructions     -> materializes AGENTS.md into the open folder.
   - Check Agent Instructions     -> reports match/drift vs the embedded canonical.
   - Show Host Capabilities / Poll Bus / Post Note -> reviewer staging installs and resolves `lbabus` explicitly.
     Configure a bus peer before Poll/Post.

C. Documentation
   - README (above) is the shipped doc surface. Deeper specs (SRS/ADRs/user guide) are in
     the repo under docs/ if you want to cross-check wording.

Verdict: if A + B and the exact candidate receipt pass, a visual PASS approves this candidate for later release
gates. It does NOT authorize Marketplace publication. Hosted, cross-plane, provenance, canonical-release, lineage,
and Marketplace proofs remain mandatory and publication stays blocked until those later gates pass.
'@
  # Cross-platform host temp dir: $env:TEMP is null when this script runs under pwsh on the LINUX
  # (VirtualBox) lane -- use [IO.Path]::GetTempPath() (returns %TEMP% on Windows, /tmp on Linux).
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) 'lba-review-checklist.txt'
  Set-Content -Path $tmp -Value $checklist -Encoding ASCII
  Step 'upload review checklist -> C:/lba-review/REVIEW-CHECKLIST.txt'
  vagrant upload $tmp 'C:/lba-review/REVIEW-CHECKLIST.txt' $Machine | Out-Null

  Write-Host ''
  Step 'DONE. Switch to the VM window, open VS Code, and follow C:\lba-review\REVIEW-CHECKLIST.txt.'
  Step 'The candidate extension is installed; nothing has been published.'
}
finally {
  if ($lbabusTemp -and (Test-Path -LiteralPath $lbabusTemp)) {
    Remove-Item -LiteralPath $lbabusTemp -Recurse -Force
  }
  Pop-Location
}
