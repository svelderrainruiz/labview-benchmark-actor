#requires -Version 5
<#+
.SYNOPSIS
  Content-bound local lifecycle for Ubuntu mesh actors.

.DESCRIPTION
  Implements -Plan, -VerifyReceipt, -Apply, and -Replace. Receipts contain only
  public topology and provisioning fingerprints, never registry credentials.
#>
[CmdletBinding()]
param(
  [ValidateSet('vmware_desktop', 'virtualbox')]
  [string]$Provider = 'vmware_desktop',
  [switch]$Plan,
  [switch]$Apply,
  [switch]$Replace,
  [switch]$VerifyReceipt,
  [switch]$SelfTest,
  [ValidateRange(5, 300)]
  [int]$MeshProofTimeoutSec = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$meshRoot = $PSScriptRoot
$cleanroomRoot = Split-Path -Parent $meshRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $cleanroomRoot)
$registryPath = Join-Path $cleanroomRoot 'mesh-actors.csv'
$manifestPath = Join-Path $cleanroomRoot 'cleanroom-manifest.json'
$vagrantfilePath = Join-Path $meshRoot 'Vagrantfile'
$provisionerPath = Join-Path $cleanroomRoot 'provision-lbabus-fromsource.sh'
$meshWorkerPath = Join-Path $repoRoot 'tools\collab-cli\ci\mesh-actor.sh'
$receiptPath = Join-Path $meshRoot '.vagrant\provision-cycle-receipt.json'
$receiptSchema = 'labview-benchmark-actor/mesh-provision-cycle@2'

function Get-Sha256Text {
  param([Parameter(Mandatory = $true)][string]$Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) }
  finally { $sha.Dispose() }
}

function Get-Sha256File {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "missing required input: $Path" }
  return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash).ToLowerInvariant()
}

function ConvertTo-CompactJson {
  param([Parameter(Mandatory = $true)]$Value, [int]$Depth = 8)
  return ($Value | ConvertTo-Json -Depth $Depth -Compress)
}

function Write-AtomicUtf8Json {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporaryPath = Join-Path $directory ([System.IO.Path]::GetRandomFileName())
  $backupPath = Join-Path $directory ([System.IO.Path]::GetRandomFileName())
  $encoding = New-Object System.Text.UTF8Encoding($false)
  try {
    [System.IO.File]::WriteAllText($temporaryPath, (ConvertTo-CompactJson -Value $Value -Depth 10), $encoding)
    if (Test-Path -LiteralPath $Path -PathType Leaf) { [System.IO.File]::Replace($temporaryPath, $Path, $backupPath) }
    else { [System.IO.File]::Move($temporaryPath, $Path) }
  } finally {
    Remove-Item -LiteralPath $temporaryPath, $backupPath -Force -ErrorAction SilentlyContinue
  }
}

function Get-ObjectProperty {
  param([Parameter(Mandatory = $true)]$Object, [Parameter(Mandatory = $true)][string]$Name)
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { throw "missing required property: $Name" }
  return $property.Value
}

function Invoke-Vagrant {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & vagrant @Arguments
  if ($LASTEXITCODE -ne 0) { throw "vagrant $($Arguments -join ' ') exited $LASTEXITCODE" }
}

function Read-ActorRegistry {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "missing local actor registry: $Path" }
  $raw = (Get-Content -LiteralPath $Path -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
  $lines = $raw -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and -not $_.TrimStart().StartsWith('#') }
  $actors = @($lines | ConvertFrom-Csv | Where-Object role -eq 'mesh')
  if ($actors.Count -lt 2) { throw 'at least two role=mesh actors are required for a cross-actor mesh proof' }
  return $actors
}

