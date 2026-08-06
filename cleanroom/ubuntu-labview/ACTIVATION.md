# Golden Actor Activation Runbook

This runbook prepares a local Ubuntu golden actor for the human-only LabVIEW Community Edition activation step.

## Boundary

Automation may install public packages, configure headless prerequisites, collect non-secret readiness evidence, and run a functional known-answer probe. It must never accept, request, read, or transmit an NI account password, MFA code, or VIPM credential.

## Agent Cycle

From the repository root, use a declared mesh actor as the temporary golden activation target:

```powershell
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Check
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Repair
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Handoff `
  -ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
```

`Check` writes a non-secret readiness capture and receipt. `Repair` reruns the public dependency provisioner, reboots once for VI Server readiness, and checks again. `Handoff` is available only after readiness is confirmed.

## User Handoff

Open the actor's VMware console, launch LabVIEW Community Edition, and complete NI/VIPM activation directly in the VM. Credentials and MFA codes stay in the user-controlled console.

After activation, the agent can verify it functionally:

```powershell
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Confirm `
  -ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
```

A successful confirmation writes `golden-actor1-activation-receipt.json` under `mesh/.vagrant/`. Pass the public
actor identity for enrollment-bound confirmation; it is digest-bound into the receipt. Only a receipt with
`verdict.activated: true` and a matching actor identity may be passed to the actor enrollment workflow.

## Enrollment

After `Confirm` exits successfully, register the local golden actor with the receipt it produced:

```powershell
node experiments/activation/registerMeshActor.mjs `
	--receipt cleanroom/ubuntu-labview/mesh/.vagrant/golden-actor1-activation-receipt.json `
	--registry cleanroom/ubuntu-labview/mesh-actors.csv
```

The command validates the receipt before changing the ignored local registry. It never accepts a password;
the local provisioning flow generates credentials separately. If confirmation is unconfirmed, crashed, or
tampered, enrollment leaves the registry unchanged and prints the next safe action.

## Handoff Evidence

The activation cycle keeps these non-secret local artifacts in `mesh/.vagrant/`:

- `golden-actor1-readiness-capture.json`
- `golden-actor1-readiness-receipt.json`
- `golden-actor1-activation-capture.json`
- `golden-actor1-activation-receipt.json`

A `-350000` result is an unconfirmed activation/VI Server probe result, not permission for automation to retry credentials. Reissue the human handoff, then use `Confirm` after the user completes activation.
