[CmdletBinding()]
param(
  [string]$OutputPath = 'C:\lba-provision\vagrant-box-preparation.json',
  [string]$VagrantPassword = 'Vagrant1234!'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Vagrant box preparation requires an elevated PowerShell session.'
}

$securePassword = ConvertTo-SecureString $VagrantPassword -AsPlainText -Force
$user = Get-LocalUser -Name vagrant
Set-LocalUser -Name vagrant -Password $securePassword -AccountNeverExpires -PasswordNeverExpires $true
Enable-LocalUser -Name vagrant
$adsiUser = [ADSI]"WinNT://$env:COMPUTERNAME/vagrant,user"
$adsiUser.IsAccountLocked = $false
$adsiUser.SetInfo()
$administratorMember = "$env:COMPUTERNAME\vagrant"
if (@(Get-LocalGroupMember -Group Administrators).Name -notcontains $administratorMember) {
  Add-LocalGroupMember -Group Administrators -Member "$env:COMPUTERNAME\vagrant"
}

Get-NetConnectionProfile -ErrorAction SilentlyContinue |
  Where-Object NetworkCategory -eq Public |
  Set-NetConnectionProfile -NetworkCategory Private

New-ItemProperty `
  -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' `
  -Name LocalAccountTokenFilterPolicy `
  -PropertyType DWord `
  -Value 1 `
  -Force | Out-Null

Set-Service WinRM -StartupType Automatic
Enable-PSRemoting -SkipNetworkProfileCheck -Force
Set-Item WSMan:\localhost\Service\Auth\Basic -Value $true
Set-Item WSMan:\localhost\Service\AllowUnencrypted -Value $true
Set-Item WSMan:\localhost\Shell\MaxMemoryPerShellMB -Value 1024

$firewallRuleName = 'LBA-Vagrant-WinRM-HTTP'
$rule = Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue
if ($rule) {
  Set-NetFirewallRule -Name $firewallRuleName -Enabled True -Profile Any -Action Allow
} else {
  New-NetFirewallRule `
    -Name $firewallRuleName `
    -DisplayName 'LabVIEW Benchmark Actor Vagrant WinRM HTTP' `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 5985 `
    -Profile Any | Out-Null
}

$selfHealPath = 'C:\lba-provision\ensure-vagrant-winrm.ps1'
$selfHeal = @'
$ErrorActionPreference = 'Stop'
Set-Service WinRM -StartupType Automatic
Start-Service WinRM
Enable-NetFirewallRule -Name 'LBA-Vagrant-WinRM-HTTP' -ErrorAction SilentlyContinue
'@
[IO.File]::WriteAllText($selfHealPath, $selfHeal, [Text.UTF8Encoding]::new($false))
$taskAction = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$selfHealPath`""
$taskTrigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask `
  -TaskName 'LBA-Vagrant-WinRM-SelfHeal' `
  -Action $taskAction `
  -Trigger $taskTrigger `
  -User SYSTEM `
  -RunLevel Highest `
  -Force | Out-Null

$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
New-ItemProperty -Path $winlogon -Name AutoAdminLogon -PropertyType String -Value '1' -Force | Out-Null
New-ItemProperty -Path $winlogon -Name DefaultUserName -PropertyType String -Value 'vagrant' -Force | Out-Null
New-ItemProperty -Path $winlogon -Name DefaultDomainName -PropertyType String -Value $env:COMPUTERNAME -Force | Out-Null
New-ItemProperty -Path $winlogon -Name DefaultPassword -PropertyType String -Value $VagrantPassword -Force | Out-Null

Start-Service WinRM
$preparedUser = Get-LocalUser -Name vagrant
$preparedUserCim = Get-CimInstance Win32_UserAccount -Filter "LocalAccount=True AND Name='vagrant'"
$listener = Get-ChildItem WSMan:\localhost\Listener |
  Where-Object { $_.Keys -contains 'Transport=HTTP' } |
  Select-Object -First 1
$receipt = [ordered]@{
  schema = 'labview-benchmark-actor/windows-vagrant-box-preparation@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  computerName = $env:COMPUTERNAME
  user = [ordered]@{
    name = $preparedUser.Name
    enabled = $preparedUser.Enabled
    lockedOut = [bool]$adsiUser.IsAccountLocked
    passwordNeverExpires = -not [bool]$preparedUserCim.PasswordExpires
    administrator = @(Get-LocalGroupMember -Group Administrators).Name -contains $administratorMember
  }
  winrm = [ordered]@{
    serviceStatus = (Get-Service WinRM).Status.ToString()
    serviceStartType = (Get-CimInstance Win32_Service -Filter "Name='WinRM'").StartMode
    httpListenerPresent = $null -ne $listener
    basicAuthentication = [bool](Get-Item WSMan:\localhost\Service\Auth\Basic).Value
    allowUnencrypted = [bool](Get-Item WSMan:\localhost\Service\AllowUnencrypted).Value
    firewallRuleEnabled = (Get-NetFirewallRule -Name $firewallRuleName).Enabled.ToString()
    selfHealTask = $null -ne (Get-ScheduledTask -TaskName 'LBA-Vagrant-WinRM-SelfHeal' -ErrorAction SilentlyContinue)
  }
  autoLogon = [ordered]@{
    enabled = (Get-ItemPropertyValue -Path $winlogon -Name AutoAdminLogon) -eq '1'
    user = Get-ItemPropertyValue -Path $winlogon -Name DefaultUserName
    passwordContract = 'public disposable Vagrant credential; value intentionally omitted'
  }
}

$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$temporary = "$OutputPath.$PID.tmp"
[IO.File]::WriteAllText($temporary, "$(ConvertTo-Json $receipt -Depth 10)`n", [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
$receipt | ConvertTo-Json -Depth 10 -Compress
