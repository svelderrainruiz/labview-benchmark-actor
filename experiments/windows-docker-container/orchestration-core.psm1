Set-StrictMode -Version Latest

function Assert-WindowsHost {
  param([string]$Platform = [System.Environment]::OSVersion.Platform.ToString())
  if ($Platform -ne 'Win32NT') {
    throw "This experiment requires a Windows host (detected '$Platform')."
  }
}

function Assert-DockerWindowsMode {
  param([Parameter(Mandatory = $true)]$DockerInfo)
  if ($DockerInfo.OSType -ne 'windows') {
    throw "Docker must be in Windows-container mode (OSType=windows, got '$($DockerInfo.OSType)')."
  }
}

function Assert-ImageContract {
  param(
    [Parameter(Mandatory = $true)][AllowNull()]$ImageInspection,
    [Parameter(Mandatory = $true)][string]$ExpectedId,
    [switch]$AllowUnexpectedImageId
  )
  if ($null -eq $ImageInspection) {
    throw 'The exact local image is missing or could not be inspected.'
  }

  if ($ImageInspection.Os -ne 'windows' -or $ImageInspection.Architecture -ne 'amd64') {
    throw "Image must be windows/amd64 (got '$($ImageInspection.Os)/$($ImageInspection.Architecture)')."
  }
  if (-not $AllowUnexpectedImageId -and $ImageInspection.Id -ne $ExpectedId) {
    throw "Image ID mismatch: expected '$ExpectedId', got '$($ImageInspection.Id)'. Use -AllowUnexpectedImageId only for an explicitly approved local override."
  }
}

function New-SmokeContainerRunArgs {
  param(
    [Parameter(Mandatory = $true)][string]$ContainerName,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][ValidateSet('process', 'hyperv')][string]$Isolation,
    [Parameter(Mandatory = $true)][string]$ImageReference,
    [string]$Marker = 'SMOKE_OK'
  )
  return @(
    'run', '--rm', '--name', $ContainerName,
    '--label', "org.labview-benchmark-actor.windows-docker-run=$RunId",
    "--isolation=$Isolation",
    $ImageReference,
    'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "'$Marker'"
  )
}

function New-ExperimentContainerCreateArgs {
  param(
    [Parameter(Mandatory = $true)][string]$ContainerName,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][ValidateSet('process', 'hyperv')][string]$Isolation,
    [Parameter(Mandatory = $true)][string]$ExperimentRoot,
    [Parameter(Mandatory = $true)][string]$RunRoot,
    [Parameter(Mandatory = $true)][string]$SecretRoot,
    [Parameter(Mandatory = $true)][string]$ImageReference,
    [Parameter(Mandatory = $true)][string]$TightVncSha256,
    [Parameter(Mandatory = $true)][string]$TightVncVersion,
    [Parameter(Mandatory = $true)][ValidateSet('Inherited', 'WinSta0')][string]$DesktopTarget,
    [Parameter(Mandatory = $true)][ValidateSet('StandardGdi', 'D3d')][string]$TightVncCaptureMode,
    [switch]$TransportOnly,
    [switch]$AssignGpuDevice,
    [string]$BootstrapInstaller,
    [string]$LbaBusPath
  )
  if ($Isolation -eq 'hyperv' -and $AssignGpuDevice) {
    throw 'Device assignment is unsupported for Hyper-V-isolated Windows containers.'
  }
  if ($TransportOnly -and $DesktopTarget -ne 'WinSta0') {
    throw 'TransportOnly is restricted to the explicit WinSta0 baseline.'
  }
  $arguments = @(
    'create',
    '--name', $ContainerName,
    '--label', "org.labview-benchmark-actor.windows-docker-run=$RunId",
    '--label', 'org.labview-benchmark-actor.experiment=windows-docker-tightvnc',
    "--isolation=$Isolation"
  )
  if ($AssignGpuDevice) {
    $arguments += @('--device', 'class/5B45201D-F2F2-4F3B-85BB-30FF1F953599')
  }

  $arguments += @(
    '--mount', "type=bind,source=$ExperimentRoot,target=C:\experiment,readonly",
    '--mount', "type=bind,source=$RunRoot,target=C:\evidence",
    '--mount', "type=bind,source=$SecretRoot,target=C:\run-secrets,readonly",
    $ImageReference,
    'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'C:\experiment\container-bootstrap.ps1',
    '-Action', 'Serve',
    '-PasswordFile', 'C:\run-secrets\vnc-password.txt',
    '-ExpectedInstallerSha256', $TightVncSha256,
    '-DesktopTarget', $DesktopTarget,
    '-TightVncCaptureMode', $TightVncCaptureMode,
    '-RunId', $RunId
  )
  if ($BootstrapInstaller) { $arguments += @('-InstallerPath', $BootstrapInstaller) }
  if ($LbaBusPath) { $arguments += @('-LbaBusPath', $LbaBusPath) }
  if ($TransportOnly) { $arguments += '-TransportOnly' }
  $arguments += @('-TightVncVersion', $TightVncVersion)
  return $arguments
}

