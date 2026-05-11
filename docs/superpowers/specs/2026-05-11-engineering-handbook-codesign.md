---
title: Engineering handbook v1 — co-designed with the v1 release epics
date: 2026-05-11
status: draft
authors: opus (proposed), oak (Captain attached)
spec: docs/engineering/ (handbook precipitate), cargo/CLAUDE.md (canonical agent surface)
supersedes-context-from: cargo/docs/proposals/2026-04-23-engineering-practices-cadence.md (referenced by jinn-mono-2cl; not on disk at time of writing)
bd: jinn-mono-pgjj (this design), jinn-mono-2cl (handbook umbrella)
related-bd: jinn-mono-uy6v, jinn-mono-9iq3, jinn-mono-8psp, jinn-mono-jnw9
related-decisions: DR-2026-05-11-a (Prediction freeze), DR-2026-05-11-b (Engineering substrate — paired with this design)
---

## Context

The 2026-05-11 backlog narrowing pass filed jinn-mono-2cl (engineering handbook v1) as a peer of v1 release work (jinn-mono-uy6v) and sibling epics (jinn-mono-9iq3 Prediction freeze, jinn-mono-8psp Hermes harness, jinn-mono-jnw9 self-modifying learner). A subsequent gap analysis found that 2cl and the epics are entangled in five concrete ways: 2cl.1's CI gate consumes uy6v.2's vitest list, 2cl.2's runbook reference overlaps with uy6v.5's evidence bundle, 2cl.5's CONTRIBUTING file is the same artifact as 9iq3.3's review guardrail, 2cl.4's handbook index needs 9iq3.2's freeze-note to be ratified first, and 2cl's AI-workflow rules include decisions (supervised-diff, agent PR review parity) that the jnw9 / 8psp design beads must close before promotion.

Designing 2cl in isolation produces generic OSS-AI rules. Designing it as the consolidation of decisions the epics force produces a handbook grounded in the work this team is actually shipping. This document is that consolidation.

The handbook is **Jinn-flavored**, not generic. Per BRAND.md the engineering substrate is itself a brand surface — the public sprint board, GitHub Releases, CHANGELOG, DRs, and specs are the visible artifacts that make the headless-brand posture legible. The shipping machine is not separate from the work; it is the work made public.

## Threads designed (recap of locked picks)

The eight threads in jinn-mono-pgjj are closed as follows:

1. **Daily intent discipline.** Sprint container is a GitHub Project (v2) on `Jinn-Network/mono` with a Status board (Open / In Progress / In Review / Shipped), a custom Sprint field keyed to the upcoming Monday's date, and an Epic field (`uy6v` / `8psp` / `jnw9` / `9iq3` / `2cl`). A secondary Roadmap view groups by Epic in Now / Next / Later. The bd remains the internal system of record; only sprint-scoped bd issues mirror to public GitHub Issues, which are the Project board's items. The daily brief is the `eng-day` skill, modeled on `growth-day`.

2. **Cross-references.** Merge 2cl.5 + 9iq3.3 (same artifact: CONTRIBUTING.md). Add blocks edges 2cl.1 → uy6v.2 (acceptance-gate vitest list) and 2cl.4 → 9iq3.2 (handbook cites ratified freeze note). Add a relates edge 2cl.2 ↔ uy6v.5 (same runbook §Evidence list, different artifacts).

3. **AI workflow rule promotion.** Rules 1–4 + 6–9 are battle-tested and promote into AGENTS.md / docs/engineering/ immediately. Rule 5 (supervised-diff for the self-modifying learner) waits on jinn-mono-8qbc (the jnw9 design bead); until then the handbook records rule 5 as a placeholder pointing at the open design.

4. **Gap-close shape.** Tighten 2cl.1 acceptance (absorb: replace manual `release:client`, add acceptance-gate invocation to publish path). Tighten 2cl.2 acceptance (absorb: cron schedule, scaffold content matches Hermes-style, drift mitigation). File two new sibling beads: 2cl.6 (tag-format dual policy `v2026.MM.DD` + `v0.N.0`) and 2cl.7 (`prepublishOnly` hardening — full release-gate suite). No new sub-epic; flat under 2cl.

5. **Bump heuristic.** The Monday cron always suggests a minor bump. Captain manually overrides to major. Pre-v1 Monday cuts go v0.N → v0.N+1.0. v1.0.0 is the Monday cut that ships uy6v. Post-v1 epic close = major (8psp → v2.0.0, jnw9 → v3.0.0); other Mondays minor.

