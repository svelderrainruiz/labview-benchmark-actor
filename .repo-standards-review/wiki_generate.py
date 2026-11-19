#!/usr/bin/env python3
"""Generate a member's wiki from its docs/ folder (rsr/ecosystem-wiki-standard@8).

Managed by the repo-standards-review consumer kit (templates/consumer); update it
with `cruft update`. It needs only Python 3.9+. It is deterministic: the same
docs/ and configuration always give the same files, byte for byte.

Commands:
- no option: build the wiki in memory, validate it, and print a JSON summary.
- `--out <dir>`: write the wiki into `<dir>`, keeping `<dir>/.git` and pruning
  stale files.
- `--check <dir>`: exit 1 when `<dir>` differs from the generated wiki.

The configuration is a JSON file, by default `.wiki-generator.json` at the member
root (`--member-root`, default the current directory), schema
`rsr/wiki-generator-config@1`. It names the ID prefixes, the requirement
specification style (`blocks` or `table`), the RTM, the test plan, the
architecture files and the sections of each governed scope. The generator writes
`.wiki-profile.json` (`rsr/wiki-profile@2`) from the same configuration, so the
profile and the pages cannot disagree.

Output:
- a requirement page for each requirement of the specification, in the software
  scope's directory, with the configured sections in order;
- a stub test page for each test-plan row, when a test scope is configured
  (`observations.py generate` and `stimulus` replace the stubs);
- every other Markdown page of docs/, a generated traceability matrix, an ADR
  index, `Home` and `_Sidebar`;
- a page over the 16,384-byte budget becomes a hub whose children are its parts.
  A requirement page over the budget moves its largest sections to note pages.
"""

from __future__ import annotations

import argparse
import csv
import fnmatch
import io
import json
import os
import posixpath
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True

CONFIG_SCHEMA = "rsr/wiki-generator-config@1"
PROFILE_SCHEMA = "rsr/wiki-profile@2"
PROFILE_FILE = ".wiki-profile.json"
DEFAULT_CONFIG = ".wiki-generator.json"
BUDGET = 16384
TARGET = 14800
RESERVED_SECTIONS = ("ID", "Title", "Page kind", "Body")
TEST_SECTIONS = ["Stimulus", "Required observation"]
PREFIX = re.compile(r"[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*")
DIRECTORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")
NAME = re.compile(r"[A-Za-z0-9_-]+")
SOURCE = re.compile(r"(block|table|rtm):(.+)")
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
LINK = re.compile(r"(!?)\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(\s+\"[^\"]*\")?\)")
WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
HEADING = re.compile(r"\n\n## ([^\n]+)\n\n")
IMAGE = re.compile(r"\.(png|jpe?g|gif|svg|webp)$", re.I)
SPEC_NAMES = {"srs": "Software-Requirements-Specification", "rtm": "Requirements-Traceability-Matrix",
              "overview": "Architecture-Packet", "adr_index": "ADR-Index"}
WORDS = {"cm": "CM", "cli": "CLI", "faq": "FAQ", "mcp": "MCP", "adr": "ADR", "srs": "SRS", "rtm": "RTM", "api": "API"}


class Refused(Exception):
    """The command cannot run (exit 2)."""


# ---- configuration --------------------------------------------------------------------------------------------
def prefixes_of(scope: dict) -> list[str]:
    return [scope["idPrefix"]] if "idPrefix" in scope else list(scope["idPrefixes"])


