[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$packages = @(
  @{ id = 'Git.Git' },
  @{ id = 'BurntSushi.ripgrep.MSVC' },
  @{ id = 'GitHub.cli' },
  @{ id = 'GLab.GLab' },
  @{ id = 'Microsoft.DotNet.SDK.8' }
)

foreach ($package in $packages) {
  $installed = (& winget list --id $package.id --exact --accept-source-agreements --disable-interactivity 2>&1 | Out-String)
  $verb = if ($LASTEXITCODE -eq 0 -and $installed -match [regex]::Escape($package.id)) { 'upgrade' } else { 'install' }
  $args = @(
    $verb, '--id', $package.id, '--exact', '--silent',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
  )
  if ($package.version) { $args += @('--version', $package.version) }
  & winget @args | Out-Host
  # APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE: the exact package is already installed with no newer version.
  if ($LASTEXITCODE -notin 0, -1978335189) {
    throw "winget install $($package.id) failed ($LASTEXITCODE)."
  }
}

function Find-WingetTool([string]$PackagePrefix, [string]$FileName) {
  $root = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  $package = Get-ChildItem $root -Directory -Filter "$PackagePrefix*" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $package) { return $null }
  return Get-ChildItem $package.FullName -File -Filter $FileName -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}

$tools = [ordered]@{
  git = 'C:\Program Files\Git\cmd\git.exe'
  rg = Find-WingetTool 'BurntSushi.ripgrep.MSVC_' 'rg.exe'
  gh = 'C:\Program Files\GitHub CLI\gh.exe'
  glab = Join-Path $env:LOCALAPPDATA 'Programs\glab\glab.exe'
  dotnet = 'C:\Program Files\dotnet\dotnet.exe'
}
foreach ($entry in $tools.GetEnumerator()) {
  if (-not $entry.Value -or -not (Test-Path -LiteralPath $entry.Value)) {
    throw "Reviewer tool '$($entry.Key)' did not resolve after installation."
  }
}

$pathEntries = @($tools.Values | ForEach-Object { Split-Path $_ -Parent } | Select-Object -Unique)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($userPath -split ';' | Where-Object { $_ })
foreach ($entry in $pathEntries) {
  if ($parts -notcontains $entry) { $parts += $entry }
}
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
$env:Path = "$([Environment]::GetEnvironmentVariable('Path', 'Machine'));$($parts -join ';')"

$versions = [ordered]@{
  git = (& $tools.git --version | Select-Object -First 1)
  rg = (& $tools.rg --version | Select-Object -First 1)
  gh = (& $tools.gh --version | Select-Object -First 1)
  glab = (& $tools.glab --version | Select-Object -First 1)
  dotnet = (& $tools.dotnet --version | Select-Object -First 1)
}

$receipt = [ordered]@{
  schema = 'labview-benchmark-actor/reviewer-toolchain-install@1'
  ok = $true
  installedAt = [DateTime]::UtcNow.ToString('o')
  tools = $tools
  versions = $versions
  pathEntries = $pathEntries
}
$receiptPath = 'C:\lba-tools\reviewer-toolchain.json'
[IO.File]::WriteAllText($receiptPath, "$($receipt | ConvertTo-Json -Depth 8)`n", [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 8 -Compress
