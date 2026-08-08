$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'orchestration-core.psm1') -Force
Add-Type -Path (Join-Path $PSScriptRoot 'display-surface.cs') -ReferencedAssemblies @('System', 'System.Core', 'System.Drawing')

function Assert-Throws([scriptblock]$Body, [string]$Pattern) {
  try {
    & $Body
  } catch {
    if ($_.Exception.Message -notmatch $Pattern) {
      throw "Expected error matching '$Pattern', got '$($_.Exception.Message)'."
    }
    return
  }
  throw "Expected error matching '$Pattern', but no error was thrown."
}

Assert-WindowsHost -Platform 'Win32NT'
Assert-Throws { Assert-WindowsHost -Platform 'Unix' } 'requires a Windows host'
Assert-DockerWindowsMode ([pscustomobject]@{ OSType = 'windows' })
Assert-Throws { Assert-DockerWindowsMode ([pscustomobject]@{ OSType = 'linux' }) } 'Windows-container mode'

$expected = 'sha256:' + ('a' * 64)
$goodImage = [pscustomobject]@{ Os = 'windows'; Architecture = 'amd64'; Id = $expected }
Assert-ImageContract -ImageInspection $goodImage -ExpectedId $expected
Assert-Throws { Assert-ImageContract -ImageInspection $null -ExpectedId $expected } 'local image is missing'
Assert-Throws {
  Assert-ImageContract -ImageInspection ([pscustomobject]@{ Os = 'linux'; Architecture = 'amd64'; Id = $expected }) -ExpectedId $expected
} 'windows/amd64'
Assert-Throws {
  Assert-ImageContract -ImageInspection ([pscustomobject]@{ Os = 'windows'; Architecture = 'amd64'; Id = ('sha256:' + ('b' * 64)) }) -ExpectedId $expected
} 'Image ID mismatch'
Assert-ImageContract -ImageInspection ([pscustomobject]@{ Os = 'windows'; Architecture = 'amd64'; Id = 'override' }) -ExpectedId $expected -AllowUnexpectedImageId
$processSmoke = @(New-SmokeContainerRunArgs -ContainerName 'process-smoke' -RunId 'process-run' -Isolation process -ImageReference 'image')
$hypervSmoke = @(New-SmokeContainerRunArgs -ContainerName 'hyperv-smoke' -RunId 'hyperv-run' -Isolation hyperv -ImageReference 'image')
if ($processSmoke -notcontains '--isolation=process' -or $hypervSmoke -notcontains '--isolation=hyperv') {
  throw 'Smoke arguments did not propagate the requested isolation mode.'
}
if ($processSmoke -contains '--publish' -or $hypervSmoke -contains '--device') {
  throw 'Smoke arguments unexpectedly publish ports or assign devices.'
}

