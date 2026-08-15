# Policy Optimization Product — Design

- **Date:** 2026-08-03
- **Version:** 0.1
- **Status:** draft — written in-session; pending architecture review, standards/adversarial
  review, and operator approval
- **Shape:** `design`
- **Scope:** a tier-4 product that maintains a population of identifiable policies for a task
  family, allocates evaluation to them through ordinary Tasks and the benchmarking records,
  accepts candidates from independent proposers, and gives adopters evidence to decide with.
  Includes: the campaign model, evaluation-wave and promotion discipline, the proposer
  contract, the learner migration, adoption, v0 venue and companion work items, economics
  posture, seams, supersessions.
- **Out of scope:** policy identity, the candidate manifest, the outcomes projection, and
  fidelity semantics — owned by the companion substrate design
  ([`2026-08-03-policy-identity-and-outcomes-design.md`](./2026-08-03-policy-identity-and-outcomes-design.md));
  protocol, record, trust, or marketplace-contract changes (none are made); the skill
  factory's retained scope (§15.2).
- **Depends on:** the substrate design; the benchmarking records and capabilities
  ([design](./2026-07-28-benchmarking-application-design.md), implemented under
  `packages/benchmarking/`); the local execution backend; evidence retrieval; task-supply
  (`task-curation` in particular).

## 1. Problem statement

Jinn's learning capability is trapped in one plugin that silently mutates its own state
between runs. The shipped learner conflates four authorities — running the policy, judging
it, changing it, and adopting the change — inside one mutable directory; its only shipped
improvement discipline is single-lineage hill-climbing with statistical revert (L1), and the
2026-05-28 architecture's own empirical finding (the promoter occupancy gap: tier-0
markdown edits only, across every observed learning run) shows a single greedy lineage
under-explores the policy space it was built to search.

Meanwhile the stack this branch built is a complete evaluation machine with no operator:
`benchmarking-run`, `benchmarking-aggregate` (seven implemented methods),
`evidence-retrieval`, `task-curation`, and the rest of task-supply have **zero dependents
outside their own subtrees**. Curation's README names "a tier-4 product" as the required
supplier of its adapter; the Phase C capability-boundaries spec (ratified 2026-08-03)
assigns task curation's first real adapter to a tier-4 consumer. The seams are built and
waiting.

Outside, the auto-harness wave (Meta-Harness, HarnessForge, Harbor-scale rollouts) has made
cheap autonomous harness optimization real — 24 hours of unsupervised search now beats
hand-engineered leaderboard entries — and every project in that wave grades its own
homework. Auto-optimized results are precisely the ones that cannot be taken at face value:
maximal exposure to Goodharting, contamination, and selective reporting, in a
single-trust-domain stack with no verification story. The demand for "how strangers believe
each other's policy improvements" is being generated faster than anyone is supplying it.

This product is Jinn's supply: the first host for the stack, and the first place its trust
properties — exactness, attributability, observability, replaceability — are the
load-bearing feature rather than background hygiene.

## 2. Position in the architecture

One tier-4 product package: `packages/policy-optimization`
(`@jinn-network/policy-optimization`), classification `product`, release group
`transitional-or-private`, publication disabled, catalog authority pointing at this
document. Per the tier rules it may depend on anything; nothing in tiers 1–3 may reference
it, and no tier-1–3 kit, guard, or fixture does. The catalog amendment is twofold: the
substrate's new `experimental-policy` release group is added, **and** this product's
release group's allowed dependency groups are amended to include it — otherwise
product→substrate imports fail the catalog gate.

This is the plugin roadmap's named **Stage 4 slot** ("Agent policy network": the unit of
learning expands from an individual skill to the complete agent configuration). That
roadmap's architectural rule is this product's tier boundary restated: *the plugin consumes
and applies network learning; it does not need to contain every process that produces it* —
and "Jinn Core does not need to become a skill factory, policy optimizer, or model trainer."
This product is where the policy optimizer lives instead.

It is deliberately the **first host** of seven previously-unconsumed packages. That makes it
the integration test the stack has been waiting for, and integration findings (the
task-posting F-C5-8 precedent) are expected product work, surfaced with dispositions per the
designs-are-law rule — never silently patched into tier-3 packages.

## 3. Standards audit

The substrate design audits identity standards. At the product layer:

