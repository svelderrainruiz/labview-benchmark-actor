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
- The candidate's own validators and guest scripts are read from the candidate checkout (`-CandidateRepo`), because the
  stage evidence depends on the candidate's `release-components.json`.
- The private reviewer key stays in the guest; only public sign-offs are collected.
- `-DryRun` prints the ordered plan without touching Hyper-V, the firewall or the network, which is how CI tests it.

## Consequences

Each gate still binds the candidate version, commit and VSIX hash, as before. No gate binds the commit of the
tooling that ran the steps. Operators running this driver from a different checkout than the candidate
must pass `-CandidateRepo`. Live Hyper-V behaviour is exercised by operators, not by CI.
