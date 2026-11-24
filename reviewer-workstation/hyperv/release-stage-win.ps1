<#
.SYNOPSIS
  Release phase 7 against a Hyper-V reviewer guest (the Hyper-V counterpart of release-stage-win.mjs).
.DESCRIPTION
  Stages the candidate VSIX in the guest and proves the guest holds the exact bytes, installs it, points the extension
  at the per-version visual key, captures the guest's correlated release-stage@1 DONE frame over lbabus TCP, records
  staged-frame-WIN-<version>.json, and binds the review target to the candidate and its evidence.
  The sender, install and configure scripts, the task id, the evidence and the pin come from this tooling tree
  (stage-guest-scripts.mjs, the code the VirtualBox driver uses); the candidate supplies package.json,
  release-components.json and the host scripts that gate the result (record-release-stage, await-agent-reply,
  verify-staged-vsix). Before any guest change the sha256 of the evidence and pin rule files
  (scripts/verify-reviewer-infrastructure.mjs, scripts/lbabus-pin.mjs, experiments/acg-quorum/cross-plane-attestation.mjs)
  must be equal in the tooling tree and in -CandidateRepo, else exit 2.
  The host listener binds all interfaces (lbabus has no bind option), so an inbound firewall rule scoped to
  -HostAddress, its interface, -TcpPort and the guest address is opened for the step and removed when it ends,
  on success and on failure. The guest address is -GuestAddress or, when omitted, the VM's IPv4 address on the
  host's subnet; with neither the step refuses (exit 2) before any guest change. Run elevated on the Hyper-V host.
  Find the host address the guest reaches on a Hyper-V switch with
    (Get-NetIPAddress -InterfaceAlias 'vEthernet (<switch>)' -AddressFamily IPv4).IPAddress
  or pass -SwitchName and let the script read it.
.EXAMPLE
  .\release-stage-win.ps1 -VMId <guid> -Credential $c -Version 1.6.7 -Commit <40-hex> -Vsix C:\work\candidate.vsix `
    -Attestation $HOME\lba-vm-share\attestation-1.6.7.json -CandidateRepo C:\work\candidate -VisualKey C:\keys\reviewer-visual.pem `
    -SwitchName 'Default Switch' -LbabusExe C:\lba-tools\lbabus-0.17.1-win-x64.exe
