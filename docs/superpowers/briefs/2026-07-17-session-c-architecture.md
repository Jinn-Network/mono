# Session brief C — Stage 2 architecture design

Design session. Output is a spec, not implementation — and **not a program plan** (the meta
session owns scheduling, issue filing, and sequencing). **Read
`docs/superpowers/briefs/2026-07-17-stage2-framing-packet.md` first and follow it.**

## Mission

Design the Stage 2 architecture: the roadmap's "product-shaped foundation." Three pillars, one
spec:

1. **Package extraction to its end-state.** The Stage 1 package architecture
   (`docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-package-architecture.md`) chose
   "approach C — contract core now, strangler-fig migration" and explicitly named **approach B
   (full extraction) as the Stage 2 destination** (§1), with implementation mass migrating out
   of `client/packages/harness-layer` (§11). Design that end-state: package layout, dependency
   direction, what moves, what dies, the migration sequence (strangler-fig, stacked PRs per the
   refactor shape rules).
2. **Evidence-contract unification.** The roadmap's Stage 2 bullets: "unifies overlapping task,
   trace, trajectory, snapshot, outcome, and contribution concepts; removes accidental storage
   boundaries that hide meaningful evidence inside generic artifacts." The current reality to
   unify — verify each in code: a solve's evidence lives in **four places by stage** (working-dir
   transcript streams; the signed `jinn.execution.v1` envelope on IPFS with `jinn.trajectory.v1`
   + `system_snapshot` raw bytes; the Ponder execution-ledger rows; operator-local envelope
   projections), while the interactive lane writes **three local stores** (episodes dir, legacy
   captures tee, the mineable contribution store) plus the corpus-published evidence shape.
   DR-2026-07-14 (raw = capture, typed = first derivation) is the ratified conceptual spine —
   design the storage/index architecture that makes it true with fewer accidental homes.
3. **Attribution (P6).** Stage 2's gate: "Jinn can determine whether its intervention helped,
   harmed, or made no difference." Stage 1 deliberately stopped at `searched → provided` and
   left the lineage hook (`activity.providedRefs` links consumer episode → source evidence).
   Design the minimal honest attribution mechanism on top of it — what gets measured, how
   provided-vs-not sessions compare, what instrumentation the episode/summary needs, and what
   claim the product is allowed to render (guard against the multiple-comparisons and
   regression-to-the-mean traps; `docs/learning-engine.md` is the house methodology).

## Required reading (beyond the framing packet's canon)

- The package architecture spec above, incl. §11a (post-rescope amendments: SkillsPort
  quarantine, content-bearing CorpusPort, shipped-API reconciliation) and #1755's closure.
- The roadmap's Stage 2 section (all eight bullets — they are the requirements list).
- `log/decisions/2026-07-14-trajectory-is-the-transcript.md`.
- Stage-1 debt issues that are architectural in nature — triage each as in-scope (architecture)
  or chore (hand to meta's backlog): #1792 (content re-scoring — the CorpusPort/pickup flow it
  needs), #1799 (host-internal sessions duplicating episodes/candidates — a capture-boundary
  design question), #1800 (evidence fidelity: recording what the model actually received —
  an attribution prerequisite), #1754 (plugin-ci client-compat), #1797 (publish path filter —
  symptomatic of the bundling topology), #1783.
- `client/ARCHITECTURE.md`, the harness-layer source layout, `packages/plugin` as shipped.

## Investigate before designing

- The actual dependency graph today: client ↔ harness-layer ↔ @jinn-network/plugin ↔ sdk,
  portal wiring, what the daemon links vs. what the CLI links, where the process contract sits.
- Every evidence store, with paths and owners (the inventory above — confirm, correct, and
  diagram it).
- The attribution data actually available after a week of dogfooding (real episodes with
  `providedRefs` exist now — look at them; what comparison do they support honestly?).
- What Stage 2's "stable canonical evidence contract shared by local and public knowledge"
  means against B's incoming training-readiness requirements (the B↔C seam — you own the
  schema; B states field-level needs).
- Contract versioning: the process contract is v1; determine what the extraction/unification
  does to it and how hosts migrate (A↔C seam: A's doctor and install checks ride this
  boundary).

## Questions the spec must answer

1. The end-state package layout and dependency rules (with the boundary-enforcement story —
   architecture tests, CI jobs — carried forward from §7 of the Stage 1 package architecture).
2. The unified evidence architecture: one store or federated-with-one-index; what is canonical
   vs. derived-view per DR-2026-07-14; the migration path for existing local data (a week of
   real episodes exists — don't strand it).
3. The attribution MVP: design + its honest claim boundary + the instrumentation delta.
4. Which Stage-1 debt items the architecture absorbs vs. hands to the backlog (explicit list).
5. Migration sequencing at design granularity (phases and their invariants — the meta session
   turns this into issues), including what must NOT run concurrently with tracks A/B
   implementation and why (name the files/surfaces).
6. Explicit non-goals (multi-host adapters, Skills Hub, network distillation — confirm out;
   they are Stage 3+ per the roadmap).

## Output

Per the framing packet: spec at `docs/superpowers/specs/2026-07-XX-stage2-architecture-design.md`
with the Seams & assumptions register and the Proposed issues table (do not file). End with the
recommended verification posture for the refactor (the cold-stock gate + a regression
walkthrough, per the Stage 1 precedent that live walkthroughs catch what CI structurally cannot).
