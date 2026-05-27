# Engineering handbook (v1)

This handbook describes how the Jinn engineering team ships. It is the canonical reference for the SOPs, AI workflow rules, and cadence that every contributor (human or AI agent) is expected to follow.

The handbook is **Jinn-flavored**, not generic. Per [`BRAND.md`](../../BRAND.md) the engineering substrate is itself a brand surface — the public sprint board, GitHub Releases, CHANGELOG, DRs, and specs are the visible artifacts that make the headless-brand posture legible. The shipping machine is not separate from the work; it is the work made public.

Canonical references:
- Design that ratified this handbook: [`docs/superpowers/specs/2026-05-11-engineering-handbook-codesign.md`](../superpowers/specs/2026-05-11-engineering-handbook-codesign.md)
- DR-2026-05-18 — Issue tracking substrate (retire `bd`, single-track on GitHub): [`log/decisions/2026-05-18-bd-vs-gh-substrate.md`](../../log/decisions/2026-05-18-bd-vs-gh-substrate.md)
- DR-2026-05-11-b — Engineering substrate (superseded for the internal-SoR claim by DR-2026-05-18; sprint-surface claim survives): [`log/decisions/2026-05-11-engineering-substrate.md`](../../log/decisions/2026-05-11-engineering-substrate.md)
- DR-2026-05-11-a — Prediction freeze: [`log/decisions/2026-05-11-freeze-prediction-solvernet.md`](../../log/decisions/2026-05-11-freeze-prediction-solvernet.md)

**Note on `bd` retirement (2026-05-18):** Per DR-2026-05-18, `bd` is retired as the issue-tracking substrate. GitHub Issues + native sub-issues + the "Jinn engineering" Project (v2) are the single source of truth for engineering work going forward. The Dolt remote that backed `bd` is frozen as a read-only archive (`bd-archive-2026-05-18`, see `scripts/freeze-beads.sh`); the `bd` CLI on operator machines continues to resolve historical `jinn-mono-<id>` references via `bd show <id>` after a one-time `bd dolt pull`. The local `.beads/` directory is gitignored — historical-lookup state is per-operator, sourced from the Dolt remote. Sections below reflect the new substrate; the prior `bd ↔ GitHub Issue mirror` from DR-2026-05-11-b is retired.

## Cadence

Two-train release model:

- **`next` is the integration branch.** Every PR targets `next`. Every push to `next` that touches `client/**` publishes `<package.version>-canary.<sha8>` to npm under the `canary` dist-tag within minutes (`cargo/.github/workflows/npm-publish.yml`). Operators on `npm install -g @jinn-network/client@canary` receive the rolling build.
- **`main` is the released-train head.** It is advanced only by `cargo/.github/workflows/promote-main.yml`, which fast-forwards main to the v<semver> tag on `release: published`. `main` HEAD therefore always reflects what is currently in npm `@latest`.
- **Weekly named Build Notes cut every Monday.** A Monday cron creates a GitHub Release **draft** at 09:00 UTC against `next` HEAD. Captain reviews (Hermes-style: build-name + highlights + known-issues + auto-aggregated PRs and closed Issues), then publishes. Publish triggers (a) npm `latest`, (b) `promote-main.yml` to fast-forward main, (c) CHANGELOG auto-mirror. Default `npm install -g @jinn-network/client` gets the weekly named stable build.

