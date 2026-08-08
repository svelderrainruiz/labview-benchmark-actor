[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = 'C:\lba-provision'
$readyPath = Join-Path $root 'interactive-agent-ready.json'
$pidPath = Join-Path $root 'interactive-agent.pid'
$triggerPath = Join-Path $root 'launch.go'
$diagnosticsPath = Join-Path $root 'launch-diagnostics.json'
$tightVnc = 'C:\Program Files\TightVNC\tvnserver.exe'

Remove-Item $readyPath, $triggerPath, $diagnosticsPath -Force -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($pidPath, "$PID", [Text.UTF8Encoding]::new($false))
$server = Start-Process -FilePath $tightVnc -ArgumentList '-run' -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(45)
do {
  Start-Sleep -Milliseconds 250
  $listener = Get-NetTCPConnection -State Listen -LocalPort 5900 -ErrorAction SilentlyContinue |
    Select-Object -First 1
} while (-not $listener -and [DateTime]::UtcNow -lt $deadline)
if (-not $listener) { throw 'Interactive login agent could not start TightVNC on port 5900.' }

$ready = [ordered]@{
  schema = 'labview-benchmark-actor/windows-vagrant-interactive-agent@1'
  wallTime = [DateTime]::UtcNow.ToString('o')
  processId = $PID
  sessionId = (Get-Process -Id $PID).SessionId
  user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  tightVncProcessId = $server.Id
  listener = [ordered]@{
    address = $listener.LocalAddress
    port = $listener.LocalPort
    owningProcess = $listener.OwningProcess
  }
}
[IO.File]::WriteAllText($readyPath, "$(ConvertTo-Json $ready -Depth 8 -Compress)`n", [Text.UTF8Encoding]::new($false))

while (-not (Test-Path -LiteralPath $triggerPath)) {
  Start-Sleep -Milliseconds 100
}
Remove-Item -LiteralPath $triggerPath -Force
& (Join-Path $root 'vm-launch.ps1') `
  -OutputPath $diagnosticsPath `
  -WindowTimeoutSeconds 90 `
  -DirectLaunch
