# LbaHyperV.psm1 -- the Hyper-V transport for the reviewer release steps. Windows PowerShell 5.1 and PowerShell 7.
#
# Every call that touches the guest is bounded: the work runs as a job, Wait-Job -Timeout waits for it, and a timeout
# stops the job and fails with a named reason (LBA_TIMEOUT). The caller passes the credential; nothing here reads one
# from a file, and no key material is copied. In dry-run mode (-DryRun, alias -WhatIf on the step scripts) no primitive
# touches Hyper-V, the firewall or the network: each one only records the step it would run, so the plan can be tested
# on a machine without a hypervisor.
Set-StrictMode -Version 2.0

$script:Plan = New-Object System.Collections.ArrayList
$script:DryRun = $false

# Exit codes the step scripts return through Invoke-LbaMain, keyed by the reason prefix of the thrown message.
$script:ExitCodes = @{ USAGE = 2; TIMEOUT = 3; GUEST = 4; GATE = 5; HOST = 6 }

function Start-LbaPlan {
  [CmdletBinding()] param([switch]$DryRun)
  $script:Plan.Clear()
  $script:DryRun = [bool]$DryRun
}

function Test-LbaDryRun { return $script:DryRun }

function Add-LbaStep {
  [CmdletBinding()] param([Parameter(Mandatory)][string]$Op, [string]$Target = '', [string]$Detail = '')
  [void]$script:Plan.Add([pscustomobject]@{ step = ($script:Plan.Count + 1); op = $Op; target = $Target; detail = $Detail })
}

function Get-LbaPlan { return , @($script:Plan.ToArray()) }

function Write-LbaPlan {
  [CmdletBinding()] param([Parameter(Mandatory)][string]$Title)
  if (-not $script:DryRun) { return }
  Write-Output "$Title (dry run, nothing was run):"
  foreach ($s in $script:Plan) {
    $tail = ''
    if ($s.detail) { $tail = ' :: ' + $s.detail }
    Write-Output ('  {0}. [{1}] {2}{3}' -f $s.step, $s.op, $s.target, $tail)
  }
  Write-Output ('LBA_PLAN_JSON=' + (ConvertTo-Json -InputObject @($script:Plan.ToArray()) -Compress -Depth 4))
}

# Runs a step script's body. A thrown "LBA_<REASON>: text" becomes "LBA_FAIL=<REASON>: text" on stderr and the exit code.
function Invoke-LbaMain {
  [CmdletBinding()] param([Parameter(Mandatory)][scriptblock]$Body)
  try { & $Body } catch {
    $m = $_.Exception.Message
    $reason = 'HOST'
    if ($m -match '^LBA_([A-Z]+):') { $reason = $Matches[1] }
    [Console]::Error.WriteLine("LBA_FAIL=$m")
    $code = 1
    if ($script:ExitCodes.ContainsKey($reason)) { $code = $script:ExitCodes[$reason] }
    exit $code
  }
}

function Assert-LbaArgument {
  [CmdletBinding()] param([bool]$Condition, [Parameter(Mandatory)][string]$Message)
  if (-not $Condition) { throw "LBA_USAGE: $Message" }
}

function Assert-LbaCredential {
  [CmdletBinding()] param([pscredential]$Credential)
  if (-not $script:DryRun) { Assert-LbaArgument ($null -ne $Credential) '-Credential is required (the caller supplies the guest credential)' }
}

# The guest account name without a domain or machine prefix.
function Get-LbaGuestUser {
  [CmdletBinding()] param([pscredential]$Credential, [string]$GuestUser)
  if ($GuestUser) { return $GuestUser }
  if ($null -ne $Credential) { return ($Credential.UserName -replace '^.*\\', '') }
  return 'vagrant'
}

function Resolve-LbaVmId {
  [CmdletBinding()] param([string]$VMId, [string]$VMName)
  Assert-LbaArgument ([bool]$VMId -ne [bool]$VMName) 'give exactly one of -VMId or -VMName'
  if ($VMId) {
    Assert-LbaArgument ($VMId -match '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') "-VMId must be a GUID, got $VMId"
    return $VMId.ToLowerInvariant()
  }
  if ($script:DryRun) { Add-LbaStep 'resolve-vm' $VMName 'Get-VM -Name (the id is read at run time)'; return "<id of VM $VMName>" }
  $vms = @(Get-VM -Name $VMName -ErrorAction Stop)
  if ($vms.Count -ne 1) { throw "LBA_USAGE: -VMName $VMName matches $($vms.Count) VMs; use -VMId" }
  return $vms[0].Id.ToString()
}

