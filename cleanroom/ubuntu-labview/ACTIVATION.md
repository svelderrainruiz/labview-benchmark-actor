# Golden Actor Activation Runbook

This runbook prepares a local Ubuntu golden actor for the human-only LabVIEW Community Edition activation step.

## Boundary

Automation may install public packages, configure headless prerequisites, collect non-secret readiness evidence, and run a functional known-answer probe. It must never accept, request, read, or transmit an NI account password, MFA code, or VIPM credential.

## Production Cycle

From the repository root, use a declared Vagrant actor as the temporary production-golden target:

```powershell
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Provision
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode ConsoleReady `
	-OperatorDesktopConfirmed `
	-ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Handoff `
	-ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
```

`Provision` reruns only public dependency setup, reboots once, then confirms LabVIEWCLI and the graphical console. `ConsoleReady` requires an explicit operator acknowledgement after the VMware console is unlocked with the local credential; it writes no credential data. `Handoff` is available only after that current console receipt verifies. `Repair` remains a compatibility alias for `Provision`.

## User Handoff

Open the actor's VMware console, launch LabVIEW Community Edition, and complete NI/VIPM activation directly in the VM. Credentials and MFA codes stay in the user-controlled console.

After activation, the agent can verify it functionally:

```powershell
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Confirm `
	-ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
```

A successful confirmation writes `golden-actor1-activation-receipt.json` under `mesh/.vagrant/`. Pass the public actor identity for enrollment-bound confirmation; it is digest-bound into the receipt. The controller also generates a new host challenge and persists it only after the successful functional probe, so a pre-activation snapshot cannot replay an older receipt into packaging or enrollment.

## Production Package

After a fresh `Confirm` succeeds, create the production box. This mode validates the receipt, current guest identity, persisted challenge, and current console acknowledgement; it then halts and packages the actor. It never runs an automatic LabVIEWCLI retry.

```powershell
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Package `
	-ActorId golden -ActorHostname actor1 -ActorIp 192.168.56.11
```

The default output is `cleanroom/ubuntu-labview/production/labview-ubuntu2404-production.box`; the command refuses to overwrite it unless `-OverwriteProductionBox` is supplied deliberately. A non-secret production package receipt is written beside the activation artifacts.

## Enrollment

After `Package` exits successfully, register the local golden actor with the receipt it produced:

```powershell
node experiments/activation/registerMeshActor.mjs `
	--receipt cleanroom/ubuntu-labview/mesh/.vagrant/golden-actor1-activation-receipt.json `
	--registry cleanroom/ubuntu-labview/mesh-actors.csv `
	--vm actor1 `
	--vagrant-root cleanroom/ubuntu-labview/mesh
```

The command validates the receipt and challenges the current Vagrant guest boot ID, hostname, IP, and persisted post-confirmation challenge before changing the ignored local registry. It never accepts a password. If confirmation is unconfirmed, crashed, tampered, or replayed after a snapshot restore, enrollment leaves the registry unchanged and prints the next safe action.

## Handoff Evidence

The activation cycle keeps these non-secret local artifacts in `mesh/.vagrant/`:

- `golden-actor1-readiness-capture.json`
- `golden-actor1-readiness-receipt.json`
- `golden-actor1-console-readiness.json`
- `golden-actor1-activation-capture.json`
- `golden-actor1-activation-receipt.json`
- `golden-actor1-production-package.json`

A `-350000` result is an unconfirmed activation/VI Server probe result, not permission for automation to retry credentials. Reissue the human handoff, then use `Confirm` after the user completes activation.
