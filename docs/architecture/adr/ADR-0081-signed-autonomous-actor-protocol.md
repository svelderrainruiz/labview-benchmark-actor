# ADR-0081: Signed autonomous actor protocol (LBA-REQ-098)

- Status: Accepted
- Date: 2026-08-10
- Deciders: maintainer + parent-integration agent
- Relates to: LBA-REQ-098 (realized here), LBA-REQ-074 / ADR-0055 (mesh dispatch),
  LBA-REQ-077 / ADR-0058 (enrolled actor signatures)

## Context

The mesh contracts bind dispatch, tasking, collection, and fulfillment, but live benchmark runners are started by
host SSH or hypervisor control. That control path cannot prove an actor independently accepted an authorized task,
ran the intended candidate, rejected replay, or signed a bounded failure. Parent integration now requires a
bus-native production mesh whose benchmark runtime has no SSH, WinRM, shared-folder, or Guest Control dependency.

## Decision

- A requester signs an `autonomous-actor-request@1` envelope with an enrolled Ed25519 key.
- The request binds dispatch and task identifiers, target OS plane, a 16-128 character nonce, an issued/expiry
  window of at most 15 minutes, an allowlisted workload, and the candidate source commit/tree/bundle SHA-256.
- An actor rejects an un-enrolled signer, signature or candidate mutation, wrong plane, expired request, replayed
  requester/nonce pair, or non-allowlisted workload before execution.
- Exactly one workload may execute per actor; concurrent requests receive a signed `BUSY` response.
- Every outcome is an actor-signed `autonomous-actor-response@1` bound to the exact request digest. Success carries
  a bounded result plus content-addressed artifact metadata. Rejection, busy, and failure carry a bounded code.
- The documents fit inside the existing `bus-msg@1` TCP frame and use `lbabus net send --message-file`; private
  keys remain outside the repository.

## Consequences

- A bus frame alone cannot authorize code execution; enrolled identity, freshness, candidate, and allowlist checks
  all fail closed before an adapter runs.
- Results and failures are attributable to an enrolled actor and cannot be rebound to another task.
- The protocol is plane-neutral and dependency-free. Persistent services, actor key custody, lifecycle application,
  dual activation enrollment, and live N=3 evidence remain separately governed increments.

## References

- Realizes: LBA-REQ-098 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-098`)
- Protocol: `experiments/mesh-fulfillment/autonomousActorProtocol.mjs`
- Fail-closed evidence: `experiments/mesh-fulfillment/autonomousActorProtocol.selftest.mjs`