# Session brief B — Corpus supply and data strategy design

Design session. Output is a spec, not implementation. **Read
`docs/superpowers/briefs/2026-07-17-stage2-framing-packet.md` first and follow it** — working
assumptions W1–W4, the seams table, output conventions, and process constraints all apply.

## Mission

Design the corpus's **supply side**: what data enters it, through which lane, at which
visibility tier, in what shape — such that it serves **retrieval now** and is **ready for skill
distillation and post-training later** (SFT, Agent SFT, RL/RLVR, preference optimization) without
re-capturing anything. Under W1/W3, seeding — not user contribution — is the growth mechanism
for the foreseeable stages; this spec is therefore the corpus's de-facto growth strategy.

## Product framing (from the Stage 1 close-out discussion — engage, don't assume)

The operator's directional steer, to be stress-tested and made precise here:

1. Contribution back to the corpus is not a requirement until later stages (→ W1/W3).
2. Corpus data should be useful for retrieval **and** ready for distillation → SFT / Agent SFT /
   RL-RLVR / preference optimization.
3. "Maybe we just seed it with existing HF datasets or just use the datasets directly at the
   beginning."

A prior position exists on (3) — sharpen, confirm, or refute it with evidence: *don't launder HF
datasets through the corpus for training's sake* (anyone can train on SWE-bench; mirroring it
into signed envelopes adds provenance theater, not value). The corpus's comparative advantage is
data HF does not have: **verdict-grounded marketplace attempts** (~2,676 backfilled derived
trajectories from real solves exist in-house — verify location, shape, and publishability),
**group-relative outcomes** (`{groupSize, nPass, nFail}` shipped via #1478), and **user-context
episodes**. Under that position: curated imports serve retrieval relevance; training consumers
use HF directly plus our native evidence; RLVR specifically wants our mint lane (it carries the
verifiable test contract that generic trajectory dumps lack).

## Required reading (beyond the framing packet's canon)

- `spec/2026-07-06-distillation-v1.md` — the three stores, D8 (held-out contamination
  boundary), D9/D11 (retrieval-over-evidence baseline). Your seeds feed this pipeline.
- `spec/2026-07-06-capability-eval-v0.md` + the held-out slate — **imports must respect the
  contamination boundary** (instance_id AND repo exclusion). This is a hard constraint.
- `log/decisions/2026-07-09-swe-smith-spike-task-creator.md` — prior art on synthetic task
  generation.
- `docs/runbooks/stage1-evidence-seeding.md` + `client/packages/harness-layer/src/seed-import/`
  — the shipped seed lane (episodes source, idempotency, supersedes), and #1784 (scrub-profile
  mismatch, already filed).
- `log/decisions/2026-07-14-trajectory-is-the-transcript.md` — the span vocabulary all evidence
  shares; raw-vs-typed roles.
- Issues #1791/#1792 — retrieval's lexical limits and the designed content-rescoring step. Your
  content decisions (summaries, tags, synthesis quality) are the other half of retrieval
  quality.
- `docs/superpowers/plans/2026-07-04-1393-engine-corpus-autoload.md` — the *other* retrieval
  consumer (operator engine autoload); your tiering must serve or explicitly scope it.

## Investigate before designing

- Live corpus contents (probe the testnet indexer) and the full record-type inventory on the
  wire vs. in schemas.
- The 2,676 backfilled trajectories (#1672): where they live, their exact shape, what promoting
  them into the corpus costs — and specifically whether **substrate-tier residency requires
  on-chain anchoring at all** (per-record IPFS+anchor cost at bulk scale is a real design
  input; a cheaper substrate store may be the honest answer — take a position and reconcile it
  with Legibility).
- What each training consumer actually needs, as a field-level checklist against the current
  evidence contract: SFT (prompt/response or full trajectories), Agent SFT (multi-turn tool use
  with observations), RLVR (task + verifiable reward — map to the mint lane's F2P/P2P/test
  contracts), preference optimization (grouped/ranked attempts — map to the group-relative
  fields). The delta between "what evidence carries" and "what training needs" is the B↔C seam
  input: state requirements; C owns the schema.
- HF dataset survey (bounded — a day, not a week): the 3–5 most plausible sets for each
  consumer, license posture, shape-fit to the span vocabulary, and which (if any) earn
  retrieval-tier import vs. direct-use-at-training-time.
- The retrieval-visibility mechanism options (tag filtered at pickup, enrichment opt-out, index
  exclusion) — specify the rule; C confirms it survives schema unification.
- The curated-seed pipeline as a repeatable process: who authors, per-repo targeting for actual
  early users, quality bar (the walkthrough proved synthesis/tags quality determines
  retrievability), cadence, and the measurement (provide-rate on real sessions at N records).

## Questions the spec must answer

1. The two-tier rule, exactly: what marks a record retrieval-visible, who decides, how demotion
   works (W2 made precise — or argued down, with the lexical-collision evidence addressed).
2. The seeding roadmap: first 3 supply moves in order (candidate default: promote the backfill
   to substrate tier; fix-then-run curated seeds for the repos early users touch; define the
   HF policy) — each with cost and owner.
3. The post-training readiness contract: the field checklist per method, as requirements handed
   to C.
4. The HF policy: import-to-corpus vs. use-directly, per consumer, with license/contamination
   discipline (cap-eval boundary) stated as invariants.
5. Anchoring economics: what bulk substrate residency costs on-chain, and the tiered
   anchoring position.
6. How supply quality is measured (retrieval provide-rate, distillation yield, and — later —
   training lift), and what "enough corpus for onboarding" means (the A↔B seam: what B
   guarantees A's first-session aha).
7. Explicit non-goals (e.g., knowledge pricing, network distillation rung 3, evaluator
   economics — confirm out).

## Output

Per the framing packet: spec at `docs/superpowers/specs/2026-07-XX-corpus-supply-design.md` with
the Seams & assumptions register and the Proposed issues table (do not file). End with the
recommended verification moment: a live retrieval session against the first curated seed batch,
run by the operator.
