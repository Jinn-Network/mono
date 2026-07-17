# Stage 2 framing packet (shared by all three design sessions + the meta session)

- **Date:** 2026-07-17
- **Origin:** Stage 1 close-out session (issue #1654, ratified proceed 2026-07-17; walkthrough
  records in that issue's comments are the freshest ground truth about the shipped product).
- **Read this first in every session.** It is the common contract between the three parallel
  design sessions (A: onboarding, B: corpus supply, C: architecture) and the meta session that
  reconciles them.

## Working assumptions (design against these; flag, don't relitigate)

These are **presumptions, not decisions**. Each design session designs as if they hold, and
maintains a short list of places where its design would materially change if one flips. The meta
session ratifies or flips them with all three flag-sets in hand, and writes the resulting DR.

- **W1 — Outbound contribution is parked.** The mint → preview → publish lane is deferred to a
  later stage (evaluator/reward era). **Local capture stays unconditional** — episodes and
  contribution candidates keep being recorded locally exactly as today; nothing leaves the
  machine. Consequence: the single `shareConsent` question has nothing to gate, so onboarding
  presumes **zero consent questions**.
- **W2 — Two-tier corpus.** Retrieval-visible content is curated and targeted (small, hand-shaped
  for the repos early users actually work in). Bulk/imported/derived material is
  substrate-resident (available to distillation and training consumers) without entering the
  retrieval index by default. Rationale: at three records the walkthrough already produced a
  lexical false-positive; retrieval quality is a function of vocabulary match, not corpus size.
- **W3 — Near-term corpus growth comes from seeding, not contribution.** Follows from W1. The
  evidence-episode seed lane (shipped, `docs/runbooks/stage1-evidence-seeding.md`) is the supply
  mechanism until outbound contribution returns.
- **W4 — No model calls in the retrieval path.** Deterministic lexical retrieval, with the
  ratified escalation ladder: lexical v2 (shipped) → content re-scoring (#1792, designed) →
  embeddings only with Stage 2 attribution evidence. Corpus-side fixes (better summaries, tags,
  tiering) are preferred over retrieval-side complexity.

## Known seams (address explicitly; the meta session diffs these)

| Seam | Between | The question |
|---|---|---|
| First-session aha | A ↔ B | A's onboarding gate needs retrievable content to exist; B owns what content and for which repos. Who owns the "corpus has relevant content" check in the doctor? |
| Evidence contract evolution | B ↔ C | B wants training-ready fields (verifiable reward refs, group-relative outcomes, tool-use fidelity); C owns schema unification. B states requirements; C owns the schema. |
| Process contract + doctor placement | A ↔ C | A's first-run doctor and install checks sit on the plugin↔layer boundary C is refactoring. A states required checks; C decides where they live. |
| "Parked" semantics | all ↔ DR | What parked means in code: surfaces hidden, code behind a flag, or deleted. Each session states what it needs parked to mean for its design. |
| Retrieval visibility mechanics | B ↔ C | The tier tag/flag lives in record metadata or index behavior — B specifies the rule, C confirms it survives the schema unification. |

## Output conventions (all three design sessions)

1. **One spec** at `docs/superpowers/specs/2026-07-XX-<track>-design.md` (repo spec conventions:
   version, date, author, shape `design`). Committed on a branch, PR to `next`, left for the meta
   session to read — merge the PR when the spec is stable (docs-only; fast-merge is fine).
2. **A mandatory final section: "Seams & assumptions register"** with exactly three lists:
   - *Assumes from other tracks* — named interfaces/behaviors this design depends on.
   - *Provides to other tracks* — named interfaces/behaviors others may depend on.
   - *Would renegotiate* — where this design wants a working assumption flipped or a seam moved,
     with the concrete alternative.
3. **A "Proposed issues" section** — the implementation decomposition as a table (title, shape,
   affected packages, dependencies, rough effort). **Do NOT file issues.** The meta session
   reconciles all three lists and files one combined train with merge-pairing declared.
4. State explicit non-goals. Prefer reducing surface area. No speculative infrastructure.

## Process constraints (all sessions)

- Design/investigation only — no implementation. Inspect actual code and GitHub state before
  recommending; the codebase moved fast this week and memory of it may be stale.
- Work in your own worktree; branch from current `origin/next`.
- Sonnet subagents for investigation fan-out are encouraged (the Stage 1 rescope pattern:
  parallel Explore agents → synthesis). The operator steers product decisions; sessions should
  surface decision points rather than bury them.
- Canonical grounding, in priority order: `PRINCIPLES.md` →
  `docs/superpowers/specs/2026-07-14-jinn-plugin-product-roadmap-design.md` (the staged roadmap)
  → `docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-product-design.md` (as amended by the
  rescope) → `docs/superpowers/plans/2026-07-16-jinn-plugin-stage-1-rescope-plan.md`.
- The Stage 1 walkthrough thread (issue #1654, comments of 2026-07-16/17) is the freshest
  ground truth on what the shipped product actually does — nine defects were found there that
  CI could not see. Treat "the gate is green" as necessary, never sufficient.

## Status of known chores (do not re-file)

Already filed, autopilot-bound, and load-bearing for these tracks: #1797 (canary path filter —
blocks real-user install testing), #1784 (seed scrub profile — blocks curated seed authoring),
#1799 (background-review duplicate episodes), #1800 (evidence fidelity of the injected block),
#1792 (content re-scoring), #1783, #1776, #1754.
