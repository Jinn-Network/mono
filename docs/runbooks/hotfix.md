# Hotfix sub-flow

A hotfix targets `main` directly when a critical bug in `@latest` cannot wait for the next Monday cut. The sub-flow is intentionally rare; most fixes go through `next` and ship at the regular Monday cadence.

## When this applies

This is the only sanctioned exception to the handbook §Cadence "PRs target `next`" rule; all non-hotfix PRs target `next`. See [`docs/engineering/handbook.md`](../engineering/handbook.md) §Cadence (PR base policy) and §AI workflow rules (rule 10).

- Critical operator-facing bug in the current `@latest` build (e.g. broken bootstrap, broken claim flow, security disclosure).
- Captain has decided the regression cannot wait for Monday.
- The `fix(incident)` shape from `docs/engineering/handbook.md` §The shapes of work applies.

If any of the above is in doubt: ship through `next` at the normal cadence.

## Release-review gate carve-out

The Monday cadence opens a standing **release-review PR** (`base: main`, `head: next`) as the holistic-review surface for the release window — see `docs/engineering/handbook.md` §Cadence and [DR-2026-05-20](../../log/decisions/2026-05-20-holistic-release-review-gate.md).

**Hotfixes do not open a release-review PR.** They bypass `release-notes-scaffold.yml` entirely (that workflow runs only on the Monday cron / `workflow_dispatch`). For a hotfix, the holistic-review surface *is* the hotfix PR-to-`main` itself (step 4 below): the hotfix is a single small, scoped patch, so its own PR diff is already the whole change. There is no separate release-window diff to review because a hotfix is not a release window — it is one out-of-cadence patch. The `promote-main.yml` audit-comment step is best-effort and a missing release-review PR on the hotfix path is expected and non-fatal.

## Steps

> **Guard recognition.** The `Main base guard` required check on `main` (`.github/workflows/main-base-guard.yml`) recognises the hotfix shape by either of two signals: a head branch matching `hotfix/*`, or a PR title beginning with `fix(incident)`. Both are produced by following the steps below verbatim; if the guard fails on a hotfix PR, neither signal is present — fix the branch name or rename the PR title and the check re-runs.

