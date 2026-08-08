[CmdletBinding()]
param(
  [ValidateSet('Serve', 'DisplayProbe', 'LaunchLabVIEW', 'ResourceSample', 'StopProbe', 'Stop')][string]$Action = 'Serve',
  [string]$PasswordFile,
  [string]$InstallerPath,
  [string]$ExpectedInstallerSha256,
  [string]$TightVncVersion = '2.8.81',
  [string]$OutputPath = 'C:\evidence\launch-diagnostics.json',
  [ValidateSet('Inherited', 'WinSta0')][string]$DesktopTarget = 'Inherited',
  [ValidateSet('StandardGdi', 'D3d')][string]$TightVncCaptureMode = 'StandardGdi',
  [switch]$TransportOnly,
  [string]$LbaBusPath,
  [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$RunId = 'standalone',
  [ValidateRange(15, 300)][int]$WindowTimeoutSeconds = 45,
  [ValidateRange(5, 30)][int]$AliveHoldSeconds = 10
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TightVncUrl = 'https://www.tightvnc.com/download/2.8.81/tightvnc-2.8.81-gpl-setup-64bit.msi'
$TightVncExe = 'C:\Program Files\TightVNC\tvnserver.exe'
$LabViewExe = 'C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe'
$RegistryPath = 'HKCU:\Software\TightVNC\Server'
$ServiceOnlyRegistryPath = 'HKLM:\SOFTWARE\TightVNC\Server\ServiceOnly'
$StopSignal = 'C:\evidence\stop.signal'
if ($TransportOnly -and $DesktopTarget -ne 'WinSta0') {
  throw 'TransportOnly is restricted to the explicit WinSta0 baseline.'
}

function Write-BootstrapLog([string]$Message) {
  $line = '{0} [container-bootstrap] {1}' -f [DateTime]::UtcNow.ToString('o'), $Message
  Write-Host $line
  if (Test-Path -LiteralPath 'C:\evidence') {
    try {
      [System.IO.File]::AppendAllText(
        'C:\evidence\container-debug.log',
        "$line`r`n",
        [System.Text.UTF8Encoding]::new($false)
      )
    } catch [System.IO.IOException] {
      Write-Warning "Could not append the container debug log: $($_.Exception.Message)"
    }
  }
}

function Write-AtomicJson([string]$Path, $Value) {
  $temp = "$Path.$PID.tmp"
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($temp, "$json`n", [System.Text.UTF8Encoding]::new($false))
  try {
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } catch [System.IO.DirectoryNotFoundException] {
    # Windows Docker bind mounts can reject an otherwise same-directory rename.
    # Preserve the temp-write discipline and use an overwrite copy for that
    # mount-specific case rather than failing before evidence readiness.
    [System.IO.File]::Copy($temp, $Path, $true)
    Remove-Item -LiteralPath $temp -Force
  }
}

function Invoke-NativeCapture([string]$FilePath, [string[]]$Arguments) {
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Invoke-LbaBusProbe {
  if (-not $LbaBusPath) {
    Write-BootstrapLog 'lbabus container probe is not configured.'
    return $null
  }
  if (-not (Test-Path -LiteralPath $LbaBusPath)) {
    throw "Mounted lbabus payload is missing at '$LbaBusPath'."
  }
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  if (-not $dotnet) {
    throw 'The pinned image does not contain the .NET runtime required by lbabus.'
  }

  Write-BootstrapLog "Running the mounted lbabus payload with '$($dotnet.Source)'."
  $versionResult = Invoke-NativeCapture $dotnet.Source @($LbaBusPath, 'version')
  foreach ($line in $versionResult.Output) { Write-BootstrapLog "[lbabus version] $line" }
  if ($versionResult.ExitCode -ne 0) {
    throw "lbabus version failed inside the container with exit code $($versionResult.ExitCode)."
  }
  $version = @($versionResult.Output | Where-Object { $_.Trim() } | Select-Object -Last 1)[0].Trim()
  if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "lbabus returned an invalid version '$version' inside the container."
  }

  $capabilitiesResult = Invoke-NativeCapture $dotnet.Source @($LbaBusPath, 'capabilities')
  foreach ($line in $capabilitiesResult.Output) { Write-BootstrapLog "[lbabus capabilities] $line" }
  if ($capabilitiesResult.ExitCode -ne 0) {
    throw "lbabus capabilities failed inside the container with exit code $($capabilitiesResult.ExitCode)."
  }
  $runtimeResult = Invoke-NativeCapture $dotnet.Source @('--list-runtimes')
  if ($runtimeResult.ExitCode -ne 0) {
    throw "dotnet --list-runtimes failed inside the container with exit code $($runtimeResult.ExitCode)."
  }

  $record = [ordered]@{
    schema = 'labview-benchmark-actor/windows-container-lbabus@1'
    wallTime = [DateTime]::UtcNow.ToString('o')
    status = 'passed'
    version = $version
    payloadPath = $LbaBusPath
    payloadSha256 = (Get-FileHash -LiteralPath $LbaBusPath -Algorithm SHA256).Hash.ToLowerInvariant()
    dotnetPath = $dotnet.Source
    dotnetRuntimes = @($runtimeResult.Output)
    capabilitiesExitCode = $capabilitiesResult.ExitCode
    capabilities = @($capabilitiesResult.Output)
  }
  Write-AtomicJson 'C:\evidence\lbabus-container.json' $record
  Write-BootstrapLog "lbabus container capability evidence passed (version $version, payload SHA-256 $($record.payloadSha256))."
  return $record
}

if ($Action -in @('Serve', 'DisplayProbe', 'LaunchLabVIEW')) {
  Add-Type -Path (Join-Path $PSScriptRoot 'display-surface.cs') -ReferencedAssemblies @('System', 'System.Core', 'System.Drawing')
}

function Get-DesktopWindows {
  return @([LbaDesktop]::WindowsOnSelectedDesktop())
}

function Protect-TightVncPassword([string]$PlainText) {
  if ($PlainText.Length -lt 1 -or $PlainText.Length -gt 8) {
    throw 'The ephemeral TightVNC password must contain 1 to 8 characters.'
  }
  $plain = [byte[]]::new(8)
  $ascii = [System.Text.Encoding]::ASCII.GetBytes($PlainText)
  [Array]::Copy($ascii, $plain, [Math]::Min(8, $ascii.Length))
  # TightVNC 2.8.81 GPL source: VncPassCrypt key {23,82,107,6,35,78,88,7};
  # DesCrypt reverses each key byte for VNC compatibility.
  $key = [byte[]](232, 74, 214, 96, 196, 114, 26, 224)
  $des = [System.Security.Cryptography.DES]::Create()
  try {
    $des.Mode = [System.Security.Cryptography.CipherMode]::ECB
    $des.Padding = [System.Security.Cryptography.PaddingMode]::None
    $des.Key = $key
    $encryptor = $des.CreateEncryptor()
    try {
      return $encryptor.TransformFinalBlock($plain, 0, $plain.Length)
    } finally {
      $encryptor.Dispose()
    }
  } finally {
    [Array]::Clear($plain, 0, $plain.Length)
    [Array]::Clear($ascii, 0, $ascii.Length)
    $des.Dispose()
  }
}

function Test-Port5900 {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync('127.0.0.1', 5900)
    return $connect.Wait(1000) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Start-DesktopProbe {
  $probeExe = Join-Path $env:TEMP 'lba-vnc-desktop-probe.exe'
  Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;

public sealed class ProbePanel : Panel {
  readonly string marker;
  public ProbePanel(string markerValue) {
    marker = markerValue;
    Dock = DockStyle.Fill;
    DoubleBuffered = true;
  }
  protected override void OnPaint(PaintEventArgs e) {
    base.OnPaint(e);
    var g = e.Graphics;
    g.Clear(Color.FromArgb(0, 0, 128));
    g.FillRectangle(Brushes.White, 40, 35, 700, 90);
    g.FillRectangle(Brushes.Orange, 60, 175, 260, 150);
    g.FillRectangle(Brushes.Lime, 450, 175, 260, 150);
    g.FillRectangle(Brushes.Black, 40, 390, 700, 110);
    using (var titleFont = new Font(FontFamily.GenericSansSerif, 24, FontStyle.Bold))
    using (var markerFont = new Font(FontFamily.GenericMonospace, 16, FontStyle.Bold)) {
      g.DrawString("LBA VNC DESKTOP PROBE", titleFont, Brushes.Navy, new PointF(115, 58));
      g.DrawString(marker, markerFont, Brushes.White, new PointF(90, 425));
    }
  }
}

public static class LbaDesktopProbe {
  [STAThread]
  public static void Main(string[] args) {
    string marker = args.Length > 0 ? args[0] : "standalone";
    var form = new Form {
      Text = "LBA-VNC-DESKTOP-PROBE",
      BackColor = Color.Navy,
      ForeColor = Color.White,
      Width = 800,
      Height = 600,
      StartPosition = FormStartPosition.Manual,
      Location = new Point(80, 60)
    };
    form.AutoScaleMode = AutoScaleMode.None;
    form.Controls.Add(new ProbePanel(marker));
    Application.Run(form);
  }
}
'@ -OutputAssembly $probeExe -OutputType WindowsApplication -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing')
  $probeProcessId = [LbaDesktop]::StartOnSelectedDesktop($probeExe, $RunId, $env:TEMP)
  $probeProcess = Get-Process -Id $probeProcessId
  $expectedSessionId = (Get-Process -Id $PID).SessionId
  if ($probeProcess.SessionId -ne $expectedSessionId) {
    Stop-Process -Id $probeProcessId -Force -ErrorAction SilentlyContinue
    throw "Desktop probe session $($probeProcess.SessionId) does not match bootstrap session $expectedSessionId."
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $probeWindow = $null
  do {
    Start-Sleep -Milliseconds 250
    $probeProcess.Refresh()
    if ($probeProcess.HasExited) { break }
    $probeWindow = Get-DesktopWindows | Where-Object {
      $_.processId -eq $probeProcessId -and $_.visible -and $_.title -eq 'LBA-VNC-DESKTOP-PROBE' -and
      ($_.bounds.right - $_.bounds.left) -gt 100 -and ($_.bounds.bottom - $_.bounds.top) -gt 100
    } | Select-Object -First 1
  } while (-not $probeWindow -and [DateTime]::UtcNow -lt $deadline)
  $probeProcess.Refresh()
  return [ordered]@{
    process = $probeProcess
    executable = $probeExe
    window = $probeWindow
    visible = $null -ne $probeWindow
    exited = $probeProcess.HasExited
    exitCode = if ($probeProcess.HasExited) { $probeProcess.ExitCode } else { $null }
  }
}

function Get-DisplayRecord {
    $process = Get-Process -Id $PID
    $api = [LbaDesktop]::DiagnoseDisplay($PID, $process.SessionId)
    return [ordered]@{
      schema = 'labview-benchmark-actor/windows-container-display@1'
      wallTime = [DateTime]::UtcNow.ToString('o')
      desktopTarget = $DesktopTarget
      tightVncCaptureMode = $TightVncCaptureMode
      processId = $PID
      sessionId = $process.SessionId
      api = $api
      videoControllers = @(
        Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
          Select-Object Name, PNPDeviceID, DriverVersion, VideoModeDescription, CurrentHorizontalResolution,
            CurrentVerticalResolution, CurrentBitsPerPixel, AdapterCompatibility, Status
      )
      desktopMonitors = @(
        Get-CimInstance Win32_DesktopMonitor -ErrorAction SilentlyContinue |
          Select-Object Name, PNPDeviceID, ScreenWidth, ScreenHeight, Status
      )
      desktopProbe = $null
      localGdi = $null
    }
  }

function Write-BootstrapFailure(
    [string]$Classification,
    [string]$ErrorMessage,
    $VncProcess,
    $DisplayRecord
  ) {
    $logFiles = @(Copy-TightVncLogs)
    try { $windows = @(Get-DesktopWindows) } catch { $windows = @() }
    Write-AtomicJson 'C:\evidence\bootstrap-failure.json' ([ordered]@{
      status = 'failed'
      failedGate = if ($Classification -match '^desktop-|^rfb-') { 3 } else { 2 }
      classification = $Classification
      wallTime = [DateTime]::UtcNow.ToString('o')
      error = $ErrorMessage
      desktopTarget = $DesktopTarget
      tightVncCaptureMode = $TightVncCaptureMode
      display = $DisplayRecord
      vncProcess = if ($VncProcess) {
        $VncProcess.Refresh()
        [ordered]@{
          processId = $VncProcess.Id
          sessionId = $VncProcess.SessionId
          hasExited = $VncProcess.HasExited
          mainWindowTitle = $VncProcess.MainWindowTitle
        }
      } else { $null }
      windows = $windows
      logFiles = @($logFiles | ForEach-Object { $_.Name })
    })
  }

function Copy-TightVncLogs {
  $logFiles = @(
    Get-ChildItem -Path (Join-Path $env:APPDATA 'TightVNC') -Filter '*.log' -File -ErrorAction SilentlyContinue
  )
  foreach ($logFile in $logFiles) {
    Copy-Item -LiteralPath $logFile.FullName -Destination (Join-Path 'C:\evidence' $logFile.Name) -Force
  }
  return $logFiles
}

function Invoke-Serve {
  if (-not $PasswordFile -or -not (Test-Path -LiteralPath $PasswordFile)) {
    throw 'Serve requires a mounted ephemeral PasswordFile.'
  }
  if (-not $ExpectedInstallerSha256 -or $ExpectedInstallerSha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw 'Serve requires the pinned TightVNC installer SHA-256.'
  }
  Remove-Item -LiteralPath $StopSignal -Force -ErrorAction SilentlyContinue
  $downloadedInstaller = $null
  $vncProcess = $null
  $desktopProbe = $null
  $displayRecord = $null
  $desktopContext = $null
  $lbabusRecord = $null
  $failureClassification = 'container-listener-unavailable'
  try {
    Write-BootstrapLog "Serve action started: runId=$RunId, desktopTarget=$DesktopTarget, captureMode=$TightVncCaptureMode, transportOnly=$([bool]$TransportOnly)."
    $lbabusRecord = Invoke-LbaBusProbe
    $desktopContext = [LbaDesktop]::Configure($DesktopTarget)
    $startupDesktop = if ($desktopContext.explicitStartupDesktop) { $desktopContext.explicitStartupDesktop } else { '<inherited>' }
    Write-BootstrapLog "Selected $DesktopTarget desktop '$($desktopContext.qualifiedDesktop)' (explicit startup desktop=$startupDesktop)."
    $displayRecord = Get-DisplayRecord
    Write-AtomicJson 'C:\evidence\display-diagnostics.json' $displayRecord
    Write-BootstrapLog "Display diagnostics: getDcSucceeded=$($displayRecord.api.getDcSucceeded), monitors=$(@($displayRecord.api.monitorRectangles).Count), virtual=$($displayRecord.api.virtualWidth)x$($displayRecord.api.virtualHeight), primary=$($displayRecord.api.primaryWidth)x$($displayRecord.api.primaryHeight)."
    if (-not $displayRecord.api.getDcSucceeded) {
      $failureClassification = 'desktop-screen-dc-unavailable'
      throw "GetDC(NULL) failed with Win32 error $($displayRecord.api.getDcError) on '$($desktopContext.qualifiedDesktop)'."
    }
    $desktopProbe = Start-DesktopProbe
    $displayRecord.desktopProbe = [ordered]@{
      processId = $desktopProbe.process.Id
      sessionId = $desktopProbe.process.SessionId
      marker = $RunId
      visible = $desktopProbe.visible
      exited = $desktopProbe.exited
      exitCode = $desktopProbe.exitCode
      window = $desktopProbe.window
    }
    Write-BootstrapLog "Desktop probe: pid=$($desktopProbe.process.Id), session=$($desktopProbe.process.SessionId), visible=$($desktopProbe.visible), exited=$($desktopProbe.exited)."
    $zeroDisplays = @($displayRecord.api.monitorRectangles).Count -eq 0
    $localGdiPath = 'C:\evidence\local-gdi-capture.png'
    $localGdiCaptured = $false
    try {
      $localGdiAnalysis = [LbaDesktop]::CaptureScreen($localGdiPath)
      $localGdiCaptured = $true
    } catch {
      $failureClassification = if ($zeroDisplays) { 'desktop-has-zero-displays' } else { 'desktop-local-gdi-capture-black' }
      $displayRecord.localGdi = [ordered]@{
        path = $null
        sha256 = $null
        analysis = [ordered]@{ passed = $false; reason = 'capture-error' }
        captureMethod = 'GetDC(NULL)+BitBlt(SRCCOPY|CAPTUREBLT)+GetDIBits'
        error = $_.Exception.Message
      }
      $localGdiAnalysis = $displayRecord.localGdi.analysis
      Write-AtomicJson 'C:\evidence\display-diagnostics.json' $displayRecord
      Write-BootstrapLog "Local GDI capture failed: zeroDisplays=$zeroDisplays, error=$($_.Exception.Message)"
      if (-not ($TransportOnly -and $zeroDisplays)) { throw }
      Write-BootstrapLog 'Transport-only mode retained the zero-display/local-GDI failure and will continue only to authenticated RFB image acquisition.'
    }
    if ($localGdiCaptured) {
      $displayRecord.localGdi = [ordered]@{
        path = 'local-gdi-capture.png'
        sha256 = (Get-FileHash -LiteralPath $localGdiPath -Algorithm SHA256).Hash.ToLowerInvariant()
        analysis = $localGdiAnalysis
        captureMethod = 'GetDC(NULL)+BitBlt(SRCCOPY|CAPTUREBLT)+GetDIBits'
      }
      Write-BootstrapLog "Local GDI capture completed: passed=$($localGdiAnalysis.passed), reason=$($localGdiAnalysis.reason), SHA-256=$($displayRecord.localGdi.sha256)."
    }
    Write-AtomicJson 'C:\evidence\display-diagnostics.json' $displayRecord
    if ($zeroDisplays -and -not $TransportOnly) {
      $failureClassification = 'desktop-has-zero-displays'
      throw "EnumDisplayMonitors found zero displays on '$($desktopContext.qualifiedDesktop)'."
    }
    if (
      $displayRecord.api.virtualWidth -le 0 -or $displayRecord.api.virtualHeight -le 0 -or
      $displayRecord.api.primaryWidth -le 0 -or $displayRecord.api.primaryHeight -le 0
    ) {
      $failureClassification = 'desktop-has-zero-displays'
      throw "Display metrics are degenerate on '$($desktopContext.qualifiedDesktop)'."
    }
    if ((-not $desktopProbe.visible -or $desktopProbe.exited) -and -not $TransportOnly) {
      $failureClassification = 'desktop-probe-window-unavailable'
      throw "The deterministic probe did not produce a visible window on '$($desktopContext.qualifiedDesktop)'."
    }
    if (-not $localGdiAnalysis.passed -and -not $TransportOnly) {
      $failureClassification = 'desktop-local-gdi-capture-black'
      throw "Local GDI capture failed pixel proof: $($localGdiAnalysis.reason)."
    }

    if (-not (Test-Path -LiteralPath $TightVncExe)) {
      $installer = $InstallerPath
      if (-not $installer) {
        $downloadedInstaller = Join-Path $env:TEMP 'tightvnc-2.8.81-gpl-setup-64bit.msi'
        Write-BootstrapLog "Downloading TightVNC $TightVncVersion from the pinned official HTTPS URL."
        Invoke-WebRequest -UseBasicParsing -Uri $TightVncUrl -OutFile $downloadedInstaller
        $installer = $downloadedInstaller
      }
      if (-not (Test-Path -LiteralPath $installer)) { throw "TightVNC installer not found at '$installer'." }
      $actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualHash -ne $ExpectedInstallerSha256.ToLowerInvariant()) {
        throw "TightVNC installer SHA-256 mismatch: expected '$ExpectedInstallerSha256', got '$actualHash'."
      }
      Write-BootstrapLog "TightVNC installer identity passed: version=$TightVncVersion, SHA-256=$actualHash."
      Write-BootstrapLog 'Installing only the TightVNC Server feature (no service and no firewall exception).'
      $install = Start-Process -FilePath 'msiexec.exe' -ArgumentList @(
        '/i', "`"$installer`"", '/quiet', '/norestart',
        'ADDLOCAL=Server', 'SERVER_REGISTER_AS_SERVICE=0', 'SERVER_ADD_FIREWALL_EXCEPTION=0'
      ) -Wait -PassThru
      if ($install.ExitCode -ne 0) { throw "TightVNC MSI exited with code $($install.ExitCode)." }
    }
    if (-not (Test-Path -LiteralPath $TightVncExe)) { throw 'tvnserver.exe was not installed.' }
    $installedVersion = ([System.Diagnostics.FileVersionInfo]::GetVersionInfo($TightVncExe).ProductVersion -replace '[,\s]+', '.').Trim('.')
    if ($installedVersion -notmatch "^$([regex]::Escape($TightVncVersion))(\.|$)") {
      throw "Unexpected TightVNC product version '$installedVersion' (expected $TightVncVersion)."
    }
    Write-BootstrapLog "TightVNC executable identity passed: path='$TightVncExe', productVersion=$installedVersion."
    if (Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue) {
      throw 'TightVNC unexpectedly registered a Windows service; application mode is required for this gate.'
    }
    $serviceOnlyMarkerRemoved = Test-Path -LiteralPath $ServiceOnlyRegistryPath
    if ($serviceOnlyMarkerRemoved) {
      Remove-Item -LiteralPath $ServiceOnlyRegistryPath -Recurse -Force
    }
    if (Test-Path -LiteralPath $ServiceOnlyRegistryPath) {
      throw 'TightVNC ServiceOnly registry marker could not be removed inside the disposable container.'
    }

    $passwordText = [System.IO.File]::ReadAllText($PasswordFile).Trim()
    $protectedPassword = Protect-TightVncPassword $passwordText
    $passwordText = $null
    New-Item -Path $RegistryPath -Force | Out-Null
    New-ItemProperty -Path $RegistryPath -Name 'Password' -Value $protectedPassword -PropertyType Binary -Force | Out-Null
    [Array]::Clear($protectedPassword, 0, $protectedPassword.Length)
    $settings = [ordered]@{
      AcceptRfbConnections = 1
      RfbPort = 5900
      UseVncAuthentication = 1
      UseControlAuthentication = 0
      LoopbackOnly = 0
      AllowLoopback = 1
      AcceptHttpConnections = 0
      EnableFileTransfers = 0
      UseD3D = if ($TightVncCaptureMode -eq 'D3d') { 1 } else { 0 }
      UseMirrorDriver = 0
      RemoveWallpaper = 0
      LogLevel = 9
    }
    foreach ($entry in $settings.GetEnumerator()) {
      New-ItemProperty -Path $RegistryPath -Name $entry.Key -Value $entry.Value -PropertyType DWord -Force | Out-Null
    }
    Remove-ItemProperty -Path $RegistryPath -Name 'PasswordViewOnly' -ErrorAction SilentlyContinue
    Write-BootstrapLog "TightVNC application settings written: RfbPort=5900, VNCAuth=1, HTTP=0, fileTransfers=0, UseD3D=$($settings.UseD3D), mirrorDriver=0, LogLevel=9."

    $vncProcessId = [LbaDesktop]::StartOnSelectedDesktop($TightVncExe, '-run', (Split-Path -Parent $TightVncExe))
    $vncProcess = Get-Process -Id $vncProcessId
    Write-BootstrapLog "TightVNC process created: pid=$vncProcessId, session=$($vncProcess.SessionId), desktop='$($desktopContext.qualifiedDesktop)'; waiting for port 5900."
    $bootstrapSessionId = (Get-Process -Id $PID).SessionId
    if ($vncProcess.SessionId -ne $bootstrapSessionId) {
      throw "TightVNC session $($vncProcess.SessionId) does not match bootstrap session $bootstrapSessionId."
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      Start-Sleep -Milliseconds 250
      $vncProcess.Refresh()
      if ($vncProcess.HasExited) { throw "TightVNC application mode exited with code $($vncProcess.ExitCode)." }
    } while (-not (Test-Port5900) -and [DateTime]::UtcNow -lt $deadline)
    if (-not (Test-Port5900)) {
      throw 'TightVNC did not listen on container port 5900.'
    }

    $containerOs = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
    Write-AtomicJson 'C:\evidence\bootstrap-ready.json' ([ordered]@{
      status = 'ready'
      wallTime = [DateTime]::UtcNow.ToString('o')
      containerOs = $containerOs
      bootstrap = [ordered]@{
        processId = $PID
        sessionId = (Get-Process -Id $PID).SessionId
        desktopContext = $desktopContext
      }
      display = $displayRecord
      lbabus = $lbabusRecord
      transportOnly = [bool]$TransportOnly
      vnc = [ordered]@{
        processId = $vncProcess.Id
        sessionId = $vncProcess.SessionId
        processAlive = -not $vncProcess.HasExited
        port5900Listening = (Test-Port5900)
        mode = 'application'
        version = $installedVersion
        authentication = 'VNC authentication with ephemeral eight-character secret'
        registryHive = 'HKCU'
        serviceOnlyMarkerRemoved = $serviceOnlyMarkerRemoved
        captureMode = $TightVncCaptureMode
        useD3D = $settings.UseD3D
        useMirrorDriver = $settings.UseMirrorDriver
      }
      desktopProbe = $displayRecord.desktopProbe
      windows = Get-DesktopWindows
    })
    Write-BootstrapLog "TightVNC application mode is ready (PID $($vncProcess.Id), session $($vncProcess.SessionId), port 5900)."

    while (-not (Test-Path -LiteralPath $StopSignal)) {
      Start-Sleep -Seconds 1
      $vncProcess.Refresh()
      if ($vncProcess.HasExited) { throw "TightVNC application mode exited unexpectedly with code $($vncProcess.ExitCode)." }
      if (-not (Test-Port5900)) { throw 'TightVNC port 5900 stopped listening.' }
    }
    Write-BootstrapLog 'Graceful stop signal received.'
  } catch {
    Write-BootstrapLog "Serve action failed: classification=$failureClassification, error=$($_.Exception.Message)"
    if (-not (Test-Path -LiteralPath 'C:\evidence\bootstrap-failure.json')) {
      Write-BootstrapFailure $failureClassification $_.Exception.Message $vncProcess $displayRecord
    }
    throw
  } finally {
    Write-BootstrapLog 'Serve cleanup started.'
    if ($desktopProbe -and $desktopProbe.process -and -not $desktopProbe.process.HasExited) {
      Stop-Process -Id $desktopProbe.process.Id -Force -ErrorAction SilentlyContinue
    }
    if ($desktopProbe -and $desktopProbe.executable -and (Test-Path -LiteralPath $desktopProbe.executable)) {
      Remove-Item -LiteralPath $desktopProbe.executable -Force
    }
    if ($vncProcess -and -not $vncProcess.HasExited) {
      Start-Process -FilePath $TightVncExe -ArgumentList @('-controlapp', '-shutdown') -Wait -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 500
      $vncProcess.Refresh()
      if (-not $vncProcess.HasExited) { Stop-Process -Id $vncProcess.Id -Force }
    }
    $null = Copy-TightVncLogs
    if (Test-Path -LiteralPath $RegistryPath) {
      Remove-ItemProperty -Path $RegistryPath -Name 'Password' -ErrorAction SilentlyContinue
    }
    if ($downloadedInstaller -and (Test-Path -LiteralPath $downloadedInstaller)) {
      Remove-Item -LiteralPath $downloadedInstaller -Force
    }
    Write-AtomicJson 'C:\evidence\bootstrap-stopped.json' ([ordered]@{
      wallTime = [DateTime]::UtcNow.ToString('o')
      passwordRegistryValueRemoved = -not [bool](Get-ItemProperty -Path $RegistryPath -Name 'Password' -ErrorAction SilentlyContinue)
      downloadedInstallerRemoved = -not ($downloadedInstaller -and (Test-Path -LiteralPath $downloadedInstaller))
      probeProcessStopped = -not $desktopProbe -or $desktopProbe.process.HasExited
      probeExecutableRemoved = -not $desktopProbe -or -not (Test-Path -LiteralPath $desktopProbe.executable)
    })
    Write-BootstrapLog "Serve cleanup completed: probeStopped=$(-not $desktopProbe -or $desktopProbe.process.HasExited), probeExecutableRemoved=$(-not $desktopProbe -or -not (Test-Path -LiteralPath $desktopProbe.executable)), downloadedInstallerRemoved=$(-not ($downloadedInstaller -and (Test-Path -LiteralPath $downloadedInstaller)))."
  }
}

function Invoke-LaunchLabView {
  $desktopContext = [LbaDesktop]::Configure($DesktopTarget)
  $bootstrapReady = Get-Content -LiteralPath 'C:\evidence\bootstrap-ready.json' -Raw | ConvertFrom-Json
  $diagnostics = [ordered]@{
    status = 'failed'
    wallTime = [DateTime]::UtcNow.ToString('o')
    triggerClock = [ordered]@{
      source = 'container Stopwatch.GetTimestamp'
      ticks = [System.Diagnostics.Stopwatch]::GetTimestamp()
      frequency = [System.Diagnostics.Stopwatch]::Frequency
    }
    launcher = [ordered]@{
      processId = $PID
      sessionId = (Get-Process -Id $PID).SessionId
      desktopContext = $desktopContext
    }
    labviewPath = $LabViewExe
  }
  try {
    if ($desktopContext.mode -ne $bootstrapReady.bootstrap.desktopContext.mode) {
      throw "LabVIEW desktop mode '$($desktopContext.mode)' differs from bootstrap mode '$($bootstrapReady.bootstrap.desktopContext.mode)'."
    }
    if ($desktopContext.qualifiedDesktop -ne $bootstrapReady.bootstrap.desktopContext.qualifiedDesktop) {
      throw "LabVIEW desktop '$($desktopContext.qualifiedDesktop)' differs from bootstrap desktop '$($bootstrapReady.bootstrap.desktopContext.qualifiedDesktop)'."
    }
    $launcherSessionId = (Get-Process -Id $PID).SessionId
    if ($launcherSessionId -ne $bootstrapReady.bootstrap.sessionId) {
      throw "LabVIEW launcher session $launcherSessionId differs from bootstrap session $($bootstrapReady.bootstrap.sessionId)."
    }
    if (-not (Test-Path -LiteralPath $LabViewExe)) { throw "LabVIEW executable not found at '$LabViewExe'." }
    $existing = @(Get-Process -Name 'LabVIEW' -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) { throw 'LabVIEW was already running before the launch trigger.' }
    $labviewProcessId = [LbaDesktop]::StartOnSelectedDesktop($LabViewExe, '', (Split-Path -Parent $LabViewExe))
    $labview = Get-Process -Id $labviewProcessId
    if ($labview.SessionId -ne $launcherSessionId) {
      throw "LabVIEW session $($labview.SessionId) does not match launcher session $launcherSessionId."
    }
    $diagnostics.labviewPid = $labview.Id
    $diagnostics.labviewSessionId = $labview.SessionId
    Write-BootstrapLog "Launched LabVIEW PID $($labview.Id) on '$($desktopContext.qualifiedDesktop)'."

    $deadline = [DateTime]::UtcNow.AddSeconds($WindowTimeoutSeconds)
    $expectedWindow = $null
    do {
      Start-Sleep -Milliseconds 500
      $labview.Refresh()
      if ($labview.HasExited) { throw "LabVIEW exited during startup with code $($labview.ExitCode)." }
      $windows = Get-DesktopWindows
      $expectedWindow = $windows | Where-Object {
        $_.processId -eq $labview.Id -and $_.visible -and -not $_.minimized -and
        $_.title -match 'LabVIEW' -and
        ($_.bounds.right - $_.bounds.left) -gt 100 -and ($_.bounds.bottom - $_.bounds.top) -gt 100
      } | Select-Object -First 1
    } while (-not $expectedWindow -and [DateTime]::UtcNow -lt $deadline)
    if (-not $expectedWindow) {
      $diagnostics.windows = Get-DesktopWindows
      throw "No visible process-matched LabVIEW top-level window appeared on '$($desktopContext.qualifiedDesktop)' within $WindowTimeoutSeconds seconds."
    }

    $aliveDeadline = [DateTime]::UtcNow.AddSeconds($AliveHoldSeconds)
    while ([DateTime]::UtcNow -lt $aliveDeadline) {
      Start-Sleep -Milliseconds 500
      $labview.Refresh()
      if ($labview.HasExited) { throw "LabVIEW exited before the $AliveHoldSeconds-second visibility hold completed with code $($labview.ExitCode)." }
    }
    $diagnostics.status = 'ready'
    $diagnostics.readyWallTime = [DateTime]::UtcNow.ToString('o')
    $diagnostics.expectedWindow = $expectedWindow
    $diagnostics.windows = Get-DesktopWindows
    $diagnostics.aliveHoldSeconds = $AliveHoldSeconds
  } catch {
    $diagnostics.error = $_.Exception.Message
    if (-not $diagnostics.windows) { $diagnostics.windows = Get-DesktopWindows }
    throw
  } finally {
    Write-AtomicJson $OutputPath $diagnostics
  }
}

function Invoke-ResourceSample {
  $process = Get-CimInstance Win32_Process -Filter "Name='LabVIEW.exe'" | Select-Object -First 1
  $os = Get-CimInstance Win32_OperatingSystem
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
  $sample = [ordered]@{
    wallTime = [DateTime]::UtcNow.ToString('o')
    clock = 'container DateTimeOffset UTC (provenance only)'
    labview = if ($process) {
      [ordered]@{
        processId = [int]$process.ProcessId
        cpuSeconds = [Math]::Round(([double]$process.KernelModeTime + [double]$process.UserModeTime) / 10000000, 6)
        workingSetMb = [Math]::Round([double]$process.WorkingSetSize / 1MB, 3)
        privateMemoryMb = [Math]::Round([double]$process.PrivatePageCount / 1MB, 3)
        readMb = [Math]::Round([double]$process.ReadTransferCount / 1MB, 3)
        writeMb = [Math]::Round([double]$process.WriteTransferCount / 1MB, 3)
      }
    } else { $null }
    os = [ordered]@{
      availableMemoryMb = [Math]::Round([double]$os.FreePhysicalMemory / 1024, 3)
      committedMemoryMb = [Math]::Round(([double]$os.TotalVirtualMemorySize - [double]$os.FreeVirtualMemory) / 1024, 3)
    }
    disk = [ordered]@{
      deviceId = $disk.DeviceID
      sizeMb = [Math]::Round([double]$disk.Size / 1MB, 3)
      freeMb = [Math]::Round([double]$disk.FreeSpace / 1MB, 3)
    }
  }
  $sample | ConvertTo-Json -Depth 8 -Compress
}

function Invoke-StopProbe {
  $ready = Get-Content -LiteralPath 'C:\evidence\bootstrap-ready.json' -Raw | ConvertFrom-Json
  $probeId = [int]$ready.desktopProbe.processId
  $probe = Get-Process -Id $probeId -ErrorAction SilentlyContinue
  $stopped = $false
  if ($probe) {
    if ($probe.ProcessName -ne 'lba-vnc-desktop-probe') {
      throw "Refusing to stop PID $probeId because its process name is '$($probe.ProcessName)'."
    }
    Stop-Process -Id $probeId -Force
    $probe.WaitForExit(5000)
    $stopped = $probe.HasExited
  } else {
    $stopped = $true
  }
  $probeExe = Join-Path $env:TEMP 'lba-vnc-desktop-probe.exe'
  if (Test-Path -LiteralPath $probeExe) { Remove-Item -LiteralPath $probeExe -Force }
  $result = [ordered]@{
    wallTime = [DateTime]::UtcNow.ToString('o')
    processId = $probeId
    stopped = $stopped
    executableRemoved = -not (Test-Path -LiteralPath $probeExe)
  }
  Write-AtomicJson 'C:\evidence\probe-stopped.json' $result
  $result | ConvertTo-Json -Compress
}

function Invoke-DisplayProbe {
  $probe = $null
  $display = $null
  $classification = 'display-probe-failed'
  $errorMessage = $null
  try {
    $context = [LbaDesktop]::Configure($DesktopTarget)
    $display = Get-DisplayRecord
    if (-not $display.api.getDcSucceeded) {
      $classification = 'desktop-screen-dc-unavailable'
      throw "GetDC(NULL) failed with Win32 error $($display.api.getDcError)."
    }
    $probe = Start-DesktopProbe
    $display.desktopProbe = [ordered]@{
      processId = $probe.process.Id
      sessionId = $probe.process.SessionId
      marker = $RunId
      visible = $probe.visible
      exited = $probe.exited
      exitCode = $probe.exitCode
      window = $probe.window
    }
    try {
      $png = 'C:\evidence\local-gdi-capture.png'
      $analysis = [LbaDesktop]::CaptureScreen($png)
      $display.localGdi = [ordered]@{
        path = 'local-gdi-capture.png'
        sha256 = (Get-FileHash -LiteralPath $png -Algorithm SHA256).Hash.ToLowerInvariant()
        analysis = $analysis
        captureMethod = 'GetDC(NULL)+BitBlt(SRCCOPY|CAPTUREBLT)+GetDIBits'
      }
    } catch {
      $display.localGdi = [ordered]@{
        path = $null
        sha256 = $null
        analysis = [ordered]@{ passed = $false; reason = 'capture-error' }
        captureMethod = 'GetDC(NULL)+BitBlt(SRCCOPY|CAPTUREBLT)+GetDIBits'
        error = $_.Exception.Message
      }
    }
    if (@($display.api.monitorRectangles).Count -eq 0) {
      $classification = 'desktop-has-zero-displays'
    } elseif (-not $probe.visible -or $probe.exited) {
      $classification = 'desktop-probe-window-unavailable'
    } elseif ($display.localGdi.analysis.passed -ne $true) {
      $classification = 'desktop-local-gdi-capture-black'
    } else {
      $classification = 'display-surface-available'
    }
  } catch {
    $errorMessage = $_.Exception.Message
  } finally {
    if ($probe -and $probe.process -and -not $probe.process.HasExited) {
      Stop-Process -Id $probe.process.Id -Force -ErrorAction SilentlyContinue
    }
    if ($probe -and $probe.executable -and (Test-Path -LiteralPath $probe.executable)) {
      Remove-Item -LiteralPath $probe.executable -Force
    }
  }
  if ($display) { Write-AtomicJson 'C:\evidence\display-diagnostics.json' $display }
  $passed = $classification -eq 'display-surface-available'
  $receipt = [ordered]@{
    schema = 'labview-benchmark-actor/windows-container-display-probe@1'
    status = if ($passed) { 'display-surface-available' } else { 'unsupported-display-surface' }
    passed = $passed
    classification = $classification
    error = $errorMessage
    wallTime = [DateTime]::UtcNow.ToString('o')
    runId = $RunId
    desktopTarget = $DesktopTarget
    display = $display
    tightVncStarted = $false
    relayStarted = $false
    secretCreated = $false
    cleanup = [ordered]@{
      probeProcessStopped = -not $probe -or $probe.process.HasExited
      probeExecutableRemoved = -not $probe -or -not (Test-Path -LiteralPath $probe.executable)
    }
  }
  Write-AtomicJson 'C:\evidence\display-probe.json' $receipt
  return $receipt
}

switch ($Action) {
  'Serve' { Invoke-Serve }
  'DisplayProbe' {
    $probeResult = Invoke-DisplayProbe
    $probeResult | ConvertTo-Json -Depth 20 -Compress
    if (-not $probeResult.passed) { exit 3 }
  }
  'LaunchLabVIEW' { Invoke-LaunchLabView }
  'ResourceSample' { Invoke-ResourceSample }
  'StopProbe' { Invoke-StopProbe }
  'Stop' {
    [System.IO.File]::WriteAllText($StopSignal, [DateTime]::UtcNow.ToString('o'), [System.Text.UTF8Encoding]::new($false))
    Write-BootstrapLog 'Stop signal written.'
  }
}
