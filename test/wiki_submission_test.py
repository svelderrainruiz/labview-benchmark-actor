"""Offline fixtures for scripts/wiki_submission.py. Every fixture is synthetic; the network is a fake that only returns data."""
import base64
import contextlib
import copy
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import wiki_submission as ws  # noqa: E402

UPSTREAM = "example-org/upstream-repo"
FORK = "example-partner/upstream-repo"
FORK_SHA, BASE_SHA = "a" * 40, "b" * 40
SCHEMA = json.loads((ROOT / "scripts" / "wiki-submission.schema.json").read_text(encoding="utf-8"))
CANONICAL = {"evidence": ["wiki-evidence.json"], "testFiles": ["\\.selftest\\.mjs$", "^test/[^/]+\\.mjs$"]}
TRACKED = ["README.md", "test/alpha.mjs", "test/beta.mjs", "tools/x.selftest.mjs"]
ALLOW = "example-partner:4242"
CANARY = "canary-login-zq"
OBSERVATIONS = ws.load_observations()


def evidence(**changes):
    document = {"schema": "rsr/test-evidence@1", "commit": FORK_SHA, "platform": "linux-x64", "format": "jest-json",
                "cases": [{"file": "test/alpha.mjs", "name": "a", "status": "passed"},
                          {"file": "test/alpha.mjs", "name": "b", "status": "passed"},
                          {"file": "test/beta.mjs", "name": "c", "status": "skipped"}]}
    document.update(changes)
    return json.dumps(document).encode()


class FakeNet:
    def __init__(self, files, **changes):
        self.files = files
        self.info = {"fork": True, "parents": [UPSTREAM], "owner_id": 4242, "owner_login": "Example-Partner"}
        self.members = set()
        self.commits = {(FORK, FORK_SHA), (UPSTREAM, BASE_SHA)}
        self.calls = []
        self.__dict__.update(changes)

    def repo(self, slug):
        self.calls.append(("repo", slug))
        return self.info

    def public_member(self, org, login):
        self.calls.append(("member", org))
        return (org.lower(), login.lower()) in self.members

    def commit_exists(self, slug, sha):
        self.calls.append(("commit", slug))
        return (slug, sha) in self.commits

    def file(self, slug, path, ref):
        self.calls.append(("file", path))
        data = self.files.get(path)
        if data is None:
            return None
        if isinstance(data, dict):
            return data
        return {"type": "file", "size": len(data), "encoding": "base64", "content": base64.b64encode(data).decode()}


def submission(blob, **changes):
    document = {"schema": "rsr/wiki-submission@1", "fork": FORK, "fork_commit": FORK_SHA, "upstream_base": BASE_SHA,
                "generator": "1.2.3", "platform": "linux-x64",
                "tests": [{"id": "test/alpha.mjs", "result": "passed"}, {"id": "test/beta.mjs", "result": "skipped"}],
                "evidence": [{"path": "wiki-evidence.json", "sha256": hashlib.sha256(blob).hexdigest()}],
                "lineage": {"source_repo": "partner-one/source-repo", "source_commit": "c" * 40}}
    document.update(changes)
    return document


def run(body, net=None, user=None, title="[wiki-submission] one", blob=None):
    blob = evidence() if blob is None else blob
    net = net or FakeNet({"wiki-evidence.json": blob})
    text = body if isinstance(body, str) else json.dumps(body)
    event = {"issue": {"title": title, "body": text, "user": user or {"id": 4242, "login": "example-partner"}}}
    try:
        return ws.verify(event, upstream=UPSTREAM, schema=SCHEMA, canonical=CANONICAL, tracked=TRACKED,
                         net=net, observations=OBSERVATIONS), net
    except ws.Reject as error:
        return error.code, net


def event_for(body=None, user=None):
    text = json.dumps(submission(evidence())) if body is None else body
    return {"issue": {"title": "[wiki-submission] x", "body": text, "user": user or {"id": 4242, "login": "example-partner"}}}


def auth(allow, event=None, net=None):
    net = net or FakeNet({})
    return ws.authorized(event or event_for(), allow, SCHEMA["x-limits"], net), net


def cli(mode, event, allow, net, upstream_sha="e" * 40):
    """Drive ws.main() with a fake network; return what a workflow log and its outputs would hold."""
    with tempfile.TemporaryDirectory() as temp:
        path, out = Path(temp) / "event.json", Path(temp) / "out"
        path.write_text(json.dumps(event))
        env = {"GITHUB_REPOSITORY": UPSTREAM, "GITHUB_SHA": upstream_sha, "GITHUB_OUTPUT": str(out), "GITHUB_EVENT_PATH": str(path)}
        if allow is not None:
            env["SUBMISSION_ALLOWLIST"] = allow
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env), mock.patch.object(sys, "argv", ["wiki_submission.py", mode]), \
                mock.patch.object(ws, "GitHubApi", lambda token: net), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = ws.main()
        return code, stdout.getvalue(), stderr.getvalue(), out.read_text() if out.exists() else ""


