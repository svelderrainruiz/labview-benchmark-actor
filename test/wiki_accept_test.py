"""Offline fixtures for scripts/wiki_accept.py and scripts/wiki_lineage.py. Synthetic data; the network is the S2 fake."""
import hashlib
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "test"))
import wiki_submission_test as s2  # noqa: E402
import wiki_accept as wa  # noqa: E402
import wiki_lineage as wl  # noqa: E402

ws = s2.ws
UPSTREAM_SHA = "d" * 40
DATE = "2026-11-20"
FORK_IDENTITIES = ["example-partner", "upstream-repo", "partner-one", "source-repo"]


def issue(body=None, labels=("wiki-attested",), blob=None):
    blob = s2.evidence() if blob is None else blob
    body = s2.submission(blob) if body is None else body
    return {"title": "[wiki-submission] one", "body": body if isinstance(body, str) else json.dumps(body),
            "user": {"id": 4242, "login": "example-partner"}, "labels": [{"name": name} for name in labels]}


def accept(document=None, net=None, allowlist=s2.ALLOW, fork_blob=None):
    blob = s2.evidence() if fork_blob is None else fork_blob
    net = net or s2.FakeNet({"wiki-evidence.json": blob})
    document = document or issue(blob=s2.evidence())
    return wa.reverify(document, upstream=s2.UPSTREAM, schema=s2.SCHEMA, canonical=s2.CANONICAL, tracked=s2.TRACKED,
                       net=net, observations=s2.OBSERVATIONS, allowlist=allowlist)


def record_for(submission, data):
    return wa.lineage_record(number=7, digest=hashlib.sha256(data).hexdigest(), submission=submission, upstream=UPSTREAM_SHA, date=DATE)


def tree_text(root):
    return "\n".join(p.read_text(encoding="utf-8") for p in sorted(Path(root).rglob("*")) if p.is_file() and ".git" not in p.parts)


