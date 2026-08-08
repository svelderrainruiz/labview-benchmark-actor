# ADR-0077: Extension-contributed compound human tasks and local governance workbench (LBA-REQ-094)

- Status: Accepted
- Date: 2026-08-08
- Deciders: 1.4.1 human reviewer + release agent
- Relates to: LBA-REQ-094 (realized here), LBA-REQ-034 / ADR-0024 (information for users), LBA-REQ-037 /
  ADR-0027 (continuous compliance), LBA-REQ-057 / ADR-0037 (human visual release gate)

## Context

The 1.4.1 human review found that complete written command documentation still required people to repeatedly type
long preflight, governance, reviewer-readiness, and release commands. This is a release-blocking developer-experience
gap: the extension is the operator surface, so its human workflows must be discoverable through VS Code itself.
The same review requires a real standards governance pass using the published Linux-container workbench from the
locally available GitLab repository `svelderrainruiz/repo-standards-review`.

Repository `.vscode/tasks.json` alone is insufficient because Marketplace users do not receive the repository.
Tasks must be contributed by the installed extension and must run without requiring a separately installed Node
binary. Governance must fail closed when the local standards checkout or Docker Linux engine is unavailable.

## Decision

- Register a `labviewBenchmarkActor` VS Code `TaskProvider` with four shortcuts:
  - **LBA: Agent Preflight** — exact `lbabus` version, selfcheck, and capabilities;
  - **LBA: Governance Review** — local `repo-standards-review` checkout plus its published
    `assurance-workbench:main` Linux-container `release-gate` profile;
  - **LBA: Reviewer Mesh Readiness (compound)** — agent preflight followed by governance review;
  - **LBA: Release Candidate Check (compound)** — reviewer readiness followed by tests, local gates, and package.
- Execute the packaged task runner with VS Code's own executable under `ELECTRON_RUN_AS_NODE=1`, avoiding a hidden
  host Node prerequisite for Marketplace users.
- Require the local standards checkout at `REPO_STANDARDS_REVIEW` or the maintained default path, and require Docker
  to report `OSType=linux` before invoking the workbench image.
- Require the local standards corpus at `STANDARDS_ROOT` or `C:\design\standards`, prove the eight governed PDFs
  exist, and mount it read-only at `/standards`. The corpus is local reference material and is never packaged.
- Keep every child command visible in the terminal and stop at the first nonzero exit.
- Version the compound task bundle independently and display that version in generated AGENTS.md and task details.
- Require the maintained raw-review collector before disposable VM teardown; it retains target/candidate identities,
  installed commands/tasks, AGENTS version/hash/text, `lbabus capabilities`, safe reviewer settings, VM info, and a
  screenshot for the next agent.
- Gate task contribution, exact labels, bundled-runner wiring, local-checkout requirement, Linux-engine guard, and
  the published workbench image command deterministically.

## Consequences

- Human operators discover the governed workflows under **Terminal: Run Task** and no longer reconstruct command
  sequences from prose.
- Marketplace users can run the preflight even when `node` is absent from PATH; workload tools such as Docker,
  `lbabus`, and the standards checkout remain explicit prerequisites.
- Governance is reproducible against the same published workbench image used by the external standards repository.
- Human-review evidence survives VM cleanup as indexed, hashed raw artifacts.
- The compound release task is intentionally strict and potentially long-running; it is a release/readiness action,
  not a background convenience.

## References

- Realizes: LBA-REQ-094 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-094`)
- Human review evidence: signed 1.4.1 request-changes/FAIL verdicts retained in session evidence
- Governance workbench: `https://gitlab.com/svelderrainruiz/repo-standards-review`
- Runtime: `src/humanTasks.ts`, `extension-tasks/human-task-runner.mjs`