| Candidate | What it owns | Disposition |
| --- | --- | --- |
| **DSPy / GEPA** | Reflective candidate generation over execution traces; maintains its own Pareto pool; 35× fewer rollouts than RL baselines | **Adopt as a proposer class.** GEPA's premise — traces beat scalar rewards as learning signal — is exactly what Evidence supplies. Never protocol: no `optimizerType` enum anywhere |
| **Inspect (UK AISI)** | How one party runs an eval; EvalLog; the credible-evaluator ecosystem's viewer | **Inherited via benchmarking-interop** (import / execute / export). This product builds no viewer |
| **Harbor (Terminal-Bench)** | Agent-in-container rollouts at cloud scale; RL/SFT interfaces | **Named future seam:** a Harbor executor launcher beside claude-code/codex/hermes, wrapping the evidence and verdict records Harbor does not produce. Not v0 |
| **Environments Hub / verifiers (Prime Intellect)** | Installable verified-reward RL environments; an active environment vendor market | **Named future seam, task-supply side:** import as Benchmarks; export Jinn-verified environments into that market. Not v0 |
| **RFT services (OpenAI, Bedrock)** | Weights-level optimization as a metered API (dataset + programmable grader in, checkpoint out) | **Adopt as a future proposer class:** an RFT job is one more proposer whose candidate pins a model artifact. Never in-product training |
| **Ax/BoTorch, Optuna, evolutionary libraries** | Search/allocation algorithms | **Library choices inside proposers or the allocator** — implementation detail, never interface |

**The differentiation, owned here:** every framework above assumes a single trust domain —
one party optimizes, evaluates, logs, promotes, and believes its own numbers. This product
is the adversarial-setting transpose: content-addressed policies instead of registry names,
sealed preregistered Runs instead of dashboard experiments, per-axis fidelity disclosure
instead of trusting one's own harness, signed recomputable Reports instead of leaderboard
claims, market-executable work instead of one budget, local adoption instead of a promotion
button. Existing frameworks standardize how one party improves a policy; this product
standardizes how strangers believe, fund, and trade policy improvements.

## 4. The model

> "If the task that goes into the marketplace is 'create this policy' — what is it that we're
> actually evaluating?"

That question is this design's spine, and its answer is the product's one invariant:

**Tasks evaluate work. Policies are evaluated by aggregating the evaluations of ordinary
work performed under them. Candidate generation is decentralized. Adoption is local.**

- The unit of evidence is unchanged and clean: one Task, one policy tuple, one result, one
  evaluation. Nothing in this product adds a group verdict, a policy score record, or a
  "produce a better policy" task whose evaluator secretly swallows a benchmark campaign.
- A policy's value is a *derived, attributable interpretation* — a benchmarking Report over
  Matrices, or a consumer-filtered read of the outcomes projection — never a fact a
  proposer, or this product, can assert.
- Anyone may propose a candidate, by any method (the shipped learner, GEPA, distillation,
  a human, an RFT job). The product never knows or encodes the method.
- The campaign recommends; every operator decides adoption against their own thresholds.
  There is no network-level "current best policy."

Generalized policy iteration, with the stack as the instrument: policy evaluation is
benchmarking + the outcomes projection; policy improvement is whatever proposers do; this
product is the loop that alternates them under a budget.

## 5. Campaigns

### 5.1 The campaign document

A campaign fixes *what is being optimized, what counts as better, and the budget* — never
how candidates are made. It is an immutable, sealed product document (JCS-once, sha256,
format token `network.jinn.policy-optimization.campaign/1.0` — a product convention, not a
record kind):

| Field | Content |
| --- | --- |
| `target` | `taskProfile`; `developmentBenchmark` (Benchmark record digest); `promotionBenchmark` (**committed** Benchmark record digest, §6.3); optional `trainingEvidence` (saved-query reference for proposer input). *(Amended 2026-08-03, C7b review M4: the development and promotion Benchmarks must be **item-disjoint** — item digests are public even on a committed record, so the check runs at sealing and at `EXPLORING`-entry without any reveal; a promotion gate sharing items with the dev slate is contaminated item-by-item by every dev wave.)* |
| `seeds[]` | initial policy tuples or candidate-manifest digests |
| `mutationSurface` | which tuple axes candidates may vary; **v0: `["loadout"]`** — harness and model frozen per campaign, isolation excluded as vacuous |
| `frozenAxes` | **explicit byte-exact values for every non-mutable axis.** All seeds and every admitted candidate MUST byte-share these values — checked at campaign sealing (seeds that disagree make the document invalid) and again at admission (§7.3). Frozen and mutable axes are exact pins, never constraint-shaped values (substrate §4.1 rule 4) |
| `objective` | `methods[]`: benchmarking method-registry references (`{id, version, parameters}`) + `constraints[]` (protected measurements that must not regress) — never a method implemented privately |
| `budgets` | proposal, evaluation, hard cap |
| `allocation` | dev-wave allocation policy reference + parameters (§6.2) |
| `stoppingRule` | mandatory; exploration cannot run open-ended |

