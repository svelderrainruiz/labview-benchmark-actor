# ADR-0082: Persistent lbabus autonomous actor service (LBA-REQ-099)

- Status: Accepted
- Date: 2026-08-10
- Deciders: maintainer + parent-integration agent
- Relates to: LBA-REQ-098 / ADR-0081 (signed actor protocol), LBA-REQ-060 / ADR-0040 (local receive log)

## Context

ADR-0081 defines a signed execution protocol, but a production actor needs a long-running process that owns
delivery, durable replay state, bounded execution, and response transport across Linux and Windows. A host-driven
SSH command per task would leave the host as the execution plane and would not survive response loss or restart.

## Decision

- A dependency-free Node daemon launches `lbabus net listen --log` and consumes its canonical append-only JSONL.
- Only `bus-msg@1` `CLAIM` frames whose bus sender/task equal the signed requester/task enter the protocol service.
- The cursor advances atomically only after every eligible response in the complete JSONL batch is sent. A failed
  send leaves the cursor unchanged; the persisted outcome is retransmitted without executing the workload again.
- Per-actor state durably records accepted requester/nonces, signed outcomes, and the active request. Startup turns
  an interrupted active request into a signed `ACTOR_INTERRUPTED` failure.
- The actor runs at most one workload. Its local registry contains fixed executable/argument adapters; signed
  request parameters never become shell text or argv. The configured staged candidate must exactly match the
  request's commit, tree, and bundle SHA-256.
- Workload results are bounded to 64 KiB. Artifacts are bounded to 16 MiB each, stored by SHA-256 in guest-local
  content-addressed storage, and represented on the bus only by name, digest, and byte count.
- Responses use `lbabus net send --message-file`; private actor keys and requester allowlists are read from local
  paths and private material is never placed in the bus envelope.

## Consequences

- Duplicate log delivery and peer outages are idempotent: execution remains exactly once per accepted nonce while
  signed delivery can retry.
- The service is cross-platform and shell-free, but it must run as the already activated desktop user when the fixed
  adapter requires that user's LabVIEW/VIPM licenses.
- VM service installation, dual LabVIEW/VIPM functional enrollment, and live signed N=3 evidence remain subsequent
  governed increments; this decision proves the persistent execution mechanism offline.

## References

- Realizes: LBA-REQ-099 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-099`)
- Service: `experiments/mesh-fulfillment/autonomousActorService.mjs`
- Daemon: `experiments/mesh-fulfillment/autonomousActorDaemon.mjs`
- Focused command: `node scripts/lba.mjs actor-service-check`