1. **Branch from `main`:** `git fetch origin && git checkout -b hotfix/<issue-#>-<slug> origin/main`.
2. **Write the regression test first** (rule 7 — deferred-not-waived on incident). Reproduce the failure.
3. **Implement the smallest patch.** Do not bundle unrelated work.
4. **PR against `main`.** Title: `fix(incident)(<issue-#>): <one-line summary>`. Body: incident link, root cause, blast radius, evidence.
5. **Relaxed review (rule 4 + emergency sub-flow):** one reviewer; reviewer documents justification in the PR body. Reviewer may be the same human/agent who shipped if escalation requires it — document this.
6. **Merge to `main`.** `gh pr merge --squash --delete-branch`.
7. **Manually cut a named release on `main` HEAD:** `gh release create v<x.y.z> --target main --title "v<x.y.z> — Hotfix (<one-line>)" --notes-file <evidence-body>`. **Hotfix evidence is the same two SHA-bound check-runs as the regular cut** — `hermetic-gate=success` and `environment-suite=success` bound to the hotfix SHA — not a hand-typed marker (two-gate redesign, [`docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md`](../superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md) §15). The hotfix SHA lands on `main` via the merge in step 6; `hermetic-gate` runs on it per-push, and the authoritative `environment-suite` run is dispatched on that SHA. The transitional `JINN_ENVIRONMENT_SUITE_WAIVED == 'true'` repo variable waives the `environment-suite` requirement until the testnet-gate secrets are provisioned, and `JINN_HERMETIC_GATE_WAIVED == 'true'` likewise waives `hermetic-gate` until the Anvil snapshot fixture lands; both default unset, and when unset both check-runs are hard-required. The release notes body is free-form (incident link, root cause, blast radius) — no `jinn-release-evidence:v1` marker is required or parsed.
8. **Publish triggers** `npm-publish.yml` → publish guard verifies the two check-runs on the release SHA (re-runs nothing, §7) → `@latest`, `promote-main.yml` (no-op — main already at the release SHA), `changelog-mirror.yml`.
9. **Back-merge `main → next` (MANDATORY).** The back-merge is a PR through the merge queue on `next`. No actor retains direct push to `next` ([DR-2026-08-18-b](../../log/decisions/2026-08-18-merge-queue-on-next.md) D2; [`docs/engineering/handbook.md`](../engineering/handbook.md) §Cadence).

   ```bash
   git fetch origin
   git checkout -b chore/back-merge-v<x.y.z> origin/next
   git merge --no-ff origin/main -m "chore: back-merge hotfix v<x.y.z> into next"
   # if the merge stops on conflicts, resolve them here and commit
   git push -u origin chore/back-merge-v<x.y.z>
   gh pr create --base next \
     --title "chore: back-merge hotfix v<x.y.z>" \
     --body "Back-merge of hotfix v<x.y.z>. Incident: #<issue-#>."
   ```

   The PR needs one approving review under a code-owner credential, recorded on a non-author account, because a `main → next` merge touches code-owned paths essentially by construction. Once that review and the required checks are green, enqueue it with **Merge when ready**, exactly like an ordinary PR.

   The honest cost is one queue battery of latency plus the review cycle. That cost is affordable because step 9 is post-incident hygiene rather than the emergency itself: the fix already shipped to `@latest` at step 8, so nobody is waiting on the back-merge.

   **Transition note.** Until the merge-queue ruleset on `next` is live (DR-2026-08-18-b step 1, issue [#2799](https://github.com/Jinn-Network/mono/issues/2799)), this same PR merges the ordinary way instead of through a queue. The PR shape is canonical either way; the direct push is retired now, not when the queue turns on.

   **Divergence alert during this window.** Between the step-6 merge to `main` and this back-merge landing on `next`, `main` is not an ancestor of `next`, so the `main-next ancestor check` workflow opens or updates its `[main-next-divergence]` alert issue. That is expected, and the alert is self-healing: the workflow runs again on the push that lands the back-merge and closes the issue itself.

10. **File the post-hoc follow-up Issues** (incident sub-flow):
    - regression-test follow-up Issue (if the regression test in step 2 was minimal-only)
    - proper-fix Issue (if the patch was a workaround)
    Both are sub-issues of the incident Issue; both must close before the incident Issue closes.

## Break-glass (wedged queue)

If the merge queue on `next` is wedged, meaning a GitHub incident has taken it down or every entry is failing for a reason unrelated to the entries, and a critical fix must land on `next`:

1. A repo admin disables the `merge_queue` rule on the `next` ruleset. This is a ruleset edit, so it is auditable in the repository's ruleset history.
2. Land the critical PR through the still-required checks. Only the queue rule comes off; the required-check rule and the review rules stay in force.
3. Re-enable the `merge_queue` rule on the `next` ruleset.
4. Immediately dispatch the policy audit to confirm the restored state:

   ```bash
   gh workflow run "Architecture Policy Audit"
   ```

Never a silent push. There is no direct-push path to `next` for anyone, admins included, and break-glass does not create one: it swaps the queue for the same required checks, under an edit that leaves a record.

## Anti-patterns

- **Don't cherry-pick to main from next.** If a fix sits on next and needs to ship out of cadence, treat it as a hotfix: open a new PR from a branch off main with the fix's content.
- **Don't skip the back-merge.** Without it, `next` will conflict with `main` at the next promote, and main can diverge from next in a way that makes the next promote-main fail-loud. The `[main-next-divergence]` alert also stays open until the back-merge lands.
- **Don't push the back-merge directly to `next`.** The queue is the only merger of `next`, and no actor retains direct push, because an untested push to the integration branch is the exact failure class the queue exists to prevent ([DR-2026-08-18-b](../../log/decisions/2026-08-18-merge-queue-on-next.md) D2; [`docs/engineering/handbook.md`](../engineering/handbook.md) §Cadence). If the queue itself is wedged, use Break-glass above rather than a push.
- **Don't bundle a hotfix with a non-incident fix.** Two hotfixes can share a PR only if the incident scope unambiguously covers both.