6. **Release-notes scaffold.** Trigger: Monday cron (09:00 UTC). Output: a GitHub Release **draft** with mechanical inputs (merged PRs + authors, closed bd issues, contributors, line stats, suggested semver=minor) and placeholders for build-name + highlights + known-issues. Captain edits in the GitHub Release draft UI and clicks Publish. Release publish triggers npm `latest` (already wired in `cargo/.github/workflows/npm-publish.yml`).

7. **CHANGELOG mirroring.** Workflow on Release publish appends the Release body as a new section in `cargo/client/CHANGELOG.md` under Unreleased. Existing per-release sections (0.1.3, 0.1.2, …) stay verbatim. No root CHANGELOG; the GitHub Releases page is the repo-wide narrative; the per-package CHANGELOG is the npm-consumer mirror only.

8. **Dist-tag.** Keep `canary` as the rolling dist-tag. `latest` is Monday named. The original 2cl proposal of renaming `canary` → `next` is dropped — `canary` already matches the intent and the rename's deprecation cost exceeds its framing benefit.

## The shipping machine — process

The handbook describes one daily loop and one weekly retrace. Both fit on a single screen.

### Daily loop

Captain starts in `cargo/`:

```
cd cargo
claude
```

Then:

1. **Orient.** `eng day` (once jinn-mono-2cl.8 ships) reads the GitHub Project board, open PRs, and the bd ready queue, and prints a four-line brief: today's sprint progress against the upcoming Monday cut, yesterday's shipped, today's top-3 *guidance* actions (Captain picks; the skill does not auto-dispatch), and drift flags (canary status, sprint age > 7 days, PRs > 3 days stale, named-`latest` vs canary mismatch). Until 2cl.8 ships, the fallback is `bd ready` plus `gh pr list --search 'is:open draft:false'`.

2. **Pick one piece of work.** Always a single unit: a bd issue, a stale PR to review, or a design conversation. `bd show <id>` reads the work; its body's `Run-mode` field tells you which flavor.

3. **Execute** according to the work's **shape**. The shape is declared in the bd issue's `Run-mode` field and determines the skill chain, test discipline, design requirement, and stacking policy. See §The shapes of work below for the full taxonomy. The seven shapes are `fix`, `feat`, `refactor`, `spike`, `chore`, `docs`, `test` (plus `fix(incident)` as a sub-flow of `fix`). The shape also determines the Conventional Commits prefix that goes on the PR title, which propagates through to the Monday Release notes section grouping.

4. **Open PR(s).** PR title format is `<shape>: <one-line summary>` or `<shape>(<scope>): <one-line summary>` per Conventional Commits — for example `fix: SWE typed payload fallback validation`, `feat(uy6v): live verdict-success on Base Sepolia`, `refactor: extract Harness selection from buildHarnesses`. The PR template prompts for: problem-not-solution body (rule 2), test plan, agent identity (`agent:opus` / `agent:codex` / `human` labels), and a `Co-Authored-By` trailer for AI commits.

5. **Review (rule 4: agent PR review parity).** Every PR gets human eyes before merge. No agent self-merge. Codex / Opus / Sonnet / Claude PRs go through the same gate as human PRs. Reviewer may request a stack-split for any single PR that exceeds 300 LOC without an obvious single logical-thing. The one allowed relaxation is `fix(incident)` — see the incident sub-flow in §The shapes of work.

6. **Merge → auto-ship canary.** `cargo/.github/workflows/npm-publish.yml` fires on every merge to main with paths matching `client/**` and publishes `<package.version>-canary.<sha8>` under the `canary` dist-tag. Operators on `npm i -g @jinn-network/client@canary` receive it within minutes.

7. **Close bd.** `bd close <id>`. The Project board's mirrored GitHub Issue moves to the Shipped column (via Project automation on Issue close; the GitHub Issue is auto-closed via PR linking).

### Weekly retrace

**Friday afternoon — triage.** A Friday cron (jinn-mono-2cl.11 — to file) reads the bd ready queue, picks the top-N priority issues (P0 + P1, capped at sprint capacity), and auto-mirrors each to a public GitHub Issue with sprint label `sprint:<next-monday-date>`, epic label, and a footer `Internal tracking: jinn-mono-<id>`. The cron also adds the Issue to the Project board with `Sprint = <next-monday-date>`. Captain reviews on Friday afternoon and **rejects** any that don't belong (closing the GH Issue and removing the sprint label). Captain only adds Issues by exception. Default flow is *reject, not select*.