function Get-NormalizedTopology {
  param(
    [Parameter(Mandatory = $true)][object[]]$Actors,
    [Parameter(Mandatory = $true)][string]$IdField,
    [Parameter(Mandatory = $true)][string]$TcpField,
    [Parameter(Mandatory = $true)][string]$UdpField,
    [Parameter(Mandatory = $true)][string]$NodeTypeField
  )
  $normalized = @()
  foreach ($actor in $Actors) {
    $actorId = [string](Get-ObjectProperty -Object $actor -Name $IdField)
    $hostname = ([string](Get-ObjectProperty -Object $actor -Name 'hostname')).Trim().ToLowerInvariant()
    $ip = ([string](Get-ObjectProperty -Object $actor -Name 'ip')).Trim()
    $nodeType = ([string](Get-ObjectProperty -Object $actor -Name $NodeTypeField)).Trim().ToLowerInvariant()
    $tcpPort = 0; $udpPort = 0
    if (-not [int]::TryParse([string](Get-ObjectProperty -Object $actor -Name $TcpField), [ref]$tcpPort)) { throw "actor $hostname has invalid $TcpField" }
    if (-not [int]::TryParse([string](Get-ObjectProperty -Object $actor -Name $UdpField), [ref]$udpPort)) { throw "actor $hostname has invalid $UdpField" }
    $normalized += [pscustomobject][ordered]@{ actorId = $actorId; hostname = $hostname; ip = $ip; tcpPort = $tcpPort; udpPort = $udpPort; nodeType = $nodeType }
  }
  return @($normalized | Sort-Object actorId, hostname)
}

