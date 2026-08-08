[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Init', 'Status', 'RepairVsixProof', 'Resume', 'Halt')]
  [string]$Action,
  [string]$CacheRoot = 'D:\lba-vagrant-instances\actor-reviewer-local',
  [string]$VagrantHome = 'D:\vagrant-home',
  [string]$VmName = 'actor-reviewer-local',
  [string]$Hostname = 'actor-reviewer',
  [string]$BoxName = 'actor/win11-labview2026',
  [string]$InstalledExtensionManifest,
  [string]$InstalledExtensionArchive
)

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

function Get-MachineValue([string]$Text, [string]$Name) {
  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name))=`"([^`"]*)`"$")
  if ($match.Success) { return $match.Groups[1].Value }
  return $null
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

if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Reviewer cache orchestration requires Windows.' }
foreach ($command in 'node', 'vagrant', 'VBoxManage') {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command '$command' is unavailable." }
}
if ($Hostname.Length -gt 15 -or $Hostname -notmatch '^[A-Za-z0-9-]+$') {
  throw 'Hostname must be a NetBIOS-compatible name of at most 15 characters.'
}

$experimentRoot = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $experimentRoot '..\..')).Path
$reviewerRoot = Join-Path $repoRoot 'reviewer-workstation'
$statePath = Join-Path $CacheRoot '.vagrant'
$metadataPath = Join-Path $CacheRoot 'reviewer-cache-session.json'
$lockPath = Join-Path $CacheRoot '.reviewer-cache.lock'
$cacheLog = Join-Path $CacheRoot 'reviewer-cache.log'

function Set-VagrantEnvironment {
  $env:VAGRANT_HOME = (Resolve-Path -LiteralPath $VagrantHome).Path
  $env:VAGRANT_CWD = $reviewerRoot
  $env:VAGRANT_DOTFILE_PATH = $statePath
  $env:LBA_VM_NAME = $VmName
  $env:LBA_VM_HOSTNAME = $Hostname
  $env:VIHS_REVIEWER_BOX = $BoxName
}

function Read-CacheMetadata {
  if (-not (Test-Path -LiteralPath $metadataPath)) { throw "Reviewer cache metadata is missing at '$metadataPath'." }
  return Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
}

function Assert-CacheOwnership($Metadata) {
  if ($Metadata.vm.name -ne $VmName) { throw "Reviewer cache VM name '$($Metadata.vm.name)' does not match '$VmName'." }
  $providerIdPath = Join-Path $statePath 'machines\default\virtualbox\id'
  if (-not (Test-Path -LiteralPath $providerIdPath)) { throw 'Persisted Vagrant provider UUID is missing.' }
  $persistedUuid = (Get-Content -LiteralPath $providerIdPath -Raw).Trim()
  if ($persistedUuid -ne $Metadata.vm.uuid) { throw 'Persisted Vagrant provider UUID contradicts cache metadata.' }
  $infoResult = Invoke-Native 'VBoxManage' @('showvminfo', $persistedUuid, '--machinereadable') $cacheLog
  $info = $infoResult.Output -join "`n"
  if (
    (Get-MachineValue $info 'name') -ne $VmName -or
    (Get-MachineValue $info 'UUID') -ne $Metadata.vm.uuid -or
    (Get-MachineValue $info 'hardwareuuid') -ne $Metadata.vm.hardwareUuid
  ) {
    throw 'Live VirtualBox VM identity contradicts retained cache metadata.'
  }
  return $info
}

function Assert-CacheLock($Metadata) {
  if (-not (Test-Path -LiteralPath $lockPath)) { throw "Reviewer cache lock is missing at '$lockPath'." }
  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  $expectedRunId = if ($Metadata.PSObject.Properties['activeResume']) {
    $Metadata.activeResume.runId
  } else {
    $Metadata.runId
  }
  if (
    $lock.schema -ne 'labview-benchmark-actor/windows-vagrant-reviewer-cache-lock@1' -or
    $lock.runId -ne $expectedRunId -or
    $lock.vmName -ne $Metadata.vm.name -or
    $lock.releasedWallTime
  ) {
    throw 'Reviewer cache lock identity/state contradicts cache metadata.'
  }
  return $lock
}

