#!/usr/bin/env python3
"""Accept one attested wiki submission (fork-and-wiki S3): re-verify it, commit its evidence, open a PR as the App.

The label `wiki-attested` is never trusted: the issue is fetched again, the S2 gate and verifier run again, the evidence
bytes are fetched again at the pinned commit and compared with their sha256. Nothing is written to a wiki; the result is
`wiki-evidence/<sha256>.json` plus `wiki-evidence/<sha256>.lineage.json` in a pull request whose title, body, branch and
commit message are templates filled with validated fields only (hex, issue number, enum), never with fork text.
The fork owner and repository never reach the tree: the lineage record holds the submission number and the evidence hash.
Needs only Python 3.9+."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import wiki_submission as ws  # noqa: E402

ROOT = ws.ROOT
DIRECTORY = "wiki-evidence"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PLATFORM = re.compile(r"^[a-z0-9]+-[a-z0-9_]+$")
LABEL = "wiki-attested"
TITLE = "Accept wiki evidence {digest} from submission #{issue}"
BODY = ("Accepted wiki submission #{issue} ({platform}).\n\nEvidence sha256: {digest}\nVerified at upstream commit: {upstream}\n"
        "Re-verified by scripts/wiki_accept.py; the fork is not named.\n")


class Refuse(Exception):
    pass


def evidence_path(digest: str, suffix: str = ".json") -> str:
    """The only place a record may live: a fixed directory and a name made of 64 hex digits."""
    if not HEX64.fullmatch(digest):
        raise Refuse("digest-invalid")
    return f"{DIRECTORY}/{digest}{suffix}"


def reverify(issue: dict, *, upstream: str, schema: dict, canonical: dict, tracked: list, net, observations, allowlist) -> tuple:
    """Return (submission, evidence bytes). Raises Refuse, or ws.Reject with the S2 reason code."""
    if LABEL not in [label.get("name") for label in issue.get("labels", []) if isinstance(label, dict)]:
        raise Refuse("no-attested-label")
    event = {"issue": issue}
    limits = schema["x-limits"]
    if not ws.authorized(event, allowlist, limits, net):
        raise Refuse("not-authorized")
    ws.verify(event, upstream=upstream, schema=schema, canonical=canonical, tracked=tracked, net=net, observations=observations)
    submission = ws.parse_body(issue.get("body"), limits)
    blobs = ws.fetch_evidence(net, submission["fork"], submission["evidence_commit"], submission["evidence"], limits)
    names = [name for name in blobs if name in canonical.get("evidence", [])]
    if len(names) != 1:
        raise Refuse("evidence-not-single")
    data = blobs[names[0]]
    fork_owner, fork_name = submission["fork"].lower().split("/")
    if fork_owner.encode() in data.lower() or fork_name.encode() in data.lower():
        raise Refuse("evidence-names-the-fork")
    return submission, data


def lineage_record(*, number: int, digest: str, submission: dict, upstream: str, date: str) -> dict:
    if not (isinstance(number, int) and number > 0 and DATE.fullmatch(date) and ws.SHA.fullmatch(upstream) and PLATFORM.fullmatch(submission["platform"])):
        raise Refuse("record-invalid")
    return {"schema": "rsr/wiki-lineage@1", "submission": number, "evidence_sha256": digest, "platform": submission["platform"],
            "tests": sorted(test["id"] for test in submission["tests"]), "upstream_commit": upstream, "attested": date}


def write_files(root: Path, data: bytes, record: dict) -> list:
    """Write both files, content-addressed; an existing pair makes no change and returns []."""
    digest = hashlib.sha256(data).hexdigest()
    if record["evidence_sha256"] != digest:
        raise Refuse("hash-mismatch")
    files = {evidence_path(digest): data, evidence_path(digest, ".lineage.json"): (json.dumps(record, indent=2, sort_keys=True) + "\n").encode()}
    written = []
    for relative, content in files.items():
        target = root / relative
        if target.exists():
            if target.read_bytes() != content:
                raise Refuse("record-conflict")
            continue
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(content)
        written.append(relative)
    return written


def open_pull_request(root: Path, files: list, record: dict, run=subprocess.run) -> list:
    """Branch, commit and PR through git and gh with the App token of the environment; text comes from templates."""
    digest = record["evidence_sha256"]
    title = TITLE.format(digest=digest[:12], issue=record["submission"])
    body = BODY.format(digest=digest, issue=record["submission"], platform=record["platform"], upstream=record["upstream_commit"])
    branch = f"agents/wiki-evidence-{digest[:12]}"
    commands = [["git", "checkout", "-b", branch], ["git", "add", "--", *files], ["git", "commit", "-m", title],
                ["git", "push", "origin", branch],
                ["gh", "pr", "create", "--base", "develop", "--head", branch, "--title", title, "--body", body]]
    for command in commands:
        run(command, cwd=root, check=True)
    return commands


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--issue", type=int, required=True)
    parser.add_argument("--open-pr", action="store_true", help="commit the files on a new branch and open the PR (needs git and gh as the App)")
    parser.add_argument("--date", default=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"))
    options = parser.parse_args()
    upstream, sha = os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GITHUB_SHA", "")
    if not ws.SLUG.fullmatch(upstream) or not ws.SHA.fullmatch(sha) or options.issue < 1:
        print("FAIL: GITHUB_REPOSITORY, GITHUB_SHA and a positive --issue are required", file=sys.stderr)
        return 2
    net = ws.GitHubApi(os.environ.get("GITHUB_TOKEN"))
    try:
        issue = net.get(f"/repos/{upstream}/issues/{options.issue}")
        if not isinstance(issue, dict):
            raise Refuse("issue-missing")
        with os.popen("git -C " + str(ROOT) + " ls-files") as listing:
            tracked = listing.read().split("\n")
        submission, data = reverify(issue, upstream=upstream, schema=ws.load_json(ROOT / "scripts" / "wiki-submission.schema.json"),
                                    canonical=ws.load_json(ROOT / ".wiki-canonical.json"), tracked=tracked, net=net,
                                    observations=ws.load_observations(), allowlist=os.environ.get("SUBMISSION_ALLOWLIST"))
        record = lineage_record(number=options.issue, digest=hashlib.sha256(data).hexdigest(), submission=submission, upstream=sha, date=options.date)
        files = write_files(ROOT, data, record)
    except (Refuse, ws.Reject) as error:
        print(f"REFUSED: {getattr(error, 'code', None) or error}")
        return 1
    except Exception:
        print("REFUSED: internal-error")
        return 1
    print(json.dumps({"written": files, "evidence_sha256": record["evidence_sha256"]}))
    if files and options.open_pr:
        open_pull_request(ROOT, files, record)
    return 0


if __name__ == "__main__":
    sys.exit(main())
