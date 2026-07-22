# SolverNet Benchmarking Primitive — Consumer Requirements and Design

- **Version:** 0.1
- **Date:** 2026-07-22
- **Author:** Ritsu (design session, Claude Opus 4.8)
- **Shape:** `design` — output is this document; no implementation or implementation plan in this
  session
- **Status:** proposed (written review pending)
- **Parent direction:**
  [`2026-07-16-jinn-skill-factory-design.md`](2026-07-16-jinn-skill-factory-design.md) v1.0 §11
  names this pass: its Block 2 ("the benchmarking primitive, skill-agnostic") is to be specced as
  a generic SolverNet capability with its own consumer-driven design. The product roadmap
  ([`2026-07-14-jinn-plugin-product-roadmap-design.md`](2026-07-14-jinn-plugin-product-roadmap-design.md))
  already names "benchmark derived artifacts" as one of the task marketplace's two durable roles;
  this document is that role's design.
- **Input contract dependency:**
  [`2026-07-10-task-creator-generalized-task-capsules-design.md`](2026-07-10-task-creator-generalized-task-capsules-design.md)
  — the capsule stack (`jinn.task-capsule.v1`, `jinn.evaluator-bundle.v1`,
  `jinn.submission-bundle.v1`, `jinn.task-admission-receipt.v1`). This primitive consumes that
  contract; it does not define a rival eval-item format.

One sentence: **benchmarking-as-a-marketplace-service** — a consumer who has an eval question and
no fleet submits a set of task capsules and a config matrix, funds the run as an ordinary Curator,
diverse independent operators execute every cell, each capsule's committed evaluator judges each
attempt, and the consumer receives one frozen, anchored, re-derivable result matrix. Aggregation —
statistics, verdicts, leaderboards — is the consumer's, not the primitive's.

---

## 1. Product definition

### 1.1 The consumer

Anyone with the question **"which configuration is best at this?"** who does not run a fleet:

- **The custom-eval runner (primary archetype).** An engineer or organization with their own
  eval — their tasks, their scoring — who wants it executed across models/harnesses/loadouts they don't
  operate. Today they either rent one provider's eval infra (single-vendor, unverifiable) or
  build a bench farm (capital, ops). Here they bring an eval definition; the network supplies
  diverse execution and anchored, independently checkable results.
- **The Skill Factory (first programmatic consumer).** Its Block 3 composes this primitive:
  candidate-skill arms are just configs; its paired statistics are one consumer-side aggregation
  over the matrix.
- **A Curator A/B-ing their own SolverNet** — "does config X beat config Y on my task pool" is a
  degenerate run (§4.5 presets).
- **Future learning applications** (policy optimizers, model-adaptation apps, per the roadmap) —
  same shape: benchmark a derived artifact across environments.

Designing for the demanding archetype (custom evals) makes the programmatic consumers a subset,
not a second product.

### 1.2 Product promise

> Bring your eval — tasks tied to their judges — and a config matrix. The network executes every
> cell with independent operators, judges every attempt with your committed evaluator, and hands
> back a frozen result matrix anyone can re-derive your conclusions from. You never operate
> infrastructure, and nobody has to trust your summary — the matrix is the receipt.

### 1.3 What this primitive is NOT (boundary, binding)

- **Not skill-aware.** It knows nothing of skills, holdouts, baselines-as-concepts, promotion, or
  candidate verdicts. A "baseline" is merely a config with an empty loadout. The Skill Factory
  layers those meanings on top (its §4.2–4.4 wave/snapshot machinery becomes a consumer of this
  primitive once it exists).
- **Not an aggregation or statistics service.** It produces the judged matrix; consumers compute
  aggregates. Publishing an aggregate is the consumer's act, attributable to them.
- **Not a task factory.** Capsule supply is the consumer's problem (or the Task Creator ladder's,
  for pool-drawn presets). The primitive is supply-agnostic.
- **Not a leaderboard product.** Nothing here ranks models or operators; a leaderboard is one
  possible consumer.
- **Not new trust machinery.** Identity, anchoring, verdicts, envelopes, fees — all existing
  rails. The primitive adds orchestration and one artifact type.

