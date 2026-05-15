# Two-train release flow (next → main) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move from single-trunk (PR → `main` → `@canary`; Monday cut → `@latest`) to two-train (PR → `next` → `@canary`; Monday cut publishes from `next`, then auto-fast-forwards `main`).

**Architecture:** `next` becomes the integration branch (default branch on GitHub; all PRs target it). `main` becomes a read-only reference for "what is currently published to `@latest`," advanced only by a release-publish event via a new `promote-main.yml` workflow. The canary publish trigger moves from `push: main` → `push: next`. The Monday release-notes scaffold and tag creation run against `next`; on publish, `main` is fast-forwarded to the tagged commit. Hotfixes target `main` directly via a documented sub-flow with mandatory back-merge to `next`.

**Tech Stack:** GitHub Actions workflows (YAML), `gh` CLI, npm OIDC trusted publishing, `actionlint` for workflow validation, bash, the existing `bd` + `bd-mirror` tooling.

**Intent (what we are buying, what we are paying):**

- **Buying:** A soak window where `main` always reflects what operators on `@latest` are running. Easier rollback (revert on `next` does not affect `@latest`). Label semantics that match reality (`release:next` will publish to `@canary` from `next`; the bogus `@next` channel reference goes away).
- **Paying:** Every cut is a branch-promotion step (automated). Hotfixes need an explicit sub-flow with back-merge ceremony. CI matrix unchanged. Default-branch flip is a one-time settings change. Vestigial branches/labels need decommissioning.
- **NOT solving:** The PR review-throughput bottleneck (28 open PRs as of 2026-05-15). That is a review-velocity problem, not a release-flow problem. This plan is orthogonal — execute it **after** the v0.1.6 Monday cut, not as part of it.

---

## File structure

**Workflows (modified):**
- `.github/workflows/npm-publish.yml` — canary `push` trigger `main` → `next`; release-event path unchanged
- `.github/workflows/release-notes-scaffold.yml` — PR-walk search and draft `--target` change `main` → `next`

**Workflows (new):**
- `.github/workflows/promote-main.yml` — fires on `release: published`, fast-forwards `main` to the tagged commit on `next`

**Docs (modified):**
- `docs/engineering/handbook.md` — §Cadence rewrite; §Dist-tags rewrite; §The shipping machine — daily-loop + weekly-retrace updates; new §Hotfix sub-flow; AI workflow rule 8 reworded
- `CLAUDE.md` — engineering-handbook quick-reference cadence summary line
- `docs/runbooks/hotfix.md` (new) — hotfix protocol runbook

**Settings (out-of-band, one-time):**
- GitHub default branch: `main` → `next`
- Branch protection on `next`: PR required, codeowners, required CI checks
- Branch protection on `main`: restrict push to `github-actions[bot]` (only the promote workflow); disallow direct PRs to `main` except `hotfix/*` head pattern (enforced by a small `pr-base-guard.yml` if we want belt-and-braces; v0 leaves it to convention)

**Labels (modified):**
- `release:next` — description rewrite (no longer "publishes @next")
- `release:current` — description rewrite (default for PRs targeting `next`)
- `release:blocked` — unchanged
- `release:none` — unchanged

**Decommission (after cutover):**
- Stale local branches: `pr174-next-fix`, the `codex/*` backup branches (out of scope for this plan; track in a separate `chore` bead)

---

## Task decomposition

Tasks are ordered to ship in two ratifiable PR groups:

- **Group A (PRs 1–3) — "Plumbing":** new workflow + workflow trigger changes + label hygiene. Lands on `main` (still default at this point). Does not flip flow until Group B fires.
- **Group B (PR 4 + settings change) — "Cutover":** docs update + default-branch flip + branch-protection change. After this, all new PRs target `next`.

Each task is the size of a single commit. The plan assumes the engineer has `gh` authenticated with `repo` + `project` scopes and `actionlint` installed (`brew install actionlint`).

---

### Task 1: Create the migration bd

**Files:**
- None — bd CLI only

- [ ] **Step 1: Create the bd issue**

