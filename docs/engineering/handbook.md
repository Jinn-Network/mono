# Engineering handbook (v1)

This handbook describes how the Jinn engineering team ships. It is the canonical reference for the SOPs, AI workflow rules, and cadence that every contributor (human or AI agent) is expected to follow.

The handbook is **Jinn-flavored**, not generic. Per [`BRAND.md`](../../BRAND.md) the engineering substrate is itself a brand surface — the public sprint board, GitHub Releases, CHANGELOG, DRs, and specs are the visible artifacts that make the headless-brand posture legible. The shipping machine is not separate from the work; it is the work made public.

Canonical references:
- Design that ratified this handbook: [`docs/superpowers/specs/2026-05-11-engineering-handbook-codesign.md`](../superpowers/specs/2026-05-11-engineering-handbook-codesign.md)
- DR-2026-05-11-b — Engineering substrate decision: [`log/decisions/2026-05-11-engineering-substrate.md`](../../log/decisions/2026-05-11-engineering-substrate.md)
- DR-2026-05-11-a — Prediction freeze: [`log/decisions/2026-05-11-freeze-prediction-solvernet.md`](../../log/decisions/2026-05-11-freeze-prediction-solvernet.md)
- Umbrella bd: `jinn-mono-2cl`

## Cadence

Two-track release model:

- **Continuous canary on every merge to `main`.** GitHub Actions (`cargo/.github/workflows/npm-publish.yml`) publishes `<package.version>-canary.<sha8>` under the npm dist-tag `canary` within minutes of any PR merge that touches `client/**`. Operators on `npm install -g @jinn-network/client@canary` receive the rolling build.
- **Weekly named Build Notes cut every Monday.** A Monday cron creates a GitHub Release **draft** at 09:00 UTC. Captain reviews the draft (Hermes-style: build-name + highlights + known-issues + auto-aggregated PRs/closed-bd/stats), then publishes. Publish triggers npm `latest` and the CHANGELOG auto-mirror. Default `npm install -g @jinn-network/client` (no tag) gets the weekly named stable build.

Tag format on Monday cuts: dual — `v2026.MM.DD` (the human-readable build identifier) and `vX.Y.Z` (the semver for npm). Pre-v1 weekly Build Notes cuts usually patch (`v0.1.3 → v0.1.4`). A Monday cut where an epic or significant capability lands can bump the minor (`v0.1.x → v0.2.0`). **v1.0.0 is reserved for far-future graduation** (mainnet / exit-testnet / Phase 2), explicitly not `jinn-mono-uy6v`.