### 1.4 Relationship to the Skill Factory design

The parent design's Block 2 decomposition assigned this primitive: config-diverse execution +
per-attempt judging, skill-agnostic. On approval of this document, the Skill Factory design's
wave-execution and snapshot machinery (§4.2 selection/holdout waves, §4.4 frozen snapshot) is
understood as **an instance of this primitive plus factory-side aggregation**; the factory doc
gains a one-line reference at its next amendment rather than duplicating this spec.

---

## 2. Requirements (consumer-first)

Functional requirements R1–R10; each names its owner in §4/§5.

- **R1 — Eval definition = capsules.** The consumer defines an eval as a set of task capsules:
  task + committed evaluator + environment requirement, per the capsule contract. Tasks and their
  judging are inseparable by schema (`capsule.evaluator.bundleCommitment`), which is the design
  decision made in the parent pass: the fully-custom consumer (own tasks + own judge) is the
  primary; pool-drawn tasks and existing evaluators are presets (§4.5), not modes.
- **R2 — Config matrix.** The consumer specifies the comparison: a list of configs (solve
  profile: harness + model; injected loadout: an artifact by CID+sha256 or none; environment
  overrides within the capsule's declared envelope) × replicates R. Every cell's config is
  task-pinned, machine-verifiable after the fact, and enforced by cell invalidation — never by
  trusting operators.
- **R3 — Fund as a Curator, with a ceiling.** Cost = cells × per-cell fees (solve + verdict) +
  the run's own overhead tasks (e.g. the optional matrix-validation task, §9.5), computable
  **before** launch. The consumer approves one budget;
  the run can never exceed it (the orchestrator stops posting; it does not overdraw).
- **R4 — Diverse independent execution.** Cells are ordinary marketplace tasks claimed by
  operators the consumer does not control. Diversity (operators, hosts) is the service; the
  matrix records who/what actually ran per cell.
- **R5 — Judging is the capsule's evaluator, run by the network's evaluator role.** Per-attempt
  verdicts are ordinary anchored verdicts. The consumer's judge is code the network executes —
  the consumer never scores their own run.
- **R6 — One frozen result matrix.** At run close, a single artifact fixes: the pre-registration
  echo, every cell key (capsule × config × replicate), each cell's attempt/verdict envelope refs,
  per-cell verification results, cost and latency, exclusions with reasons, attrition statistics,
  and a close boundary. Late enrichment cannot change it. Aggregation is consumer-side, over this
  matrix only.
- **R7 — Integrity metadata, per cell and per run.** Loadout verification (did the cell run the
  pinned artifact — sha256 against the envelope's executor/plugins), profile verification (did it
  run the pinned model/harness), isolation receipts, solver and evaluator identities (for
  consumer-side conflict exclusion), and the judge's **integrity tier** derived from its
  admission receipt (replay variance, declared capabilities — §3).
- **R8 — Legibility.** The run is pre-registered (capsule-set hash + config matrix + R + policy
  committed before any cell posts); every conclusion a consumer publishes is re-derivable by
  anyone from the anchored matrix; the matrix itself is verifiable bytes (hash-chained to
  anchored envelopes). PRINCIPLES → Legible is the reason this primitive exists at all.
- **R9 — Honest degradation.** Missing cells are reported missing, never imputed. A run below
  its pre-registered completeness floor closes as `partial` with per-arm attrition stated
  (asymmetric attrition flagged). Cancellation drains in-flight cells and still produces the
  matrix over what exists.
- **R10 — Judge-agnostic mechanism, judge-aware metadata.** The primitive never gates on judge
  *kind*. It executes whatever committed bundle the capsule declares, inside that capsule's
  declared capability envelope, and **records** the properties that determine result semantics
  (replay variance from the admission receipt; network capability; semantics version).
  "Deterministic-only" exists solely as the v0 *admission-policy default* (§6), not as a contract
  mode.

Non-functional: batch latency (hours-to-days; not interactive); v0 scale bounds stated in §6;
cost transparency per R3; no credential custody (capsules declare typed credential requirements;
the primitive never holds consumer secrets beyond the capsule design's evaluator-bundle
provisioning, whose limits that spec already states honestly).

---

## 3. The judge model (resolved, not decided)

The parent session's "deterministic vs LLM judge" fork dissolved on contact with the capsule
contract, and this document records the resolution as binding:

- The judge **is** the capsule's committed evaluator bundle. Evaluators stage a clean
  environment, inject the submission, and run the committed code. What a judge may touch is the
  capsule's declared capability envelope (`EnvironmentRequirementV1` includes network
  capability; the bundle declares its expected infrastructure capabilities) — enforced per
  capsule, not decided globally.
