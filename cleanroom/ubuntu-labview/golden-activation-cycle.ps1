#requires -Version 5
<#+
.SYNOPSIS
  Provision, activate, and package a Vagrant-hosted Ubuntu production golden VM.

.DESCRIPTION
  Provision public LabVIEW prerequisites, reboot and verify LabVIEWCLI plus graphical-console readiness,
  record the operator's non-secret desktop-unlock acknowledgement, hand off NI/VIPM activation, capture a
  functional activation receipt, then package a production box only after that receipt verifies. This script
  never accepts, reads, or transmits credentials.

.EXAMPLE
  pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Provision
  pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode ConsoleReady -OperatorDesktopConfirmed -ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
  pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Handoff -ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
  pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Confirm -ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
  pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Package -ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
#>
[CmdletBinding()]
param(
  [string]$Vm = 'actor1',

  [ValidateSet('Check', 'Provision', 'Repair', 'ConsoleReady', 'Handoff', 'Confirm', 'Package')]
  [string]$Mode = 'Check',

  [string]$VagrantRoot = (Join-Path $PSScriptRoot 'mesh'),

  [string]$ActorId = '',

  [string]$ActorHostname = '',

  [string]$ActorIp = '',

  [switch]$OperatorDesktopConfirmed,

  [string]$ProductionBoxPath = (Join-Path $PSScriptRoot 'production\labview-ubuntu2404-production.box'),

  [string]$ProductionVagrantfile = (Join-Path $PSScriptRoot 'production-golden-box.Vagrantfile'),

  [switch]$OverwriteProductionBox
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$readinessScript = Join-Path $PSScriptRoot 'activation-ready.sh'
$provisioner = Join-Path $PSScriptRoot 'provision-guest.sh'
$keyring = Join-Path $PSScriptRoot 'ni-labview-2026-noble-community.asc'
$readinessBuilder = Join-Path $repoRoot 'experiments\provisioner-readiness\goldenActivationReadiness.mjs'
$activationProbe = Join-Path $repoRoot 'experiments\activation\probe-activation.sh'
$activationBuilder = Join-Path $repoRoot 'experiments\activation\buildActivationReceipt.mjs'
$registrationScript = Join-Path $repoRoot 'experiments\activation\registerMeshActor.mjs'
$artifactDir = Join-Path $VagrantRoot '.vagrant'
$readinessCapture = Join-Path $artifactDir "golden-$Vm-readiness-capture.json"
$readinessReceipt = Join-Path $artifactDir "golden-$Vm-readiness-receipt.json"
$activationCapture = Join-Path $artifactDir "golden-$Vm-activation-capture.json"
$activationReceipt = Join-Path $artifactDir "golden-$Vm-activation-receipt.json"
$consoleReceipt = Join-Path $artifactDir "golden-$Vm-console-readiness.json"
$packageReceipt = Join-Path $artifactDir "golden-$Vm-production-package.json"

function Invoke-Vagrant {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & vagrant @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "vagrant $($Arguments -join ' ') exited $LASTEXITCODE"
  }
}

function Invoke-VagrantAllowFailure {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & vagrant @Arguments | Out-Host
  return $LASTEXITCODE
}

function Send-GuestFile {
  param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
  Invoke-Vagrant -Arguments @('upload', $Source, $Destination, $Vm)
}

function Receive-GuestFile {
  param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  $encoded = (& vagrant ssh $Vm -c "base64 -w 0 '$Source'" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "could not read guest file $Source from $Vm"
  }
  try {
    [System.IO.File]::WriteAllBytes($Destination, [System.Convert]::FromBase64String($encoded))
  } catch {
    throw "could not decode guest file $Source from $Vm"
  }
}

function Assert-EnrollmentIdentity {
  $identityValues = @($ActorId, $ActorHostname, $ActorIp)
  if ($identityValues | Where-Object { [string]::IsNullOrWhiteSpace($_) }) {
    throw 'ActorId, ActorHostname, and ActorIp are required together for enrollment-bound handoff and confirmation'
  }
  if ($ActorId -ne 'golden') {
    throw 'ActorId must be golden for the golden actor enrollment workflow'
  }
  if ($ActorId -notmatch '^[A-Za-z0-9._-]+$' -or $ActorHostname -notmatch '^[A-Za-z0-9.-]+$' -or $ActorIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
    throw 'actor identity values contain unsupported characters'
  }
}

