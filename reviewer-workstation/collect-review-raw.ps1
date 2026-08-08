[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$VmName,
  [Parameter(Mandatory)][string]$OutDir,
  [string]$GuestUser = 'vagrant',
  [string]$GuestPassword = 'Vagrant1234!'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$guestOutput = 'C:\Windows\Temp\lba-review-raw.json'
$script = @'
$global = 'C:\Users\vagrant\AppData\Roaming\Code\User\globalStorage\svelderrainruiz.labview-benchmark-actor\handoff'
$extensionRoot = Get-ChildItem 'C:\Users\vagrant\.vscode\extensions' -Directory -Filter 'svelderrainruiz.labview-benchmark-actor-*' |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $extensionRoot) { throw 'Installed extension root was not found.' }
$package = Get-Content (Join-Path $extensionRoot.FullName 'package.json') -Raw | ConvertFrom-Json
$agentsPath = Join-Path $extensionRoot.FullName 'media\AGENTS.md'
$agents = Get-Content $agentsPath -Raw
$settings = Get-Content 'C:\Users\vagrant\AppData\Roaming\Code\User\settings.json' -Raw | ConvertFrom-Json
$lbabus = 'C:\lba-tools\lbabus\lbabus.exe'
$capabilitiesOut = 'C:\Windows\Temp\lba-capabilities.out'
$capabilitiesErr = 'C:\Windows\Temp\lba-capabilities.err'
Remove-Item $capabilitiesOut, $capabilitiesErr -Force -ErrorAction SilentlyContinue
$capabilitiesProcess = Start-Process $lbabus -ArgumentList 'capabilities' -PassThru `
  -RedirectStandardOutput $capabilitiesOut -RedirectStandardError $capabilitiesErr
$capabilitiesTimedOut = -not $capabilitiesProcess.WaitForExit(30000)
if ($capabilitiesTimedOut) {
  Stop-Process -Id $capabilitiesProcess.Id -Force -ErrorAction SilentlyContinue
  $capabilitiesProcess.WaitForExit()
}
$capabilities = @()
if (Test-Path $capabilitiesOut) { $capabilities += Get-Content $capabilitiesOut }
if (Test-Path $capabilitiesErr) { $capabilities += Get-Content $capabilitiesErr }
[ordered]@{
  schema = 'labview-benchmark-actor/reviewer-raw-evidence@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  reviewTarget = Get-Content (Join-Path $global 'review-target.json') -Raw | ConvertFrom-Json
  candidate = [ordered]@{
    path = 'C:\lba-review\candidate.vsix'
    size = (Get-Item 'C:\lba-review\candidate.vsix').Length
    sha256 = (Get-FileHash 'C:\lba-review\candidate.vsix' -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  extension = [ordered]@{
    id = 'svelderrainruiz.labview-benchmark-actor'
    version = $package.version
    commands = @($package.contributes.commands | Select-Object command,title)
    taskDefinitions = @($package.contributes.taskDefinitions)
  }
  agents = [ordered]@{
    manifest = Get-Content (Join-Path $extensionRoot.FullName 'media\agents.manifest.json') -Raw | ConvertFrom-Json
    sha256 = (Get-FileHash $agentsPath -Algorithm SHA256).Hash.ToLowerInvariant()
    text = $agents
  }
  lbabus = [ordered]@{
    path = $lbabus
    version = (& $lbabus version)
    capabilitiesTimedOut = $capabilitiesTimedOut
    capabilitiesExitCode = if ($capabilitiesTimedOut) { $null } else { $capabilitiesProcess.ExitCode }
    capabilities = $capabilities
  }
  reviewerSettings = [ordered]@{
    reviewerId = $settings.'labviewBenchmarkActor.reviewerId'
    reviewerKeyPath = $settings.'labviewBenchmarkActor.reviewerKeyPath'
    keyExists = Test-Path $settings.'labviewBenchmarkActor.reviewerKeyPath'
  }
} | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath 'C:\Windows\Temp\lba-review-raw.json' -Encoding UTF8
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
& VBoxManage guestcontrol $VmName --username $GuestUser --password $GuestPassword run `
  --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' --wait-stdout --wait-stderr -- `
  -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded | Out-Null
if ($LASTEXITCODE) { throw 'Guest raw-review collection failed.' }

$rawPath = Join-Path $OutDir 'review-raw.json'
& VBoxManage guestcontrol $VmName --username $GuestUser --password $GuestPassword copyfrom $guestOutput $rawPath | Out-Null
if ($LASTEXITCODE) { throw 'Raw review JSON extraction failed.' }
$screenshot = Join-Path $OutDir 'review-screen.png'
& VBoxManage controlvm $VmName screenshotpng $screenshot | Out-Null
if ($LASTEXITCODE) { throw 'Review screenshot capture failed.' }
$vmInfo = & VBoxManage showvminfo $VmName --machinereadable
[IO.File]::WriteAllLines((Join-Path $OutDir 'vm-info.txt'), @($vmInfo), [Text.UTF8Encoding]::new($false))

$raw = Get-Content $rawPath -Raw | ConvertFrom-Json
[ordered]@{
  schema = 'labview-benchmark-actor/reviewer-raw-index@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  vmName = $VmName
  candidateSha256 = $raw.candidate.sha256
  files = @(
    Get-ChildItem $OutDir -File | Sort-Object Name | ForEach-Object {
      [ordered]@{
        path = $_.FullName
        size = $_.Length
        sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  )
} | ConvertTo-Json -Depth 10