```bash
bd create \
  --title="Adopt two-train release flow (next → main)" \
  --description="$(cat <<'EOF'
Context: Today canary publishes from main on every merge; the Monday cut publishes @latest from a Captain-published release draft. A `next` branch exists but is vestigial (one outlier PR targets it; handbook §Dist-tags says "no next channel"). Labels release:next / release:current exist but no workflow reads them.

Impact: Operators on @latest cannot tell from main whether a given SHA has been promoted to a named cut. Rollback on main affects canary publishes. The two-train model used by React/Babel/npm would make main = "what is currently published to @latest" and next = integration. Plan in docs/superpowers/plans/2026-05-15-two-train-release-flow.md ratifies this migration.

Acceptance criteria (problem-shaped):
- After cutover, every push to next that touches client/** publishes a -canary.<sha> build to @canary within minutes.
- Monday release-notes scaffold creates a draft tagged on next HEAD; on Captain Publish, main is fast-forwarded to that tag and @latest is published as today.
- The handbook's §Cadence, §Dist-tags, AI rule 8, daily-loop step 6, weekly-retrace cut step all describe the two-train flow.
- A documented hotfix sub-flow exists in docs/runbooks/hotfix.md; rule 4 (review parity) explicitly allows the same relaxation it allows for fix(incident).
- Default branch on GitHub is `next`. Branch protection on `next` requires PR + 1 review + required CI checks; main can only be advanced by the promote-main workflow.

## Run-mode
REFACTOR
EOF
)" \
  --type=task --priority=2
```

- [ ] **Step 2: Note the assigned id**

Capture the issued id (e.g. `jinn-mono-XXXX`). Reference it in every subsequent commit message in this plan.

- [ ] **Step 3: Claim it**

```bash
bd update <id> --claim
```

---

### Task 2: Add `promote-main.yml` workflow

**Files:**
- Create: `.github/workflows/promote-main.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/promote-main.yml
#
# Two-train cadence promotion: fast-forwards `main` to the SHA of the just-published
# release tag. After this runs, `main` always reflects what's currently published to npm @latest.
# Hotfix sub-flow bypasses this workflow (hotfix PRs target main directly).
#
# Reference: docs/engineering/handbook.md §Cadence (two-train); jinn-mono-<migration-id>.

name: Promote main on release

on:
  release:
    types: [published]

permissions:
  contents: write

jobs:
  promote:
    name: Fast-forward main to release tag
    runs-on: ubuntu-latest
    # Skip pre-release tags (e.g. -canary.*, -rc.*) — only v<semver> named cuts promote main.
    # The Monday scaffold creates v<semver> tags from `next` HEAD; this job advances main to that SHA.
    if: ${{ !github.event.release.prerelease && startsWith(github.event.release.tag_name, 'v') }}
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
          ref: main
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Resolve release SHA
        id: sha
        env:
          RELEASE_TAG: ${{ github.event.release.tag_name }}
        run: |
          git fetch --tags --depth=1 origin "$RELEASE_TAG"
          SHA="$(git rev-parse "$RELEASE_TAG^{commit}")"
          echo "release_sha=$SHA" >> "$GITHUB_OUTPUT"

      - name: Verify release SHA is reachable from next
        env:
          RELEASE_SHA: ${{ steps.sha.outputs.release_sha }}
        run: |
          git fetch origin next
          if ! git merge-base --is-ancestor "$RELEASE_SHA" origin/next; then
            echo "::error::Release SHA $RELEASE_SHA is not reachable from origin/next. \
                  Refusing to promote main — release tag must be cut from next or main \
                  (hotfix path). Investigate the release event before retrying."
            exit 1
          fi

      - name: Verify fast-forward only
        env:
          RELEASE_SHA: ${{ steps.sha.outputs.release_sha }}
        run: |
          # main must be an ancestor of the release commit; otherwise the promotion would
          # rewrite history. If this fails, a hotfix has landed on main since the release
          # was drafted — Captain must resolve manually.
          if ! git merge-base --is-ancestor HEAD "$RELEASE_SHA"; then
            echo "::error::main is not an ancestor of release SHA $RELEASE_SHA. \
                  Refusing non-fast-forward promotion. Captain: investigate (likely a \
                  hotfix landed on main between draft and publish)."
            exit 1
          fi

      - name: Fast-forward main
        env:
          RELEASE_SHA: ${{ steps.sha.outputs.release_sha }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git merge --ff-only "$RELEASE_SHA"
          git push origin main
          echo "::notice::main advanced to $RELEASE_SHA (release ${{ github.event.release.tag_name }})"
```

- [ ] **Step 2: Validate YAML**