function Get-Sha256Text {
  param([Parameter(Mandatory = $true)][string]$Text)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
  }
}

function ConvertTo-CompactJson {
  param([Parameter(Mandatory = $true)]$Value, [int]$Depth = 8)

  return $Value | ConvertTo-Json -Depth $Depth -Compress
}

function Get-GuestConsoleState {
  $guestCommand = 'boot_id="$(cat /proc/sys/kernel/random/boot_id)"; guest_hostname="$(hostname)"; guest_ips="$(hostname -I)"; activation_challenge="$(sudo -n cat /var/lib/lba-golden-activation/challenge 2>/dev/null || true)"; if systemctl is-active --quiet display-manager; then display_manager=true; else display_manager=false; fi; if [ "$(systemctl get-default 2>/dev/null || true)" = graphical.target ]; then graphical_target=true; else graphical_target=false; fi; if loginctl show-seat seat0 -p CanGraphical --value 2>/dev/null | grep -Fxq yes; then console_seat=true; else console_seat=false; fi; if command -v LabVIEWCLI >/dev/null 2>&1; then labview_cli=true; else labview_cli=false; fi; printf "bootId=%s\nhostname=%s\nips=%s\nactivationChallenge=%s\ndisplayManager=%s\ngraphicalTarget=%s\nconsoleSeat=%s\nlabviewCli=%s\n" "$boot_id" "$guest_hostname" "$guest_ips" "$activation_challenge" "$display_manager" "$graphical_target" "$console_seat" "$labview_cli"'
  $output = (& vagrant ssh $Vm -c $guestCommand | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "could not inspect console readiness on $Vm"
  }
  $values = @{}
  foreach ($line in $output -split "`r?`n") {
    $parts = $line -split '=', 2
    if ($parts.Count -eq 2) { $values[$parts[0]] = $parts[1] }
  }
  foreach ($name in @('bootId', 'hostname', 'ips', 'activationChallenge', 'displayManager', 'graphicalTarget', 'consoleSeat', 'labviewCli')) {
    if (-not $values.ContainsKey($name)) { throw "console readiness response is missing $name" }
  }
  return [pscustomobject]@{
    bootId = [string]$values.bootId
    hostname = [string]$values.hostname
    ips = @(([string]$values.ips).Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries))
    activationChallenge = [string]$values.activationChallenge
    displayManager = ([string]$values.displayManager -eq 'true')
    graphicalTarget = ([string]$values.graphicalTarget -eq 'true')
    consoleSeat = ([string]$values.consoleSeat -eq 'true')
    labviewCli = ([string]$values.labviewCli -eq 'true')
  }
}

function New-ConsoleReadinessReceipt {
  param([Parameter(Mandatory = $true)]$State)

  $receipt = [pscustomobject][ordered]@{
    schema = 'labview-benchmark-actor/golden-console-readiness@1'
    vm = $Vm
    actor = [pscustomobject][ordered]@{ actorId = $ActorId; hostname = $ActorHostname; ip = $ActorIp }
    guest = [pscustomobject][ordered]@{
      bootId = $State.bootId
      hostname = $State.hostname
      ips = $State.ips
      displayManager = $State.displayManager
      graphicalTarget = $State.graphicalTarget
      consoleSeat = $State.consoleSeat
      labviewCli = $State.labviewCli
    }
    operatorDesktopConfirmed = $OperatorDesktopConfirmed.IsPresent
    confirmedAt = [DateTime]::UtcNow.ToString('o')
    digest = ''
  }
  $canonical = [pscustomobject][ordered]@{
    schema = $receipt.schema
    vm = $receipt.vm
    actor = $receipt.actor
    guest = $receipt.guest
    operatorDesktopConfirmed = $receipt.operatorDesktopConfirmed
    confirmedAt = $receipt.confirmedAt
  }
  $receipt.digest = Get-Sha256Text -Text (ConvertTo-CompactJson -Value $canonical -Depth 6)
  return $receipt
}

