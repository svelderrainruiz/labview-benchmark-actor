[CmdletBinding()]
param(
  [string]$ConfigPath = 'C:\ProgramData\lba-autonomous-actor\actor.json',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object Text.UTF8Encoding($false)
$RequestSchema = 'labview-benchmark-actor/autonomous-actor-request@1'
$ResponseSchema = 'labview-benchmark-actor/autonomous-actor-response@1'
$AttestationSchema = 'labview-benchmark-actor/acg-witness-attestation-v1'
$WorkloadId = 'labviewcli-known-answer-v1'

function ConvertTo-CanonicalJson {
  param($Value)
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [string]) { return ($Value | ConvertTo-Json -Compress) }
  if ($Value -is [bool]) { return $Value.ToString().ToLowerInvariant() }
  if ($Value -is [ValueType]) { return [Convert]::ToString($Value, [Globalization.CultureInfo]::InvariantCulture) }
  if ($Value -is [Collections.IDictionary]) {
    $parts = foreach ($key in @($Value.Keys | Sort-Object)) {
      "$(ConvertTo-CanonicalJson ([string]$key)):$(ConvertTo-CanonicalJson $Value[$key])"
    }
    return '{' + ($parts -join ',') + '}'
  }
  if ($Value -is [Collections.IEnumerable]) {
    $parts = foreach ($entry in $Value) { ConvertTo-CanonicalJson $entry }
    return '[' + ($parts -join ',') + ']'
  }
  $properties = [ordered]@{}
  foreach ($property in @($Value.PSObject.Properties | Sort-Object Name)) {
    $properties[$property.Name] = $property.Value
  }
  return ConvertTo-CanonicalJson $properties
}

