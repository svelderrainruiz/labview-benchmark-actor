[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$ActorId,
  [Parameter(Mandatory = $true)][string]$RequesterKeysPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceCommit,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceTree,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$BundleSha256,
  [string]$InstallRoot = 'C:\ProgramData\lba-autonomous-actor',
  [string]$ControllerHost = '192.168.56.1',
  [ValidateRange(1, 65535)][int]$TcpPort = 7430,
  [string]$Session = 'autonomous-n3',
  [string]$LbabusPath = 'C:\lba-tools\lbabus\lbabus.exe',
  [string]$OpenSslPath = 'C:\Program Files\Git\usr\bin\openssl.exe'
)

$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'provision-autonomous-windows-actor.ps1 must run from an elevated native Windows PowerShell 5 console'
}
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "native Windows PowerShell 5 Desktop is required; found $($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
}

$daemonSource = Join-Path $SourceRoot 'experiments\mesh-fulfillment\autonomousActorDaemon.ps1'
$workloadSource = Join-Path $SourceRoot 'experiments\mesh-fulfillment\runLabviewKnownAnswer.ps1'
foreach ($path in @($daemonSource, $workloadSource, $RequesterKeysPath, $LbabusPath, $OpenSslPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "required file does not exist: $path" }
}

$runtimeDir = Join-Path $InstallRoot 'run'
New-Item -ItemType Directory -Path $InstallRoot, $runtimeDir -Force | Out-Null
Copy-Item -LiteralPath $daemonSource -Destination (Join-Path $InstallRoot 'autonomousActorDaemon.ps1') -Force
Copy-Item -LiteralPath $workloadSource -Destination (Join-Path $InstallRoot 'runLabviewKnownAnswer.ps1') -Force
Copy-Item -LiteralPath $RequesterKeysPath -Destination (Join-Path $InstallRoot 'requesters.json') -Force

$privateKeyPath = Join-Path $InstallRoot 'actor-private.pem'
$publicKeyPath = Join-Path $InstallRoot 'actor-public.pem'
if (-not (Test-Path -LiteralPath $privateKeyPath -PathType Leaf)) {
  & $OpenSslPath genpkey -algorithm ED25519 -out $privateKeyPath
  if ($LASTEXITCODE -ne 0) { throw 'guest-local Ed25519 key generation failed' }
}
& $OpenSslPath pkey -in $privateKeyPath -pubout -out $publicKeyPath
if ($LASTEXITCODE -ne 0) { throw 'guest-local public key export failed' }

$config = [ordered]@{
  actorId = $ActorId
  plane = 'WIN'
  privateKeyPath = $privateKeyPath
  publicKeyPath = $publicKeyPath
  requesterKeysPath = Join-Path $InstallRoot 'requesters.json'
  statePath = Join-Path $InstallRoot 'state.json'
  runtimeDir = $runtimeDir
  logPath = Join-Path $InstallRoot 'bus.jsonl'
  workloadPath = Join-Path $InstallRoot 'runLabviewKnownAnswer.ps1'
  lbabusPath = $LbabusPath
  opensslPath = $OpenSslPath
  controllerHost = $ControllerHost
  tcpPort = $TcpPort
  session = $Session
  expectedCandidate = [ordered]@{ sourceCommit = $SourceCommit; sourceTree = $SourceTree; bundleSha256 = $BundleSha256 }
}
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $InstallRoot 'actor.json'), "$(ConvertTo-Json $config -Depth 10)`n", $utf8NoBom)

$firewallName = "LBA Autonomous Actor TCP $TcpPort"
if (-not (Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $TcpPort -Profile Any | Out-Null
}

$startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'lba-autonomous-actor.cmd'
$powershellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$launcher = "@echo off`r`nstart `"`" `"$powershellPath`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$InstallRoot\autonomousActorDaemon.ps1`"`r`n"
[IO.File]::WriteAllText($startupPath, $launcher, [Text.Encoding]::ASCII)

Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match ' -File .*autonomousActorDaemon\.ps1') -or
  ($_.Name -eq 'lbabus.exe' -and $_.CommandLine -match "net listen.*--tcp $TcpPort")
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process -FilePath $startupPath

$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
  $listening = [bool](Get-NetTCPConnection -State Listen -LocalPort $TcpPort -ErrorAction SilentlyContinue)
  if (-not $listening) { Start-Sleep -Milliseconds 250 }
} while (-not $listening -and [DateTime]::UtcNow -lt $deadline)
if (-not $listening) { throw "actor did not listen on TCP $TcpPort within 15 seconds" }

[ordered]@{
  actorId = $ActorId
  runtime = "$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
  executable = $powershellPath
  tcpPort = $TcpPort
  startupPath = $startupPath
  publicKeyPem = [IO.File]::ReadAllText($publicKeyPath)
} | ConvertTo-Json -Depth 5