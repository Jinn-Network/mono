- **Date:** 2026-05-06
- **Author:** Oak
- **Status:** Proposal
- **Version:** 0.1

## Motivation

`GROWTH.md` exists but defers its load-bearing section: §3 Audiences is `Specifics deferred — to be filled in.` That deferral has had two consequences.

1. **Strategy leaks into the working appendix.** The actual audience taxonomy (Operators / Contributors / Launchers), the X-channel mechanics (Premium mandatory, +75 reply-to-reply weight, cluster-fit dominance), and the "what we will not chase" list live in `growth/docs/2026-04-10-bullseye-framework.md`, `growth/docs/2026-04-10-growth-briefing.md`, `discover-twitter-recruits/references/audience-profile.md`, and `x-algorithm-grader/references/algorithm-model.md`. Each restatement is a fork in the team's collective head — exactly the failure mode `spec/2026-04-28-canonical-docs.md` was written to prevent.
2. **The skills can't compose around a single source of truth.** Three competing audience taxonomies (Operators/Contributors/Launchers, Priority 1/2/Tier-3, AI/Crypto/AI×Crypto) coexist in different skill references and don't align. `growth-day` reads GROWTH.md but its routing logic operates against `growth-log` derivative state, not against canonical strategy. `cluster-model` defines its own clusters. `discover-twitter-recruits` defines its own priorities. The result is that a strategy update — like the 2026-05-06 pivot from "jinn-adjacent crypto" to "AI builders" — has to be edited in five places and silently goes stale in the others.

The 2026-05-06 pivot itself is the forcing function. Sprint #1 (declared 2026-05-05, jinn-adjacent crypto) was abandoned one day in: the cluster was tribal at the sub-segment level and the differentiation from Bittensor / Numerai / Allora was too fine-grained to articulate from inside crypto vocabulary. The agreed reframe inverts the GTM order: AI builders first (pitch: *we use Jinn to compete on public benchmarks; the product is — here's a way to bring your talent to training agentic AI as a public good*), domain professionals later if at all, crypto-native operators downstream once adoption is visible.

Landing this pivot without first fixing the architecture would just deepen the leakage. Landing the architecture without the pivot would be ceremony. Both go together.

## What this proposal changes

### GROWTH.md gains canonical content for what was deferred

The deferred sections are populated and the doc gains three new sections:

- **§3 Target recruit** — single named target cluster at a time, with the canonical pitch line and the bridge model (how the cluster currently thinks vs how Jinn frames the same problem). Updates as we learn. Prior targets archived in `growth-log` §1, not deleted from history.
- **§4 GTM sequence** *(new)* — Phase 1 AI builders → Phase 2 domain professionals (provisional, brand-risk-gated) → Phase 3 crypto-native operators downstream of visible adoption. Each phase has a transition trigger.
- **§5 The daily loop** *(reshape)* — Understand / Teach / Engage / Refine. The previous Teach / Understand / Direct offer / Interact buckets collapse cleanly into the new four (Direct offer + Interact → Engage; Refine is new and load-bearing). Each function names the operationalising skills.
- **§6 What we will not chase** *(restructure)* — split into §6.1 Permanent rules and §6.2 Tactical deferrals. The split lets a deferred-cluster note (e.g. "Sprint #1 retired jinn-adjacent crypto cluster") land without colliding with permanent rules like "no fear-bait."
- **§7 Metrics** *(update)* — supporting metric "Prediction SolverNet submissions" → "Benchmark-SolverNet runs (specific benchmark TBD)". The SolverNet of focus is named here when chosen; it is not pinned to APEX-Agents until the Archipelago T&C concern is resolved.
- **§8 Channel canon** *(new)* — direction-only claims about X (Premium mandatory, reply-to-reply is the engine, cluster-fit dominates first-impression distribution, weekday cluster-peak window, constructive-tone overlay). Numerics and tactical heuristics stay in `x-algorithm-grader/references/`. §8 is the direction those numerics point in. Changes to §8 require a spec proposal; numerics recalibrate freely.
- **§9 Sprint discipline** *(new)* — canonical sprint shape (cluster from §3, time-boxed window, declared inputs, thresholds, decision rule, mandatory postmortem). One active sprint at a time. The `growth-day` fail-loud refers here for sprint shape; growth-day Step 1.5 retains operational enforcement.
- **§10 Where the long-form lives** — current §7 footer renumbered. Spec-proposal rule preserved.