**Monday morning — cut.** The Monday cron (09:00 UTC) computes the window since the last `v0.N.0` tag and opens a GitHub Release **draft** shaped like Hermes Agent's:

```
# v0.4.0 — "<build name placeholder>"
2026-05-18 · Suggested bump: minor

## Highlights
- <placeholder — Captain edits>

## Changes
- (#125) Fix SWE typed payload fallback validation — @opus
- (#126) Prepare SWE donation release gates — @oak
- …

## Closed this week
- jinn-mono-uy6v.7 — Live verdict-success on Base Sepolia
- …

## Stats
- 18 commits · 7 PRs · 12 files · +1,240 / -380 LOC · 3 contributors

## Known issues
- <placeholder>
```

Captain reviews, fills in build-name + highlights + known-issues, clicks Publish. Publish triggers:

- `npm-publish.yml` (release branch of the workflow) → publishes `v0.4.0` under `latest`.
- The CHANGELOG mirror workflow (jinn-mono-2cl.10) → appends the Release body to `cargo/client/CHANGELOG.md` under the Unreleased section.
- Tags created: `client-v0.4.0` (current format) and `v2026.05.18` (date tag — once jinn-mono-2cl.6 ships dual tagging).

The Project board's Sprint view resets to the new Monday's sprint; shipped items move to the Roadmap view's Done column.

### The shapes of work

The handbook recognises seven shapes of work plus one emergency sub-flow. Each shape has a distinct **disposition** — when it applies, what kind of discipline its container demands, what design ceremony fits. The shape is declared in the bd issue's `Run-mode` field and replicated in the PR title prefix (Conventional Commits) so it propagates through to Release notes section grouping. If a bd issue does not fit one of these shapes, it is mis-scoped — split it or reshape it.

The taxonomy is keyed to Conventional Commits prefixes so it composes with existing tooling: PR title → Release section grouping → CHANGELOG entry. Note that the bump heuristic remains the one locked in Thread 5 (weekly named-minor; Captain overrides to major on epic close) — Conventional Commits here drives section grouping in Release notes and Release-notes scaffold readability, **not** per-merge semver bumps. The canary channel handles per-merge patch publishing implicitly (`<v>-canary.<sha>`).

**Important — the per-shape skill chains below are v0 defaults, not canon.** They are starting heuristics derived from current practice (existing superpowers skills, recurring patterns Captain has noticed in 2026-Q2 work). They will be wrong in places we haven't shipped yet. The handbook treats them as inputs to an iterative refinement loop — see §Iterative refinement of shape flows at the end of this section. The shape *taxonomy* (which shapes exist, when each applies) is more stable than the *flows* (which skills, in what order, with which checkpoints).

