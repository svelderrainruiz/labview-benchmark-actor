#!/usr/bin/env python3
"""Verify one rsr/wiki-submission@1 issue against upstream: attested or not-attested, with a fixed reason code.

Fork content is data. This script never checks out, imports or runs anything from a fork: it fetches evidence
files as bytes through the GitHub contents API at the pinned fork commit and compares them with what upstream owns
(.wiki-canonical.json, scripts/wiki-submission.schema.json and its own test files).
Needs only Python 3.9+."""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import importlib.util
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TITLE_PREFIX = "[wiki-submission]"
REASONS = frozenset({
    "ok", "not-a-submission", "not-authorized",
    "body-too-large", "body-not-json", "duplicate-key", "too-deep", "schema-invalid", "not-a-fork",
    "commit-missing", "base-commit-missing", "path-invalid", "not-a-regular-file", "file-too-large", "total-too-large",
    "fetch-failed", "hash-mismatch", "evidence-missing", "evidence-invalid", "evidence-commit-mismatch", "platform-mismatch",
    "test-unknown", "result-mismatch", "config-invalid", "evidence-commit-unrelated", "internal-error"})
SLUG = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")
SHA = re.compile(r"^[0-9a-f]{40}$")
RANK = {"passed": 1, "skipped": 0, "failed": 2}


