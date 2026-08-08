# ADR-0078: System-level SemVer, deterministic task receipts, and canonical distribution (LBA-REQ-095)

- Status: Accepted
- Date: 2026-08-08
- Deciders: 1.4.2 human reviewer + release agent
- Relates to: LBA-REQ-095 (realized here), LBA-REQ-020 (release agreement), LBA-REQ-057 (human gate),
  LBA-REQ-085 / LBA-REQ-086 / LBA-REQ-093 (reviewed artifact reproducibility)

## Context

The signed 1.4.1 review found that a task could execute the right commands while still presenting confusing output:
terminal reuse/capture prompts obscured the result, command output had no deterministic event index, and neither wall
time nor its monotonic clock source was explicit. The review also found that independently versioned AGENTS, `lbabus`,
and human-task changes were not reflected in one extension-level version contract.

Marketplace publication could precede the immutable GitHub Release. That made it unclear which artifact was canonical
and allowed a stable gallery channel to appear authoritative before the reviewed, signed release assets existed.
The local standards corpus at `C:\design\standards` supports this control: ISO 10007:2017 §§5.3 and 5.5 govern
configuration identification and status accounting, ISO/IEC/IEEE 12207:2017 Transition requires a software-release
strategy, and ISO/IEC/IEEE 29119-3:2021 defines retained test-log information. These references inform the tailored
controls below; they are not a blanket conformance claim.

## Decision

- `release-components.json` is the system-version definition. It binds the SemVer 2.0 versions of the extension,
  generated AGENTS, `lbabus`, and the human-task bundle, plus the distribution policy and exact standards-review
  source commit/workbench image digest.
- Any governed component change increments that component's SemVer and the extension SemVer before commit. Candidate
  remediation after a signed rejection uses a new extension version; rejected-version keys do not authorize it.
- The repository precommit hook runs `scripts/release-components.mjs --precommit`. A governed component change is
  rejected unless its component version and extension version changed, `package.json`, `package-lock.json`,
  `release-components.json`, and `CHANGELOG.md` are all staged, and those release metadata files have no unstaged
  edits. This is the enforceable meaning of final release documents: the committed metadata and CHANGELOG are the
  final staged state, not stale drafts.
- Human tasks use dedicated terminals, suppress reuse prompts, ignore stdin, fail on the first nonzero child, and
  prefix every task/command/output event with a stable index, UTC timestamp, monotonic nanoseconds, and the named
  `process.hrtime.bigint` clock source. A JSON receipt is retained under extension global storage.
- The immutable GitHub Release targeting `main` is canonical. Marketplace publication is a separate, explicitly
  requested second dispatch, uses `vsce publish --pre-release`, and first downloads the GitHub Release VSIX and proves
  its SHA-256 equals the staged VSIX. That dispatch runs from the release tag and publishes the downloaded release
  asset itself. There is no stable Marketplace path in the governed workflow.

## Consequences

- Component, extension, and release-document drift fails before a commit is created and again in local gates.
- Task output is reviewable without a terminal-interaction decision and its chronology is machine-readable.
- A Marketplace package cannot precede or differ from the canonical GitHub Release artifact.
- Component changes intentionally consume extension versions even when an earlier candidate was rejected.

## References

- Realizes: LBA-REQ-095 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-095`)
- Runtime: `src/humanTasks.ts`, `extension-tasks/human-task-runner.mjs`
- Version authority: `release-components.json`, `scripts/release-components.mjs`, `.githooks/pre-commit`
- Publication: `.github/workflows/extension-release.yml`, `scripts/lba.mjs`
