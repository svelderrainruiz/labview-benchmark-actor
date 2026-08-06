#requires -Version 5
<#+
.SYNOPSIS
  Validate, replace, and attest a local Ubuntu mesh provisioning cycle.
#>
[CmdletBinding()]
param(
  [ValidateSet('vmware_desktop', 'virtualbox')]
  [string]$Provider = 'vmware_desktop',
  [switch]$Plan,
  [switch]$Apply,
  [switch]$Replace,
  [switch]$VerifyReceipt,
  [switch]$SelfTest,
  [ValidateRange(5, 300)]
  [int]$MeshProofTimeoutSec = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'provision-cycle-v2.ps1') @PSBoundParameters
exit $LASTEXITCODE