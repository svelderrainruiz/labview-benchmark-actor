[CmdletBinding()]
param(
  [string]$ExpectedExtensionId = 'svelderrainruiz.labview-benchmark-actor',
  [string]$ChecklistPath = 'C:\lba-review\REVIEW-CHECKLIST.txt',
  [string]$CandidatePath = 'C:\lba-review\candidate.vsix'
)

$ErrorActionPreference = 'Stop'
$interactiveUser = (Get-CimInstance Win32_ComputerSystem).UserName
$explorer = @(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0)
if (-not $interactiveUser -or $explorer.Count -eq 0) {
  throw 'No interactive console user is available for VSIX verification.'
}

$code = Get-Command code.cmd, code.exe, code -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $code) { throw 'VS Code command is unavailable in the reviewer VM.' }
$extensions = @(& $code.Source --list-extensions --show-versions 2>&1)
$installed = $extensions | Where-Object { $_ -match "^$([regex]::Escape($ExpectedExtensionId))@" } | Select-Object -First 1
if (-not $installed) { throw "Extension '$ExpectedExtensionId' is not installed." }
if (-not (Test-Path -LiteralPath $CandidatePath)) { throw "Staged candidate is missing at '$CandidatePath'." }
$lbabusPath = 'C:\lba-tools\lbabus\lbabus.exe'
if (-not (Test-Path -LiteralPath $lbabusPath)) { throw "Reviewer lbabus is missing at '$lbabusPath'." }
$lbabusVersion = (& $lbabusPath version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $lbabusVersion -ne '0.15.8') {
  throw "Reviewer lbabus version '$lbabusVersion' is invalid."
}

[pscustomobject]@{
  schema = 'labview-benchmark-actor/windows-vagrant-reviewer-vsix-proof@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  interactiveUser = $interactiveUser
  interactiveSessionIds = @($explorer.SessionId | Sort-Object -Unique)
  profile = 'interactive'
  extension = $installed
  extensionId = $ExpectedExtensionId
  version = ($installed -split '@', 2)[1]
  codeCommand = $code.Source
  checklistPath = $ChecklistPath
  checklistPresent = Test-Path -LiteralPath $ChecklistPath
  candidatePath = $CandidatePath
  candidateSize = (Get-Item -LiteralPath $CandidatePath).Length
  candidateSha256 = (Get-FileHash -LiteralPath $CandidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
  lbabusPath = $lbabusPath
  lbabusVersion = $lbabusVersion
} | ConvertTo-Json -Compress