$createArgs = @(New-ExperimentContainerCreateArgs `
  -ContainerName 'lba-test' `
  -RunId 'run-selftest' `
  -Isolation 'process' `
  -ExperimentRoot 'C:\experiment-source' `
  -RunRoot 'C:\evidence-source' `
  -SecretRoot 'C:\secret-source' `
  -ImageReference 'nationalinstruments/labview:2026q3-windows' `
  -TightVncSha256 ('a' * 64) `
  -TightVncVersion '2.8.81' `
  -DesktopTarget 'Inherited' `
  -TightVncCaptureMode 'StandardGdi' `
  -BootstrapInstaller 'C:\run-secrets\tightvnc.msi' `
  -LbaBusPath 'C:\run-secrets\lbabus\lbabus.dll')
if ($createArgs[0] -ne 'create' -or $createArgs -contains '--publish' -or $createArgs -contains '-p') {
  throw 'Container create arguments must omit every Docker publish option.'
}
if ($createArgs -notcontains '--mount' -or $createArgs -notcontains '--isolation=process') {
  throw 'Container create arguments lost required isolation or mounts.'
}
if ($createArgs -contains '--device' -or $createArgs -notcontains 'Inherited' -or $createArgs -notcontains 'StandardGdi') {
  throw 'Default container arguments must select inherited standard-GDI mode without a GPU device.'
}
if ($createArgs -notcontains '-LbaBusPath' -or $createArgs -notcontains 'C:\run-secrets\lbabus\lbabus.dll') {
  throw 'Container arguments did not propagate the mounted lbabus payload.'
}
$transportArgs = @(New-ExperimentContainerCreateArgs `
  -ContainerName 'lba-transport-test' `
  -RunId 'run-transport-selftest' `
  -Isolation 'process' `
  -ExperimentRoot 'C:\experiment-source' `
  -RunRoot 'C:\evidence-source' `
  -SecretRoot 'C:\secret-source' `
  -ImageReference 'nationalinstruments/labview:2026q3-windows' `
  -TightVncSha256 ('a' * 64) `
  -TightVncVersion '2.8.81' `
  -DesktopTarget 'WinSta0' `
  -TightVncCaptureMode 'StandardGdi' `
  -TransportOnly)
if ($transportArgs -notcontains '-TransportOnly' -or $transportArgs -notcontains 'WinSta0') {
  throw 'Transport-only arguments did not retain the explicit WinSta0 boundary.'
}
Assert-Throws {
  New-ExperimentContainerCreateArgs `
    -ContainerName 'lba-invalid-transport' `
    -RunId 'run-invalid-transport' `
    -Isolation 'process' `
    -ExperimentRoot 'C:\experiment-source' `
    -RunRoot 'C:\evidence-source' `
    -SecretRoot 'C:\secret-source' `
    -ImageReference 'nationalinstruments/labview:2026q3-windows' `
    -TightVncSha256 ('a' * 64) `
    -TightVncVersion '2.8.81' `
    -DesktopTarget 'Inherited' `
    -TightVncCaptureMode 'StandardGdi' `
    -TransportOnly
} 'restricted to the explicit WinSta0'
$gpuArgs = @(New-ExperimentContainerCreateArgs `
  -ContainerName 'lba-gpu-test' `
  -RunId 'run-gpu-selftest' `
  -Isolation 'process' `
  -ExperimentRoot 'C:\experiment-source' `
  -RunRoot 'C:\evidence-source' `
  -SecretRoot 'C:\secret-source' `
  -ImageReference 'nationalinstruments/labview:2026q3-windows' `
  -TightVncSha256 ('a' * 64) `
  -TightVncVersion '2.8.81' `
  -DesktopTarget 'WinSta0' `
  -TightVncCaptureMode 'D3d' `
  -AssignGpuDevice)
if ($gpuArgs -notcontains '--device' -or $gpuArgs -notcontains 'class/5B45201D-F2F2-4F3B-85BB-30FF1F953599') {
  throw 'Explicit GPU-device arguments were not added.'
}
Assert-Throws {
  New-ExperimentContainerCreateArgs `
    -ContainerName 'lba-invalid-hyperv-main' `
    -RunId 'run-invalid-hyperv-main' `
    -Isolation 'hyperv' `
    -ExperimentRoot 'C:\experiment-source' `
    -RunRoot 'C:\evidence-source' `
    -SecretRoot 'C:\secret-source' `
    -ImageReference 'nationalinstruments/labview:2026q3-windows' `
    -TightVncSha256 ('a' * 64) `
    -TightVncVersion '2.8.81' `
    -DesktopTarget 'Inherited' `
    -TightVncCaptureMode 'StandardGdi' `
    -AssignGpuDevice
} 'unsupported for Hyper-V-isolated'
$hypervProbeArgs = @(New-DisplayProbeContainerCreateArgs `
  -ContainerName 'lba-hyperv-probe' `
  -RunId 'run-hyperv-probe' `
  -Isolation 'hyperv' `
  -ExperimentRoot 'C:\experiment-source' `
  -RunRoot 'C:\evidence-source' `
  -ImageReference 'nationalinstruments/labview:2026q3-windows')
if (
  $hypervProbeArgs -notcontains '--isolation=hyperv' -or
  $hypervProbeArgs -contains '--device' -or
  $hypervProbeArgs -contains '--publish' -or
  $hypervProbeArgs -contains 'C:\run-secrets\vnc-password.txt' -or
  $hypervProbeArgs -notcontains 'DisplayProbe'
) {
  throw 'Hyper-V display-probe arguments violated isolation/no-secret/no-device/no-publish requirements.'
}
Assert-Throws {
  New-DisplayProbeContainerCreateArgs `
    -ContainerName 'lba-invalid-hyperv-probe' `
    -RunId 'run-invalid-hyperv-probe' `
    -Isolation 'hyperv' `
    -ExperimentRoot 'C:\experiment-source' `
    -RunRoot 'C:\evidence-source' `
    -ImageReference 'nationalinstruments/labview:2026q3-windows' `
    -AssignGpuDevice
} 'unsupported for Hyper-V-isolated'
$processProbeArgs = @(New-DisplayProbeContainerCreateArgs `
  -ContainerName 'lba-process-probe' `
  -RunId 'run-process-probe' `
  -Isolation 'process' `
  -ExperimentRoot 'C:\experiment-source' `
  -RunRoot 'C:\evidence-source' `
  -ImageReference 'nationalinstruments/labview:2026q3-windows' `
  -AssignGpuDevice)
if ($processProbeArgs -notcontains '--isolation=process' -or $processProbeArgs -notcontains '--device') {
  throw 'Process display-probe arguments did not propagate requested isolation/device assignment.'
}
$inherited = [LbaDesktop]::Configure('Inherited')
if ($inherited.mode -ne 'Inherited' -or $inherited.explicitStartupDesktop -or $inherited.processWindowStationChanged) {
  throw 'Inherited desktop mode did not preserve the current GUI context.'
}
$displaySource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'display-surface.cs') -Raw
if ($displaySource -match 'Service-0x') {
  throw 'A dynamic service-window-station name was hardcoded.'
}
if ($displaySource -notmatch 'mode == "WinSta0"' -or $displaySource -notmatch 'SetProcessWindowStation') {
  throw 'WinSta0 explicit baseline behavior is missing.'
}

$runId = 'run-selftest'
$labels = [pscustomobject]@{ 'org.labview-benchmark-actor.windows-docker-run' = $runId }
Assert-RunOwnedContainer -Labels $labels -RunId $runId
Assert-Throws {
  Assert-RunOwnedContainer -Labels ([pscustomobject]@{ 'org.labview-benchmark-actor.windows-docker-run' = 'other' }) -RunId $runId
} 'Refusing to manage'

$vagrantUpArgs = @(New-VagrantBoxUpArgs)
if (
  ($vagrantUpArgs -join ' ') -ne 'up default --provider virtualbox --no-provision' -or
  $vagrantUpArgs -contains 'provision'
) {
  throw 'Vagrant box proof arguments must use VirtualBox with provisioning disabled.'
}
Assert-RunOwnedVagrantVm `
  -ActualName 'lba-box-proof-1234' `
  -ExpectedName 'lba-box-proof-1234' `
  -ActualUuid '11111111-1111-1111-1111-111111111111' `
  -SourceVmUuid '22222222-2222-2222-2222-222222222222'
Assert-Throws {
  Assert-RunOwnedVagrantVm `
    -ActualName 'unrelated' `
    -ExpectedName 'lba-box-proof-1234' `
    -ActualUuid '11111111-1111-1111-1111-111111111111' `
    -SourceVmUuid '22222222-2222-2222-2222-222222222222'
} 'Refusing to manage'
Assert-Throws {
  Assert-RunOwnedVagrantVm `
    -ActualName 'lba-box-proof-1234' `
    -ExpectedName 'lba-box-proof-1234' `
    -ActualUuid '22222222-2222-2222-2222-222222222222' `
    -SourceVmUuid '22222222-2222-2222-2222-222222222222'
} 'retained source VM'
$natRule = New-LoopbackVagrantNatRule -Name 'lba-proof' -HostPort 49152
if ($natRule -ne 'lba-proof,tcp,127.0.0.1,49152,,5900') {
  throw 'Vagrant NAT rule must bind only to IPv4 loopback.'
}

$cleanupState = [pscustomobject]@{ Cleaned = $false }
Assert-Throws {
  Invoke-WithOwnedCleanup -Body { throw 'forced failure' } -Cleanup { $cleanupState.Cleaned = $true }
} 'forced failure'
if (-not $cleanupState.Cleaned) {
  throw 'Owned cleanup did not run after the forced failure.'
}

Write-Host 'windows-docker orchestration core self-test: PASS'