### 5.2 State and lifecycle

Campaign state is an **append-only product journal** (created / candidate-admitted /
candidate-rejected / wave-planned / allocation-decided / run-sealed / matrix-assembled /
report-recorded / frontier-updated / promotion-run-sealed / closed), host-persisted.
Authoritative *facts* live in the referenced sealed records; the journal itself is the
**non-derivable ordering of product decisions** — admissions, allocations, wave boundaries
— which cannot be reconstructed from records and is exactly what it exists to preserve. It
is not network truth. Benchmarking deliberately keeps no run journal; the adaptive outer
process owns its own resumption state, here.

Lifecycle: `DRAFT → EXPLORING → CONFIRMING → CLOSED`. The transition into `EXPLORING` is
legal only if `promotionBenchmark` references a sealed *committed* Benchmark (§6.3).
`CONFIRMING` admits exactly one promotion Run. `CLOSED` publishes outputs (§8.3) and stops
spending.

## 6. Evaluation waves and the promotion discipline

### 6.1 A wave is a sealed Run

Every evaluation wave is one preregistered benchmarking Run: arms = policy tuples expressed
as Submission run pinning per the substrate's expression rule (a candidate's loadout digest
pinned via `loadout`; every arm pinned byte-identically to the campaign's `frozenAxes`
values), cells dispatched through the injected backend,
Matrix assembled and verified, Reports produced through the method registry. This product
adds **no execution, assembly, or aggregation machinery** — re-implementing any of it is
forbidden duplication. New statistics a campaign needs (e.g. a bandit posterior) land as
named methods in the benchmarking registry with reference implementations, so policy-value
estimates stay third-party recomputable.

An adaptive campaign is therefore a *sequence of fixed Runs*: candidates arriving mid-wave
wait for the next wave; a sealed Run is never amended.

### 6.2 Dev-wave allocation

Between waves the allocator decides which candidates get how many cells next, using: prior
wave Reports, the outcomes projection (organic bucket), and task informativeness from the
curation projection (saturated tasks discriminate nothing). Informativeness-weighted
sampling and early candidate pruning are **legal at dev waves and illegal at promotion** —
the optional-stopping hazard is confined to exploration. But confinement is not immunity:
allocation inputs include the manipulable organic bucket, so poisoned signal can prune the
genuinely best candidate before promotion — a **wrong recommendation**, not merely wasted
budget; the promotion *claim* itself never rests on allocation. Every pruning decision is
journaled with the rows and Reports it consumed, so survivorship is post-hoc auditable.
Dev-wave Reports are labeled exploratory by
construction (their `preregistered` flag reflects exactly what was in the Run's analysis
plan and nothing else).

### 6.3 Promotion

- `promotionBenchmark` is a **committed (reveal-later) Benchmark record**, sealed before the
  campaign enters `EXPLORING`, **unrevealed at `EXPLORING`-entry** (a previously revealed
  committed Benchmark is contaminated and inadmissible as a promotion gate), revealed only
  at `CONFIRMING`, and **single-use per campaign**.
- The promotion Run is preregistered with the campaign's objective methods in its
  `analysisPlan`, flat sampling per plan (no informativeness weighting), executed once.
- The held-out discipline is inherited, not designed: proposer evidence bundles MUST pass
  the capability-eval exclusion on **instance and repo**; generated policy bodies MUST pass
  the lexical scan; the freeze order (corpus before slate draw) applies. The committed
  Benchmark record is the **single go-forward representation** of a held-out boundary,
  subsuming the earlier slate-artifact representation for this product's purposes.
