# ADR-0079: Preserve the standards score and overlay candidate-specific release risk (LBA-REQ-096)

- Status: Accepted
- Date: 2026-08-08
- Deciders: maintainer + 1.4.3 release agent
- Relates to: LBA-REQ-096 (realized here), LBA-REQ-094 / ADR-0077 (Governance Review task),
  LBA-REQ-095 / ADR-0078 (system version and canonical distribution)

## Context

The exact repo-standards-review 0.2.19 workbench scored the repository's static maturity REQ/ARCH/TEST/CM/DOC
5/5 and returned six PASS gates. Every Missing Proof cell rendered as `-`. Its `score.json` correctly means that
the static rules found no absent repository artifact; it does not model candidate-specific proofs such as a signed
human PASS, hosted final-commit CI, cross-plane corroboration, an immutable target-main GitHub Release, or secondary
Marketplace closeout.

Treating `-` as "no risk" overstates readiness. Replacing the standards result with an invented lower maturity score
would also be dishonest. The two questions need separate, traceable scores.

## Decision

- Preserve the raw workbench identity, schema, maturity scores, gate status/confidence, and `-` Missing Proof values.
- Add `release-risk-baseline.json` as the candidate-specific overlay. Every scorecard gate has explicit present and
  missing proof items, a residual risk, and a forward action.
- Calculate release evidence completion as present proof count divided by all listed proof items with no hidden
  weights. Every present item must resolve to committed artifacts. The 1.4.3 baseline is 12/28 (42.9%) and BLOCKED.
- Bind the expected present/total/status tuple in `release-components.json`; changing proof state requires a
  system-versioned update and cannot pass precommit by toggling status alone.
- The evaluator fails closed on a missing gate row, invalid proof state, version drift, or workbench identity drift.
- Governance Review prints the static result followed by the overlay score and all six detailed actions into the
  indexed task receipt.
- Generated AGENTS states the exact repo-standards-review version/commit/image, explains the `-` boundary, and directs
  the next agent to report and close missing proofs only from exact-version artifacts.

## Consequences

- A static PASS remains a defensible repository-maturity result without becoming a release claim.
- Human and agent reviewers see the same realistic release blockers and ordered next actions.
- Release Candidate Check remains nonzero while the overlay is BLOCKED.
- Changing proof state requires a resolvable artifact and a system-versioned update.

## References

- Realizes: LBA-REQ-096 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-096`)
- Baseline: `release-risk-baseline.json`
- Evaluator: `extension-tasks/release-risk.mjs`
- Surfaces: `extension-tasks/human-task-runner.mjs`, `extension-agents/AGENTS.md`