```bash
actionlint .github/workflows/promote-main.yml
```

Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/promote-main.yml
git commit -m "$(cat <<'EOF'
chore(<migration-id>): add promote-main workflow

Fires on release: published; fast-forwards main to the tagged commit on next.
Refuses non-fast-forward and unreachable-from-next SHAs (hotfix-on-main resolution
becomes Captain's manual step). Skips prereleases.

Part of the two-train cadence migration — see docs/superpowers/plans/2026-05-15-two-train-release-flow.md.
EOF
)"
```

---

### Task 3: Move canary trigger from `main` to `next`

**Files:**
- Modify: `.github/workflows/npm-publish.yml` (line 5)

- [ ] **Step 1: Edit the push branch list**

Change line 5 from:

```yaml
    branches: [main]
```

to:

```yaml
    branches: [next]
```

- [ ] **Step 2: Add a clarifying comment block above the trigger**

Insert just above the `on:` block:

```yaml
# Two-train cadence: canary publishes on every push to `next` (the integration branch).
# `main` is advanced only by the promote-main workflow on release: published — it stays
# in lock-step with what's currently in npm @latest. See docs/engineering/handbook.md §Cadence.
```

- [ ] **Step 3: Validate**

```bash
actionlint .github/workflows/npm-publish.yml
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/npm-publish.yml
git commit -m "$(cat <<'EOF'
chore(<migration-id>): move canary trigger to next branch

Two-train cadence: canary publishes on push to `next`; release-event path
(@latest publish) is unchanged. main is advanced by the promote-main workflow.
EOF
)"
```

---

### Task 4: Retarget the Monday release-notes scaffold to `next`

**Files:**
- Modify: `.github/workflows/release-notes-scaffold.yml`

- [ ] **Step 1: Change the PR-walk search base**

Find the line in the `Gather merged PRs + closed-bd references since last tag` step:

```bash
            --search "is:merged base:main merged:>${PREV_DATE}" \
```

Change to:

```bash
            --search "is:merged base:next merged:>${PREV_DATE}" \
```

- [ ] **Step 2: Change the draft release target**

Find the `gh release create` invocation:

```bash
            gh release create "$TAG" \
              --draft \
              --title "v$SUGGESTED — Build Notes (draft)" \
              --notes-file "$BODY_FILE" \
              --target main
```

Change `--target main` to `--target next`. This means the v<semver> tag, when Captain publishes, is created on `next` HEAD — which the `promote-main.yml` workflow then fast-forwards into `main`.

- [ ] **Step 3: Add a clarifying comment near the top of the workflow**

Find the existing header comment block and append a paragraph:

```yaml
# Two-train cadence: this workflow targets `next` (integration branch). Captain's Publish
# action creates a v<semver> tag on next HEAD; the promote-main.yml workflow then
# fast-forwards main to that tag. main remains the "currently published to @latest" reference.
```

- [ ] **Step 4: Validate**

```bash
actionlint .github/workflows/release-notes-scaffold.yml
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release-notes-scaffold.yml
git commit -m "$(cat <<'EOF'
chore(<migration-id>): retarget Monday scaffold to next branch

PR-walk search filters on base:next; draft release target is `next`. Captain's
Publish creates the v<semver> tag on next HEAD; promote-main.yml advances main.
EOF
)"
```

---

### Task 5: Verify CI workflow runs on PRs targeting `next`

**Files:**
- Read-only: `.github/workflows/ci.yml`

- [ ] **Step 1: Inspect ci.yml triggers**

```bash
sed -n '1,25p' .github/workflows/ci.yml
```

If `pull_request:` is present without a `branches:` constraint, no change is needed (PR-CI runs on every PR regardless of base).

If `pull_request: branches: [main]` is set, the next step is required.

- [ ] **Step 2: (Conditional) Add `next` to PR-CI branch list**

Edit `.github/workflows/ci.yml` so the `pull_request:` trigger covers both `next` and `main`:

```yaml
on:
  pull_request:
    branches: [next, main]
  push:
    branches: [next, main]
