<#
.SYNOPSIS
  The host side of the reviewer visual verdict for a Hyper-V guest (the Hyper-V counterpart of render-verdict.sh).
.DESCRIPTION
  guard       fail unless the VSIX staged in the guest is byte-identical to the candidate (reviewed == shipped)
  set-target  guard, then write handoff\review-target.json into the guest (what is under review)
  collect     copy the verdict the reviewer signed in the guest (handoff\verdicts\<component>-<version>.json) to -Out
  The human renders and signs the verdict inside the guest; the private key never leaves it. Run elevated on the Hyper-V host.
.EXAMPLE
  .\render-verdict.ps1 set-target -VMId <guid> -Credential $c -Version 1.6.7 -Commit <40-hex> -VsixSha256 <64-hex> -CandidateRepo C:\work\candidate -Evidence 'windows-stage:stage-1.6.7-abcdef0-json'
  .\render-verdict.ps1 collect -VMId <guid> -Credential $c -Version 1.6.7 -Out $HOME\lba-vm-share\visual-verdict-1.6.7.json
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('guard', 'set-target', 'collect')][string]$Action,
  [string]$VMId, [string]$VMName, [pscredential]$Credential,
  [Parameter(Mandatory)][string]$Version,
  [string]$Commit, [string]$VsixSha256, [string[]]$Evidence = @(),
  [string]$Component = 'extension',
  [string]$CandidateRepo, [string]$GuestUser, [string]$Out,
  [string]$Node = 'node',
  [Alias('WhatIf')][switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'LbaHyperV.psm1') -Force
Start-LbaPlan -DryRun:$DryRun
Invoke-LbaMain {
  $toolingRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  Assert-LbaArgument ($Version -match '^\d+\.\d+\.\d+$') "-Version must be X.Y.Z, got $Version"
  Assert-LbaArgument ($Component -match '^[a-z][a-z0-9-]*$') "-Component is not a component name: $Component"
  Assert-LbaCredential $Credential
  Assert-LbaElevated
  $id = Resolve-LbaVmId -VMId $VMId -VMName $VMName
  $user = Get-LbaGuestUser -Credential $Credential -GuestUser $GuestUser
  Assert-LbaVmRunning -VMId $id -RequireFileCopy:($Action -eq 'set-target')
  if ($Action -ne 'collect') {
    Assert-LbaArgument ($VsixSha256 -match '^[0-9a-fA-F]{64}$') '-VsixSha256 must be the candidate 64-hex sha256'
    Assert-LbaArgument ([bool]$CandidateRepo) '-CandidateRepo is required (its verify-staged-vsix.mjs is the guard)'
    Assert-LbaArgument ($Action -eq 'guard' -or $Commit -match '^[0-9a-f]{40}$') '-Commit must be a full 40-character sha'
  }
  switch ($Action) {
    'guard' {
      $staged = Get-LbaGuestSha256 -VMId $id -Credential $Credential -Path 'C:\lba-review\candidate.vsix'
      if (-not (Test-LbaDryRun) -and -not $staged) { throw 'LBA_GATE: no candidate VSIX is staged in the guest at C:\lba-review\candidate.vsix' }
      if (Test-LbaDryRun) { $staged = '<sha256 of the staged VSIX in the guest>' }
      [void](Invoke-LbaHost -File $Node -Arguments @((Join-Path $CandidateRepo 'reviewer-workstation\verify-staged-vsix.mjs'), '--candidate-sha256', $VsixSha256, '--staged-sha256', $staged) -FailAs GATE)
    }
    'set-target' {
      Set-LbaReviewTarget -VMId $id -Credential $Credential -GuestUser $user -Version $Version -Commit $Commit -VsixSha256 $VsixSha256 -Evidence $Evidence `
        -Node $Node -ToolingRoot $toolingRoot -CandidateRoot $CandidateRepo -Component $Component
      if (-not (Test-LbaDryRun)) { Write-Output "render-verdict: review target set in the guest: $Component $Version. Run 'Render Reviewer Verdict' in the guest to sign." }
    }
    'collect' {
      Assert-LbaArgument ([bool]$Out) 'collect requires -Out <file.json>'
      $src = "C:\Users\$user\AppData\Roaming\Code\User\globalStorage\svelderrainruiz.labview-benchmark-actor\handoff\verdicts\$Component-$Version.json"
      if (-not (Test-LbaDryRun)) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null }
      Copy-LbaFromGuest -VMId $id -Credential $Credential -Source $src -Destination $Out
      if (-not (Test-LbaDryRun)) {
        try { [void](Get-Content -Raw -LiteralPath $Out | ConvertFrom-Json) } catch { throw "LBA_GATE: the collected verdict is not valid JSON: $Out" }
        Write-Output "render-verdict: collected the signed verdict -> $Out"
      }
    }
  }
  Write-LbaPlan -Title "render-verdict $Action"
}
