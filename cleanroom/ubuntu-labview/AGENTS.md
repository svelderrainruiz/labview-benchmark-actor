# Ubuntu Golden Actor Agent Runbook

Use this folder only for public dependency repair and non-secret readiness work. LabVIEW and VIPM activation always belong to the user in the VM console.

1. Start with `golden-activation-cycle.ps1 -Vm <actor> -Mode Provision`; it may install public packages, reboots once, and confirms LabVIEWCLI plus graphical console readiness.
2. After the operator reaches the unlocked graphical desktop, use `-Mode ConsoleReady -OperatorDesktopConfirmed` with the golden actor identity. This acknowledgement contains no credential.
3. Use `-Mode Handoff -ActorId golden -ActorHostname <golden-host> -ActorIp <golden-ip>` and stop at the user interaction boundary.
4. After the user activates LabVIEW, use the same identity with `-Mode Confirm`. Confirmation generates a new host challenge and only succeeds when the functional probe persists it in the current guest.
5. Use `-Mode Package` only after a fresh confirmation. It verifies the current console receipt and persisted challenge before halting and creating the production box.
6. Register the packaged golden actor only with that current receipt; enrollment rejects snapshot-replayed or delimiter-injected local registry values.
7. Do not ask for or route passwords, MFA codes, tokens, or license keys through chat, environment variables, arguments, or uploaded files.

For mesh lifecycle work, use `mesh/provision-cycle.ps1 -Plan` before `-Apply` or `-Replace`, and verify the local receipt before reusing existing actors.