- Determinism is **measured, not declared**: the admission receipt already records repeated
  clean-replay scores and variance. From it the primitive derives a per-capsule **integrity
  tier** surfaced in every result row:
  - `re-derivable` — replay variance ≈ 0 and no network capability: anyone can recompute the
    verdict and must get the same answer; disputes are resolved by re-execution.
  - `attested-only` — nonzero replay variance or external capabilities (e.g. an LLM-judge
    bundle): the verdict is an honest attestation of one committed execution, checkable for
    process but not byte-reproducible.
- Consumers see the tier per cell and per capsule; nothing stops mixing tiers in one run, and
  nothing lets a summary silently launder `attested-only` results as re-derivable.

---

## 4. Contracts (conceptual, versioned)

Identities, lineage, and ownership binding; field lists refined at implementation. One new
published artifact type (§4.4); everything else reuses existing rails.

### 4.1 `BenchmarkRunV1` — the consumer's definition (pre-registered)

`{ runId, consumer (Curator identity), capsuleSet { capsuleDigests[], admissionReceiptRefs[],
setHash }, configs: ConfigV1[], replicates R, policy { completenessFloor, replacementPolicy
(bounded re-posts for infra-lapsed cells), eligibilityExclusions (operator addresses excluded
from claiming cells — consumer-supplied conflict list), cellWindow, selfEvaluation: false },
budget { perCellFees, hardCap }, preRegistrationHash (over all of the above, committed before
any cell posts) }`.

### 4.2 `ConfigV1` — one arm of the comparison

`{ configId, solveProfile { harness, harnessVersionOrDigest, model }, loadout: { kind:
'artifact', ref (CID), sha256 } | { kind: 'none' }, envOverrides? (within the capsule
envelope) }`. Notes: "baseline" is `loadout: none` — the primitive has no baseline concept; the
loadout is *any* artifact (a skill, a raw-evidence packet, a config file, a tool bundle) —
skill-ness is the consumer's interpretation; the mechanism is the loadout-injection engine
extension already specified in the Skill Factory design §4.5 (hash-verified, hermetic, per-task
mount; envelope-recorded), which this document adopts as a shared Core primitive.

### 4.3 Cell task

One posted marketplace task per (capsule × config × replicate): the capsule's solve task plus
context `{ runId, cellKey, configId, loadout ref+sha256, solveProfile }`. Ordinary claim →
solve → deliver → evaluate flow; the capsule's evaluator produces the cell verdict;
`allowSolverSelfEvaluation: false` always, testnet included (inherited decision). Replicates are
separate posts. Cells carry the consumer's eligibility exclusions; enforcement is the standing
two-layer reality — off-chain claim filtering plus matrix-side verification — and the matrix
records the solver identity of every cell so exclusion is *checkable*, not merely requested
(§7).

### 4.4 `jinn.bench-matrix.v1` — the result matrix (the one new artifact type)

`{ schemaVersion, runId, preRegistration (echoed verbatim + hash), closeBoundary (block/time),
cells [{ cellKey, capsuleDigest, configId, replicate, attemptEnvelopeCid, verdictEnvelopeRef,
outcome (judged | unscorable | expired | invalidated), verification { loadout: match|mismatch|
unverifiable, profile: match|mismatch|unverifiable, isolation: receiptRef }, judgeIntegrityTier
(re-derivable | attested-only), solverId, evaluatorId, cost { reported, source }, latencyMs }],
exclusions [{ cellKey, reason }], attrition { perConfig, perCapsule, asymmetryFlags },
completeness (achieved vs floor; runOutcome: complete | partial | cancelled), matrixHash }`.

