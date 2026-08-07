[CmdletBinding()]
param([string]$CacheRoot = 'D:\lba-vagrant-instances\actor-reviewer-local')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-AtomicJson([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($temporary, "$(ConvertTo-Json $Value -Depth 30)`n", [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments, [string]$LogPath, [switch]$AllowFailure) {
  $prior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& $FilePath @Arguments 2>&1 | Tee-Object -FilePath $LogPath -Append)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prior
  }
  if (-not $AllowFailure -and $exitCode -ne 0) {
    throw "'$FilePath $($Arguments -join ' ')' exited $exitCode. See '$LogPath'."
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Get-JsonFromOutput([object[]]$Output, [string]$Label) {
  foreach ($line in @($Output) | Select-Object -Last 30) {
    $text = "$line" -replace "$([char]27)\[[0-9;?]*[ -/]*[@-~]", ''
    $start = $text.IndexOf('{')
    if ($start -ge 0) {
      try { return ($text.Substring($start) | ConvertFrom-Json) } catch {}
    }
  }
  throw "$Label returned no JSON."
}

function MachineValue([string]$Text, [string]$Name) {
  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name))=`"([^`"]*)`"$")
  if ($match.Success) { return $match.Groups[1].Value }
  return $null
}

$experimentRoot = $PSScriptRoot
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
$verificationPending = $metadata.state -eq 'seal-verification-pending'
if ($metadata.state -notin @('vsix-installed', 'seal-verification-pending')) {
  throw "Reviewer cache state '$($metadata.state)' is not ready to seal."
}
$env:VAGRANT_HOME = $metadata.vagrant.home
$env:VAGRANT_CWD = $metadata.vagrant.cwd
$env:VAGRANT_DOTFILE_PATH = $metadata.vagrant.dotfilePath
$env:LBA_VM_NAME = $metadata.vm.name
$env:LBA_VM_HOSTNAME = $metadata.vm.hostname
$env:VIHS_REVIEWER_BOX = $metadata.vagrant.box
$providerId = (Get-Content (Join-Path $metadata.vagrant.dotfilePath 'machines\default\virtualbox\id') -Raw).Trim()
if ($providerId -ne $metadata.vm.uuid) { throw 'Retained provider UUID mismatch.' }
$logPath = Join-Path $activeEvidenceRoot 'reviewer-cache-seal.log'
$info = (Invoke-Native 'VBoxManage' @('showvminfo', $providerId, '--machinereadable') $logPath).Output -join "`n"
if (
  (MachineValue $info 'name') -ne $metadata.vm.name -or
  (MachineValue $info 'hardwareuuid') -ne $metadata.vm.hardwareUuid
) {
  throw 'Retained VM identity mismatch before sealing.'
}

if ($verificationPending) {
  foreach ($required in @($metadata.snapshot.receiptPath, $metadata.cleanupPath, $activeLifecyclePath)) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Pending reviewer cache seal is missing '$required'."
    }
  }
  $pendingLifecycle = Get-Content -LiteralPath $activeLifecyclePath -Raw | ConvertFrom-Json
  if (
    $pendingLifecycle.state -ne 'sealed' -or
    $pendingLifecycle.completion.completedThrough -ne 'REVIEWER-CACHE-READY'
  ) {
    throw 'Pending reviewer cache lifecycle is not sealed through REVIEWER-CACHE-READY.'
  }
  $receiptPath = Join-Path $metadata.evidenceRoot 'reviewer-cache.json'
  Invoke-Native 'node' @(
    (Join-Path $experimentRoot 'build-reviewer-cache.mjs'),
    $CacheRoot,
    $receiptPath
  ) $logPath | Out-Null
  Invoke-Native 'node' @(
    (Join-Path $experimentRoot 'verify-reviewer-cache.mjs'),
    $receiptPath
  ) $logPath | Out-Null
  $metadata.state = 'cache-ready'
  $metadata.vm.state = 'poweroff'
  $metadata.lifecyclePath = $activeLifecyclePath
  $metadata | Add-Member -NotePropertyName lastReviewLifecyclePath -NotePropertyValue $activeLifecyclePath -Force
  $metadata | Add-Member -NotePropertyName lockReleased -NotePropertyValue $true -Force
  if ($metadata.PSObject.Properties['lockReleasePending']) {
    $metadata.PSObject.Properties.Remove('lockReleasePending')
  }
  if ($metadata.PSObject.Properties['activeResume']) {
    $metadata.PSObject.Properties.Remove('activeResume')
  }
  $metadata.nextAction = 'Use reviewer-cache.ps1 -Action Resume; activation must be re-probed before trusted use.'
  Write-AtomicJson $metadataPath $metadata
  Remove-Item -LiteralPath $lockPath -Force
  Invoke-Native 'node' @(
    (Join-Path $experimentRoot 'verify-reviewer-cache.mjs'),
    $receiptPath
  ) $logPath | Out-Null
  Write-Host ($metadata | ConvertTo-Json -Depth 20 -Compress)
  return
}

