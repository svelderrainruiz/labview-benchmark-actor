# ADR-0087: Re-certify the standards baseline at repo-standards-review v0.4.1 through the RSR consumer kit

- Status: Accepted
- Date: 2026-11-14
- Amended: 2026-11-14 (the kit and governance pin move to v0.4.2, commit `5a3aa9da`, workbench
  `sha256:913bba59…cfe5`, which LF-pins the kit's root files; the v0.4.2 deep run gives a byte-identical raw
  score, so only the source identity changes, #52)
- Amended: 2026-11-16 (the kit and governance pin move to v0.6.0, commit `d25cfc16`, workbench
  `sha256:6283bb7d…1890`; the static baseline is re-captured on the current tree as raw score `46e48d9a…a265`,
  which is still 25/25 with six PASS/High gates, DoD 5/5 and no contradictions. A control run of the v0.4.2
  workbench on the same tree gives a byte-identical raw score, so the hash change comes from this repository's
  own evolution since 2026-11-14, not from the standard; VITechnologies/projectbuddy#332)
- Amended: 2026-11-16 (the kit and governance pin move to v0.8.0, commit `d4d022b9`, workbench
  `sha256:068e5d58…a551`; v0.8.0 adds the ecosystem wiki standard `@3` and `@4`, which are test-page content
  rules, with no layout or finding changes. The v0.8.0 deep run on the current tree gives a raw score
  byte-identical to the v0.6.0 re-capture (`46e48d9a…a265`): 25/25, six PASS/High gates, DoD 5/5 and no
  contradictions. A control run of the v0.6.0 workbench on the same tree gives the same bytes, so neither the
  standard nor this repository changed the score, and only the source identity changes;
  VITechnologies/projectbuddy#346)
- Amended: 2026-11-17 (the kit and governance pin move to v0.9.0, commit `8306ebc7`, workbench
  `sha256:22a05f23…3582`; v0.9.0 moves the ecosystem wiki standard to `@5`, which adds wiki profile
  `rsr/wiki-profile@2` (a scope may declare several ID prefixes, `idPrefixes`) and an observation rule, with no
  layout or finding changes for this repository. The v0.9.0 deep run on the current tree gives a raw score
  byte-identical to the v0.6.0 re-capture (`46e48d9a…a265`): 25/25, six PASS/High gates, DoD 5/5 and no
  contradictions. A control run of the v0.8.0 workbench on the same tree gives the same bytes, so neither the
  standard nor this repository changed the score, and only the source identity changes;
  VITechnologies/projectbuddy#348)
- Amended: 2026-11-18 (the kit and governance pin move to v0.10.0, commit `2065a7de`, workbench
  `sha256:da37a471…b793`; v0.10.0 moves the ecosystem wiki standard to `@6`, whose test-case items name the
  runner's test cases verbatim and whose new observation check, outside conformance, has three findings. The kit
  adds its reference observation checker, `.repo-standards-review/observations.py`, which CI does not run and the
  VSIX excludes. RSR changed no scoring script, so there are no layout, finding or score changes for this
  repository. The v0.10.0 deep run on the current tree gives a raw score byte-identical to the v0.6.0 re-capture
  (`46e48d9a…a265`): 25/25, six PASS/High gates, DoD 5/5 and no contradictions. A control run of the v0.9.0
  workbench on the same tree gives the same bytes, so neither the standard nor this repository changed the score,
  and only the source identity changes; VITechnologies/projectbuddy#364, #84)
- Amended: 2026-11-18 (the kit and governance pin move to v0.11.0, commit `6fefbc25`, workbench
  `sha256:9ed6423b…8df2`; v0.11.0 moves the ecosystem wiki standard to `@7`, whose test-case items may name only a
  test file, which then requires every test case of that file to pass, and which counts a test file that its
  runner cannot load as one failing `(load error)` test case. The kit's reference observation checker,
  `.repo-standards-review/observations.py`, now reads pytest JUnit reports, adds a `stimulus` command and refuses
  document types and entity declarations in reports; CI still does not run it and the VSIX excludes it. RSR changed
  no scoring script (in `scripts/`, only the observation check `eval_test_observations.py` changed), so there are
  no layout, finding or score changes for this repository. The v0.11.0 deep run on the current tree gives a raw
  score byte-identical to the v0.6.0 re-capture (`46e48d9a…a265`): 25/25, six PASS/High gates, DoD 5/5 and no
  contradictions. A control run of the v0.10.0 workbench on the same tree gives the same bytes, so neither the
  standard nor this repository changed the score, and only the source identity changes;
  VITechnologies/projectbuddy#369, #86)
- Amended: 2026-11-19 (the kit and governance pin move to v0.12.0, commit `49dfa312`, workbench
  `sha256:1b6e639e…a241`. The v0.12.0 deep run (`release-gate`, standards corpus mounted read-only) on the current
  tree was measured with `score.json` SHA-256 `46e48d9a…a265`, byte-identical to the v0.6.0 re-capture: 25/25, six
  PASS/High gates, DoD 5/5 and no contradictions. No control run of an earlier workbench was made for this
  amendment; the score is unchanged against the retained baseline, and only the source identity moves;
  VITechnologies/projectbuddy#387)
- Amended: 2026-11-20 (the kit and governance pin move to v0.15.0, commit `3d4a10f1`, workbench
  `sha256:f3193f85…c278`, from the kit manifest `manifests/v0.15.0.json` through `cruft update` with the release-owned
  values. The v0.15.0 deep run (`--profile release-gate --depth deep`, standards corpus mounted read-only) on the
  current tree scores 25/25, six PASS/High gates, DoD 5/5 and no contradictions. A control run of the v0.12.0
  workbench on the same tree gives a byte-identical `score.json` (SHA-256 `babbeba2…898e`); the retained baselines are
  re-captured on that hash because this repository's own content changed since 2026-11-19, not the standard;
  #99)
- Owner: LINUX
- Traces to: LBA-REQ-008, LBA-REQ-096
- Amends: [ADR-0079](ADR-0079-standards-release-risk-overlay.md). The overlay is unchanged; the static
  baseline it preserves is the v0.6.0 re-capture, re-identified as v0.15.0 by the last amendment above.

## Context

The repository was certified against `repo-standards-review` v0.2.19 (commit `d44f210d`) in 2026-08.
`release-components.json`, both retained baselines and the agent contract pin that release. The CM plan
allows the stamp to move only together with a re-validation.

RSR has since released v0.4.x. It publishes a consumer kit and one release manifest per tag (tag, commit,
workbench image by digest) at `github.com/svelderrainruiz/repo-standards-review-consumer-kit`, so that every
ecosystem repository pins a release the same way (VITechnologies/projectbuddy#277). Two findings came out of
the first v0.4.x run against this repository:

- Since v0.2.20, RSR scores the DoD gate on a 0-5 scale. A PASS needs an itemized checklist that contribution
  or pull-request guidance links to. The exit criteria here were a table only, so the gate scored 2/5.
- The v0.4.0 workbench reported line endings as unknown for every mounted repository. RSR v0.4.1 fixed this
  (VITechnologies/projectbuddy#279).

## Decision

- Adopt the consumer kit at v0.4.1:
  - `.repo-standards-review.json` pins the release, and `.cruft.json` links the kit at the same tag.
  - The kit's LF rules head `.gitattributes` and end with the kit's closing line; this repository's own rules
    follow. The answers pin `*.py` and the shebang PowerShell scripts to LF, and exempt the Windows-captured
    `win-vm-*.json` fixtures and the Windows-container evidence, which keep their CRLF bytes.
  - The `repo-standards-review` workflow runs the kit's check, which compares the pin with the published
    manifest.
- Move the governance pin in `release-components.json` to v0.4.1 (commit `6386084c`, workbench digest
  `sha256:c31d824d…4e9b`). A local gate requires the kit pin and the governance pin to name the same release.
- Carry the seven DoD exit criteria as a checklist in `.github/pull_request_template.md`. The
  `dod-definition-present` gate keeps the checklist equal to the DoD table.
- Re-certify `standards-score-baseline.json` and `release-risk-baseline.json` from one v0.4.1 `release-gate`
  deep run, with the standards corpus mounted read-only. The run found:
  - all five areas at 5/5 and all six gates PASS (DoD confidence is now High);
  - no contradictions;
  - 319 executable scripts pinned to LF.
  
  The release-evidence overlay stays at 12/28 (BLOCKED): it counts this repository's own release proofs, which
  did not change.
- Records made against v0.2.19 stay as written: per-ADR stamps, ADR-0079's context, earlier CHANGELOG entries,
  and past proofs.

## Consequences

- Later RSR releases arrive as `cruft update` changes (VITechnologies/projectbuddy#276). Each governance bump
  still re-certifies both baselines and bumps the `agents` and extension versions, as `release-components.mjs`
  requires.
