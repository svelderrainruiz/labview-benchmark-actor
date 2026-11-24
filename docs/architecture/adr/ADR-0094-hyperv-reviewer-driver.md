# ADR-0094: Drive a Hyper-V reviewer guest from a Windows host with the same protocol

- Status: Accepted
- Owner: WIN
- Traces to: LBA-REQ-057, LBA-REQ-069

## Context

The WIN-plane validate, release-stage, verdict and quorum steps had only a VirtualBox driver. A Windows host
running Hyper-V had no way to run them, so its operator would have had to improvise the transport.

## Decision

`reviewer-workstation/hyperv/` holds a PowerShell driver with the same four steps and the same artifacts and gate
fields as the VirtualBox scripts. Only the transport changes: PowerShell Direct (by VM id) and `Copy-VMFile` replace
`VBoxManage guestcontrol`. The guest credential is supplied by the caller and is never read from a file.

- Every guest call runs as a job with a time bound; on expiry the job is stopped and the step fails naming itself.
- The stage listener binds all interfaces, so an inbound firewall rule scoped to the host address, its interface,
  the port and the guest address is opened for the step and removed on success and on failure.
- The guest scripts, task id and evidence come from the code the VirtualBox driver uses
  (`stage-guest-scripts.mjs`, `build-review-target.mjs`); there is no second copy to drift.
- The host address is a parameter (no default); the VirtualBox default is unchanged.
- The pinned `lbabus` hash is checked on the host and again in the guest before it is used.
- Tooling runs from the driver's checkout; the candidate's `release-components.json`, version and VSIX come from
  `-CandidateRepo`. The evidence builders' import closure (listed in
  `tooling-compare.json`; release data files excluded with reasons) must be byte-equal in both or the step exits 2.
- Each driver checks for an elevated administrator or Hyper-V Administrators before the first `Get-VM` (not
  `#requires`, which would block `-WhatIf`); only IPv4 addresses are accepted.
- The firewall rule is always scoped to the guest address (`-GuestAddress`, else the VM's address on the host subnet).
  A busy port or a leftover rule is refused before any guest change.
- Each guest program is bounded in the guest as well as on the host, since a guest process can outlive a host job stop.
- The private reviewer key stays in the guest; only public sign-offs are collected.
- `-DryRun` prints the ordered plan without touching Hyper-V, the firewall or the network, which is how CI tests it.

## Consequences

Each gate still binds the candidate version, commit and VSIX hash, as before. No gate binds the commit of the
tooling that ran the steps. Operators running this driver from a different checkout than the candidate
must pass `-CandidateRepo`; the compared rule files catch a tooling checkout that disagrees with the candidate. Live Hyper-V behaviour is exercised by operators, not by CI.
