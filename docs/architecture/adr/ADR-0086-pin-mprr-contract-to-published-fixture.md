# ADR-0086: Pin the absorbed mprr contract to mprr's published shared contract

- Status: Accepted
- Date: 2026-11-14
- Owner: LINUX
- Traces to: LBA-REQ-003, LBA-REQ-005, LBA-REQ-009
- Supersedes in part: [ADR-0009](ADR-0009-absorb-mprr-model-self-owned.md). The implementation stays
  self-owned; only the contract is now pinned upstream.

## Context

ADR-0009 absorbed the mprr ring-buffer and timing model as a self-owned, dependency-free mirror, and the
`mprr-absorbed-constants-match-mprr-spec` gate pinned its constants to values read from mprr source by hand.
Two problems followed:

- The gate attributed the `1.10` admission headroom to MPRR-REQ-110, which did not state the value.
- The capture-ring packet, launch-capture record and boot-benchmark record contracts that this repository
  added later had no upstream reference at all.

The operator has since decided that mprr is upstream for these contracts. mprr `v0.1.1` publishes them as a
machine-readable file (`contracts/mprr-shared-contract.v1.json`, `mprr-shared-contract-v1`, mprr ADR-0046)
with canonical identifiers. The identifiers this repository already emits are accepted aliases.

## Decision

- The implementation under `experiments/mprr-ring/` and `experiments/mprr-capture-ring/` stays self-owned
  and dependency-free, as ADR-0009 decided.
- The contract is vendored byte-for-byte into `experiments/mprr-ring/contract/` from a tagged release of the
  private mprr repository on GitLab (`gitlab.com/svelderrainruiz/mprr`), with `pin.json` recording that
  source, the tag and the SHA-256. `.gitattributes` keeps the file byte-exact
  on every plane.
- `experiments/mprr-ring/mprrContract.mjs` refuses a vendored file that does not match its pin, and
  compares the implementation with the contract:
  - the ring constants, including the three-block horizon, checked through
    `requiredThreeBlockCapacityBytes`;
  - the capture-ring packet layout, version, flag and milestone IDs;
  - launch-capture field presence and nullability, checked on a record built by `buildLaunchCapture`;
  - the boot-benchmark JSON Schema's required fields, dialect and schema constant.
- The `mprr-contract-matches-pinned-fixture` gate replaces `mprr-absorbed-constants-match-mprr-spec`.
  It fails closed on any mismatch, and its own checks show that a drifted constant, offset, field or
  tampered file is reported.
- A record's `schema` value is accepted when it is the canonical identifier or one of the contract's
  aliases (`isContractSchema`). Producers keep emitting the existing identifiers, which stay valid as
  aliases.
- Updating the contract means vendoring a newer mprr tag, updating `pin.json`, and passing the gate.

## Consequences

- Every shared constant and wire shape now cites one versioned upstream source, not prose.
- The mprr repository is private, so the pinned tag can't be fetched from public CI; the SHA-256 in
  `pin.json` is the integrity anchor. The published contract carries only values, units, requirement
  identifiers and wire shapes; its verification bindings stay private in mprr.
- Readers that check a `schema` value with strict equality still accept only the existing identifiers.
  They need to move to `isContractSchema` before any producer emits a canonical identifier.
