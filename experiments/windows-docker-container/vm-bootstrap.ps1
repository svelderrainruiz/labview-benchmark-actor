[CmdletBinding()]
param(
  [string]$TightVncInstaller,
  [Parameter(Mandatory = $true)][string]$PasswordFile,
  [string]$ExpectedInstallerSha256 = '0d6402e530a563c90040d7c07b98ab68670d3669e4cc573ad24056ff960c9dcb',
  [switch]$UseLoginAgent
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TightVncExe = 'C:\Program Files\TightVNC\tvnserver.exe'
$LabViewExe = 'C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe'
$RegistryPath = 'HKCU:\Software\TightVNC\Server'
$ServiceOnlyPath = 'HKLM:\SOFTWARE\TightVNC\Server\ServiceOnly'

function Protect-TightVncPassword([string]$PlainText) {
  if ($PlainText.Length -lt 1 -or $PlainText.Length -gt 8) {
    throw 'The ephemeral TightVNC password must contain 1 to 8 characters.'
  }
  $plain = [byte[]]::new(8)
  $ascii = [Text.Encoding]::ASCII.GetBytes($PlainText)
  [Array]::Copy($ascii, $plain, [Math]::Min(8, $ascii.Length))
  $key = [byte[]](232, 74, 214, 96, 196, 114, 26, 224)
  $des = [Security.Cryptography.DES]::Create()
  try {
    $des.Mode = [Security.Cryptography.CipherMode]::ECB
    $des.Padding = [Security.Cryptography.PaddingMode]::None
    $des.Key = $key
    $encryptor = $des.CreateEncryptor()
    try { return $encryptor.TransformFinalBlock($plain, 0, $plain.Length) }
    finally { $encryptor.Dispose() }
  } finally {
    [Array]::Clear($plain, 0, $plain.Length)
    [Array]::Clear($ascii, 0, $ascii.Length)
    $des.Dispose()
  }
}

function Register-InteractiveTask([string]$Name, [string]$Executable, [string]$Arguments) {
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $root = $service.GetFolder('\')
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = 'LabVIEW Benchmark Actor local VM task'
  $definition.Settings.Enabled = $true
  $definition.Settings.Hidden = $false
  $definition.Settings.StartWhenAvailable = $true
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $action = $definition.Actions.Create(0)
  $action.Path = $Executable
  $action.Arguments = $Arguments
  $action.WorkingDirectory = Split-Path -Parent $Executable
  $definition.Principal.UserId = "$env:COMPUTERNAME\$env:USERNAME"
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 1
  $null = $root.RegisterTaskDefinition($Name, $definition, 6, $null, $null, 3, $null)
}

if (-not (Test-Path -LiteralPath $PasswordFile)) { throw 'VNC password file is missing.' }
if (-not (Test-Path -LiteralPath $LabViewExe)) { throw 'LabVIEW 2026 x64 is missing.' }
if ($TightVncInstaller) {
  if (-not (Test-Path -LiteralPath $TightVncInstaller)) { throw 'TightVNC installer is missing.' }
  if ((Get-FileHash -LiteralPath $TightVncInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedInstallerSha256) {
    throw 'TightVNC installer SHA-256 mismatch.'
  }
}

if (-not (Test-Path -LiteralPath $TightVncExe)) {
  if (-not $TightVncInstaller) { throw 'TightVNC is not installed and no installer path was supplied.' }
  $install = Start-Process msiexec.exe -ArgumentList @(
    '/i', "`"$TightVncInstaller`"", '/quiet', '/norestart',
    'ADDLOCAL=Server', 'SERVER_REGISTER_AS_SERVICE=0', 'SERVER_ADD_FIREWALL_EXCEPTION=0'
  ) -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "TightVNC installer exited $($install.ExitCode)." }
}
if (Get-Service tvnserver -ErrorAction SilentlyContinue) {
  throw 'TightVNC unexpectedly registered a Windows service.'
}
if (Test-Path -LiteralPath $ServiceOnlyPath) {
  Remove-Item -LiteralPath $ServiceOnlyPath -Recurse -Force
}

$passwordText = [IO.File]::ReadAllText($PasswordFile).Trim()
$encrypted = Protect-TightVncPassword $passwordText
$passwordText = $null
New-Item -Path $RegistryPath -Force | Out-Null
New-ItemProperty -Path $RegistryPath -Name Password -PropertyType Binary -Value $encrypted -Force | Out-Null
[Array]::Clear($encrypted, 0, $encrypted.Length)
$settings = [ordered]@{
  AcceptRfbConnections = 1
  RfbPort = 5900
  UseVncAuthentication = 1
  UseControlAuthentication = 0
  LoopbackOnly = 0
  AllowLoopback = 1
  AcceptHttpConnections = 0
  EnableFileTransfers = 0
  UseD3D = 1
  UseMirrorDriver = 0
  RemoveWallpaper = 0
  LogLevel = 9
}
foreach ($entry in $settings.GetEnumerator()) {
  New-ItemProperty -Path $RegistryPath -Name $entry.Key -PropertyType DWord -Value $entry.Value -Force | Out-Null
}

$tasks = @()
$listener = $null
if ($UseLoginAgent) {
  Unregister-ScheduledTask `
    -TaskName 'LBA-TightVNC', 'LBA-LaunchLabVIEW', 'LBA-CaptureLaunch' `
    -Confirm:$false `
    -ErrorAction SilentlyContinue
  $runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  New-Item -Path $runPath -Force | Out-Null
  New-ItemProperty `
    -Path $runPath `
    -Name 'LBA-InteractiveAgent' `
    -PropertyType String `
    -Value 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\lba-provision\vm-vagrant-interactive-agent.ps1' `
    -Force | Out-Null
} else {
  Register-InteractiveTask -Name 'LBA-TightVNC' -Executable $TightVncExe -Arguments '-run'
  Register-InteractiveTask -Name 'LBA-LaunchLabVIEW' -Executable $LabViewExe -Arguments ''
  Register-InteractiveTask `
    -Name 'LBA-CaptureLaunch' `
    -Executable 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -Arguments '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\lba-provision\vm-launch.ps1 -OutputPath C:\lba-provision\launch-diagnostics.json -WindowTimeoutSeconds 90'
  $tasks = @('LBA-TightVNC', 'LBA-LaunchLabVIEW', 'LBA-CaptureLaunch')
  Start-ScheduledTask -TaskName 'LBA-TightVNC'

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $listener = Get-NetTCPConnection -State Listen -LocalPort 5900 -ErrorAction SilentlyContinue | Select-Object -First 1
  } while (-not $listener -and [DateTime]::UtcNow -lt $deadline)
  if (-not $listener) {
    $task = Get-ScheduledTask -TaskName 'LBA-TightVNC' -ErrorAction SilentlyContinue
    $taskInfo = Get-ScheduledTaskInfo -TaskName 'LBA-TightVNC' -ErrorAction SilentlyContinue
    $processCount = @(Get-Process tvnserver -ErrorAction SilentlyContinue).Count
    throw "TightVNC did not listen on port 5900 (taskState=$($task.State), lastTaskResult=$($taskInfo.LastTaskResult), processCount=$processCount)."
  }
}

$labviewVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($LabViewExe)
$tightVncVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($TightVncExe)
[pscustomobject]@{
  schema = 'labview-benchmark-actor/windows-vm-bootstrap@1'
  labview = [ordered]@{ path = $LabViewExe; fileVersion = $labviewVersion.FileVersion }
  tightVnc = [ordered]@{
    path = $TightVncExe
    productVersion = $tightVncVersion.ProductVersion
    processId = if ($listener) { $listener.OwningProcess } else { $null }
    port = 5900
    address = if ($listener) { $listener.LocalAddress } else { $null }
    authentication = 'VNC authentication with ephemeral eight-character secret'
    startMode = if ($UseLoginAgent) { 'interactive-login-agent-after-reboot' } else { 'interactive-scheduled-task' }
  }
  tasks = $tasks
  rebootRequired = [bool]$UseLoginAgent
  sessionId = (Get-Process -Id $PID).SessionId
} | ConvertTo-Json -Depth 6 -Compress