class AcceptTests(unittest.TestCase):
    def test_accept_writes_one_content_addressed_file_and_a_lineage_record(self):
        submission, data = accept()
        record = record_for(submission, data)
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as tmp:
            written = wa.write_files(Path(tmp), data, record)
            self.assertEqual(sorted(written), [f"wiki-evidence/{digest}.json", f"wiki-evidence/{digest}.lineage.json"])
            self.assertEqual((Path(tmp) / f"wiki-evidence/{digest}.json").read_bytes(), data)
        self.assertEqual(record, {"schema": "rsr/wiki-lineage@1", "submission": 7, "evidence_sha256": digest, "platform": "linux-x64",
                                  "tests": ["test/alpha.mjs", "test/beta.mjs"], "upstream_commit": UPSTREAM_SHA, "attested": DATE})

    def test_label_set_by_hand_without_a_valid_record_is_rejected(self):
        bad = issue(body={"schema": "rsr/wiki-submission@1"})
        with self.assertRaises((wa.Refuse, ws.Reject)):
            accept(bad)
        unknown = s2.submission(s2.evidence())
        unknown["tests"] = [{"id": "test/nope.mjs", "result": "passed"}]
        with self.assertRaises((wa.Refuse, ws.Reject)):
            accept(issue(body=unknown))

    def test_a_missing_label_is_rejected(self):
        with self.assertRaises(wa.Refuse) as caught:
            accept(issue(labels=("wiki-not-attested",)))
        self.assertEqual(str(caught.exception), "no-attested-label")

    def test_an_unlisted_submitter_is_rejected(self):
        for allowlist in (None, "", "someone-else:1"):
            with self.assertRaises(wa.Refuse) as caught:
                accept(allowlist=allowlist)
            self.assertEqual(str(caught.exception), "not-authorized")

    def test_tampered_evidence_is_rejected(self):
        tampered = s2.evidence(platform="linux-x64", cases=[{"file": "test/alpha.mjs", "name": "z", "status": "passed"}])
        with self.assertRaises(ws.Reject) as caught:
            accept(fork_blob=tampered, document=issue(blob=s2.evidence()))
        self.assertEqual(caught.exception.code, "hash-mismatch")
        submission, data = accept()
        record = record_for(submission, data)
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(wa.Refuse) as swapped:
            wa.write_files(Path(tmp), data + b" ", record)
        self.assertEqual(str(swapped.exception), "hash-mismatch")

    def test_a_record_that_names_the_fork_is_refused(self):
        leaky = s2.evidence(cases=[{"file": "test/alpha.mjs", "name": "example-partner", "status": "passed"}, {"file": "test/beta.mjs", "name": "c", "status": "skipped"}])
        with self.assertRaises(wa.Refuse) as caught:
            accept(document=issue(blob=leaky), fork_blob=leaky)
        self.assertEqual(str(caught.exception), "evidence-names-the-fork")

    def test_path_safety(self):
        for digest in ("../../etc/passwd", "A" * 64, "a" * 63, "a" * 64 + "/x", "", "a" * 64 + "\n"):
            with self.assertRaises(wa.Refuse):
                wa.evidence_path(digest)
        self.assertEqual(wa.evidence_path("a" * 64), "wiki-evidence/" + "a" * 64 + ".json")

    def test_the_same_record_twice_makes_no_second_file(self):
        submission, data = accept()
        record = record_for(submission, data)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(len(wa.write_files(Path(tmp), data, record)), 2)
            self.assertEqual(wa.write_files(Path(tmp), data, record), [])
            self.assertEqual(len(list((Path(tmp) / "wiki-evidence").iterdir())), 2)
            changed = dict(record, submission=8)
            with self.assertRaises(wa.Refuse):
                wa.write_files(Path(tmp), data, changed)

    def test_the_pull_request_uses_templates_and_names_no_fork(self):
        hostile = s2.submission(s2.evidence(), generator="9.9.9")
        submission, data = accept(issue(body=hostile))
        record = record_for(submission, data)
        calls = []
        wa.open_pull_request(ROOT, ["wiki-evidence/x.json"], record, run=lambda command, **kw: calls.append(command))
        digest = record["evidence_sha256"]
        self.assertEqual(calls[-1], ["gh", "pr", "create", "--base", "develop", "--head", f"agents/wiki-evidence-{digest[:12]}",
                                     "--title", f"Accept wiki evidence {digest[:12]} from submission #7",
                                     "--body", wa.BODY.format(digest=digest, issue=7, platform="linux-x64", upstream=UPSTREAM_SHA)])
        text = json.dumps(calls)
        for name in FORK_IDENTITIES:
            self.assertNotIn(name, text)
        self.assertNotIn("9.9.9", text)

    def test_zero_or_two_canonical_evidence_files_are_refused(self):
        blob = s2.evidence()
        entry = lambda path: {"path": path, "sha256": hashlib.sha256(blob).hexdigest()}
        two = s2.submission(blob, evidence=[entry("wiki-evidence.json"), entry("second-evidence.json")])
        net = s2.FakeNet({"wiki-evidence.json": blob, "second-evidence.json": blob})
        canonical = dict(s2.CANONICAL, evidence=["wiki-evidence.json", "second-evidence.json"])
        with mock.patch.object(s2, "CANONICAL", canonical), self.assertRaises(wa.Refuse) as caught:
            accept(issue(body=two), net=net)
        self.assertEqual(str(caught.exception), "evidence-not-single")
        with mock.patch.object(s2, "CANONICAL", dict(s2.CANONICAL, evidence=[])), self.assertRaises((wa.Refuse, ws.Reject)):
            accept()

    def test_evidence_naming_only_the_fork_repository_is_refused(self):
        leaky = s2.evidence(cases=[{"file": "test/alpha.mjs", "name": "upstream-repo", "status": "passed"}, {"file": "test/beta.mjs", "name": "c", "status": "skipped"}])
        self.assertNotIn(b"example-partner", leaky)
        with self.assertRaises(wa.Refuse) as caught:
            accept(document=issue(blob=leaky), fork_blob=leaky)
        self.assertEqual(str(caught.exception), "evidence-names-the-fork")

    def test_open_pull_request_runs_exactly_these_commands(self):
        submission, data = accept()
        record = record_for(submission, data)
        digest = record["evidence_sha256"]
        files = [f"wiki-evidence/{digest}.json", f"wiki-evidence/{digest}.lineage.json"]
        calls = []
        result = wa.open_pull_request(ROOT, files, record, run=lambda command, **kw: calls.append((command, kw)))
        title = f"Accept wiki evidence {digest[:12]} from submission #7"
        branch = f"agents/wiki-evidence-{digest[:12]}"
        expected = [["git", "checkout", "-b", branch], ["git", "add", "--", *files], ["git", "commit", "-m", title], ["git", "push", "origin", branch],
                    ["gh", "pr", "create", "--base", "develop", "--head", branch, "--title", title,
                     "--body", wa.BODY.format(digest=digest, issue=7, platform="linux-x64", upstream=UPSTREAM_SHA)]]
        self.assertEqual([command for command, _ in calls], expected)
        self.assertEqual(result, expected)
        self.assertTrue(all(kw == {"cwd": ROOT, "check": True} for _, kw in calls))

    def test_lineage_record_refuses_a_bad_platform_date_or_upstream_sha(self):
        submission, data = accept()
        digest = hashlib.sha256(data).hexdigest()
        good = dict(number=7, digest=digest, submission=submission, upstream=UPSTREAM_SHA, date=DATE)
        self.assertEqual(wa.lineage_record(**good)["attested"], DATE)
        bad = [dict(good, submission=dict(submission, platform="Linux X64")), dict(good, date="20/11/2026"), dict(good, date="2026-11-20\n"),
               dict(good, upstream="d" * 39), dict(good, upstream="D" * 40), dict(good, number=0), dict(good, number="7")]
        for changes in bad:
            with self.assertRaises(wa.Refuse) as caught:
                wa.lineage_record(**changes)
            self.assertEqual(str(caught.exception), "record-invalid")


