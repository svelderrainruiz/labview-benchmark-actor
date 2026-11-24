# Hyper-V reviewer driver

PowerShell steps that run the WIN-plane validate, release-stage, verdict and quorum steps against a reviewer guest
under Hyper-V (ADR-0094). They mirror the VirtualBox scripts one for one and produce the same artifacts. Windows
PowerShell 5.1 and PowerShell 7 both work.

## Prerequisites

- An elevated PowerShell on the Hyper-V host (Hyper-V cmdlets, firewall rules).
- The guest is running, has the Guest Service Interface enabled (`Enable-VMIntegrationService -VMName <vm> -Name 'Guest Service Interface'`), and has Node, npm and git.
- A guest credential, passed as `-Credential` (`Get-Credential`). It is never read from a file. The guest user defaults to the credential's account name; override with `-GuestUser`.
- `node` on the host, a checkout of the candidate (`-CandidateRepo`) and, for staging, the pinned `lbabus` win-x64 exe (`node scripts/fetch-lbabus.mjs binary --rid win-x64 --out <file>`). The script refuses an exe that does not match the pinned hash.
- Pass the VM with exactly one of `-VMId <guid>` or `-VMName <name>`.
- Add `-WhatIf` (alias of `-DryRun`) to print the ordered plan without touching Hyper-V, the firewall or the network.

Every guest call has a time bound and fails naming the step. Exit codes: 2 usage, 3 timeout, 4 guest, 5 gate, 6 host.

## Steps

| Script | Does | Gate field |
| --- | --- | --- |
| `win-plane-validate.ps1 -Branch release/X.Y.Z -CandidateRepo <dir> [-OutFile]` | bundle, ship, run the candidate validator in the guest, write the receipt | `winPlaneReady` is true and `head` is the branch tip |
| `release-stage-win.ps1 -Version -Commit -Vsix -Attestation -CandidateRepo -VisualKey -LbabusExe (-HostAddress or -SwitchName) [-TcpPort 7420] [-GuestAddress] [-Share] [-NoSetTarget] [-Force]` | stage, install, capture the DONE frame, record it, set the review target | `staged-frame-WIN-<version>.json` (`release-stage@1` DONE bound to the candidate) |
| `render-verdict.ps1 guard\|set-target\|collect` | guard the staged VSIX hash, set the target, collect the signed verdict | verdict JSON signed by the enrolled visual key |
| `render-quorum.ps1 stage\|sign\|collect\|verify\|all` | sign in the guest, collect, verify on the host | `verify-quorum-signoff.mjs` against the attestation and allowlist |

## Host address and firewall

The listener binds every interface, so `release-stage-win.ps1` opens an inbound rule scoped to the host address, its
interface, the port and (with `-GuestAddress`) the guest, and removes it when the step ends, also on failure.
Find the address the guest reaches with
`(Get-NetIPAddress -InterfaceAlias 'vEthernet (<switch>)' -AddressFamily IPv4).IPAddress`, or pass `-SwitchName`.
The step refuses to start when the port is already in use.

## Candidate checkout

Release evidence depends on the candidate's `release-components.json`, so the candidate validators and guest scripts
are read from `-CandidateRepo`, not from the checkout that holds this driver.