function Get-Sha256Text {
  param([string]$Text)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try { $bytes = $sha256.ComputeHash($Utf8NoBom.GetBytes($Text)) }
  finally { $sha256.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-BundleDigest {
  param($Bundle)
  return Get-Sha256Text (ConvertTo-CanonicalJson $Bundle)
}

function Write-AtomicJson {
  param([string]$Path, $Value)
  $temporary = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($temporary, "$(ConvertTo-Json $Value -Depth 30)`n", $Utf8NoBom)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Write-ActorEvent {
  param([string]$Event, [string]$TaskId, [string]$Detail)
  $record = [ordered]@{ timestamp = [DateTime]::UtcNow.ToString('o'); event = $Event; taskId = $TaskId; detail = $Detail }
  [IO.File]::AppendAllText($Config.eventLogPath, "$(ConvertTo-Json $record -Compress)`n", $Utf8NoBom)
}

function Test-Ed25519Signature {
  param([string]$PublicKeyPem, [string]$Message, [string]$SignatureBase64)
  $temporary = Join-Path $Config.runtimeDir ([Guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $temporary -Force | Out-Null
  try {
    [IO.File]::WriteAllText((Join-Path $temporary 'public.pem'), $PublicKeyPem, $Utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $temporary 'message.txt'), $Message, $Utf8NoBom)
    [IO.File]::WriteAllBytes((Join-Path $temporary 'signature.bin'), [Convert]::FromBase64String($SignatureBase64))
    & $Config.opensslPath pkeyutl -verify -pubin -inkey (Join-Path $temporary 'public.pem') -rawin -in (Join-Path $temporary 'message.txt') -sigfile (Join-Path $temporary 'signature.bin') 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  } finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function New-Attestation {
  param($Bundle)
  $digest = Get-BundleDigest $Bundle
  $message = "$($Config.actorId)`n$digest"
  $temporary = Join-Path $Config.runtimeDir ([Guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $temporary -Force | Out-Null
  try {
    [IO.File]::WriteAllText((Join-Path $temporary 'message.txt'), $message, $Utf8NoBom)
    & $Config.opensslPath pkeyutl -sign -inkey $Config.privateKeyPath -rawin -in (Join-Path $temporary 'message.txt') -out (Join-Path $temporary 'signature.bin') 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Ed25519 signing failed' }
    $signature = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $temporary 'signature.bin')))
  } finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
  }
  return [ordered]@{
    schema = $AttestationSchema
    subject = [ordered]@{ digest = $digest; plane = $Bundle.plane; os = $null; sourceCommit = $null }
    witnessIdentity = $Config.actorId
    algorithm = 'ed25519'
    publicKeyPem = [IO.File]::ReadAllText($Config.publicKeyPath)
    signature = $signature
    signedAt = [DateTime]::UtcNow.ToString('o')
  }
}

function Test-Request {
  param($Envelope)
  $request = $Envelope.request
  if ($null -eq $request -or $request.schema -ne $RequestSchema) { return 'INVALID_SCHEMA' }
  if ($request.plane -ne 'WIN') { return 'WRONG_PLANE' }
  if ($request.workload.id -ne $WorkloadId) { return 'WORKLOAD_NOT_ALLOWED' }
  if ($request.candidate.sourceCommit -ne $Config.expectedCandidate.sourceCommit -or
      $request.candidate.sourceTree -ne $Config.expectedCandidate.sourceTree -or
      $request.candidate.bundleSha256 -ne $Config.expectedCandidate.bundleSha256) { return 'CANDIDATE_MISMATCH' }
  try {
    $issuedAt = [DateTime]::Parse($request.issuedAt).ToUniversalTime()
    $expiresAt = [DateTime]::Parse($request.expiresAt).ToUniversalTime()
  } catch { return 'INVALID_TIMESTAMP' }
  $now = [DateTime]::UtcNow
  if ($expiresAt -le $issuedAt -or ($expiresAt - $issuedAt).TotalMinutes -gt 15 -or $expiresAt -le $now -or $issuedAt -gt $now.AddMinutes(1)) { return 'EXPIRED' }
  if ([string]::IsNullOrWhiteSpace($request.requesterId) -or $request.nonce -notmatch '^[A-Za-z0-9_-]{16,128}$') { return 'INVALID_IDENTITY' }
  $replayKey = "$($request.requesterId):$($request.nonce)"
  if ($State.seenNonces -contains $replayKey) { return 'REPLAYED_NONCE' }
  $enrolledPem = $RequesterKeys.($request.requesterId)
  if ([string]::IsNullOrWhiteSpace($enrolledPem)) { return 'REQUESTER_NOT_ENROLLED' }
  $attestation = $Envelope.attestation
  $digest = Get-BundleDigest $request
  if ($attestation.schema -ne $AttestationSchema -or $attestation.algorithm -ne 'ed25519' -or
      $attestation.witnessIdentity -ne $request.requesterId -or $attestation.subject.digest -ne $digest -or
      (($attestation.publicKeyPem -replace '\s', '') -ne ($enrolledPem -replace '\s', ''))) { return 'INVALID_ATTESTATION' }
  if (-not (Test-Ed25519Signature $attestation.publicKeyPem "$($request.requesterId)`n$digest" $attestation.signature)) { return 'INVALID_SIGNATURE' }
  $State.seenNonces += $replayKey
  Write-AtomicJson $Config.statePath $State
  return $null
}

function Send-Response {
  param($Request, [string]$Status, $Result, $Failure, [DateTime]$StartedAt)
  $response = [ordered]@{
    schema = $ResponseSchema
    dispatchId = $Request.dispatchId
    taskId = $Request.taskId
    requestDigest = Get-BundleDigest $Request
    actorId = $Config.actorId
    plane = 'WIN'
    status = $Status
    startedAt = $StartedAt.ToUniversalTime().ToString('o')
    completedAt = [DateTime]::UtcNow.ToString('o')
    result = $Result
    artifacts = @()
    failure = $Failure
  }
  $envelope = [ordered]@{ response = $response; attestation = New-Attestation $response }
  Write-AtomicJson (Join-Path $Config.runtimeDir 'last-response.json') $envelope
  $messagePath = Join-Path $Config.runtimeDir "response-$([Guid]::NewGuid().ToString('n')).json"
  try {
    [IO.File]::WriteAllText($messagePath, "$(ConvertTo-Json $envelope -Depth 30 -Compress)`n", $Utf8NoBom)
    $type = if ($Status -eq 'SUCCESS' -or $Status -eq 'FAILED') { 'DONE' } else { 'ACK' }
    $env:VIHS_COLLAB_AGENT = $Config.actorId
    & $Config.lbabusPath net send --hosts $Config.controllerHost --tcp $Config.tcpPort --session $Config.session --type $type --task $Request.taskId --message-file $messagePath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'lbabus response send failed' }
    Write-ActorEvent 'response-sent' $Request.taskId $Status
  } finally {
    Remove-Item -LiteralPath $messagePath -Force -ErrorAction SilentlyContinue
  }
}

if ($SelfTest) {
  $fixture = '{"z":[3,{"b":true,"a":null}],"a":"line\nvalue","nested":{"two":2,"one":1}}' | ConvertFrom-Json
  $canonical = ConvertTo-CanonicalJson $fixture
  [ordered]@{ canonical = $canonical; digest = Get-Sha256Text $canonical } | ConvertTo-Json -Compress
  exit 0
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$Config | Add-Member -NotePropertyName eventLogPath -NotePropertyValue (Join-Path (Split-Path $Config.statePath) 'events.jsonl') -Force
New-Item -ItemType Directory -Path $Config.runtimeDir, (Split-Path $Config.logPath), (Split-Path $Config.statePath) -Force | Out-Null
$RequesterKeys = Get-Content -LiteralPath $Config.requesterKeysPath -Raw | ConvertFrom-Json
if (Test-Path -LiteralPath $Config.statePath) {
  $State = Get-Content -LiteralPath $Config.statePath -Raw | ConvertFrom-Json
} else {
  $State = [ordered]@{ seenNonces = @(); processedLines = 0 }
  Write-AtomicJson $Config.statePath $State
}

$env:VIHS_COLLAB_AGENT = $Config.actorId
$listenerStdout = Join-Path $Config.runtimeDir 'lbabus-listener.stdout.log'
$listenerStderr = Join-Path $Config.runtimeDir 'lbabus-listener.stderr.log'
$listener = Start-Process -FilePath $Config.lbabusPath -ArgumentList @('net','listen','--tcp',$Config.tcpPort,'--bind','0.0.0.0','--session',$Config.session,'--log',$Config.logPath) -WindowStyle Hidden -RedirectStandardOutput $listenerStdout -RedirectStandardError $listenerStderr -PassThru
try {
  while (-not $listener.HasExited) {
    $lines = if (Test-Path -LiteralPath $Config.logPath) { @(Get-Content -LiteralPath $Config.logPath) } else { @() }
    while ($State.processedLines -lt $lines.Count) {
      $line = $lines[$State.processedLines]
      $State.processedLines++
      Write-AtomicJson $Config.statePath $State
      try { $busEnvelope = $line | ConvertFrom-Json } catch { continue }
      if ($busEnvelope.schema -ne 'labview-benchmark-actor/bus-msg@1' -or $busEnvelope.type -ne 'CLAIM') { continue }
      try { $requestEnvelope = $busEnvelope.payload | ConvertFrom-Json } catch { continue }
      $request = $requestEnvelope.request
      if ($busEnvelope.task -ne $request.taskId -or $busEnvelope.senderId -ne $request.requesterId) { continue }
      $startedAt = [DateTime]::UtcNow
      $rejection = Test-Request $requestEnvelope
      if ($null -ne $rejection) {
        Write-ActorEvent 'request-rejected' $request.taskId $rejection
        Send-Response $request 'REJECTED' $null ([ordered]@{ code = $rejection; message = 'request rejected by local policy' }) $startedAt
        continue
      }
      Write-ActorEvent 'request-accepted' $request.taskId $WorkloadId
      try {
        $resultText = & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Config.workloadPath
        $result = $resultText | ConvertFrom-Json
        Send-Response $request 'SUCCESS' $result $null $startedAt
      } catch {
        Write-ActorEvent 'workload-failed' $request.taskId $_.Exception.Message.Substring(0, [Math]::Min(512, $_.Exception.Message.Length))
        Send-Response $request 'FAILED' $null ([ordered]@{ code = 'WORKLOAD_FAILED'; message = $_.Exception.Message.Substring(0, [Math]::Min(512, $_.Exception.Message.Length)) }) $startedAt
      }
    }
    Start-Sleep -Milliseconds 250
  }
  throw "lbabus listener exited with code $($listener.ExitCode)"
} finally {
  if (-not $listener.HasExited) { Stop-Process -Id $listener.Id -Force }
}