<#
.SYNOPSIS
  WIN-plane validation of a release branch in a Hyper-V reviewer guest (the Hyper-V counterpart of win-plane-validate.sh).
.DESCRIPTION
  Bundles the branch from the candidate checkout, copies the bundle and the candidate's own guest-side validator
  (win-plane-validate.ps1) and mask into the guest, runs the validator there, and records its WINPLANE_JSON receipt.
  Exit 0 only when the receipt says winPlaneReady:true and its head is the branch tip on the host.
  Run elevated on the Hyper-V host. The guest needs Node, npm and git (the golden image has them).
.EXAMPLE
  $c = Get-Credential
  .\win-plane-validate.ps1 -VMId <guid> -Credential $c -CandidateRepo C:\work\candidate -Branch release/1.6.7 -OutFile $HOME\lba-vm-share\winplane-1.6.7.json
#>
[CmdletBinding()]
param(
  [string]$VMId, [string]$VMName, [pscredential]$Credential,
  [Parameter(Mandatory)][string]$CandidateRepo,
  [Parameter(Mandatory)][string]$Branch,
  [string]$OutFile = (Join-Path (Join-Path $HOME 'lba-vm-share') 'winplane-receipt.json'),
  [int]$TimeoutSec = 3600,
  [Alias('WhatIf')][switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'LbaHyperV.psm1') -Force
Start-LbaPlan -DryRun:$DryRun
Invoke-LbaMain {
  Assert-LbaArgument ($Branch -match '^[A-Za-z0-9._/-]+$' -and $Branch -notmatch '^-|\.\.|/$') "-Branch is not a plain branch name: $Branch"
  Assert-LbaArgument (Test-Path -LiteralPath (Join-Path $CandidateRepo 'reviewer-workstation\win-plane-validate.ps1')) "-CandidateRepo $CandidateRepo is not a checkout of the candidate"
  Assert-LbaCredential $Credential
  $id = Resolve-LbaVmId -VMId $VMId -VMName $VMName
  $guestDir = 'C:\lba-validate'
  $guestBundle = "$guestDir\rel.bundle"
  $guestScript = "$guestDir\win-plane-validate.ps1"
  $bundle = Join-Path ([IO.Path]::GetTempPath()) ('lba-rel-' + [guid]::NewGuid().ToString('N') + '.bundle')
  try {
    Assert-LbaVmRunning -VMId $id -RequireFileCopy
    [void](Invoke-LbaHost -File git -Arguments @('-C', $CandidateRepo, 'bundle', 'create', $bundle, $Branch))
    [void](Invoke-LbaHost -File git -Arguments @('-C', $CandidateRepo, 'bundle', 'verify', $bundle))
    [void](Invoke-LbaGuest -Name 'create the validation directory' -VMId $id -Credential $Credential -ArgumentList @($guestDir) -Describe "New-Item -ItemType Directory -Force '$guestDir'" -ScriptBlock { param($d) New-Item -ItemType Directory -Force -Path $d | Out-Null })
    Copy-LbaToGuest -VMId $id -Source $bundle -Destination $guestBundle
    Copy-LbaToGuest -VMId $id -Source (Join-Path $CandidateRepo 'reviewer-workstation\labview-mask.cjs') -Destination "$guestDir\labview-mask.cjs"
    Copy-LbaToGuest -VMId $id -Source (Join-Path $CandidateRepo 'reviewer-workstation\win-plane-validate.ps1') -Destination $guestScript
    $lines = Invoke-LbaGuestProgram -Name 'win-plane-validate' -VMId $id -Credential $Credential -TimeoutSec $TimeoutSec -Exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
      -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $guestScript, '-Bundle', $guestBundle, '-Branch', $Branch)
    Add-LbaStep 'host-write' $OutFile 'the WINPLANE_JSON receipt; exit 0 only if winPlaneReady is true and head is the branch tip'
    if (-not (Test-LbaDryRun)) {
      $line = @($lines | Where-Object { $_ -like 'WINPLANE_JSON=*' } | Select-Object -Last 1)
      if ($line.Count -ne 1) { throw 'LBA_GUEST: the guest printed no WINPLANE_JSON line' }
      $json = $line[0].Substring('WINPLANE_JSON='.Length)
      $receipt = $json | ConvertFrom-Json
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
      [IO.File]::WriteAllText($OutFile, $json + "`n", (New-Object Text.UTF8Encoding($false)))
      $tip = ((& git -C $CandidateRepo rev-parse "$Branch^{commit}") -join '').Trim()
      if ($receipt.head -ne $tip) { throw "LBA_GATE: the guest validated $($receipt.head), not the branch tip $tip" }
      if ($receipt.winPlaneReady -ne $true) { throw "LBA_GATE: winPlaneReady is not true (receipt written to $OutFile)" }
      Write-Output "win-plane-validate: winPlaneReady=true head=$tip receipt=$OutFile"
    }
  } finally { if (Test-Path -LiteralPath $bundle) { Remove-Item -Force -LiteralPath $bundle } }
  Write-LbaPlan -Title "win-plane-validate $Branch"
}
