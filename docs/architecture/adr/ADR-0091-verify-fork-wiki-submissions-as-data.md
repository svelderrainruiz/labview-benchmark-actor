# ADR-0091: Verify fork wiki submissions as data

- Status: Accepted
- Date: 2026-11-20
- Owner: LINUX
- Traces to: LBA-REQ-104

## Context

Forks publish their own wiki and may send evidence upstream (#112). Fork content is untrusted: running it, or
checking it out beside upstream privileges, would let a fork act as upstream.

## Decision

A submission is an issue whose body is one `rsr/wiki-submission@1` JSON document. An upstream-owned verifier
(`scripts/wiki_submission.py`) treats it as data: it checks the submitter's immutable numeric account id against the
partner allow-list, a comma-separated list of `login` or `login:numeric-id` entries held in the repository Actions
secret `SUBMISSION_ALLOWLIST` (so partner names are neither in the tree nor in public logs). The gate job, the only job
that reads the secret, requires the fork owner to be listed and the issue author to be that owner or a public member of
the owning organisation; every authorization failure is the same `not-authorized` outcome, so nobody can enumerate
partners. An unset, empty or unparsable list rejects everything. The verifier then fetches the
evidence files as bytes through the API at the pinned fork commit, recomputes their sha256, and compares test ids,
results and platform with upstream's own test files and the canonical evidence rules. The result is `attested` or
`not-attested` plus a reason from a fixed vocabulary, and the verifying upstream commit. The workflow's verify job has
`contents: read` and no secrets; a separate report job with `issues: write` takes only the enum outputs. No
`pull_request_target`. A `pull_request` path is a follow-up.

## Consequences

Attested means only that the evidence matched upstream's definitions at that commit. The operator decides partners.
API rate limits can turn a submission into `fetch-failed`, which is re-run by editing the issue.

## S3: accepted evidence and lineage

An operator runs `scripts/wiki_accept.py --issue N` for an issue labelled `wiki-attested`. The label is not trusted:
the script fetches the issue again, runs the same gate and verifier again, refetches the evidence bytes at the pinned
commit and checks the sha256. It writes `wiki-evidence/<sha256>.json` and `wiki-evidence/<sha256>.lineage.json` (the
name is 64 hex digits, never a fork-controlled path) and opens a pull request as the App; the title, body, branch and
commit message are templates filled with validated hex, the issue number and the platform. Nothing is written to a wiki.
The record holds the submission number, the evidence hash, platform, test ids, the verifying upstream commit and the
date; the fork owner and repository are never written, and evidence that names them is refused. `scripts/wiki_lineage.py`
runs inside the canonical checker after the shared generator (which stays pinned and unedited) and appends a lineage
block to every test page: `attested at <upstream sha>` when an accepted record covers one of the test files the page's
requirements name, otherwise `not attested`. Showing the fork (`SHOW_FORK`) stays off.
