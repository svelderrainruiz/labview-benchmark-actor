<#
.SYNOPSIS
  The host side of the machine quorum sign-off for a Hyper-V guest (the Hyper-V counterpart of render-quorum.sh).
.DESCRIPTION
  stage    copy the host attestation to C:\lba-review\attestation-<version>.json in the guest
  sign     in the guest, run the candidate's sign-release-quorum.mjs from C:\lba-validate\repo with the enrolled key
           C:\lba-review\reviewer-vitech.pem; the private key never leaves the guest, only the public sign-off is written
  collect  copy C:\lba-review\quorum-signoff-<version>.json to -Out
  verify   on the host, verify the sign-off against the attestation and the enrolled reviewer allowlist (needs no guest)
  all      stage, sign, collect, verify
  Needs the guest repo clone left by win-plane-validate.ps1 and the enrolled key in the guest. Run elevated on the Hyper-V host.
.EXAMPLE
  .\render-quorum.ps1 all -VMId <guid> -Credential $c -Version 1.6.7 -Attestation $HOME\lba-vm-share\attestation-1.6.7.json -CandidateRepo C:\work\candidate
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('stage', 'sign', 'collect', 'verify', 'all')][string]$Action,
  [string]$VMId, [string]$VMName, [pscredential]$Credential,
  [Parameter(Mandatory)][string]$Version,
  [string]$Attestation, [string]$Signoff, [string]$Out,
  [Parameter(Mandatory)][string]$CandidateRepo,
  [string]$Reviewer = 'reviewer@vi-tech.nl',
  [string]$GuestKey = 'C:\lba-review\reviewer-vitech.pem',
  [string]$Node = 'node',
  [int]$TimeoutSec = 120,
  [Alias('WhatIf')][switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'LbaHyperV.psm1') -Force
Start-LbaPlan -DryRun:$DryRun
Invoke-LbaMain {
  Assert-LbaArgument ($Version -match '^\d+\.\d+\.\d+$') "-Version must be X.Y.Z, got $Version"
  Assert-LbaArgument ($Reviewer -match '^[A-Za-z0-9._@+-]+$') "-Reviewer is not an identity: $Reviewer"
  Assert-LbaArgument ($GuestKey -match '^[A-Za-z]:\\[A-Za-z0-9._\\-]+$') "-GuestKey is not a plain guest path: $GuestKey"
  if (-not $Out) { $Out = Join-Path (Join-Path $HOME 'lba-vm-share') "quorum-signoff-$Version.json" }
  $guestAtt = "C:\lba-review\attestation-$Version.json"
  $guestSignoff = "C:\lba-review\quorum-signoff-$Version.json"
  $needsGuest = $Action -ne 'verify'
  $id = $null
  if ($needsGuest) {
    Assert-LbaCredential $Credential
    Assert-LbaElevated
    $id = Resolve-LbaVmId -VMId $VMId -VMName $VMName
    Assert-LbaVmRunning -VMId $id -RequireFileCopy:($Action -in 'stage', 'all')
  }
  if ($Action -in 'stage', 'verify', 'all') { Assert-LbaArgument ([bool]$Attestation -and (Test-Path -LiteralPath $Attestation)) "$Action needs -Attestation <existing host file>" }

  if ($Action -in 'stage', 'all') {
    [void](Invoke-LbaGuest -Name 'create the staging directory' -VMId $id -Credential $Credential -ArgumentList @('C:\lba-review') -Describe "New-Item -ItemType Directory -Force 'C:\lba-review'" -ScriptBlock { param($d) New-Item -ItemType Directory -Force -Path $d | Out-Null })
    Copy-LbaToGuest -VMId $id -Source $Attestation -Destination $guestAtt
  }
  if ($Action -in 'sign', 'all') {
    $cmd = "cd /d C:\lba-validate\repo && node reviewer-workstation\sign-release-quorum.mjs --key $GuestKey --reviewer $Reviewer --station WINDOWS_VM --quorum $guestAtt --out $guestSignoff"
    [void](Invoke-LbaGuestProgram -Name 'sign the quorum in the guest' -VMId $id -Credential $Credential -TimeoutSec $TimeoutSec -Exe 'cmd.exe' -Arguments @('/c', $cmd))
  }
  if ($Action -in 'collect', 'all') {
    if (-not (Test-LbaDryRun)) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null }
    Copy-LbaFromGuest -VMId $id -Credential $Credential -Source $guestSignoff -Destination $Out
  }
  if ($Action -in 'verify', 'all') {
    $file = $Out
    if ($Signoff) { $file = $Signoff }
    $verify = Join-Path $CandidateRepo 'reviewer-workstation\verify-quorum-signoff.mjs'
    $allow = Join-Path $CandidateRepo 'tools\release-governance\reviewer-allowlist.json'
    [void](Invoke-LbaHost -File $Node -Arguments @($verify, '--attestation', $Attestation, '--signoff', $file, '--allowlist', $allow) -FailAs GATE)
    if (-not (Test-LbaDryRun)) { Write-Output "render-quorum: verified the quorum sign-off for $Version at $file (the private key never left the guest)" }
  }
  Write-LbaPlan -Title "render-quorum $Action"
}
