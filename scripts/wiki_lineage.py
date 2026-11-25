#!/usr/bin/env python3
"""Add the attestation label and the lineage field to the wiki pages of the tests (fork-and-wiki S3).

An LBA-local step after the shared generator (which is pinned by digest and never edited): it reads the accepted
records in wiki-evidence/*.lineage.json and appends one block to each tests/<id>.md. A page whose test files are
covered by an accepted record shows `attested at <upstream sha>`; every other page shows `not attested`. The lineage
shows the submission number and the evidence sha256 only; the fork is never named (`show_fork` stays off).
Needs only Python 3.9+."""
from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
MARKER = "<!-- lineage -->"
NAME = re.compile(r"^[0-9a-f]{64}\.lineage\.json$")
SHA = re.compile(r"^[0-9a-f]{40}$")
SHOW_FORK = False  # the commander's rule: partner names never appear in the public tree; do not enable


def load_records(root: Path) -> list:
    """Accepted records, strictly validated; an invalid file is an error, never silently skipped."""
    records = []
    for path in sorted((root / "wiki-evidence").glob("*.lineage.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        valid = (NAME.fullmatch(path.name) and record.get("schema") == "rsr/wiki-lineage@1" and record.get("evidence_sha256") == path.name[:64]
                 and SHA.fullmatch(str(record.get("upstream_commit"))) and isinstance(record.get("submission"), int)
                 and isinstance(record.get("tests"), list))
        if not valid:
            raise SystemExit(f"FAIL: {path.name} is not a valid lineage record")
        records.append(record)
    return records


def page_tests(root: Path) -> dict:
    """Test page id -> the test files its linked requirements name, the same link the canonical checker reads."""
    pages: dict = {}
    with (root / "docs" / "requirements" / "rtm.csv").open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            tokens = {token for token in re.split(r"[;\s]+", row["CodeRef"]) if token}
            for page in re.split(r"[\s,;]+", row["TestID"]):
                if page:
                    pages.setdefault(page, set()).update(tokens)
    return pages


def block(covering: list) -> str:
    if not covering:
        return f"\n{MARKER}\n## Lineage\n\n- **Attestation:** not attested\n- **Lineage:** none\n"
    latest = max(covering, key=lambda r: (r["attested"], r["upstream_commit"]))
    lines = [f"- submission #{r['submission']}, evidence sha256 `{r['evidence_sha256']}`" for r in sorted(covering, key=lambda r: r["evidence_sha256"])]
    return f"\n{MARKER}\n## Lineage\n\n- **Attestation:** attested at {latest['upstream_commit']}\n- **Lineage:**\n" + "\n".join("  " + line for line in lines) + "\n"


def apply(wiki: Path, root: Path) -> int:
    records, pages = load_records(root), page_tests(root)
    count = 0
    for page in sorted((wiki / "tests").glob("*.md")):
        files = pages.get(page.stem, set())
        text = page.read_text(encoding="utf-8").split(MARKER)[0].rstrip("\n") + "\n"
        covering = [r for r in records if files & set(r["tests"])]
        page.write_text(text + block(covering), encoding="utf-8")
        count += bool(covering)
    return count


if __name__ == "__main__":
    wiki_dir = Path(sys.argv[1]) if len(sys.argv) == 2 else None
    if wiki_dir is None:
        sys.exit("usage: wiki_lineage.py WIKI_DIR")
    print(f"PASS: {apply(wiki_dir, Path('.'))} test pages are covered by an accepted record")