```

(`push` on `main` keeps the post-promote no-op happy; it's idempotent.)

- [ ] **Step 3: Validate + commit (if changed)**

```bash
actionlint .github/workflows/ci.yml
git diff --quiet .github/workflows/ci.yml && echo "no changes" || {
  git add .github/workflows/ci.yml
  git commit -m "chore(<migration-id>): run CI on PRs to next and main"
}
```

---

### Task 6: Audit the rest of `.github/workflows/` for `main`-only triggers

**Files:**
- Read-only audit across `.github/workflows/`

- [ ] **Step 1: Find every workflow with `branches:` constraint**

```bash
grep -n -A1 'branches:' .github/workflows/*.yml
```

Expected outputs after Task 3 + 4:
- `npm-publish.yml` — push: `next`
- `ci.yml` — pull_request: `next, main` (or unconstrained)
- `docker.yml`, `canonical-docs-check.yml`, `friday-triage.yml`, `changelog-mirror.yml`, `sdk-*.yml` — case-by-case

- [ ] **Step 2: Reason about each `branches: [main]` finding**

For each workflow that still says `branches: [main]`:

- **`docker.yml`** — image publish on main merge. Two-train: this should fire on push to `next` (rolling image tag) OR keep on main for the stable image. Decision rule for this plan: **leave docker.yml on main** until a separate bead reviews image-tag policy. (Aligns with "main = what's published" — operators pulling `:latest` from the registry get what's published to npm @latest.)
- **`canonical-docs-check.yml`** — pull_request validation. Already runs on PRs to main; add `next` to the branch list so it runs on PRs to next.
- **`friday-triage.yml`** — workflow_dispatch + cron. No branch trigger. No change.
- **`changelog-mirror.yml`** — `release: published` triggered. No branch trigger. No change.
- **`sdk-ci.yml`**, **`sdk-npm-publish.yml`** — separate package, separate train. Out of scope; do not touch in this migration.

- [ ] **Step 3: Apply changes for `canonical-docs-check.yml`**

If the workflow has `pull_request: branches: [main]`, change to `pull_request: branches: [next, main]`.

```bash
grep -n 'branches:' .github/workflows/canonical-docs-check.yml
```

Edit accordingly. Validate:

```bash
actionlint .github/workflows/canonical-docs-check.yml
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/canonical-docs-check.yml
git commit -m "chore(<migration-id>): canonical-docs check runs on PRs to next"
```

(Skip the commit if no diff.)

---

### Task 7: Open Group A PR

**Files:**
- None — git/gh operation

- [ ] **Step 1: Push branch**

```bash
git push -u origin chore/<migration-id>-two-train-plumbing
```

- [ ] **Step 2: Open PR against `main`** (still default at this point)

```bash
gh pr create \
  --base main \
  --title "chore(<migration-id>): two-train plumbing (promote-main + canary trigger + scaffold target)" \
  --body "$(cat <<'EOF'
## Summary
- Adds `.github/workflows/promote-main.yml` — fast-forwards main to the tagged commit on next when a release publishes.
- Moves canary trigger in `npm-publish.yml` from push:main → push:next.
- Retargets `release-notes-scaffold.yml` to next (PR-walk filter + draft target).
- Adds `next` to PR-CI branch list where applicable.

This is Group A of the two-train migration. Flow does not flip until Group B (default-branch change + handbook docs + branch protection).

Refs: docs/superpowers/plans/2026-05-15-two-train-release-flow.md, jinn-mono-<migration-id>.

## Test plan
- [ ] actionlint clean on all modified workflows.
- [ ] Dry-run `release-notes-scaffold.yml` via workflow_dispatch — verify draft is created with `--target next` and PRs filtered by `base:next` (expect: empty list initially, since no PR has merged to next yet).
- [ ] Verify promote-main job's `if:` filter rejects prerelease and non-`v*` tags. (Unit-testable via `act` or via examining the conditional inline.)
- [ ] Captain ratifies the cutover sequencing.
EOF
)"
```

- [ ] **Step 3: Get review (rule 4)**

Human or agent review per the engineering handbook AI rule 4. Do not self-merge.

---

### Task 8: Update labels

**Files:**
- None — `gh label edit` operations

- [ ] **Step 1: Update `release:next`**

```bash
gh label edit "release:next" \
  --description "PR is integration-target only; held off the current release window" \
  --color "1D76DB"
```

- [ ] **Step 2: Update `release:current`**

```bash
gh label edit "release:current" \
  --description "Default — PR targets next; auto-publishes @canary on merge; promotes to @latest on the next Monday cut" \
  --color "0E8A16"
```

- [ ] **Step 3: Update `release:blocked`** (description-only refresh)

```bash
gh label edit "release:blocked" \
  --description "Do not merge — release blocker open. Holds the train at the cut boundary." \
  --color "D93F0B"
```

- [ ] **Step 4: Leave `release:none` unchanged**

(Validates the audit.)

---

### Task 9: Sync `next` to `main` (one-time pre-cutover alignment)

**Files:**
- None — git operation

- [ ] **Step 1: Inspect divergence**

```bash
git fetch origin
git log --oneline origin/main..origin/next | head
git log --oneline origin/next..origin/main | head
```

If `main..next` shows commits and `next..main` is empty, `next` is ahead — that's fine (the migration plumbing PR is on `next` already or we merged it to main and forgot to forward).

If both show commits, there's a divergence to resolve before cutover. Resolve by hard-resetting `next` to `main` if `next` has no important history (it should not, given the handbook said "no next channel"):

```bash
# Only if the audit confirms `next` has no in-flight unmerged work
git checkout next
git reset --hard origin/main
git push --force-with-lease origin next
```

**Stop and ask Captain** before force-pushing if any in-flight PR (e.g. `#234` fufn spike) targets `next`. Likely action: merge or close `#234` to `main` first, then sync.

- [ ] **Step 2: Verify post-sync state**

```bash
git log --oneline origin/main..origin/next | head
git log --oneline origin/next..origin/main | head
```

Expected: both empty (next == main).

- [ ] **Step 3: Resolve PR #234**

PR #234 currently targets `next`. After this plan ships, that's the new normal — but during the migration window, retarget it to `main` (or rebase onto the post-sync next) so it doesn't anchor stale history:

```bash
gh pr edit 234 --base main
```

(Or `gh pr edit 234 --base next` if Group A has landed and `next` is the post-sync integration branch.)

---

### Task 10: Update the engineering handbook

**Files:**
- Modify: `docs/engineering/handbook.md` (§Cadence, §Dist-tags, §The shipping machine, AI rule 8)

- [ ] **Step 1: Rewrite §Cadence**

Replace lines 13–22 with:

```markdown
## Cadence

Two-train release model:

- **`next` is the integration branch.** Every PR targets `next`. Every push to `next` that touches `client/**` publishes `<package.version>-canary.<sha8>` to npm under the `canary` dist-tag within minutes (`cargo/.github/workflows/npm-publish.yml`). Operators on `npm install -g @jinn-network/client@canary` receive the rolling build.
- **`main` is the released-train head.** It is advanced only by `cargo/.github/workflows/promote-main.yml`, which fast-forwards main to the v<semver> tag on `release: published`. `main` HEAD therefore always reflects what is currently in npm `@latest`.
- **Weekly named Build Notes cut every Monday.** A Monday cron creates a GitHub Release **draft** at 09:00 UTC against `next` HEAD. Captain reviews (Hermes-style: build-name + highlights + known-issues + auto-aggregated PRs/closed-bd/stats), then publishes. Publish triggers (a) npm `latest`, (b) `promote-main.yml` to fast-forward main, (c) CHANGELOG auto-mirror. Default `npm install -g @jinn-network/client` gets the weekly named stable build.

Tag format on Monday cuts: dual — `v2026.MM.DD` (the human-readable build identifier) and `vX.Y.Z` (the semver for npm). Pre-v1 weekly Build Notes cuts usually patch (`v0.1.3 → v0.1.4`). A Monday cut where an epic or significant capability lands can bump the minor (`v0.1.x → v0.2.0`). **v1.0.0 is reserved for far-future graduation** (mainnet / exit-testnet / Phase 2), explicitly not `jinn-mono-uy6v`.

**Bump heuristic** (cron's suggestion, Captain overrides): the Monday cron always suggests a patch bump. Captain manually overrides to the next minor when an epic or significant capability closes in the window. Conventional Commits drives section grouping in Release notes (Features / Fixes / Refactors / Chore / Docs / Tests), **not** per-merge semver bumps. Canary handles per-merge implicit patching.

**Hotfix sub-flow** — see [`docs/runbooks/hotfix.md`](../runbooks/hotfix.md). Critical fixes to `@latest` may target `main` directly; the hotfix PR is published as an out-of-cadence release; a back-merge `main → next` chore PR is mandatory before closing the incident.
```

- [ ] **Step 2: Rewrite §Dist-tags**

Replace lines 24–29 with:

```markdown
## Dist-tags

- `canary` — rolling, every-push-to-next build (`<v>-canary.<sha>`). Sourced from `next` (integration).
- `latest` — Monday named stable build, sourced from a v<semver> tag on `next` HEAD that `promote-main.yml` then fast-forwards into `main`.

There is no `@next` dist-tag. The branch named `next` exists; the dist-tag does not. Operators who want the rolling build use `@canary`; operators who want stable get `latest` by default.
```

- [ ] **Step 3: Update §The shipping machine — daily-loop step 6**

Find:

```markdown
6. **Merge → auto-canary.** `npm-publish.yml` fires on merge to main, publishes `<v>-canary.<sha>` under `canary`.
```

Replace with:

```markdown
6. **Merge to `next` → auto-canary.** `npm-publish.yml` fires on push to `next`, publishes `<v>-canary.<sha>` under `canary`. `main` advances only on the Monday cut's release publish (or via the hotfix sub-flow).
```

- [ ] **Step 4: Update §The shipping machine — weekly retrace cut step**

Find the "Monday morning — cut" paragraph; update the bullet list to include the promote step:

```markdown
- `npm-publish.yml` (release event branch) → npm `latest`.
- `cargo/.github/workflows/promote-main.yml` → fast-forwards `main` to the tagged commit on `next`. After this runs, `git log main` shows exactly the named-cut commit.
- `cargo/.github/workflows/changelog-mirror.yml` → appends Release body to `cargo/client/CHANGELOG.md` under Unreleased.
```

- [ ] **Step 5: Update AI rule 8**

Find:

```markdown
8. **Auto-canary on main merge; Monday-only named stable cut.** Cadence policy from §Cadence above.
```

Replace with:

```markdown
8. **Auto-canary on every push to `next`; Monday-only named stable cut promotes `main`.** Cadence policy from §Cadence above. Hotfix sub-flow may bypass `next`; back-merge is mandatory.
```

- [ ] **Step 6: Commit**

```bash
git add docs/engineering/handbook.md
git commit -m "docs(<migration-id>): handbook §Cadence + §Dist-tags + rule 8 to two-train"
```

---

### Task 11: Write the hotfix runbook

**Files:**
- Create: `docs/runbooks/hotfix.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Hotfix sub-flow

A hotfix targets `main` directly when a critical bug in `@latest` cannot wait for the next Monday cut. The sub-flow is intentionally rare; most fixes go through `next` and ship at the regular Monday cadence.

## When this applies

- Critical operator-facing bug in the current `@latest` build (e.g. broken bootstrap, broken claim flow, security disclosure).
- Captain has decided the regression cannot wait for Monday.
- The `fix(incident)` shape from `docs/engineering/handbook.md` §The shapes of work applies.

If any of the above is in doubt: ship through `next` at the normal cadence.

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
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/hotfix.md
git commit -m "docs(<migration-id>): hotfix sub-flow runbook"
```

---

### Task 12: Update `CLAUDE.md` quick-reference

**Files:**
- Modify: `cargo/CLAUDE.md` (§Engineering handbook quick reference)

- [ ] **Step 1: Find the cadence-summary line**

Search for the line in `cargo/CLAUDE.md` §Engineering handbook that reads:

```markdown
- Every merge to main → npm `canary` (`<v>-canary.<sha>`).
```

- [ ] **Step 2: Replace with two-train summary**

```markdown
- Every push to `next` → npm `canary` (`<v>-canary.<sha>`).
- Monday named cut → v<semver> tag on `next` HEAD → npm `latest` → `promote-main.yml` fast-forwards `main`.
- Hotfix → PR to `main` directly; mandatory back-merge to `next`. See `docs/runbooks/hotfix.md`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(<migration-id>): CLAUDE.md cadence quick-ref to two-train"
```

---

### Task 13: Open Group B PR

**Files:**
- None — git/gh operation

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin docs/<migration-id>-two-train-cutover
gh pr create \
  --base main \
  --title "docs(<migration-id>): two-train cutover (handbook + CLAUDE + hotfix runbook + labels)" \
  --body "$(cat <<'EOF'
## Summary
- Handbook §Cadence, §Dist-tags, §The shipping machine, AI rule 8 rewritten for two-train.
- CLAUDE.md quick-reference cadence line updated.
- New `docs/runbooks/hotfix.md` documents the hotfix sub-flow with mandatory back-merge.
- Label descriptions for `release:current` / `release:next` / `release:blocked` updated.

This is Group B of the two-train migration. After this PR + the default-branch flip, all new PRs target `next`.

Refs: docs/superpowers/plans/2026-05-15-two-train-release-flow.md, jinn-mono-<migration-id>.

## Test plan
- [ ] Canonical-docs check passes.
- [ ] Captain ratifies handbook prose.
- [ ] After merge, perform the settings flip (Task 14) and the validation cut (Task 15).
EOF
)"
```

- [ ] **Step 2: Get review (rule 4)**

Canonical-doc changes also need Discussion + CODEOWNERS approval per the `docs` shape SOP. Open a Discussion on Jinn-Network/mono referencing this PR if the handbook + CLAUDE.md changes haven't been pre-discussed.

---

### Task 14: Flip default branch + branch protection

**Files:**
- None — GitHub settings (UI or `gh api`)

**Sequencing:** Do this **only after Groups A + B have merged to `main`** so the workflows + docs are in place before flow flips.

- [ ] **Step 1: Sync `next` to merged `main` one more time**

```bash
git fetch origin
git checkout next
git pull --ff-only origin next
git merge --ff-only origin/main
git push origin next
```

Verify `git log origin/main..origin/next` and `git log origin/next..origin/main` are both empty.

- [ ] **Step 2: Change default branch**

```bash
gh api -X PATCH repos/Jinn-Network/mono \
  -f default_branch=next \
  -f name=mono
```

Confirm:

```bash
gh api repos/Jinn-Network/mono --jq '.default_branch'
```

Expected: `next`.

- [ ] **Step 3: Apply branch protection to `next`**

Mirror the protection main currently has, plus codeowner-review-required:

```bash
gh api -X PUT repos/Jinn-Network/mono/branches/next/protection \
  --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": false,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

(Add specific `contexts` to `required_status_checks` once a `ci.yml` job's check-name is stable. v0: leave null.)

- [ ] **Step 4: Tighten `main` protection**

`main` should only accept the `promote-main.yml` fast-forward and the hotfix sub-flow. The simplest enforcement: keep PR review required, require linear history, and restrict push to the `github-actions[bot]` user:

```bash
gh api -X PUT repos/Jinn-Network/mono/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": false,
    "require_last_push_approval": false
  },
  "restrictions": {
    "users": [],
    "teams": [],
    "apps": ["github-actions"]
  },
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

The `apps: ["github-actions"]` restriction lets `promote-main.yml`'s push succeed. Hotfix PRs from humans must merge via PR (the review-required gate still applies). Note: `restrictions` requires the repo to be in an org with private/team features; if `gh api` returns 422 here, fall back to "PR-required-from-humans + convention" and document the gap.

- [ ] **Step 5: Verify settings**

```bash
gh api repos/Jinn-Network/mono/branches/main/protection --jq '.restrictions, .required_linear_history'
gh api repos/Jinn-Network/mono/branches/next/protection --jq '.required_pull_request_reviews'
```

---

### Task 15: Validation cut

**Files:**
- None — workflow_dispatch + observation

- [ ] **Step 1: Land a tiny no-op PR on `next` to validate canary**

Open a docs-only PR (touching `client/**` so the workflow fires — e.g. a comment in `client/README.md`):

```bash
git checkout -b chore/<migration-id>-canary-validation
echo "" >> client/README.md  # or a real one-line clarification
git add client/README.md
git commit -m "chore(<migration-id>): validate canary publish from next"
git push -u origin chore/<migration-id>-canary-validation
gh pr create --base next --title "chore(<migration-id>): canary validation" --body "no-op PR to validate canary publishes from next"
```

Merge after review.

- [ ] **Step 2: Verify @canary published**

```bash
sleep 180  # give the workflow time
npm view @jinn-network/client@canary version
```

Expected: a `-canary.<sha>` version where `<sha>` matches the merge commit short SHA.

- [ ] **Step 3: Dry-run the Monday scaffold against `next`**

```bash
gh workflow run release-notes-scaffold.yml
```

Wait for the run; inspect the draft release. Expected:
- Tag suggestion based on previous v<semver> tag.
- Draft `--target next`.
- PR list includes PRs merged with `base:next` since the previous tag.

- [ ] **Step 4: Verify `promote-main.yml` would fire correctly**

Inspect the promote-main job's `if:` condition against a hypothetical release event payload. (Use a workflow_dispatch debug-only path if needed — alternatively, wait for the next real Monday cut to validate end-to-end.)

- [ ] **Step 5: Close the migration bd**

```bash
bd close <migration-id>
```

---

### Task 16: Post-migration follow-ups (file as separate beads)

**Files:**
- None — bd CLI

- [ ] **Step 1: File label-cleanup bead**

```bash
bd create --title="Sunset release:next label once next-train cadence is bedded in" \
  --description="After two-train cadence runs for 3+ Monday cuts without surprises, audit whether release:next is still useful. It currently means 'hold off the current train' — that's a valid signal but rare. Consider replacing with a 'draft-label' on the PR itself if the audit shows the label is barely used." \
  --type=task --priority=4
```

- [ ] **Step 2: File stale-branches-cleanup bead**

```bash
bd create --title="Prune stale codex/* and pr174-next-fix local-only branches" \
  --description="Out-of-scope cleanup from the two-train migration. The codex/* family on origin should be audited for orphans; local branches pr174-next-fix, integrate/pr-65-main can be deleted." \
  --type=chore --priority=4
```

- [ ] **Step 3: File docker-tag-policy review bead**

```bash
bd create --title="Review docker.yml image-tag policy under two-train cadence" \
  --description="Two-train migration left docker.yml on push:main (i.e. stable image tracks @latest). Review whether the docker image should also have a :canary tag fired on push:next, mirroring npm. Decide explicitly, document, and either change the workflow or note the policy in the handbook." \
  --type=task --priority=3
```

---

## Self-review checklist (post-write)

**Spec coverage:**
- §Intent: ✅ articulated buying/paying.
- §Workflow changes: ✅ canary trigger + scaffold target + new promote workflow.
- §Branch settings: ✅ default-branch flip + protection on both branches.
- §Docs: ✅ handbook + CLAUDE.md + hotfix runbook.
- §Labels: ✅ description updates for release:current + release:next.
- §Validation: ✅ canary-validation no-op PR + dry-run scaffold.
- §Hotfix path: ✅ documented with back-merge mandate.
- §Decommission follow-ups: ✅ filed as separate beads.

**Placeholder scan:** No `<placeholder>` strings remain except `<migration-id>` which is intentionally to-be-filled from Task 1's bd id. No "TBD" / "implement later" / "fill in details."

**Type/name consistency:**
- Workflow names consistent: `promote-main.yml`, `npm-publish.yml`, `release-notes-scaffold.yml`.
- Branch names consistent: `next` (integration), `main` (released-train head).
- Label names: `release:current` / `release:next` / `release:blocked` / `release:none` — unchanged identifiers, descriptions updated only.

**Risks called out:**
- Group A lands while flow is still single-trunk — workflow changes activate immediately but trigger on `next` (which is currently quiet), so no surprise canary publishes. Captain may want to merge Group A on a Friday so Sat/Sun is the soak window before the Monday cut tests the new path.
- `restrictions: apps: ["github-actions"]` on main may 422 on non-org repos; documented fallback.
- Hotfix back-merge is human-discipline; no automation enforces it. If we see drift, a small workflow can be added that opens an auto-PR `chore: back-merge main into next` whenever main advances. Defer to follow-up bead if friction observed.

---

## Execution sequencing summary

```
Day 0  Task 1: file migration bd
Day 0  Tasks 2–6: Group A plumbing PR (workflows + label hygiene)
Day 1  Task 7: review + merge Group A
Day 1  Task 9: sync next ↔ main
Day 2  Tasks 10–12: Group B docs PR
Day 3  Task 13: review + merge Group B
Day 3  Task 14: flip default branch + branch protection
Day 4  Task 15: validation cut (canary no-op + dry-run scaffold)
Day 7  First real Monday cut on new flow (validates promote-main.yml end-to-end)
Day 7+ Task 16: file follow-up beads if friction observed
```

**Do not start this plan before the v0.1.6 Monday cut on 2026-05-18.** Mixing a workflow migration with the cut is asking for confusion. Earliest sane start: 2026-05-19 (Tuesday). Earliest sane validation cut: 2026-05-25 (the following Monday).
