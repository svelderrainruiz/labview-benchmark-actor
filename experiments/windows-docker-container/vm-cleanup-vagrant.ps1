[CmdletBinding()]
param([string]$OutputPath = 'C:\lba-provision\guest-cleanup-verification.json')

$ErrorActionPreference = 'Stop'

Get-Process LabVIEW, tvnserver -ErrorAction SilentlyContinue | Stop-Process -Force
Unregister-ScheduledTask `
  -TaskName 'LBA-TightVNC', 'LBA-LaunchLabVIEW', 'LBA-CaptureLaunch' `
  -Confirm:$false `
  -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\TightVNC\Server' -Name Password -ErrorAction SilentlyContinue
Remove-ItemProperty `
  -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
  -Name 'LBA-InteractiveAgent' `
  -ErrorAction SilentlyContinue
if (Test-Path 'C:\lba-provision\interactive-agent.pid') {
  $agentPid = [int](Get-Content 'C:\lba-provision\interactive-agent.pid' -Raw)
  Stop-Process -Id $agentPid -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object CommandLine -Match 'vm-vagrant-interactive-agent\.ps1' |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item 'C:\lba-provision\.vnc-password' -Force -ErrorAction SilentlyContinue
Remove-Item `
  'C:\lba-provision\interactive-agent-ready.json', `
  'C:\lba-provision\interactive-agent.pid', `
  'C:\lba-provision\launch.go' `
  -Force `
  -ErrorAction SilentlyContinue

$proof = Start-Process powershell.exe -ArgumentList @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', 'C:\lba-provision\vm-guest-cleanup-proof.ps1',
  '-OutputPath', $OutputPath
) -Wait -PassThru

if (-not (Test-Path -LiteralPath $OutputPath)) {
  throw "Guest cleanup proof did not create '$OutputPath'."
}

$receipt = Get-Content -LiteralPath $OutputPath -Raw | ConvertFrom-Json
$receipt | Add-Member -NotePropertyName proofExitCode -NotePropertyValue $proof.ExitCode -Force
$receipt | ConvertTo-Json -Depth 10 -Compress