#>
[CmdletBinding()]
param(
  [string]$VMId, [string]$VMName, [pscredential]$Credential,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$Commit,
  [Parameter(Mandatory)][string]$Vsix,
  [Parameter(Mandatory)][string]$Attestation,
  [Parameter(Mandatory)][string]$CandidateRepo,
  [Parameter(Mandatory)][string]$VisualKey,
  [string]$HostAddress, [string]$SwitchName, [string]$GuestAddress,
  [int]$TcpPort = 7420,
  [Parameter(Mandatory)][string]$LbabusExe,
  [string]$Share = (Join-Path $HOME 'lba-vm-share'),
  [string]$GuestUser, [string]$Reviewer = 'reviewer@vi-tech.nl',
  [string]$Node = 'node',
  [int]$TimeoutSec = 300,
  [switch]$NoSetTarget, [switch]$Force,
  [Alias('WhatIf')][switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'LbaHyperV.psm1') -Force
Start-LbaPlan -DryRun:$DryRun
Invoke-LbaMain {
  $toolingRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  Assert-LbaArgument ($Version -match '^\d+\.\d+\.\d+$') "-Version must be X.Y.Z, got $Version"
  Assert-LbaArgument ($Commit -match '^[0-9a-f]{40}$') '-Commit must be a full 40-character sha'
  Assert-LbaArgument ($TcpPort -gt 0 -and $TcpPort -lt 65536) "-TcpPort is not a port: $TcpPort"
  foreach ($f in @($Vsix, $Attestation, $VisualKey, $LbabusExe)) { Assert-LbaArgument (Test-Path -LiteralPath $f) "$f does not exist" }
  Assert-LbaToolingMatchesCandidate -ToolingRoot $toolingRoot -CandidateRoot $CandidateRepo -Files @('scripts\verify-reviewer-infrastructure.mjs', 'scripts\lbabus-pin.mjs', 'experiments\acg-quorum\cross-plane-attestation.mjs')
  Assert-LbaCredential $Credential
  $id = Resolve-LbaVmId -VMId $VMId -VMName $VMName
  $hostAddr = Resolve-LbaHostAddress -HostAddress $HostAddress -SwitchName $SwitchName
  $user = Get-LbaGuestUser -Credential $Credential -GuestUser $GuestUser
  $work = Join-Path ([IO.Path]::GetTempPath()) ('lba-stage-' + [guid]::NewGuid().ToString('N'))
  $rule = $null
  $listener = $null
  try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $planArgs = @((Join-Path $toolingRoot 'reviewer-workstation\stage-guest-scripts.mjs'), '--version', $Version, '--commit', $Commit, '--vsix', $Vsix,
      '--attestation', $Attestation, '--host', $hostAddr, '--tcp', "$TcpPort", '--user', $user, '--reviewer', $Reviewer, '--out-dir', $work, '--share', $Share,
      '--candidate-root', $CandidateRepo)
    if ($NoSetTarget) { $planArgs += '--no-set-target' }
    $plan = (Invoke-LbaHost -File $Node -Arguments $planArgs -Pure) -join "`n" | ConvertFrom-Json
    $stagedFrame = $plan.paths.stagedFrame
    $readback = $plan.paths.readback
    Assert-LbaArgument ($Force -or -not (Test-Path -LiteralPath $stagedFrame)) "$stagedFrame already exists; refusing to overwrite release evidence (pass -Force)"

    # The pinned lbabus: the host copy must be the pinned release asset before it is used or sent anywhere.
    Assert-LbaArgument ([bool]$plan.lbabus.sha256) 'release-components.json pins no lbabus win-x64 asset'
    if (-not (Test-LbaDryRun)) {
      $have = Get-LbaHostSha256 -Path $LbabusExe
      if ($have -ne $plan.lbabus.sha256) { throw "LBA_GATE: -LbabusExe hashes to $have, not the pinned $($plan.lbabus.asset) $($plan.lbabus.sha256)" }
    } else { Add-LbaStep 'host-check' $LbabusExe "sha256 equals the pinned $($plan.lbabus.asset) $($plan.lbabus.sha256)" }

    # Everything that can refuse on the host or the guest state comes before the first guest change.
    Assert-LbaVmRunning -VMId $id -RequireFileCopy
    $guestAddr = Resolve-LbaGuestAddress -GuestAddress $GuestAddress -VMId $id -HostAddress $hostAddr
    # A stale listener would ACK the sender in place of ours: the port must start free.
    if (Test-LbaPortInUse -Port $TcpPort) { throw "LBA_HOST: tcp $TcpPort is already in use on this host; stop the stale listener first (Get-NetTCPConnection -State Listen -LocalPort $TcpPort)" }
    Assert-LbaNoStaleRule -Port $TcpPort
    if (-not (Test-LbaDryRun)) { New-Item -ItemType Directory -Force -Path $Share | Out-Null }
    $g = $plan.guest
    foreach ($dir in @($g.dir, $g.keyDir, (Split-Path -Parent $g.lbabus))) {
      [void](Invoke-LbaGuest -Name "mkdir $dir" -VMId $id -Credential $Credential -ArgumentList @($dir) -Describe "New-Item -ItemType Directory -Force '$dir'" -ScriptBlock { param($d) New-Item -ItemType Directory -Force -Path $d | Out-Null })
    }

    $guestHash = Get-LbaGuestSha256 -VMId $id -Credential $Credential -Path $g.lbabus
    if ($guestHash -ne $plan.lbabus.sha256) {
      Copy-LbaToGuest -VMId $id -Source $LbabusExe -Destination $g.lbabus
      $guestHash = Get-LbaGuestSha256 -VMId $id -Credential $Credential -Path $g.lbabus
      if (-not (Test-LbaDryRun) -and $guestHash -ne $plan.lbabus.sha256) { throw "LBA_GATE: lbabus in the guest hashes to $guestHash, not the pinned $($plan.lbabus.sha256)" }
    }

    [void](Invoke-LbaGuest -Name 'remove a stale candidate VSIX' -VMId $id -Credential $Credential -ArgumentList @($g.vsix) -Describe "Remove-Item -Force '$($g.vsix)'" -ScriptBlock { param($p) Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue })
    Copy-LbaToGuest -VMId $id -Source $plan.files.sender -Destination "$($g.dir)\lba-send-stage-$Version.mjs"
    Copy-LbaToGuest -VMId $id -Source $plan.files.install -Destination "$($g.dir)\lba-install-$Version.ps1"
    Copy-LbaToGuest -VMId $id -Source $plan.files.configure -Destination "$($g.dir)\lba-configure-visual-$Version.ps1"
    Copy-LbaToGuest -VMId $id -Source $Vsix -Destination $g.vsix
    Copy-LbaToGuest -VMId $id -Source $VisualKey -Destination "$($g.keyDir)\reviewer-visual.pem"
    $staged = Get-LbaGuestSha256 -VMId $id -Credential $Credential -Path $g.vsix
    if (-not (Test-LbaDryRun) -and $staged -ne $plan.vsixSha256) { throw "LBA_GATE: the VSIX in the guest hashes to '$staged', not $($plan.vsixSha256)" }

    $installOut = Invoke-LbaGuestProgram -Name 'install the extension' -VMId $id -Credential $Credential -Exe $g.powershell `
      -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "$($g.dir)\lba-install-$Version.ps1") -TimeoutSec 300
    $want = "INSTALLED=$($plan.extensionId)@$Version"
    if (-not (Test-LbaDryRun) -and -not (($installOut -join "`n") -match [regex]::Escape($want))) { throw "LBA_GUEST: the guest did not confirm $want" }
    $confOut = Invoke-LbaGuestProgram -Name 'configure the visual reviewer key' -VMId $id -Credential $Credential -Exe $g.powershell `
      -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "$($g.dir)\lba-configure-visual-$Version.ps1") -TimeoutSec 120
    if (-not (Test-LbaDryRun) -and -not (($confOut -join "`n") -match 'STALE_VERDICT_CLEARED=True')) { throw "LBA_GUEST: visual key configuration failed: $(($confOut | Select-Object -Last 2) -join ' | ')" }

    $rule = Open-LbaListener -Port $TcpPort -LocalAddress $hostAddr -RemoteAddress $guestAddr
    $listener = Start-LbaListener -Node $Node -Script (Join-Path $CandidateRepo 'reviewer-workstation\await-agent-reply.mjs') -Lbabus $LbabusExe -TaskId $plan.taskId `
      -Port $TcpPort -TimeoutSec $TimeoutSec -Out $readback -LogDir $work
    $sent = Invoke-LbaGuestProgram -Name 'send the DONE frame' -VMId $id -Credential $Credential -Exe $g.node -Arguments @("$($g.dir)\lba-send-stage-$Version.mjs") -TimeoutSec $TimeoutSec
    if (-not (Test-LbaDryRun)) {
      if (-not (($sent -join "`n") -match [regex]::Escape("STAGED_SHA256=$($plan.vsixSha256)"))) { throw "LBA_GUEST: the in-guest sender did not report the staged hash: $(($sent | Select-Object -Last 2) -join ' | ')" }
      if (-not $listener.WaitForExit($TimeoutSec * 1000)) { throw "LBA_TIMEOUT: the host listener did not correlate $($plan.taskId) within $TimeoutSec s" }
      if ($listener.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $readback)) { throw "LBA_GATE: the host listener did not correlate $($plan.taskId) (exit $($listener.ExitCode))" }
    }
    Stop-LbaListener -Process $listener
    $listener = $null
    Close-LbaListener -Name $rule
    $rule = $null

    $recordArgs = @((Join-Path $CandidateRepo 'reviewer-workstation\record-release-stage.mjs'), '--component', 'extension', '--version', $Version, '--commit', $Commit,
      '--vsix256', $plan.vsixSha256, '--readback', $readback, '--out', $stagedFrame)
    [void](Invoke-LbaHost -File $Node -Arguments $recordArgs -FailAs GATE)
    if (-not $NoSetTarget) {
      Set-LbaReviewTarget -VMId $id -Credential $Credential -GuestUser $user -Version $Version -Commit $Commit -VsixSha256 $plan.vsixSha256 -Evidence @($plan.evidence) `
        -Node $Node -ToolingRoot $toolingRoot -CandidateRoot $CandidateRepo -GuestVsix $g.vsix
    }
    if (-not (Test-LbaDryRun)) { Write-Output "release-stage-win: recorded $stagedFrame (task $($plan.taskId))" }
  } finally {
    if ($listener) { Stop-LbaListener -Process $listener }
    if ($rule) { Close-LbaListener -Name $rule }
    if (Test-Path -LiteralPath $work) { Remove-Item -Recurse -Force -LiteralPath $work }
  }
  Write-LbaPlan -Title "release-stage-win $Version"
}