function Test-ConsoleReadinessReceipt {
  if (-not (Test-Path -LiteralPath $consoleReceipt -PathType Leaf)) { return $false }
  try {
    $receipt = Get-Content -LiteralPath $consoleReceipt -Raw | ConvertFrom-Json
    $canonical = [pscustomobject][ordered]@{
      schema = [string]$receipt.schema
      vm = [string]$receipt.vm
      actor = $receipt.actor
      guest = $receipt.guest
      operatorDesktopConfirmed = ($receipt.operatorDesktopConfirmed -eq $true)
      confirmedAt = [string]$receipt.confirmedAt
    }
    if ($receipt.schema -ne 'labview-benchmark-actor/golden-console-readiness@1' -or $receipt.vm -ne $Vm -or $receipt.operatorDesktopConfirmed -ne $true) { return $false }
    if ($receipt.actor.actorId -ne $ActorId -or $receipt.actor.hostname -ne $ActorHostname -or $receipt.actor.ip -ne $ActorIp) { return $false }
    if ($receipt.guest.hostname -ne $ActorHostname -or $receipt.guest.ips -notcontains $ActorIp -or -not $receipt.guest.labviewCli -or -not $receipt.guest.displayManager -or -not $receipt.guest.graphicalTarget -or -not $receipt.guest.consoleSeat) { return $false }
    if ($receipt.digest -ne (Get-Sha256Text -Text (ConvertTo-CompactJson -Value $canonical -Depth 6))) { return $false }
    $current = Get-GuestConsoleState
    return $current.bootId -eq $receipt.guest.bootId -and $current.hostname -eq $ActorHostname -and $current.ips -contains $ActorIp -and $current.labviewCli -and $current.displayManager -and $current.graphicalTarget -and $current.consoleSeat
  } catch {
    return $false
  }
}

function Assert-ActivatedReceiptForPackage {
  Assert-EnrollmentIdentity
  if (-not (Test-ConsoleReadinessReceipt)) { throw 'operator desktop-unlock confirmation is missing or stale; run ConsoleReady and Confirm before packaging' }
  if (-not (Test-Path -LiteralPath $activationReceipt -PathType Leaf)) { throw 'activation receipt is missing; run Confirm after operator activation' }
  & node $activationBuilder --validate $activationReceipt | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'activation receipt validation failed; package is blocked' }
  $receipt = Get-Content -LiteralPath $activationReceipt -Raw | ConvertFrom-Json
  if ($null -eq $receipt.PSObject.Properties['actor'] -or $receipt.verdict.activated -ne $true -or $receipt.actor.actorId -ne $ActorId -or $receipt.actor.hostname -ne $ActorHostname -or $receipt.actor.ip -ne $ActorIp) {
    throw 'activation receipt does not confirm the requested golden actor identity'
  }
  $activationChallenge = ''
  if ($null -ne $receipt.PSObject.Properties['freshness'] -and $null -ne $receipt.freshness.PSObject.Properties['challenge']) {
    $activationChallenge = [string]$receipt.freshness.challenge
  }
  if ($activationChallenge -notmatch '^[a-f0-9]{32}$') { throw 'activation receipt lacks a valid post-confirmation challenge; run a fresh Confirm before packaging' }
  $current = Get-GuestConsoleState
  if ($receipt.host.bootId -ne $current.bootId -or $current.hostname -ne $ActorHostname -or $current.ips -notcontains $ActorIp -or $current.activationChallenge -ne $activationChallenge) {
    throw 'the current guest does not match the activation receipt; run a fresh Confirm before packaging'
  }
  return $receipt
}

