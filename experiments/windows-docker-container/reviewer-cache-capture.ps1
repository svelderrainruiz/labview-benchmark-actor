[CmdletBinding()]
param(
  [string]$CacheRoot = 'D:\lba-vagrant-instances\actor-reviewer-local',
  [ValidateRange(30000, 300000)][int]$DurationMs = 90000
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

function MachineValue([string]$Text, [string]$Name) {
  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name))=`"([^`"]*)`"$")
  if ($match.Success) { return $match.Groups[1].Value }
  return $null
}

$experimentRoot = $PSScriptRoot
$metadataPath = Join-Path $CacheRoot 'reviewer-cache-session.json'
$lockPath = Join-Path $CacheRoot '.reviewer-cache.lock'
if (-not (Test-Path -LiteralPath $metadataPath) -or -not (Test-Path -LiteralPath $lockPath)) {
  throw 'Reviewer cache metadata or exclusive lock is missing.'
}
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
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
if ($metadata.state -notin @(
  'awaiting-activation',
  'resume-activation-probe-required',
  'activated-capture-passed'
)) {
  throw "Reviewer cache state '$($metadata.state)' is not valid for an activation capture."
}
if ($lock.runId -ne $activeRunId -or $lock.vmName -ne $metadata.vm.name -or $lock.releasedWallTime) {
  throw 'Reviewer cache lock does not own this VM lifecycle.'
}
$env:VAGRANT_HOME = $metadata.vagrant.home
$env:VAGRANT_CWD = $metadata.vagrant.cwd
$env:VAGRANT_DOTFILE_PATH = $metadata.vagrant.dotfilePath
$env:LBA_VM_NAME = $metadata.vm.name
$env:LBA_VM_HOSTNAME = $metadata.vm.hostname
$env:VIHS_REVIEWER_BOX = $metadata.vagrant.box
$providerIdPath = Join-Path $metadata.vagrant.dotfilePath 'machines\default\virtualbox\id'
if (-not (Test-Path -LiteralPath $providerIdPath)) { throw 'Retained provider UUID file is missing.' }
$providerUuid = (Get-Content -LiteralPath $providerIdPath -Raw).Trim()
if ($providerUuid -ne $metadata.vm.uuid) { throw 'Retained provider UUID contradicts cache metadata.' }
$logPath = Join-Path $activeEvidenceRoot 'reviewer-capture.log'
$infoResult = Invoke-Native 'VBoxManage' @('showvminfo', $providerUuid, '--machinereadable') $logPath
$info = $infoResult.Output -join "`n"
if (
  (MachineValue $info 'name') -ne $metadata.vm.name -or
  (MachineValue $info 'UUID') -ne $metadata.vm.uuid -or
  (MachineValue $info 'hardwareuuid') -ne $metadata.vm.hardwareUuid -or
  (MachineValue $info 'VMState') -ne 'running'
) {
  throw 'Retained reviewer VM identity/state does not match the activation target.'
}