class Raising(FakeNet):
    def repo(self, slug):
        raise RuntimeError(CANARY)


class Authorization(unittest.TestCase):
    def test_owner_who_is_the_author_is_authorized(self):
        for allow in ("example-partner", "EXAMPLE-PARTNER", "x-other,example-partner:4242", "example-partner:4242,x-other"):
            self.assertTrue(auth(allow)[0], allow)

    def test_public_org_member_is_authorized_only_when_public(self):
        member = {"id": 7, "login": "some-member"}
        net = FakeNet({})
        self.assertFalse(auth("example-partner", event_for(user=member), net)[0])
        net.members.add(("example-partner", "some-member"))
        self.assertTrue(auth("example-partner", event_for(user=member), net)[0])

    def test_failures(self):
        stranger = event_for(user={"id": 7, "login": "stranger"})
        for allow, event in (("other-login", None), ("example-partner:999", None), ("example-partner", stranger),
                             ("example-partner:4242", stranger)):
            self.assertFalse(auth(allow, event)[0], allow)
        net = FakeNet({}, info={"fork": True, "parents": [UPSTREAM], "owner_id": 4242, "owner_login": "someone-else"})
        self.assertFalse(auth("example-partner", net=net)[0])
        self.assertFalse(auth("example-partner", net=FakeNet({}, info=None))[0])
        self.assertFalse(auth("example-partner", event_for("not json"))[0])
        self.assertFalse(auth("example-partner", event_for(json.dumps({"fork": "../x"})))[0])
        self.assertFalse(auth("example-partner", net=Raising({}))[0])
        self.assertFalse(auth("example-partner", {"issue": None})[0])

    def test_unset_empty_and_garbage_lists_reject_everything(self):
        for allow in (None, "", " ", ",", "a,,example-partner", "example-partner,", "example-partner, other", "example partner",
                      "example-partner:", "example-partner:12x", "example-partner:-1", "ex@mple", "../x", "example-partner\nother",
                      "example-partner;other", 5, ["example-partner"]):
            ok, net = auth(allow)
            self.assertFalse(ok, repr(allow))
            self.assertEqual(net.calls, [], repr(allow))

    def test_rejection_happens_before_any_evidence_fetch(self):
        for allow in ("other-login", "example-partner:999"):
            _, net = auth(allow)
            self.assertFalse([call for call in net.calls if call[0] == "file"])

    def test_canary_never_appears_in_any_output_or_in_the_tree(self):
        owner = {"id": 4242, "login": CANARY}
        allow = f"{CANARY}:4242,other-login"
        body = json.dumps(submission(evidence(), fork=CANARY + "/upstream-repo"))
        info = {"fork": True, "parents": [UPSTREAM], "owner_id": 4242, "owner_login": CANARY}
        files = {"wiki-evidence.json": evidence()}
        cases = [
            ("gate", event_for(body, owner), allow, FakeNet({}, info=info)),
            ("gate", event_for(body, {"id": 7, "login": "stranger"}), allow, FakeNet({}, info=info)),
            ("gate", event_for("not json", owner), allow, FakeNet({}, info=info)),
            ("gate", event_for(body, owner), allow, Raising({})),
            ("gate", event_for(body, owner), f"{CANARY}:1", FakeNet({}, info=info)),
            ("gate", event_for(body, owner), f"{CANARY},,x", FakeNet({}, info=info)),
            ("gate", event_for(body, owner), None, FakeNet({}, info=info)),
            ("verify", event_for(body, owner), allow, FakeNet(files, info=info)),
            ("verify", event_for(body, owner), allow, Raising({})),
            ("verify", event_for("not json", owner), allow, FakeNet(files, info=info)),
        ]
        for mode, event, listed, net in cases:
            code, stdout, stderr, output = cli(mode, event, listed, net)
            self.assertEqual(code, 0)
            for stream in (stdout, stderr, output):
                self.assertNotIn(CANARY, stream)
        for root, dirs, names in os.walk(ROOT):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "coverage")]
            for name in names:
                path = Path(root) / name
                if path != Path(__file__).resolve():
                    self.assertNotIn(CANARY.encode(), path.read_bytes(), str(path.relative_to(ROOT)))

    def test_no_oracle_all_authorization_failures_look_the_same(self):
        owner_body = json.dumps(submission(evidence()))
        scenarios = [
            (None, event_for(), FakeNet({})),
            ("other-login", event_for(), FakeNet({})),
            ("example-partner:999", event_for(), FakeNet({})),
            ("example-partner", event_for(user={"id": 7, "login": "stranger"}), FakeNet({})),
            ("example-partner", event_for("not json"), FakeNet({})),
            ("example-partner", event_for(owner_body), Raising({})),
            ("example-partner", event_for(owner_body), FakeNet({}, info=None)),
            ("a,,b", event_for(), FakeNet({})),
        ]
        results = {cli("gate", event, allow, net)[1:] for allow, event, net in scenarios}
        self.assertEqual(results, {('{"authorized": "no"}\n', "", "authorized=no\n")})
        self.assertEqual(cli("gate", event_for(), "example-partner", FakeNet({}))[3], "authorized=yes\n")

    def test_the_secret_reaches_only_the_gate_job(self):
        workflow = (ROOT / ".github" / "workflows" / "wiki-submission-ingest.yml").read_text(encoding="utf-8")
        self.assertEqual(workflow.count("secrets.SUBMISSION_ALLOWLIST"), 1)
        self.assertEqual(workflow.count("SUBMISSION_ALLOWLIST"), 2)
        self.assertTrue(workflow.index("  gate:") < workflow.index("secrets.SUBMISSION_ALLOWLIST") < workflow.index("  verify:"))
        self.assertNotIn("vars.", workflow)
        self.assertNotIn("pull_request_target", workflow.replace("Never pull_request_target", ""))
        self.assertNotIn("github.event.issue.body", workflow)
        self.assertNotIn("github.event.issue.user", workflow)
        self.assertEqual(workflow.count("github.event.issue.title"), 1)