$guestCleanupPath = Join-Path $activeEvidenceRoot 'reviewer-cache-guest-cleanup.json'
if ((MachineValue $info 'VMState') -ne 'running') {
  Invoke-Native 'vagrant' @('up', 'default', '--provider', 'virtualbox', '--no-provision') $logPath | Out-Null
}
Invoke-Native 'vagrant' @(
  'upload',
  (Join-Path $experimentRoot 'vm-guest-cleanup-proof.ps1'),
  'C:/lba-provision/vm-guest-cleanup-proof.ps1',
  'default'
) $logPath | Out-Null
Invoke-Native 'vagrant' @(
  'upload',
  (Join-Path $experimentRoot 'vm-reviewer-cache-cleanup.ps1'),
  'C:/lba-provision/vm-reviewer-cache-cleanup.ps1',
  'default'
) $logPath | Out-Null
$guestCleanupResult = Invoke-Native 'vagrant' @(
  'winrm', 'default', '-c',
  'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-reviewer-cache-cleanup.ps1'
) $logPath
$guestCleanup = Get-JsonFromOutput $guestCleanupResult.Output 'Reviewer cache guest cleanup'
Write-AtomicJson $guestCleanupPath $guestCleanup
Invoke-Native 'vagrant' @('halt', 'default') $logPath | Out-Null
$info = (Invoke-Native 'VBoxManage' @('showvminfo', $providerId, '--machinereadable') $logPath).Output -join "`n"
if (
  $guestCleanup.labviewProcesses -ne 0 -or
  $guestCleanup.tightVncProcesses -ne 0 -or
  $guestCleanup.captureTasks -ne 0 -or
  $guestCleanup.vncPasswordPresent -or
  $guestCleanup.guestVncSecretPresent -or
  $guestCleanup.interactiveAgentRunPresent -or
  $guestCleanup.interactiveAgentStatePresent -or
  $guestCleanup.interactiveAgentProcesses -ne 0
) {
  throw 'Guest cleanup proof failed before reviewer cache snapshot.'
}

if ((MachineValue $info 'VMState') -ne 'poweroff') { throw 'Retained reviewer VM is not powered off.' }
if ($info -match 'lba-reviewer-vnc-') { throw 'Ephemeral reviewer VNC NAT rule remains.' }

