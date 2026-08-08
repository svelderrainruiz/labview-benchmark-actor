[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$VmName,
  [Parameter(Mandatory)][string]$OutDir,
  [string]$GuestUser = 'vagrant',
  [string]$GuestPassword = 'Vagrant1234!'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

function Copy-GuestFile([string]$Source, [string]$Destination, [switch]$AllowMissing) {
  Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
  $prior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(
      & VBoxManage guestcontrol $VmName --username $GuestUser --password $GuestPassword `
        copyfrom $Source $Destination 2>&1 | ForEach-Object { "$_" }
    )
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prior
  }
  if ($exitCode -ne 0 -and -not $AllowMissing) {
    throw "Could not extract '$Source': $($output -join [Environment]::NewLine)"
  }
  return $exitCode -eq 0
}

$targetPath = Join-Path $OutDir 'review-target.json'
Copy-GuestFile `
  'C:\Users\vagrant\AppData\Roaming\Code\User\globalStorage\svelderrainruiz.labview-benchmark-actor\handoff\review-target.json' `
  $targetPath | Out-Null
$target = Get-Content $targetPath -Raw | ConvertFrom-Json
if ($target.component -ne 'extension' -or $target.version -notmatch '^\d+\.\d+\.\d+$') {
  throw 'Guest review target is invalid.'
}

$extensionRoot = "C:\Users\vagrant\.vscode\extensions\svelderrainruiz.labview-benchmark-actor-$($target.version)"
$candidatePath = Join-Path $OutDir 'candidate.vsix'
$candidateReceiptPath = Join-Path $OutDir 'candidate-receipt.json'
$packagePath = Join-Path $OutDir 'extension-package.json'
$agentsPath = Join-Path $OutDir 'AGENTS.md'
$agentsManifestPath = Join-Path $OutDir 'agents.manifest.json'
$settingsPath = Join-Path $OutDir 'settings.json'
$verdictPath = Join-Path $OutDir 'signed-verdict.json'
Copy-GuestFile 'C:\lba-review\candidate.vsix' $candidatePath | Out-Null
Copy-GuestFile 'C:\lba-review\workspace\candidate-receipt.json' $candidateReceiptPath | Out-Null
Copy-GuestFile "$extensionRoot\package.json" $packagePath | Out-Null
Copy-GuestFile "$extensionRoot\media\AGENTS.md" $agentsPath | Out-Null
Copy-GuestFile "$extensionRoot\media\agents.manifest.json" $agentsManifestPath | Out-Null
Copy-GuestFile 'C:\Users\vagrant\AppData\Roaming\Code\User\settings.json' $settingsPath | Out-Null
$verdictPresent = Copy-GuestFile `
  "C:\Users\vagrant\AppData\Roaming\Code\User\globalStorage\svelderrainruiz.labview-benchmark-actor\handoff\verdicts\extension-$($target.version).json" `
  $verdictPath -AllowMissing

$settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
$safeSettings = [ordered]@{
  reviewerId = $settings.'labviewBenchmarkActor.reviewerId'
  reviewerKeyPath = $settings.'labviewBenchmarkActor.reviewerKeyPath'
  keyExists = $false
}
if ($safeSettings.reviewerKeyPath) {
  $keyProbe = Join-Path $OutDir 'key-exists.txt'
  $command = "if (Test-Path -LiteralPath '$($safeSettings.reviewerKeyPath.Replace("'", "''"))') { 'YES' } else { 'NO' }"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $keyOutput = & VBoxManage guestcontrol $VmName --username $GuestUser --password $GuestPassword run `
    --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' --wait-stdout --wait-stderr --timeout=15000 -- `
    -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded
  $safeSettings.keyExists = @($keyOutput) -contains 'YES'
  [IO.File]::WriteAllLines($keyProbe, @($keyOutput), [Text.UTF8Encoding]::new($false))
}
[IO.File]::WriteAllText(
  $settingsPath,
  "$($safeSettings | ConvertTo-Json -Depth 5)`n",
  [Text.UTF8Encoding]::new($false)
)

$capabilitiesOut = Join-Path $OutDir 'lbabus-capabilities.txt'
$capabilitiesErr = Join-Path $OutDir 'lbabus-capabilities.err.txt'
$capabilitiesProcess = Start-Process VBoxManage -ArgumentList @(
  'guestcontrol', $VmName, '--username', $GuestUser, '--password', $GuestPassword,
  'run', '--exe', 'C:\lba-tools\lbabus\lbabus.exe',
  '--wait-stdout', '--wait-stderr', '--timeout=30000', '--', 'capabilities'
) -PassThru -RedirectStandardOutput $capabilitiesOut -RedirectStandardError $capabilitiesErr
$capabilitiesTimedOut = -not $capabilitiesProcess.WaitForExit(45000)
if ($capabilitiesTimedOut) {
  Stop-Process -Id $capabilitiesProcess.Id -Force -ErrorAction SilentlyContinue
  $capabilitiesProcess.WaitForExit()
}

$screenshot = Join-Path $OutDir 'review-screen.png'
& VBoxManage controlvm $VmName screenshotpng $screenshot | Out-Null
if ($LASTEXITCODE) { throw 'Review screenshot capture failed.' }
$vmInfoPath = Join-Path $OutDir 'vm-info.txt'
[IO.File]::WriteAllLines(
  $vmInfoPath,
  @(& VBoxManage showvminfo $VmName --machinereadable),
  [Text.UTF8Encoding]::new($false)
)

$package = Get-Content $packagePath -Raw | ConvertFrom-Json
$candidateReceipt = Get-Content $candidateReceiptPath -Raw | ConvertFrom-Json
$agentsManifest = Get-Content $agentsManifestPath -Raw | ConvertFrom-Json
$candidateHash = (Get-FileHash $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
if (
  $candidateReceipt.mode -ne 'full' -or
  $candidateReceipt.outcome -ne 'PASS' -or
  $candidateReceipt.version -ne $target.version -or
  $candidateReceipt.kpi.candidate.sourceCommit -ne $target.commit -or
  $candidateReceipt.kpi.candidate.vsixSha256 -ne $candidateHash -or
  $candidateReceipt.kpi.candidate.vsixSize -ne (Get-Item $candidatePath).Length -or
  -not $candidateReceipt.kpi.package.identical -or
  $candidateReceipt.kpi.package.firstSha256 -ne $candidateHash -or
  $candidateReceipt.kpi.package.secondSha256 -ne $candidateHash
) {
  throw 'Guest candidate receipt does not bind the exact review target and physical VSIX.'
}
$raw = [ordered]@{
  schema = 'labview-benchmark-actor/reviewer-raw-evidence@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  vmName = $VmName
  reviewTarget = $target
  candidate = [ordered]@{
    size = (Get-Item $candidatePath).Length
    sha256 = $candidateHash
    receiptSha256 = (Get-FileHash $candidateReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceCommit = $candidateReceipt.kpi.candidate.sourceCommit
    coverage = $candidateReceipt.kpi.coverage
    localGates = $candidateReceipt.kpi.localGates
    correspondences = $candidateReceipt.kpi.correspondences
    reproduciblePackage = $candidateReceipt.kpi.package
  }
  extension = [ordered]@{
    id = 'svelderrainruiz.labview-benchmark-actor'
    version = $package.version
    commands = @($package.contributes.commands | Select-Object command,title)
    taskDefinitions = @($package.contributes.taskDefinitions)
  }
  agents = [ordered]@{
    manifest = $agentsManifest
    sha256 = (Get-FileHash $agentsPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  lbabus = [ordered]@{
    version = '0.15.7'
    capabilitiesTimedOut = $capabilitiesTimedOut
    capabilitiesExitCode = if ($capabilitiesTimedOut) { $null } else { $capabilitiesProcess.ExitCode }
    capabilitiesFile = $capabilitiesOut
    capabilitiesErrorFile = $capabilitiesErr
  }
  reviewerSettings = $safeSettings
  signedVerdictPresent = $verdictPresent
}
$rawPath = Join-Path $OutDir 'review-raw.json'
[IO.File]::WriteAllText($rawPath, "$($raw | ConvertTo-Json -Depth 20)`n", [Text.UTF8Encoding]::new($false))

$files = @(
  Get-ChildItem $OutDir -File | Sort-Object Name | ForEach-Object {
    [ordered]@{
      path = $_.FullName
      size = $_.Length
      sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
)
[ordered]@{
  schema = 'labview-benchmark-actor/reviewer-raw-index@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  vmName = $VmName
  candidateSha256 = $raw.candidate.sha256
  files = $files
} | ConvertTo-Json -Depth 10
