# ADR-0080: Govern experiment lifecycle and require a local continuous KPI (LBA-REQ-097)

- Status: Accepted
- Date: 2026-08-08
- Deciders: maintainer + 1.4.3 release agent
- Relates to: LBA-REQ-097 (realized here), LBA-REQ-096 / ADR-0079 (release-risk overlay),
  LBA-REQ-021 / ADR-0013 (correspondence graph)

## Context

An experiment can remain in the repository after its learning is absorbed. Without explicit lifecycle state, a
prototype or superseded harness can later be called from production or release automation as though it were active.
The repository also needs a local, repeatable KPI that validates incremental CHANGELOG/system-version work before a
human verdict instead of discovering drift at the end.

## Decision

- An immediate `experiments/` directory is active-governed when the RTM names one of its files.
- Every directory not directly named by the RTM must appear in `experiments/governance-overrides.json` with status
  active, prototype, superseded, or retired; owner; requirement ownership; and a production-use boundary.
- Prototype, superseded, retired, and evidence-only experiments fail if production surfaces reference them.
  Superseded entries also name a resolvable replacement.
- `npm run ci:local:quick` validates system version/CHANGELOG, experiment lifecycle, release-risk integrity,
  traceability currency, and test-report currency during development.
- `npm run ci:local` runs from a clean worktree before verdict and adds the full test suite, local gates,
  correspondence graph, and two byte-identical normalized VSIX builds. It writes an indexed KPI receipt under
  `.lba/local-ci/`.
- Generated AGENTS states the numeric acceptance KPI and requires the receipt in pre-verdict evidence.

## Consequences

- An ungoverned experiment or prohibited production reference fails local and hosted gates.
- Historical evidence can remain without being mistaken for an active implementation.
- CHANGELOG and system-version drift is caught continuously, not only during release packaging.
- A passing local KPI is necessary but not sufficient for release; the human and cross-plane gates remain explicit.

## References

- Realizes: LBA-REQ-097 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-097`)
- Lifecycle: `experiments/governance-overrides.json`, `experiments/experiment-governance.mjs`
- KPI: `scripts/local-continuous-kpi.mjs`
- Agent contract: `extension-agents/AGENTS.md`
