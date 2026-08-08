[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$labview = 'C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe'
$os = Get-CimInstance Win32_OperatingSystem
$explorer = @(
  Get-Process explorer -ErrorAction SilentlyContinue |
    Where-Object SessionId -gt 0
)

[pscustomobject]@{
  schema = 'labview-benchmark-actor/windows-vagrant-guest-ready@1'
  computerName = $env:COMPUTERNAME
  product = $os.Caption
  version = $os.Version
  labviewPresent = Test-Path -LiteralPath $labview
  labviewFileVersion = if (Test-Path -LiteralPath $labview) {
    [Diagnostics.FileVersionInfo]::GetVersionInfo($labview).FileVersion
  } else {
    $null
  }
  interactiveExplorerCount = $explorer.Count
  interactiveSessionIds = @($explorer.SessionId | Sort-Object -Unique)
  wallTime = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Compress
