[CmdletBinding()]
param(
  [string]$BoxName = 'actor/win11-labview2026',
  [string]$VagrantHome = 'D:\vagrant-home',
  [string]$PackagePath = 'D:\lba-vm-assets\actor-win11-labview2026-20260807.box',
  [string]$ExpectedPackageSha256 = '3d7e0e8651d87b52b567d327b661347efcdbcca8bf6b6dc6bc2d2aa62bb8a5b6',
  [string]$SourceVmName = 'lba-win11-labview2026-build',
  [string]$ExpectedSourceVmUuid = '3e29a8af-ee1f-442f-8e28-2eaa07832786',
  [string]$ExpectedActivatedSnapshotUuid = 'c00da84d-61b1-4c1d-94ed-d063022db42a',
  [string]$RepairLifecyclePath = 'experiments\windows-docker-container\evidence\vagrant-repair-20260807T151447227Z-a0c3daba\vm-lifecycle.json',
  [ValidateRange(30000, 300000)][int]$CaptureDurationMs = 90000
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'orchestration-core.psm1') -Force

function Write-AtomicJson([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($temporary, "$(ConvertTo-Json $Value -Depth 30)`n", [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Invoke-NativeLogged(
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$LogPath,
  [switch]$AllowFailure
) {
  $priorErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& $FilePath @Arguments 2>&1 | Tee-Object -FilePath $LogPath -Append)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $priorErrorActionPreference
  }
  if (-not $AllowFailure -and $exitCode -ne 0) {
    throw "'$FilePath $($Arguments -join ' ')' exited $exitCode. See '$LogPath'."
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Get-JsonObjectFromOutput([object[]]$Output, [string]$Label) {
  foreach ($line in @($Output) | Select-Object -Last 40) {
    $text = "$line" -replace "$([char]27)\[[0-9;?]*[ -/]*[@-~]", ''
    $start = $text.IndexOf('{')
    if ($start -ge 0) {
      try { return ($text.Substring($start) | ConvertFrom-Json) } catch {}
    }
  }
  throw "$Label returned no JSON object."
}

function Get-VmInfo([string]$Vm) {
  $result = Invoke-NativeLogged 'VBoxManage' @('showvminfo', $Vm, '--machinereadable') $script:VBoxLog -AllowFailure
  if ($result.ExitCode -ne 0) { return $null }
  return ($result.Output -join "`n")
}

function Get-MachineReadableValue([string]$Text, [string]$Name) {
  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name))=`"([^`"]*)`"$")
  if (-not $match.Success) { return $null }
  return $match.Groups[1].Value
}

function New-EvidenceRef([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  return [ordered]@{
    path = $item.FullName
    size = $item.Length
    sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
  throw 'The Vagrant box consumer proof requires a Windows host.'
}
foreach ($command in 'node', 'vagrant', 'VBoxManage') {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command '$command' is unavailable." }
}

$experimentRoot = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $experimentRoot '..\..')).Path
$reviewerRoot = Join-Path $repoRoot 'reviewer-workstation'
$evidenceRoot = Join-Path $experimentRoot 'evidence'
$randomBytes = [byte[]]::new(4)
$randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $randomGenerator.GetBytes($randomBytes) } finally { $randomGenerator.Dispose() }
$suffix = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })
$runId = "vagrant-box-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$suffix"
$vmName = "lba-box-proof-$suffix"
$hostname = "lba-box-$suffix".Substring(0, [Math]::Min(15, "lba-box-$suffix".Length))
$runRoot = Join-Path $evidenceRoot $runId
$captureRoot = Join-Path $runRoot 'capture'
$stateRoot = Join-Path ([IO.Path]::GetTempPath()) "$runId-vagrant-state"
$secretRoot = Join-Path ([IO.Path]::GetTempPath()) "$runId-secrets"
$consumerVagrantHome = Join-Path 'D:\lba-vagrant-proof' $runId
$lifecyclePath = Join-Path $runRoot 'vm-lifecycle.json'
$proofPath = Join-Path $runRoot 'vagrant-box-proof.json'
$script:VBoxLog = Join-Path $runRoot 'vbox.log'
$vagrantLog = Join-Path $runRoot 'vagrant.log'
$nodeLog = Join-Path $runRoot 'node.log'
$natRuleName = "lba-box-vnc-$suffix"
$providerIdPath = Join-Path $stateRoot 'machines\default\virtualbox\id'