- **Owner-equals-proposer residual, named:** the exclusion and lexical scans against a
  *committed* benchmark can be run pre-reveal only by whoever holds the secret bytes — the
  campaign owner — and proposer inputs (a human's, a learner's) are ultimately
  unobservable. In v0 the owner and the proposer are typically the same operator, so
  owner-side contamination of the promotion set is not ruled out by mechanism. The named
  check that bounds it: **post-reveal, third parties re-run the held-out exclusion
  (instance + repo) and the lexical scan** against the revealed items and every candidate's
  evidence bundle and policy body. Campaigns whose recommendation is meant to carry
  cross-operator weight SHOULD have the promotion Benchmark authored by a party distinct
  from the campaign owner.
- The campaign's promotion output is a signed Report plus a recommendation entry in the
  journal — never an activation. §9 owns what operators do with it.

## 7. Candidates and proposers

### 7.1 The proposer contract

Product-local interface; implementations are operator-chosen and invisible to the campaign:

```
PolicyProposer.propose({
  parents:          typed references (substrate §5.1: {kind: "candidate"|"tuple", digest}),
  evidence:         frozen evidence bundle reference (held-out-excluded),
  objective:        the campaign's objective (informational),
  mutationSurface:  the axes this campaign permits,
  budget:           proposal budget
}) → CandidateManifest[]
```

### 7.2 v0 proposers — two, deliberately

1. **The learner, in candidate mode** (§10): the shipped Debrief→Improve→Consolidate
   machinery pointed at a candidate workspace, emitting a `jinn.harness-state.v1` candidate
   instead of mutating the live directory.
2. **A deliberately-dumb reference proposer** (deterministic skill ablation / recombination
   over the parent loadout). Its purpose is architectural falsification: if the campaign
   engine cannot accept a second proposer without modification, replaceability was
   decorative. It is the falsifier, not a baseline anyone should beat.

