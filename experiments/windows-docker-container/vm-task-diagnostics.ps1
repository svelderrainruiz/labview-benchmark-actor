[CmdletBinding()]
param([string]$TaskName = 'LBA-TightVNC')

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName
$before = Get-ScheduledTaskInfo -TaskName $TaskName
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5
$afterTask = Get-ScheduledTask -TaskName $TaskName
$after = Get-ScheduledTaskInfo -TaskName $TaskName
$events = @(
  Get-WinEvent -FilterHashtable @{
    LogName = 'Microsoft-Windows-TaskScheduler/Operational'
    StartTime = [DateTime]::Now.AddMinutes(-10)
  } -ErrorAction SilentlyContinue |
    Where-Object Message -Match ([regex]::Escape($TaskName)) |
    Select-Object -First 20 |
    ForEach-Object {
      [pscustomobject]@{
        id = $_.Id
        level = $_.LevelDisplayName
        time = $_.TimeCreated.ToString('o')
        message = $_.Message
      }
    }
)

[pscustomobject]@{
  schema = 'labview-benchmark-actor/windows-interactive-task-diagnostics@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  computerName = $env:COMPUTERNAME
  winrmIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
  task = [pscustomobject]@{
    stateBefore = $task.State.ToString()
    stateAfter = $afterTask.State.ToString()
    principal = $task.Principal
    actions = @($task.Actions)
    lastResultBefore = $before.LastTaskResult
    lastResultAfter = $after.LastTaskResult
    lastRunTime = $after.LastRunTime.ToString('o')
  }
  tvnserverProcesses = @(
    Get-Process tvnserver -ErrorAction SilentlyContinue |
      ForEach-Object { [pscustomobject]@{ id = $_.Id; sessionId = $_.SessionId } }
  )
  listener = @(
    Get-NetTCPConnection -State Listen -LocalPort 5900 -ErrorAction SilentlyContinue |
      Select-Object LocalAddress, LocalPort, OwningProcess
  )
  events = $events
} | ConvertTo-Json -Depth 20 -Compress
