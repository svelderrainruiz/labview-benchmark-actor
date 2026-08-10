[CmdletBinding()]
param(
  [string]$LabVIEWCLI = 'C:\Program Files (x86)\National Instruments\Shared\LabVIEW CLI\LabVIEWCLI.exe',
  [string]$LabVIEWPath = 'C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe',
  [string]$VIPath = 'C:\ProgramData\lba-autonomous-actor\workloads\AddTwoNumbers.vi'
)

$ErrorActionPreference = 'Stop'
$started = [Diagnostics.Stopwatch]::StartNew()
$output = (& $LabVIEWCLI -LabVIEWPath $LabVIEWPath -OperationName RunVI -VIPath $VIPath 1 2 2>&1 | Out-String)
$exitCode = $LASTEXITCODE
$started.Stop()

$match = [regex]::Match($output, 'Operation output:\s*\r?\n\s*(-?\d+)')
$observed = if ($match.Success) { [int]$match.Groups[1].Value } else { $null }
$passed = $exitCode -eq 0 -and $observed -eq 3 -and $output -match 'RunVI operation succeeded\.'
if (-not $passed) {
  throw "known-answer workload failed (exit=$exitCode observed=$observed)"
}

$canonical = '{"operation":"AddTwoNumbers.vi","observed":3,"expected":3,"verdict":"PASS"}'
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $digestBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))
} finally {
  $sha256.Dispose()
}
$receiptDigest = -join ($digestBytes | ForEach-Object { $_.ToString('x2') })

[ordered]@{
  operation = 'AddTwoNumbers.vi'
  observed = $observed
  expected = 3
  verdict = 'PASS'
  receiptDigest = $receiptDigest
  wallMs = $started.ElapsedMilliseconds
} | ConvertTo-Json -Compress