GEPA-class, distillation (the factory's retained scope, §15.2), human-authored, and
RFT-backed proposers plug in later through the same contract.

### 7.3 Admission

A candidate enters the population when: manifest validates (substrate §5.3); the policy
materializes digest-correct through the provisioner; the tuple byte-shares the campaign's
`frozenAxes` and mutates only within `mutationSurface`; the held-out lexical scan passes;
an optional smoke canary (small dev subset) completes. Admission asserts *usable*, never
*better*.

Two consequences, stated:

- **Population membership is keyed by `tupleDigest`.** A second manifest proposing an
  already-admitted tuple joins the existing arm rather than minting a duplicate; execution
  attribution goes to the first-admitted manifest, and later manifests are journaled
  against the same arm (load-bearing for any future paid-proposal economics).
- **Admitting a candidate whose payload includes hooks, tool configs, or harness code is
  code-execution consent** (§7.4) — the smoke canary and every subsequent cell *run* the
  payload. For cross-operator candidates, those payload classes require explicit owner
  approval at admission, not merely at adoption.

### 7.4 The transfer security gradient

Adopting a stranger's candidate is installing their code. Payload classes carry escalating
risk — prompts < skills (injection surface) < hooks/tool configs (arbitrary code execution)
< harness forks (their runtime) — so:

- cross-operator candidates require the DSSE-signed manifest (substrate §5.2);
- adoption gates (§9) distinguish payload classes within one bundle;
- **evaluating a candidate executes it — and that is not safe today.** With `unrestricted`
  the only isolation policy any launcher supports, the §7.3 smoke canary and every dev cell
  run the candidate's payload with the campaign owner's user privileges. The per-attempt
  directory contract (ephemeral harness-state, wiped secrets — on backends that declare
  it) bounds persistence and credential exposure; it does **not** bound execution,
  exfiltration, or lateral movement. Evaluating hook-, tool-config-, or harness-code-
  bearing candidates from strangers is therefore code-execution consent given at admission
  (§7.3), and safe evaluation of hostile candidates is **gated on a future meaningful
  isolation tier** — this design does not pretend the current contract provides it. v0's
  closed-proposer setup (own learner + own reference proposer) is what bounds the exposure
  in practice.

## 8. Signal: experimental and observational

### 8.1 Two kinds of evidence, kept distinct

Benchmark waves are experiments: preregistered, controlled, comparable. The outcomes
projection's `organic` bucket is observation: operator-selected tasks, no controlled arms,
selection bias everywhere. The product uses observation for cheap direction (which
candidates look interesting, which lineages are drifting) and experiments for every claim
that reaches a Report or a recommendation. The bucket split makes it impossible to launder
one into the other.

### 8.2 The adapters this product owes the stack

This product implements, as product code with injected ports:

1. **The curation adapter** — the seven joins curation's README documents, fail-closed
   conflict policy — discharging the tier-4 obligation the Phase C boundaries spec assigned.
2. **The policy-outcomes adapter** — the same joins plus tuple resolution from Submission
   requirements and per-axis status from available fidelity evidence (substrate §6.3).

Both remain product-internal until a second consumer justifies extraction into discovery
facts (the recorded curation rule).

### 8.3 The archive

A derived, local projection over candidate manifests + Reports + projection rows: lineage
graph (typed parents), per-policy evaluated history, frontier membership (quality / cost /
latency non-dominated set — a *set*, deliberately not a leaderboard). Re-derivable; never
authoritative; never published as a ranking. Adoption state rides alongside as locally
recorded operator decisions — the one part of the archive that is *not* re-derivable, and
is labeled as such.

## 9. Adoption

Adoption is an operator-local decision with product support: `adopt` (pin the tuple for a
task route), `fork`, `rollback` (the freeze-fence and L1 revert machinery remain the safety
net under any adopted policy). Adoption gates are per payload class (§7.4): an operator may
auto-adopt prompt-only candidates on a passing canary while requiring manual review for
hook-bearing ones. Cross-operator adoption additionally requires signed manifests and rides
the checkpoint train (#2117–#2120) for byte transport. The product ships defaults;
operators own thresholds.

## 10. Learner migration

The learner's four bundled authorities separate; the plugin survives as a proposer.

- **Candidate mode:** Improve (§8) and Consolidate (§9) write to a provisioned candidate
  workspace and emit a sealed candidate manifest + `jinn.harness-state.v1` loadout; the
  active `implStateDir` is never touched mid-run. The existing per-mutation
  `promotion_record`s become `declaredChanges` input. Orient→Execute is unchanged — it is
  the policy being evaluated, not the proposer.
- **Freeze-fence and codeDigest stay** exactly as shipped; the substrate's fork-healing
  makes the fence's identity and the pinning identity one scheme.
- **`LearnerHarness.supports()` stops defaulting to everything.** The
  wrap-every-SolverType posture (self-documented architectural debt) collides with
  controlled arms; routing becomes explicit per task profile.
- **Inline self-mutation** (the current train-mode behavior) survives as a compatibility
  mode with a deprecation note, and is retired once the first campaign completes
  end-to-end; campaign evaluation never depends on it. Operators who want fast local
  adaptation get it back as *provisional self-adoption of own candidates with rollback* —
  the same cadence, with an identity boundary.

## 11. v0 venue and companion work items

**v0 campaigns execute on the local backend**, over swe-rebench-shaped Benchmarks, mutation
surface `loadout` only. Rationale: the local venue is the only place pins are *enforced*,
so v0 is the only configuration in which a per-axis `match` — and therefore a verified
policy comparison, the product's central claim — is honestly makeable (on the three
enforced axes; isolation "matches" by vacuity, per the substrate's weakest-axis rule).
Marketplace participation in v0 is **read-only**: the §8.2 adapters consume announced
verdicts; no marketplace-funded proposal or evaluation work.

**v0 honesty residuals (the benchmarking §12.2 discipline, restated rather than
inherited silently):** on the local venue, pre-registration ordering carries no guarantee
against the run's own owner. A v0 owner can rehearse privately, construct the "committed"
promotion Benchmark after seeing dev results, retro-write a host-local journal, choose
which waves become Reports, and best-of-N whole campaigns — invisibly. v0 promotion
discipline is therefore *discipline*: it protects an honest owner from self-deception and
proves nothing to strangers. Stranger-credible campaigns require anchored-venue execution
(deferred, §13), where the named check is: **the promotion Benchmark's
announcement/anchor precedes the earliest dev-wave cell anchor**, and post-reveal third
parties re-run the §6.3 exclusion and lexical scans. The §3 differentiation statement is a
statement about the architecture's ceiling; v0 reaches the fidelity half of it, not yet
the stranger-credibility half.

Companion work items this design declares (implementation homes, not designs):

1. **Local-venue benchmarking assembly ports** — the local counterpart of
   `marketplaceAssemblyPorts` (`InputScope`, `CloseBoundaryResolver`, `TrustResolver`,
   `PinningObservationPort`, `AdmissionEvidencePort`); home: a `benchmarking-local` ports
   package or `benchmarking-run` testing-adjacent module, per the implementation plan.
2. **The local `PinningObservationPort` bridge** — admission-gate results + Runtime
   Observations → per-axis status (substrate §7); the single highest-leverage fidelity
   producer.
3. **Launcher loadout-inventory support for `jinn.harness-state.v1`.**
4. **The #2117–#2120 checkpoint train** — pre-existing, ratified; blocks cross-operator
   distribution only, not v0.

## 12. Economics

v0 has **no payments at all** — the local venue has no settlement, and marketplace
participation is read-only. When marketplace execution arrives: ordinary per-Task
settlement only — target work paid as target work; proposers run on their own account; no
payment for proposals, no bonus pools, no challenge settlement.

One asymmetry recorded now because it shapes any future intake: admission costs the
*owner* (fetch, materialize, canary) while proposing is free, so the §7.3 gate alone
cannot price out junk — **open proposal intake requires a rate or stake gate before it
exists**, whatever form that takes.

Deferred, each with its graduation trigger recorded:

- **Paid proposal work** (a task profile whose evaluator checks admission criteria) — when
  a campaign owner wants to commission strangers and admission gates are demonstrably
  expensive enough to price out junk candidates.
- **Cross-candidate bonus pools / tournament settlement** — product-owned escrow first;
  a venue-level primitive only on demonstrated need, and any venue change is a governed
  surface requiring its own DR and human review (platform architecture §8.2).

## 13. Seams

- **Inspect** — inherited whole from benchmarking-interop; this product renders nothing
  Inspect's viewer can render.
- **Harbor** — future executor launcher (agent-image rollouts as cells), OCI digest as the
  harness-axis identity; declared, not scheduled.
- **Environments Hub** — future task-supply import/export; declared, not scheduled.
- **RFT services** — future proposer class; declared, not scheduled.

## 14. Non-goals

- No in-house optimization algorithms beyond the dumb reference proposer. No `optimizerType`
  anywhere in any interface.
- No eval viewer, no experiment dashboard, no leaderboard, and no ranking record — a
  frontier is a set; editorial collections of Reports are someone else's product.
- No skill format, no prompt format, no harness config format — payloads are SKILL.md and
  friends.
- No protocol, record-kind, trust, discovery, or marketplace-contract changes. No group
  verdict. No policy-score record.
- No online per-step RL, no PRM, no weight training in-product (RFT is an external proposer).
- No network-level policy promotion or "current best" designation, ever — that is a
  monoculture machine and an attack surface.
- No marketplace execution of campaign cells in v0 (read-only signal consumption only).
- No multi-domain campaigns in v0 (swe-rebench-shaped repository work only; the second
  domain is the generalization test, not the first deliverable).

## 15. Impact and supersessions

### 15.1 Superseded outright

- **`spec/2026-06-10-learning-approach-solvernet.md`** — same product intent (population of
  content-addressed policies, independent proposers, evaluation through ordinary tasks) in
  dissolved SolverNet vocabulary, never implemented. Harvested: the bundle-as-smallest-
  complete-policy argument (→ the tuple), the novelty-vs-quality split (→ admission vs
  promotion), its auto-A/B open question (→ §6). Disposition: superseded-by header pointing
  here.

### 15.2 Superseded in part — the skill factory's outer loop

The skill-factory lineage (2026-07-16 v1.0; 2026-07-30 MVP pivot) loses its optimization
outer loop — population, Pareto pool, wave evaluation, promotion — to this product, exactly
as it earlier lost its Block 2 to the benchmarking application (that design's §17.1
precedent). The factory **retains** what it does uniquely: skill-shaped candidate
generation (distillation; the GEPA inner loop as a fast local pre-filter) and skill product
packaging (badges, cards, publication posture). Under this design the factory is a
proposer plus a Report consumer. Disposition: an amendment note on the factory documents
when they next land on an integration lineage; recorded here first per designs-are-law.

### 15.3 Composed, with sections superseded

- **`spec/2026-05-28-harness-as-policy-learning-architecture.md`** — per-section
  disposition, since the L2+ material is interleaved: **kept** — §1 (harness-is-policy),
  §1.1 (self/cross-operator retrieval collapse), §2 (the occupancy gap — this design's
  empirical justification), §7 (what is not engineering). **Superseded** — §3's L2–L5
  roadmap (the ladder table and §3.1's `jinn ablate` mechanism): the campaign engine with
  a policy population is the ladder's escape from single-lineage L1 by a different route.
  **Composed via other owners** — §4 (the held-out exam measurement floor: promoted
  through capability-eval, §15.4). **Historical context, neither binding nor superseded**
  — §0, §5, §6, §9. §8's four open questions transfer to §16 in full.

### 15.4 Composed unchanged

Benchmarking design and packages (this product is the §17.4-anticipated consumer);
capability-eval v0 (its boundary becomes the committed promotion Benchmark; "not
superseded; promoted" carries forward); the impl-state-sharing spike; the 2026-05-06
train/frozen substrate; graded-verdict signal designs; the plugin roadmap Stage 4 framing;
the Phase C capability boundaries (whose curation-adapter assignment §8.2 discharges).

### 15.5 Pointer updates on approval

`docs/learning-engine.md:9` — the "ratified L0–L5 ladder" wording is corrected there (the
DRs are ratified; the 05-28 spec is `proposed`) and the SWE-side authority pointer adds
this design; `.claude/skills/learning-engine/SKILL.md:21` — the "canonical roadmap"
wording likewise updated to point here. Both flagged by lane research; fixed in the same
commit that lands these specs.

## 16. Open questions carried

From 05-28 §8, all four transfer: multi-operator publish-vs-hoard dynamics once policies
have market value; window-pressure feasibility of higher-tier mutations; learner
attestation in a manifest (partially answered here — the DSSE-signed candidate manifest is
that surface's successor); the `harvest.ts` SolverType-awareness layering violation
(carried as implementation debt into the §10 migration, not silently dropped). New: when
the second domain arrives, does the tuple need a domain axis or is the task profile
sufficient context; whether dev-wave allocation methods themselves belong in the method
registry (currently: no — allocation is product policy, only *estimates* must be
recomputable).

## 17. Provenance

Same session and method as the substrate design (its §11): two research lanes, six operator
decisions, live standards research, the corrected-hypothesis lineage from the prior
optimizer conversation. The occupancy-gap and zero-host findings that anchor §1 are lane
findings verified against the tree at PR #2363's head. Written form reviewed by an
architecture review and a standards/adversarial review before presentation; dispositions
in Appendix A.

## Appendix A — Review disposition (2026-08-03)

Two independent reviews ran on the written form; all findings touching this document were
resolved in-text before presentation:

- **Blockers.** The safety claim "evaluating a hostile candidate is made safe by the
  isolation contract" was false with isolation vacuous (the canary *is* the code
  execution): §7.4 inverted — evaluation executes the payload; admission of hook/tool/
  harness-code payloads is code-execution consent, moved up to admission for
  cross-operator candidates (§7.3); safe hostile evaluation gated on a future isolation
  tier. The campaign's frozen-axis values were declared nowhere, making the
  mutation-surface check uncomputable: `frozenAxes` added to the campaign document with
  sealing- and admission-time checks (§5.1, §6.1, §7.3).
- **Majors.** The local-venue trust posture overclaimed by omission: §11 gained the
  honesty-residuals paragraph (v0 discipline proves nothing to strangers; the
  anchored-venue named check pins promotion-Benchmark anchor before the earliest dev-cell
  anchor). "Worst effect is wasted budget" overclaimed: §6.2 restated — poisoned
  allocation yields a wrong recommendation; pruning decisions journaled for survivorship
  audit. Owner-equals-proposer contamination of the promotion set named as a residual with
  a post-reveal third-party re-check and a distinct-authorship recommendation (§6.3). The
  05-28 partial supersession enumerated per section, and its two silently-dropped open
  questions restored (§15.3, §16).
- **Minors.** Promotion Benchmark must be unrevealed at `EXPLORING`-entry (§6.3);
  population membership keyed by `tupleDigest` with a first-admitted attribution rule
  (§7.3); the journal's non-derivability stated precisely and adoption state removed from
  the re-derivable claim (§5.2, §8.3); v0 has no payments and open intake needs a
  rate/stake gate (§12); "match by vacuity" on isolation named (§11); pointer-update file
  attributions corrected (§15.5); the catalog's allowed-deps amendment named (§2); typed
  parent references adopted from the substrate (§7.1).