class WikiSubmission(unittest.TestCase):
    def test_accept(self):
        self.assertEqual(run(submission(evidence()))[0], "ok")

    def test_reject_bad_schema(self):
        good = submission(evidence())
        for bad in ({**good, "extra": 1}, {**good, "fork_commit": "main"}, {**good, "fork_commit": "A" * 40},
                    {**good, "tests": []}, {**good, "platform": "../x"}, {**good, "evidence": good["evidence"] * 9}):
            self.assertEqual(run(bad)[0], "schema-invalid")
        self.assertEqual(run("not json")[0], "body-not-json")
        self.assertEqual(run('{"a": NaN}')[0], "body-not-json")

    def test_oversize_body(self):
        self.assertEqual(run(" " * (SCHEMA["x-limits"]["bodyBytes"] + 1))[0], "body-too-large")

    def test_oversize_file_and_total(self):
        big = b"x" * (SCHEMA["x-limits"]["fileBytes"] + 1)
        reason, _ = run(submission(big), net=FakeNet({"wiki-evidence.json": big}))
        self.assertEqual(reason, "file-too-large")
        lie = {"type": "file", "size": 5, "encoding": "base64", "content": base64.b64encode(big).decode()}
        self.assertEqual(run(submission(big), net=FakeNet({"wiki-evidence.json": lie}))[0], "file-too-large")
        huge = {"type": "file", "size": 5 << 20, "encoding": "none", "content": ""}
        self.assertEqual(run(submission(big), net=FakeNet({"wiki-evidence.json": huge}))[0], "file-too-large")
        chunk = b"y" * 200000
        extra = [{"path": f"e{i}.json", "sha256": hashlib.sha256(chunk).hexdigest()} for i in range(6)]
        blob = evidence()
        files = {"wiki-evidence.json": blob, **{e["path"]: chunk for e in extra}}
        body = submission(blob)
        body["evidence"] += extra
        self.assertEqual(run(body, net=FakeNet(files))[0], "total-too-large")

    def test_tampered_hash(self):
        body = submission(evidence())
        body["evidence"][0]["sha256"] = "0" * 64
        self.assertEqual(run(body)[0], "hash-mismatch")
        self.assertEqual(run(submission(evidence()), net=FakeNet({"wiki-evidence.json": evidence(platform="win-x64")}))[0], "hash-mismatch")

    def test_duplicate_keys_and_depth(self):
        text = json.dumps(submission(evidence()))[:-1] + ', "fork": "other/x"}'
        self.assertEqual(run(text)[0], "duplicate-key")
        self.assertEqual(run("[" * 50 + "]" * 50)[0], "too-deep")
        self.assertEqual(run("[" * 30000 + "]" * 30000)[0], "too-deep")

    def test_path_traversal_and_symlink(self):
        for path in ("../x.json", "/etc/passwd", "a/../b", "a//b", "a\\b", "./x"):
            body = submission(evidence())
            body["evidence"][0]["path"] = path
            self.assertIn(run(body)[0], ("schema-invalid", "path-invalid"))
        self.assertTrue(ws.safe_path("a/b.json") and not ws.safe_path("a/../b") and not ws.safe_path("/a"))
        link = {"type": "symlink", "size": 5, "encoding": "base64", "content": ""}
        self.assertEqual(run(submission(evidence()), net=FakeNet({"wiki-evidence.json": link}))[0], "not-a-regular-file")

    def test_evidence_must_include_canonical_file_and_exist(self):
        blob = evidence()
        body = submission(blob)
        body["evidence"][0]["path"] = "other.json"
        self.assertEqual(run(body, net=FakeNet({"other.json": blob}))[0], "evidence-missing")
        self.assertEqual(run(submission(blob), net=FakeNet({}))[0], "evidence-missing")

    def test_test_id_unknown_to_upstream(self):
        body = submission(evidence(), tests=[{"id": "test/mine.mjs", "result": "passed"}])
        self.assertEqual(run(body)[0], "test-unknown")
        body = submission(evidence(), tests=[{"id": "README.md", "result": "passed"}])
        self.assertEqual(run(body)[0], "test-unknown")

    def test_result_commit_and_platform_must_match_evidence(self):
        self.assertEqual(run(submission(evidence(), tests=[{"id": "test/alpha.mjs", "result": "failed"}]))[0], "result-mismatch")
        blob = evidence(commit="d" * 40)
        self.assertEqual(run(submission(blob), blob=blob)[0], "evidence-commit-mismatch")
        blob = evidence(platform="win-x64")
        self.assertEqual(run(submission(blob), blob=blob)[0], "platform-mismatch")
        blob = b'{"schema": "x"}'
        self.assertEqual(run(submission(blob), blob=blob)[0], "evidence-invalid")

    def test_fork_checks(self):
        blob = evidence()
        files = {"wiki-evidence.json": blob}
        body = submission(blob)
        self.assertEqual(run(body, net=FakeNet(files, info={"fork": False, "parents": [], "owner_id": 4242}))[0], "not-a-fork")
        self.assertEqual(run(body, net=FakeNet(files, info={"fork": True, "parents": ["other/x"], "owner_id": 4242}))[0], "not-a-fork")
        self.assertEqual(run(body, net=FakeNet(files, info=None))[0], "not-a-fork")
        self.assertEqual(run(body, net=FakeNet(files, commits={(UPSTREAM, BASE_SHA)}))[0], "commit-missing")
        self.assertEqual(run(body, net=FakeNet(files, commits={(FORK, FORK_SHA)}))[0], "base-commit-missing")

    def test_network_failure_is_a_reason_not_a_crash(self):
        class Broken(FakeNet):
            def file(self, *args):
                raise OSError("boom")
        self.assertEqual(run(submission(evidence()), net=Broken({}))[0], "fetch-failed")

    def test_title_gate_and_reason_vocabulary(self):
        self.assertEqual(run(submission(evidence()), title="hello")[0], "not-a-submission")
        codes = set(ws.REASONS)
        source = (ROOT / "scripts" / "wiki_submission.py").read_text(encoding="utf-8")
        used = set(__import__("re").findall(r'Reject\("([a-z-]+)"\)', source))
        self.assertTrue(used <= codes, used - codes)

    def test_no_fork_code_is_executed(self):
        source = (ROOT / "scripts" / "wiki_submission.py").read_text(encoding="utf-8")
        for forbidden in ("subprocess", "exec(", "eval(", "checkout", "os.system", "pickle"):
            self.assertNotIn(forbidden, source)


class Cli(unittest.TestCase):
    def test_unset_allow_list_gives_unauthorized_in_a_real_process(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            event, out = Path(temp) / "event.json", Path(temp) / "out"
            event.write_text(json.dumps(event_for()))
            env = {k: v for k, v in os.environ.items() if k != "SUBMISSION_ALLOWLIST"}
            env.update({"GITHUB_REPOSITORY": UPSTREAM, "GITHUB_SHA": "e" * 40, "GITHUB_OUTPUT": str(out)})
            done = subprocess.run([sys.executable, "-B", str(ROOT / "scripts" / "wiki_submission.py"), "gate", "--event", str(event)],
                                  env=env, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(done.stdout), {"authorized": "no"})
            self.assertEqual(out.read_text(), "authorized=no\n")


if __name__ == "__main__":
    unittest.main()