Assembled deterministically by the run orchestrator at close; published and anchored on the
existing artifact rails. Anyone can re-derive it from the underlying anchored envelopes; the
factory's `jinn.skill-benchmark.v1` report becomes a consumer-computed derivative over exactly
this object.

### 4.5 Presets (sugar over C, not modes)

- *Pool-drawn tasks*: capsuleSet resolved from an existing SolverNet pool via its pool adapter
  (the degenerate capsule of §6) — "run the pool's tasks across my configs."
- *Existing judge*: capsules whose bundle commitment is an already-registered evaluator
  implementation — "score by the SolverNet's standard metric."
- *Pure sweep*: both presets at once — "A/B configs on this SolverNet."

---

## 5. Architecture: mapping onto existing rails

| Need | Existing rail | Net-new |
|---|---|---|
| Eval item (task + judge + env) | Capsule stack (2026-07-10 design; G1+ designed) | — |
| Cell posting, claims, fees | signed `task.v1`, claim policy, per-task escrow | — |
| Treatment per cell | Loadout-injection engine extension (skill-factory §4.5) | shared primitive (build once) |
| Judging | Evaluator role + committed bundles; verdict anchoring | — |
| Orchestration | Launched-record generator + durable phase ledger (skill-factory §4.1/§4.5; red-team N5) | **run orchestrator** — posts cells, tracks completeness, applies replacement policy, freezes and publishes the matrix; never holds a claim open across the run (red-team B1/N7 lesson: aggregation is generator-posted work after close, not a blocking evaluation job) |
| Result integrity | JCS envelope hashing, ERC-8004 anchors, sha256 acquisition | `jinn.bench-matrix.v1` (one artifact type) |
| Consumer intake | Curator config on a launched record (v0) | CLI verb to validate + price + launch a `BenchmarkRunV1` |

Placement follows the house pattern (in-repo, per `add-solver-type.md` precedent); the orchestrator
is a launched-record generator; no standalone package; no daemon-loop coupling.

---

## 6. v0 scope and staging

- **Degenerate capsule first.** v0 accepts the rebench-shaped implicit capsule (instance row as
  instruction; shipped Docker evaluator as the committed bundle, its impl digest + semantics
  version standing in for `bundleCommitment`; environment = the existing eval-runner contract)
  while the intake interface is written against `TaskCapsuleV1` — so the generalized stack (G1+)
  slots in without rewriting consumers. Stated plainly: full bring-your-own capsules arrive when
  the capsule stack ships; v0 proves the run/matrix machinery on the substrate that runs today.
- **v0 config axis:** model × injected loadout on a pinned harness; harness/host diversity joins
  when profile pinning is enforceable per cell (same mechanism, more fields verified).
- **v0 admission-policy default:** capsules whose bundles declare no network capability and show
  ~zero replay variance (`re-derivable` tier). `attested-only` capsules are schema-valid from day
  one and admitted when the policy knob opens — a policy change, not a redesign.
- **Staging ladder unchanged:** local adapter → Anvil fork → testnet SolverNet, byte-identical
  run/cell/matrix contracts across rungs, with the LocalAdapter parity caveat inherited from the
  parent design's red-team pass (B2): rung 1 proves orchestrator + matrix logic; the
  claim/evaluation transport is first fully proven at rung 2.
- **Parallelization:** this block builds alongside the Skill Factory's Block 1 (local distill
  loop); they share nothing until Block 3 composes them.

---

## 7. Adversarial floors (inherited, primitive-level)

These ride with the primitive regardless of consumer, restated from the Skill Factory red-team
pass as invariants of *any* run:

1. **Per-cell hermetic isolation** — the injected loadout exists only inside the cell's task
   workspace; nothing persists into operator homes; isolation receipts land in the matrix.
2. **Profile + loadout verification with cell invalidation** — trust nothing claimed; verify
   `executor` provenance post-hoc; mismatches become `invalidated` cells, never counted.
