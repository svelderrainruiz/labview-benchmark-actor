# Release runbook — labview-benchmark-actor (concrete, agent-executable)

> The **step-by-step, copy-pasteable** end-to-end sequence for a governed Marketplace
> release, captured verbatim from the 1.1.1 publish. The companion
> `docs/release/release-procedure.md` is the ISO/IEC/IEEE 15289 *procedure* (the
> normative "what + why"); this runbook is the concrete *how* — the exact commands,
> artifact locations, and ordering an operator or future agent runs. Every repo path
> named below in backticks resolves on disk (fail-closed via the
> `release-runbook-references-resolve` gate); the ephemeral staging artifacts live in
> `~/lba-vm-share/` on the operator host, **not** in the repo.
>
> The `lba release` orchestrator (issue #409) will eventually execute this runbook
> resumably, preflighting each gate; until then this file is the manual source of truth.

## 0. Prereqs

- **Build/review on the pinned node.** The published `.vsix` is byte-reproducible only
  within an exact node version, so the whole release path is pinned by the repo-root
  `.nvmrc` (issue #408). Run `nvm use` (or install that exact version) before packaging;
  the release-path workflows source it via `node-version-file: .nvmrc`.
- **Reviewer VM up.** The `actor` reviewer VM is running with the enrolled reviewer key
  present in the VM (issue #414), and the guest-side scripts under `reviewer-workstation/`
  are reachable.
- **Host credentials + share.** `~/.config/lba/vm-pass` holds the VM password; the shared
  drop folder `~/lba-vm-share` exists (staging artifacts land here).

## 1. Cut the candidate

1. Cut `release/X.Y.Z` from `develop` (GitFlow; only release/hotfix heads may target
   `main`).
2. Bump changed component versions and the extension in `release-components.json`, synchronize
   package/component sources, and stamp `## [X.Y.Z]` in `CHANGELOG.md`. The repository precommit
   hook requires these release metadata files to be staged in their final state.
   **From 1.6.7:** the release operator checks the full reviewer infrastructure receipt against the
   selected baseline in private, before signing. Hash the exact retained receipt bytes with SHA-256.
   Put only the [three-field record](reviewer-infrastructure.schema.json) in `release-components.json`
   before building: `schema` is `reviewer-infrastructure@1`, `baseline` is the baseline version (e.g.
   `v0.1.0`), and `receiptSha256` is the 64-character lowercase hex digest. Keep the receipt private.
3. On the pinned node, build the normalized artifact: `npm run package`, from a clean
   `git worktree` of the candidate commit so no ignored local file is packaged (#55). Capture
   the candidate `commit` and the packaged `vsixSha256`. Packaging fails closed unless every
   Marketplace link in the packaged manifest names the canonical repository
   (`scripts/verify-vsix-links.mjs`, #56).
4. **Re-`npm run package` after every later seal/back-merge commit and assert the sha is
   unchanged** — the packaged file set must not move once reviewed (normalization is
   proven by `scripts/normalize-vsix.mjs`).

## 2. Machine half — cross-plane corroboration

1. Dispatch the corroboration grid at the candidate commit:
   `.github/workflows/acg-cross-plane-corroboration.yml` (`workflow_dispatch`, `--ref`
   the candidate commit). This runs genuine ubuntu + windows runners as the two OS
   planes.
2. Download the witnesses and build + validate the attestation, dropping it at
   `~/lba-vm-share/attestation-X.Y.Z.json`. The byte-reproducibility of the `.vsix`
   across planes is separately guarded by `.github/workflows/vsix-cross-plane-repro.yml`.

## 3. WIN plane validation

Run `reviewer-workstation/win-plane-validate.sh` for `release/X.Y.Z` (drives
`reviewer-workstation/win-plane-validate.ps1` in the VM): `npm ci` + compile + the test
suites + masked activation + the packaging gate, landing on `winPlaneReady:true`. The
candidate `.vsix` is staged in the VM (sha verified) via
`reviewer-workstation/stage-local-vsix.ps1`. Save the resulting WIN-plane net `DONE` frame
as `~/lba-vm-share/staged-frame-WIN-X.Y.Z.json`; this is the independent, version-bound
completion evidence for release phase 7 (neither a quorum sign-off nor a visual verdict
can substitute for it).

Stage, capture, and bind in one command (#73). With the reviewer VM running and the per-version reviewer keys
enrolled:

```
npm run lba -- release-stage-win X.Y.Z --vm <reviewer-vm> --commit <candidate-commit> \
   --vsix <candidate.vsix> --attestation ~/lba-vm-share/attestation-X.Y.Z.json
```

It copies the candidate into the VM and fails unless the VM holds the exact bytes. It then installs the extension
and confirms the listed `id@version`, and points the reviewer key setting at the `X.Y.Z` visual key. Next, it listens
for the correlated `DONE` while the in-VM sender reports the staged identity, and writes
`~/lba-vm-share/staged-frame-WIN-X.Y.Z.json`. Finally, it runs `render-verdict.sh set-target` with the evidence taken
from the attestation (`cross-plane-run`, `attestation-sha256`) plus the `windows-stage` task. The VM password comes from
`LBA_VM_PASS` or `~/.config/lba/vm-pass` and reaches VBoxManage only as a private `--passwordfile`. `--dry-run`
prints the plan, and the command refuses to overwrite an existing staged frame without `--force`.

When the infrastructure record is present, the stage command adds its digest to those evidence entries.
If setting the target manually, preserve the stage evidence and add exactly one
`--evidence "reviewer-infrastructure-receipt-sha256:<receiptSha256>"` to the same `set-target` command.
Before signing, the reviewer confirms the target carries the digest of the privately checked receipt.

The steps it composes, for diagnosis: after the WIN reviewer agent reports its stage task, await its correlated
`DONE` frame and then build the composite-ready artifact:

```
node reviewer-workstation/await-agent-reply.mjs \
   --task <stage-task-id> --type DONE \
   --out ~/lba-vm-share/stage-readback-X.Y.Z.json
node reviewer-workstation/record-release-stage.mjs \
   --component extension --version X.Y.Z --commit <candidate-commit> \
   --vsix256 <candidate-vsix-sha256> \
   --readback ~/lba-vm-share/stage-readback-X.Y.Z.json \
   --out ~/lba-vm-share/staged-frame-WIN-X.Y.Z.json
```

The awaiter ignores unrelated traffic and stops only when the correlated `DONE` arrives or its wrapper-enforced
timeout expires. The WIN `DONE` payload must be this structured identity, emitted by the stage operation rather
than copied from the host command:

```json
{"schema":"labview-benchmark-actor/release-stage@1","candidate":{"component":"extension","version":"X.Y.Z","commit":"<candidate-commit>","vsixSha256":"<candidate-vsix-sha256>"}}
```

`record-release-stage.mjs` rejects prose-only, partial, non-terminal, mismatched, or uncorrelated readbacks. It
derives the staged candidate from that WIN frame and verifies all four fields before writing the artifact.

## 4. Signing (the two human sign-offs, in the VM)

The enrolled reviewer key lives in the VM (issue #414), so signing happens guest-side.
First **discover where your key is + the exact station-bound sign commands** with
`scripts/lba.mjs signing-status` (set `LBA_VM_PASS` so it can read the VM's
`labviewBenchmarkActor.reviewerKeyPath`; it reports the key path + existence, never the
key material). Then:

> VS Code's extension page shows the Issues and Repository links only from the Marketplace
> listing. Before publishing it shows the previous release's links, or none when offline, so the
> reviewer cannot judge them there. The packaged links are gated at step 1.3, and the live
> listing's links at close-out (#56).

1. **Visual verdict.** Stage the candidate (`stage-local-vsix.ps1`), then point the renderer
   at the target with `reviewer-workstation/render-verdict.sh` (`set-target`, then `collect`
   after the in-VM "Render Reviewer Verdict"). `set-target` runs the **reviewed==shipped sha
   guard** (issue #411): it refuses to bind the target unless the .vsix staged in the VM matches
   `--vsix-sha256` (run it standalone with `render-verdict.sh guard --vsix-sha256 <sha>`). The
   reviewer's PASS is Ed25519-signed by `reviewer-workstation/sign-visual-verdict.mjs` → a
   `visual-verdict-X.Y.Z.json` record in `~/lba-vm-share/`.
2. **Machine quorum sign-off.** Use the host wrapper
   `reviewer-workstation/render-quorum.sh` (issue #415), which mirrors `render-verdict.sh`:
   `LBA_VM_PASS=… render-quorum.sh all --version X.Y.Z --attestation ~/lba-vm-share/attestation-X.Y.Z.json`
   stages the attestation into the VM, runs `sign-release-quorum.mjs` **in the VM** against the
   VM-resident enrolled key (the key never leaves the VM; it wraps the guestcontrol `cmd /c`
   node-invocation gotcha), collects the signed `quorum-signoff-X.Y.Z.json` to `~/lba-vm-share/`,
   and verifies it (`verify-quorum-signoff.mjs`: enrolled key + passing cross-plane quorum, fail-closed).
3. Verify both locally before sealing: `tools/release-governance/verify-visual-review.mjs` and
   the composite verifier `tools/release-governance/verify-composite-release.mjs`.

## 5. Seal — receipt + agreement

1. **Composite receipt.** Assemble the composite release-decision receipt with the actual
   assembler, writing `reviewer-workstation/composite-release-decision-receipt.json`:

   ```
   node reviewer-workstation/assemble-composite.mjs \
     --component extension --version X.Y.Z --commit <candidate-commit> \
     --vsix256 <candidate-vsix-sha256> \
     --attestation ~/lba-vm-share/attestation-X.Y.Z.json \
     --quorum-signoff ~/lba-vm-share/quorum-signoff-X.Y.Z.json \
     --visual-verdict ~/lba-vm-share/visual-verdict-X.Y.Z.json \
     --staged-frame ~/lba-vm-share/staged-frame-WIN-X.Y.Z.json \
     --out reviewer-workstation/composite-release-decision-receipt.json
   ```

   The committed `candidate.version == X.Y.Z` is the **single source of truth** for the
   enforced version (issue #416) — no gate file hardcodes a version, so the bump touches
   only this receipt (+ `package.json` + `CHANGELOG.md`).
2. **Record the agreement.** Instead of hand-editing JSON, run the recorder (issue #419):

   ```
   node tools/release-governance/record-release-agreement.mjs \
     --component extension --version X.Y.Z --commit <sha> \
     --linux-note "..." --win-note "..." \
     --visual-verdict ~/lba-vm-share/visual-verdict-X.Y.Z.json
   ```

   It inserts the `components.extension.releases.<version>` entry (both planes
   `agreed:true` + the embedded signed `visualReview`) as a minimal structured edit into
   `tools/release-governance/release-agreement.json`, refuses to clobber an existing version, and
   fails closed unless `tools/release-governance/verify-release-agreement.mjs` +
   `tools/release-governance/verify-visual-review.mjs` both pass for that version.
   These two generated sealing receipts are release evidence, not product-component source;
   the precommit version classifier therefore permits their post-signing update without
   forcing a new extension or `lbabus` identity.
3. **Preflight.** `npm run lba -- release-preflight X.Y.Z` must be all green: it asserts
   the local node equals `.nvmrc`, `package.json` + `CHANGELOG.md` are at `X.Y.Z`, the
   composite receipt `candidate.version == X.Y.Z`, and the live publish gates clear. Both preflight and
   the workflow's `agreement` job run `scripts/verify-reviewer-infrastructure.mjs` against the sealed
   candidate. A pass proves the signed verdict commits to the public digest, not that the infrastructure
   matches the receipt. Published releases are not re-checked.
   The visual key must have `validFrom` and `validThrough` both equal to `X.Y.Z` and the `visual`
   purpose. Ranges are insufficient for this gate. Supply stable versions without leading zeros;
   pre-release versions and duplicate JSON member names are rejected.

## 6. Reconcile + merge to main

1. Merge `origin/main` into the release branch to absorb any divergence (issue #417),
   resolving the sealing files (`reviewer-workstation/composite-release-decision-receipt.json`,
   `tools/release-governance/release-agreement.json`) with `--ours`; verify no main-unique commit
   is lost.
2. Open the PR to `main` and merge with `--no-ff` (never squash a release), so
   `main` ↔ `develop` never diverge (`docs/cm/cm-plan.md`).
3. After the back-merge to `develop`, verify shared lineage:
   `node experiments/release/verify-release-lineage.mjs --check` (fails closed if any `ext-v*`
   tag is not an ancestor of BOTH `main` and `develop`, issue #417). If a prior release diverged
   and `develop` already carries its content, reconcile with `git merge -s ours origin/main`
   into `develop` (records shared ancestry without changing develop's tree).

## 7. Publish

1. Dispatch `.github/workflows/extension-release.yml` (`workflow_dispatch`,
   `-f version=X.Y.Z -f publish_marketplace=false`, `--ref main`). The `agreement` job runs
   `tools/release-governance/verify-composite-release.mjs --component extension X.Y.Z` and blocks
   the publish unless the committed composite decision proves both gates for the tagged
   candidate. This first dispatch stages signed assets and does not publish to Marketplace.
2. Confirm reviewed == shipped: `scripts/verify-published-vsix.mjs` asserts the CI-built
   `.vsix` sha256 equals the reviewed `vsixSha256`.
3. Cut the canonical immutable GitHub Release from the signed artifact: download the
   `ext-vsix-signed-X.Y.Z` build artifact, then
   `gh release create ext-vX.Y.Z <assets> --notes-file <changelog section> --target main`
   (an authorized bypass token is needed to push the protected `ext-v*` tag).
4. Dispatch the workflow again with
   `-f version=X.Y.Z -f publish_marketplace=true --ref ext-vX.Y.Z`. Its `publish` job waits for the
   operator to approve the `marketplace` environment deployment, downloads the canonical release VSIX,
   requires its SHA-256 to equal the staged VSIX, then publishes it with `vsce publish --oidc`
   (Trusted Publishing; no stored PAT). A tag cut before Trusted Publishing still carries the PAT
   workflow, so publish such a release with `--ref main`; the SHA-256 check still binds the upload to
   the canonical release asset.

## 8. Close out

1. Back-merge the release tip to `develop` with `--no-ff` (issue #417) so the version
   bump, receipt, and agreement return to integration.
2. Assert `git merge-base --is-ancestor <release-tip> main` **and** `… develop` — the
   release tip is an ancestor of both, so the planes stay in sync.
3. Re-check the Marketplace listing (the gallery API lags a few minutes) with
   `npm run lba -- release-verify-published X.Y.Z`. It also requires every listing link,
   Issues (`Links.Support`) included, to name the canonical repository (#56), and it downloads the VSIX the
   Marketplace serves and the `ext-vX.Y.Z` GitHub Release asset and requires both to equal the reviewed artifact
   (the signed visual-verdict target in `release-agreement.json`, #71). A successful query records
   `~/lba-vm-share/marketplace-verification-X.Y.Z.json` with the three hashes, allowing the resumable driver to
   recognize phase 13 only after the required release-tip back-merge to `develop` is also
   proven. Record the closeout in the regenerated `docs/testing/test-report.md` counts.

## Artifact + credential map

| Item | Location |
| --- | --- |
| Node pin | `.nvmrc` (sourced by every release-path workflow) |
| Cross-plane attestation | `~/lba-vm-share/attestation-X.Y.Z.json` (host) |
| WIN staging net frame | `~/lba-vm-share/staged-frame-WIN-X.Y.Z.json` (host) |
| Signed visual verdict | `~/lba-vm-share/visual-verdict-X.Y.Z.json` (host) |
| Marketplace verification | `~/lba-vm-share/marketplace-verification-X.Y.Z.json` (host) |
| Composite receipt (committed) | `reviewer-workstation/composite-release-decision-receipt.json` |
| Release agreement (committed) | `tools/release-governance/release-agreement.json` |
| Marketplace publish credential | none stored: Trusted Publishing policy on the `svelderrainruiz` publisher for `extension-release.yml` + environment `marketplace` |
| `ext-v*` tag push | an authorized bypass token (protected tag) |
