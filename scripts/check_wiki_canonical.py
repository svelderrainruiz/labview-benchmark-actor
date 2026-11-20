#!/usr/bin/env python3
"""Check this repository's wiki, generated with canonical test pages from execution evidence.

Needs only Python 3.9+ and Git. Run it at the repository root, in a clean checkout, after
`node scripts/wikiEvidence.mjs` wrote `wiki-jest-report.json` and `.repo-standards-review/observations.py
evidence --format jest-json` turned it into `wiki-evidence.json` (the `Wiki Canonical Test Pages` CI job does
both). The canonical block is in `.wiki-canonical.json`, merged into `.wiki-generator.json` at run time. It builds the wiki twice (generate, then `observations.py stimulus` and `generate`), requires the two builds to be
byte-identical, at least one canonical page and no `Pending:` placeholder, and runs `observations.py check
--member-commit` on the committed result. It prints the stub pages by reason. Exit 0 when all hold.
The evidence is execution evidence at one commit; it does not say the member is verified.
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
KIT = Path(".repo-standards-review")
STEPS = ["npm ci", "npm run compile"]
COMMAND = "node scripts/wikiEvidence.mjs --report wiki-jest-report.json # evidence for {files}"
ARTIFACT_SECTION = "CodeRef"
MEMBER = "labview-benchmark-actor"
ENVIRONMENT = {**os.environ, "PYTHONUTF8": "1", "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "wiki", "GIT_AUTHOR_EMAIL": "wiki@example.invalid",
               "GIT_COMMITTER_NAME": "wiki", "GIT_COMMITTER_EMAIL": "wiki@example.invalid"}


def run(*command: str) -> subprocess.CompletedProcess[str]:
    done = subprocess.run(command, capture_output=True, text=True, env=ENVIRONMENT, check=False)
    if done.returncode != 0:
        sys.exit(f"FAIL: {' '.join(command[:4])} exited {done.returncode}\n{done.stdout}{done.stderr}")
    return done


CANONICAL = Path(".wiki-canonical.json")


def canonical_config(destination: Path) -> Path:
    """Write .wiki-generator.json plus the canonical block of .wiki-canonical.json.

    The default configuration stays free of the evidence: the wiki-vault gate and wiki-publish generate without it,
    and the evidence is produced by running those gates."""
    config = json.loads(Path(".wiki-generator.json").read_text(encoding="utf-8"))
    config["testPlan"] = {**config["testPlan"], "canonical": json.loads(CANONICAL.read_text(encoding="utf-8"))}
    destination.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return destination


def build(wiki: Path, evidence: str, config: Path) -> dict:
    wiki.mkdir()
    run("git", "-C", str(wiki), "init", "-q", "-b", "main")
    generated = run(sys.executable, str(KIT / "wiki_generate.py"), "--member-root", ".", "--config", str(config), "--out", str(wiki))
    summary = json.loads(generated.stdout)
    run(sys.executable, str(KIT / "observations.py"), "stimulus", "--wiki", str(wiki), "--evidence", evidence,
        "--member", MEMBER, "--artifact-section", ARTIFACT_SECTION,
        *[x for step in STEPS for x in ("--step", step)], "--command", COMMAND)
    run(sys.executable, str(KIT / "observations.py"), "generate", "--wiki", str(wiki), "--evidence", evidence)
    return summary


def tree(wiki: Path) -> dict[str, bytes]:
    return {p.relative_to(wiki).as_posix(): p.read_bytes() for p in sorted(wiki.rglob("*"))
            if p.is_file() and ".git" not in p.relative_to(wiki).parts}


def stub_reasons(wiki_tree: dict[str, bytes], evidence: str) -> collections.Counter:
    """Why each stub test page is a stub, read from the RTM and the evidence (informational)."""
    document = json.loads(Path(evidence).read_text(encoding="utf-8"))
    status: dict[str, set] = collections.defaultdict(set)
    for case in document["cases"]:
        status[case["file"]].add(case["status"])
    patterns = [re.compile(p) for p in json.loads(CANONICAL.read_text(encoding="utf-8"))["testFiles"]]
    rows = list(csv.DictReader(Path("docs/requirements/rtm.csv").open(encoding="utf-8", newline="")))
    reasons: collections.Counter = collections.Counter()
    for path, data in wiki_tree.items():
        if not (path.startswith("tests/") and b"<!-- page-kind: stub -->" in data):
            continue
        test_id = Path(path).stem
        linked = [r for r in rows if test_id in re.split(r"[\s,;]+", r["TestID"])]
        tokens = {t.strip() for r in linked for t in re.split(r"[;\s]+", r["CodeRef"]) if t.strip()}
        if any("failed" in status.get(t, set()) or "skipped" in status.get(t, set()) for t in tokens):
            reasons["a linked test file has failing or skipped cases"] += 1
        elif linked and all(r["Status"] in ("Planned", "Superseded") for r in linked):
            reasons["linked requirement is Planned or Superseded (no implementation to run)"] += 1
        elif any(any(p.search(t) for p in patterns) for t in tokens):
            reasons["a linked test file exists but no gate or npm test step ran it"] += 1
        else:
            reasons["linked requirements name no test file or gate (only code, receipts or docs)"] += 1
    return reasons


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--evidence", default="wiki-evidence.json", help="evidence file named by testPlan.canonical (default: wiki-evidence.json)")
    parser.add_argument("--emit-config", metavar="FILE", help="write the merged generator configuration to FILE and exit")
    options = parser.parse_args()
    if options.emit_config:
        print(f"PASS: wrote {canonical_config(Path(options.emit_config))}")
        return 0
    with tempfile.TemporaryDirectory() as temp:
        first, second = Path(temp) / "first", Path(temp) / "second"
        config = canonical_config(Path(temp) / "wiki-generator.canonical.json")
        summary = build(first, options.evidence, config)
        build(second, options.evidence, config)
        built = tree(first)
        if built != tree(second):
            sys.exit("FAIL: two builds of the wiki differ")
        pending = [path for path, data in built.items() if b"Pending:" in data]
        if pending:
            sys.exit(f"FAIL: pages still hold a placeholder: {', '.join(pending)}")
        if summary["problem_count"] or not summary["canonical_test_pages"]:
            sys.exit(f"FAIL: {json.dumps({k: summary[k] for k in ('canonical_test_pages', 'stub_test_pages', 'warnings', 'problem_count')})}")
        for warning in summary["warnings"]:
            print(f"NOTE: {warning}")
        for reason, count in sorted(stub_reasons(built, options.evidence).items()):
            print(f"STUB: {count} pages: {reason}")
        run("git", "-C", str(first), "add", "-A")
        run("git", "-C", str(first), "commit", "-q", "--no-verify", "-m", "wiki")
        commit = run("git", "rev-parse", "HEAD").stdout.strip()
        checked = run(sys.executable, str(KIT / "observations.py"), "check", "--wiki", str(first), "--member-commit", commit,
                      "--evidence", options.evidence)
        print(checked.stdout.strip())
    print(f"PASS: {summary['canonical_test_pages']} canonical, {summary['stub_test_pages']} stub test pages; two builds are byte-identical")
    return 0


if __name__ == "__main__":
    sys.exit(main())