function Assert-ActorTopology {
  param([Parameter(Mandatory = $true)][object[]]$Actors)
  $names = @{}; $ids = @{}; $ips = @{}; $tcpEndpoints = @{}; $udpEndpoints = @{}; $emitters = 0; $listeners = 0
  foreach ($actor in $Actors) {
    foreach ($field in @('actor_id', 'hostname', 'username', 'ip', 'tcp_port', 'udp_port', 'node_type')) {
      if ([string]::IsNullOrWhiteSpace([string]$actor.$field)) { throw "mesh actor has an empty $field" }
    }
    if ($names.ContainsKey($actor.hostname) -or $ids.ContainsKey($actor.actor_id) -or $ips.ContainsKey($actor.ip)) { throw 'mesh actor hostname, actor_id, and IP values must each be unique' }
    $nodeType = ([string]$actor.node_type).Trim().ToLowerInvariant()
    if ($nodeType -notin @('source', 'sink', 'both')) { throw "mesh actor $($actor.hostname) has invalid node_type '$($actor.node_type)'" }
    $names[$actor.hostname] = $true; $ids[$actor.actor_id] = $true; $ips[$actor.ip] = $true
    foreach ($portSpec in @(@('tcp_port', $tcpEndpoints), @('udp_port', $udpEndpoints))) {
      $port = 0; $field = [string]$portSpec[0]; $endpoints = $portSpec[1]
      if (-not [int]::TryParse([string]$actor.$field, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw "mesh actor $($actor.hostname) has invalid $field '$($actor.$field)'" }
      $endpoint = "$($actor.ip):$port"
      if ($endpoints.ContainsKey($endpoint)) { throw "$field collision: $($endpoints[$endpoint]) and $($actor.hostname) declare $endpoint" }
      $endpoints[$endpoint] = $actor.hostname
    }
    if ($nodeType -in @('source', 'both')) { $emitters++ }
    if ($nodeType -in @('sink', 'both')) { $listeners++ }
  }
  if ($emitters -eq 0 -or $listeners -eq 0) { throw 'mesh topology needs at least one emitter and one listener' }
}

function Get-MeshSuccessMarker {
  param([Parameter(Mandatory = $true)][string]$NodeType)
  if ($NodeType -eq 'source') { return 'MESH OK (source)' }
  return 'MESH OK (TCP+UDP)'
}

function Get-InputState {
  param([Parameter(Mandatory = $true)][object[]]$Actors, [Parameter(Mandatory = $true)][string]$SourceRef)
  $topology = Get-NormalizedTopology -Actors $Actors -IdField 'actor_id' -TcpField 'tcp_port' -UdpField 'udp_port' -NodeTypeField 'node_type'
  return [pscustomobject][ordered]@{
    sourceRef = $SourceRef
    topologyHash = Get-Sha256Text -Text (ConvertTo-CompactJson -Value $topology -Depth 4)
    registryHash = Get-Sha256File -Path $registryPath
    vagrantfileHash = Get-Sha256File -Path $vagrantfilePath
    provisionerHash = Get-Sha256File -Path $provisionerPath
    meshWorkerHash = Get-Sha256File -Path $meshWorkerPath
    topology = $topology
  }
}

function Get-ReceiptCanonicalView {
  param([Parameter(Mandatory = $true)]$Receipt)
  $actors = @($Receipt.actors | ForEach-Object {
    [pscustomobject][ordered]@{
      actorId = [string]$_.actorId; hostname = [string]$_.hostname; ip = [string]$_.ip
      tcpPort = [int]$_.tcpPort; udpPort = [int]$_.udpPort; nodeType = [string]$_.nodeType
      lbabusVersion = [string]$_.lbabusVersion; meshMarker = [string]$_.meshMarker; verification = [string]$_.verification
    }
  } | Sort-Object actorId, hostname)
  return [ordered]@{
    schema = [string]$Receipt.schema; outcome = [string]$Receipt.outcome; provider = [string]$Receipt.provider
    sourceRef = [string]$Receipt.sourceRef; action = [string]$Receipt.action
    inputs = [ordered]@{
      topologyHash = [string]$Receipt.inputs.topologyHash; registryHash = [string]$Receipt.inputs.registryHash
      vagrantfileHash = [string]$Receipt.inputs.vagrantfileHash; provisionerHash = [string]$Receipt.inputs.provisionerHash
      meshWorkerHash = [string]$Receipt.inputs.meshWorkerHash
    }
    actors = $actors
  }
}

function Get-ReceiptDigest {
  param([Parameter(Mandatory = $true)]$Receipt)
  return Get-Sha256Text -Text (ConvertTo-CompactJson -Value (Get-ReceiptCanonicalView -Receipt $Receipt) -Depth 8)
}

function Read-ValidatedReceipt {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ valid = $false; receipt = $null; findings = @('receipt is missing') } }
  try { $receipt = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { return [pscustomobject]@{ valid = $false; receipt = $null; findings = @('receipt JSON is unreadable') } }
  $findings = @()
  try {
    $allowedRoot = @('schema', 'outcome', 'provider', 'sourceRef', 'action', 'completedAt', 'inputs', 'actors', 'digest')
    $actualRoot = @($receipt.PSObject.Properties.Name)
    $missingRoot = @($allowedRoot | Where-Object { $actualRoot -notcontains $_ })
    $unexpectedRoot = @($actualRoot | Where-Object { $allowedRoot -notcontains $_ })
    if ($missingRoot.Count -gt 0 -or $unexpectedRoot.Count -gt 0) { throw "receipt fields are invalid (missing=$($missingRoot -join ',') unexpected=$($unexpectedRoot -join ','))" }
    if ([string]$receipt.schema -ne $receiptSchema) { throw "receipt schema must be $receiptSchema" }
    if ([string]$receipt.outcome -ne 'success') { throw 'receipt outcome is not success' }
    if ([string]$receipt.action -notin @('replace', 'apply-refresh', 'apply-verify')) { throw 'receipt action is unsupported' }
    if ([string]$receipt.sourceRef -notmatch '^collab-cli-v\d+\.\d+\.\d+$') { throw 'receipt sourceRef is invalid' }
    if ([string]$receipt.digest -notmatch '^[a-f0-9]{64}$') { throw 'receipt digest is not a lowercase SHA-256' }
    $allowedInputs = @('topologyHash', 'registryHash', 'vagrantfileHash', 'provisionerHash', 'meshWorkerHash')
    $actualInputs = @($receipt.inputs.PSObject.Properties.Name)
    if (@($allowedInputs | Where-Object { $actualInputs -notcontains $_ }).Count -gt 0 -or @($actualInputs | Where-Object { $allowedInputs -notcontains $_ }).Count -gt 0) { throw 'receipt input fingerprint fields are invalid' }
    foreach ($name in $allowedInputs) { if ([string]$receipt.inputs.$name -notmatch '^[a-f0-9]{64}$') { throw "receipt inputs.$name is not a lowercase SHA-256" } }
    $proofs = @($receipt.actors)
    if ($proofs.Count -lt 2) { throw 'receipt has fewer than two actor proofs' }
    $allowedActor = @('actorId', 'hostname', 'ip', 'tcpPort', 'udpPort', 'nodeType', 'lbabusVersion', 'meshMarker', 'verification')
    foreach ($proof in $proofs) {
      $actualActor = @($proof.PSObject.Properties.Name)
      if (@($allowedActor | Where-Object { $actualActor -notcontains $_ }).Count -gt 0 -or @($allowedActor | Where-Object { $actualActor -notcontains $_ }).Count -gt 0) { throw 'receipt actor proof fields are invalid' }
      if ([string]$proof.nodeType -notin @('source', 'sink', 'both')) { throw "receipt actor $($proof.hostname) has invalid nodeType" }
      if ([string]$proof.lbabusVersion -ne ([string]$receipt.sourceRef).Substring(12)) { throw "receipt actor $($proof.hostname) has inconsistent lbabusVersion" }
      if ([string]$proof.meshMarker -ne (Get-MeshSuccessMarker -NodeType ([string]$proof.nodeType))) { throw "receipt actor $($proof.hostname) has inconsistent meshMarker" }
      if ([string]$proof.verification -ne "lbabus=$($proof.lbabusVersion) nodeType=$($proof.nodeType) meshProof=ok") { throw "receipt actor $($proof.hostname) has malformed verification" }
    }
    $proofTopology = Get-Sha256Text -Text (ConvertTo-CompactJson -Value (Get-NormalizedTopology -Actors $proofs -IdField 'actorId' -TcpField 'tcpPort' -UdpField 'udpPort' -NodeTypeField 'nodeType') -Depth 4)
    if ($proofTopology -ne [string]$receipt.inputs.topologyHash) { throw 'receipt actor proofs do not match receipt topology hash' }
    if ([string]$receipt.digest -ne (Get-ReceiptDigest -Receipt $receipt)) { throw 'receipt digest does not match canonical content' }
  } catch { $findings += $_.Exception.Message }
  return [pscustomobject]@{ valid = ($findings.Count -eq 0); receipt = $receipt; findings = $findings }
}

