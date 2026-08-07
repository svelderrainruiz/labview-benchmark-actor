[CmdletBinding()]
param(
  [string]$CacheRoot = 'D:\lba-vagrant-instances\actor-reviewer-local',
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f-]{36}$')][string]$ConfirmVmUuid,
  [Parameter(Mandatory = $true)][switch]$DiscardActivation
)

$ErrorActionPreference = 'Stop'
if (-not $DiscardActivation) { throw 'Destruction requires explicit -DiscardActivation.' }
$metadataPath = Join-Path $CacheRoot 'reviewer-cache-session.json'
if (-not (Test-Path $metadataPath)) { throw 'Reviewer cache metadata is missing.' }
$metadata = Get-Content $metadataPath -Raw | ConvertFrom-Json
if (
  $metadata.vm.uuid -ne $ConfirmVmUuid -or
  -not $metadata.vm.name -or
  $metadata.vm.hardwareUuid -ne $ConfirmVmUuid
) {
  throw 'Reviewer cache identity does not match the explicit destroy confirmation.'
}
$providerIdPath = Join-Path $metadata.vagrant.dotfilePath 'machines\default\virtualbox\id'
if (-not (Test-Path $providerIdPath) -or (Get-Content $providerIdPath -Raw).Trim() -ne $ConfirmVmUuid) {
  throw 'Persisted Vagrant provider UUID does not match the destroy confirmation.'
}
$info = (& VBoxManage showvminfo $metadata.vm.name --machinereadable) -join "`n"
if (
  $info -notmatch "(?m)^UUID=`"$([regex]::Escape($ConfirmVmUuid))`"$" -or
  $info -notmatch "(?m)^hardwareuuid=`"$([regex]::Escape($ConfirmVmUuid))`"$"
) {
  throw 'Live VirtualBox identity does not match the destroy confirmation.'
}
$env:VAGRANT_HOME = $metadata.vagrant.home
$env:VAGRANT_CWD = $metadata.vagrant.cwd
$env:VAGRANT_DOTFILE_PATH = $metadata.vagrant.dotfilePath
$env:LBA_VM_NAME = $metadata.vm.name
$env:LBA_VM_HOSTNAME = $metadata.vm.hostname
$env:VIHS_REVIEWER_BOX = $metadata.vagrant.box
vagrant destroy default -f
if ($LASTEXITCODE) { exit $LASTEXITCODE }
if ((& VBoxManage list vms) -match [regex]::Escape($ConfirmVmUuid)) {
  throw 'Reviewer VM still exists after Vagrant destroy.'
}
Remove-Item -LiteralPath $CacheRoot -Recurse -Force
Write-Host "Destroyed retained reviewer VM '$ConfirmVmUuid'; VM-specific activation was discarded."