def load_config(path: Path) -> dict:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Refused(f"cannot read the configuration {path}: {error}")
    errors: list[str] = []

    def need(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    need(isinstance(config, dict) and config.get("schema") == CONFIG_SCHEMA, f"schema must be {CONFIG_SCHEMA}")
    if errors:
        raise Refused("; ".join(errors))
    for key in ("repoUrl", "branch", "wikiTitle", "docs"):
        need(isinstance(config.get(key), str) and bool(config[key]), f"{key} must be a non-empty string")
    scopes = config.get("scopes")
    need(isinstance(scopes, dict) and isinstance(scopes.get("software"), dict), "scopes.software is required")
    if errors:
        raise Refused("; ".join(errors))
    seen: list[str] = []
    directories: list[str] = []
    for scope_name, scope in scopes.items():
        need(scope_name in ("software", "test"), f"scopes.{scope_name}: only software and test are generated")
        if scope_name not in ("software", "test") or not isinstance(scope, dict):
            continue
        need(isinstance(scope.get("directory"), str) and DIRECTORY.fullmatch(scope["directory"]) is not None,
             f"scopes.{scope_name}.directory must be one plain path segment")
        directories.append(str(scope.get("directory")))
        need(("idPrefix" in scope) != ("idPrefixes" in scope), f"scopes.{scope_name} needs exactly one of idPrefix and idPrefixes")
        found = scope.get("idPrefixes") if "idPrefixes" in scope else [scope.get("idPrefix")]
        need(isinstance(found, list) and bool(found) and all(isinstance(p, str) and PREFIX.fullmatch(p) for p in found),
             f"scopes.{scope_name} prefixes must be upper-case words joined by '-'")
        if isinstance(found, list):
            for prefix in found:
                need(prefix not in seen, f"prefix {prefix} appears twice")
                seen.append(prefix)
    need(len(set(directories)) == len(directories), "scope directories must differ")
    software = scopes["software"]
    sections = software.get("sections")
    need(isinstance(sections, list) and bool(sections), "scopes.software.sections must be a non-empty array")
    names: list[str] = []
    for section in sections if isinstance(sections, list) else []:
        valid = isinstance(section, dict) and isinstance(section.get("name"), str) and isinstance(section.get("from"), str)
        need(valid, "each software section needs a name and a from")
        if not valid:
            continue
        need(section["name"] not in RESERVED_SECTIONS and "\n" not in section["name"] and section["name"].strip() != "",
             f"section name {section['name']!r} is not allowed")
        need(section["name"] not in names, f"section {section['name']} appears twice")
        names.append(section["name"])
        need(SOURCE.fullmatch(section["from"]) is not None, f"section {section['name']}: from must be block:<label>, table:<header> or rtm:<column>")
    srs = config.get("srs")
    need(isinstance(srs, dict) and isinstance(srs.get("path"), str) and srs.get("style") in ("blocks", "table"),
         "srs needs a path and a style of blocks or table")
    for section in sections if isinstance(sections, list) else []:
        match = SOURCE.fullmatch(section.get("from", "")) if isinstance(section, dict) else None
        if match and isinstance(srs, dict):
            kind = match.group(1)
            need(kind == "rtm" or kind == ("block" if srs.get("style") == "blocks" else "table"),
                 f"section {section['name']}: {kind}: does not fit the {srs.get('style')} style")
    rtm = config.get("rtm")
    need(rtm is None or (isinstance(rtm, dict) and isinstance(rtm.get("path"), str) and isinstance(rtm.get("idColumn"), str)),
         "rtm needs a path and an idColumn")
    plan = config.get("testPlan")
    need(plan is None or isinstance(plan, dict) and isinstance(plan.get("path"), str), "testPlan needs a path")
    need("test" not in scopes or plan is not None, "a test scope needs a testPlan")
    for key in ("names", "words"):
        need(isinstance(config.get(key, {}), dict), f"{key} must be an object")
    for key in ("exclude", "assetDirs"):
        need(isinstance(config.get(key, []), list), f"{key} must be an array")
    if errors:
        raise Refused("; ".join(errors))
    return config


def profile_of(config: dict) -> dict:
    scopes = []
    for scope_name in ("software", "test"):
        scope = config["scopes"].get(scope_name)
        if scope is None:
            continue
        entry = {"scope": scope_name, "directory": scope["directory"]}
        entry["idPrefix" if "idPrefix" in scope else "idPrefixes"] = scope.get("idPrefix", scope.get("idPrefixes"))
        entry["sections"] = [s["name"] for s in scope["sections"]] if scope_name == "software" else list(TEST_SECTIONS)
        scopes.append(entry)
    return {"schema": PROFILE_SCHEMA, "scopes": scopes}


# ---- small helpers --------------------------------------------------------------------------------------------
def split_row(line: str) -> list[str]:
    cells, cell, index = [], "", 0
    while index < len(line):
        if line[index] == "\\" and line[index + 1:index + 2] == "|":
            cell += "\\|"
            index += 2
            continue
        if line[index] == "|":
            cells.append(cell.strip())
            cell = ""
        else:
            cell += line[index]
        index += 1
    cells.append(cell.strip())
    return cells[1:-1] if line.rstrip().endswith("|") else cells[1:]


def table_rows(lines: list[str]):
    """Yield (header, cells, line index) for each data row of every pipe table outside code fences."""
    header, state, fence = None, 0, None
    for index, line in enumerate(lines):
        marker = FENCE.match(line)
        if fence:
            if marker and marker.group(1)[0] == fence[0] and line.strip() == marker.group(1):
                fence = None
            continue
        if marker:
            fence = marker.group(1)
            continue
        if not line.startswith("|"):
            header, state = None, 0
            continue
        cells = split_row(line)
        if header is None:
            header, state = cells, 1
        elif state == 1:
            state = 2 if re.fullmatch(r"\|?[\s:|-]+\|?", line) else 0
            if state == 0:
                header = None
        else:
            if len(cells) > len(header) and header:
                cells = cells[:len(header) - 1] + [" | ".join(cells[len(header) - 1:])]
            yield header, cells + [""] * (len(header) - len(cells)), index


def cell_text(text: str) -> str:
    return str(text).replace("|", "\\|")


def utf8(path: Path, problems: list[str], base: Path) -> str:
    try:
        return path.read_bytes().decode("utf-8").replace("\r\n", "\n")
    except (OSError, UnicodeDecodeError) as error:
        problems.append(f"{path.relative_to(base).as_posix()}: cannot read as UTF-8 ({type(error).__name__})")
        return ""


def title_of(markdown: str, fallback: str) -> str:
    match = re.search(r"^#\s+(.+?)\s*$", markdown, re.M)
    return match.group(1) if match else fallback


def clean(text: str) -> str:
    return text.rstrip() + "\n"


# ---- source model ---------------------------------------------------------------------------------------------
class Model:
    def __init__(self, root: Path, config: dict) -> None:
        self.root = root
        self.config = config
        self.problems: list[str] = []
        self.warnings: list[str] = []
        self.docs = config["docs"].strip("/")
        scopes = config["scopes"]
        self.req_prefixes = prefixes_of(scopes["software"])
        self.test_prefixes = prefixes_of(scopes["test"]) if "test" in scopes else []
        alternatives = "|".join(re.escape(p) for p in sorted(self.req_prefixes + self.test_prefixes, key=len, reverse=True))
        self.id_pattern = rf"(?:{alternatives}|ADR)-\d{{3,4}}" if alternatives else r"ADR-\d{4}"
        self.req_id = re.compile(r"(?:%s)-\d{3,}" % "|".join(re.escape(p) for p in self.req_prefixes))
        self.test_id = re.compile(r"(?:%s)-\d{3,}" % "|".join(re.escape(p) for p in self.test_prefixes)) if self.test_prefixes else None
        self.load()

    def path(self, rel: str) -> Path:
        return self.root / rel

    def docs_rel(self, rel: str) -> str:
        return f"{self.docs}/{rel}"

    def read(self, rel: str) -> str:
        return utf8(self.path(rel), self.problems, self.root)

    def load(self) -> None:
        config = self.config
        files = sorted(p.relative_to(self.root).as_posix() for p in (self.root / self.docs).rglob("*") if p.is_file())
        exclude = [self.docs_rel(pattern) for pattern in config.get("exclude", [])]
        self.excluded = {rel for rel in files if any(fnmatch.fnmatchcase(rel, pattern) for pattern in exclude)}
        self.pages = [rel for rel in files if rel.endswith(".md") and rel not in self.excluded]
        asset_dirs = config.get("assetDirs", ["images"])
        self.images = [rel for rel in files if rel not in self.excluded and IMAGE.search(rel)
                       and any(f"/{d}/" in rel for d in asset_dirs)]
        self.srs_rel = self.docs_rel(config["srs"]["path"])
        self.overview_rel = self.docs_rel(config["architecture"]["overview"]) if config.get("architecture", {}).get("overview") else None
        self.adr_dir = self.docs_rel(config["architecture"]["adrDir"]) if config.get("architecture", {}).get("adrDir") else None
        self.adr_index_rel = self.docs_rel(config["architecture"]["adrIndex"]) if config.get("architecture", {}).get("adrIndex") else None
        self.plan_rel = self.docs_rel(config["testPlan"]["path"]) if config.get("testPlan") else None
        for rel in (self.srs_rel, self.overview_rel, self.adr_index_rel, self.plan_rel):
            if rel and not self.path(rel).is_file():
                self.problems.append(f"configured file not found: {rel}")
        for rel in config.get("names", {}):
            if not self.path(self.docs_rel(rel)).is_file():
                self.problems.append(f"names: {rel} is not a file under {self.docs}/")
        self.load_requirements()
        self.load_rtm()
        self.load_tests()
        self.check_labels()
        self.rtm_only = sorted(set(self.rtm) - {r["id"] for r in self.requirements})

    def load_requirements(self) -> None:
        self.requirements: list[dict] = []
        self.srs_lines = self.read(self.srs_rel).split("\n") if self.path(self.srs_rel).is_file() else []
        lines = self.srs_lines
        seen: set[str] = set()
        self.labels_seen: set[str] = set()
        self.block_spans: list[tuple[int, int]] = []
        if self.config["srs"]["style"] == "blocks":
            heading = re.compile(r"^###\s+(%s):\s*(.+?)\s*$" % self.req_id.pattern)
            for index, line in enumerate(lines):
                match = heading.match(line)
                if not match:
                    continue
                end = index + 1
                while end < len(lines) and not re.match(r"^#{1,3}\s", lines[end]):
                    end += 1
                if match.group(1) in seen:
                    self.problems.append(f"duplicate requirement {match.group(1)}")
                    continue
                seen.add(match.group(1))
                fields, extra = self.parse_block(match.group(1), lines[index + 1:end])
                self.labels_seen.update(fields)
                if extra:
                    self.problems.append(f"{match.group(1)}: {extra} text lines outside any labelled bullet would be dropped")
                self.requirements.append({"id": match.group(1), "title": match.group(2), "fields": fields})
                self.block_spans.append((index, end))
        else:
            id_column = self.config["srs"].get("idColumn")
            for header, cells, _ in table_rows(lines):
                key = id_column if id_column in header else header[0]
                row = dict(zip(header, cells))
                if not self.req_id.fullmatch(row.get(key, "")):
                    continue
                if row[key] in seen:
                    self.problems.append(f"duplicate requirement {row[key]}")
                    continue
                seen.add(row[key])
                self.labels_seen.update(h for h in header if h != key)
                self.requirements.append({"id": row[key], "title": "", "fields": {h: v for h, v in row.items() if h != key}})
        if not self.requirements:
            self.problems.append(f"{self.srs_rel}: no requirement found for the {self.config['srs']['style']} style")

    def parse_block(self, rid: str, body: list[str]) -> tuple[dict, int]:
        fields: dict[str, list[str]] = {}
        current: list[str] | None = None
        extra = 0
        for line in body:
            match = re.match(r"^- ([^:\n]+?):[ \t]*(.*)$", line)
            if match:
                if match.group(1) in fields:
                    self.problems.append(f"{rid}: label {match.group(1)!r} appears twice")
                current = [match.group(2)]
                fields[match.group(1)] = current
            elif current is not None and (line.startswith("  ") or not line.strip()):
                current.append(line[2:] if line.startswith("  ") else "")
            elif line.strip() and line.strip() != "---":
                extra += 1
                current = None
            elif not line.strip() or line.strip() == "---":
                current = None if line.strip() == "---" else current
        return {label: "\n".join(value).strip("\n").rstrip() for label, value in fields.items()}, extra

    def load_rtm(self) -> None:
        self.rtm: dict[str, dict] = {}
        self.rtm_columns: list[str] = []
        spec = self.config.get("rtm")
        if not spec:
            return
        rel = self.docs_rel(spec["path"])
        if not self.path(rel).is_file():
            self.problems.append(f"configured file not found: {rel}")
            return
        reader = csv.DictReader(io.StringIO(self.read(rel), newline=""), restkey="\0extra")
        self.rtm_columns = [c.strip() for c in (reader.fieldnames or [])]
        if spec["idColumn"] not in self.rtm_columns:
            self.problems.append(f"{rel}: no column {spec['idColumn']}")
            return
        for row in reader:
            if "\0extra" in row:
                self.problems.append(f"{rel}: row {reader.line_num} has more fields than the header")
            clean_row = {k.strip(): (v or "").strip() for k, v in row.items() if k != "\0extra"}
            if self.req_id.fullmatch(clean_row.get(spec["idColumn"], "")):
                self.rtm[clean_row[spec["idColumn"]]] = clean_row

    def load_tests(self) -> None:
        self.tests: list[dict] = []
        if not self.test_id or not self.plan_rel or not self.path(self.plan_rel).is_file():
            return
        seen: set[str] = set()
        column = self.config["testPlan"].get("idColumn")
        for header, cells, _ in table_rows(self.read(self.plan_rel).split("\n")):
            key = column if column in header else header[0]
            row = dict(zip(header, cells))
            match = re.match(r"^[`\[]?(%s)\b[`\]]?\s*[-:\u2013\u2014]*\s*(.*)$" % self.test_id.pattern, row.get(key, ""))
            if not match:
                continue
            if match.group(1) in seen:
                self.problems.append(f"duplicate test {match.group(1)}")
                continue
            seen.add(match.group(1))
            requirements = sorted({m for value in row.values() for m in self.req_id.findall(value)})
            self.tests.append({"id": match.group(1), "title": match.group(2).strip(), "row": {h: v for h, v in row.items() if h != key and v},
                               "requirements": requirements})

    def check_labels(self) -> None:
        sections = self.config["scopes"]["software"]["sections"]
        used = {s["from"].partition(":")[2] for s in sections if s["from"].startswith(("block:", "table:"))}
        for label in sorted(self.labels_seen - used):
            self.problems.append(f"requirement label {label!r} is in {self.srs_rel} but in no configured section")
        for label in sorted(used - self.labels_seen):
            self.problems.append(f"configured label {label!r} appears in no requirement of {self.srs_rel}")
        for section in sections:
            if section["from"].startswith("rtm:") and section["from"][4:] not in self.rtm_columns:
                self.problems.append(f"section {section['name']}: the RTM has no column {section['from'][4:]!r}")


# ---- naming ---------------------------------------------------------------------------------------------------
def words_name(model: Model, rel: str) -> str:
    words = {**WORDS, **model.config.get("words", {})}
    base = re.sub(r"[^A-Za-z0-9]+", "-", posixpath.splitext(posixpath.basename(rel))[0]).strip("-") or "Page"
    return "-".join(words.get(w.lower(), w[0].upper() + w[1:]) for w in base.split("-") if w)


def assign_names(model: Model) -> dict[str, str]:
    """Return the note name of every docs page: fixed names first, then file names, then directory-qualified names."""
    names: dict[str, str] = {}
    fixed = {model.srs_rel: SPEC_NAMES["srs"]}
    if model.overview_rel:
        fixed[model.overview_rel] = SPEC_NAMES["overview"]
    if model.adr_index_rel:
        fixed[model.adr_index_rel] = SPEC_NAMES["adr_index"]
    fixed.update({model.docs_rel(rel): name for rel, name in model.config.get("names", {}).items()})
    pending = []
    for rel in model.pages:
        adr = posixpath.basename(rel) if model.adr_dir and rel.startswith(model.adr_dir + "/") else ""
        match = re.match(r"^(ADR-\d{4})-.+\.md$", adr)
        if rel in fixed:
            names[rel] = fixed[rel]
        elif match:
            names[rel] = match.group(1)
        else:
            pending.append(rel)
    taken = {name.casefold() for name in names.values()} | {SPEC_NAMES["rtm"].casefold(), "home", "_sidebar"}
    base = {rel: words_name(model, rel) for rel in pending}
    for rel in pending:
        candidates = [base[rel]]
        segments = [re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-") for s in rel.split("/")[1:-1]]
        for depth in range(1, len(segments) + 1):
            candidates.append("-".join(words_name(model, s) for s in segments[-depth:]) + "-" + base[rel])
        clashes = [r for r in pending if base[r].casefold() == base[rel].casefold()]
        if len(clashes) == 1 and candidates[0].casefold() not in taken:
            names[rel] = candidates[0]
        else:
            for candidate in candidates[1:]:
                if candidate.casefold() not in taken:
                    names[rel] = candidate
                    break
            else:
                model.problems.append(f"cannot name {rel} uniquely")
                continue
        taken.add(names[rel].casefold())
    for rel in fixed:
        if rel not in names:
            names[rel] = fixed[rel]
    return names


# ---- vault construction ---------------------------------------------------------------------------------------
class Vault:
    def __init__(self, model: Model) -> None:
        self.model = model
        self.config = model.config
        self.files: dict[str, bytes] = {}
        self.note_path: dict[str, str] = {}
        self.children: dict[str, list[str]] = {}
        self.noted: set[str] = set()
        self.problems = list(model.problems)
        self.names = assign_names(model)
        self.repo = self.config["repoUrl"].rstrip("/")
        self.branch = self.config["branch"]
        scopes = self.config["scopes"]
        self.req_dir = scopes["software"]["directory"]
        self.test_dir = scopes["test"]["directory"] if "test" in scopes else None
        self.adr_names = sorted(n for n in self.names.values() if re.fullmatch(r"ADR-\d{4}", n))
        self.assets: dict[str, str] = {}

    # -- registry of notes
    def register(self, name: str, path: str) -> None:
        if not NAME.fullmatch(name):
            self.problems.append(f"{path}: page name must use only letters, digits, '-' and '_'")
        folded = {n.casefold() for n in self.note_path}
        if name.casefold() in folded and self.note_path.get(name) != path:
            self.problems.append(f"note name collision: {name}")
        self.note_path[name] = path

    def blob_url(self, rel: str) -> str:
        kind = "tree" if self.model.path(rel).is_dir() else "blob"
        return f"{self.repo}/{kind}/{self.branch}/{'/'.join(quote(part) for part in rel.split('/'))}"

    def footer(self, rel: str) -> str:
        return f"---\n\nGenerated from [{rel}]({self.blob_url(rel)}) on `{self.branch}`. Edit the source in the repository, not this page.\n"

    # -- link conversion
    def convert(self, markdown: str, src_rel: str, self_name: str, only: re.Pattern | None = None) -> str:
        directory = posixpath.dirname(self.note_path.get(self_name, f"{self_name}.md"))
        out, fence = [], None
        for line in markdown.split("\n"):
            marker = FENCE.match(line)
            if fence:
                out.append(line)
                if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence) and line.strip() == marker.group(1):
                    fence = None
                continue
            if marker:
                fence = marker.group(1)
                out.append(line)
                continue
            out.append(self.convert_line(line, src_rel, self_name, directory, only))
        return "\n".join(out)

    def convert_line(self, line: str, src_rel: str, self_name: str, directory: str, only: re.Pattern | None) -> str:
        saved: list[str] = []

        def keep(text: str) -> str:
            saved.append(text)
            return f"\x01{len(saved) - 1}\x01"

        text = re.sub(r"(`+)([\s\S]*?[^`])\1(?!`)", lambda m: keep(m.group(0)), line)
        text = re.sub(r"<!--.*?-->", lambda m: keep(m.group(0)), text)
        text = WIKILINK.sub(lambda m: keep(m.group(0)), text)
        text = LINK.sub(lambda m: keep(self.rewrite_link(m, src_rel, self_name, directory, saved)), text)
        text = re.sub(r"<?https?://[^\s)>\]]+>?", lambda m: keep(m.group(0)), text)
        # An explicit owner/repo#N reference becomes its GitHub issue URL (`"issueLinks": false` keeps it text); a bare #N stays text.
        if self.config.get("issueLinks", True):
            text = re.sub(r"(?<![\w&#/.-])([A-Za-z0-9-]+/[A-Za-z0-9._-]+)#(\d+)\b",
                          lambda m: keep(f"[{m.group(0)}](https://github.com/{m.group(1)}/issues/{m.group(2)})"), text)
        known = self.note_path
        # A bracketed plain identifier would become an ambiguous triple bracket; use parentheses.
        text = re.sub(r"\[(%s)\]" % self.model.id_pattern,
                      lambda m: f"({m.group(1)})" if m.group(1) in known and m.group(1) != self_name else m.group(0), text)
        pattern = re.compile(r"(?<![A-Za-z0-9_\-/.])(%s)(?![A-Za-z0-9_]|-[A-Za-z0-9])" % self.model.id_pattern)

        def link_id(match: re.Match) -> str:
            ident = match.group(1)
            if ident == self_name or ident not in known or (only is not None and not only.fullmatch(ident)):
                return ident
            return f"[[{ident}]]"

        text = pattern.sub(link_id, text)
        previous = None
        while previous != text:
            previous = text
            text = re.sub(r"\x01(\d+)\x01", lambda m: saved[int(m.group(1))], text)
        return text

    def rewrite_link(self, match: re.Match, src_rel: str, self_name: str, directory: str, saved: list[str]) -> str:
        whole, bang, text, target, title = match.group(0), match.group(1), match.group(2), match.group(3), match.group(4) or ""
        if not target or target.startswith(("#", "/")) or SCHEME.match(target):
            return whole
        hash_at = target.find("#")
        raw = target[:hash_at] if hash_at >= 0 else target
        fragment = target[hash_at + 1:] if hash_at >= 0 else ""
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(src_rel), unquote(raw))).rstrip("/")
        if resolved.startswith(".."):
            return whole
        if bang:
            dest = self.assets_by_source.get(resolved)
            if dest:
                return f"![{text}]({posixpath.relpath(dest, directory or '.')}{title})"
            return f"![{text}]({self.blob_url(resolved)}?raw=true{title})"
        name = self.name_for.get(resolved)
        if name == SPEC_NAMES["srs"]:
            slug = re.sub(r"[^a-z0-9]+", "-", fragment.lower()).strip("-")
            for rid in self.req_ids:
                if slug == rid.lower() or slug.startswith(rid.lower() + "-"):
                    name = rid
                    break
        if not name:
            return f"[{text}]({self.blob_url(resolved)}{'#' + fragment if fragment else ''}{title})"
        shown = re.sub(r"\x01(\d+)\x01", lambda m: saved[int(m.group(1))], text)
        plain = shown.replace("`", "").strip()
        if name == self_name:
            return shown
        if plain == name or plain.endswith(".md") or plain == posixpath.basename(resolved) or not plain:
            return f"[[{name}]]"
        return f"{text} ([[{name}]])"

    # -- page emission
    def put(self, path: str, text: str) -> None:
        self.files[path] = text.encode("utf-8")

    def emit(self, name: str, title: str, body: str, footer: str, children: list[str], note: bool = False) -> None:
        """Write a page; one over the budget becomes a hub whose children are its parts."""
        path = self.note_path[name]
        directory = posixpath.dirname(path)
        text = self.compose(title, note, body, footer, self.index_block(children))
        if len(text.encode("utf-8")) <= BUDGET:
            self.put(path, text)
            return
        room = TARGET - len(self.compose(f"{title} (part 99 of 99)", False, "", footer, "").encode("utf-8"))
        chunks = split_text(body, room)
        parts = []
        for number, chunk in enumerate(chunks, 1):
            part = f"{name}-Part-{number}"
            self.register(part, posixpath.join(directory, f"{part}.md") if directory else f"{part}.md")
            parts.append(part)
            self.put(self.note_path[part], self.compose(f"{title} (part {number} of {len(chunks)})", False, chunk, footer, ""))
        lead = f"This page is split into {len(parts)} parts to stay within the wiki page budget of {BUDGET} bytes."
        self.put(path, self.compose(title, note, lead, footer, self.index_block(parts + children)))

    @staticmethod
    def compose(title: str, note: bool, body: str, footer: str, index: str) -> str:
        blocks = [f"# {title}"]
        if note:
            blocks.append("<!-- page-kind: note -->")
        if body.strip("\n"):
            blocks.append(body.strip("\n"))
        if footer:
            blocks.append(footer)
        text = "\n\n".join(blocks) + "\n"
        return text + "\n" + index if index else text

    @staticmethod
    def index_block(children: list[str]) -> str:
        if not children:
            return ""
        return "<!-- sections -->\n" + "".join(f"- [[{child}]]\n" for child in children) + "<!-- /sections -->\n"

    def build(self) -> "Vault":
        model, config = self.model, self.config
        self.name_for = dict(self.names)
        self.req_ids = {r["id"] for r in model.requirements}
        self.test_ids = {t["id"] for t in model.tests}
        self.assets_by_source = {}
        for rel in model.images:
            dest = "images/" + rel[rel.rfind("/images/") + len("/images/"):] if "/images/" in rel else "images/" + posixpath.basename(rel)
            if dest in self.assets:
                self.problems.append(f"image name collision: {dest}")
            self.assets[dest] = rel
            self.assets_by_source[rel] = dest
        for rel, name in self.names.items():
            if rel in model.excluded:
                continue
            adr = re.fullmatch(r"ADR-\d{4}", name) is not None
            self.register(name, f"architecture/{name}.md" if adr else f"{name}.md")
        for rel, name in self.names.items():
            if rel in model.excluded and name not in self.note_path:
                self.note_path[name] = f"{name}.md"
        self.register(SPEC_NAMES["rtm"], f"{SPEC_NAMES['rtm']}.md")
        for rid in sorted(self.req_ids):
            self.register(rid, f"{self.req_dir}/{rid}.md")
        for tid in sorted(self.test_ids):
            self.register(tid, f"{self.test_dir}/{tid}.md")
        self.register("Home", "Home.md")
        self.register("_Sidebar", "_Sidebar.md")
        self.requirement_pages()
        self.test_pages()
        self.spec_pages()
        self.other_pages()
        self.home_page()
        self.put(PROFILE_FILE, json.dumps(profile_of(config), indent=2) + "\n")
        if config.get("obsidian"):
            self.put(".obsidian/app.json", json.dumps({"useMarkdownLinks": False, "newLinkFormat": "shortest"}, indent=2) + "\n")
        for dest, rel in self.assets.items():
            self.files[dest] = model.path(rel).read_bytes()
        return self

    def requirement_pages(self) -> None:
        sections = self.config["scopes"]["software"]["sections"]
        title_from = self.config["srs"].get("titleFrom")
        for req in self.model.requirements:
            rtm = self.model.rtm.get(req["id"], {})
            title = req["title"] or (rtm.get(title_from[4:], "") if title_from and title_from.startswith("rtm:") else "")
            title = " ".join(title.split())
            bodies = []
            for section in sections:
                kind, _, label = section["from"].partition(":")
                raw = rtm.get(label, "") if kind == "rtm" else req["fields"].get(label, "")
                only = self.model.test_id if section["name"] == "TestID" else None
                if section["name"] == "TestID" and only is None:
                    only = re.compile(r"(?!)")
                bodies.append(self.convert(raw, self.model.srs_rel, req["id"], only).strip("\n"))
            self.requirement_page(req["id"], title, [s["name"] for s in sections], bodies)

    def requirement_page(self, rid: str, title: str, names: list[str], bodies: list[str]) -> None:
        def render() -> str:
            head = f"# {rid}" + (f": {title}" if title else "")
            return head + "".join(f"\n\n## {n}\n\n{b}" for n, b in zip(names, bodies)) + "\n"

        for name, body in zip(names, bodies):
            if HEADING.search("\n\n" + body + "\n\n"):
                self.problems.append(f"{rid}: section {name} holds a blank-line-delimited '## ' heading, which the page layout cannot hold")
        spilled: dict[int, list[str]] = {}
        while len(render().encode("utf-8")) > BUDGET or len(render()) > BUDGET:
            candidates = [i for i, b in enumerate(bodies) if len(b.encode("utf-8")) > 400 and i not in spilled]
            if not candidates:
                self.problems.append(f"{rid}: the page exceeds {BUDGET} bytes and no section can move to a note page")
                break
            largest = max(candidates, key=lambda i: (len(bodies[i].encode("utf-8")), -i))
            slug = re.sub(r"[^A-Za-z0-9]+", "-", names[largest]).strip("-")
            room = TARGET - len(f"# {rid} {names[largest]} (part 99 of 99)\n\n<!-- page-kind: note -->\n\n".encode("utf-8"))
            chunks = split_text(bodies[largest], room)
            links = []
            for number, chunk in enumerate(chunks, 1):
                name = f"{rid}-{slug}" + (f"-Part-{number}" if len(chunks) > 1 else "")
                self.register(name, f"{name}.md")
                self.noted.add(name)
                suffix = f" (part {number} of {len(chunks)})" if len(chunks) > 1 else ""
                self.put(f"{name}.md", f"# {rid} {names[largest]}{suffix}\n\n<!-- page-kind: note -->\n\n{chunk.strip(chr(10))}\n")
                links.append(f"[[{name}]]")
            spilled[largest] = links
            bodies[largest] = f"The full text is in {', '.join(links)}: this page would exceed the wiki page budget of {BUDGET} bytes."
        self.put(f"{self.req_dir}/{rid}.md", render())

    def test_pages(self) -> None:
        for test in self.model.tests:
            lines = [f"No test definition exists yet: this stub records the {self.model.plan_rel} row of {test['id']}."]
            if test["requirements"]:
                lines.append("")
                lines.append("- **Linked requirements, not verified here:** " + ", ".join(f"[[{r}]]" if r in self.req_ids else r for r in test["requirements"]))
            for header, value in test["row"].items():
                lines.append(f"- **{header}:** {self.convert(cell_one_line(value), self.model.plan_rel, test['id'])}")
            title = f": {' '.join(test['title'].split())}" if test["title"] else ""
            self.put(f"{self.test_dir}/{test['id']}.md", f"# {test['id']}{title}\n\n<!-- page-kind: stub -->\n" + "\n".join(lines).rstrip() + "\n")

    def spec_pages(self) -> None:
        model, config = self.model, self.config
        lines = list(model.srs_lines)
        if config["srs"]["style"] == "blocks" and model.block_spans:
            first = model.block_spans[0][0]
            listing = [f"- [[{r['id']}]]: {r['title']}" + (f" ({model.rtm[r['id']][config['rtm'].get('statusColumn', 'Status')]})"
                                                          if r["id"] in model.rtm and model.rtm[r["id"]].get(config["rtm"].get("statusColumn", "Status")) else "")
                       for r in model.requirements]
            removed = {i for start, end in model.block_spans for i in range(start, end)}
            rebuilt = []
            for index, line in enumerate(lines):
                if index == first:
                    rebuilt += [f"Each requirement has its own page ({len(model.requirements)} requirements):", "", *listing, ""]
                if index not in removed:
                    rebuilt.append(line)
            lines = rebuilt
        srs_body = self.convert("\n".join(lines), model.srs_rel, SPEC_NAMES["srs"])
        title, body = split_title(srs_body, "Software Requirements Specification")
        self.emit(SPEC_NAMES["srs"], title, body, self.footer(model.srs_rel), [])
        self.rtm_page()

    def rtm_page(self) -> None:
        model, config = self.model, self.config
        spec = config.get("rtm") or {}
        columns = spec.get("columns", [])
        header = ["Requirement", "Title", *columns] + (["Tests"] if model.test_prefixes else [])
        rows = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
        title_from = config["srs"].get("titleFrom", "")
        for req in model.requirements:
            rtm = model.rtm.get(req["id"], {})
            title = req["title"] or (rtm.get(title_from[4:], "") if title_from.startswith("rtm:") else "")
            cells = [f"[[{req['id']}]]", cell_text(" ".join(title.split()) or "\u2014")]
            cells += [cell_text(" ".join(rtm.get(c, "").split()) or "\u2014") for c in columns]
            if model.test_prefixes:
                ids = sorted({t for t in model.test_id.findall(rtm.get("TestID", ""))} | {t["id"] for t in model.tests if req["id"] in t["requirements"]})
                cells.append(", ".join(f"[[{t}]]" for t in ids if t in self.test_ids) or "\u2014")
            rows.append("| " + " | ".join(cells) + " |")
        intro = (f"Requirement to its status and tests, from the same sources as the repository matrix: the specification and `{spec.get('path', 'the RTM')}`.\n\n"
                 f"Related: [[{SPEC_NAMES['srs']}]], [[Home]].\n\n")
        rel = self.model.docs_rel(spec["path"]) if spec else model.srs_rel
        self.emit(SPEC_NAMES["rtm"], "Requirements Traceability Matrix", intro + "\n".join(rows), self.footer(rel), [])

    def other_pages(self) -> None:
        model = self.model
        for rel in model.pages:
            if rel in model.excluded or rel == model.srs_rel:
                continue
            name = self.names[rel]
            text = model.read(rel)
            title, body = split_title(self.convert(text, rel, name), words_name(model, rel).replace("-", " "))
            children: list[str] = []
            if rel == model.adr_index_rel:
                children = list(self.adr_names)
            self.emit(name, title, body, self.footer(rel), children)
        if self.adr_names and not model.adr_index_rel:
            self.register(SPEC_NAMES["adr_index"], f"{SPEC_NAMES['adr_index']}.md")
            lines = ["Architecture decision records:", ""]
            for rel in model.pages:
                if re.fullmatch(r"ADR-\d{4}", self.names.get(rel, "")):
                    lines.append(f"- [[{self.names[rel]}]]: {title_of(model.read(rel), self.names[rel])}")
            self.emit(SPEC_NAMES["adr_index"], "ADR Index", "\n".join(lines), "", list(self.adr_names))
            self.names[SPEC_NAMES["adr_index"]] = SPEC_NAMES["adr_index"]

    def home_page(self) -> None:
        model, config = self.model, self.config
        sections = [(d, s) for d, s in config.get("sections", [])]
        groups: dict[str, list[str]] = {}
        special = {model.srs_rel, model.overview_rel, model.plan_rel, model.adr_index_rel}
        for rel in model.pages:
            if rel in model.excluded or rel in special or re.fullmatch(r"ADR-\d{4}", self.names[rel]):
                continue
            parts = rel.split("/")
            folder = parts[1] if len(parts) > 2 else ""
            label = next((s for d, s in sections if d == folder), "More documentation")
            groups.setdefault(label, []).append(f"- [[{self.names[rel]}]]: {title_of(model.read(rel), self.names[rel])}")
        top = [SPEC_NAMES["srs"], SPEC_NAMES["rtm"]]
        lines = [config.get("description") or f"The spec-driven documentation of [{config['repoUrl'].rsplit('/', 1)[-1]}]({self.repo}).", "",
                 f"Every page is generated from the repository's `docs/` folder on `{self.branch}` by `wiki_generate.py`. Edit `docs/`, not these pages; a change made here is overwritten.", "",
                 "## Specifications", "",
                 f"- [[{SPEC_NAMES['srs']}]]: {len(model.requirements)} requirements, one page each under `{self.req_dir}/`.",
                 f"- [[{SPEC_NAMES['rtm']}]]: each requirement with its status and tests."]
        if model.overview_rel:
            lines.append(f"- [[{SPEC_NAMES['overview']}]]: the architecture description" + (f"; {len(self.adr_names)} decisions in [[{SPEC_NAMES['adr_index']}]]." if self.adr_names else "."))
            top.append(SPEC_NAMES["overview"])
        if model.plan_rel:
            lines.append(f"- [[{self.names[model.plan_rel]}]]" + (f": {len(model.tests)} test items, one stub page each under `{self.test_dir}/`." if model.tests else "."))
            top.append(self.names[model.plan_rel])
        lines.append("")
        order = list(dict.fromkeys([s for _, s in sections] + ["More documentation"]))
        for label in order:
            if label in groups:
                lines += [f"## {label}", "", *groups[label], ""]
        children = sorted({n for rel, n in self.names.items() if rel not in model.excluded and not re.fullmatch(r"ADR-\d{4}", n)
                           and rel != model.adr_index_rel} | {SPEC_NAMES["rtm"], *([SPEC_NAMES["adr_index"]] if self.adr_names else [])})
        self.emit("Home", config["wikiTitle"], "\n".join(lines), "", children)
        sidebar = ["**[[Home]]**", "", "<!-- page-kind: note -->", ""] + [f"- [[{n}]]" for n in top + ([SPEC_NAMES["adr_index"]] if self.adr_names else [])]
        self.put("_Sidebar.md", "\n".join(sidebar) + "\n")