**Bump heuristic** (cron's suggestion, Captain overrides): the Monday cron always suggests a patch bump. Captain manually overrides to the next minor when an epic or significant capability closes in the window. Conventional Commits drives section grouping in Release notes (Features / Fixes / Refactors / Chore / Docs / Tests), **not** per-merge semver bumps. Canary handles per-merge implicit patching.

## Dist-tags

- `canary` — rolling, every-merge build (`<v>-canary.<sha>`).
- `latest` — Monday named stable build.

There is no `next` channel; `canary` is the rolling channel name we use. Operators who want the rolling build use `@canary`; operators who want stable get `latest` by default.

## The shipping machine — process

### Daily loop

In `cargo/`:

```
claude
```

then:

1. **Orient.** Invoke `eng-day` skill (or fallback: `bd ready` + `gh pr list --search 'is:open draft:false'`). Brief reports sprint progress, yesterday's shipped, today's top-3 guidance, drift flags.
2. **Pick one piece of work** — a bd issue, a stale PR, or a design conversation. Run `bd show <id>` to read the work.
3. **Execute according to shape** — the bd issue's `Run-mode` field declares the shape; the shape determines the skill chain, test discipline, design ceremony, and stacking policy (see §The shapes of work below).
4. **Open PR(s).** PR title format: `<shape>(<optional scope>): <one-line summary>` (Conventional Commits). Template in `cargo/.github/PULL_REQUEST_TEMPLATE.md` prompts for problem-not-solution body, test plan, agent identity, Co-Authored-By trailer.
5. **Review.** Human eyes on every PR (rule 4). No agent self-merge. Exception: `fix(incident)` allows reviewer relaxation with documented justification.
6. **Merge → auto-canary.** `npm-publish.yml` fires on merge to main, publishes `<v>-canary.<sha>` under `canary`.
7. **Close bd.** `bd close <id>`. The mirrored GitHub Issue (if any) auto-closes via PR linking.

### Weekly retrace

**Friday afternoon — triage.** The Friday triage workflow (`cargo/.github/workflows/friday-triage.yml`, currently `workflow_dispatch` only until cron is enabled) reads the bd ready queue, picks top-N priority bd issues (P0 + capped P1), invokes `cargo/scripts/bd-mirror` for each to open a public GitHub Issue with sprint label + Project board entry. Captain reviews on Friday and **rejects** anything that doesn't belong (close Issue, remove sprint label). Captain adds Issues by exception only. Default flow is *reject, not select*.

**Monday morning — cut.** The Monday cron (`cargo/.github/workflows/release-notes-scaffold.yml`, currently `workflow_dispatch` only) creates a GitHub Release **draft** at 09:00 UTC. Captain edits build-name + highlights + known-issues, clicks Publish. Publish triggers:

- `npm-publish.yml` (release event branch) → npm `latest`.
- `cargo/.github/workflows/changelog-mirror.yml` → appends Release body to `cargo/client/CHANGELOG.md` under Unreleased.

The Project board's Sprint view resets to the new Monday; shipped items move to the Roadmap view's Done column.

## The shapes of work

The handbook recognises seven shapes plus one emergency sub-flow. Each shape declares a **disposition** — when it applies, what discipline its container demands, what ceremony fits. The shape is declared in the bd issue's `Run-mode` field and replicated in the PR title prefix (Conventional Commits). If a bd issue does not fit one of these shapes, it is mis-scoped — split it or reshape it.

The taxonomy is keyed to Conventional Commits prefixes so it composes with existing tooling: PR title → Release section grouping → CHANGELOG entry.

**The per-shape skill chains below are v0 defaults, not canon.** Treat them as starting heuristics derived from current practice. See §Iterative refinement at the end of this section for how flows evolve as we use them.

| Shape | Trigger | v0 skill chain | Test discipline | Design upfront | Stacking | Observed pitfall (2026-05-11) |
|---|---|---|---|---|---|---|
| **`fix`** — Bug fix | Failing test, user report, canary alert | `systematic-debugging` → `executing-plans` → `verification-before-completion` → `receiving-code-review` | Regression test **first** (rule 7) | Skipped — escalate to `refactor` if bug reveals architectural problem | Skipped — single PR | Proposing a fix before reproducing |
| **`feat`** — Feature | bd issue with acceptance criteria; user request; spec need | (`brainstorming` if scope ambiguous) → `writing-plans` → `test-driven-development` → `executing-plans` or `dispatching-parallel-agents` → `verification-before-completion` → `receiving-code-review` | TDD (rule 7) | Required if scope ambiguous; optional if acceptance concrete | Allowed/encouraged for multi-task | Skipping TDD and discovering at PR time the design doesn't support testing |
| **`refactor`** — Architecture / migration | Scaling problem, velocity drag, migration to a new pattern | `brainstorming` (**required**) → `writing-plans` → `test-driven-development` → `subagent-driven-development` → `executing-plans` → `verification-before-completion` → `receiving-code-review` | TDD + integration tests on migration / contract surfaces (rules 6 + 7) | **Required** — DR for big, spec for medium | **Required** — strangler-fig preferred; each layer ships independently | Big-bang refactor as one giant PR — reviewers reject |
| **`spike`** — Research / exploration | Open "can we?" question; tech evaluation | `brainstorming` → exploratory work in a worktree → write finding as spec or DR | Skipped — output is a finding | The output IS the design | Skipped — spike code does not merge | Letting spike code drift back into a feature PR; not writing the finding |
| **`chore`** — Deps, CI, dev tooling | Dependabot, CI tweak, dev-pain | `executing-plans` → `verification-before-completion` → `receiving-code-review` | Integration tests required if touches a dep (rule 6) | Skipped | Skipped | Batching dep upgrade with feature work |
| **`docs`** — Documentation | Doc gap; canonical-doc amendment; runbook update | `executing-plans` → `receiving-code-review` | Skipped | Required if canonical (SPEC/BRAND/THESIS/GROWTH/GLOSSARY/CLAUDE/README per `cargo/spec/2026-04-28-canonical-docs.md`) — needs Discussion + CODEOWNERS approval | Skipped | Touching canonical docs without the Discussion ceremony |
| **`test`** — Test-only | Coverage gap, flake fix, test refactor | `executing-plans` → `verification-before-completion` | Meta — the test IS the discipline | Skipped | Skipped | Adding tests that pass without exercising the surface |

**Emergency sub-flow of `fix`:**

`fix(incident)` — used when canary is broken, production is incident-mode, or a security disclosure lands. SOP: acknowledge in the incident thread; diagnose (revert is the default); ship the smallest possible patch with **relaxed review** (one reviewer, justification noted in PR body); the post-hoc regression test and proper-fix are **required follow-up beads** filed before the incident is closed. Rule 4 (review parity) explicitly allows relaxation here; rule 7 (regression test) defers but does not waive.

**`Run-mode` values** used in bd issue bodies: `BUG-FIX` / `FEATURE` / `REFACTOR` / `SPIKE` / `CHORE` / `DOCS` / `TEST` / `INCIDENT` / `INTERACTIVE DESIGN`. The `INTERACTIVE DESIGN` value is the meta-shape used when the bd issue's job is to *produce a design doc* — its skill chain is `brainstorming` → spec → DR(s) → bd restructure, with no implementation in the same session.

**Every bd issue declares a `Run-mode`.** Add a `## Run-mode` section to the bd body at create-time. Epics (containers) are exempt; only work-unit beads need it. The `eng-day` daily-brief skill reads `Run-mode` to apply the right skill chain when surfacing a task. If you create a bd without `Run-mode`, a reviewer will infer one from the title and `type` field — `bd update --append-notes` adds the section retroactively, but declaring it up front is cheaper. Captain may amend a previously-declared `Run-mode` if the shape changes (e.g. a `feat` that reveals a deeper architectural problem becomes a `refactor`).

### Iterative refinement of shape flows

The shape taxonomy above is the stable surface. The per-shape skill chains are v0 defaults — they will be wrong in places we haven't shipped enough work to know yet.

Friction observed in a shape's flow → bd issue under `jinn-mono-2cl` → refinement, via one of three paths:

1. **Author a new shape-specific skill.** If friction recurs and no existing skill covers it. New skill lands in `cargo/.claude/skills/` (in-repo, AI agents pick up via Claude Code skill loading); the shape's v0 skill chain in this handbook updates to invoke it.
2. **Amend an existing skill.** If friction is in how an existing skill (e.g., `superpowers:systematic-debugging`) fits the shape's context. The amendment is itself a `docs` change in the relevant skill's repo.
3. **Revise the handbook.** If the friction is taxonomic (e.g., `chore` should split into `chore(deps)` vs `chore(ci)`). `docs`-shape change against this file.

For v0 the refinement mechanism is intentionally lightweight: file a bd under `jinn-mono-2cl` tagged with the shape it concerns, body describing the friction and the proposed refinement. No structured retro skill, no per-PR friction form, no end-of-sprint shape ceremony — until usage demonstrates a more disciplined mechanism would pay off.

## AI workflow rules

The eight rules below land in this handbook + [`cargo/CLAUDE.md`](../../CLAUDE.md) immediately. Rule 5 is a placeholder pending `jinn-mono-8qbc` (the self-modifying learner design).

1. **Worktree-for-multi-agent.** Multi-agent or speculative subagent work uses `git worktree add cargo/.tasks/<id>`, not the primary checkout.
2. **Beads frame problems, not solutions.** bd issue bodies = context + impact + needs-design-session or testable acceptance criteria. Solutions live in design sessions (`INTERACTIVE DESIGN` shape) or implementation plans, not in the bd body.
3. **bd-as-SoR, not `MEMORY.md`.** Memory fragments across accounts and worktrees. Use `bd remember "..."` and `bd memories <keyword>` for persistent knowledge.
4. **Agent PR review parity.** Codex / Opus / Sonnet / Claude PRs go through the same review gate as human PRs. No agent self-merge. Exception: `fix(incident)` allows reviewer relaxation with documented justification.
5. **(Deferred — open)** Supervised-diff for the self-modifying learner. Phase A.5+ learner ships proposed changes as PRs against the repo; designated reviewer approves before merge. Concrete mechanism is open until `jinn-mono-8qbc` closes. **Status: open — see `jinn-mono-8qbc`.**
6. **Integration tests > mocks for migration / contract surfaces.** Mock policy stays for the unit-test pyramid; migration tests must hit a real database or a forked chain (per `superpowers:test-driven-development`'s position on the test pyramid).
7. **TDD for new features, regression test for fixes.** Per `superpowers:test-driven-development`. TDD on `feat` / `refactor`; regression-first on `fix`; deferred-not-waived on `fix(incident)`.
8. **Auto-canary on main merge; Monday-only named stable cut.** Cadence policy from §Cadence above.
9. **`canary` for rolling patches, `latest` for Monday named.** Dist-tag policy from §Dist-tags above.

Rule-to-shape wiring is in §The shapes of work; the mapping is the load-bearing piece. Rules in the abstract are guidance; rules wired to shapes are operational.

## Sprint surface — GitHub Project (v2)

Per DR-2026-05-11-b, the canonical sprint board is a GitHub Project (v2) on `Jinn-Network/mono` named **Jinn engineering**.

- **Status columns**: Todo / In Progress / In Review / Done.
- **Sprint field** (Iteration): keyed to the current Monday week.
- **Epic field** (single select): human option names such as `Engineering handbook`, `Discovery API`, and `v1 public testnet`; option descriptions carry the internal `jinn-mono-<id>` mapping.
- **Default view**: current sprint Status board.
- **Roadmap view**: grouped by Epic in Now / Next / Later.

**bd ↔ GitHub Issue boundary**: bd is the internal SoR. When (and only when) a bd issue is pulled into the upcoming sprint, the `cargo/scripts/bd-mirror` helper opens a public GitHub Issue with a curated subset of the bd body and adds it to the Project board with the current Sprint iteration. The Issue body ends with `Internal tracking: jinn-mono-<bd-id>` so the boundary is legible to external readers. Backlog stays in bd-only.

The Friday triage cron (currently manual via `workflow_dispatch`) auto-mirrors top-N priority bd issues for the upcoming sprint. Captain reviews and **rejects** anything that doesn't belong. Default flow is reject, not select.

## Building in public — substrate

Per the umbrella `jinn-mono-2cl` and DR-2026-05-11-b:

- **GitHub Projects (v2)** — public sprint board (this handbook §Sprint surface above).
- **Public GitHub Issues** — the sprint-scoped mirrored Issues are the externally-visible "what we're working on right now" surface.
- **GitHub Releases + auto-generated notes** — the devlog. Monday cuts. Released artifacts: `v2026.MM.DD` + `vX.Y.Z` dual tags.
- **CHANGELOG.md** — `cargo/client/CHANGELOG.md` auto-mirrored from Release body on publish via `cargo/.github/workflows/changelog-mirror.yml`. npm-tarball-shipped.
- **Repo-as-docs** — `cargo/docs/` (engineering, runbooks, specs, decisions). GitHub Pages-ready.
- **GitHub Discussions** — RFCs / Q&A / governance prep through Phase 2.

What we do **not** do (yet): GitHub Wiki (drifts), Discourse forum (premature — Discussions cover it), Discord/Telegram as engineering substrate (community engagement, not engineering), public bd mirror beyond sprint-scope (bd is internal by design).

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

- **Rule 5 concrete mechanism.** Waits on `jinn-mono-8qbc` (self-modifying learner design).
- **Cron enablement for 2cl.2 + 2cl.11.** Both shipped with `workflow_dispatch` only; cron schedules commented out. Promote after first manual run validates.
- **GitHub Project (v2) board creation.** Tracked as `jinn-mono-2cl.9`. External irreversible org-write; Captain does manually.
