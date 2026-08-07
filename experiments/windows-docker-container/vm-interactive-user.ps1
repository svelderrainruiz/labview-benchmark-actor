[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$explorer = @(
  Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" |
    ForEach-Object {
      $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
      [pscustomobject]@{
        processId = [int]$_.ProcessId
        sessionId = [int]$_.SessionId
        domain = $owner.Domain
        user = $owner.User
        returnValue = $owner.ReturnValue
      }
    }
)

[pscustomobject]@{
  schema = 'labview-benchmark-actor/windows-interactive-user@1'
  computerName = $env:COMPUTERNAME
  winrmIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
  explorer = $explorer
  queryUser = @(& "$env:SystemRoot\System32\query.exe" user 2>&1)
} | ConvertTo-Json -Depth 10 -Compress