function New-DisplayProbeContainerCreateArgs {
  param(
    [Parameter(Mandatory = $true)][string]$ContainerName,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][ValidateSet('process', 'hyperv')][string]$Isolation,
    [Parameter(Mandatory = $true)][string]$ExperimentRoot,
    [Parameter(Mandatory = $true)][string]$RunRoot,
    [Parameter(Mandatory = $true)][string]$ImageReference,
    [ValidateSet('Inherited', 'WinSta0')][string]$DesktopTarget = 'Inherited',
    [switch]$AssignGpuDevice
  )
  if ($Isolation -eq 'hyperv' -and $AssignGpuDevice) {
    throw 'Device assignment is unsupported for Hyper-V-isolated Windows containers.'
  }
  $arguments = @(
    'create',
    '--name', $ContainerName,
    '--label', "org.labview-benchmark-actor.windows-docker-run=$RunId",
    '--label', 'org.labview-benchmark-actor.experiment=windows-docker-display-probe',
    "--isolation=$Isolation"
  )
  if ($AssignGpuDevice) {
    $arguments += @('--device', 'class/5B45201D-F2F2-4F3B-85BB-30FF1F953599')
  }
  $arguments += @(
    '--mount', "type=bind,source=$ExperimentRoot,target=C:\experiment,readonly",
    '--mount', "type=bind,source=$RunRoot,target=C:\evidence",
    $ImageReference,
    'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'C:\experiment\container-bootstrap.ps1',
    '-Action', 'DisplayProbe',
    '-DesktopTarget', $DesktopTarget,
    '-RunId', $RunId
  )
  return $arguments
}

function Assert-RunOwnedContainer {
  param(
    [Parameter(Mandatory = $true)]$Labels,
    [Parameter(Mandatory = $true)][string]$RunId
  )
  $actual = $Labels.'org.labview-benchmark-actor.windows-docker-run'
  if ($actual -ne $RunId) {
    throw "Refusing to manage a container not owned by run '$RunId' (owner label '$actual')."
  }
}

function New-VagrantBoxUpArgs {
  param([string]$Machine = 'default')
  return @('up', $Machine, '--provider', 'virtualbox', '--no-provision')
}

function Assert-RunOwnedVagrantVm {
  param(
    [Parameter(Mandatory = $true)][string]$ActualName,
    [Parameter(Mandatory = $true)][string]$ExpectedName,
    [Parameter(Mandatory = $true)][string]$ActualUuid,
    [Parameter(Mandatory = $true)][string]$SourceVmUuid
  )
  if ($ActualName -ne $ExpectedName) {
    throw "Refusing to manage Vagrant VM '$ActualName'; expected run-owned name '$ExpectedName'."
  }
  if ($ActualUuid -eq $SourceVmUuid) {
    throw 'Refusing to manage the retained source VM as a disposable Vagrant consumer.'
  }
}

function New-LoopbackVagrantNatRule {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Name,
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$HostPort,
    [ValidateRange(1, 65535)][int]$GuestPort = 5900
  )
  return "$Name,tcp,127.0.0.1,$HostPort,,$GuestPort"
}

function Invoke-WithOwnedCleanup {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Body,
    [Parameter(Mandatory = $true)][scriptblock]$Cleanup
  )
  try {
    & $Body
  } finally {
    & $Cleanup
  }
}

Export-ModuleMember -Function @(
  'Assert-WindowsHost',
  'Assert-DockerWindowsMode',
  'Assert-ImageContract',
  'New-SmokeContainerRunArgs',
  'New-ExperimentContainerCreateArgs',
  'New-DisplayProbeContainerCreateArgs',
  'Assert-RunOwnedContainer',
  'New-VagrantBoxUpArgs',
  'Assert-RunOwnedVagrantVm',
  'New-LoopbackVagrantNatRule',
  'Invoke-WithOwnedCleanup'
)