function Get-DriftClassification {
  param([Parameter(Mandatory = $true)]$Receipt, [Parameter(Mandatory = $true)]$Inputs, [Parameter(Mandatory = $true)][string]$Provider)
  $destructive = @(); $refresh = @()
  if ([string]$Receipt.provider -ne $Provider) { $destructive += 'provider' }
  if ([string]$Receipt.inputs.topologyHash -ne [string]$Inputs.topologyHash) { $destructive += 'topology' }
  if ([string]$Receipt.inputs.vagrantfileHash -ne [string]$Inputs.vagrantfileHash) { $destructive += 'Vagrantfile' }
  if ([string]$Receipt.sourceRef -ne [string]$Inputs.sourceRef) { $refresh += 'sourceRef' }
  foreach ($name in @('registryHash', 'provisionerHash', 'meshWorkerHash')) { if ([string]$Receipt.inputs.$name -ne [string]$Inputs.$name) { $refresh += $name } }
  $kind = if ($destructive.Count -gt 0) { 'replace-required' } elseif ($refresh.Count -gt 0) { 'apply-refresh' } else { 'apply-verify' }
  return [pscustomobject]@{ kind = $kind; destructive = $destructive; refresh = $refresh }
}

function Get-GuestProofs {
  param(
    [Parameter(Mandatory = $true)][object[]]$Actors,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][int]$TimeoutSec,
    [Parameter(Mandatory = $true)][string]$Action
  )
  $proofs = @()
  foreach ($actor in $Actors) {
    $nodeType = ([string]$actor.node_type).Trim().ToLowerInvariant()
    $marker = Get-MeshSuccessMarker -NodeType $nodeType
    $guestCheck = (@'
set -e
started="$(date +%s)"
test ! -e /tmp/lba-{0}.credential
test "$(/usr/local/bin/lbabus version)" = "{1}"
test "$(systemctl show -p ActiveState --value lba-gate-suite.service)" = active
grep -Fx 'NODE_TYPE={2}' /etc/lba-mesh-actor >/dev/null
systemctl show -p Environment --value lba-mesh.service | tr ' ' '\n' | grep -Fx 'NODE_TYPE={2}' >/dev/null
sudo systemctl restart --no-block lba-mesh.service
timeout {3} sh -c 'until journalctl -u lba-mesh.service --no-pager --since "@$1" | grep -Fq "{4}"; do sleep 1; done' sh "$started"
printf 'lbabus=%s nodeType={2} meshProof=ok\n' "$(/usr/local/bin/lbabus version)"
'@ -f $actor.hostname, $ExpectedVersion, $nodeType, $TimeoutSec, $marker).Replace("`r`n", "`n")
    $guestOutput = & vagrant ssh ([string]$actor.hostname) '-c' $guestCheck
    if ($LASTEXITCODE -ne 0) { throw "guest verification failed for $($actor.hostname) during $Action" }
    $verification = (($guestOutput | Out-String).Trim())
    $expectedVerification = "lbabus=$ExpectedVersion nodeType=$nodeType meshProof=ok"
    if ($verification -ne $expectedVerification) { throw "guest verification output is not canonical for $($actor.hostname)" }
    $proofs += [pscustomobject][ordered]@{
      actorId = [string]$actor.actor_id; hostname = ([string]$actor.hostname).Trim().ToLowerInvariant(); ip = ([string]$actor.ip).Trim()
      tcpPort = [int]$actor.tcp_port; udpPort = [int]$actor.udp_port; nodeType = $nodeType; lbabusVersion = $ExpectedVersion
      meshMarker = $marker; verification = $verification
    }
  }
  return $proofs
}