### One reconciled audience taxonomy

The three competing taxonomies collapse around §3's single-target-cluster shape. Operators / Contributors / Launchers becomes a *role annotation* on a cluster (with Launchers absorbed into the deferred Phase 2 bucket of §4). Priority 1/2/Tier-3 becomes the *priority annotation*, derived from the active sprint, not fixed. AI / Crypto / AI×Crypto becomes the *cluster taxonomy* itself — but with only one named *target* in §3 at a time, and the others either explicitly deferred (in §4 phases) or de-prioritised (in §6.2 tactical deferrals).

### `growth-day` reframed as aggregator + guidance, not dispatcher

`growth-day`'s contract becomes:

- **Reads** GROWTH.md §3 (target cluster + bridge model), §5 (loop functions), §7 (metrics), §8 (channel canon), §9 (sprint discipline) — re-anchors each run.
- **Aggregates** operational state from `growth-log`, warm-contacts CSV, today's watcher file.
- **Surfaces** sprint progress, yesterday's loop compliance, today's top-3 *guidance* (each tagged by the §5 function it serves), ready-to-advance warm-list rows, heads-up from watcher, drift flags from twitter-strategy, channel-canon violations from §8.
- **Refreshes** stale read-only feeds (`cluster-model`, `growth-watcher`, `twitter-strategy`) as input to aggregation. Read-only routines are aggregation-side, not action-dispatch.
- **Does not invoke** action routines (`x-post-builder`, `discover-twitter-recruits`, the new `growth-refine`). Oak invokes those from the brief.
- **Fails loud** when no active sprint is in `growth-log` §6, with a message that quotes the §9 sprint shape.

### New skill: `growth-refine`

The Refine function in §5 is operationalised by a new skill at `.claude/skills/growth-refine/`. It closes the loop by proposing diff-shaped amendments to GROWTH.md, skill files, or the loop itself when accumulated evidence drifts from canon. The skill produces *proposals*, not edits — Oak applies via PRs (with a spec proposal for canonical changes). Cadence: ad-hoc, suggested every sprint postmortem, surfaced as a Tier B action by `growth-day` when a refine has not run in >30 days.

### Skills lose the right to redefine canon; retain the right to evolve numeric calibration

Per-skill demotions:

- `cluster-model/SKILL.md` — cluster definitions removed; reads GROWTH §3 to enumerate; cluster-vocabulary moved to a new operational `references/cluster-vocabulary.md`. Bridge-model updates target GROWTH §3 (proposed via refine, not direct write); Evidence appends to `growth-log` §1 as today.
- `discover-twitter-recruits/references/audience-profile.md` — priority tables removed; replaced with reference to GROWTH §3 + §5 Engage. Skill-internal calibration (out-of-scope cases, defining traits, two-tier rule, first-touch bridge) stays. Broken link to `growth/CLAUDE.md` fixed to `GROWTH.md §3`.
- `x-algorithm-grader/SKILL.md` and `references/algorithm-model.md` — preamble's philosophical claims redirected to GROWTH §8. Numerics, scoring tables, calibration logs unchanged.
- `growth-watcher/SKILL.md` — cluster-signals reference targets GROWTH §3 + `growth-log` §1 (not "as defined in cluster-model").
- `twitter-strategy/SKILL.md` — §4 violation heuristics reference GROWTH §6.1 vs §6.2 so tactical deferrals don't fire as permanent violations.
- `growth-day/SKILL.md` — reframed as aggregator; Step 1.5 references GROWTH §9; Step 2 buckets renamed to Understand/Teach/Engage/Refine.
- `x-post-builder/SKILL.md` — Read-first adds GROWTH §3 (current target + bridge model), §5 (which loop function this post serves), §8 (channel canon).

### Two `growth/docs/` files retired

