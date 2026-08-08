#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PayloadZip,
  [string]$InstallRoot = 'C:\lba-tools\lbabus',
  [string]$ExpectedVersion = '0.15.4'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $PayloadZip)) { throw "lbabus payload is missing at '$PayloadZip'." }
$temporary = "$InstallRoot.$PID.tmp"
Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $temporary -Force | Out-Null
try {
  Expand-Archive -LiteralPath $PayloadZip -DestinationPath $temporary
  $executable = Join-Path $temporary 'lbabus.exe'
  if (-not (Test-Path -LiteralPath $executable)) { throw 'lbabus payload has no Windows apphost.' }
  $version = (& $executable version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $version -ne $ExpectedVersion) {
    throw "lbabus payload version '$version' does not match '$ExpectedVersion'."
  }
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $temporary -Destination $InstallRoot
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if ($parts -notcontains $InstallRoot) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $InstallRoot) -join ';'), 'User')
  }
  [pscustomobject]@{
    schema = 'labview-benchmark-actor/reviewer-lbabus-install@1'
    path = Join-Path $InstallRoot 'lbabus.exe'
    version = $version
    userPathUpdated = $parts -notcontains $InstallRoot
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
