# ADR-0090: Generate the repository wiki with the shared repo-standards-review generator

- Status: Accepted
- Date: 2026-11-19
- Owner: LINUX
- Traces to: LBA-REQ-103
- Supersedes: ADR-0089

## Context

ADR-0089 made the wiki an Obsidian vault generated from `docs/` by this repository's own `scripts/build-wiki.mjs`.
The ecosystem now has one wiki standard for all of its members (`rsr/ecosystem-wiki-standard@8`, profile
`rsr/wiki-profile@2`), a shared generator that implements it (`wiki_generate.py` in the repo-standards-review consumer
kit), and a reference checker that reads the result into the ecosystem registry (VITechnologies/projectbuddy#318,
#408, #418). A repository-specific generator cannot produce the governed requirement and test pages that checker
and registry read, and it would have to be kept in step with the standard by hand.

The operator's reason for ADR-0089 stands: the wiki must open as an Obsidian vault (#64) and must follow `docs/`, the
governed source, by construction.

## Decision

- `docs/` stays the single source of truth. `.repo-standards-review/wiki_generate.py` generates the whole wiki from it
  under `.wiki-generator.json` (the SRS in block style, the RTM, the test plan, the architecture overview and ADRs).
  The file is vendored byte for byte from repo-standards-review `develop` (the commit and SHA-256 are recorded in the
  pull request that introduced it); a kit update replaces it and must show no difference for this file.
- The generated wiki holds `Home` and `_Sidebar`; the specification pages `Software-Requirements-Specification`,
  `Requirements-Traceability-Matrix`, `Architecture-Packet` and `ADR-Index`; one page per requirement
  (`requirements/LBA-REQ-NNN`), per test-plan item (`tests/T-NNN`, a stub page) and per ADR (`architecture/ADR-NNNN`);
  every other `docs/` page; the documentation images; the `.obsidian/app.json` vault setting
  (`"obsidian": true`); and `.wiki-profile.json`, which declares the governed scopes (`LBA-REQ` software, `T` test).
  A page over the 16,384-byte budget becomes a hub whose parts are separate pages.
- Links are alias-free `[[Page]]` wikilinks. Links to other repository files become GitHub URLs on `develop`, and
  explicit `owner/repo#N` references become issue URLs. A bare `#N` stays text.
- `.wiki-generator.json` pins the page names that readers already use (the four `Proposal-*` pages and
  `Information-For-Users-Plan`), and puts the "open this wiki in Obsidian" how-to on `Home`.
- The `wiki-vault` gate runs the generator, requires one page per RTM requirement and per test-plan item with no
  generator problem, requires a second run to equal the first byte for byte, requires the vault setting and the how-to,
  and proves two detectors with negative controls (an unresolved wikilink and an unconfigured requirement label). The
  `wiki-publish` workflow regenerates the wiki on every `develop` change, pushes it to the `.wiki.git` repository with
  the workflow token, then re-clones it and runs `--check` to prove the published wiki has not drifted.
- `scripts/build-wiki.mjs` is retired.

## Consequences

- The wiki follows the ecosystem standard and can be exported to the registry through the reference checker.
- Known reductions against ADR-0089, accepted rather than patched in the shared generator:
  - `.obsidian/core-plugins.json` (the plugin list) and `.obsidian/graph.json` (the graph colour groups) are no longer
    written; Obsidian falls back to its defaults for both.
  - The generator does not refuse an `--out` directory that is the repository or one of its parents; it prunes
    whatever it is pointed at (tracked as work item 7 of repo-standards-review). The workflow only writes into the
    `.wiki` clone, and no gate asserts the refusal.
  - An aliased wikilink, a relative link to a missing file and a missing image written in `docs/` are not reported;
    the generator also does not check that every page is reachable from `Home` by links (it requires every page to be
    indexed). The gate proves two detectors, not the eight of ADR-0089.
  - A requirement page lists its test through the RTM `TestID` section, but no longer lists its architecture view and
    decisions; an ADR page still links back to its requirements.
- The page set changes: long pages split into `-Part-N` pages, `Traceability-Matrix` is a page of its own, and
  `ADR-Index` moves from `architecture/` to the wiki root. The wiki root URL, the only inbound link, is unchanged.
- The wiki is generated with the vendored generator, so `python3` is required wherever the `wiki-vault` gate runs.
- Nobody edits the wiki directly; the next publish overwrites a direct edit.
