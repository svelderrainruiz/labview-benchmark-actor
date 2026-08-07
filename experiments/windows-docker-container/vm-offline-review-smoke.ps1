[CmdletBinding()]
param([string]$Workspace = 'C:\lba-review\offline-gate')

$ErrorActionPreference = 'Stop'
$interactiveUser = (Get-CimInstance Win32_ComputerSystem).UserName
$explorer = @(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0)
if (-not $interactiveUser -or $explorer.Count -eq 0) { throw 'No interactive reviewer session is active.' }

New-Item -ItemType Directory -Path $Workspace -Force | Out-Null
Remove-Item (Join-Path $Workspace 'AGENTS.md') -Force -ErrorAction SilentlyContinue
$code = 'C:\Program Files\Microsoft VS Code\bin\code.cmd'
if (-not (Test-Path $code)) { throw 'VS Code command is missing.' }
$extensionLine = @(& $code --list-extensions --show-versions) |
  Where-Object { $_ -match '^svelderrainruiz\.labview-benchmark-actor@' } |
  Select-Object -First 1
if (-not $extensionLine) { throw 'LabVIEW Benchmark Actor extension is not installed.' }
$extensionDir = Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory |
  Where-Object Name -Like 'svelderrainruiz.labview-benchmark-actor-*' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $extensionDir) { throw 'Installed extension directory is missing.' }
$manifest = Get-Content (Join-Path $extensionDir.FullName 'package.json') -Raw | ConvertFrom-Json
$commands = @($manifest.contributes.commands | ForEach-Object command)
$mcpPath = Join-Path $extensionDir.FullName 'out\mcp\runBenchmarkActorMcpServer.js'

[pscustomobject]@{
  schema = 'labview-benchmark-actor/windows-reviewer-offline-smoke@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  computerName = $env:COMPUTERNAME
  interactiveUser = $interactiveUser
  interactiveSessionIds = @($explorer.SessionId | Sort-Object -Unique)
  workspace = $Workspace
  workspaceAgentsAbsent = -not (Test-Path (Join-Path $Workspace 'AGENTS.md'))
  extension = [pscustomobject]@{
    installed = $true
    line = $extensionLine
    id = $manifest.publisher + '.' + $manifest.name
    version = $manifest.version
    directory = $extensionDir.FullName
    commandCount = $commands.Count
    commands = $commands
  }
  mcp = [pscustomobject]@{
    serverPath = $mcpPath
    serverPresent = Test-Path $mcpPath
  }
  labview = [pscustomobject]@{
    path = 'C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe'
    present = Test-Path 'C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe'
    fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo(
      'C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe'
    ).FileVersion
  }
} | ConvertTo-Json -Depth 20 -Compress
