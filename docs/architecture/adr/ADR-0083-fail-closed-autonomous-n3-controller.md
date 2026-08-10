# ADR-0083: Fail-closed autonomous N>=3 controller decision (LBA-REQ-100)

- Status: Accepted
- Date: 2026-08-10
- Deciders: maintainer + parent-integration agent
- Relates to: LBA-REQ-098 / ADR-0081 (signed actor protocol), LBA-REQ-099 / ADR-0082 (persistent actor service)

## Context

The persistent actors independently admit and execute signed work, but the final live N=3 proof still required manual
construction of actor-specific requests, correlation of full bus responses, signature checks, known-answer checks, and
assembly of the candidate consume decision. Those manual steps are part of the trust boundary: a missing, duplicate,
unknown-task, forged, wrong-answer, or candidate-drifted response must not be mistaken for a complete gate.

## Decision

- A controller dispatch names an exact candidate and at least three distinct actors spanning LINUX and WIN.
- Dispatch construction emits one requester-signed request per actor with a canonical actor-specific task id.
- Decision reduction revalidates every requester envelope and actor response against enrolled public keys; no trust is
  inherited merely because an envelope was already present in a persisted dispatch or receive log.
- Every expected actor must return exactly one response bound to its actor identity, task, plane, request digest, and
  dispatch candidate. Unknown tasks and duplicate responses fail the entire decision.
- The fixed workload succeeds only when the signed response is `SUCCESS` and reports observed `3`, expected `3`, and
  verdict `PASS`.
- The dispatch candidate must equal an independently supplied sealed commit/tree/bundle descriptor.
- The reducer emits `autonomous-n3-decision@1`; `consume` is true only when every check passes. It remains pure and
  dependency-free. `lba actor-n3-decide` provides file-oriented operation without introducing another transport.

## Consequences

- The controller decision is deterministic, portable, and replayable over durable full-frame evidence.
- Actor execution and transport remain owned by ADR-0082 and `lbabus`; this decision does not add SSH, hypervisor, or
  GitHub queue dependencies.
- Live send/listen orchestration can be added separately without weakening this reducer or conflating transport with
  authorization and consumption.

## References

- Realizes: LBA-REQ-100 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-100`)
- Controller: `experiments/mesh-fulfillment/autonomousN3Controller.mjs`
- Focused command: `node experiments/mesh-fulfillment/autonomousN3Controller.selftest.mjs`
- Operator command: `node scripts/lba.mjs actor-n3-decide ...`