$snapshotName = "reviewer-activated-vsix-$($metadata.vsix.sha256.Substring(0, 12))-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
$snapshotList = Invoke-Native 'VBoxManage' @('snapshot', $providerId, 'list', '--machinereadable') $logPath -AllowFailure
$existingSnapshots = $snapshotList.Output -join "`n"
if ($snapshotList.ExitCode -ne 0 -and $existingSnapshots -notmatch 'does not have any snapshots') {
  throw 'Unable to inspect existing retained reviewer snapshots.'
}
if ($existingSnapshots -match [regex]::Escape("SnapshotName=`"$snapshotName`"")) {
  throw "Snapshot '$snapshotName' already exists; refusing to overwrite cache history."
}
$snapshotOutput = Invoke-Native 'VBoxManage' @(
  'snapshot', $providerId, 'take', $snapshotName,
  '--description', 'Retained reviewer: exact-UUID NI activation, activated MPRR proof, and current local VSIX installed.'
) $logPath
$snapshotMatch = [regex]::Match(($snapshotOutput.Output -join "`n"), 'UUID:\s*([0-9a-f-]{36})', 'IgnoreCase')
if (-not $snapshotMatch.Success) { throw 'VirtualBox did not return the reviewer cache snapshot UUID.' }
$snapshotUuid = $snapshotMatch.Groups[1].Value.ToLowerInvariant()
$snapshotReceipt = [ordered]@{
  schema = 'labview-benchmark-actor/windows-vagrant-reviewer-snapshot@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  vmName = $metadata.vm.name
  vmUuid = $metadata.vm.uuid
  hardwareUuid = $metadata.vm.hardwareUuid
  snapshotName = $snapshotName
  snapshotUuid = $snapshotUuid
  state = 'poweroff'
  activationScope = 'exact-retained-vm-identity'
  vsixSha256 = $metadata.vsix.sha256
}
$snapshotReceiptPath = Join-Path $activeEvidenceRoot 'reviewer-cache-snapshot.json'
Write-AtomicJson $snapshotReceiptPath $snapshotReceipt
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
  '--record', $activeLifecyclePath,
  '--phase', 'REVIEWER-CACHE-SNAPSHOT',
  '--status', 'completed',
  '--detail', 'Powered-off retained reviewer UUID snapshotted after activated capture and local VSIX installation.',
  '--evidence', $snapshotReceiptPath
) $logPath | Out-Null

$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
  $_.LocalPort -in 2222, 55985, 55986, 5900
})
$cleanup = [ordered]@{
  schema = 'labview-benchmark-actor/windows-vagrant-reviewer-cache-cleanup@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  vmPoweredOff = $true
  vncListenerAbsent = @($listeners | Where-Object LocalPort -eq 5900).Count -eq 0
  natListenerAbsent = @($listeners | Where-Object LocalPort -in 2222,55985,55986).Count -eq 0
  listenersAbsent = $listeners.Count -eq 0
  tasksAbsent = $guestCleanup.captureTasks -eq 0
  processesAbsent = $guestCleanup.labviewProcesses -eq 0 -and $guestCleanup.tightVncProcesses -eq 0
  secretsRemoved = -not $guestCleanup.vncPasswordPresent -and -not $guestCleanup.guestVncSecretPresent
  retainedVmPreserved = $true
  guestBootTime = $guestCleanup.bootTime
  guestComputerName = $guestCleanup.computerName
  retainedVmUuid = $metadata.vm.uuid
}
$cleanupPath = Join-Path $activeEvidenceRoot 'reviewer-cache-cleanup.json'
Write-AtomicJson $cleanupPath $cleanup
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
  '--record', $activeLifecyclePath,
  '--phase', 'REVIEWER-CACHE-READY',
  '--status', 'completed',
  '--detail', 'Retained reviewer cache is powered off, snapshotted, clean, and ready for ownership-checked resume.',
  '--evidence', $cleanupPath
) $logPath | Out-Null
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'seal',
  '--record', $activeLifecyclePath,
  '--state', 'reviewer-cache-ready'
) $logPath | Out-Null

$metadata.state = 'seal-verification-pending'
$metadata.vm.state = 'poweroff'
$metadata | Add-Member -NotePropertyName snapshot -NotePropertyValue ([ordered]@{
  name = $snapshotName
  uuid = $snapshotUuid
  receiptPath = $snapshotReceiptPath
}) -Force
$metadata | Add-Member -NotePropertyName cleanupPath -NotePropertyValue $cleanupPath -Force
$metadata | Add-Member -NotePropertyName guestCleanupPath -NotePropertyValue $guestCleanupPath -Force
$metadata | Add-Member -NotePropertyName lockReleased -NotePropertyValue $false -Force
$metadata | Add-Member -NotePropertyName lockReleasePending -NotePropertyValue $true -Force
$metadata.lifecyclePath = $activeLifecyclePath
$metadata.nextAction = 'Retry reviewer-cache-seal.ps1 to complete receipt verification and lock release.'
$lock | Add-Member `
  -NotePropertyName releasePendingWallTime `
  -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) `
  -Force
Write-AtomicJson $lockPath $lock
Write-AtomicJson $metadataPath $metadata

$receiptPath = Join-Path $metadata.evidenceRoot 'reviewer-cache.json'
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'build-reviewer-cache.mjs'),
  $CacheRoot,
  $receiptPath
) $logPath | Out-Null
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'verify-reviewer-cache.mjs'),
  $receiptPath
) $logPath | Out-Null
$metadata.state = 'cache-ready'
$metadata.lifecyclePath = $activeLifecyclePath
$metadata | Add-Member -NotePropertyName lastReviewLifecyclePath -NotePropertyValue $activeLifecyclePath -Force
$metadata | Add-Member -NotePropertyName lockReleased -NotePropertyValue $true -Force
$metadata.PSObject.Properties.Remove('lockReleasePending')
if ($metadata.PSObject.Properties['activeResume']) {
  $metadata.PSObject.Properties.Remove('activeResume')
}
$metadata.nextAction = 'Use reviewer-cache.ps1 -Action Resume; activation must be re-probed before trusted use.'
Write-AtomicJson $metadataPath $metadata
Remove-Item -LiteralPath $lockPath -Force
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'verify-reviewer-cache.mjs'),
  $receiptPath
) $logPath | Out-Null
Write-Host ($metadata | ConvertTo-Json -Depth 20 -Compress)
