# ADR-0093: Publish only the digest of the reviewer infrastructure receipt

- Status: Accepted
- Owner: LINUX
- Traces to: LBA-REQ-057, LBA-REQ-071

## Context

Reviewers need to identify the infrastructure baseline used for a particular candidate.
Publishing the full receipt would expose operational details unrelated to verifying the release.

## Decision

The release operator privately validates and retains the receipt. Publish its SHA-256 and baseline
in the [release record](../../release/reviewer-infrastructure.schema.json), and include the digest
once in the visual verdict evidence **before** signing. Pre-flight and CI check the signed verdict
against the version's enrolled visual key and bind it to the same candidate and verdict in both
the agreement and the composite decision.

## Consequences

Anyone with the retained bytes can compare their digest to the release record. Without those bytes,
the public check establishes only the signed commitment, not the receipt's contents or the state
of the infrastructure. It is not remote attestation. See the [release runbook](../../release/release-runbook.md)
for the order of operations.