New-Item -ItemType Directory -Path $runRoot, $captureRoot, $secretRoot -Force | Out-Null
$priorEnvironment = @{}
foreach ($name in 'VAGRANT_HOME', 'VAGRANT_CWD', 'VAGRANT_DOTFILE_PATH', 'LBA_VM_NAME', 'LBA_VM_HOSTNAME', 'VIHS_REVIEWER_BOX') {
  $priorEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$env:VAGRANT_HOME = (Resolve-Path -LiteralPath $VagrantHome).Path
$env:VAGRANT_CWD = $reviewerRoot
$env:VAGRANT_DOTFILE_PATH = $stateRoot
$env:LBA_VM_NAME = $vmName
$env:LBA_VM_HOSTNAME = $hostname
$env:VIHS_REVIEWER_BOX = $BoxName

$providerUuid = $null
$hostPort = $null
$captureSummary = $null
$guestFacts = $null
$bootstrap = $null
$guestCleanup = $null
$sourceBefore = $null
$sourceAfter = $null
$sourceConfigBefore = $null
$sourceConfigAfter = $null
$upStartedWallTime = $null
$upCompletedWallTime = $null
$capturePassed = $false
$activationRequired = $false
$ownedVmDestroyed = $false
$natRuleRemoved = $true
$secretRemoved = $false
$stateRemoved = $false
$consumerVagrantHomeRemoved = $false
$mainError = $null
$vmNameAbsentBefore = $false
$guestArtifactsUploaded = $false

try {
  Invoke-NativeLogged 'node' @(
    (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'init',
    '--record', $lifecyclePath,
    '--lifecycle-id', $runId,
    '--vm-name', $vmName
  ) $nodeLog | Out-Null

  $package = Get-Item -LiteralPath $PackagePath
  $packageSha256 = (Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($packageSha256 -ne $ExpectedPackageSha256) {
    throw "Box package SHA-256 mismatch: expected '$ExpectedPackageSha256', got '$packageSha256'."
  }

  $sourceBefore = Get-VmInfo $SourceVmName
  if (-not $sourceBefore) { throw "Retained source VM '$SourceVmName' is missing." }
  if ((Get-MachineReadableValue $sourceBefore 'UUID') -ne $ExpectedSourceVmUuid) { throw 'Retained source VM UUID mismatch.' }
  if ((Get-MachineReadableValue $sourceBefore 'VMState') -ne 'poweroff') { throw 'Retained source VM must remain powered off.' }
  if ($sourceBefore -notmatch [regex]::Escape("CurrentSnapshotUUID=`"$ExpectedActivatedSnapshotUuid`"")) {
    throw 'Retained source VM is not on the expected activated snapshot.'
  }
  $sourceConfigBefore = New-EvidenceRef (Get-MachineReadableValue $sourceBefore 'CfgFile')
  if (Get-VmInfo $vmName) { throw "Refusing to reuse pre-existing VM '$vmName'." }
  $vmNameAbsentBefore = $true

  $boxList = Invoke-NativeLogged 'vagrant' @('box', 'list') $vagrantLog
  if (($boxList.Output -join "`n") -notmatch "(?m)^$([regex]::Escape($BoxName))\s+\(virtualbox,\s*0,\s*\(amd64\)\)$") {
    throw "Registered box '$BoxName' was not found in '$env:VAGRANT_HOME'."
  }
  Invoke-NativeLogged 'vagrant' @('validate') $vagrantLog | Out-Null

  New-Item -ItemType Directory -Path $consumerVagrantHome -Force | Out-Null
  $persistentVagrantHome = $env:VAGRANT_HOME
  $env:VAGRANT_HOME = $consumerVagrantHome
  Invoke-NativeLogged 'vagrant' @(
    'box', 'add',
    '--force',
    '--name', $BoxName,
    '--provider', 'virtualbox',
    $package.FullName
  ) $vagrantLog | Out-Null
  $consumerBoxList = Invoke-NativeLogged 'vagrant' @('box', 'list') $vagrantLog
  if (($consumerBoxList.Output -join "`n") -notmatch "(?m)^$([regex]::Escape($BoxName))\s+\(virtualbox,\s*0,\s*\(amd64\)\)$") {
    throw "Exact package registration failed in run-owned VAGRANT_HOME '$consumerVagrantHome'."
  }

  $registration = [ordered]@{
    schema = 'labview-benchmark-actor/windows-vagrant-box-registration@1'
    name = $BoxName
    provider = 'virtualbox'
    version = '0'
    architecture = 'amd64'
    persistentVagrantHome = $persistentVagrantHome
    consumerVagrantHome = $consumerVagrantHome
    exactPackageAdded = $true
    exactPackageSha256 = $packageSha256
    addInvocation = [ordered]@{
      command = 'vagrant'
      args = @('box', 'add', '--force', '--name', $BoxName, '--provider', 'virtualbox', $package.FullName)
    }
    upInvocation = [ordered]@{
      command = 'vagrant'
      args = @(New-VagrantBoxUpArgs)
      noProvision = $true
    }
    package = [ordered]@{ path = $package.FullName; size = $package.Length; sha256 = $packageSha256 }
    validatedWallTime = [DateTime]::UtcNow.ToString('o')
  }
  $registrationPath = Join-Path $runRoot 'box-registration.json'
  Write-AtomicJson $registrationPath $registration

  Invoke-NativeLogged 'node' @(
    (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
    '--record', $lifecyclePath,
    '--phase', 'VM-CREATE-START',
    '--status', 'started',
    '--detail', 'Disposable Vagrant consumer import/boot started with provisioning disabled.',
    '--evidence', $registrationPath
  ) $nodeLog | Out-Null

  $upStartedWallTime = [DateTime]::UtcNow.ToString('o')
  Invoke-NativeLogged 'vagrant' @(New-VagrantBoxUpArgs) $vagrantLog | Out-Null
  $upCompletedWallTime = [DateTime]::UtcNow.ToString('o')

  if (-not (Test-Path -LiteralPath $providerIdPath)) { throw 'Vagrant provider UUID file is missing.' }
  $providerUuid = (Get-Content -LiteralPath $providerIdPath -Raw).Trim()
  if ($providerUuid -notmatch '^[a-f0-9-]{36}$') { throw "Invalid Vagrant provider UUID '$providerUuid'." }
  if ($providerUuid -eq $ExpectedSourceVmUuid) { throw 'Vagrant consumer unexpectedly references the retained source VM.' }
  $providerInfo = Get-VmInfo $providerUuid
  if (-not $providerInfo) { throw 'Run-owned Vagrant provider VM is missing.' }
  Assert-RunOwnedVagrantVm `
    -ActualName (Get-MachineReadableValue $providerInfo 'name') `
    -ExpectedName $vmName `
    -ActualUuid $providerUuid `
    -SourceVmUuid $ExpectedSourceVmUuid
  if ((Get-MachineReadableValue $providerInfo 'VMState') -ne 'running') { throw 'Vagrant provider VM is not running.' }

  Invoke-NativeLogged 'vagrant' @(
    'upload',
    (Join-Path $experimentRoot 'vm-guest-ready.ps1'),
    'C:/lba-provision/vm-guest-ready.ps1',
    'default'
  ) $vagrantLog | Out-Null
  $guestFactsCommand = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-guest-ready.ps1'
  $guestFactsResult = Invoke-NativeLogged 'vagrant' @('winrm', 'default', '-c', $guestFactsCommand) $vagrantLog
  $guestFacts = Get-JsonObjectFromOutput $guestFactsResult.Output 'Vagrant guest readiness'
  if (-not $guestFacts.labviewPresent -or $guestFacts.interactiveExplorerCount -lt 1) {
    throw 'Vagrant guest lacks LabVIEW or an interactive Explorer desktop.'
  }
  $guestFactsPath = Join-Path $runRoot 'guest-ready.json'
  Write-AtomicJson $guestFactsPath $guestFacts
  Invoke-NativeLogged 'node' @(
    (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
    '--record', $lifecyclePath,
    '--phase', 'WINDOWS-INTERACTIVE-READY',
    '--status', 'completed',
    '--detail', 'Vagrant WinRM and the interactive Windows desktop are ready.',
    '--evidence', $guestFactsPath
  ) $nodeLog | Out-Null

  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $passwordBytes = [byte[]]::new(8)
  $passwordGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $passwordGenerator.GetBytes($passwordBytes) } finally { $passwordGenerator.Dispose() }
  $vncPassword = -join ($passwordBytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  $passwordFile = Join-Path $secretRoot 'vnc-password.txt'
  [IO.File]::WriteAllText($passwordFile, $vncPassword, [Text.UTF8Encoding]::new($false))
  $vncPassword = $null
  $principal = "$env:USERDOMAIN\$env:USERNAME"
  & icacls.exe $secretRoot /inheritance:r /grant:r "${principal}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict the VNC secret directory ACL.' }

  $uploads = @(
    @{ Source = (Join-Path $experimentRoot 'vm-bootstrap.ps1'); Destination = 'C:/lba-provision/vm-bootstrap.ps1' },
    @{ Source = (Join-Path $experimentRoot 'vm-launch.ps1'); Destination = 'C:/lba-provision/vm-launch.ps1' },
    @{ Source = (Join-Path $experimentRoot 'vm-launch-vagrant.ps1'); Destination = 'C:/lba-provision/vm-launch-vagrant.ps1' },
    @{ Source = (Join-Path $experimentRoot 'vm-cleanup-vagrant.ps1'); Destination = 'C:/lba-provision/vm-cleanup-vagrant.ps1' },
    @{ Source = (Join-Path $experimentRoot 'vm-guest-cleanup-proof.ps1'); Destination = 'C:/lba-provision/vm-guest-cleanup-proof.ps1' },
    @{ Source = (Join-Path $experimentRoot 'display-surface.cs'); Destination = 'C:/lba-provision/display-surface.cs' },
    @{ Source = $passwordFile; Destination = 'C:/lba-provision/.vnc-password' }
  )
  foreach ($upload in $uploads) {
    Invoke-NativeLogged 'vagrant' @('upload', $upload.Source, $upload.Destination, 'default') $vagrantLog | Out-Null
  }
  $guestArtifactsUploaded = $true

  $bootstrapCommand = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-bootstrap.ps1 -PasswordFile C:\lba-provision\.vnc-password'
  $bootstrapResult = Invoke-NativeLogged 'vagrant' @('winrm', 'default', '-c', $bootstrapCommand) $vagrantLog
  $bootstrap = Get-JsonObjectFromOutput $bootstrapResult.Output 'Vagrant TightVNC bootstrap'
  if ($bootstrap.tightVnc.port -ne 5900) { throw 'Guest TightVNC did not report port 5900.' }

  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $hostPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  Invoke-NativeLogged 'VBoxManage' @(
    'controlvm', $providerUuid, 'natpf1',
    (New-LoopbackVagrantNatRule -Name $natRuleName -HostPort $hostPort)
  ) $script:VBoxLog | Out-Null
  $natRuleRemoved = $false

  $client = [Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync('127.0.0.1', $hostPort)
    if (-not $connect.Wait(5000) -or -not $client.Connected) { throw 'Loopback VNC forward is not reachable.' }
  } finally {
    $client.Dispose()
  }

  $capturePath = [ordered]@{
    schema = 'labview-benchmark-actor/windows-vagrant-capture-path@1'
    providerVmUuid = $providerUuid
    providerVmName = $vmName
    natRule = $natRuleName
    hostEndpoint = "127.0.0.1:$hostPort"
    guestEndpoint = '5900'
    loopbackOnly = $true
    bootstrap = $bootstrap
  }
  $capturePathFile = Join-Path $runRoot 'capture-path.json'
  Write-AtomicJson $capturePathFile $capturePath
  Invoke-NativeLogged 'node' @(
    (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
    '--record', $lifecyclePath,
    '--phase', 'CAPTURE-PATH-READY',
    '--status', 'completed',
    '--detail', 'Ephemeral authenticated TightVNC path is reachable through a loopback-only NAT rule.',
    '--evidence', $capturePathFile
  ) $nodeLog | Out-Null
  Invoke-NativeLogged 'node' @(
    (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
    '--record', $lifecyclePath,
    '--phase', 'POST-ACTIVATION-CAPTURE-START',
    '--status', 'started',
    '--detail', 'Disposable box activated-IDE capture armed before LabVIEW launch.'
  ) $nodeLog | Out-Null

  $captureArguments = @(
    (Join-Path $experimentRoot 'vm-capture.mjs'),
    '--vm-name', $vmName,
    '--vnc-port', "$hostPort",
    '--password-file', $passwordFile,
    '--evidence-dir', $captureRoot,
    '--duration-ms', "$CaptureDurationMs",
    '--vagrant-cwd', $reviewerRoot,
    '--vagrant-machine', 'default'
  )
  $captureRun = Invoke-NativeLogged 'node' $captureArguments $nodeLog -AllowFailure
  $captureSummary = Get-Content -LiteralPath (Join-Path $captureRoot 'capture-summary.json') -Raw | ConvertFrom-Json
  if ($captureRun.ExitCode -eq 0) {
    if ($captureSummary.outcome -ne 'passed' -or -not $captureSummary.visibility.passed) {
      throw 'Disposable Vagrant box capture did not prove an activated LabVIEW IDE.'
    }
    $capturePassed = $true
  } elseif (
    $captureRun.ExitCode -eq 4 -and
    $captureSummary.outcome -eq 'blocked' -and
    $captureSummary.classification -eq 'labview-activation-required'
  ) {
    $activationRequired = $true
  } else {
    throw "VM capture exited $($captureRun.ExitCode) without a verified pass or activation-required receipt."
  }
} catch {
  $mainError = $_
  Write-AtomicJson (Join-Path $runRoot 'failure-receipt.json') ([ordered]@{
    schema = 'labview-benchmark-actor/windows-vagrant-box-consumer-failure@1'
    outcome = 'failed'
    runId = $runId
    error = $_.Exception.Message
    wallTime = [DateTime]::UtcNow.ToString('o')
    providerVmUuid = $providerUuid
  })
} finally {
  if (-not $providerUuid -and (Test-Path -LiteralPath $providerIdPath)) {
    $candidateUuid = (Get-Content -LiteralPath $providerIdPath -Raw).Trim()
    if ($candidateUuid -match '^[a-f0-9-]{36}$') { $providerUuid = $candidateUuid }
  }
  if (-not $providerUuid -and $vmNameAbsentBefore) {
    $candidateInfo = Get-VmInfo $vmName
    if ($candidateInfo) { $providerUuid = Get-MachineReadableValue $candidateInfo 'UUID' }
  }
  if ($providerUuid) {
    $ownedInfo = Get-VmInfo $providerUuid
    if ($ownedInfo -and (Get-MachineReadableValue $ownedInfo 'name') -eq $vmName) {
      if ($guestArtifactsUploaded) {
        try {
          $cleanupCommand = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-cleanup-vagrant.ps1'
          $cleanupResult = Invoke-NativeLogged 'vagrant' @('winrm', 'default', '-c', $cleanupCommand) $vagrantLog -AllowFailure
          $guestCleanup = Get-JsonObjectFromOutput $cleanupResult.Output 'Vagrant guest cleanup'
          Write-AtomicJson (Join-Path $captureRoot 'guest-cleanup-verification.json') $guestCleanup
        } catch {
          if (-not $mainError) { $mainError = $_ }
        }
      }
      if (-not $natRuleRemoved) {
        try {
          $state = Get-MachineReadableValue $ownedInfo 'VMState'
          if ($state -eq 'running') {
            Invoke-NativeLogged 'VBoxManage' @('controlvm', $providerUuid, 'natpf1', 'delete', $natRuleName) $script:VBoxLog | Out-Null
          } else {
            Invoke-NativeLogged 'VBoxManage' @('modifyvm', $providerUuid, '--natpf1', 'delete', $natRuleName) $script:VBoxLog | Out-Null
          }
          $natRuleRemoved = $true
        } catch {
          if (-not $mainError) { $mainError = $_ }
        }
      }
      try {
        $destroy = Invoke-NativeLogged 'vagrant' @('destroy', 'default', '-f') $vagrantLog -AllowFailure
        if ($destroy.ExitCode -ne 0 -and (Get-VmInfo $providerUuid)) {
          Invoke-NativeLogged 'VBoxManage' @('unregistervm', $providerUuid, '--delete') $script:VBoxLog | Out-Null
        }
        $ownedVmDestroyed = -not [bool](Get-VmInfo $providerUuid)
      } catch {
        if (-not $mainError) { $mainError = $_ }
      }
    } elseif ($ownedInfo) {
      $ownershipError = [InvalidOperationException]::new("Refusing to destroy provider VM '$providerUuid' because its name is not '$vmName'.")
      if (-not $mainError) {
        $mainError = [System.Management.Automation.ErrorRecord]::new(
          $ownershipError,
          'VagrantVmOwnership',
          [System.Management.Automation.ErrorCategory]::SecurityError,
          $providerUuid
        )
      }
    } else {
      $ownedVmDestroyed = $true
    }
  }

  if (Test-Path -LiteralPath $secretRoot) { Remove-Item -LiteralPath $secretRoot -Recurse -Force }
  $secretRemoved = -not (Test-Path -LiteralPath $secretRoot)
  if (Test-Path -LiteralPath $stateRoot) { Remove-Item -LiteralPath $stateRoot -Recurse -Force }
  $stateRemoved = -not (Test-Path -LiteralPath $stateRoot)
  if (Test-Path -LiteralPath $consumerVagrantHome) {
    Remove-Item -LiteralPath $consumerVagrantHome -Recurse -Force
  }
  $consumerVagrantHomeRemoved = -not (Test-Path -LiteralPath $consumerVagrantHome)
  $sourceAfter = Get-VmInfo $SourceVmName
  if ($sourceAfter) {
    $sourceConfigAfter = New-EvidenceRef (Get-MachineReadableValue $sourceAfter 'CfgFile')
  }
  $sourcePreserved = [bool](
    $sourceAfter -and
    (Get-MachineReadableValue $sourceAfter 'UUID') -eq $ExpectedSourceVmUuid -and
    (Get-MachineReadableValue $sourceAfter 'VMState') -eq 'poweroff' -and
    $sourceAfter -match [regex]::Escape("CurrentSnapshotUUID=`"$ExpectedActivatedSnapshotUuid`"") -and
    $null -ne $sourceConfigBefore -and
    $null -ne $sourceConfigAfter -and
    $sourceConfigAfter.sha256 -eq $sourceConfigBefore.sha256
  )
  $vncListenerAbsent = if ($hostPort) {
    -not [bool](Get-NetTCPConnection -State Listen -LocalPort $hostPort -ErrorAction SilentlyContinue)
  } else {
    $true
  }
  $cleanup = [ordered]@{
    schema = 'labview-benchmark-actor/windows-vagrant-box-consumer-cleanup@1'
    wallTime = [DateTime]::UtcNow.ToString('o')
    vmPoweredOff = $ownedVmDestroyed
    providerVmDestroyed = $ownedVmDestroyed
    natRuleRemoved = $natRuleRemoved
    hostVncSecretRemoved = $secretRemoved
    guestVncSecretRemoved = [bool]($guestCleanup -and -not $guestCleanup.guestVncSecretPresent)
    vncPasswordRegistryRemoved = [bool]($guestCleanup -and -not $guestCleanup.vncPasswordPresent)
    captureTasksRemoved = [bool]($guestCleanup -and $guestCleanup.captureTasks -eq 0)
    captureProcessesStopped = [bool]($guestCleanup -and $guestCleanup.labviewProcesses -eq 0 -and $guestCleanup.tightVncProcesses -eq 0)
    loopbackVncListenerRemoved = $vncListenerAbsent
    vagrantLocalStateRemoved = $stateRemoved
    consumerVagrantHomeRemoved = $consumerVagrantHomeRemoved
    lifecycleLockRemoved = -not (Test-Path -LiteralPath "$lifecyclePath.resume.lock")
    sourceVmPreserved = $sourcePreserved
  }
  Write-AtomicJson (Join-Path $captureRoot 'cleanup-verification.json') $cleanup

  foreach ($entry in $priorEnvironment.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
}

if ($mainError) { throw $mainError }
if (-not $capturePassed -and -not $activationRequired) { throw 'Capture did not complete.' }

if ($activationRequired) {
  Invoke-NativeLogged 'node' @(
    (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'seal',
    '--record', $lifecyclePath,
    '--state', 'activation-required'
  ) $nodeLog | Out-Null
  Invoke-NativeLogged 'node' @(
    (Join-Path $experimentRoot 'build-vagrant-box-proof.mjs'),
    '--run', $runRoot,
    '--package', (Resolve-Path -LiteralPath $PackagePath).Path,
    '--package-sha256', $ExpectedPackageSha256,
    '--box-name', $BoxName,
    '--vagrant-home', (Resolve-Path -LiteralPath $VagrantHome).Path,
    '--source-vm', $SourceVmName,
    '--source-uuid', $ExpectedSourceVmUuid,
    '--source-snapshot', $ExpectedActivatedSnapshotUuid,
    '--repair-lifecycle', (Resolve-Path -LiteralPath $RepairLifecyclePath).Path,
    '--output', $proofPath
  ) $nodeLog | Out-Null
  Invoke-NativeLogged 'node' @(
    (Join-Path $experimentRoot 'verify-vagrant-box-proof.mjs'),
    '--verify', $proofPath
  ) $nodeLog | Out-Null
  Write-Host "Vagrant box proof -> $proofPath (activation required per new VM identity)"
  return
}

Invoke-NativeLogged 'node' @(
  (Join-Path $experimentRoot 'verify-vm-capture.mjs'),
  '--finalize-and-verify', $captureRoot
) $nodeLog | Out-Null
$captureManifestPath = Join-Path $captureRoot 'manifest.json'
Invoke-NativeLogged 'node' @(
  (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
  '--record', $lifecyclePath,
  '--phase', 'LABVIEW-IDE-SETTLED',
  '--status', 'completed',
  '--detail', 'Disposable registered-box instance produced verified activated LabVIEW IDE evidence.',
  '--evidence', $captureManifestPath
) $nodeLog | Out-Null
Invoke-NativeLogged 'node' @(
  (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'checkpoint',
  '--record', $lifecyclePath,
  '--phase', 'BOX-REGISTERED',
  '--status', 'verified',
  '--detail', 'Registered box was independently consumed and verified through cleanup.',
  '--evidence', (Join-Path $runRoot 'box-registration.json')
) $nodeLog | Out-Null
Invoke-NativeLogged 'node' @(
  (Join-Path $experimentRoot 'vm-lifecycle.mjs'), 'seal',
  '--record', $lifecyclePath,
  '--state', 'complete'
) $nodeLog | Out-Null

$launchDiagnostics = Get-Content -LiteralPath (Join-Path $captureRoot 'launch-diagnostics.json') -Raw | ConvertFrom-Json
$resourceRecord = Get-Content -LiteralPath (Join-Path $captureRoot 'resource-samples.json') -Raw | ConvertFrom-Json
$usableResources = @(
  $resourceRecord.samples |
    Where-Object { $null -ne $_.cpuPct -and $null -ne $_.ramMb } |
    ForEach-Object {
      [ordered]@{
        ms = [double]$_.ms
        cpuPct = [double]$_.cpuPct
        ramMb = [double]$_.ramMb
        diskPct = $_.diskPct
      }
    }
)
if ($usableResources.Count -eq 0) { throw 'No usable resource samples remain for the box proof.' }
$packageRef = [ordered]@{
  name = $BoxName
  provider = 'virtualbox'
  role = 'box-package'
  path = (Resolve-Path -LiteralPath $PackagePath).Path
  size = (Get-Item -LiteralPath $PackagePath).Length
  sha256 = $ExpectedPackageSha256
}
$receipt = [ordered]@{
  schema = 'labview-benchmark-actor/windows-vagrant-box-consumer@1'
  outcome = 'passed'
  runId = $runId
  package = $packageRef
  registration = [ordered]@{
    name = $BoxName
    provider = 'virtualbox'
    version = '0'
    architecture = 'amd64'
    persistentVagrantHome = (Resolve-Path -LiteralPath $VagrantHome).Path
    consumerVagrantHome = $consumerVagrantHome
    exactPackageAdded = $true
    exactPackageSha256 = $ExpectedPackageSha256
    providerUuid = $providerUuid
    providerUuidOwnership = 'run-owned'
    addInvocation = [ordered]@{
      command = 'vagrant'
      args = @('box', 'add', '--force', '--name', $BoxName, '--provider', 'virtualbox', (Resolve-Path -LiteralPath $PackagePath).Path)
    }
    upInvocation = [ordered]@{
      command = 'vagrant'
      args = @(New-VagrantBoxUpArgs)
      noProvision = $true
    }
  }
  proof = [ordered]@{
    winrm = [ordered]@{
      authenticated = $true
      computerName = $guestFacts.computerName
      upStartedWallTime = $upStartedWallTime
      upCompletedWallTime = $upCompletedWallTime
    }
    desktop = [ordered]@{
      interactive = ($guestFacts.interactiveExplorerCount -gt 0)
      windowStation = $launchDiagnostics.launcher.desktopContext.windowStation
      desktop = $launchDiagnostics.launcher.desktopContext.desktop
      monitorRectangles = @(
        [ordered]@{
          left = 0
          top = 0
          right = [int]$captureSummary.rfb.width
          bottom = [int]$captureSummary.rfb.height
        }
      )
    }
    labview = [ordered]@{
      installed = [bool]$guestFacts.labviewPresent
      activated = [bool](
        $launchDiagnostics.status -eq 'ready' -and
        $launchDiagnostics.expectedWindow.className -notmatch 'NI License Manager Wizard'
      )
      fileVersion = $guestFacts.labviewFileVersion
      title = $launchDiagnostics.expectedWindow.title
      className = $launchDiagnostics.expectedWindow.className
    }
    capture = [ordered]@{
      rfb = [ordered]@{
        authenticated = ($captureSummary.rfb.securityType -eq 2)
        loopbackOnly = [bool]$captureSummary.relay.localOnly
        boundAddress = '127.0.0.1'
        port = $hostPort
        securityType = [int]$captureSummary.rfb.securityType
        width = [int]$captureSummary.rfb.width
        height = [int]$captureSummary.rfb.height
        updateCount = [int]$captureSummary.rfb.updateCount
      }
      mprr = [ordered]@{
        passed = [bool]($captureSummary.outcome -eq 'passed' -and $captureSummary.visibility.passed)
        launchMs = [double]$captureSummary.launchMs
        settleMs = [double]$captureSummary.settle.settleMs
        frameCount = [int]$captureSummary.frameCount
        uniqueFingerprintCount = [int]$captureSummary.fingerprintSummary.uniqueFingerprintCount
        resourceSamples = $usableResources
      }
    }
    sourceVm = [ordered]@{
      activated = $true
      preserved = [bool]$cleanup.sourceVmPreserved
      name = $SourceVmName
      providerUuid = $ExpectedSourceVmUuid
      snapshotUuid = $ExpectedActivatedSnapshotUuid
      configSha256Before = $sourceConfigBefore.sha256
      configSha256After = $sourceConfigAfter.sha256
    }
    cleanup = [ordered]@{
      runOwnedVmAbsent = [bool]$cleanup.providerVmDestroyed
      natListenerAbsent = [bool]$cleanup.natRuleRemoved
      vncListenerAbsent = [bool]$cleanup.loopbackVncListenerRemoved
      secretsRemoved = [bool](
        $cleanup.hostVncSecretRemoved -and
        $cleanup.guestVncSecretRemoved -and
        $cleanup.vncPasswordRegistryRemoved
      )
      localDotfileRemoved = [bool]$cleanup.vagrantLocalStateRemoved
      consumerVagrantHomeRemoved = [bool]$cleanup.consumerVagrantHomeRemoved
      lifecycleLockRemoved = [bool]$cleanup.lifecycleLockRemoved
    }
  }
  evidence = @(
    (New-EvidenceRef $captureManifestPath),
    (New-EvidenceRef $lifecyclePath),
    (New-EvidenceRef (Join-Path $runRoot 'box-registration.json')),
    (New-EvidenceRef (Join-Path $runRoot 'guest-ready.json')),
    (New-EvidenceRef (Join-Path $runRoot 'capture-path.json'))
  )
  liveChecks = [ordered]@{
    vagrantBox = $true
    runOwnedVm = [ordered]@{ name = $vmName; uuid = $providerUuid; absent = $true }
    sourceVm = [ordered]@{
      name = $SourceVmName
      uuid = $ExpectedSourceVmUuid
      snapshotUuid = $ExpectedActivatedSnapshotUuid
      state = 'poweroff'
      preserved = $true
    }
    pathsAbsent = @($stateRoot, $secretRoot, $consumerVagrantHome)
  }
}
Write-AtomicJson $proofPath $receipt
Invoke-NativeLogged 'node' @(
  (Join-Path $experimentRoot 'verify-vagrant-box-proof.mjs'),
  '--verify', $proofPath
) $nodeLog | Out-Null

Write-Host "Vagrant box proof -> $proofPath"
