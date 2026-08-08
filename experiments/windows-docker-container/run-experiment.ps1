[CmdletBinding()]
param(
  [ValidateSet('process', 'hyperv')][string]$Isolation = 'process',
  [ValidateRange(1, 60)][double]$FramesPerSecond = 12,
  [ValidateRange(5, 600)][int]$CaptureDurationSeconds = 60,
  [ValidateRange(5, 120)][int]$RfbTimeoutSeconds = 30,
  [ValidateRange(15, 300)][int]$LaunchWindowTimeoutSeconds = 45,
  [ValidateRange(5, 30)][int]$LaunchAliveSeconds = 10,
  [ValidateRange(1, 120)][int]$SettleWindow = 8,
  [ValidateRange(0, 64)][int]$SettleTolerance = 2,
  [ValidateSet('Inherited', 'WinSta0')][string]$DesktopTarget = 'Inherited',
  [ValidateSet('StandardGdi', 'D3d')][string]$TightVncCaptureMode = 'StandardGdi',
  [switch]$TransportOnly,
  [switch]$AssignGpuDevice,
  [string]$TightVncInstaller,
  [switch]$AllowUnexpectedImageId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'orchestration-core.psm1') -Force

$ImageReference = 'nationalinstruments/labview:2026q3-windows'
$ExpectedImageId = 'sha256:f45c639a201f51875465a0d02aa69e65a3630054e564c8724c105f2e1b5eee30'
$TightVncVersion = '2.8.81'
$TightVncSha256 = '0d6402e530a563c90040d7c07b98ab68670d3669e4cc573ad24056ff960c9dcb'
$EvidenceRoot = Join-Path $PSScriptRoot 'evidence'
$runStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$randomBytes = [byte[]]::new(5)
$randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $randomGenerator.GetBytes($randomBytes) } finally { $randomGenerator.Dispose() }
$randomSuffix = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })
$runId = "$runStamp-$randomSuffix"
$containerName = "lba-win-vnc-$randomSuffix"
$smokeName = "lba-win-vnc-smoke-$randomSuffix"
$runDirectory = Join-Path $EvidenceRoot $runId
$hostLog = Join-Path $runDirectory 'host-orchestration.log'
$secretDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "lba-win-vnc-$runId"
$passwordFile = Join-Path $secretDirectory 'vnc-password.txt'
$containerCreated = $false
$containerId = $null
$resolvedImageId = $null
$relayPort = $null
$captureStarted = $false
$dockerPublishedPortsAbsent = $false
$hostFailureClassification = $null
$failedGate = 1
$outcome = 'inconclusive'
$caughtError = $null
$containerDebugLineCount = 0
$lbabusStage = $null

New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null

function Write-RunLog([string]$Message) {
  $line = '{0} {1}' -f [DateTime]::UtcNow.ToString('o'), $Message
  Write-Host $line
  Add-Content -LiteralPath $hostLog -Value $line -Encoding UTF8
}