function Assert-LbaVmRunning {
  [CmdletBinding()] param([Parameter(Mandatory)][string]$VMId)
  Add-LbaStep 'check-vm' $VMId 'the VM is Running'
  if ($script:DryRun) { return }
  $vm = Get-VM -Id $VMId -ErrorAction Stop
  if ($vm.State -ne 'Running') { throw "LBA_GUEST: VM $VMId is $($vm.State), not Running; start it with Start-VM -Id $VMId" }
}

function Invoke-LbaJob {
  [CmdletBinding()] param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Start, [Parameter(Mandatory)][int]$TimeoutSec)
  $job = & $Start
  try {
    if (-not (Wait-Job -Job $job -Timeout $TimeoutSec)) {
      Stop-Job -Job $job
      throw "LBA_TIMEOUT: $Name did not finish within $TimeoutSec s; the job was stopped"
    }
    try { return @(Receive-Job -Job $job -ErrorAction Stop) } catch { throw "LBA_GUEST: $Name failed: $($_.Exception.Message)" }
  } finally { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
}

# Runs a script block in the guest over PowerShell Direct, addressed by VM id. -Describe is the command line shown in the plan.
function Invoke-LbaGuest {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$VMId, [pscredential]$Credential, [Parameter(Mandatory)][scriptblock]$ScriptBlock,
        [object[]]$ArgumentList = @(), [int]$TimeoutSec = 120, [string]$Describe = '')
  $detail = $Name
  if ($Describe) { $detail = "${Name}: $Describe" }
  Add-LbaStep 'guest-run' $VMId $detail
  if ($script:DryRun) { return @() }
  Assert-LbaCredential $Credential
  $start = { Invoke-Command -VMId $VMId -Credential $Credential -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList -AsJob }.GetNewClosure()
  return Invoke-LbaJob -Name $Name -TimeoutSec $TimeoutSec -Start $start
}

function Copy-LbaToGuest {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$VMId, [Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [int]$TimeoutSec = 300)
  Add-LbaStep 'copy-to-guest' $VMId "$Source -> $Destination"
  if ($script:DryRun) { return }
  if (-not (Test-Path -LiteralPath $Source)) { throw "LBA_HOST: $Source does not exist" }
  $start = {
    $vm = Get-VM -Id $VMId -ErrorAction Stop
    Copy-VMFile -VM $vm -SourcePath $Source -DestinationPath $Destination -CreateFullPath -FileSource Host -Force -AsJob
  }.GetNewClosure()
  [void](Invoke-LbaJob -Name "Copy-VMFile $Source" -TimeoutSec $TimeoutSec -Start $start)
}

# Copy-Item -FromSession over PowerShell Direct. The host file is removed first so a shorter file cannot keep a longer one's tail.
function Copy-LbaFromGuest {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$VMId, [pscredential]$Credential, [Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [int]$TimeoutSec = 120)
  Add-LbaStep 'copy-from-guest' $VMId "$Source -> $Destination"
  if ($script:DryRun) { return }
  Assert-LbaCredential $Credential
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  $start = {
    Start-Job -ArgumentList @($VMId, $Credential, $Source, $Destination) -ScriptBlock {
      param($id, $account, $src, $dst)
      $ErrorActionPreference = 'Stop'
      $session = New-PSSession -VMId $id -Credential $account
      try { Copy-Item -FromSession $session -LiteralPath $src -Destination $dst -Force } finally { Remove-PSSession $session }
    }
  }.GetNewClosure()
  [void](Invoke-LbaJob -Name "Copy-Item -FromSession $Source" -TimeoutSec $TimeoutSec -Start $start)
  if (-not (Test-Path -LiteralPath $Destination)) { throw "LBA_GUEST: $Source was not copied to $Destination" }
}

function Get-LbaGuestSha256 {
  [CmdletBinding()] param([Parameter(Mandatory)][string]$VMId, [pscredential]$Credential, [Parameter(Mandatory)][string]$Path, [int]$TimeoutSec = 120)
  $out = Invoke-LbaGuest -Name "sha256 of $Path" -VMId $VMId -Credential $Credential -TimeoutSec $TimeoutSec -ArgumentList @($Path) -Describe "Get-FileHash -Algorithm SHA256 '$Path'" -ScriptBlock {
    param($p)
    if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash }
  }
  if ($script:DryRun) { return '' }
  $m = [regex]::Match((($out | ForEach-Object { "$_" }) -join "`n"), '[0-9a-fA-F]{64}')
  if ($m.Success) { return $m.Value.ToLowerInvariant() }
  return ''
}

