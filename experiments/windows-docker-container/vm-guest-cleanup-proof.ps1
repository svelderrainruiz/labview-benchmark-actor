[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputPath)

$ErrorActionPreference = 'Stop'
$receipt = [ordered]@{
  schema = 'labview-benchmark-actor/windows-vm-guest-cleanup@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  labviewProcesses = @(Get-Process LabVIEW -ErrorAction SilentlyContinue).Count
  tightVncProcesses = @(Get-Process tvnserver -ErrorAction SilentlyContinue).Count
  captureTasks = @(
    Get-ScheduledTask `
      -TaskName LBA-TightVNC,LBA-LaunchLabVIEW,LBA-CaptureLaunch `
      -ErrorAction SilentlyContinue
  ).Count
  vncPasswordPresent = $null -ne (Get-ItemProperty HKCU:\Software\TightVNC\Server -Name Password -ErrorAction SilentlyContinue)
  guestVncSecretPresent = Test-Path C:\lba-provision\.vnc-password
  guestTightVncMsiPresent = Test-Path C:\lba-provision\tightvnc.msi
  interactiveAgentRunPresent = $null -ne (
    Get-ItemProperty `
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
      -Name 'LBA-InteractiveAgent' `
      -ErrorAction SilentlyContinue
  )
  interactiveAgentStatePresent = @(
    Test-Path C:\lba-provision\interactive-agent-ready.json
    Test-Path C:\lba-provision\interactive-agent.pid
    Test-Path C:\lba-provision\launch.go
  ) -contains $true
  interactiveAgentProcesses = @(
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
      Where-Object CommandLine -Match 'vm-vagrant-interactive-agent\.ps1'
  ).Count
  bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')
  computerName = $env:COMPUTERNAME
  labviewVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo('C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe').FileVersion
}
$temporary = "$OutputPath.$PID.tmp"
[IO.File]::WriteAllText($temporary, "$(ConvertTo-Json $receipt -Compress)`n", [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
$receipt | ConvertTo-Json -Compress

if (
  $receipt.labviewProcesses -ne 0 -or $receipt.tightVncProcesses -ne 0 -or
  $receipt.captureTasks -ne 0 -or $receipt.vncPasswordPresent -or
  $receipt.guestVncSecretPresent -or $receipt.guestTightVncMsiPresent -or
  $receipt.interactiveAgentRunPresent -or $receipt.interactiveAgentStatePresent -or
  $receipt.interactiveAgentProcesses -ne 0
) {
  exit 6
}