def cell_one_line(value: str) -> str:
    return " ".join(value.split())


def quote(part: str) -> str:
    return "".join(c if re.fullmatch(r"[A-Za-z0-9._~-]", c) else "".join(f"%{b:02X}" for b in c.encode("utf-8")) for c in part)


def unquote(text: str) -> str:
    from urllib.parse import unquote as _unquote
    return _unquote(text)


def split_title(markdown: str, fallback: str) -> tuple[str, str]:
    """Split a page into its `# title` and the rest; a page without a leading title gets the fallback."""
    lines = markdown.lstrip("\n").split("\n")
    if lines and re.match(r"^#\s+\S", lines[0]):
        return lines[0][1:].strip(), "\n".join(lines[1:]).strip("\n")
    return fallback, "\n".join(lines).strip("\n")


def split_text(body: str, limit: int) -> list[str]:
    """Split Markdown into chunks of at most `limit` bytes, at headings, then blank lines, then lines outside code fences."""
    def size(text: str) -> int:
        return len(text.encode("utf-8"))

    def units(lines: list[str], level: int) -> list[list[str]]:
        pieces: list[list[str]] = [[]]
        fence = None
        for line in lines:
            marker = FENCE.match(line)
            if fence:
                if marker and marker.group(1)[0] == fence[0] and line.strip() == marker.group(1):
                    fence = None
            elif marker:
                fence = marker.group(1)
            elif level <= 6 and re.match(r"^#{%d}\s" % level, line) and any(pieces[-1]):
                pieces.append([])
            elif level == 7 and not line.strip() and any(pieces[-1]):
                pieces[-1].append(line)
                pieces.append([])
                continue
            pieces[-1].append(line)
        return [p for p in pieces if p]

    def cut(lines: list[str], level: int) -> list[list[str]]:
        text = "\n".join(lines)
        if size(text) <= limit:
            return [lines]
        if level > 7:
            return cut_lines(lines)
        pieces = units(lines, level)
        if len(pieces) == 1:
            return cut(lines, level + 1)
        out: list[list[str]] = []
        for piece in pieces:
            out += cut(piece, level + 1) if size("\n".join(piece)) > limit else [piece]
        return out

    def cut_lines(lines: list[str]) -> list[list[str]]:
        out: list[list[str]] = []
        current: list[str] = []
        used = 0
        header: list[str] = []
        fence = None
        opener = ""
        for index, line in enumerate(lines):
            marker = FENCE.match(line)
            closes = bool(fence and marker and marker.group(1)[0] == fence[0] and line.strip() == marker.group(1))
            if not fence:
                if line.startswith("|") and index + 1 < len(lines) and re.fullmatch(r"\|?[\s:|-]+\|?", lines[index + 1]):
                    header = [line, lines[index + 1]]
                elif not line.startswith("|"):
                    header = []
            # A closing fence never starts a chunk, so a fence is closed in the chunk that opened it.
            reserve = size(fence) + 1 if fence and not closes else 0
            if current and not closes and used + size(line) + 1 + reserve > limit:
                if fence:
                    current.append(fence)
                    out.append(current)
                    current, used = [opener], size(opener) + 1
                else:
                    out.append(current)
                    repeat = list(header) if line.startswith("|") and header and line != header[0] else []
                    current, used = repeat, sum(size(h) + 1 for h in repeat)
            current.append(line)
            used += size(line) + 1
            if closes:
                fence = None
            elif marker and not fence:
                fence, opener = marker.group(1), line
        if current:
            out.append(current)
        return out

    chunks = cut(body.strip("\n").split("\n"), 2)
    # Greedy packing: join neighbours while they fit.
    packed: list[list[str]] = []
    for chunk in chunks:
        if packed and size("\n".join(packed[-1] + [""] + chunk)) <= limit:
            packed[-1] = packed[-1] + [""] + chunk
        else:
            packed.append(chunk)
    return ["\n".join(chunk).strip("\n") for chunk in packed]