- `growth/docs/2026-04-10-bullseye-framework.md` — deleted. Its canonical claims (Three Audiences, One Metric, What We're Not Doing) are absorbed into GROWTH §3, §6, §7. The reasoning trail is preserved in this spec.
- `growth/docs/2026-04-10-growth-briefing.md` — deleted. Same shape as the bullseye-framework plus an X-algorithm play (now in `x-algorithm-grader/references/`) and a retired pitch (*"Your AI's experience is worth something"*) that GROWTH §6.1 already names as a retired framing.

### Operational state pivot

- `growth/.local/growth-log.md` §7 — Sprint #1 postmortem written. Reasons: cluster too tribal at sub-segment level; differentiation from Bittensor/Numerai/Allora too fine-grained to articulate from inside crypto vocabulary.
- `growth/.local/growth-log.md` §6 — Sprint #2 declared. Cluster: AI builders (per GROWTH §3). Pitch: public-benchmark contribution. Specific benchmark TBD pending T&C resolution on Archipelago.
- `growth/.local/growth-log.md` §1 — existing AI/Crypto/AI×Crypto cluster snapshot retained as history; new annotation when content is promoted into GROWTH §3.

## Sequencing

1. **This spec lands.** Approval gate per `spec/2026-04-28-canonical-docs.md`.
2. **GROWTH.md PR** linked to this spec — populate §3, add §4, reshape §5, split §6, update §7, add §8, add §9, renumber footer. Nothing else.
3. **`growth-refine` skill creation PR** — scaffolding for the new skill so the demotion PR can wire it in.
4. **Skill demotion + reframing PR** — per-skill edits above. No behaviour change beyond reference targets.
5. **Cleanup PR** — delete `growth/docs/2026-04-10-bullseye-framework.md` and `growth/docs/2026-04-10-growth-briefing.md`.
6. **Operational state** — Sprint #1 postmortem, Sprint #2 declaration. Mostly gitignored under `growth/.local/`.

The canonical change must land before the skill edits — otherwise skills point at sections that don't exist.

## Risks and limitations

- **§3 single-target-cluster shape may oversimplify.** When two adjacent clusters are worth tracking in parallel, §3 forces a choice. Counter: §4 GTM sequence handles the multi-phase case explicitly; if two simultaneous targets are genuinely needed, that is itself a real spec proposal, which is the right level of friction.
- **`growth-refine` scope creep.** Risk that the new skill becomes a meta-skill that touches everything and edits nothing well. Mitigation: it produces *proposals*, never edits. Output is a structured diff-shaped document; Oak applies via PRs.
- **Sprint discipline split between §9 (shape) and `growth-day` Step 1.5 (enforcement).** Risk: §9 field rename breaks growth-day's parser. Mitigation: growth-day cites the §9 fields it parses; CODEOWNERS catches drift.
- **Bullseye / briefing deletion loses the historical reasoning trail.** Mitigation: this spec cites both as the source of the absorbed claims, so the reasoning is preserved in spec history; the docs themselves are deleted to remove the canonical-claim leak surface.
- **APEX-Agents / Archipelago T&C concern.** This proposal does not pin §7 to APEX-Agents. The benchmark choice remains open. A separate (non-canonical) decision will name the SolverNet of focus and update §7 via a small follow-up PR.

## Out of scope

- The product-side decision about which public benchmark Jinn competes on first. Ritsu/Cladio's lane. Archipelago T&C resolution, 1-job-=-1-run vs 1-job-=-1-task, and licensing review all happen there. §7 stays "TBD" until that decision lands.
- Re-canonising domain professionals as a target cluster. Phase 2 is provisional; revisit when Phase 1 has produced visible adoption or when a SolverNet stabilises around a domain.

## Open questions

- **Where the bridge model's "Frame they hold" / "Frame Jinn offers" / "The bridge" content lives.** Proposed: in GROWTH.md §3 itself for the *current* target cluster, promoted from `growth-log` §1's Frame + Gap when a target is named. `growth-log` §1 retains the dynamic evidence sample and the historical record. The `cluster-model` skill proposes promotions via `growth-refine`.
- **`growth-refine` cadence.** Proposed: ad-hoc + every sprint postmortem + Tier B surface in `growth-day` when last refine >30 days. Open to making the >30d threshold configurable.
- **Should §8 channel canon eventually fork by channel?** Today it is X-only. If a second channel becomes load-bearing (Telegram, Discord), §8 either splits into §8.1/§8.2 or names additional channels' direction-only claims inline. Defer until a second channel is real.
