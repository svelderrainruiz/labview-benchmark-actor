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
  $titleEvidence = $null
  $windowSelection = $null
  do {
    Start-Sleep -Milliseconds 250
    $labview = Get-Process LabVIEW -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($labview) {
      $processWindows = @([LbaDesktop]::WindowsOnSelectedDesktop() | Where-Object {
        $_.processId -eq $labview.Id
      })
      foreach ($candidate in $processWindows) {
        $extended = $candidate.extendedFrameBounds
        if (
          $candidate.extendedFrameBoundsAvailable -and
          ($extended.right - $extended.left) -gt 100 -and
          ($extended.bottom - $extended.top) -gt 100
        ) {
          $candidate | Add-Member -NotePropertyName originalBounds -NotePropertyValue $candidate.bounds -Force
          $candidate.bounds = $extended
          $candidate | Add-Member -NotePropertyName boundsSource -NotePropertyValue 'DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)' -Force
        } else {
          $candidate | Add-Member -NotePropertyName boundsSource -NotePropertyValue 'GetWindowRect' -Force
        }
      }
      $titleEvidence = $processWindows |
        Where-Object { $_.title -match 'LabVIEW' } |
        Sort-Object {
          [int]$_.visible * 1000000000 +
          ($_.bounds.right - $_.bounds.left) * ($_.bounds.bottom - $_.bounds.top)
        } -Descending |
        Select-Object -First 1
      $splashVisible = $processWindows | Where-Object {
        $_.className -eq 'SPLASHSCREEN' -and $_.visible -and -not $_.minimized
      } | Select-Object -First 1
      if ($splashVisible) {
        $window = $null
        $windowSelection = $null
        continue
      }
      $usableWindows = @($processWindows | Where-Object {
        $_.className -ne 'SPLASHSCREEN' -and $_.visible -and -not $_.minimized -and
        ($_.bounds.right - $_.bounds.left) -gt 100 -and ($_.bounds.bottom - $_.bounds.top) -gt 100
      })
      $window = $usableWindows | Where-Object { $_.title -match 'LabVIEW' } | Select-Object -First 1
      if ($window) {
        $windowSelection = 'titled-process-window'
      } elseif ($titleEvidence) {
        $window = $usableWindows |
          Sort-Object { ($_.bounds.right - $_.bounds.left) * ($_.bounds.bottom - $_.bounds.top) } -Descending |
          Select-Object -First 1
        if ($window) {
          $windowSelection = 'largest-process-window-with-labview-title-sibling'
        }
      }
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
  if ($windowSelection -eq 'largest-process-window-with-labview-title-sibling') {
    $clientBounds = $window.bounds
    $window | Add-Member -NotePropertyName clientBounds -NotePropertyValue $clientBounds -Force
    $window.bounds = [LbaRect]@{
      left = $clientBounds.left - 48
      top = $clientBounds.top - 96
      right = $clientBounds.right + 48
      bottom = $clientBounds.bottom + 48
    }
    $window | Add-Member -NotePropertyName frameExpansion -NotePropertyValue ([ordered]@{
      left = 48
      top = 96
      right = 48
      bottom = 48
      reason = 'LabVIEW LVFrame reports zero bounds; expand the same-process LVDChild client to include visible frame chrome.'
    }) -Force
    $window | Add-Member -NotePropertyName boundsSource -NotePropertyValue 'same-process-client-frame-expansion' -Force
  } elseif (
    $window.extendedFrameBoundsAvailable -and
    ($window.extendedFrameBounds.right - $window.extendedFrameBounds.left) -gt 100 -and
    ($window.extendedFrameBounds.bottom - $window.extendedFrameBounds.top) -gt 100
  ) {
    $window | Add-Member -NotePropertyName originalBounds -NotePropertyValue $window.bounds -Force
    $window.bounds = $window.extendedFrameBounds
    $window | Add-Member -NotePropertyName boundsSource -NotePropertyValue 'DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)' -Force
  } else {
    $window | Add-Member -NotePropertyName boundsSource -NotePropertyValue 'GetWindowRect' -Force
  }
  $window | Add-Member -NotePropertyName titleEvidence -NotePropertyValue $titleEvidence.title -Force
  $window | Add-Member -NotePropertyName titleEvidenceHandle -NotePropertyValue $titleEvidence.handle -Force
  $window | Add-Member -NotePropertyName selection -NotePropertyValue $windowSelection -Force
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
