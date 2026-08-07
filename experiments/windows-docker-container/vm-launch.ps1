[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [ValidateRange(15, 300)][int]$WindowTimeoutSeconds = 90,
  [switch]$DirectLaunch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -Path C:\lba-provision\display-surface.cs -ReferencedAssemblies @('System', 'System.Core', 'System.Drawing')
$context = [LbaDesktop]::Configure('WinSta0')
$result = [ordered]@{
  status = 'failed'
  wallTime = [DateTime]::UtcNow.ToString('o')
  launcher = [ordered]@{
    processId = $PID
    sessionId = (Get-Process -Id $PID).SessionId
    desktopContext = $context
  }
  labviewPath = 'C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe'
}

try {
  Get-Process LabVIEW -ErrorAction SilentlyContinue | Stop-Process -Force
  if ($DirectLaunch) {
    $null = Start-Process -FilePath $result.labviewPath -WorkingDirectory (Split-Path -Parent $result.labviewPath)
  } else {
    Start-ScheduledTask -TaskName 'LBA-LaunchLabVIEW'
  }
  $deadline = [DateTime]::UtcNow.AddSeconds($WindowTimeoutSeconds)
  $window = $null
  do {
    Start-Sleep -Milliseconds 250
    $labview = Get-Process LabVIEW -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($labview) {
      $window = [LbaDesktop]::WindowsOnSelectedDesktop() | Where-Object {
        $_.processId -eq $labview.Id -and $_.visible -and -not $_.minimized -and
        $_.title -match 'LabVIEW' -and
        ($_.bounds.right - $_.bounds.left) -gt 100 -and ($_.bounds.bottom - $_.bounds.top) -gt 100
      } | Select-Object -First 1
    }
  } while (-not $window -and [DateTime]::UtcNow -lt $deadline)
  if (-not $labview) { throw 'LabVIEW.exe did not remain running.' }
  if (-not $window) { throw 'No process-matched visible LabVIEW window appeared on WinSta0\Default.' }
  $stableWindow = $window
  $stablePolls = 0
  do {
    Start-Sleep -Milliseconds 250
    $current = [LbaDesktop]::WindowsOnSelectedDesktop() | Where-Object {
      $_.handle -eq $stableWindow.handle -and $_.processId -eq $labview.Id -and
      $_.visible -and -not $_.minimized -and $_.className -eq $stableWindow.className
    } | Select-Object -First 1
    if ($current) { $stablePolls += 1 } else { $stablePolls = 0 }
  } while ($stablePolls -lt 8 -and [DateTime]::UtcNow -lt $deadline)
  if ($stablePolls -lt 8) { throw 'The process-matched LabVIEW window did not remain stable across eight polls.' }
  $window = $current
  $activationRequired = $window.className -match 'NI License Manager Wizard'
  $result.status = if ($activationRequired) { 'activation-required' } else { 'ready' }
  $result.readyWallTime = [DateTime]::UtcNow.ToString('o')
  $result.labviewPid = $labview.Id
  $result.labviewSessionId = $labview.SessionId
  $result.expectedWindow = $window
  $result.windows = @([LbaDesktop]::WindowsOnSelectedDesktop())
  if ($activationRequired) {
    $result.error = 'NI License Manager requires an interactive maintainer activation before benchmarking.'
  }
} catch {
  $result.error = $_.Exception.Message
  $result.labviewPid = if ($labview) { $labview.Id } else { $null }
  $result.labviewSessionId = if ($labview) { $labview.SessionId } else { $null }
  $result.windows = @([LbaDesktop]::WindowsOnSelectedDesktop())
} finally {
  $temporary = "$OutputPath.$PID.tmp"
  [IO.File]::WriteAllText($temporary, "$(ConvertTo-Json $result -Depth 20)`n", [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
}
if ($result.status -eq 'activation-required') { exit 5 }
if ($result.status -ne 'ready') { exit 4 }