# ---- validation -----------------------------------------------------------------------------------------------
def mask_code(text: str) -> str:
    out, fence = [], None
    for line in text.split("\n"):
        marker = FENCE.match(line)
        if fence:
            if marker and marker.group(1)[0] == fence[0] and line.strip() == marker.group(1):
                fence = None
            out.append("")
            continue
        if marker:
            fence = marker.group(1)
            out.append("")
            continue
        out.append(re.sub(r"(`+)([\s\S]*?[^`])\1(?!`)", "", line))
    return "\n".join(out)


def validate(vault: Vault) -> list[str]:
    errors = list(vault.problems)
    config = vault.config
    scopes = config["scopes"]
    notes = {posixpath.basename(path)[:-3]: path for path in vault.files if path.endswith(".md")}
    prefixes = [p for s in scopes.values() for p in prefixes_of(s)]
    id_page = re.compile(r"(?:%s)-[0-9]{3,}" % "|".join(re.escape(p) for p in prefixes))
    children = set()
    for path, data in vault.files.items():
        if not path.endswith(".md"):
            continue
        text = data.decode("utf-8")
        block = re.search(r"\n<!-- sections -->\n((?:- \[\[[^\]\n]+\]\]\n)*)<!-- /sections -->\n$", text)
        if block:
            children.update(re.findall(r"- \[\[([^\]\n]+)\]\]\n", block.group(1)))
    for path, data in sorted(vault.files.items()):
        if not path.endswith(".md"):
            continue
        name = posixpath.basename(path)[:-3]
        text = data.decode("utf-8")
        if len(data) > BUDGET:
            errors.append(f"{path}: {len(data)} bytes exceeds the page budget of {BUDGET}")
        for link in WIKILINK.findall(mask_code(text)):
            target = re.split(r"[|#]", link)[0]
            if target not in notes:
                errors.append(f"{path}: link [[{link}]] names no page")
        if not id_page.fullmatch(name) and "<!-- page-kind: note -->" not in text and name not in children and name != "Home":
            errors.append(f"{path}: the page is not indexed")
        for scope_name, scope in scopes.items():
            if path.startswith(scope["directory"] + "/"):
                check_governed(path, text, scope_name, scope, errors)
    for child in sorted(children):
        if child not in notes:
            errors.append(f"index child [[{child}]] names no page")
    return errors