class Reject(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def load_observations():
    spec = importlib.util.spec_from_file_location("observations", ROOT / ".repo-standards-review" / "observations.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("observations", module)
    spec.loader.exec_module(module)
    return module


def strict_object(pairs: list) -> dict:
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise Reject("duplicate-key")
    return dict(pairs)


def parse_body(body: object, limits: dict) -> dict:
    data = body.encode("utf-8") if isinstance(body, str) else b""
    if len(data) > limits["bodyBytes"]:
        raise Reject("body-too-large")
    try:
        document = json.loads(data.decode("utf-8"), object_pairs_hook=strict_object,
                              parse_constant=lambda name: (_ for _ in ()).throw(ValueError(name)))
    except Reject:
        raise
    except RecursionError:
        raise Reject("too-deep") from None
    except ValueError:
        raise Reject("body-not-json") from None
    if depth(document) > limits["depth"]:
        raise Reject("too-deep")
    return document


def depth(value: object) -> int:
    deepest, stack = 0, [(value, 1)]
    while stack:
        item, level = stack.pop()
        deepest = max(deepest, level)
        if deepest > 64:
            break
        children = item.values() if isinstance(item, dict) else item if isinstance(item, list) else ()
        stack.extend((child, level + 1) for child in children)
    return deepest


def conforms(schema: dict, value: object) -> bool:
    """The subset of JSON Schema that scripts/wiki-submission.schema.json uses; the schema file is the single source of the limits."""
    if "const" in schema and value != schema["const"]:
        return False
    if "enum" in schema and value not in schema["enum"]:
        return False
    kind = schema.get("type")
    if kind == "string":
        return (isinstance(value, str) and len(value) <= schema.get("maxLength", 4096)
                and ("pattern" not in schema or re.search(schema["pattern"], value) is not None and "\n" not in value))
    if kind == "array":
        return (isinstance(value, list) and schema.get("minItems", 0) <= len(value) <= schema["maxItems"]
                and all(conforms(schema["items"], item) for item in value))
    if kind == "object":
        if not isinstance(value, dict) or set(value) - set(schema["properties"]) or not set(schema.get("required", ())) <= set(value):
            return False
        return all(conforms(schema["properties"][key], item) for key, item in value.items())
    return kind is None


def load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Reject("config-invalid") from None


LOGIN = re.compile(r"^[A-Za-z0-9-]{1,39}$")
ENTRY = re.compile(r"^([A-Za-z0-9-]{1,39})(?::([0-9]{1,12}))?$")


def parse_allowlist(text: object) -> list:
    """`login` or `login:numeric-id` entries, comma separated. Any unparsable token rejects everything."""
    entries = []
    for token in (text.strip() if isinstance(text, str) else "").split(","):
        match = ENTRY.fullmatch(token)
        if match is None:
            return []
        entries.append((match.group(1).lower(), int(match.group(2)) if match.group(2) else None))
    return entries


def is_id(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def attempt(call, *args):
    try:
        return call(*args)
    except Exception:
        return None


DUMMY_REPO, DUMMY_LOGIN = "octocat/Hello-World", "octocat"


def authorized(event: dict, allowlist: object, limits: dict, net) -> bool:
    """The fork owner is listed, and the issue author is that owner or a public member of the owning organisation.

    Every path makes the same two API calls, with fixed dummies when a real value is missing, and combines the checks
    without early returns, so neither the result nor the timing tells which part failed or whether a login is listed."""
    entries = parse_allowlist(allowlist)
    issue = event.get("issue") if isinstance(event, dict) else None
    issue = issue if isinstance(issue, dict) else {}
    user = issue.get("user") if isinstance(issue.get("user"), dict) else {}
    author_id, login = user.get("id"), user.get("login")
    author_ok = is_id(author_id) and isinstance(login, str) and bool(LOGIN.fullmatch(login))
    record = attempt(parse_body, issue.get("body"), limits)
    fork = record.get("fork") if isinstance(record, dict) else None
    fork_ok = isinstance(fork, str) and bool(SLUG.fullmatch(fork))
    slug = fork if fork_ok else DUMMY_REPO
    owner = slug.split("/")[0]
    info = attempt(net.repo, slug)
    member = attempt(net.public_member, owner, login if author_ok else DUMMY_LOGIN)
    info = info if isinstance(info, dict) else {}
    owner_id = info.get("owner_id")
    owner_ok = is_id(owner_id) and str(info.get("owner_login", "")).lower() == owner.lower()
    listed = any(name == owner.lower() and (pinned is None or pinned == owner_id) for name, pinned in entries)
    related = (author_id == owner_id) or member is True
    return bool(entries) & author_ok & fork_ok & owner_ok & listed & related


def safe_path(path: str) -> bool:
    parts = path.split("/")
    return not path.startswith("/") and "\\" not in path and all(part not in ("", ".", "..") for part in parts)


def fetch_evidence(net, fork: str, commit: str, entries: list, limits: dict) -> dict:
    total, blobs = 0, {}
    for entry in entries:
        path = entry["path"]
        if not safe_path(path):
            raise Reject("path-invalid")
        try:
            info = net.file(fork, path, commit)
        except Exception:
            raise Reject("fetch-failed") from None
        if info is None:
            raise Reject("evidence-missing")
        if info.get("type") != "file":
            raise Reject("not-a-regular-file")
        size = info.get("size")
        if not isinstance(size, int) or size > limits["fileBytes"]:
            raise Reject("file-too-large")
        try:
            data = base64.b64decode(info.get("content") or "", validate=False) if info.get("encoding") == "base64" else None
        except (binascii.Error, ValueError):
            data = None
        if data is None:
            raise Reject("fetch-failed")
        if len(data) > limits["fileBytes"]:
            raise Reject("file-too-large")
        total += len(data)
        if total > limits["totalBytes"]:
            raise Reject("total-too-large")
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise Reject("hash-mismatch")
        blobs[path] = data
    return blobs


def check_evidence(observations, canonical: dict, blobs: dict, submission: dict, known_tests: set) -> None:
    names = [path for path in blobs if path in canonical.get("evidence", [])]
    if not names:
        raise Reject("evidence-missing")
    outcomes: dict = {}
    for name in names:
        try:
            document = json.loads(blobs[name].decode("utf-8"), object_pairs_hook=strict_object)
        except (ValueError, Reject):
            raise Reject("evidence-invalid") from None
        if observations.evidence_problem(document) is not None:
            raise Reject("evidence-invalid")
        if document["commit"] != submission["fork_commit"]:
            raise Reject("evidence-commit-mismatch")
        if document["platform"] != submission["platform"]:
            raise Reject("platform-mismatch")
        for case in document["cases"]:
            status = case["status"]
            outcomes[case["file"]] = max(outcomes.get(case["file"], "skipped"), status, key=RANK.__getitem__)
    seen = set()
    for test in submission["tests"]:
        if test["id"] not in known_tests or test["id"] in seen:
            raise Reject("test-unknown")
        seen.add(test["id"])
        if outcomes.get(test["id"]) != test["result"]:
            raise Reject("result-mismatch")


def upstream_tests(tracked: list, canonical: dict) -> set:
    patterns = [re.compile(pattern) for pattern in canonical.get("testFiles", [])]
    return {path for path in tracked if any(pattern.search(path) for pattern in patterns)}


def verify(event: dict, *, upstream: str, schema: dict, canonical: dict, tracked: list, net, observations) -> str:
    """Return the reason code; "ok" means attested. Every check raises Reject with a code from REASONS."""
    if not isinstance(event.get("issue"), dict) or not str(event["issue"].get("title", "")).startswith(TITLE_PREFIX):
        raise Reject("not-a-submission")
    limits = schema["x-limits"]
    submission = parse_body(event["issue"].get("body"), limits)
    if not conforms(schema, submission) or not observations.PLATFORM.fullmatch(submission.get("platform", "")):
        raise Reject("schema-invalid")
    fork = submission["fork"]
    try:
        info = net.repo(fork)
        exists = info is not None and net.commit_exists(fork, submission["fork_commit"])
        base_exists = net.commit_exists(upstream, submission["upstream_base"])
    except Exception:
        raise Reject("fetch-failed") from None
    if info is None or not info.get("fork") or upstream.lower() not in [p.lower() for p in info.get("parents", [])]:
        raise Reject("not-a-fork")
    if not exists:
        raise Reject("commit-missing")
    if not base_exists:
        raise Reject("base-commit-missing")
    try:
        relation = net.compare(fork, submission["fork_commit"], submission["evidence_commit"])
    except Exception:
        raise Reject("fetch-failed") from None
    if relation is None:
        raise Reject("commit-missing")
    if relation not in ("ahead", "identical"):
        raise Reject("evidence-commit-unrelated")
    blobs = fetch_evidence(net, fork, submission["evidence_commit"], submission["evidence"], limits)
    check_evidence(observations, canonical, blobs, submission, upstream_tests(tracked, canonical))
    return "ok"


class GitHubApi:
    """Read-only GitHub API client; every call is a GET and its answer is treated as data."""

    def __init__(self, token: str | None) -> None:
        self.token = token

    def get(self, path: str, limit: int = 2 << 20):
        request = urllib.request.Request("https://api.github.com" + path, headers={"Accept": "application/vnd.github+json"})
        if self.token:
            request.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                data = response.read(limit)
        except urllib.error.HTTPError as error:
            if error.code in (404, 422):
                return None
            raise
        return json.loads(data)

    def repo(self, slug: str):
        document = self.get(f"/repos/{slug}")
        if document is None:
            return None
        parents = [(document.get(key) or {}).get("full_name") for key in ("parent", "source")]
        return {"fork": bool(document.get("fork")), "parents": [p for p in parents if p], "owner_id": (document.get("owner") or {}).get("id"),
                "owner_login": (document.get("owner") or {}).get("login")}

    def public_member(self, org: str, login: str) -> bool:
        request = urllib.request.Request(f"https://api.github.com/orgs/{org}/public_members/{login}",
                                         headers={"Accept": "application/vnd.github+json"})
        if self.token:
            request.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status == 204
        except urllib.error.HTTPError as error:
            if error.code in (302, 404):
                return False
            raise

    def commit_exists(self, slug: str, sha: str) -> bool:
        return self.get(f"/repos/{slug}/commits/{sha}") is not None

    def file(self, slug: str, path: str, ref: str):
        return as_file(self.get(f"/repos/{slug}/contents/{path}?ref={ref}"))

    def compare(self, slug: str, base: str, head: str):
        document = self.get(f"/repos/{slug}/compare/{base}...{head}?per_page=1", limit=8 << 20)
        return document.get("status") if isinstance(document, dict) else None


def as_file(document: object):
    """A missing path is None, a directory listing is a dir; only a dict can be a file."""
    if document is None:
        return None
    return document if isinstance(document, dict) else {"type": "dir", "size": 0}


def emit(lines: dict) -> None:
    print(json.dumps(lines))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write("".join(f"{key}={value}\n" for key, value in lines.items()))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=["gate", "verify"], help="gate: authorize the submitter (reads SUBMISSION_ALLOWLIST); verify: check the submission")
    parser.add_argument("--event", default=os.environ.get("GITHUB_EVENT_PATH"), help="path to the GitHub event JSON")
    options = parser.parse_args()
    upstream, sha = os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GITHUB_SHA", "")
    if not SLUG.fullmatch(upstream) or not SHA.fullmatch(sha) or not options.event:
        print("FAIL: GITHUB_REPOSITORY, GITHUB_SHA and --event are required", file=sys.stderr)
        return 2
    net = GitHubApi(os.environ.get("GITHUB_TOKEN"))
    if options.mode == "gate":
        try:
            ok = authorized(load_json(Path(options.event)), os.environ.get("SUBMISSION_ALLOWLIST"),
                            load_json(ROOT / "scripts" / "wiki-submission.schema.json")["x-limits"], net)
        except BaseException:
            ok = False
        emit({"authorized": "yes" if ok else "no"})
        return 0
    try:
        event = load_json(Path(options.event))
        if not isinstance(event, dict):
            raise Reject("config-invalid")
        schema = load_json(ROOT / "scripts" / "wiki-submission.schema.json")
        canonical = load_json(ROOT / ".wiki-canonical.json")
        with os.popen("git -C " + str(ROOT) + " ls-files") as listing:
            tracked = listing.read().split("\n")
        reason = verify(event, upstream=upstream, schema=schema, canonical=canonical, tracked=tracked, net=net,
                        observations=load_observations())
    except Reject as error:
        reason = error.code
    except BaseException:
        reason = "internal-error"
    assert reason in REASONS
    emit({"verdict": "attested" if reason == "ok" else "not-attested", "reason": reason, "upstream": sha})
    return 0


if __name__ == "__main__":
    sys.exit(main())