class RenderTests(unittest.TestCase):
    def make(self, tmp, with_record=True):
        root, wiki = Path(tmp) / "root", Path(tmp) / "wiki"
        (root / "docs/requirements").mkdir(parents=True)
        (root / "wiki-evidence").mkdir()
        (wiki / "tests").mkdir(parents=True)
        (root / "docs/requirements/rtm.csv").write_text("ReqID,TestID,CodeRef\nR1,T-001,test/alpha.mjs;src/a.ts\nR2,T-002,test/other.mjs\n", encoding="utf-8")
        for name in ("T-001", "T-002", "T-003"):
            (wiki / "tests" / f"{name}.md").write_text(f"# {name}\n\nbody\n", encoding="utf-8")
        if with_record:
            submission, data = accept()
            record = record_for(submission, data)
            wa.write_files(root, data, record)
        return root, wiki

    def test_pages_show_the_label_and_lineage_or_not_attested(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, wiki = self.make(tmp)
            self.assertEqual(wl.apply(wiki, root), 1)
            covered = (wiki / "tests/T-001.md").read_text(encoding="utf-8")
            digest = hashlib.sha256(s2.evidence()).hexdigest()
            self.assertIn(f"**Attestation:** attested at {UPSTREAM_SHA}", covered)
            self.assertIn(f"submission #7, evidence sha256 `{digest}`", covered)
            for other in ("T-002", "T-003"):
                page = (wiki / f"tests/{other}.md").read_text(encoding="utf-8")
                self.assertIn("**Attestation:** not attested", page)
                self.assertNotIn("attested at", page)

    def test_rendering_is_deterministic_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, wiki = self.make(tmp)
            wl.apply(wiki, root)
            first = tree_text(wiki)
            wl.apply(wiki, root)
            self.assertEqual(tree_text(wiki), first)
            self.assertEqual(first.count(wl.MARKER), 3)

    def test_without_records_every_page_is_not_attested(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, wiki = self.make(tmp, with_record=False)
            self.assertEqual(wl.apply(wiki, root), 0)
            self.assertNotIn("attested at", tree_text(wiki))

    def test_an_invalid_record_stops_the_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, wiki = self.make(tmp)
            (root / "wiki-evidence" / ("b" * 64 + ".lineage.json")).write_text('{"schema": "x"}', encoding="utf-8")
            with self.assertRaises(SystemExit):
                wl.apply(wiki, root)

    def test_canary_no_fork_identity_in_the_tree_or_the_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, wiki = self.make(tmp)
            wl.apply(wiki, root)
            text = tree_text(root) + tree_text(wiki)
            for name in FORK_IDENTITIES:
                self.assertNotIn(name, text)
        self.assertIs(wl.SHOW_FORK, False)

    def test_a_lineage_file_whose_hash_differs_from_its_name_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, wiki = self.make(tmp)
            good = next((root / "wiki-evidence").glob("*.lineage.json"))
            (root / "wiki-evidence" / ("c" * 64 + ".lineage.json")).write_bytes(good.read_bytes())
            with self.assertRaises(SystemExit):
                wl.load_records(root)

    def test_two_records_on_one_page_show_the_newest_and_sorted_lineage(self):
        def add(root, digest, submission, upstream, date):
            record = {"schema": "rsr/wiki-lineage@1", "submission": submission, "evidence_sha256": digest, "platform": "linux-x64",
                      "tests": ["test/alpha.mjs"], "upstream_commit": upstream, "attested": date}
            (root / "wiki-evidence" / f"{digest}.lineage.json").write_text(json.dumps(record), encoding="utf-8")
        outputs = []
        for order in (("1", "2", "3"), ("3", "2", "1")):
            with tempfile.TemporaryDirectory() as tmp:
                root, wiki = self.make(tmp, with_record=False)
                rows = {"1": ("1" * 64, 11, "a" * 40, "2026-11-19"), "2": ("2" * 64, 12, "f" * 40, "2026-11-20"), "3": ("3" * 64, 13, "b" * 40, "2026-11-20")}
                for key in order:
                    add(root, *rows[key])
                wl.apply(wiki, root)
                outputs.append((wiki / "tests/T-001.md").read_text(encoding="utf-8"))
        self.assertEqual(outputs[0], outputs[1])
        page = outputs[0]
        self.assertIn("**Attestation:** attested at " + "f" * 40, page)
        self.assertLess(page.index("1" * 64), page.index("2" * 64))
        self.assertLess(page.index("2" * 64), page.index("3" * 64))

    def test_block_sorts_lineage_lines_whatever_the_input_order(self):
        rows = [{"submission": n, "evidence_sha256": d * 64, "upstream_commit": "a" * 40, "attested": DATE} for n, d in ((3, "3"), (1, "1"), (2, "2"))]
        self.assertEqual(wl.block(rows), wl.block(list(reversed(rows))))
        text = wl.block(rows)
        self.assertLess(text.index("1" * 64), text.index("2" * 64))
        self.assertLess(text.index("2" * 64), text.index("3" * 64))


if __name__ == "__main__":
    unittest.main()