$captureRoot = Join-Path $activeEvidenceRoot 'activated-capture'
$secretRoot = Join-Path ([IO.Path]::GetTempPath()) "$activeRunId-capture-secrets"
$passwordFile = Join-Path $secretRoot 'vnc-password.txt'
$natRule = "lba-reviewer-vnc-$($activeRunId.Substring($activeRunId.Length - 8))"
$hostPort = $null
$guestArtifactsUploaded = $false
$guestCleanup = $null
$capturePassed = $false
$activationRequired = $false
$mainError = $null
if (Test-Path -LiteralPath $captureRoot) {
  if (Test-Path -LiteralPath (Join-Path $captureRoot 'manifest.json')) {
    throw 'A finalized activated capture already exists; refusing to overwrite it.'
  }
  Remove-Item -LiteralPath $captureRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $captureRoot, $secretRoot -Force | Out-Null

try {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = [byte[]]::new(8)
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $password = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  [IO.File]::WriteAllText($passwordFile, $password, [Text.UTF8Encoding]::new($false))
  $password = $null
  $principal = "$env:USERDOMAIN\$env:USERNAME"
  & icacls.exe $secretRoot /inheritance:r /grant:r "${principal}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE) { throw 'Failed to restrict reviewer capture secret ACL.' }

  $uploads = @(
    @{ Source = (Join-Path $experimentRoot 'vm-bootstrap.ps1'); Destination = 'C:/lba-provision/vm-bootstrap.ps1' },
    @{ Source = (Join-Path $experimentRoot 'vm-launch.ps1'); Destination = 'C:/lba-provision/vm-launch.ps1' },
    @{ Source = (Join-Path $experimentRoot 'vm-launch-vagrant.ps1'); Destination = 'C:/lba-provision/vm-launch-vagrant.ps1' },
    @{ Source = (Join-Path $experimentRoot 'vm-cleanup-vagrant.ps1'); Destination = 'C:/lba-provision/vm-cleanup-vagrant.ps1' },
    @{ Source = (Join-Path $experimentRoot 'vm-guest-cleanup-proof.ps1'); Destination = 'C:/lba-provision/vm-guest-cleanup-proof.ps1' },
    @{ Source = (Join-Path $experimentRoot 'vm-vagrant-interactive-agent.ps1'); Destination = 'C:/lba-provision/vm-vagrant-interactive-agent.ps1' },
    @{ Source = (Join-Path $experimentRoot 'display-surface.cs'); Destination = 'C:/lba-provision/display-surface.cs' },
    @{ Source = $passwordFile; Destination = 'C:/lba-provision/.vnc-password' }
  )
  foreach ($upload in $uploads) {
    Invoke-Native 'vagrant' @('upload', $upload.Source, $upload.Destination, 'default') $logPath | Out-Null
  }
  $guestArtifactsUploaded = $true
  $bootstrapResult = Invoke-Native 'vagrant' @(
    'winrm', 'default', '-c',
    'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-bootstrap.ps1 -PasswordFile C:\lba-provision\.vnc-password -UseLoginAgent'
  ) $logPath
  $bootstrap = Get-JsonFromOutput $bootstrapResult.Output 'Reviewer TightVNC bootstrap'
  if (-not $bootstrap.rebootRequired) { throw 'Reviewer login-agent bootstrap did not require a governed reboot.' }
  Invoke-Native 'vagrant' @('reload', 'default', '--no-provision') $logPath | Out-Null
  $agentDeadline = [DateTime]::UtcNow.AddMinutes(3)
  $readyResult = $null
  do {
    $candidate = Invoke-Native 'vagrant' @(
      'winrm', 'default', '-c',
      'cmd.exe /c type C:\lba-provision\interactive-agent-ready.json'
    ) $logPath -AllowFailure
    if ($candidate.ExitCode -eq 0) {
      $readyResult = $candidate
      break
    }
    Start-Sleep -Seconds 5
  } while ([DateTime]::UtcNow -lt $agentDeadline)
  if (-not $readyResult) { throw 'Reviewer interactive login agent did not become ready within three minutes.' }
  $agentReady = Get-JsonFromOutput $readyResult.Output 'Reviewer interactive login agent'
  if ($agentReady.sessionId -lt 1 -or $agentReady.listener.port -ne 5900) {
    throw 'Reviewer interactive login agent did not prove session-1 TightVNC readiness.'
  }

  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $hostPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  Invoke-Native 'VBoxManage' @(
    'controlvm', $providerUuid, 'natpf1',
    "$natRule,tcp,127.0.0.1,$hostPort,,5900"
  ) $logPath | Out-Null
  $capturePath = [ordered]@{
    schema = 'labview-benchmark-actor/windows-vagrant-reviewer-capture-path@1'
    vmName = $metadata.vm.name
    vmUuid = $metadata.vm.uuid
    hardwareUuid = $metadata.vm.hardwareUuid
    hostEndpoint = "127.0.0.1:$hostPort"
    loopbackOnly = $true
    bootstrap = $bootstrap
    interactiveAgent = $agentReady
  }
  $capturePathFile = Join-Path $activeEvidenceRoot "activated-capture-path-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')).json"
  Write-AtomicJson $capturePathFile $capturePath

  $lifecycle = Get-Content -LiteralPath $activeLifecyclePath -Raw | ConvertFrom-Json
  $postCaptureCount = @($lifecycle.checkpoints | Where-Object phase -eq 'POST-ACTIVATION-CAPTURE-START').Count
  $postStatus = if ($postCaptureCount) { "retry-$($postCaptureCount + 1)-started" } else { 'started' }
  Invoke-Native 'node' @(
    (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
    '--record', $activeLifecyclePath,
    '--phase', 'POST-ACTIVATION-CAPTURE-START',
    '--status', $postStatus,
    '--detail', 'Retained reviewer activated-IDE capture armed before LabVIEW launch.',
    '--evidence', $capturePathFile
  ) $logPath | Out-Null

  $capture = Invoke-Native 'node' @(
    (Join-Path $experimentRoot 'vm-capture.mjs'),
    '--vm-name', $metadata.vm.name,
    '--vnc-port', "$hostPort",
    '--password-file', $passwordFile,
    '--evidence-dir', $captureRoot,
    '--duration-ms', "$DurationMs",
    '--dimension-stable-ms', '3000',
    '--vagrant-cwd', $metadata.vagrant.cwd,
    '--vagrant-machine', 'default'
  ) $logPath -AllowFailure
  $summary = Get-Content -LiteralPath (Join-Path $captureRoot 'capture-summary.json') -Raw | ConvertFrom-Json
  if ($capture.ExitCode -eq 0 -and $summary.outcome -eq 'passed' -and $summary.visibility.passed) {
    $capturePassed = $true
  } elseif (
    $capture.ExitCode -eq 4 -and
    $summary.outcome -eq 'blocked' -and
    $summary.classification -eq 'labview-activation-required'
  ) {
    $activationRequired = $true
  } else {
    throw "Reviewer capture exited $($capture.ExitCode) without a verified activated-IDE or activation-required receipt."
  }
} catch {
  $mainError = $_
} finally {
  if ($guestArtifactsUploaded) {
    try {
      $cleanupResult = Invoke-Native 'vagrant' @(
        'winrm', 'default', '-c',
        'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-cleanup-vagrant.ps1'
      ) $logPath -AllowFailure
      $guestCleanup = Get-JsonFromOutput $cleanupResult.Output 'Reviewer guest cleanup'
      Write-AtomicJson (Join-Path $captureRoot 'guest-cleanup-verification.json') $guestCleanup
    } catch {
      if (-not $mainError) { $mainError = $_ }
    }
  }
  if ($hostPort) {
    try { Invoke-Native 'VBoxManage' @('controlvm', $providerUuid, 'natpf1', 'delete', $natRule) $logPath | Out-Null }
    catch { if (-not $mainError) { $mainError = $_ } }
  }
  if (Test-Path -LiteralPath $secretRoot) { Remove-Item -LiteralPath $secretRoot -Recurse -Force }
}

if ($mainError) { throw $mainError }
if ($activationRequired) {
  $metadata.state = 'awaiting-activation'
  $metadata.nextAction = 'Complete NI activation for this exact retained VM UUID, then rerun reviewer-cache-capture.ps1.'
  Write-AtomicJson $metadataPath $metadata
  throw 'NI activation is still required for the retained reviewer VM.'
}
if (-not $capturePassed) { throw 'Activated reviewer capture did not complete.' }

Invoke-Native 'vagrant' @('halt', 'default') $logPath | Out-Null
$postInfo = (Invoke-Native 'VBoxManage' @('showvminfo', $providerUuid, '--machinereadable') $logPath).Output -join "`n"
$cleanup = [ordered]@{
  schema = 'labview-benchmark-actor/windows-vagrant-reviewer-capture-cleanup@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  vmPoweredOff = (MachineValue $postInfo 'VMState') -eq 'poweroff'
  natRuleRemoved = $postInfo -notmatch [regex]::Escape($natRule)
  hostVncSecretRemoved = -not (Test-Path -LiteralPath $secretRoot)
  guestVncSecretRemoved = [bool]($guestCleanup -and -not $guestCleanup.guestVncSecretPresent)
  vncPasswordRegistryRemoved = [bool]($guestCleanup -and -not $guestCleanup.vncPasswordPresent)
  captureTasksRemoved = [bool]($guestCleanup -and $guestCleanup.captureTasks -eq 0)
  captureProcessesStopped = [bool]($guestCleanup -and $guestCleanup.labviewProcesses -eq 0 -and $guestCleanup.tightVncProcesses -eq 0)
  loopbackVncListenerRemoved = -not [bool](Get-NetTCPConnection -State Listen -LocalPort $hostPort -ErrorAction SilentlyContinue)
  retainedVmPreserved = (MachineValue $postInfo 'UUID') -eq $metadata.vm.uuid
}
Write-AtomicJson (Join-Path $captureRoot 'cleanup-verification.json') $cleanup
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'verify-vm-capture.mjs'),
  '--finalize-and-verify', $captureRoot
) $logPath | Out-Null
$manifest = Join-Path $captureRoot 'manifest.json'
Invoke-Native 'node' @(
  (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
  '--record', $activeLifecyclePath,
  '--phase', 'LABVIEW-IDE-SETTLED',
  '--status', 'completed',
  '--detail', 'Retained reviewer UUID produced verified activated LabVIEW IDE evidence.',
  '--evidence', $manifest
) $logPath | Out-Null

$summary = Get-Content -LiteralPath (Join-Path $captureRoot 'capture-summary.json') -Raw | ConvertFrom-Json
$metadata.state = 'activated-capture-passed'
$metadata.vm.state = 'poweroff'
$activationMetadata = [ordered]@{
  exactProviderVmUuid = $metadata.vm.uuid
  challengeVmUuid = $metadata.vm.uuid
  hardwareUuid = $metadata.vm.hardwareUuid
  verifiedWallTime = [DateTime]::UtcNow.ToString('o')
  profile = 'interactive'
}
$captureMetadata = [ordered]@{
  root = $captureRoot
  manifest = $manifest
  launchMs = $summary.launchMs
  settleMs = $summary.settle.settleMs
  frameCount = $summary.frameCount
  resourceSampleCount = $summary.resourceSampleCount
}
$metadata | Add-Member -NotePropertyName activation -NotePropertyValue $activationMetadata -Force
$metadata | Add-Member -NotePropertyName capture -NotePropertyValue $captureMetadata -Force
$metadata.nextAction = 'Resume the same retained VM UUID and stage the current local VSIX.'
Write-AtomicJson $metadataPath $metadata
Write-Host ($metadata | ConvertTo-Json -Depth 15 -Compress)