function Write-AtomicJson([string]$Path, $Value) {
  $temp = "$Path.$PID.tmp"
  $json = $Value | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText($temp, "$json`n", [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Invoke-Docker([string[]]$Arguments, [switch]$AllowFailure) {
  $renderedArguments = @($Arguments | ForEach-Object {
    if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ }
  }) -join ' '
  Write-RunLog "[docker] > docker $renderedArguments"
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& docker @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  Write-RunLog "[docker] < exit=$code, outputLines=$(@($output).Count)"
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "docker $($Arguments[0]) failed with exit code $code`: $($output -join [Environment]::NewLine)"
  }
  return [pscustomobject]@{ ExitCode = $code; Output = $output }
}

function Invoke-NativeLogged([string]$FilePath, [string[]]$Arguments, [string]$Prefix) {
  Write-RunLog "[$Prefix] > $FilePath $($Arguments -join ' ')"
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  foreach ($line in $output) { Write-RunLog "[$Prefix] $line" }
  Write-RunLog "[$Prefix] < exit=$code, outputLines=$(@($output).Count)"
  if ($code -ne 0) {
    throw "$FilePath failed with exit code $code."
  }
  return [pscustomobject]@{ ExitCode = $code; Output = $output }
}

function Sync-ContainerDebugLog {
  $debugPath = Join-Path $runDirectory 'container-debug.log'
  if (-not (Test-Path -LiteralPath $debugPath)) { return }
  try {
    $lines = @([System.IO.File]::ReadAllLines($debugPath))
  } catch [System.IO.IOException] {
    Write-RunLog "[container-live] debug log read deferred: $($_.Exception.Message)"
    return
  }
  if ($lines.Count -lt $script:containerDebugLineCount) {
    Write-RunLog '[container-live] warning: append-only debug log was truncated; replaying its current contents.'
    $script:containerDebugLineCount = 0
  }
  for ($index = $script:containerDebugLineCount; $index -lt $lines.Count; $index++) {
    $line = "[container-live] $($lines[$index])"
    Write-Host $line
    Add-Content -LiteralPath $hostLog -Value $line -Encoding UTF8
  }
  $script:containerDebugLineCount = $lines.Count
}

function Test-TcpEndpoint([int]$Port, [int]$TimeoutMs = 1000) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    return $task.Wait($TimeoutMs) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-ContainerInspection([string]$Identity, [switch]$AllowMissing) {
  $result = Invoke-Docker @('container', 'inspect', $Identity) -AllowFailure:$AllowMissing
  if ($result.ExitCode -ne 0) { return $null }
  return ($result.Output -join "`n" | ConvertFrom-Json)[0]
}

function Write-HostFailureReceipt(
  [int]$Gate,
  [string]$Message,
  [ValidateSet('inconclusive', 'blocked')][string]$FailureOutcome = 'inconclusive',
  [string]$Classification,
  [switch]$PreserveCaptureSummary
) {
  $receipt = [ordered]@{
    schema = 'labview-benchmark-actor/windows-docker-tightvnc-failure@1'
    outcome = $FailureOutcome
    failedGate = $Gate
    classification = if ($Classification) { $Classification } elseif ($Gate -eq 1) { 'environment-preflight-failed' } elseif ($Gate -eq 2) { 'tightvnc-readiness-failed' } else { 'capture-failed' }
    error = $Message
    wallTime = [DateTime]::UtcNow.ToString('o')
    runId = $runId
    image = [ordered]@{ reference = $ImageReference; expectedId = $ExpectedImageId; resolvedId = $resolvedImageId }
    containerId = $containerId
    isolation = $Isolation
    desktopTarget = $DesktopTarget
    tightVncCaptureMode = $TightVncCaptureMode
    gpuDeviceAssigned = [bool]$AssignGpuDevice
    tightVncInstallerSha256 = $TightVncSha256
    recommendedNextHypothesis = if ($Classification -eq 'host-to-container-route-unavailable') {
      'Inspect Windows Docker NAT routing and endpoint policy read-only before requesting approval for any host change.'
    } elseif ($Classification -eq 'container-listener-unavailable') {
      'Inspect TightVNC process, session, and in-container listener diagnostics.'
    } elseif ($Gate -eq 1) {
      'Correct the Windows Docker mode or exact local image contract before retrying.'
    } elseif ($Gate -eq 6) {
      'Resolve the run-owned container or listener cleanup failure before any retry.'
    } else {
      'Inspect the preserved container and RFB diagnostics for the failed proof gate.'
    }
  }
  Write-AtomicJson (Join-Path $runDirectory 'failure-receipt.json') $receipt
  if ($PreserveCaptureSummary) {
    $summaryPath = Join-Path $runDirectory 'capture-summary.json'
    $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
    $summary | Add-Member -NotePropertyName captureOutcome -NotePropertyValue $summary.outcome -Force
    $summary | Add-Member -NotePropertyName outcome -NotePropertyValue 'inconclusive' -Force
    $summary | Add-Member -NotePropertyName failedGate -NotePropertyValue $Gate -Force
    $summary | Add-Member -NotePropertyName error -NotePropertyValue $Message -Force
    Write-AtomicJson $summaryPath $summary
  } else {
    Write-AtomicJson (Join-Path $runDirectory 'capture-summary.json') $receipt
  }
}

try {
  Write-RunLog "Starting Windows Docker TightVNC experiment run '$runId'."
  Assert-WindowsHost
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker.exe was not found on PATH.' }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node.exe was not found on PATH.' }

  $dockerInfoResult = Invoke-Docker @('info', '--format', '{{json .}}')
  $dockerInfoRaw = $dockerInfoResult.Output -join "`n"
  [System.IO.File]::WriteAllText((Join-Path $runDirectory 'docker-info.json'), "$dockerInfoRaw`n", [System.Text.UTF8Encoding]::new($false))
  $dockerInfo = $dockerInfoRaw | ConvertFrom-Json
  Assert-DockerWindowsMode $dockerInfo

  $imageInspectResult = Invoke-Docker @('image', 'inspect', $ImageReference)
  $imageInspectRaw = $imageInspectResult.Output -join "`n"
  [System.IO.File]::WriteAllText((Join-Path $runDirectory 'image-inspect.json'), "$imageInspectRaw`n", [System.Text.UTF8Encoding]::new($false))
  $imageInspection = ($imageInspectRaw | ConvertFrom-Json)[0]
  Assert-ImageContract -ImageInspection $imageInspection -ExpectedId $ExpectedImageId -AllowUnexpectedImageId:$AllowUnexpectedImageId
  $resolvedImageId = $imageInspection.Id
  Write-RunLog "Gate 1 image contract passed: $($imageInspection.Id), $($imageInspection.Os)/$($imageInspection.Architecture)."

  if (Get-ContainerInspection $smokeName -AllowMissing) {
    throw "Refusing to reuse or remove pre-existing smoke container '$smokeName'."
  }
  $smokeArgs = @(New-SmokeContainerRunArgs `
    -ContainerName $smokeName `
    -RunId $runId `
    -Isolation $Isolation `
    -ImageReference $ImageReference `
    -Marker 'SMOKE_OK')
  $smoke = Invoke-Docker $smokeArgs
  if (($smoke.Output -join "`n") -notmatch 'SMOKE_OK') { throw 'Process-isolated smoke container did not emit its readiness marker.' }
  Write-RunLog 'Gate 1 passed: Docker is in Windows mode and the process-isolated smoke container exited successfully.'

  New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  if (-not $dotnet) { throw 'dotnet is required to stage the repository lbabus tool for the container probe.' }
  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  $lbabusProject = Join-Path $repoRoot 'tools\collab-cli\LbaBus.csproj'
  $lbabusOutput = Join-Path $secretDirectory 'lbabus'
  $lbabusArtifacts = Join-Path $secretDirectory 'lbabus-artifacts'
  Write-RunLog 'Publishing the repository lbabus tool into the ephemeral read-only container mount.'
  Invoke-NativeLogged $dotnet.Source @(
    'publish', $lbabusProject,
    '--configuration', 'Release',
    '--output', $lbabusOutput,
    '--artifacts-path', $lbabusArtifacts,
    '--nologo',
    '--verbosity', 'minimal'
  ) 'lbabus-publish' | Out-Null
  $lbabusDll = Join-Path $lbabusOutput 'lbabus.dll'
  if (-not (Test-Path -LiteralPath $lbabusDll)) { throw "lbabus publish did not produce '$lbabusDll'." }
  $lbabusVersionResult = Invoke-NativeLogged $dotnet.Source @($lbabusDll, 'version') 'lbabus-host-probe'
  $lbabusVersion = @($lbabusVersionResult.Output | Where-Object { $_.Trim() } | Select-Object -Last 1)[0].Trim()
  if ($lbabusVersion -notmatch '^\d+\.\d+\.\d+$') { throw "Published lbabus returned invalid version '$lbabusVersion'." }
  $lbabusStage = [ordered]@{
    schema = 'labview-benchmark-actor/windows-container-lbabus-stage@1'
    wallTime = [DateTime]::UtcNow.ToString('o')
    sourceProject = 'tools/collab-cli/LbaBus.csproj'
    version = $lbabusVersion
    payload = 'C:\run-secrets\lbabus\lbabus.dll'
    payloadSha256 = (Get-FileHash -LiteralPath $lbabusDll -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  Write-AtomicJson (Join-Path $runDirectory 'lbabus-host-stage.json') $lbabusStage
  Write-RunLog "lbabus payload staged: version=$lbabusVersion, SHA-256=$($lbabusStage.payloadSha256)."

  if ($TightVncInstaller) {
    $resolvedInstaller = (Resolve-Path -LiteralPath $TightVncInstaller).Path
    $installerHash = (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($installerHash -ne $TightVncSha256) {
      throw "Cached TightVNC installer SHA-256 mismatch: expected '$TightVncSha256', got '$installerHash'."
    }
    Copy-Item -LiteralPath $resolvedInstaller -Destination (Join-Path $secretDirectory 'tightvnc.msi')
    Write-RunLog "Using the locally cached, SHA-256-verified TightVNC $TightVncVersion installer."
  } else {
    Write-RunLog "No local TightVNC installer supplied; the bootstrap will use the pinned official HTTPS URL and verify SHA-256."
  }

  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $secretBytes = [byte[]]::new(8)
  $secretGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $secretGenerator.GetBytes($secretBytes) } finally { $secretGenerator.Dispose() }
  $passwordChars = for ($i = 0; $i -lt 8; $i++) { $alphabet[$secretBytes[$i] % $alphabet.Length] }
  $vncPassword = -join $passwordChars
  [System.IO.File]::WriteAllText($passwordFile, $vncPassword, [System.Text.UTF8Encoding]::new($false))
  $vncPassword = $null

  $failedGate = 2
  $hostFailureClassification = 'container-listener-unavailable'
  if (Get-ContainerInspection $containerName -AllowMissing) {
    throw "Refusing to reuse or remove pre-existing container '$containerName'."
  }
  $experimentRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
  $runRoot = (Resolve-Path -LiteralPath $runDirectory).Path
  $secretRoot = (Resolve-Path -LiteralPath $secretDirectory).Path
  $bootstrapInstaller = if (Test-Path (Join-Path $secretDirectory 'tightvnc.msi')) { 'C:\run-secrets\tightvnc.msi' } else { '' }
  $bootstrapLbaBus = 'C:\run-secrets\lbabus\lbabus.dll'
  $createArgs = @(New-ExperimentContainerCreateArgs `
    -ContainerName $containerName `
    -RunId $runId `
    -Isolation $Isolation `
    -ExperimentRoot $experimentRoot `
    -RunRoot $runRoot `
    -SecretRoot $secretRoot `
    -ImageReference $ImageReference `
    -TightVncSha256 $TightVncSha256 `
    -TightVncVersion $TightVncVersion `
    -DesktopTarget $DesktopTarget `
    -TightVncCaptureMode $TightVncCaptureMode `
    -TransportOnly:$TransportOnly `
    -AssignGpuDevice:$AssignGpuDevice `
    -BootstrapInstaller $bootstrapInstaller `
    -LbaBusPath $bootstrapLbaBus)
  $createResult = Invoke-Docker $createArgs
  $containerId = ($createResult.Output | Select-Object -Last 1).Trim()
  if ($containerId -notmatch '^[a-f0-9]{12,64}$') { throw "docker create did not return a container ID (got '$containerId')." }
  $containerCreated = $true
  Write-RunLog "Created run-owned container '$containerName' ($containerId) with isolation '$Isolation'."
  Invoke-Docker @('start', $containerId) | Out-Null

  $readyPath = Join-Path $runDirectory 'bootstrap-ready.json'
  $readyDeadline = [DateTime]::UtcNow.AddMinutes(4)
  while (-not (Test-Path -LiteralPath $readyPath)) {
    Sync-ContainerDebugLog
    $state = Get-ContainerInspection $containerId
    if (-not $state.State.Running) {
      $earlyLogs = Invoke-Docker @('logs', $containerId) -AllowFailure
      $bootstrapFailurePath = Join-Path $runDirectory 'bootstrap-failure.json'
      if (Test-Path -LiteralPath $bootstrapFailurePath) {
        $bootstrapFailure = Get-Content -LiteralPath $bootstrapFailurePath -Raw | ConvertFrom-Json
        $failedGate = [int]$bootstrapFailure.failedGate
        $hostFailureClassification = $bootstrapFailure.classification
      }
      throw "Container exited before TightVNC readiness. Logs:`n$($earlyLogs.Output -join [Environment]::NewLine)"
    }
    if ([DateTime]::UtcNow -ge $readyDeadline) { throw 'Timed out waiting for bootstrap-ready.json from the container.' }
    Start-Sleep -Milliseconds 500
  }
  Sync-ContainerDebugLog
  $bootstrapReady = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
  if ($bootstrapReady.status -ne 'ready' -or -not $bootstrapReady.vnc.processAlive -or -not $bootstrapReady.vnc.port5900Listening) {
    $hostFailureClassification = 'container-listener-unavailable'
    throw "Container bootstrap did not prove TightVNC readiness: $($bootstrapReady | ConvertTo-Json -Depth 10 -Compress)"
  }
  $lbabusContainerEvidencePath = Join-Path $runDirectory 'lbabus-container.json'
  if (-not (Test-Path -LiteralPath $lbabusContainerEvidencePath)) {
    throw 'Container bootstrap did not produce lbabus capability evidence.'
  }
  $lbabusContainerEvidence = Get-Content -LiteralPath $lbabusContainerEvidencePath -Raw | ConvertFrom-Json
  if (
    $lbabusContainerEvidence.status -ne 'passed' -or
    $lbabusContainerEvidence.version -ne $lbabusStage.version -or
    $lbabusContainerEvidence.payloadSha256 -ne $lbabusStage.payloadSha256
  ) {
    throw 'Container lbabus capability evidence disagrees with the host-staged payload.'
  }
  Write-RunLog "Container lbabus probe passed: version=$($lbabusContainerEvidence.version), LabVIEWCLI capability output retained."

  $preRelayInspection = Get-ContainerInspection $containerId
  Assert-RunOwnedContainer -Labels $preRelayInspection.Config.Labels -RunId $runId
  Write-AtomicJson (Join-Path $runDirectory 'container-inspect-pre-relay.json') $preRelayInspection
  $networkPreflightPath = Join-Path $runDirectory 'network-preflight.json'
  & node (Join-Path $PSScriptRoot 'network-preflight.mjs') `
    --container-id $containerId `
    --output $networkPreflightPath `
    --timeout-ms 5000
  $networkPreflightExitCode = $LASTEXITCODE
  $networkPreflight = Get-Content -LiteralPath $networkPreflightPath -Raw | ConvertFrom-Json
  if ($networkPreflightExitCode -ne 0 -or $networkPreflight.status -ne 'passed') {
    $hostFailureClassification = $networkPreflight.classification
    throw "Private-network preflight failed: $($networkPreflight.error)"
  }
  $dockerPublishedPortsAbsent = $networkPreflight.dockerPublishedPorts.Count -eq 0 -and $networkPreflight.dockerPortOutput.Count -eq 0
  if (-not $dockerPublishedPortsAbsent) { throw 'Docker unexpectedly reports a published port for the experiment container.' }
  Write-RunLog "Gate 2 preflight passed: no Docker publication; host reached $($networkPreflight.target.ipAddress):5900 on network '$($networkPreflight.target.networkName)'."

  $hostOs = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
  $environment = [ordered]@{
    schema = 'labview-benchmark-actor/windows-docker-environment@1'
    runId = $runId
    wallTime = [DateTime]::UtcNow.ToString('o')
    hostOs = $hostOs
    docker = [ordered]@{ serverVersion = $dockerInfo.ServerVersion; osType = $dockerInfo.OSType }
    image = [ordered]@{
      reference = $ImageReference
      id = $imageInspection.Id
      expectedId = $ExpectedImageId
      unexpectedIdOverride = [bool]$AllowUnexpectedImageId
      os = $imageInspection.Os
      architecture = $imageInspection.Architecture
    }
    container = [ordered]@{
      id = $containerId
      name = $containerName
      isolation = $Isolation
      desktopTarget = $DesktopTarget
      transportOnly = [bool]$TransportOnly
      gpuDeviceAssigned = [bool]$AssignGpuDevice
      network = $networkPreflight.target
      dockerPublishedPorts = @()
    }
    containerOs = $bootstrapReady.containerOs
    display = $bootstrapReady.display
    tightVnc = [ordered]@{
      version = $TightVncVersion
      installerSha256 = $TightVncSha256
      installerSource = if ($TightVncInstaller) { 'local-cache' } else { 'official-https' }
      authentication = 'ephemeral VNC authentication'
      captureMode = $TightVncCaptureMode
    }
    lbabus = [ordered]@{
      hostStage = $lbabusStage
      containerProbe = $lbabusContainerEvidence
    }
  }
  $environmentPath = Join-Path $runDirectory 'environment.json'
  Write-AtomicJson $environmentPath $environment

  $failedGate = 2
  $captureArgs = @(
    (Join-Path $PSScriptRoot 'capture.mjs'),
    '--evidence-dir', $runDirectory,
    '--environment-json', $environmentPath,
    '--password-file', $passwordFile,
    '--container-id', $containerId,
    '--network-preflight-json', $networkPreflightPath,
    '--bootstrap-ready-json', $readyPath,
    '--fps', "$FramesPerSecond",
    '--duration-ms', "$($CaptureDurationSeconds * 1000)",
    '--rfb-timeout-ms', "$($RfbTimeoutSeconds * 1000)",
    '--launch-window-timeout-seconds', "$LaunchWindowTimeoutSeconds",
    '--launch-alive-seconds', "$LaunchAliveSeconds",
    '--settle-window', "$SettleWindow",
    '--settle-tolerance', "$SettleTolerance"
  )
  $captureStarted = $true
  Write-RunLog 'Starting the loopback relay and host RFB capture before issuing the LabVIEW launch trigger.'
  & node @captureArgs 2>&1 | ForEach-Object {
    Write-Host $_
    Add-Content -LiteralPath $hostLog -Value $_ -Encoding UTF8
  }
  $captureExitCode = $LASTEXITCODE
  if ($captureExitCode -ne 0) {
    $captureSummaryPath = Join-Path $runDirectory 'capture-summary.json'
    if (Test-Path $captureSummaryPath) {
      $captureSummary = Get-Content -LiteralPath $captureSummaryPath -Raw | ConvertFrom-Json
      if ($captureSummary.failedGate) { $failedGate = [int]$captureSummary.failedGate }
    }
    throw "Host capture failed proof gate $failedGate with exit code $captureExitCode."
  }
  $captureSummary = Get-Content -LiteralPath (Join-Path $runDirectory 'capture-summary.json') -Raw | ConvertFrom-Json
  $relayPort = [int]$captureSummary.relay.bound.port
  Write-RunLog "Gate 2 passed through relay 127.0.0.1:$relayPort -> $($captureSummary.relay.upstream.host):$($captureSummary.relay.upstream.port)."
  $outcome = 'passed'
  $failedGate = $null
} catch {
  $caughtError = $_
  if ($failedGate -eq 2 -and $_.Exception.Message -match 'does not support host IP addresses in NAT settings') {
    $outcome = 'blocked'
  }
  Write-RunLog "Experiment failed: $($_.Exception.Message)"
  if (-not (Test-Path (Join-Path $runDirectory 'failure-receipt.json'))) {
    Write-HostFailureReceipt -Gate $failedGate -Message $_.Exception.Message -FailureOutcome $outcome -Classification $hostFailureClassification
  }
} finally {
  Sync-ContainerDebugLog
  if ($containerCreated) {
    try {
      $inspection = Get-ContainerInspection $containerId -AllowMissing
      if ($inspection) {
        Assert-RunOwnedContainer -Labels $inspection.Config.Labels -RunId $runId
        $dockerPortResult = Invoke-Docker @('port', $containerId) -AllowFailure
        $dockerPortLines = @($dockerPortResult.Output | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
        $publishedBindings = if ($inspection.NetworkSettings.Ports) {
          @(
            $inspection.NetworkSettings.Ports.PSObject.Properties |
              Where-Object { $_.Value -and @($_.Value).Count -gt 0 }
          )
        } else { @() }
        $dockerPublishedPortsAbsent = $dockerPortResult.ExitCode -eq 0 -and @($dockerPortLines).Count -eq 0 -and @($publishedBindings).Count -eq 0
        [System.IO.File]::WriteAllText(
          (Join-Path $runDirectory 'container-inspect.json'),
          "$(Invoke-Docker @('container', 'inspect', $containerId) | Select-Object -ExpandProperty Output | Out-String)",
          [System.Text.UTF8Encoding]::new($false)
        )
        $containerLogs = Invoke-Docker @('logs', '--timestamps', $containerId) -AllowFailure
        [System.IO.File]::WriteAllLines(
          (Join-Path $runDirectory 'container.log'),
          $containerLogs.Output,
          [System.Text.UTF8Encoding]::new($false)
        )
        if ($inspection.State.Running) {
          Invoke-Docker @(
            'exec', $containerId,
            'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', 'C:\experiment\container-bootstrap.ps1', '-Action', 'Stop'
          ) -AllowFailure | Out-Null
          $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
          do {
            Start-Sleep -Milliseconds 250
            $inspection = Get-ContainerInspection $containerId -AllowMissing
          } while ($inspection -and $inspection.State.Running -and [DateTime]::UtcNow -lt $stopDeadline)
          if ($inspection -and $inspection.State.Running) {
            Invoke-Docker @('stop', '--time', '5', $containerId) -AllowFailure | Out-Null
          }
          Sync-ContainerDebugLog
        }
        $inspection = Get-ContainerInspection $containerId -AllowMissing
        if ($inspection) {
          Assert-RunOwnedContainer -Labels $inspection.Config.Labels -RunId $runId
          Invoke-Docker @('rm', '--force', $containerId) | Out-Null
        }
      }
    } catch {
      if (-not $caughtError) { $caughtError = $_ }
      $outcome = 'inconclusive'
      Write-RunLog "Owned-container cleanup error: $($_.Exception.Message)"
    }
  }

  $containerAbsent = $true
  if ($containerCreated) {
    $containerAbsent = -not [bool](Get-ContainerInspection $containerId -AllowMissing)
  }
  $relayEvidencePath = Join-Path $runDirectory 'network-relay.json'
  $relayEvidence = if (Test-Path -LiteralPath $relayEvidencePath) { Get-Content -LiteralPath $relayEvidencePath -Raw | ConvertFrom-Json } else { $null }
  if (
    $relayEvidence -and
    $relayEvidence.PSObject.Properties['bound'] -and
    $relayEvidence.bound -and
    $relayEvidence.bound.PSObject.Properties['port'] -and
    $relayEvidence.bound.port
  ) {
    $relayPort = [int]$relayEvidence.bound.port
  }
  $relayListenerClosed = $true
  if ($relayPort) {
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (Test-TcpEndpoint $relayPort) {
      if ([DateTime]::UtcNow -ge $closeDeadline) { $relayListenerClosed = $false; break }
      Start-Sleep -Milliseconds 250
    }
  }
  $relayCleanupProven = -not $captureStarted -or ($relayEvidence -and $relayEvidence.cleanup.closed -and $relayListenerClosed)
  $bootstrapStoppedPath = Join-Path $runDirectory 'bootstrap-stopped.json'
  $bootstrapStopped = if (Test-Path -LiteralPath $bootstrapStoppedPath) {
    Get-Content -LiteralPath $bootstrapStoppedPath -Raw | ConvertFrom-Json
  } else { $null }
  $probeTemporaryStateRemoved = -not $containerCreated -or (
    $bootstrapStopped -and $bootstrapStopped.probeProcessStopped -and $bootstrapStopped.probeExecutableRemoved
  )
  $containerInstallerRemoved = -not $containerCreated -or (
    $bootstrapStopped -and $bootstrapStopped.downloadedInstallerRemoved
  )
  if (Test-Path -LiteralPath $secretDirectory) {
    Remove-Item -LiteralPath $secretDirectory -Recurse -Force
  }
  $secretDirectoryRemoved = -not (Test-Path -LiteralPath $secretDirectory)
  Write-AtomicJson (Join-Path $runDirectory 'cleanup-verification.json') ([ordered]@{
    wallTime = [DateTime]::UtcNow.ToString('o')
    containerId = if ($containerCreated) { $containerId } else { $null }
    containerAbsent = $containerAbsent
    dockerPublishedPortsAbsent = $dockerPublishedPortsAbsent
    relayInCaptureProcess = $true
    relayPort = $relayPort
    relayListenerClosed = $relayListenerClosed
    relayCleanupProven = [bool]$relayCleanupProven
    vncPortClosed = $relayListenerClosed
    secretDirectoryRemoved = $secretDirectoryRemoved
    probeTemporaryStateRemoved = [bool]$probeTemporaryStateRemoved
    containerInstallerRemoved = [bool]$containerInstallerRemoved
  })
  if (
    -not $containerAbsent -or -not $relayListenerClosed -or -not $relayCleanupProven -or
    -not $secretDirectoryRemoved -or -not $probeTemporaryStateRemoved -or -not $containerInstallerRemoved
  ) {
    $outcome = 'inconclusive'
    if (-not $caughtError) { $caughtError = [System.Exception]::new('Cleanup verification failed.') }
  }
  Write-RunLog "Gate 6 cleanup: containerAbsent=$containerAbsent, relayListenerClosed=$relayListenerClosed, secretRemoved=$secretDirectoryRemoved."
}

Write-RunLog "Final outcome: $outcome. Evidence: $runDirectory"
if ($outcome -ne 'passed' -and -not (Test-Path (Join-Path $runDirectory 'failure-receipt.json'))) {
  $failureMessage = if ($caughtError -is [System.Management.Automation.ErrorRecord]) { $caughtError.Exception.Message } else { $caughtError.Message }
  Write-HostFailureReceipt -Gate 6 -Message $failureMessage -FailureOutcome 'inconclusive' -PreserveCaptureSummary
}
$verifyScript = Join-Path $PSScriptRoot 'verify-evidence.mjs'
& node $verifyScript --finalize-and-verify $runDirectory
$verifyExitCode = $LASTEXITCODE
if ($verifyExitCode -ne 0 -and -not $caughtError) {
  $caughtError = [System.Exception]::new("Evidence verification failed with exit code $verifyExitCode.")
}

Write-Host "Evidence directory: $runDirectory"
if ($caughtError -or $outcome -ne 'passed') { exit 1 }
exit 0