function Write-ProductionPackageReceipt {
  param([Parameter(Mandatory = $true)]$ActivationReceipt)

  $receipt = [pscustomobject][ordered]@{
    schema = 'labview-benchmark-actor/golden-production-package@1'
    vm = $Vm
    actor = $ActivationReceipt.actor
    activationReceiptDigest = $ActivationReceipt.digest
    boxPath = (Resolve-Path -LiteralPath $ProductionBoxPath).Path
    boxSha256 = ((Get-FileHash -LiteralPath $ProductionBoxPath -Algorithm SHA256).Hash).ToLowerInvariant()
    packagedAt = [DateTime]::UtcNow.ToString('o')
  }
  $canonical = ConvertTo-CompactJson -Value $receipt -Depth 6
  $receipt | Add-Member -NotePropertyName digest -NotePropertyValue (Get-Sha256Text -Text $canonical)
  [System.IO.File]::WriteAllText($packageReceipt, ((ConvertTo-CompactJson -Value $receipt -Depth 6) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  return $receipt
}

function Build-ReadinessReceipt {
  if (-not (Test-Path -LiteralPath $readinessCapture -PathType Leaf)) {
    throw 'golden activation readiness capture was not downloaded'
  }
  & node $readinessBuilder $readinessCapture $readinessReceipt | Out-Host
  $nodeExit = $LASTEXITCODE
  if (-not (Test-Path -LiteralPath $readinessReceipt -PathType Leaf)) {
    throw 'golden activation readiness receipt was not created'
  }
  $receipt = Get-Content -LiteralPath $readinessReceipt -Raw | ConvertFrom-Json
  if ($receipt.schema -ne 'labview-benchmark-actor/golden-activation-readiness@1') {
    throw 'golden activation readiness receipt schema is invalid'
  }
  if ($nodeExit -ne 0 -and $receipt.ready -eq $true) {
    throw 'golden activation readiness builder exited unsuccessfully despite a ready receipt'
  }
  return $receipt
}

function Get-Readiness {
  param([switch]$Repair)

  Send-GuestFile -Source $readinessScript -Destination '/tmp/lba-activation-ready.sh'
  $guestArgs = 'chmod 700 /tmp/lba-activation-ready.sh; bash /tmp/lba-activation-ready.sh --check --out /tmp/lba-activation-readiness.json'
  if ($Repair) {
    Send-GuestFile -Source $provisioner -Destination '/tmp/lba-provision-guest.sh'
    Send-GuestFile -Source $keyring -Destination '/tmp/lba-ni-keyring.asc'
    $guestArgs = 'chmod 700 /tmp/lba-activation-ready.sh /tmp/lba-provision-guest.sh; bash /tmp/lba-activation-ready.sh --repair --provisioner /tmp/lba-provision-guest.sh --keyring /tmp/lba-ni-keyring.asc --out /tmp/lba-activation-readiness.json; rm -f /tmp/lba-provision-guest.sh /tmp/lba-ni-keyring.asc'
  }

  $guestExit = Invoke-VagrantAllowFailure -Arguments @('ssh', $Vm, '-c', $guestArgs)
  Receive-GuestFile -Source '/tmp/lba-activation-readiness.json' -Destination $readinessCapture
  $receipt = Build-ReadinessReceipt
  if ($Repair) {
    Write-Host 'golden repair completed; rebooting the guest once without rerunning Vagrant provisioners'
    Invoke-Vagrant -Arguments @('reload', $Vm, '--no-provision')
    return Get-Readiness
  }
  if ($guestExit -ne 0 -and $receipt.ready -eq $true) {
    throw 'guest readiness check failed despite a ready receipt'
  }
  return $receipt
}

function Invoke-ProductionProvision {
  $receipt = Get-Readiness -Repair
  if (-not $receipt.ready) { throw "golden actor '$Vm' remains incomplete after public provision/reboot: $($receipt.missing -join ', ')" }
  if (-not $receipt.checks.labviewCli) { throw 'LabVIEWCLI is not present after the mandatory post-install reboot' }
  if (-not $receipt.checks.graphicalTarget -or -not $receipt.checks.displayManager -or -not $receipt.checks.consoleSeat) {
    throw 'graphical console readiness is incomplete after the mandatory post-install reboot'
  }
  return $receipt
}

function Confirm-Activation {
  Send-GuestFile -Source $activationProbe -Destination '/tmp/lba-probe-activation.sh'
  Assert-EnrollmentIdentity
  $activationChallenge = [guid]::NewGuid().ToString('N')
  $identityPrefix = "LBA_ACTOR_ID=$ActorId LBA_ACTOR_HOSTNAME=$ActorHostname LBA_ACTOR_IP=$ActorIp LBA_ACTIVATION_CHALLENGE=$activationChallenge "
  $probeExit = Invoke-VagrantAllowFailure -Arguments @('ssh', $Vm, '-c', "rm -f /tmp/lba-activation-capture.json && chmod 700 /tmp/lba-probe-activation.sh && ${identityPrefix}bash /tmp/lba-probe-activation.sh 20 22 /tmp/lba-activation-capture.json")
  Receive-GuestFile -Source '/tmp/lba-activation-capture.json' -Destination $activationCapture
  & node $activationBuilder $activationCapture $activationReceipt | Out-Host
  $builderExit = $LASTEXITCODE
  if (-not (Test-Path -LiteralPath $activationReceipt -PathType Leaf)) {
    throw 'activation receipt was not created'
  }
  $receipt = Get-Content -LiteralPath $activationReceipt -Raw | ConvertFrom-Json
  if ($builderExit -ne 0 -and $receipt.verdict.activated -eq $true) {
    throw 'activation receipt builder failed despite an activated verdict'
  }
  $identityVerified = $null -ne $receipt.actor -and $receipt.actor.actorId -eq $ActorId -and $receipt.actor.hostname -eq $ActorHostname -and $receipt.actor.ip -eq $ActorIp
  $freshnessVerified = $null -ne $receipt.PSObject.Properties['freshness'] -and $null -ne $receipt.freshness.PSObject.Properties['challenge'] -and $receipt.freshness.challenge -eq $activationChallenge
  return [pscustomobject]@{ ProbeExit = $probeExit; Receipt = $receipt; IdentityVerified = $identityVerified; FreshnessVerified = $freshnessVerified }
}

Push-Location $VagrantRoot
try {
  Invoke-Vagrant -Arguments @('validate')
  New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

  switch ($Mode) {
    'Check' {
      $receipt = Get-Readiness
      if ($receipt.ready) {
        Write-Output "golden actor '$Vm' is activation-ready; run -Mode Handoff for the user-only activation step"
        exit 0
      }
      Write-Output "golden actor '$Vm' is not activation-ready: $($receipt.missing -join ', ')"
      exit 1
    }
    'Repair' {
      $receipt = Invoke-ProductionProvision
      Write-Output "golden actor '$Vm' is activation-ready after repair/reboot; run -Mode ConsoleReady -OperatorDesktopConfirmed"
      exit 0
    }
    'Provision' {
      $receipt = Invoke-ProductionProvision
      Write-Output "golden actor '$Vm' completed public LabVIEW provision and reboot; LabVIEWCLI plus graphical console readiness are confirmed"
      exit 0
    }
    'ConsoleReady' {
      Assert-EnrollmentIdentity
      $receipt = Get-Readiness
      if (-not $receipt.ready) {
        Write-Output "golden actor '$Vm' is not ready; run -Mode Provision first: $($receipt.missing -join ', ')"
        exit 1
      }
      $state = Get-GuestConsoleState
      if (-not $state.labviewCli -or -not $state.displayManager -or -not $state.graphicalTarget -or -not $state.consoleSeat) {
        Write-Output "golden actor '$Vm' has no usable graphical activation console; run -Mode Provision again"
        exit 1
      }
      if (-not $OperatorDesktopConfirmed) {
        Write-Output "golden actor '$Vm' graphical console is ready. Open the VMware console, unlock the actor desktop with the local CSV credential, then rerun -Mode ConsoleReady -OperatorDesktopConfirmed"
        exit 1
      }
      $console = New-ConsoleReadinessReceipt -State $state
      [System.IO.File]::WriteAllText($consoleReceipt, ((ConvertTo-CompactJson -Value $console -Depth 6) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
      Write-Output "golden actor '$Vm' console readiness is confirmed; run -Mode Handoff"
      exit 0
    }
    'Handoff' {
      Assert-EnrollmentIdentity
      $receipt = Get-Readiness
      if (-not $receipt.ready) {
        Write-Output "golden actor '$Vm' is not ready; run -Mode Repair first: $($receipt.missing -join ', ')"
        exit 1
      }
      if (-not (Test-ConsoleReadinessReceipt)) {
        Write-Output "golden actor '$Vm' has no current operator desktop-unlock confirmation; run -Mode ConsoleReady -OperatorDesktopConfirmed first"
        exit 1
      }
      Write-Output "GOLDEN ACTIVATION HANDOFF for '$Vm'"
      Write-Output '1. Open the VMware console for the golden actor and launch LabVIEW Community Edition.'
      Write-Output '2. Sign in to NI and activate LabVIEW (and VIPM if it requests activation).'
      Write-Output '3. Type credentials only in the VM console; do not provide them to automation or chat.'
      Write-Output "4. After activation, run: pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm $Vm -Mode Confirm -ActorId $ActorId -ActorHostname $ActorHostname -ActorIp $ActorIp"
      exit 0
    }
    'Confirm' {
      Assert-EnrollmentIdentity
      if (-not (Test-ConsoleReadinessReceipt)) {
        Write-Output "golden actor '$Vm' has no current operator desktop-unlock confirmation; run -Mode ConsoleReady -OperatorDesktopConfirmed first"
        exit 1
      }
      $readiness = Get-Readiness
      if (-not $readiness.ready) {
        Write-Output "golden actor '$Vm' is not activation-ready: $($readiness.missing -join ', ')"
        exit 1
      }
      $result = Confirm-Activation
      if ($result.ProbeExit -eq 0 -and $result.IdentityVerified -and $result.FreshnessVerified -and $result.Receipt.verdict.activated -eq $true) {
        Write-Output "golden actor '$Vm' activation is CONFIRMED; activation receipt: $activationReceipt"
        Write-Output "enroll the current guest: node $registrationScript --receipt $activationReceipt --registry $(Join-Path (Split-Path -Parent $VagrantRoot) 'mesh-actors.csv') --vm $Vm --vagrant-root $VagrantRoot"
        exit 0
      }
      if (-not $result.IdentityVerified) {
        Write-Output "golden actor '$Vm' activation is not enrollable: the requested actor identity did not match the probed guest"
      } elseif (-not $result.FreshnessVerified) {
        Write-Output "golden actor '$Vm' activation is not enrollable: the post-confirmation challenge was not persisted"
      } else {
        Write-Output "golden actor '$Vm' activation remains unconfirmed (probe exit $($result.ProbeExit)); complete the user-only handoff and retry Confirm"
      }
      exit 1
    }
    'Package' {
      $activation = Assert-ActivatedReceiptForPackage
      if (-not (Test-Path -LiteralPath $ProductionVagrantfile -PathType Leaf)) { throw "production Vagrantfile is missing: $ProductionVagrantfile" }
      if (Test-Path -LiteralPath $ProductionBoxPath -PathType Leaf) {
        if (-not $OverwriteProductionBox) { throw "production box already exists: $ProductionBoxPath (use -OverwriteProductionBox to replace it)" }
        Remove-Item -LiteralPath $ProductionBoxPath -Force
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ProductionBoxPath) | Out-Null
      Write-Output "halting confirmed golden actor '$Vm' before production packaging"
      Invoke-Vagrant -Arguments @('halt', $Vm)
      Write-Output "packaging confirmed golden actor '$Vm' -> $ProductionBoxPath"
      Invoke-Vagrant -Arguments @('package', $Vm, '--output', $ProductionBoxPath, '--vagrantfile', $ProductionVagrantfile)
      $package = Write-ProductionPackageReceipt -ActivationReceipt $activation
      Write-Output "production golden package complete: $($package.boxPath)"
      Write-Output "production package receipt: $packageReceipt"
      exit 0
    }
  }
} finally {
  Pop-Location
}