**PR base policy.** PRs target `next`, not `main`. The single exception is the hotfix sub-flow, which targets `main` directly and carries a mandatory back-merge to `next` — see [`docs/runbooks/hotfix.md`](../runbooks/hotfix.md). Branch protection on `main` enforces this mechanically (issue #589); the rule is canon here so the why-anchor lives with the cadence it serves.

**Holistic release-review gate.** The same Monday scaffold also opens-or-updates a single standing **release-review PR** (`base: main`, `head: next`) — `cargo/.github/workflows/release-notes-scaffold.yml`, issue #307, [DR-2026-05-20](../../log/decisions/2026-05-20-holistic-release-review-gate.md). Its diff is the entire release window (`main...next`) in one reviewable view: the diff that per-PR review and the release-notes title list both miss. Cross-PR interactions — a later PR silently shadowing an earlier one — are only visible here (the v0.1.6 cut shipped #301 shadowed by hardcoded values in `main.ts`, invisible per-PR and absent from the title list, caught only afterward by #303). Before publishing the Monday release, Captain reviews this whole-window diff, not just the merged-PR titles. This is a **soft convention**: nothing mechanically blocks `npm-publish.yml` — the gate is the diff existing and being looked at. GitHub keeps exactly one open PR per base/head pair and auto-refreshes its diff as `next` advances; `promote-main.yml`'s fast-forward of `main` auto-closes the PR as merged, and the next Monday scaffold opens a fresh one. If a Monday draft is never published, the standing PR stays open and the next scaffold adopts and relabels it to the new window. **Hotfixes do not open a release-review PR** — they bypass the scaffold workflow; their diff review is the hotfix PR-to-`main` itself (see [`docs/runbooks/hotfix.md`](../runbooks/hotfix.md)).

Tag format on Monday cuts: dual — `v2026.MM.DD` (the human-readable build identifier) and `vX.Y.Z` (the semver for npm). Pre-v1 weekly Build Notes cuts usually patch (`v0.1.3 → v0.1.4`). A Monday cut where an epic or significant capability lands can bump the minor (`v0.1.x → v0.2.0`). **v1.0.0 is reserved for far-future graduation** (mainnet / exit-testnet / Phase 2), explicitly not `jinn-mono-uy6v`.

**Bump heuristic** (cron's suggestion, Captain overrides): the Monday cron always suggests a patch bump. Captain manually overrides to the next minor when an epic or significant capability closes in the window. Conventional Commits drives section grouping in Release notes (Features / Fixes / Refactors / Chore / Docs / Tests), **not** per-merge semver bumps. Canary handles per-merge implicit patching.

**Hotfix sub-flow** — see [`docs/runbooks/hotfix.md`](../runbooks/hotfix.md). Critical fixes to `@latest` may target `main` directly; the hotfix PR is published as an out-of-cadence release; a back-merge `main → next` chore PR is mandatory before closing the incident. PRs against `main` are gated by the `Main base guard` required check (`.github/workflows/main-base-guard.yml`): only PRs whose title begins with `fix(incident)` or whose head branch matches `hotfix/*`, plus the standing release-review PR (head: `next`), pass the gate. The hotfix runbook produces both signals; supplying either alone is sufficient for the guard, but the runbook prescribes both for clarity. Admin enablement: `.github/scripts/enable-main-base-guard.sh`. Until that script is run by a repo admin, the check runs advisorily — it surfaces a red X on offending PRs but does not block merge.

**main-next ancestor backstop** — `.github/workflows/main-next-ancestor-check.yml` (issue #590) runs daily at 08:00 UTC and on every push to `main` or `next`, asserting `git merge-base --is-ancestor origin/main origin/next`. On failure the workflow opens-or-updates a single alert issue titled `[main-next-divergence] …` with label `automated:divergence` linking to the back-merge step in [`docs/runbooks/hotfix.md`](../runbooks/hotfix.md); the issue auto-closes when the invariant is restored, so the alert is self-healing. `eng-day` surfaces open `automated:divergence` issues.

## Dist-tags

- `canary` — rolling, every-push-to-next build (`<v>-canary.<sha>`). Sourced from `next` (integration).
- `latest` — Monday named stable build, sourced from a v<semver> tag on `next` HEAD that `promote-main.yml` then fast-forwards into `main`.

There is no `@next` dist-tag. The branch named `next` exists; the dist-tag does not. Operators who want the rolling build use `@canary`; operators who want stable get `latest` by default.

## The shipping machine — process

### Daily loop

At the repo root:

```
claude
```

then:

1. **Orient.** Invoke `eng-day` skill (or fallback: `gh issue list --search 'is:open' --json number,title,labels,assignees` + `gh pr list --search 'is:open draft:false'`). Brief reports sprint progress, yesterday's shipped, today's top-3 guidance, drift flags.
2. **Pick one piece of work** — a GitHub Issue, a stale PR, or a design conversation. Run `gh issue view <N>` to read the work.
3. **Execute according to shape** — the Issue body's `## Run-mode` section declares the shape; the shape determines the skill chain, test discipline, design ceremony, and stacking policy (see §The shapes of work below).
4. **Open PR(s).** PR title format: `<shape>(<optional scope>): <one-line summary>` (Conventional Commits). The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) prompts for problem-not-solution body, test plan, agent identity, Co-Authored-By trailer.
5. **Review.** Human eyes on every PR (rule 4). No agent self-merge. Exception: `fix(incident)` allows reviewer relaxation with documented justification.
6. **Merge to `next` → auto-canary.** `npm-publish.yml` fires on push to `next`, publishes `<v>-canary.<sha>` under `canary`. `main` advances only on the Monday cut's release publish (or via the hotfix sub-flow).
7. **Close the Issue.** PR body's `Closes #<N>` auto-closes the Issue on merge; otherwise `gh issue close <N>`.

### Weekly retrace

**Friday afternoon — triage.** Captain walks the open GitHub Issue queue, picks candidates for the upcoming Monday sprint, and adds them to the "Jinn engineering" Project (v2) board with the upcoming-Monday Iteration value on the `Sprint` field. The pre-DR-2026-05-18 Friday triage cron + `scripts/bd-mirror` helper are retired. If a labeling pass surfaces value (e.g. flagging top-priority unsprinted Issues), the cron may be reintroduced as a label-only pass over open Issues — file a follow-up Issue if so. Default flow stays *select, not auto-promote*.

**Monday morning — cut.** The Monday cron (`cargo/.github/workflows/release-notes-scaffold.yml`, currently `workflow_dispatch` only) creates a GitHub Release **draft** at 09:00 UTC and opens-or-updates the standing release-review PR (`base: main`, `head: next` — see §Cadence). Captain reviews the release-review PR's whole-window diff, edits build-name + highlights + known-issues on the draft, then clicks Publish. Publish triggers:

- `npm-publish.yml` (release event branch) → npm `latest`.
- `cargo/.github/workflows/promote-main.yml` → fast-forwards `main` to the tagged commit on `next`. After this runs, `git log main` shows exactly the named-cut commit.
- `cargo/.github/workflows/changelog-mirror.yml` → appends Release body to `cargo/client/CHANGELOG.md` under Unreleased.

The Project board's Sprint view resets to the new Monday; shipped items move to the Roadmap view's Done column.

## The shapes of work

The handbook recognises seven shapes plus one emergency sub-flow, plus one meta-shape (`INTERACTIVE DESIGN`) used when the Issue's job is to *produce a design doc* (spec or DR) rather than ship implementation. Each shape declares a **disposition** — when it applies, what discipline its container demands, what ceremony fits. The shape is declared in the GitHub Issue body's `## Run-mode` section and replicated in the PR title prefix (Conventional Commits). If an Issue does not fit one of these shapes, it is mis-scoped — split it or reshape it.

The taxonomy is keyed to Conventional Commits prefixes so it composes with existing tooling: PR title → Release section grouping → CHANGELOG entry.

**The per-shape skill chains below are v0 defaults, not canon.** Treat them as starting heuristics derived from current practice. See §Iterative refinement at the end of this section for how flows evolve as we use them.

| Shape | Trigger | v0 skill chain | Test discipline | Design upfront | Stacking | Observed pitfall (2026-05-11) |
|---|---|---|---|---|---|---|
| **`fix`** — Bug fix | Failing test, user report, canary alert | `systematic-debugging` → `executing-plans` → `verification-before-completion` → `receiving-code-review` | Regression test **first** (rule 7) | Skipped — escalate to `refactor` if bug reveals architectural problem | Skipped — single PR | Proposing a fix before reproducing |
| **`feat`** — Feature | Issue with acceptance criteria; user request; spec need | (`brainstorming` if scope ambiguous) → `writing-plans` → `test-driven-development` → `executing-plans` or `dispatching-parallel-agents` → `verification-before-completion` → `receiving-code-review` | TDD (rule 7) | Required if scope ambiguous; optional if acceptance concrete | Allowed/encouraged for multi-task | Skipping TDD and discovering at PR time the design doesn't support testing |
| **`refactor`** — Architecture / migration | Scaling problem, velocity drag, migration to a new pattern | `brainstorming` (**required**) → `writing-plans` → `test-driven-development` → `subagent-driven-development` → `executing-plans` → `verification-before-completion` → `receiving-code-review` | TDD + integration tests on migration / contract surfaces (rules 6 + 7) | **Required** — DR for big, spec for medium | **Required** — strangler-fig preferred; each layer ships independently | Big-bang refactor as one giant PR — reviewers reject |
| **`spike`** — Research / exploration | Open "can we?" question; tech evaluation | `brainstorming` → exploratory work in a worktree → write finding as spec or DR | Skipped — output is a finding | The output IS the design | Skipped — spike code does not merge | Letting spike code drift back into a feature PR; not writing the finding |
| **`chore`** — Deps, CI, dev tooling | Dependabot, CI tweak, dev-pain | `executing-plans` → `verification-before-completion` → `receiving-code-review` | Integration tests required if touches a dep (rule 6) | Skipped | Skipped | Batching dep upgrade with feature work |
| **`docs`** — Documentation | Doc gap; canonical-doc amendment; runbook update | `executing-plans` → `receiving-code-review` | Skipped | Required if canonical (SPEC/BRAND/THESIS/GROWTH/GLOSSARY/CLAUDE/README per `cargo/spec/2026-04-28-canonical-docs.md`) — needs Discussion + CODEOWNERS approval | Skipped | Touching canonical docs without the Discussion ceremony |
| **`test`** — Test-only | Coverage gap, flake fix, test refactor | `executing-plans` → `verification-before-completion` | Meta — the test IS the discipline | Skipped | Skipped | Adding tests that pass without exercising the surface |

**Emergency sub-flow of `fix`:**

`fix(incident)` — used when canary is broken, production is incident-mode, or a security disclosure lands. SOP: acknowledge in the incident thread; diagnose (revert is the default); ship the smallest possible patch with **relaxed review** (one reviewer, justification noted in PR body); the post-hoc regression test and proper-fix are **required follow-up Issues** filed before the incident is closed. Rule 4 (review parity) explicitly allows relaxation here; rule 7 (regression test) defers but does not waive.

**`Run-mode` values** used in Issue bodies: `BUG-FIX` / `FEATURE` / `REFACTOR` / `SPIKE` / `CHORE` / `DOCS` / `TEST` / `INCIDENT` / `INTERACTIVE DESIGN`. The `INTERACTIVE DESIGN` value is the meta-shape used when the Issue's job is to *produce a design doc* — its skill chain is `brainstorming` → spec → DR(s) → Issue restructure, with no implementation in the same session.

**Every work-unit Issue declares a `Run-mode`.** Add a `## Run-mode` section to the Issue body at create-time. Epics (containers) are exempt; only work-unit Issues need it. The `eng-day` daily-brief skill reads `Run-mode` to apply the right skill chain when surfacing a task. If you create an Issue without `Run-mode`, a reviewer will infer one from the title and labels — `gh issue edit <N> --body-file -` adds the section retroactively, but declaring it up front is cheaper. Captain may amend a previously-declared `Run-mode` if the shape changes (e.g. a `feat` that reveals a deeper architectural problem becomes a `refactor`).

### Iterative refinement of shape flows

The shape taxonomy above is the stable surface. The per-shape skill chains are v0 defaults — they will be wrong in places we haven't shipped enough work to know yet.

Friction observed in a shape's flow → file a GitHub Issue under the engineering handbook umbrella → refinement, via one of three paths:

1. **Author a new shape-specific skill.** If friction recurs and no existing skill covers it. New skill lands in `.claude/skills/` (symlinked to `.cursor/skills/` and `.codex/skills/` via `./scripts/sync-skills.sh`); the shape's v0 skill chain in this handbook updates to invoke it.
2. **Amend an existing skill.** If friction is in how an existing skill (e.g., `superpowers:systematic-debugging`) fits the shape's context. The amendment is itself a `docs` change in the relevant skill's repo.
3. **Revise the handbook.** If the friction is taxonomic (e.g., `chore` should split into `chore(deps)` vs `chore(ci)`). `docs`-shape change against this file.

For v0 the refinement mechanism is intentionally lightweight: file an Issue under the engineering handbook umbrella tagged with the shape it concerns, body describing the friction and the proposed refinement. No structured retro skill, no per-PR friction form, no end-of-sprint shape ceremony — until usage demonstrates a more disciplined mechanism would pay off.

## AI workflow rules

The ten rules below land in this handbook + [`CLAUDE.md`](../../CLAUDE.md) immediately. Rule 5 is a placeholder pending the self-modifying learner design.

1. **Worktree-for-multi-agent.** Multi-agent or speculative subagent work uses a separate git worktree (current convention: `git worktree add ../jinn-mono_worktrees/<name>`), not the primary checkout.
2. **Issues frame problems, not solutions.** GitHub Issue bodies = context + impact + needs-design-session or testable acceptance criteria. Solutions live in design sessions (`INTERACTIVE DESIGN` shape) or implementation plans, not in the Issue body.
3. **GitHub Issues are the single SoR for engineering work.** Per DR-2026-05-18, `bd` retires; all new engineering work originates as a GitHub Issue on `Jinn-Network/mono`. Parent/child use native sub-issues; `Sprint`/`Epic`/`Status` live on the "Jinn engineering" Project (v2). The Dolt remote that backed `bd` is frozen as `bd-archive-2026-05-18` (per `scripts/freeze-beads.sh`); the `bd` CLI continues to resolve historical `jinn-mono-<id>` references via `bd show <id>` against the operator's local `.beads/` (gitignored, sourced from the frozen Dolt remote).
4. **Agent PR review parity.** Codex / Opus / Sonnet / Claude PRs go through the same review gate as human PRs. No agent self-merge. Exception: `fix(incident)` allows reviewer relaxation with documented justification.
5. **(Deferred — open)** Supervised-diff for the self-modifying learner. Phase A.5+ learner ships proposed changes as PRs against the repo; designated reviewer approves before merge. Concrete mechanism is open. **Status: open.**
6. **Integration tests > mocks for migration / contract surfaces.** Mock policy stays for the unit-test pyramid; migration tests must hit a real database or a forked chain (per `superpowers:test-driven-development`'s position on the test pyramid).
7. **TDD for new features, regression test for fixes.** Per `superpowers:test-driven-development`. TDD on `feat` / `refactor`; regression-first on `fix`; deferred-not-waived on `fix(incident)`.
   - **Boundary tests for numeric gates.** When a `fix` (or any change) touches a numeric threshold — funding gate, balance check, runway warning, drip target — the regression test must mock at the boundary (`gate`, `gate - 1 wei`), not at "comfortably above" (0.05 ETH, 0.1 ETH). The 2026-05-18 canary regression (jinn-mono-u34i: Stage 1 gate == transfer amount) shipped through CI because every existing mock was at 0.05 ETH — way above the 0.01 ETH gate, so the "gate exactly equals transfer" failure mode was invisible. Boundary mocks are cheap, catch this class of bug deterministically, and double as documentation of what the gate actually enforces. See `client/test/earning/staged-bootstrap-stage1.test.ts` and `staged-bootstrap-stage1and2.test.ts` for the pattern.
8. **Auto-canary on every push to `next`; Monday-only named stable cut promotes `main`.** Cadence policy from §Cadence above. Hotfix sub-flow may bypass `next`; back-merge is mandatory.
9. **`canary` for rolling patches, `latest` for Monday named.** Dist-tag policy from §Dist-tags above.
10. **PRs target `next`, not `main`.** The only exception is `fix(incident)` hotfixes (target `main` directly, mandatory back-merge per §Hotfix sub-flow / `docs/runbooks/hotfix.md`). Branch protection on `main` enforces this (issue #589). See §Cadence above for the why-anchor.

Rule-to-shape wiring is in §The shapes of work; the mapping is the load-bearing piece. Rules in the abstract are guidance; rules wired to shapes are operational.

## Sprint surface — GitHub Project (v2)

The canonical sprint board is a GitHub Project (v2) on `Jinn-Network/mono` named **Jinn engineering** (established by DR-2026-05-11-b; its sprint-surface claim survives DR-2026-05-18's retirement of `bd`).

- **Status columns**: Todo / In Progress / In Review / Done.
- **Sprint field** (Iteration): keyed to the current Monday week.
- **Epic field** (single select): human option names such as `Engineering handbook`, `Discovery API`, and `v1 public testnet`. (Option descriptions no longer carry the legacy `jinn-mono-<id>` mapping, which served the retired mirror.)
- **Parent/child**: native GitHub sub-issues (`addSubIssue` mutation / native UI). Epics are Issues with sub-issues attached.
- **Default view**: current sprint Status board.
- **Roadmap view**: grouped by Epic in Now / Next / Later.

**Workflow**: All new engineering work originates as a GitHub Issue. To put work into a sprint, add the Issue to the "Jinn engineering" Project board and set the `Sprint` Iteration to the upcoming Monday. PR merges that include `Closes #<N>` auto-close the Issue; Project automation moves it to Done.

Backlog Issues live un-sprinted on the Project board (or off-board entirely until Captain reviews). Captain's Friday triage walks the open queue and pulls candidates onto the upcoming-Monday Iteration — see §Weekly retrace above. The pre-DR-2026-05-18 `bd-mirror` helper and Friday triage cron are retired.

## Building in public — substrate

Per the engineering handbook umbrella and DR-2026-05-18 (retire `bd`, single-track on GitHub):

- **GitHub Projects (v2)** — public sprint board (this handbook §Sprint surface above).
- **Public GitHub Issues** — the single source of truth for engineering work. Externally visible at create-time; the public surface and the working surface are the same surface (per DR-2026-05-18).
- **GitHub Releases + auto-generated notes** — the devlog. Monday cuts. Released artifacts: `v2026.MM.DD` + `vX.Y.Z` dual tags.
- **CHANGELOG.md** — `client/CHANGELOG.md` auto-mirrored from Release body on publish via `.github/workflows/changelog-mirror.yml`. npm-tarball-shipped.
- **Repo-as-docs** — `docs/` (engineering, runbooks, specs, decisions). GitHub Pages-ready.
- **GitHub Discussions** — RFCs / Q&A / governance prep through Phase 2.

What we do **not** do (yet): GitHub Wiki (drifts), Discourse forum (premature — Discussions cover it), Discord/Telegram as engineering substrate (community engagement, not engineering).

## Stacked PRs

For features > 300 LOC the handbook expects stacked PRs. Each layer < 200 LOC, "one logical thing per layer that makes sense on its own" (Joe Buza, 2026). Reviewer reads bottom-up; merge in order; the stack auto-rebases.

Tooling: `gh-stack` (GitHub-native CLI extension, April 2026) is the canonical reference. Graphite (`gt`) is allowed but not required. No CI enforcement — reviewers socially enforce by asking for stack-splits on PRs > 300 LOC without a clear single logical-thing.

## Doc ladder

- `cargo/spec/` — stable proposal-style ADRs.
- `cargo/docs/superpowers/specs/` — in-progress design specs (output of `INTERACTIVE DESIGN` shape).
- `cargo/docs/superpowers/plans/` — implementation plans (output of `writing-plans` skill).
- `cargo/docs/runbooks/` — operational SOPs.
- `cargo/log/decisions/` — ratified Decision Records (DRs).
- `cargo/docs/engineering/handbook.md` — this file.
- `cargo/CLAUDE.md` — agent-canonical surface for this repo, auto-loaded by Claude Code.

## Open

- **Rule 5 concrete mechanism.** Waits on the self-modifying learner design.
- **Friday triage cron form (post DR-2026-05-18).** The pre-retirement Friday triage cron + `bd-mirror` workflow retire under DR-2026-05-18. If a label-only pass over open Issues turns out to add value, file a follow-up GitHub Issue under the engineering handbook umbrella.
- **GitHub Project (v2) board** is live ("Jinn engineering"). No open work here; documented for context.