def check_governed(path: str, text: str, scope_name: str, scope: dict, errors: list[str]) -> None:
    name = posixpath.basename(path)[:-3]
    if not any(re.fullmatch(re.escape(p) + r"-[0-9]{3,}", name) for p in prefixes_of(scope)):
        errors.append(f"{path}: id-outside-scope")
    first = text.split("\n", 1)[0]
    if first != f"# {name}" and not first.startswith(f"# {name}: "):
        errors.append(f"{path}: the title does not start with the page ID")
    rest = text.split("\n", 1)[1] if "\n" in text else ""
    if rest.startswith("\n<!-- page-kind: "):
        return
    if not rest.startswith("\n## ") or not rest.endswith("\n"):
        errors.append(f"{path}: not-canonical")
        return
    headings = HEADING.findall("\n" + rest[:-1])
    expected = [s["name"] for s in scope["sections"]] if scope_name == "software" else TEST_SECTIONS
    if headings != expected:
        errors.append(f"{path}: unexpected-sections")


# ---- output ---------------------------------------------------------------------------------------------------
def generate(root: Path, config_path: Path) -> tuple[Vault, list[str]]:
    config = load_config(config_path)
    vault = Vault(Model(root, config)).build()
    return vault, validate(vault)


def write_out(vault: Vault, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    counts = {"written": 0, "unchanged": 0, "removed": 0}
    for path, data in vault.files.items():
        target = out / path
        if target.is_file() and target.read_bytes() == data:
            counts["unchanged"] += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        counts["written"] += 1
    for current, directories, names in os.walk(out, topdown=True):
        directories[:] = [d for d in directories if not (Path(current) == out and d == ".git")]
        for name in names:
            relative = (Path(current) / name).relative_to(out).as_posix()
            if relative not in vault.files:
                (Path(current) / name).unlink()
                counts["removed"] += 1
    for current, _, _ in os.walk(out, topdown=False):
        if Path(current) != out and not any(Path(current).iterdir()) and ".git" not in Path(current).relative_to(out).parts:
            Path(current).rmdir()
    return counts


def differences(vault: Vault, directory: Path) -> list[str]:
    found = []
    actual = {}
    if directory.is_dir():
        for current, directories, names in os.walk(directory):
            directories[:] = [d for d in directories if not (Path(current) == directory and d == ".git")]
            for name in names:
                path = Path(current) / name
                actual[path.relative_to(directory).as_posix()] = path.read_bytes()
    for path in sorted(set(vault.files) | set(actual)):
        if path not in actual:
            found.append(f"missing: {path}")
        elif path not in vault.files:
            found.append(f"extra: {path}")
        elif actual[path] != vault.files[path]:
            found.append(f"differs: {path}")
    return found


def summary(vault: Vault, errors: list[str]) -> dict:
    scopes = vault.config["scopes"]
    count = lambda directory: sum(1 for p in vault.files if p.startswith(directory + "/"))  # noqa: E731
    return {"pages": sum(1 for p in vault.files if p.endswith(".md")), "files": len(vault.files),
            "requirement_pages": count(scopes["software"]["directory"]),
            "test_pages": count(scopes["test"]["directory"]) if "test" in scopes else 0,
            "adr_pages": len(vault.adr_names), "rtm_requirements_without_page": len(vault.model.rtm_only), "problems": errors[:100], "problem_count": len(errors)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate a member wiki from docs/ (deterministic, config-driven).")
    parser.add_argument("--member-root", default=".", help="the member repository root (default: the current directory)")
    parser.add_argument("--config", help=f"the configuration file (default: <member-root>/{DEFAULT_CONFIG})")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--out", help="write the wiki into this directory, keeping .git and pruning stale files")
    action.add_argument("--check", help="exit 1 when this directory differs from the generated wiki")
    arguments = parser.parse_args(argv)
    root = Path(arguments.member_root).resolve()
    try:
        vault, errors = generate(root, Path(arguments.config) if arguments.config else root / DEFAULT_CONFIG)
    except Refused as error:
        print(f"wiki_generate: {error}", file=sys.stderr)
        return 2
    report = summary(vault, errors)
    if errors:
        print(json.dumps(report, indent=2))
        return 1
    if arguments.out:
        report["write"] = write_out(vault, Path(arguments.out))
    elif arguments.check:
        found = differences(vault, Path(arguments.check))
        report["drift"] = found[:100]
        report["drift_count"] = len(found)
        print(json.dumps(report, indent=2))
        return 1 if found else 0
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
