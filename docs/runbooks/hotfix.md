# Hotfix sub-flow

A hotfix targets `main` directly when a critical bug in `@latest` cannot wait for the next Monday cut. The sub-flow is intentionally rare; most fixes go through `next` and ship at the regular Monday cadence.

## When this applies

- Critical operator-facing bug in the current `@latest` build (e.g. broken bootstrap, broken claim flow, security disclosure).
- Captain has decided the regression cannot wait for Monday.
- The `fix(incident)` shape from `docs/engineering/handbook.md` §The shapes of work applies.

If any of the above is in doubt: ship through `next` at the normal cadence.

## Release-review gate carve-out

The Monday cadence opens a standing **release-review PR** (`base: main`, `head: next`) as the holistic-review surface for the release window — see `docs/engineering/handbook.md` §Cadence and [DR-2026-05-20](../../log/decisions/2026-05-20-holistic-release-review-gate.md).

**Hotfixes do not open a release-review PR.** They bypass `release-notes-scaffold.yml` entirely (that workflow runs only on the Monday cron / `workflow_dispatch`). For a hotfix, the holistic-review surface *is* the hotfix PR-to-`main` itself (step 4 below): the hotfix is a single small, scoped patch, so its own PR diff is already the whole change. There is no separate release-window diff to review because a hotfix is not a release window — it is one out-of-cadence patch. The `promote-main.yml` audit-comment step is best-effort and a missing release-review PR on the hotfix path is expected and non-fatal.

## Steps

1. **Branch from `main`:** `git fetch origin && git checkout -b hotfix/<bd-id>-<slug> origin/main`.
2. **Write the regression test first** (rule 7 — deferred-not-waived on incident). Reproduce the failure.
3. **Implement the smallest patch.** Do not bundle unrelated work.
4. **PR against `main`.** Title: `fix(incident)(<bd-id>): <one-line summary>`. Body: incident link, root cause, blast radius, evidence.
5. **Relaxed review (rule 4 + emergency sub-flow):** one reviewer; reviewer documents justification in the PR body. Reviewer may be the same human/agent who shipped if escalation requires it — document this.
6. **Merge to `main`.** `gh pr merge --squash --delete-branch`.
7. **Manually cut a named release on `main` HEAD:** `gh release create v<x.y.z> --target main --title "v<x.y.z> — Hotfix (<one-line>)" --notes-file <evidence-body>`. The release body MUST include the `jinn-release-evidence:v1` marker; for hotfixes, the evidence entries reduce to whatever was practical in the incident window — but they MUST be present (the npm-publish.yml stable-publish step rejects releases without the marker).
8. **Publish triggers** `npm-publish.yml` → `@latest`, `promote-main.yml` (no-op — main already at the release SHA), `changelog-mirror.yml`.
9. **Back-merge `main → next` (MANDATORY):**

   ```bash
   git fetch origin
   git checkout next
   git pull --ff-only origin next
   git merge --no-ff origin/main -m "chore: back-merge hotfix v<x.y.z> into next"
   git push origin next
   ```

   If the back-merge has conflicts, open a `chore` PR titled `chore: back-merge hotfix v<x.y.z>` against `next` and resolve there.

10. **File the post-hoc beads** (incident sub-flow):
    - regression-test follow-up (if the regression test in step 2 was minimal-only)
    - proper-fix bead (if the patch was a workaround)
    Both blocked-by the incident bd; both must close before the incident bd closes.

## Anti-patterns

- **Don't cherry-pick to main from next.** If a fix sits on next and needs to ship out of cadence, treat it as a hotfix: open a new PR from a branch off main with the fix's content.
- **Don't skip the back-merge.** Without it, `next` will conflict with `main` at the next promote, and main can diverge from next in a way that makes the next promote-main fail-loud.
- **Don't bundle a hotfix with a non-incident fix.** Two hotfixes can share a PR only if the incident scope unambiguously covers both.
