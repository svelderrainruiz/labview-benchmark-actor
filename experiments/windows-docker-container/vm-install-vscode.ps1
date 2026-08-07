[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$winget = Get-Command winget.exe -ErrorAction Stop
& $winget.Source install `
  --id Microsoft.VisualStudioCode `
  --exact `
  --scope machine `
  --silent `
  --accept-package-agreements `
  --accept-source-agreements `
  --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw "winget exited $LASTEXITCODE while installing Visual Studio Code." }

$code = @(
  'C:\Program Files\Microsoft VS Code\bin\code.cmd',
  'C:\Program Files\Microsoft VS Code\Code.exe'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $code) { throw 'Visual Studio Code installation completed but no expected command path exists.' }

[pscustomobject]@{
  schema = 'labview-benchmark-actor/windows-vscode-install@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  packageId = 'Microsoft.VisualStudioCode'
  scope = 'machine'
  commandPath = $code
  fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo(
    'C:\Program Files\Microsoft VS Code\Code.exe'
  ).FileVersion
  wingetVersion = (& $winget.Source --version)
} | ConvertTo-Json -Compress
