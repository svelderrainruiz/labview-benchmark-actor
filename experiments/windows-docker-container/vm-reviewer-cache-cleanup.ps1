[CmdletBinding()]
param([string]$OutputPath = 'C:\lba-provision\reviewer-cache-cleanup.json')

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
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object CommandLine -Match 'vm-vagrant-interactive-agent\.ps1' |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item `
  'C:\lba-review\candidate.vsix', `
  'C:\Windows\Temp\lba-guest-install.ps1', `
  'C:\lba-provision\vm-vsix-proof.ps1', `
  'C:\lba-provision\.vnc-password', `
  'C:\lba-provision\interactive-agent-ready.json', `
  'C:\lba-provision\interactive-agent.pid', `
  'C:\lba-provision\launch.go' `
  -Force `
  -ErrorAction SilentlyContinue

& 'C:\lba-provision\vm-guest-cleanup-proof.ps1' -OutputPath $OutputPath
