[CmdletBinding()]
param(
  [string]$OutputPath = 'C:\lba-provision\launch-diagnostics.json',
  [ValidateRange(15, 300)][int]$WindowTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$expectedOutputPath = 'C:\lba-provision\launch-diagnostics.json'
if ($OutputPath -ne $expectedOutputPath -or $WindowTimeoutSeconds -ne 90) {
  throw 'The Vagrant interactive launch task uses the governed default output path and timeout.'
}

Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
$agentReadyPath = 'C:\lba-provision\interactive-agent-ready.json'
if (Test-Path -LiteralPath $agentReadyPath) {
  [IO.File]::WriteAllText('C:\lba-provision\launch.go', [DateTime]::UtcNow.ToString('o'), [Text.UTF8Encoding]::new($false))
} else {
  Start-ScheduledTask -TaskName 'LBA-CaptureLaunch'
}
$deadline = [DateTime]::UtcNow.AddSeconds($WindowTimeoutSeconds + 30)
do {
  Start-Sleep -Milliseconds 250
} while (-not (Test-Path -LiteralPath $OutputPath) -and [DateTime]::UtcNow -lt $deadline)

if (-not (Test-Path -LiteralPath $OutputPath)) {
  throw "LabVIEW launch adapter did not create '$OutputPath'."
}

$diagnostics = Get-Content -LiteralPath $OutputPath -Raw | ConvertFrom-Json
if (Test-Path -LiteralPath $agentReadyPath) {
  $diagnostics | Add-Member -NotePropertyName launchTaskState -NotePropertyValue 'interactive-login-agent' -Force
  $diagnostics | Add-Member -NotePropertyName launcherExitCode -NotePropertyValue 0 -Force
} else {
  $task = Get-ScheduledTask -TaskName 'LBA-CaptureLaunch'
  $taskInfo = Get-ScheduledTaskInfo -TaskName 'LBA-CaptureLaunch'
  $diagnostics | Add-Member -NotePropertyName launchTaskState -NotePropertyValue $task.State.ToString() -Force
  $diagnostics | Add-Member -NotePropertyName launcherExitCode -NotePropertyValue $taskInfo.LastTaskResult -Force
}
$diagnostics | ConvertTo-Json -Depth 20 -Compress