if ($Action -eq 'Init') {
  if (Test-Path -LiteralPath $metadataPath) { throw "Reviewer cache already exists at '$metadataPath'." }
  if (Test-Path -LiteralPath $statePath) { throw "Refusing to reuse pre-existing Vagrant state '$statePath'." }
  New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
  $preexisting = Invoke-Native 'VBoxManage' @('showvminfo', $VmName, '--machinereadable') $cacheLog -AllowFailure
  if ($preexisting.ExitCode -eq 0) { throw "Refusing to reuse pre-existing VM '$VmName'." }

  $runId = "reviewer-cache-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
  $evidenceRoot = Join-Path (Join-Path $experimentRoot 'evidence') $runId
  New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
  $lifecyclePath = Join-Path $evidenceRoot 'vm-lifecycle.json'
  $lock = [ordered]@{
    schema = 'labview-benchmark-actor/windows-vagrant-reviewer-cache-lock@1'
    runId = $runId
    vmName = $VmName
    cacheRoot = $CacheRoot
    acquiredWallTime = [DateTime]::UtcNow.ToString('o')
    releasedWallTime = $null
  }
  Write-AtomicJson $lockPath $lock

  Set-VagrantEnvironment
  $providerUuid = $null
  try {
    Invoke-Native 'node' @(
      (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'init',
      '--record', $lifecyclePath,
      '--lifecycle-id', $runId,
      '--vm-name', $VmName
    ) (Join-Path $evidenceRoot 'node.log') | Out-Null

    $decisionPath = Join-Path $experimentRoot 'decisions\windows-vm-substrate-decision.json'
    $decision = Get-Content -LiteralPath $decisionPath -Raw | ConvertFrom-Json
    $package = Get-Item -LiteralPath $decision.completedLifecycle.registeredBox.packageFile
    $packageHash = (Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($packageHash -ne $decision.completedLifecycle.registeredBox.sha256) {
      throw 'Registered reviewer package SHA-256 no longer matches the VM decision.'
    }
    $boxes = Invoke-Native 'vagrant' @('box', 'list') $cacheLog
    if (($boxes.Output -join "`n") -notmatch "(?m)^$([regex]::Escape($BoxName))\s+\(virtualbox,\s*0,\s*\(amd64\)\)$") {
      throw "Registered box '$BoxName' is missing from '$env:VAGRANT_HOME'."
    }
    Invoke-Native 'vagrant' @('validate') $cacheLog | Out-Null
    Invoke-Native 'node' @(
      (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
      '--record', $lifecyclePath,
      '--phase', 'VM-CREATE-START',
      '--status', 'started',
      '--detail', 'Stable retained reviewer VM import/boot started with provisioning disabled.',
      '--evidence', $decisionPath
    ) (Join-Path $evidenceRoot 'node.log') | Out-Null
    Invoke-Native 'vagrant' @('up', 'default', '--provider', 'virtualbox', '--no-provision') $cacheLog | Out-Null

    $providerIdPath = Join-Path $statePath 'machines\default\virtualbox\id'
    if (-not (Test-Path -LiteralPath $providerIdPath)) { throw 'Vagrant did not persist a provider UUID.' }
    $providerUuid = (Get-Content -LiteralPath $providerIdPath -Raw).Trim()
    $infoResult = Invoke-Native 'VBoxManage' @('showvminfo', $providerUuid, '--machinereadable') $cacheLog
    $info = $infoResult.Output -join "`n"
    $hardwareUuid = Get-MachineValue $info 'hardwareuuid'
    if (
      (Get-MachineValue $info 'name') -ne $VmName -or
      (Get-MachineValue $info 'UUID') -ne $providerUuid -or
      $hardwareUuid -ne $providerUuid
    ) {
      throw 'New retained reviewer VM identity is inconsistent.'
    }

    Invoke-Native 'vagrant' @(
      'upload',
      (Join-Path $experimentRoot 'vm-guest-ready.ps1'),
      'C:/lba-provision/vm-guest-ready.ps1',
      'default'
    ) $cacheLog | Out-Null
    $guestResult = Invoke-Native 'vagrant' @(
      'winrm', 'default', '-c',
      'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-guest-ready.ps1'
    ) $cacheLog
    $guest = Get-JsonFromOutput $guestResult.Output 'Reviewer guest readiness'
    if (-not $guest.labviewPresent -or $guest.interactiveExplorerCount -lt 1) {
      throw 'Reviewer VM lacks LabVIEW or the expected interactive console user.'
    }
    $guestPath = Join-Path $evidenceRoot 'guest-ready.json'
    Write-AtomicJson $guestPath $guest
    Invoke-Native 'node' @(
      (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
      '--record', $lifecyclePath,
      '--phase', 'WINDOWS-INTERACTIVE-READY',
      '--status', 'completed',
      '--detail', 'Stable reviewer VM WinRM and interactive console user are ready.',
      '--evidence', $guestPath
    ) (Join-Path $evidenceRoot 'node.log') | Out-Null

    $metadata = [ordered]@{
      schema = 'labview-benchmark-actor/windows-vagrant-reviewer-cache-session@1'
      state = 'awaiting-activation'
      runId = $runId
      createdWallTime = [DateTime]::UtcNow.ToString('o')
      cacheRoot = $CacheRoot
      vagrant = [ordered]@{
        home = $env:VAGRANT_HOME
        cwd = $env:VAGRANT_CWD
        dotfilePath = $env:VAGRANT_DOTFILE_PATH
        box = $BoxName
        noProvision = $true
      }
      vm = [ordered]@{
        name = $VmName
        hostname = $Hostname
        uuid = $providerUuid
        hardwareUuid = $hardwareUuid
        state = Get-MachineValue $info 'VMState'
      }
      package = [ordered]@{
        path = $package.FullName
        size = $package.Length
        sha256 = $packageHash
      }
      evidenceRoot = $evidenceRoot
      lifecyclePath = $lifecyclePath
      lockPath = $lockPath
      nextAction = 'Complete NI activation interactively for this exact VM UUID, then run activated capture.'
    }
    Write-AtomicJson $metadataPath $metadata
    Write-Host ($metadata | ConvertTo-Json -Depth 10 -Compress)
  } catch {
    $providerIdPath = Join-Path $statePath 'machines\default\virtualbox\id'
    if (-not $providerUuid -and (Test-Path -LiteralPath $providerIdPath)) {
      $candidateUuid = (Get-Content -LiteralPath $providerIdPath -Raw).Trim()
      if ($candidateUuid -match '^[a-f0-9-]{36}$') { $providerUuid = $candidateUuid }
    }
    if ($providerUuid) {
      $candidateInfo = Invoke-Native 'VBoxManage' @('showvminfo', $providerUuid, '--machinereadable') $cacheLog -AllowFailure
      if (
        $candidateInfo.ExitCode -eq 0 -and
        (Get-MachineValue ($candidateInfo.Output -join "`n") 'name') -eq $VmName -and
        (Test-Path $providerIdPath) -and
        (Get-Content $providerIdPath -Raw).Trim() -eq $providerUuid
      ) {
        Invoke-Native 'vagrant' @('destroy', 'default', '-f') $cacheLog -AllowFailure | Out-Null
      }
    }
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Recurse -Force }
    if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force }
    throw
  }
  return
}

$metadata = Read-CacheMetadata
Set-VagrantEnvironment
$info = Assert-CacheOwnership $metadata
$activeLock = if (Test-Path -LiteralPath $lockPath) { Assert-CacheLock $metadata } else { $null }
if ($metadata.state -ne 'cache-ready' -and -not $activeLock) {
  throw 'An unsealed reviewer cache requires its lifecycle lock.'
}

if ($Action -eq 'RepairVsixProof') {
  if ($metadata.state -ne 'cache-ready' -or $activeLock) {
    throw 'VSIX proof repair requires a sealed cache with no active lock.'
  }
  if ((Get-MachineValue $info 'VMState') -ne 'poweroff') {
    throw 'VSIX proof repair requires the retained source VM to remain powered off.'
  }
  if ((Get-MachineValue $info 'CurrentSnapshotUUID') -ne $metadata.snapshot.uuid) {
    throw 'VSIX proof repair source snapshot contradicts cache metadata.'
  }
  if (-not $InstalledExtensionManifest -or -not $InstalledExtensionArchive) {
    throw 'RepairVsixProof requires -InstalledExtensionManifest and -InstalledExtensionArchive.'
  }
  $manifestSource = (Resolve-Path -LiteralPath $InstalledExtensionManifest).Path
  $archiveSource = (Resolve-Path -LiteralPath $InstalledExtensionArchive).Path
  $manifest = Get-Content -LiteralPath $manifestSource -Raw | ConvertFrom-Json
  if (
    $manifest.schema -ne 'labview-benchmark-actor/reviewer-installed-extension-tree@1' -or
    $manifest.extensionId -ne 'svelderrainruiz.labview-benchmark-actor' -or
    $manifest.version -ne $metadata.vsix.version -or
    @($manifest.entries).Count -lt 1
  ) {
    throw 'Installed extension manifest contradicts the cached VSIX identity.'
  }

  $extractRoot = Join-Path ([IO.Path]::GetTempPath()) "lba-reviewer-vsix-proof-$([Guid]::NewGuid().ToString('N'))"
  try {
    Expand-Archive -LiteralPath $archiveSource -DestinationPath $extractRoot
    $archiveFiles = @(Get-ChildItem -LiteralPath $extractRoot -File -Recurse)
    if ($archiveFiles.Count -ne @($manifest.entries).Count) {
      throw 'Installed extension archive file count disagrees with its manifest.'
    }
    foreach ($entry in @($manifest.entries)) {
      $entryPath = Join-Path $extractRoot ($entry.path -replace '/', '\')
      if (-not (Test-Path -LiteralPath $entryPath)) {
        throw "Installed extension archive is missing '$($entry.path)'."
      }
      if (
        (Get-Item -LiteralPath $entryPath).Length -ne $entry.size -or
        (Get-FileHash -LiteralPath $entryPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256
      ) {
        throw "Installed extension archive entry '$($entry.path)' failed identity verification."
      }
    }
  } finally {
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
  }

  $artifactRoot = Join-Path $CacheRoot 'artifacts'
  New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
  $manifestHash = (Get-FileHash -LiteralPath $manifestSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $archiveHash = (Get-FileHash -LiteralPath $archiveSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifestTarget = Join-Path $artifactRoot "installed-extension-$($metadata.vsix.version)-$manifestHash.json"
  $archiveTarget = Join-Path $artifactRoot "installed-extension-$($metadata.vsix.version)-$archiveHash.zip"
  foreach ($copy in @(
    [pscustomobject]@{ Source = $manifestSource; Target = $manifestTarget; Hash = $manifestHash },
    [pscustomobject]@{ Source = $archiveSource; Target = $archiveTarget; Hash = $archiveHash }
  )) {
    if (-not (Test-Path -LiteralPath $copy.Target)) {
      $temporary = "$($copy.Target).$PID.tmp"
      Copy-Item -LiteralPath $copy.Source -Destination $temporary
      if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $copy.Hash) {
        Remove-Item -LiteralPath $temporary -Force
        throw "Recovered artifact '$($copy.Source)' failed copy verification."
      }
      Move-Item -LiteralPath $temporary -Destination $copy.Target
    } elseif ((Get-FileHash -LiteralPath $copy.Target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $copy.Hash) {
      throw "Existing recovered artifact '$($copy.Target)' has an unexpected SHA-256."
    }
  }

  $repairReceiptPath = Join-Path $artifactRoot "vsix-proof-repair-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')).json"
  Write-AtomicJson $repairReceiptPath ([ordered]@{
    schema = 'labview-benchmark-actor/windows-vagrant-reviewer-vsix-proof-repair@1'
    wallTime = [DateTime]::UtcNow.ToString('o')
    reason = 'Historical staging left the timestamped source VSIX at a mutable worktree path.'
    sourceVm = [ordered]@{
      name = $metadata.vm.name
      uuid = $metadata.vm.uuid
      snapshotName = $metadata.snapshot.name
      snapshotUuid = $metadata.snapshot.uuid
      remainedPoweredOff = $true
    }
    historicalVsix = [ordered]@{
      path = $metadata.vsix.path
      size = $metadata.vsix.size
      sha256 = $metadata.vsix.sha256
      version = $metadata.vsix.version
      sourceArtifactRetained = $false
    }
    installedSnapshotProof = [ordered]@{
      manifestPath = $manifestTarget
      manifestSha256 = $manifestHash
      archivePath = $archiveTarget
      archiveSha256 = $archiveHash
      entryCount = @($manifest.entries).Count
    }
  })

  $originalMetadata = Get-Content -LiteralPath $metadataPath -Raw
  $cacheReceipt = Join-Path $metadata.evidenceRoot 'reviewer-cache.json'
  $temporaryReceipt = "$cacheReceipt.$PID.repair"
  try {
    $metadata.vsix | Add-Member -NotePropertyName sourceArtifactRetained -NotePropertyValue $false -Force
    $metadata.vsix | Add-Member -NotePropertyName installedSnapshotManifestPath -NotePropertyValue $manifestTarget -Force
    $metadata.vsix | Add-Member -NotePropertyName installedSnapshotArchivePath -NotePropertyValue $archiveTarget -Force
    $metadata.vsix | Add-Member -NotePropertyName repairReceiptPath -NotePropertyValue $repairReceiptPath -Force
    Write-AtomicJson $metadataPath $metadata
    Invoke-Native 'node' @(
      (Join-Path $experimentRoot 'build-reviewer-cache.mjs'),
      $CacheRoot,
      $temporaryReceipt
    ) $cacheLog | Out-Null
    Invoke-Native 'node' @(
      (Join-Path $experimentRoot 'verify-reviewer-cache.mjs'),
      $temporaryReceipt
    ) $cacheLog | Out-Null
    Move-Item -LiteralPath $temporaryReceipt -Destination $cacheReceipt -Force
    Invoke-Native 'node' @(
      (Join-Path $experimentRoot 'verify-reviewer-cache.mjs'),
      $cacheReceipt
    ) $cacheLog | Out-Null
  } catch {
    [IO.File]::WriteAllText($metadataPath, $originalMetadata, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $temporaryReceipt) { Remove-Item -LiteralPath $temporaryReceipt -Force }
    throw
  }
  Write-Host (@{
    state = 'cache-ready'
    sourceArtifactRetained = $false
    installedSnapshotManifest = $manifestTarget
    installedSnapshotArchive = $archiveTarget
  } | ConvertTo-Json -Compress)
  return
}

if ($Action -eq 'Status') {
  $result = [ordered]@{
    schema = 'labview-benchmark-actor/windows-vagrant-reviewer-cache-status@1'
    wallTime = [DateTime]::UtcNow.ToString('o')
    state = $metadata.state
    lockPresent = Test-Path -LiteralPath $lockPath
    vm = [ordered]@{
      name = $metadata.vm.name
      uuid = $metadata.vm.uuid
      hardwareUuid = $metadata.vm.hardwareUuid
      powerState = Get-MachineValue $info 'VMState'
    }
    lifecyclePath = $metadata.lifecyclePath
    evidenceRoot = $metadata.evidenceRoot
  }
  Write-Host ($result | ConvertTo-Json -Depth 10 -Compress)
  return
}

if ($Action -eq 'Resume') {
  if ($metadata.state -eq 'cache-ready') {
    if ($activeLock) { throw 'A reviewer cache resume is already active.' }
    $cacheReceipt = Join-Path $metadata.evidenceRoot 'reviewer-cache.json'
    if (-not (Test-Path -LiteralPath $cacheReceipt)) {
      throw 'Reviewer cache receipt is missing; refusing resume.'
    }
    Invoke-Native 'node' @(
      (Join-Path $experimentRoot 'verify-reviewer-cache.mjs'),
      $cacheReceipt
    ) $cacheLog | Out-Null
    $resumeRunId = "reviewer-cache-resume-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
    $resumeEvidence = Join-Path (Join-Path $experimentRoot 'evidence') $resumeRunId
    New-Item -ItemType Directory -Path $resumeEvidence -Force | Out-Null
    $resumeLifecycle = Join-Path $resumeEvidence 'vm-lifecycle.json'
    Invoke-Native 'node' @(
      (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'init',
      '--record', $resumeLifecycle,
      '--lifecycle-id', $resumeRunId,
      '--vm-name', $metadata.vm.name
    ) (Join-Path $resumeEvidence 'node.log') | Out-Null
    $newLock = [ordered]@{
      schema = 'labview-benchmark-actor/windows-vagrant-reviewer-cache-lock@1'
      runId = $resumeRunId
      vmName = $metadata.vm.name
      cacheRoot = $CacheRoot
      acquiredWallTime = [DateTime]::UtcNow.ToString('o')
      releasedWallTime = $null
    }
    Write-AtomicJson $lockPath $newLock
    $metadata | Add-Member -NotePropertyName activeResume -NotePropertyValue ([ordered]@{
      runId = $resumeRunId
      lifecyclePath = $resumeLifecycle
      evidenceRoot = $resumeEvidence
      activationProbeRequired = $true
    }) -Force
    $metadata.state = 'resume-activation-probe-required'
    Write-AtomicJson $metadataPath $metadata
  }
  if ((Get-MachineValue $info 'VMState') -eq 'poweroff') {
    Invoke-Native 'vagrant' @('up', 'default', '--provider', 'virtualbox', '--no-provision') $cacheLog | Out-Null
  }
  Write-Host '{"state":"running","activationProbeRequired":true}'
  return
}

if ($Action -eq 'Halt') {
  if ((Get-MachineValue $info 'VMState') -ne 'poweroff') {
    Invoke-Native 'vagrant' @('halt', 'default') $cacheLog | Out-Null
  }
  Write-Host '{"state":"poweroff"}'
}