function New-Receipt {
  param(
    [Parameter(Mandatory = $true)][string]$Action,
    [Parameter(Mandatory = $true)]$Inputs,
    [Parameter(Mandatory = $true)][object[]]$ActorProofs,
    [Parameter(Mandatory = $true)][string]$Provider
  )
  $receipt = [pscustomobject][ordered]@{
    schema = $receiptSchema; outcome = 'success'; provider = $Provider; sourceRef = [string]$Inputs.sourceRef; action = $Action
    completedAt = [DateTime]::UtcNow.ToString('o')
    inputs = [pscustomobject][ordered]@{
      topologyHash = [string]$Inputs.topologyHash; registryHash = [string]$Inputs.registryHash; vagrantfileHash = [string]$Inputs.vagrantfileHash
      provisionerHash = [string]$Inputs.provisionerHash; meshWorkerHash = [string]$Inputs.meshWorkerHash
    }
    actors = @($ActorProofs | Sort-Object actorId, hostname)
    digest = ''
  }
  $receipt.digest = Get-ReceiptDigest -Receipt $receipt
  return $receipt
}

if ($SelfTest) {
  $hashA = ('a' * 64) -join ''; $hashB = ('b' * 64) -join ''; $version = '0.15.0'
  $proofs = @(
    [pscustomobject][ordered]@{ actorId = '1'; hostname = 'actor1'; ip = '192.168.56.11'; tcpPort = 7420; udpPort = 7421; nodeType = 'both'; lbabusVersion = $version; meshMarker = 'MESH OK (TCP+UDP)'; verification = "lbabus=$version nodeType=both meshProof=ok" },
    [pscustomobject][ordered]@{ actorId = '2'; hostname = 'actor2'; ip = '192.168.56.12'; tcpPort = 7420; udpPort = 7421; nodeType = 'both'; lbabusVersion = $version; meshMarker = 'MESH OK (TCP+UDP)'; verification = "lbabus=$version nodeType=both meshProof=ok" }
  )
  $topology = Get-NormalizedTopology -Actors $proofs -IdField 'actorId' -TcpField 'tcpPort' -UdpField 'udpPort' -NodeTypeField 'nodeType'
  $inputs = [pscustomobject][ordered]@{ sourceRef = "collab-cli-v$version"; topologyHash = Get-Sha256Text -Text (ConvertTo-CompactJson -Value $topology -Depth 4); registryHash = $hashA; vagrantfileHash = $hashA; provisionerHash = $hashA; meshWorkerHash = $hashA }
  $receipt = New-Receipt -Action 'apply-verify' -Inputs $inputs -ActorProofs $proofs -Provider 'vmware_desktop'
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lba-mesh-cycle-" + [Guid]::NewGuid().ToString('N'))
  $tempReceipt = Join-Path $tempRoot 'receipt.json'
  try {
    Write-AtomicUtf8Json -Path $tempReceipt -Value $receipt
    $validated = Read-ValidatedReceipt -Path $tempReceipt
    if (-not $validated.valid) { throw "self-test receipt must validate: $($validated.findings -join '; ')" }
    if ((Get-DriftClassification -Receipt $receipt -Inputs $inputs -Provider 'vmware_desktop').kind -ne 'apply-verify') { throw 'self-test expected apply-verify' }
    $refreshInputs = [pscustomobject][ordered]@{ sourceRef = 'collab-cli-v0.15.1'; topologyHash = $inputs.topologyHash; registryHash = $inputs.registryHash; vagrantfileHash = $inputs.vagrantfileHash; provisionerHash = $inputs.provisionerHash; meshWorkerHash = $inputs.meshWorkerHash }
    if ((Get-DriftClassification -Receipt $receipt -Inputs $refreshInputs -Provider 'vmware_desktop').kind -ne 'apply-refresh') { throw 'self-test expected apply-refresh' }
    $replaceInputs = [pscustomobject][ordered]@{ sourceRef = $inputs.sourceRef; topologyHash = $hashB; registryHash = $inputs.registryHash; vagrantfileHash = $inputs.vagrantfileHash; provisionerHash = $inputs.provisionerHash; meshWorkerHash = $inputs.meshWorkerHash }
    if ((Get-DriftClassification -Receipt $receipt -Inputs $replaceInputs -Provider 'vmware_desktop').kind -ne 'replace-required') { throw 'self-test expected replace-required' }
    $tampered = Get-Content -LiteralPath $tempReceipt -Raw | ConvertFrom-Json
    $tampered.digest = $hashB
    [System.IO.File]::WriteAllText($tempReceipt, (ConvertTo-CompactJson -Value $tampered -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
    if ((Read-ValidatedReceipt -Path $tempReceipt).valid) { throw 'self-test expected tampered receipt rejection' }
    Write-Output 'mesh provision cycle self-test passed: canonical receipt, tamper rejection, and drift classification'
  } finally { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
  return
}

$modes = @()
if ($Plan) { $modes += 'plan' }
if ($Apply) { $modes += 'apply' }
if ($Replace) { $modes += 'replace' }
if ($VerifyReceipt) { $modes += 'verify' }
if ($modes.Count -ne 1) { throw 'choose exactly one mode: -Plan, -Apply, -Replace, or -VerifyReceipt' }

$actors = Read-ActorRegistry -Path $registryPath
Assert-ActorTopology -Actors $actors
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$sourceRef = [string]$manifest.lbabus.source_ref
if ($sourceRef -notmatch '^collab-cli-v(\d+\.\d+\.\d+)$') { throw "cleanroom manifest has invalid lbabus.source_ref '$sourceRef'" }
$expectedVersion = $Matches[1]
$inputs = Get-InputState -Actors $actors -SourceRef $sourceRef
$prior = Read-ValidatedReceipt -Path $receiptPath
$drift = if ($prior.valid) { Get-DriftClassification -Receipt $prior.receipt -Inputs $inputs -Provider $Provider } else { [pscustomobject]@{ kind = 'replace-required'; destructive = @('receipt'); refresh = @() } }

if ($VerifyReceipt) {
  if (-not $prior.valid) { throw ("receipt verification failed: {0}" -f ($prior.findings -join '; ')) }
  if ($drift.kind -ne 'apply-verify') { throw ("receipt inputs drifted; {0} required" -f $drift.kind) }
  Write-Output 'receipt verification passed: schema, digest, and current inputs match; no VMs were changed'
  return
}

Push-Location $meshRoot
try {
  Invoke-Vagrant -Arguments @('validate')
  $planSummary = $actors | ForEach-Object { [pscustomobject]@{ actorId = [string]$_.actor_id; hostname = ([string]$_.hostname).Trim().ToLowerInvariant(); ip = ([string]$_.ip).Trim(); nodeType = ([string]$_.node_type).Trim().ToLowerInvariant() } }
  Write-Output ("mesh preflight: provider={0} lbabus={1} actors={2} proposed={3}" -f $Provider, $expectedVersion, $actors.Count, $drift.kind)
  $planSummary | Format-Table -AutoSize | Out-Host
  if ($Plan) {
    if (-not $prior.valid) { Write-Output ("receipt status: invalid; {0}" -f ($prior.findings -join '; ')) }
    elseif ($drift.destructive.Count -gt 0) { Write-Output ("replace required: {0}" -f ($drift.destructive -join ', ')) }
    elseif ($drift.refresh.Count -gt 0) { Write-Output ("safe refresh available: {0}" -f ($drift.refresh -join ', ')) }
    else { Write-Output 'apply-verify available: current receipt and inputs match' }
    Write-Output 'plan complete: no VMs were changed'
    return
  }
  $action = ''
  if ($Replace) {
    $action = 'replace'; Write-Output 'replace: destroying and rebuilding only currently declared mesh actors'
    foreach ($actor in $actors) { Invoke-Vagrant -Arguments @('destroy', '-f', [string]$actor.hostname) }
    foreach ($actor in $actors) { Invoke-Vagrant -Arguments @('up', [string]$actor.hostname, '--provider', $Provider) }
  } elseif ($Apply) {
    if (-not $prior.valid) { throw ("-Apply requires -Replace: {0}" -f ($prior.findings -join '; ')) }
    if ($drift.kind -eq 'replace-required') { throw ("-Apply requires -Replace because of: {0}" -f ($drift.destructive -join ', ')) }
    if ($drift.kind -eq 'apply-refresh') {
      $action = 'apply-refresh'; Write-Output ("apply-refresh: running vagrant up and provision for declared actors; drift={0}" -f ($drift.refresh -join ', '))
      foreach ($actor in $actors) { Invoke-Vagrant -Arguments @('up', [string]$actor.hostname, '--provider', $Provider); Invoke-Vagrant -Arguments @('provision', [string]$actor.hostname) }
    } else { $action = 'apply-verify'; Write-Output 'apply-verify: no destroy, up, or provision commands will run; proving current guests only' }
  } else { throw 'unreachable lifecycle mode' }
  $proofs = Get-GuestProofs -Actors $actors -ExpectedVersion $expectedVersion -TimeoutSec $MeshProofTimeoutSec -Action $action
  $receipt = New-Receipt -Action $action -Inputs $inputs -ActorProofs $proofs -Provider $Provider
  Write-AtomicUtf8Json -Path $receiptPath -Value $receipt
  Write-Output "mesh $action complete: $receiptPath"
} finally { Pop-Location }