| Shape | Trigger | v0 skill chain | Test discipline | Design upfront | Stacking | Observed pitfall (as of 2026-05-11) |
|---|---|---|---|---|---|---|
| **`fix`** — Bug fix | Failing test, user report, canary alert | `systematic-debugging` → `executing-plans` → `verification-before-completion` → `receiving-code-review` | Regression test **first** (rule 7) | Skipped — escalate to `refactor` if bug reveals an architectural problem | Skipped — single PR | Proposing a fix before reproducing. The skill enforces: no fix without a reproducing test. |
| **`feat`** — Feature | bd issue with acceptance criteria; user request; spec need | (`brainstorming` if scope ambiguous) → `writing-plans` → `test-driven-development` → `executing-plans` or `dispatching-parallel-agents` → `verification-before-completion` → `receiving-code-review` | TDD (rule 7) | Required if scope ambiguous; optional if acceptance criteria are concrete | Allowed and encouraged for multi-task features | Skipping TDD ("I'll add tests after") and discovering at PR time that the design doesn't support testing |
| **`refactor`** — Architecture / migration | Scaling problem, velocity drag, migration to a new pattern | `brainstorming` (**required**) → `writing-plans` → `test-driven-development` → `subagent-driven-development` → `executing-plans` → `verification-before-completion` → `receiving-code-review` | TDD + integration tests on migration / contract surfaces (rules 6 + 7) | **Required** — DR for big refactors, spec for medium | **Required** — strangler-fig preferred; each layer must ship independently as a valid partial state | Big-bang refactor as one giant PR. The handbook explicitly forbids this; reviewers reject. |
| **`spike`** — Research / exploration | Open "can we?" question; tech evaluation; performance investigation | `brainstorming` → exploratory work in a worktree → write the finding as a spec or DR | Skipped — output is a finding, not code | The output IS the design | Skipped — spike code does not merge to `main` | Letting spike code drift back into a feature PR; not writing the finding |
| **`chore`** — Deps, CI, dev tooling | Dependabot, CI tweak, dev-pain | `executing-plans` → `verification-before-completion` → `receiving-code-review` | Integration tests required if it touches a dep (rule 6) | Skipped | Skipped | Batching a dep upgrade with feature work in one PR |
| **`docs`** — Documentation | Doc gap; canonical-doc amendment; runbook update | `executing-plans` → `receiving-code-review` | Skipped (it's docs) | Required if canonical (SPEC/BRAND/THESIS/GROWTH/GLOSSARY/CLAUDE/README per `cargo/spec/2026-04-28-canonical-docs.md`) — needs a GitHub Discussion + CODEOWNERS approval | Skipped | Touching canonical docs without the Discussion ceremony |
| **`test`** — Test-only | Coverage gap, flake fix, test refactor | `executing-plans` → `verification-before-completion` | Meta — the test IS the discipline | Skipped | Skipped | Adding tests that pass without actually exercising the surface |

**Emergency sub-flow of `fix`:**

`fix(incident)` — used when canary is broken, a production incident is open, or a security disclosure lands. SOP: acknowledge in the incident thread; diagnose (revert is the default; forward-fix only if revert fails); ship the smallest possible patch with **relaxed review** (one reviewer, justification noted in the PR body); the post-hoc regression test and proper-fix are **required** follow-up beads filed before the incident is closed. Test discipline is deferred but not waived. Common pitfall: not writing the postmortem; not filing the proper-fix follow-up bead. Rule 4 (PR review parity) explicitly allows relaxation here; rule 7 (regression test) defers but does not waive.

**`Run-mode` values used in bd issues**: `BUG-FIX` / `FEATURE` / `REFACTOR` / `SPIKE` / `CHORE` / `DOCS` / `TEST` / `INCIDENT` / `INTERACTIVE DESIGN`. The `INTERACTIVE DESIGN` value is a meta-shape used when the bd issue's job is to *produce a design doc* (this very bd, jinn-mono-pgjj, is an example) — its skill chain is `brainstorming` → write spec → write DR(s) → bd restructure, with no implementation in the same session.

**How the rules wire to shapes:**

- Rule 1 (worktree-for-multi-agent): mandatory on `refactor` and large `feat` (parallel subagents); allowed on `spike`.
- Rule 2 (problems-not-solutions bd body): mandatory on all shapes.
- Rule 3 (bd-as-SoR): mandatory on all shapes.
- Rule 4 (agent PR review parity): mandatory on all shapes **except** `fix(incident)`, where relaxation is allowed with documented justification.
- Rule 5 (supervised-diff — deferred to jnw9): future — applies to the self-modifying learner's PRs across all shapes it touches.
- Rule 6 (integration > mocks): mandatory on `refactor` and `chore`(deps).
- Rule 7 (TDD / regression): TDD on `feat`/`refactor`; regression-first on `fix`; deferred-not-waived on `fix(incident)`.
- Rule 8 (cadence: auto-canary, Monday named): mechanical, applies to every merge regardless of shape.
- Rule 9 (`canary` rolling, `latest` Monday): mechanical, applies to every published version.

### Iterative refinement of shape flows

The shape taxonomy above is the stable surface. The per-shape skill chains (column 3) are v0 defaults — best guesses derived from current practice on 2026-05-11. They will be wrong in places we haven't shipped enough work to know yet.

The handbook adopts an explicit iteration loop for the flows. The principle: **friction observed in a shape's flow → bd issue → refinement**. There are three refinement paths a friction signal can take:

- **Author a new shape-specific skill.** When a friction recurs and no existing skill covers it (example: there is no current `eng-shape-retro` skill; if shape-level retros prove load-bearing one might be written). The new skill lands in `cargo/.claude/skills/` or `~/.claude/skills/` depending on scope, and the shape's v0 skill chain in this handbook updates to invoke it.
- **Amend an existing skill.** When the friction is that an existing skill (e.g., `superpowers:systematic-debugging`) does not fit the shape's context well. The skill amendment is itself a `chore` or `docs` shape change in the relevant skill's repo, and the handbook's skill chain updates to reflect the amendment if its invocation changes.
- **Revise the handbook.** When the friction is that the shape's *taxonomy* is wrong (e.g., what we called `chore` should split into `chore(deps)` vs `chore(ci)` because they want different SOPs). This is a `docs` change against `cargo/docs/engineering/handbook.md`.

For v0 the mechanism is intentionally lightweight: file a bd issue under `jinn-mono-2cl` (the handbook umbrella) tagged with the shape it concerns, body describing the friction observed and the proposed refinement, and let it be picked up like any other engineering work. No structured retro skill, no per-PR friction form, no end-of-sprint shape ceremony — until usage demonstrates a more disciplined mechanism would pay off.

The expected first refinements (best-guess places we'll feel friction first):

- `feat` flow when scope is ambiguous in a way that `brainstorming` doesn't catch — may need a pre-`brainstorming` triage step.
- `refactor` flow when strangler-fig is the right pattern but the team reaches for big-bang anyway — may need a `refactor-strangler` skill that scaffolds the layer structure.
- `fix(incident)` flow when relaxed review meets "what's the proper-fix?" — may need an incident-postmortem skill that ensures the proper-fix bd is filed before incident close.

These are guesses, not predictions. The shape-flow refinement mechanism captures whichever frictions actually surface, not the ones we anticipate.

### Entry point

The entry point is always `bd show <id>` followed by reading the `Run-mode` field. Cold-start has two equivalent paths:

- **Skill-driven** (once 2cl.8 ships): `eng day` → presents top-3 with bd ids → `bd show <id>`.
- **Manual** (today): `bd ready` → pick → `bd show <id>`.

The work-unit is always the bd issue. Everything else composes off it.

## AI workflow rules

The 2cl umbrella locked nine rules. Eight promote to `cargo/CLAUDE.md` (the canonical agent surface for this repo — auto-loaded by Claude Code) and `cargo/docs/engineering/handbook.md` (the canonical handbook prose, written at jinn-mono-2cl.4) immediately:

1. **Worktree-for-multi-agent.** Multi-agent or speculative subagent work uses `git worktree add cargo/.tasks/<id>`, not the primary checkout.
2. **Beads frame problems, not solutions.** bd issue bodies = context + impact + needs-design-session or testable acceptance criteria; solutions live in design sessions or implementation plans.
3. **bd-as-SoR, not `MEMORY.md`.** Memory fragments across accounts and worktrees. Use `bd remember` and `bd memories <keyword>` for persistent knowledge.
4. **Agent PR review parity.** Codex / Opus / Sonnet / Claude PRs go through the same review gate as human PRs. No agent self-merge.
5. **(Deferred)** Supervised-diff for the self-modifying learner. The Phase A.5+ learner ships proposed changes as PRs against the repo; designated reviewer approves before merge. The concrete mechanism is open until jinn-mono-8qbc closes; until then, the handbook records this as a placeholder.
6. **Integration tests > mocks for migration / contract surfaces.** Mock policy stays for the unit-test pyramid; migration tests must hit a real database or a forked chain.
7. **TDD for new features, regression test for fixes.** Per `superpowers:test-driven-development`.
8. **Auto-canary on main merge; Monday-only named minor.** Cadence policy from the 2cl umbrella, refined in this design's Thread 5.
9. **`canary` for rolling patches, `latest` for Monday named.** Updated from the umbrella's original `next` proposal per this design's Thread 8.

Rule 5 lands as a stub when 2cl.4 (docs/engineering/ index) writes, with `Status: open — see jinn-mono-8qbc` and a link to the design bead. It promotes to a full rule when 8qbc ratifies.

The rule-to-shape mapping (which rules apply to which work shapes) is documented in §The shapes of work above. The mapping is the load-bearing piece — rules in the abstract are guidance; rules wired to shapes are operational.

## bd restructure

The following actions land as part of this design closure:

| Action | Bead | Detail |
|---|---|---|
| Merge | 9iq3.3 → 2cl.5 | 2cl.5 gains a "Prediction-freeze guardrail" section; 9iq3.3 closes as duplicate-merged |
| Add blocks edge | 2cl.1 → uy6v.2 | acceptance-gate vitest list defined by uy6v.2 |
| Add blocks edge | 2cl.4 → 9iq3.2 | handbook cites DR-2026-05-11-a after 9iq3.2 ratifies the freeze note |
| Add relates edge | 2cl.2 ↔ uy6v.5 | same runbook §Evidence list, different artifacts |
| New | jinn-mono-2cl.6 | Tag format dual policy (`v2026.MM.DD` date + `v0.N.0` semver) |
| New | jinn-mono-2cl.7 | `prepublishOnly` hardening (invoke `release:operator-gate` + `release:donation-consumption`) |
| New | jinn-mono-2cl.8 | `eng-day` skill modeled on `growth-day`, P2 (after uy6v ships) |
| New | jinn-mono-2cl.9 | GH Project (v2) board setup: Status board + Sprint field + Epic field + Roadmap view |
| New | jinn-mono-2cl.10 | CHANGELOG auto-mirror workflow on Release publish |
| New | jinn-mono-2cl.11 | Friday triage cron: auto-mirror top-N priority bd → GH Issue + add to Project; Captain rejects |
| New | jinn-mono-2cl.12 | `bd-mirror <bd-id> <sprint-date>` helper script (used by 2cl.11 cron + manual one-shots) |
| Amend body | jinn-mono-2cl | drop `next` rename, fix stale proposal link, point at GH Project as sprint surface, cite DR-2026-05-11-b |

Tighten existing acceptance criteria on 2cl.1 and 2cl.2 to absorb the gap-scan deltas (replace manual `release:client`, add acceptance-gate invocation to publish, Hermes-shaped scaffold content, drift mitigation explicit).

## Open

- **Rule 5 (supervised-diff) concrete mechanism.** Waits on jinn-mono-8qbc design closure.
- **Hermes harness composition with rule 5.** Hermes has its own learning loop; whether that subsumes or composes with the Jinn-level learner is the question for jinn-mono-8psp.1.
- **eng-day priority.** Filed as P2; revisit after uy6v ships. If the manual fallback (`bd ready` + `gh pr list`) is friction once the GH Project board is steady-state, promote to P1.
- **Friday triage cron threshold.** Top-N defaults to "all P0 + capped P1 by Captain's set sprint-capacity" — the cap value is itself open. Suggest 8 issues / sprint as a starting heuristic; calibrate after two sprints.
- **2cl.11 cron — auto-mirror conservative or aggressive?** Conservative version mirrors only P0; aggressive mirrors P0 + all P1. Pick at 2cl.11 design time.
- **Shape-flow refinement mechanism v1 shape.** For v0 the mechanism is "file a bd under jinn-mono-2cl when friction surfaces" (per §Iterative refinement of shape flows). If by uy6v close the refinement beads cluster around a recurring pattern — e.g., shape retros becoming valuable, or per-PR friction notes proving load-bearing — file a follow-up design bead under jinn-mono-2cl for the v1 mechanism. Until then, no ceremony.

## References

Internal:
- jinn-mono-pgjj (this design's bd)
- jinn-mono-2cl (handbook umbrella)
- jinn-mono-uy6v / 9iq3 / 8psp / jnw9 (related epics)
- DR-2026-05-11-a — Prediction freeze (`cargo/log/decisions/2026-05-11-freeze-prediction-solvernet.md`)
- DR-2026-05-11-b — Engineering substrate (`cargo/log/decisions/2026-05-11-engineering-substrate.md`) — paired with this design
- `cargo/.github/workflows/npm-publish.yml` (current auto-publish wiring)
- `cargo/.github/PULL_REQUEST_TEMPLATE.md` (current PR template — to extend in 2cl.3)
- `cargo/client/CHANGELOG.md` (current changelog — to auto-mirror via 2cl.10)
- `cargo/CLAUDE.md` (canonical agent surface for this repo — the handbook's eight ratified rules land here)
- `cargo/BRAND.md` §Headless-brand posture (substrate-as-brand-surface rationale)
- `cargo/docs/runbooks/swe-rebench-v2-public-testnet.md` §Acceptance Gates + §Evidence To Retain (consumed by 2cl.1 and 2cl.2)

External:
- Hermes Agent — weekly named cadence + cumulative release notes pattern: https://github.com/NousResearch/hermes-agent
- GitHub `gh-stack` CLI extension (April 2026) for stacked PRs: https://www.infoq.com/news/2026/04/github-stacked-prs/
- Graphite — stacked-PR tooling and Graphite Agent reference: https://graphite.dev
- Conventional Commits — the shape-prefix SoR feeding PR titles → Release notes sections → CHANGELOG entries → semantic-bump heuristic: https://www.conventionalcommits.org
- Other Internet — *Headless Brands* (the brand-posture frame BRAND.md inherits): https://otherinter.net/research/headless-brands/
- Cloudflare — *The AI engineering stack we built internally* (agent-canonical-docs pattern reference): https://blog.cloudflare.com/internal-ai-engineering-stack/