function Get-LbaHostSha256 {
  [CmdletBinding()] param([Parameter(Mandatory)][string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# Runs a host program and returns its output lines; a non-zero exit is a named failure. -Pure marks a side-effect-free
# program (the Node helpers that compute the plan) that also runs in dry-run; anything else is only recorded there.
function Invoke-LbaHost {
  [CmdletBinding()] param([Parameter(Mandatory)][string]$File, [string[]]$Arguments = @(), [switch]$Pure, [ValidateSet('HOST', 'GATE')][string]$FailAs = 'HOST')
  Add-LbaStep 'host-run' $File ($Arguments -join ' ')
  if ($script:DryRun -and -not $Pure) { return @() }
  $out = @(& $File @Arguments 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) { throw "LBA_${FailAs}: $File exited ${LASTEXITCODE}: $(($out | Select-Object -Last 3) -join ' | ')" }
  return $out
}

# The address the guest can reach on a Hyper-V virtual switch: the host's IPv4 address on its vEthernet adapter.
function Get-LbaSwitchAddress {
  [CmdletBinding()] param([Parameter(Mandatory)][string]$SwitchName)
  if ($script:DryRun) { return "<host address on vEthernet ($SwitchName)>" }
  $ip = @(Get-NetIPAddress -InterfaceAlias "vEthernet ($SwitchName)" -AddressFamily IPv4 -ErrorAction Stop)
  if ($ip.Count -lt 1) { throw "LBA_USAGE: no IPv4 address on vEthernet ($SwitchName); pass -HostAddress" }
  return $ip[0].IPAddress
}

function Resolve-LbaHostAddress {
  [CmdletBinding()] param([string]$HostAddress, [string]$SwitchName)
  if ($HostAddress) {
    Assert-LbaArgument ($HostAddress -match '^[A-Za-z0-9.:-]+$') "-HostAddress is not an address: $HostAddress"
    return $HostAddress
  }
  Assert-LbaArgument ([bool]$SwitchName) 'give -HostAddress (the address the guest reaches the host on) or -SwitchName (to read it from the vEthernet adapter)'
  return (Get-LbaSwitchAddress -SwitchName $SwitchName)
}

function Test-LbaPortInUse {
  [CmdletBinding()] param([Parameter(Mandatory)][int]$Port)
  if ($script:DryRun) { return $false }
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

# An inbound allow rule scoped to the host address, its interface, the port and (when known) the guest address.
function Open-LbaListener {
  [CmdletBinding()] param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$LocalAddress, [string]$RemoteAddress = '')
  $name = 'lba-stage-{0}-{1}' -f $Port, ([guid]::NewGuid().ToString('N').Substring(0, 8))
  $scope = "inbound tcp $Port on $LocalAddress"
  if ($RemoteAddress) { $scope = "$scope from $RemoteAddress" }
  Add-LbaStep 'firewall-open' 'lba-stage-rule' $scope
  if ($script:DryRun) { return $name }
  $alias = (Get-NetIPAddress -IPAddress $LocalAddress -ErrorAction Stop | Select-Object -First 1).InterfaceAlias
  $rule = @{ DisplayName = $name; Direction = 'Inbound'; Action = 'Allow'; Protocol = 'TCP'; LocalPort = $Port; LocalAddress = $LocalAddress; InterfaceAlias = $alias; Profile = 'Any' }
  if ($RemoteAddress) { $rule.RemoteAddress = $RemoteAddress }
  [void](New-NetFirewallRule @rule -ErrorAction Stop)
  return $name
}

function Close-LbaListener {
  [CmdletBinding()] param([string]$Name)
  if (-not $Name) { return }
  Add-LbaStep 'firewall-close' 'lba-stage-rule' 'remove the rule'
  if ($script:DryRun) { return }
  Remove-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
  if (Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue) { throw "LBA_HOST: firewall rule $Name is still present; remove it with Remove-NetFirewallRule -DisplayName $Name" }
}

# Starts the host listener (await-agent-reply.mjs over the pinned lbabus) and returns the process once it is bound.
function Start-LbaListener {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Node, [Parameter(Mandatory)][string]$Script, [Parameter(Mandatory)][string]$Lbabus,
        [Parameter(Mandatory)][string]$TaskId, [Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][int]$TimeoutSec,
        [Parameter(Mandatory)][string]$Out, [Parameter(Mandatory)][string]$LogDir)
  $arguments = @($Script, '--task', $TaskId, '--tcp', "$Port", '--timeout', "$TimeoutSec", '--type', 'DONE', '--out', $Out)
  Add-LbaStep 'listener-start' $Node (($arguments -join ' ') + " (LBABUS=$Lbabus)")
  if ($script:DryRun) { return $null }
  $err = Join-Path $LogDir 'listener.err'
  $previous = $env:LBABUS
  $env:LBABUS = $Lbabus
  try { $p = Start-Process -FilePath $Node -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardError $err -RedirectStandardOutput (Join-Path $LogDir 'listener.out') }
  finally { $env:LBABUS = $previous }
  $null = $p.Handle
  for ($i = 0; $i -lt 60; $i++) {
    if ($p.HasExited) { throw "LBA_HOST: the host listener exited early ($($p.ExitCode)): $(Get-Content -Raw -ErrorAction SilentlyContinue $err)" }
    if ((Test-Path $err) -and ((Get-Content -Raw $err) -match 'listening') -and (Test-LbaPortInUse -Port $Port)) { return $p }
    Start-Sleep -Milliseconds 250
  }
  Stop-LbaListener -Process $p
  throw "LBA_HOST: the host listener did not bind tcp $Port"
}

# taskkill /T also ends the lbabus child that holds the port; stopping only the Node wrapper would leave it listening.
function Stop-LbaListener {
  [CmdletBinding()] param($Process)
  Add-LbaStep 'listener-stop' 'listener' 'stop the listener and its lbabus child'
  if ($script:DryRun -or $null -eq $Process) { return }
  if (-not $Process.HasExited) { & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null }
}

# reviewed==shipped, then bind the review target: refuse unless the VSIX staged in the guest is byte-identical to the candidate.
function Set-LbaReviewTarget {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$VMId, [pscredential]$Credential, [Parameter(Mandatory)][string]$GuestUser, [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$Commit, [Parameter(Mandatory)][string]$VsixSha256, [string[]]$Evidence = @(),
        [Parameter(Mandatory)][string]$Node, [Parameter(Mandatory)][string]$ToolingRoot, [Parameter(Mandatory)][string]$CandidateRoot,
        [string]$Component = 'extension', [string]$GuestVsix = 'C:\lba-review\candidate.vsix')
  $staged = Get-LbaGuestSha256 -VMId $VMId -Credential $Credential -Path $GuestVsix
  $verify = @((Join-Path $CandidateRoot 'reviewer-workstation\verify-staged-vsix.mjs'), '--candidate-sha256', $VsixSha256, '--staged-sha256', $staged)
  if ($script:DryRun) { $verify[-1] = '<sha256 of the staged VSIX in the guest>' }
  elseif (-not $staged) { throw "LBA_GATE: no candidate VSIX is staged in the guest at $GuestVsix; stage it first" }
  [void](Invoke-LbaHost -File $Node -Arguments $verify -FailAs GATE)
  $handoff = "C:\Users\$GuestUser\AppData\Roaming\Code\User\globalStorage\svelderrainruiz.labview-benchmark-actor\handoff"
  $targetArgs = @((Join-Path $ToolingRoot 'reviewer-workstation\build-review-target.mjs'), '--component', $Component, '--version', $Version, '--commit', $Commit, '--vsix-sha256', $VsixSha256)
  foreach ($e in $Evidence) { $targetArgs += @('--evidence', $e) }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('lba-target-' + [guid]::NewGuid().ToString('N'))
  $file = Join-Path $tmp 'review-target.json'
  try {
    if (-not $script:DryRun) { New-Item -ItemType Directory -Force -Path $tmp | Out-Null }
    $json = Invoke-LbaHost -File $Node -Arguments $targetArgs -Pure
    if (-not $script:DryRun) { [IO.File]::WriteAllText($file, ($json -join "`n"), (New-Object Text.UTF8Encoding($false))) }
    [void](Invoke-LbaGuest -Name 'create the handoff directory' -VMId $VMId -Credential $Credential -ArgumentList @($handoff) -Describe "New-Item -ItemType Directory -Force '$handoff'" -ScriptBlock { param($d) New-Item -ItemType Directory -Force -Path $d | Out-Null })
    Copy-LbaToGuest -VMId $VMId -Source $file -Destination "$handoff\review-target.json"
  } finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp } }
}

Export-ModuleMember -Function Start-LbaPlan, Test-LbaDryRun, Add-LbaStep, Get-LbaPlan, Write-LbaPlan, Invoke-LbaMain, Assert-LbaArgument, Assert-LbaCredential,
  Get-LbaGuestUser, Resolve-LbaVmId, Assert-LbaVmRunning, Invoke-LbaJob, Invoke-LbaGuest, Copy-LbaToGuest, Copy-LbaFromGuest, Get-LbaGuestSha256,
  Get-LbaHostSha256, Invoke-LbaHost, Get-LbaSwitchAddress, Resolve-LbaHostAddress, Test-LbaPortInUse, Open-LbaListener, Close-LbaListener,
  Start-LbaListener, Stop-LbaListener, Set-LbaReviewTarget
