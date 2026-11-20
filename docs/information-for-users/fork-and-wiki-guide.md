# Fork and wiki guide

> How to fork this repository and publish your own copy of its wiki. Aligns to
> **ISO/IEC/IEEE 26514:2022 §5**. See also [Getting Started](./getting-started.md)
> and [Join the mesh](./join-the-mesh.md).

The wiki is generated from `docs/`, which is the single source of truth. A fork
publishes its **own** wiki from its **own** `docs/`; it never writes to the
upstream wiki.

## Bootstrap checklist

1. **Fork** the repository on GitHub. Keep the default branch name `develop`:
   the workflow publishes from that branch only.
2. **Enable Actions** on the fork (Actions tab, or
   `gh api -X PUT repos/<fork>/actions/permissions -F enabled=true -f allowed_actions=all`).
   A fork's workflows are not registered, and a push may not start them, until
   Actions is enabled and a push has touched `.github/workflows/`; start
   `wiki-publish` with *Run workflow* if a push does not.
3. **Enable the wiki** (Settings, Features, Wiki) and **create the first page in
   the web UI** (any title, any text). A fork's `<fork>.wiki.git` repository does
   not exist until a page is created, so the first clone or push fails without
   this step. The workflow overwrites that page.
4. **Point the generator at your fork.** In `.wiki-generator.json` set `repoUrl`
   (and any URL in `description`) to your fork, so wiki links resolve to your
   repository instead of the upstream one. The job succeeds without this edit,
   but the generated pages then link to the upstream. The generated Home page
   replaces the page you created, so put any fork notice in `description`.
5. **Opt in.** Create the repository variable `WIKI_PUBLISH_ENABLED` with the value
   `true` (Settings, Secrets and variables, Actions, Variables). Without it the
   `wiki-publish` job is skipped on a fork (fail closed). On the upstream it runs
   without the variable.
6. **Run the workflow.** Push to `develop` or start `wiki-publish` from the
   Actions tab. The job uses only the fork's own `GITHUB_TOKEN`
   (`contents: write`) and pushes only to the fork's own wiki. It needs no
   secrets.

## What breaks on a fork

- **Marketplace publishing.** The `publish` job in `extension-release.yml` uses OIDC
  Trusted Publishing: no publishing secret is stored, and the publisher's policy
  trusts only the upstream repository. The job is also guarded by a
  `github.repository ==` check, so it is skipped on a fork. Likewise the
  devcontainer image push in `devcontainer-prebuild.yml` is guarded to the
  upstream. A fork that wants to publish needs its own publisher and policy.
- **Runners.** The workflows use GitHub-hosted runners (Ubuntu and Windows), so a
  fork needs no self-hosted runner for them. Lanes that need LabVIEW on a real
  machine are not covered by hosted runners and show as not run.
- **Test pages.** The wiki test pages show the evidence the job produced on your
  fork at your commit. Anything that did not run there is shown as not run, not as
  passed.

## Sending evidence upstream (issues built, pull requests planned)

The submission **issue** path is built ([ADR-0091](../architecture/adr/ADR-0091-verify-fork-wiki-submissions-as-data.md)).
The pull request path for page changes, the lineage field on pages and the
local producer are not built yet. The intended design is:

- A fork submits evidence to the upstream through an **issue** (a form with a
  structured record), and through a **pull request** for page changes, with
  evidence files attached.
- The upstream keeps a private partner **allow-list**. It is unset by default,
  so by default no submission is accepted.
- Only **attested** evidence counts: the upstream re-verifies the submitted
  evidence with its own pinned verifier code, in an isolated job, against its own
  test definitions. The fork's scripts are never run with upstream privileges, and
  fork content is treated as data. Evidence that is not verified is labelled
  *not attested*.
- Each page carries a **lineage** field (source repository and commit) that the
  fork owns; the upstream records only submissions it accepted.

### How a partner submits an issue

1. The upstream operator lists your fork's owner (your user or organisation
   login, optionally pinned to its numeric account id) in the upstream's
   private partner allow-list. Nothing is enabled until the operator does so:
   an unset or empty list rejects every submission, and the list is not
   published. You must be that owner, or a public member of the owning
   organisation, to submit.
2. Run the tests on your fork at a pushed commit (`fork_commit`) and commit the
   resulting `wiki-evidence.json` (`rsr/test-evidence@1`, one platform) in a
   later commit (`evidence_commit`): the generator records the commit it ran
   at, which cannot be the commit that adds the evidence file itself. The
   evidence must record `commit == fork_commit`, and `evidence_commit` must be
   `fork_commit` or ahead of it in your fork.
3. Open an issue on the upstream titled `[wiki-submission] <anything>` whose
   body is **only** one JSON document of schema `rsr/wiki-submission@1`
   (`scripts/wiki-submission.schema.json`): your fork, the full 40-hex fork
   commit and evidence commit, the upstream base commit, generator version,
   platform, the test ids
   with their results, the evidence files with their sha256, and the lineage
   (source repository and commit). Editing the issue re-runs verification;
   renaming the title away from the prefix withdraws an earlier attestation.
4. The workflow answers with the label `wiki-attested` or `wiki-not-attested`
   and a fixed comment that names the upstream commit that verified it and a
   reason code.

**What attested means.** The fork owner is a listed partner and you are that owner or a public member of it, the fork is a fork of
this repository, the evidence files fetched from your fork at that commit match
the declared sha256 and size limits, and the test ids, results, commit and
platform agree with this repository's own test files and canonical evidence
rules. Nothing from your fork is checked out or run, and none of your text is
echoed back. Attested is not a claim that your code is correct.
