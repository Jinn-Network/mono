# Build a holistic release-review gate as an auto-opened PR

Date: 2026-05-20
Author: opus
Resolves: issue #307

## Summary

Add a soft, build-it-new holistic-review gate for the Monday release cadence:
`release-notes-scaffold.yml` opens-or-updates a single standing **release-review
PR** (`base: main`, `head: next`) alongside the GitHub Release draft. Its diff is
the entire release window (`main...next`) in one reviewable view. Nothing
mechanically blocks publish — the gate is a **soft convention**: the value is the
whole-window diff existing and being looked at before Captain clicks Publish.

## Context

Issue #307 was filed as "investigate: restore holistic-review-at-main gate that
qlol removed" and the spike it requested corrected its own premise: **there was
never a `next → main` PR before qlol.** The pre-qlol flow was single-trunk on
`main` — there was no `next` branch and therefore no `next → main` review
surface to lose. The qlol two-train cutover (2026-05-15) introduced `next` as the
integration branch and moved publishing to the `release: published` event, with
`promote-main.yml` fast-forwarding `main`. So #307 does **not** restore a removed
gate; it builds a new one.

The genuine missing artifact is real: a single reviewable diff of the whole
release window. The v0.1.6 cut (2026-05-19, the first under the qlol flow)
shipped a bug — PR #301 was silently shadowed by hardcoded values in `main.ts`,
surfaced only later by #303. That bug was:

- invisible **per-PR** — #301 looked correct in isolation and was CI-green;
- invisible in the **release-notes title list** — the title list is merged-PR
  subjects, not a diff, so a later PR shadowing an earlier one does not show up;
- visible only in the **cumulative `main...next` diff** — where the shadowing
  interaction between the two PRs is on screen at once.

No surface in the qlol flow shows that cumulative diff. That is the gap #307
addresses.

## Decision

Build the gate as **Option B-adapted, a soft convention** (project owner's call):

1. `release-notes-scaffold.yml` — after the "Create or update the Release draft"
   step, open-or-update a standing release-review PR (`base: main`, `head: next`).
   Idempotent: query `gh pr list --base main --head next` first; create only if
   absent, otherwise refresh title/body (GitHub keeps exactly one open PR per
   base/head pair and auto-refreshes its diff as `next` advances). The workflow's
   `permissions` block gains `pull-requests: write`.
2. `promote-main.yml` — no functional change. Its fast-forward of `main` to
   `next` HEAD auto-closes the release-review PR as merged. A trailing
   best-effort `gh pr comment` step records the publish for the audit trail.
3. `npm-publish.yml` — no change. This is a soft gate; nothing mechanically
   blocks publish.
4. Docs — `docs/runbooks/hotfix.md` documents the hotfix carve-out (ships in
   this PR). `docs/engineering/handbook.md` §Cadence gains a release-review-gate
   paragraph in a separate Discussion-gated docs PR (canonical-doc change).

**Hotfixes do not open a release-review PR.** They bypass
`release-notes-scaffold.yml` entirely; their holistic-review surface is the
hotfix PR-to-`main` itself.

## Rationale

- **The value is the diff, not a second identity.** With one Captain, a
  `next → main` PR is Captain-reviews-Captain — a hard gate (merging the PR *is*
  the publish, à la Option A) adds dual-control theatre, not dual control. What
  was actually lost is not a second approver; it is a *place to see the whole
  window at once*. A soft-convention PR provides exactly that place and nothing
  more.
- **Soft over hard avoids re-introducing qlol's frictions.** Option A (trigger
  publish on `push: branches: [main]`, drop the auto-FF, require a manual
  `next → main` PR per cut) would re-couple publishing to a manual merge and
  partially unwind the qlol two-train design. #307 explicitly forbids reverting
  qlol. A soft gate leaves the publish trigger (`release: published`) and the
  `promote-main.yml` fast-forward mechanics untouched.
- **Idempotency is free.** GitHub permits at most one open PR per base/head
  pair and auto-refreshes its diff as `next` advances. "Create if absent, else
  no-op/refresh" is the entire contract. On the happy path the PR closes itself
  when `promote-main.yml` fast-forwards `main`, so there is no per-cut PR
  lifecycle to manage. The one off-happy-path case is an **abandoned draft**: if
  a Monday draft is never published, the release-review PR stays open and the
  next Monday's scaffold finds it and refreshes (re-labels) its title/body to
  the new window rather than opening a second PR. That adopt-and-relabel
  behaviour is the accepted outcome — it falls out of the "create if absent,
  else refresh" contract for free and keeps exactly one standing PR regardless
  of how many drafts were skipped.
- **Option C (release-draft reviewers) was rejected** — GitHub Releases have no
  reviewer-approval primitive; a draft's only gate is who can click Publish.
  There is nothing to build against.

## Code state

Implemented in this change:

- `.github/workflows/release-notes-scaffold.yml` — `pull-requests: write`
  permission; new "Open or update the release-review PR" step after the draft
  step.
- `.github/workflows/promote-main.yml` — `pull-requests: write` permission; a
  step that captures the open release-review PR number before the fast-forward,
  and a trailing best-effort audit-comment step that comments on that exact
  captured PR (no change to FF mechanics).
- `docs/runbooks/hotfix.md` — documents the hotfix carve-out.
- `docs/engineering/handbook.md` §Cadence — the release-review-gate paragraph
  ships as a **separate docs PR**. The handbook is a canonical doc, so per the
  `docs` work-shape SOP its edit needs a Discussion + CODEOWNERS approval and
  cannot ride this `chore` PR.

A GitHub Actions workflow cannot be fully e2e-tested locally. The YAML parses
(`python3 -c "import yaml; ..."`) and lints (`actionlint`); the `gh pr`
idempotency logic is reasoned through above. The real verification is a live
Monday-cut dry-run (or a `workflow_dispatch` run) confirming the PR is created
once and refreshed thereafter.

## Follow-up

- Enable the Monday cron on `release-notes-scaffold.yml` (currently
  `workflow_dispatch` only) — out of scope for #307; the release-review PR
  rides along whenever the scaffold is promoted to cron.
- After the first live Monday-cut dry-run, confirm the PR opens once, refreshes
  on subsequent runs, and auto-closes on publish.

## References

- Issue #307: https://github.com/Jinn-Network/mono/issues/307
- qlol two-train cutover — `docs/engineering/handbook.md` §Cadence
- `.github/workflows/release-notes-scaffold.yml`, `promote-main.yml`,
  `npm-publish.yml`
- `docs/runbooks/hotfix.md` — hotfix sub-flow + release-review carve-out