3. **Conflict data + exclusions** — the matrix always carries solver/evaluator identities; the
   run definition accepts an exclusion list; consumers computing comparisons are expected (and
   the factory is required) to exclude interested parties — the author-in-the-wave attack (A1)
   is mitigated by exclusion *plus* full authorship visibility, and the Sybil limit is disclosed
   (distinct ≠ independent) in the matrix itself.
4. **No self-evaluation, anywhere, including testnet** — explicit `false` on every cell.
5. **Network-off default envelope** for v0 cells and judges (the gold-fetch and injection
   surfaces from A5); capsules declaring wider capabilities wait on the policy knob.
6. **Claim-and-abandon handling** — bounded replacement re-posts + completeness floor + `partial`
   outcomes; denial becomes visible and priced, not silent.
7. **Consumer-supplied content is untrusted** — capsule admission (the receipt) is the gate;
   instructions and loadout artifacts are injection surfaces; the deterministic admission checks
   plus the envelope bound what they can do, and the residual is named, not hidden.

---

## 8. Acceptance (v0 gate)

> A consumer-authored `BenchmarkRunV1` (≥2 configs including one empty-loadout config, ≥6
> capsules, R≥2) executes end-to-end on the staging ladder's rung 1 with the identical contracts
> proven on rung 2: every cell claimed, solved, and judged by the capsule's committed evaluator;
> the run closes into one anchored `jinn.bench-matrix.v1` whose every row is traceable to
> anchored envelopes; verification/exclusion/attrition fields are populated and honest
> (including at least one deliberately induced invalidated cell and one expired cell in the
> test); and an independent party recomputes a consumer aggregate from the matrix alone,
> byte-agreeing with the consumer's published numbers.

Honest limits at v0, stated: operator distinctness ≠ independence; cost self-reported; capsule
generality gated on the G1+ stack; single-harness config axis until profile enforcement widens.

---

## 9. Open questions (deferred, tracked here)

1. **Pricing beyond flat delivery fees** — premium for scarce configs (rare hosts/models),
   evaluator pricing for heavy judges: deferred with the network's knowledge-pricing layer.
2. **Private/confidential evals** — capsules are public by construction; a confidential-eval
   tier (private tasks, private results) is out of scope until a confidential-execution design
   exists (the capsule spec already names this limit for hidden references).
3. **`attested-only` admission thresholds** — when the policy knob opens for LLM-judge bundles,
   what replay-variance and capability bounds apply.
4. **Preset resolution for pool-drawn capsule sets** — binding to pool adapters (supply kinds,
   exhaustion) once the Skill Factory's pool-adapter contract lands.
5. **Result-matrix validation task** — whether a marketplace task independently recomputing the
   matrix (the factory's protocol-validation pattern) becomes a standard optional stage of every
   run or stays consumer-side.

---

## Appendix A — Decision log (this pass)

1. **Consumer archetype C — bring tasks *and* judge** ("tasks and the evaluation of them are
   tied"): chosen; A (own tasks/standard judge), B (own judge/existing tasks), D (pure sweep)
   demoted to presets over one contract. Grounding: the tie is reified in the substrate
   (`capsule.evaluator.bundleCommitment`).
2. **Input contract = the capsule stack, adopted not reinvented.** Block 2 consumes
   `jinn.task-capsule.v1` + `jinn.evaluator-bundle.v1`; v0 runs on the degenerate rebench-shaped
   capsule while the interface targets the general shape.
3. **Judge fork dissolved.** No deterministic-vs-LLM mode: judge = committed bundle executed in
   its declared envelope; determinism measured at admission (replay variance); integrity tier
   (`re-derivable` | `attested-only`) recorded per result row. "Deterministic-only" survives only
   as the v0 admission-policy default.
4. **Net-new surface fixed at four:** config matrix, frozen result matrix
   (`jinn.bench-matrix.v1`), consumer intake/funding, degenerate-capsule staging — plus the
   shared loadout-injection primitive and the inherited adversarial floors.
5. **Aggregation is consumer-side, permanently.** The primitive's output is the matrix; every
   verdict-like meaning (pass, promotion, ranking) belongs to a consumer and is re-derivable by
   anyone from the matrix.
