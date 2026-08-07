[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^TC-\d{2}$')][string]$CaseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]+$')][string]$Label,
  [string]$CacheRoot = 'D:\lba-vagrant-instances\actor-reviewer-local'
)

$ErrorActionPreference = 'Stop'
$metadata = Get-Content (Join-Path $CacheRoot 'reviewer-cache-session.json') -Raw | ConvertFrom-Json
if (-not $metadata.PSObject.Properties['activeResume']) { throw 'No active reviewer-gate resume owns the VM.' }
$lock = Get-Content (Join-Path $CacheRoot '.reviewer-cache.lock') -Raw | ConvertFrom-Json
if ($lock.runId -ne $metadata.activeResume.runId -or $lock.vmName -ne $metadata.vm.name) {
  throw 'Reviewer screenshot lock ownership mismatch.'
}
$providerId = (Get-Content (Join-Path $metadata.vagrant.dotfilePath 'machines\default\virtualbox\id') -Raw).Trim()
$info = (& VBoxManage showvminfo $metadata.vm.name --machinereadable) -join "`n"
if (
  $providerId -ne $metadata.vm.uuid -or
  $info -notmatch "(?m)^UUID=`"$([regex]::Escape($metadata.vm.uuid))`"$" -or
  $info -notmatch "(?m)^hardwareuuid=`"$([regex]::Escape($metadata.vm.hardwareUuid))`"$" -or
  $info -notmatch '(?m)^VMState="running"$'
) {
  throw 'Reviewer screenshot target identity/state mismatch.'
}

$directory = Join-Path $metadata.activeResume.evidenceRoot 'screenshots'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$png = Join-Path $directory "$CaseId-$Label-$timestamp.png"
VBoxManage controlvm $providerId screenshotpng $png
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $png)) { throw 'VirtualBox screenshot capture failed.' }
$item = Get-Item $png
$receipt = [ordered]@{
  schema = 'labview-benchmark-actor/windows-reviewer-screenshot@1'
  caseId = $CaseId
  label = $Label
  wallTime = [DateTime]::UtcNow.ToString('o')
  vmName = $metadata.vm.name
  vmUuid = $metadata.vm.uuid
  hardwareUuid = $metadata.vm.hardwareUuid
  path = $item.FullName
  size = $item.Length
  sha256 = (Get-FileHash $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$json = [IO.Path]::ChangeExtension($png, '.json')
$receipt | ConvertTo-Json -Depth 8 | Set-Content $json
$receipt | ConvertTo-Json -Compress
