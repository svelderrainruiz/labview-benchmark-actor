[CmdletBinding()]
param(
  [string]$CacheRoot = 'D:\lba-vagrant-instances\actor-reviewer-local',
  [string]$Vsix,
  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$ExpectedVsixSha256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-AtomicJson([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($temporary, "$(ConvertTo-Json $Value -Depth 30)`n", [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments, [string]$LogPath) {
  $prior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& $FilePath @Arguments 2>&1 | Tee-Object -FilePath $LogPath -Append)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prior
  }
  if ($exitCode -ne 0) { throw "'$FilePath $($Arguments -join ' ')' exited $exitCode. See '$LogPath'." }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Get-JsonFromOutput([object[]]$Output, [string]$Label) {
  foreach ($line in @($Output) | Select-Object -Last 40) {
    $text = "$line" -replace "$([char]27)\[[0-9;?]*[ -/]*[@-~]", ''
    $start = $text.IndexOf('{')
    if ($start -ge 0) {
      try { return ($text.Substring($start) | ConvertFrom-Json) } catch {}
    }
  }
  throw "$Label returned no JSON."
}

$experimentRoot = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $experimentRoot '..\..')).Path
$vsixPath = if ($Vsix) {
  (Resolve-Path -LiteralPath $Vsix).Path
} else {
  Join-Path $repoRoot 'labview-benchmark-actor.vsix'
}
if (-not (Test-Path -LiteralPath $vsixPath)) { throw "Candidate VSIX is missing at '$vsixPath'." }
if ((Get-Item -LiteralPath $vsixPath).Length -gt 5MB) { throw 'Candidate VSIX exceeds the publish size guard.' }
$sourceVsixSha256 = (Get-FileHash -LiteralPath $vsixPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ExpectedVsixSha256 -and $sourceVsixSha256 -ne $ExpectedVsixSha256.ToLowerInvariant()) {
  throw "Candidate VSIX SHA-256 '$sourceVsixSha256' does not match expected '$($ExpectedVsixSha256.ToLowerInvariant())'."
}
$metadataPath = Join-Path $CacheRoot 'reviewer-cache-session.json'
$lockPath = Join-Path $CacheRoot '.reviewer-cache.lock'
if (-not (Test-Path $metadataPath) -or -not (Test-Path $lockPath)) { throw 'Reviewer cache metadata/lock is missing.' }
$metadata = Get-Content $metadataPath -Raw | ConvertFrom-Json
$lock = Get-Content $lockPath -Raw | ConvertFrom-Json
$activeRunId = if ($metadata.PSObject.Properties['activeResume']) { $metadata.activeResume.runId } else { $metadata.runId }
$activeLifecyclePath = if ($metadata.PSObject.Properties['activeResume']) {
  $metadata.activeResume.lifecyclePath
} else {
  $metadata.lifecyclePath
}
$activeEvidenceRoot = if ($metadata.PSObject.Properties['activeResume']) {
  $metadata.activeResume.evidenceRoot
} else {
  $metadata.evidenceRoot
}
if ($lock.runId -ne $activeRunId -or $lock.vmName -ne $metadata.vm.name -or $lock.releasedWallTime) {
  throw 'Reviewer cache lock ownership mismatch.'
}
if ($metadata.state -notin @('activated-capture-passed', 'vsix-installed')) {
  throw "Reviewer cache state '$($metadata.state)' is not ready for VSIX staging."
}
$env:VAGRANT_HOME = $metadata.vagrant.home
$env:VAGRANT_CWD = $metadata.vagrant.cwd
$env:VAGRANT_DOTFILE_PATH = $metadata.vagrant.dotfilePath
$env:LBA_VM_NAME = $metadata.vm.name
$env:LBA_VM_HOSTNAME = $metadata.vm.hostname
$env:VIHS_REVIEWER_BOX = $metadata.vagrant.box
$providerId = (Get-Content (Join-Path $metadata.vagrant.dotfilePath 'machines\default\virtualbox\id') -Raw).Trim()
if ($providerId -ne $metadata.vm.uuid) { throw 'Retained Vagrant provider UUID mismatch.' }
$logPath = Join-Path $activeEvidenceRoot 'vsix-stage.log'

Invoke-Native 'vagrant' @('up', 'default', '--provider', 'virtualbox', '--no-provision') $logPath | Out-Null
Invoke-Native 'vagrant' @(
  'upload',
  (Join-Path $experimentRoot 'vm-guest-ready.ps1'),
  'C:/lba-provision/vm-guest-ready.ps1',
  'default'
) $logPath | Out-Null
$guestResult = Invoke-Native 'vagrant' @(
  'winrm', 'default', '-c',
  'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-guest-ready.ps1'
) $logPath
$guest = Get-JsonFromOutput $guestResult.Output 'Pre-stage interactive user proof'
if ($guest.interactiveExplorerCount -lt 1) { throw 'VSIX staging requires the expected interactive console user.' }

$lifecycle = Get-Content -LiteralPath $activeLifecyclePath -Raw | ConvertFrom-Json
$stageCount = @($lifecycle.checkpoints | Where-Object phase -eq 'REVIEWER-VSIX-STAGE-START').Count
$installedCount = @(
  $lifecycle.checkpoints |
    Where-Object phase -In @('REVIEWER-VSIX-INSTALLED', 'REVIEWER-VSIX-RESTAGED')
).Count
$attempt = $stageCount + 1
$stageStatus = if ($stageCount) { "retry-$attempt-started" } else { 'started' }
$stagePhase = if ($installedCount) { 'REVIEWER-VSIX-RESTAGE-START' } else { 'REVIEWER-VSIX-STAGE-START' }
$installedPhase = if ($installedCount) { 'REVIEWER-VSIX-RESTAGED' } else { 'REVIEWER-VSIX-INSTALLED' }
$worktreeStatus = Join-Path $activeEvidenceRoot "vsix-worktree-status-attempt-$attempt.txt"
$worktreePatch = Join-Path $activeEvidenceRoot "vsix-worktree-attempt-$attempt.patch"
$statusLines = @(& git -C $repoRoot status --porcelain=v1)
if ($LASTEXITCODE) { throw 'Could not capture release worktree status before VSIX staging.' }
$patchLines = @(& git -C $repoRoot diff --binary --full-index HEAD)
if ($LASTEXITCODE) { throw 'Could not capture release worktree patch before VSIX staging.' }
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText(
  $worktreeStatus,
  $(if ($statusLines.Count) { "$($statusLines -join "`n")`n" } else { '' }),
  $utf8
)
[IO.File]::WriteAllText(
  $worktreePatch,
  $(if ($patchLines.Count) { "$($patchLines -join "`n")`n" } else { '' }),
  $utf8
)
$provenance = [ordered]@{
  schema = 'labview-benchmark-actor/local-vsix-worktree@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  path = $repoRoot
  branch = (git -C $repoRoot branch --show-current).Trim()
  commit = (git -C $repoRoot rev-parse HEAD).Trim()
  repository = (git -C $repoRoot config --get remote.origin.url).Trim()
  dirty = (Get-Item $worktreeStatus).Length -gt 0
  status = [ordered]@{
    path = $worktreeStatus
    size = (Get-Item $worktreeStatus).Length
    sha256 = (Get-FileHash $worktreeStatus -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  trackedPatch = [ordered]@{
    path = $worktreePatch
    size = (Get-Item $worktreePatch).Length
    sha256 = (Get-FileHash $worktreePatch -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$provenancePath = Join-Path $activeEvidenceRoot "vsix-worktree-attempt-$attempt.json"
Write-AtomicJson $provenancePath $provenance
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
  '--record', $activeLifecyclePath,
  '--phase', $stagePhase,
  '--status', $stageStatus,
  '--detail', 'Building and staging the current local VSIX into the retained interactive reviewer profile.',
  '--evidence', $provenancePath
) $logPath | Out-Null

Invoke-Native 'powershell.exe' @(
  '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $repoRoot 'reviewer-workstation\stage-local-vsix.ps1'),
  '-SkipBuild',
  '-Vsix', $vsixPath
) $logPath | Out-Null
if ((Get-FileHash -LiteralPath $vsixPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceVsixSha256) {
  throw 'Candidate VSIX changed during staging.'
}

Invoke-Native 'vagrant' @(
  'upload',
  (Join-Path $experimentRoot 'vm-vsix-proof.ps1'),
  'C:/lba-provision/vm-vsix-proof.ps1',
  'default'
) $logPath | Out-Null
$proofResult = Invoke-Native 'vagrant' @(
  'winrm', 'default', '-c',
  'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-vsix-proof.ps1'
) $logPath
$guestProof = Get-JsonFromOutput $proofResult.Output 'Guest VSIX proof'
if (-not $guestProof.checklistPresent -or $guestProof.profile -ne 'interactive') {
  throw 'Guest VSIX/checklist proof did not target the interactive profile.'
}
if ($guestProof.candidateSha256 -ne $sourceVsixSha256) {
  throw 'Guest-staged VSIX SHA-256 differs from the exact host candidate.'
}
if ($guestProof.lbabusVersion -ne '0.15.6') {
  throw 'Guest reviewer did not prove the staged lbabus version.'
}
$packageVersion = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($guestProof.version -ne $packageVersion) { throw 'Installed extension version differs from package.json.' }
$stageReceipt = [ordered]@{
  schema = 'labview-benchmark-actor/windows-vagrant-reviewer-vsix-stage@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  worktree = $provenance
  vsix = [ordered]@{
    path = $vsixPath
    size = (Get-Item $vsixPath).Length
    sha256 = $sourceVsixSha256
    version = $packageVersion
  }
  installProof = $guestProof
  command = 'reviewer-workstation/stage-local-vsix.ps1 -SkipBuild -Vsix <exact-candidate>'
}
$receiptPath = Join-Path $activeEvidenceRoot 'vsix-stage.json'
Write-AtomicJson $receiptPath $stageReceipt
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
  '--record', $activeLifecyclePath,
  '--phase', $installedPhase,
  '--status', 'completed',
  '--detail', 'Current local VSIX passed tests/size gate and is installed in the retained interactive reviewer profile.',
  '--evidence', $receiptPath
) $logPath | Out-Null

$metadata.state = 'vsix-installed'
$metadata | Add-Member -NotePropertyName vsix -NotePropertyValue ([ordered]@{
  path = $stageReceipt.vsix.path
  size = $stageReceipt.vsix.size
  sha256 = $stageReceipt.vsix.sha256
  version = $stageReceipt.vsix.version
  installProof = $guestProof
  provenancePath = $provenancePath
  receiptPath = $receiptPath
}) -Force
$metadata.nextAction = 'Power off, snapshot, and seal the retained reviewer cache.'
Write-AtomicJson $metadataPath $metadata
Write-Host ($metadata | ConvertTo-Json -Depth 15 -Compress)
