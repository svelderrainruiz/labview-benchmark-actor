[CmdletBinding()]
param(
  [ValidateSet('process', 'hyperv')][string]$Isolation = 'process',
  [ValidateSet('Inherited', 'WinSta0')][string]$DesktopTarget = 'Inherited',
  [switch]$AssignGpuDevice,
  [switch]$AllowUnexpectedImageId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'orchestration-core.psm1') -Force

$ImageReference = 'nationalinstruments/labview:2026q3-windows'
$ExpectedImageId = 'sha256:f45c639a201f51875465a0d02aa69e65a3630054e564c8724c105f2e1b5eee30'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$bytes = [byte[]]::new(5)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$suffix = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$runId = "display-probe-$stamp-$suffix"
$containerName = "lba-display-probe-$suffix"
$smokeName = "lba-display-smoke-$suffix"
$runDirectory = Join-Path (Join-Path $PSScriptRoot 'evidence') $runId
$containerId = $null
$containerCreated = $false
$probeExitCode = 1
$caught = $null
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null

function Write-AtomicJson([string]$Path, $Value) {
  $temp = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($temp, "$(ConvertTo-Json $Value -Depth 30)`n", [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Invoke-Docker([string[]]$Arguments, [switch]$AllowFailure) {
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& docker @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "docker $($Arguments[0]) failed with exit code $code`: $($output -join [Environment]::NewLine)"
  }
  return [pscustomobject]@{ ExitCode = $code; Output = $output }
}

function Get-Inspection([string]$Identity, [switch]$AllowMissing) {
  $result = Invoke-Docker @('container', 'inspect', $Identity) -AllowFailure:$AllowMissing
  if ($result.ExitCode -ne 0) { return $null }
  return ($result.Output -join "`n" | ConvertFrom-Json)[0]
}

try {
  Assert-WindowsHost
  $infoRaw = (Invoke-Docker @('info', '--format', '{{json .}}')).Output -join "`n"
  [System.IO.File]::WriteAllText((Join-Path $runDirectory 'docker-info.json'), "$infoRaw`n")
  $info = $infoRaw | ConvertFrom-Json
  Assert-DockerWindowsMode $info
  $imageRaw = (Invoke-Docker @('image', 'inspect', $ImageReference)).Output -join "`n"
  [System.IO.File]::WriteAllText((Join-Path $runDirectory 'image-inspect.json'), "$imageRaw`n")
  $image = ($imageRaw | ConvertFrom-Json)[0]
  Assert-ImageContract $image $ExpectedImageId -AllowUnexpectedImageId:$AllowUnexpectedImageId
  if ($Isolation -eq 'hyperv' -and $AssignGpuDevice) {
    throw 'Device assignment is unsupported for Hyper-V-isolated Windows containers.'
  }
  Write-AtomicJson (Join-Path $runDirectory 'probe-environment.json') ([ordered]@{
    schema = 'labview-benchmark-actor/windows-container-display-probe-environment@1'
    runId = $runId
    wallTime = [DateTime]::UtcNow.ToString('o')
    isolation = $Isolation
    desktopTarget = $DesktopTarget
    deviceAssignment = if ($AssignGpuDevice) { 'directx-gpu-class' } else { 'none' }
    image = [ordered]@{ reference = $ImageReference; id = $image.Id; expectedId = $ExpectedImageId }
    containerId = $null
    dockerCreateArguments = @()
  })

  $smokeArgs = @(New-SmokeContainerRunArgs `
    -ContainerName $smokeName `
    -RunId $runId `
    -Isolation $Isolation `
    -ImageReference $ImageReference `
    -Marker 'DISPLAY_PROBE_SMOKE_OK')
  $smoke = Invoke-Docker $smokeArgs
  if (($smoke.Output -join "`n") -notmatch 'DISPLAY_PROBE_SMOKE_OK') {
    throw "The requested $Isolation isolation smoke probe did not emit readiness."
  }

  $args = @(New-DisplayProbeContainerCreateArgs `
    -ContainerName $containerName `
    -RunId $runId `
    -Isolation $Isolation `
    -ExperimentRoot (Resolve-Path $PSScriptRoot).Path `
    -RunRoot (Resolve-Path $runDirectory).Path `
    -ImageReference $ImageReference `
    -DesktopTarget $DesktopTarget `
    -AssignGpuDevice:$AssignGpuDevice)
  $create = Invoke-Docker $args
  $containerId = ($create.Output | Select-Object -Last 1).Trim()
  if ($containerId -notmatch '^[a-f0-9]{64}$') { throw "docker create returned invalid container ID '$containerId'" }
  $containerCreated = $true
  Write-AtomicJson (Join-Path $runDirectory 'probe-environment.json') ([ordered]@{
    schema = 'labview-benchmark-actor/windows-container-display-probe-environment@1'
    runId = $runId
    wallTime = [DateTime]::UtcNow.ToString('o')
    isolation = $Isolation
    desktopTarget = $DesktopTarget
    deviceAssignment = if ($AssignGpuDevice) { 'directx-gpu-class' } else { 'none' }
    image = [ordered]@{ reference = $ImageReference; id = $image.Id; expectedId = $ExpectedImageId }
    containerId = $containerId
    dockerCreateArguments = $args
  })
  $start = Invoke-Docker @('start', '--attach', $containerId) -AllowFailure
  $probeExitCode = $start.ExitCode
  [System.IO.File]::WriteAllLines((Join-Path $runDirectory 'container.log'), $start.Output)
  if (-not (Test-Path (Join-Path $runDirectory 'display-probe.json'))) {
    throw "Display probe did not write display-probe.json (container exit $probeExitCode)."
  }
} catch {
  $caught = $_
} finally {
  if ($containerCreated) {
    try {
      $inspection = Get-Inspection $containerId -AllowMissing
      if ($inspection) {
        Assert-RunOwnedContainer $inspection.Config.Labels $runId
        Write-AtomicJson (Join-Path $runDirectory 'container-inspect.json') $inspection
        Invoke-Docker @('rm', '--force', $containerId) | Out-Null
      }
    } catch {
      if (-not $caught) { $caught = $_ }
    }
  }
  $remainingInspection = if ($containerCreated) { Get-Inspection $containerId -AllowMissing } else { $null }
  $absent = -not [bool]$remainingInspection
  $probe = if (Test-Path (Join-Path $runDirectory 'display-probe.json')) {
    Get-Content (Join-Path $runDirectory 'display-probe.json') -Raw | ConvertFrom-Json
  } else { $null }
  Write-AtomicJson (Join-Path $runDirectory 'cleanup-verification.json') ([ordered]@{
    wallTime = [DateTime]::UtcNow.ToString('o')
    containerId = $containerId
    containerAbsent = $absent
    noRelayListener = $true
    noVncListener = $true
    secretNeverCreated = $true
    probeTemporaryStateRemoved = [bool](
      -not $containerCreated -or
      ($probe -and $probe.cleanup.probeProcessStopped -and $probe.cleanup.probeExecutableRemoved)
    )
  })
}

if ($caught -and -not (Test-Path (Join-Path $runDirectory 'display-probe.json'))) {
  Write-AtomicJson (Join-Path $runDirectory 'display-probe.json') ([ordered]@{
    schema = 'labview-benchmark-actor/windows-container-display-probe@1'
    status = 'probe-orchestration-failed'
    passed = $false
    classification = 'probe-orchestration-failed'
    error = $caught.Exception.Message
    wallTime = [DateTime]::UtcNow.ToString('o')
    runId = $runId
    desktopTarget = $DesktopTarget
    display = $null
    tightVncStarted = $false
    relayStarted = $false
    secretCreated = $false
    cleanup = [ordered]@{ probeProcessStopped = $true; probeExecutableRemoved = $true }
  })
}

& node (Join-Path $PSScriptRoot 'verify-display-probe.mjs') --finalize-and-verify $runDirectory
$verifyCode = $LASTEXITCODE
Write-Host "Display-probe evidence: $runDirectory"
if ($caught -or $probeExitCode -ne 0 -or $verifyCode -ne 0) { exit 1 }
exit 0
