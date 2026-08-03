# @jinn-network/policy-optimization

The Policy Optimization product: a tier-4 package that maintains a population of identifiable
policies for a task family, allocates evaluation to them through ordinary Tasks and the
benchmarking records, accepts candidates from independent proposers, and gives adopters evidence
to decide with.

**Authority:**
[`docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md`](../../docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md).
Program:
[`docs/superpowers/plans/2026-08-03-policy-optimization-implementation-program.md`](../../docs/superpowers/plans/2026-08-03-policy-optimization-implementation-program.md).

Publication is disabled. Nothing in tiers 1–3 may reference this package, and nothing does.

## What is here now

Sub-units **C7a — the core state layer** and **C7b — the wave engine**:

| Surface | Design section | What it is |
| --- | --- | --- |
| The campaign document | §5.1 | A sealed product-convention document (JCS-once, sha256, format token `network.jinn.policy-optimization.campaign/1.0`) fixing *what is being optimized, what counts as better, and the budget*. Not a record kind. |
| The campaign journal | §5.2 | A host-persisted, append-only ordering of product decisions, with restart recovery and idempotent replay. Not network truth. |
| Arms | §6.1 | Admitted candidates' tuples expressed as Submission run pinning through the substrate's expression rule, byte-identical on the campaign's `frozenAxes`. |
| Wave planning | §6.1 | Campaign + candidates + allocation → one sealed benchmarking Run, its Benchmark, its cell count, its budget check, its stopping-rule check. |
| Wave execution and assembly | §6.1 | Dispatch through the injected `TaskExecutionBackend`, then a Matrix assembled over the local venue's ports with per-axis treatment-fidelity verification. |
| The dev-wave allocator | §6.2 | A pure decision function: rows and Reports in, a journaled decision out. Three v0 policies. |
| Promotion | §6.3 | One preregistered Run against the revealed committed Benchmark, flat, once. |

Admission and proposers (C7c) and the archive and CLI (C7d) build on these types. This package
implements **no execution, assembly, or aggregation machinery** — re-implementing any of it is
forbidden duplication (§6.1), and statistics reach this product only as `benchmarking-aggregate`
method-registry references (program ruling R3). The source-boundary guard enforces both.

## The campaign document

```
formatToken       network.jinn.policy-optimization.campaign/1.0
target            taskProfile; developmentBenchmark; promotionBenchmark (committed, §6.3);
                  trainingEvidence? (saved-query digest)
seeds[]           typed references {kind: "candidate" | "tuple", digest} (substrate §5.1)
mutationSurface   which axes candidates may vary. v0: ["loadout"], validated
frozenAxes        byte-exact values for every non-mutable axis; exact pins, never constraint-shaped
objective         methods[]: {id, version, parameters} registry references; constraints[]
budgets           proposal {maxProposals}; evaluation {maxCells}; hardCap {maxCells}
allocation        {policyRef, parameters} — product policy, not a registry method
stoppingRule      {ruleRef, parameters} — mandatory; exploration cannot run open-ended
```

Namespaced (reverse-DNS or absolute-URI) top-level extension keys are preserved; an unrecognized
non-namespaced field is refused, exactly as the candidate manifest does (substrate §5.3).

### The sealing-time check

§5.1 requires that "all seeds and every admitted candidate MUST byte-share these values — checked
at campaign sealing (seeds that disagree make the document invalid)". The document carries seed
*digests*, so that check is uncomputable from the document alone. `sealCampaign` therefore takes
the seed referents beside the document and **verifies each against its digest** before comparing
axes: a tuple is re-digested, a candidate manifest is parsed exactly and re-digested, and only then
is its `policy` compared byte-for-byte against `frozenAxes`. Handing over the wrong referent under
the right digest is refused, not trusted.

Three things are checked per seed, and the third is the one that is easy to miss:

1. every axis in `frozenAxes` is carried by the seed and byte-shares the campaign's value;
2. every axis in `mutationSurface` carries an exact pin;
3. **every remaining member of the tuple, `formatToken` aside, is refused** — an axis the campaign
   neither freezes nor mutates is checked by nothing.

(3) matters because a tuple carries more than the four core axes: substrate §4.1 step 2 admits
every profile-declared `requirementKey` present in the effective requirements, so a
`repository-work/1.0` seed carries `effort`. Without the refusal, two seeds differing only on
`effort` seal cleanly and are then compared as though they shared a treatment — the same
uncomputable-check hole §5.1's `frozenAxes` exists to close, one axis over. §5.1 says frozen axes
are "every non-mutable axis", not "every non-mutable *core* axis", so `frozenAxes` accepts a
declared axis and the refusal offers both resolutions: freeze it, or make it mutable.

`checkSeedAgreement` is exported separately so a *reader* who holds the referents can re-run
exactly what the sealer ran. It is the one campaign check a parse of the sealed bytes cannot repeat.

Budgets are positive integers, never zero: a campaign that may make no proposals or run no cells
cannot do the thing it declares, and a zero budget reads as "unset" to every author who did not
write it.

## The journal

One campaign per directory: `campaign.json` (the sealed document) and `journal.jsonl` (the
ordering). Each entry carries `{formatToken, campaign, seq, previous, type, recordedAt, payload}`;
`previous` is the sha256 of the preceding entry's canonical bytes.

`payload` is validated as canonical JSON and nothing more. Per-event payload schemas belong to the
sub-unit that emits them — freezing `allocation-decided`'s shape here would be this unit
legislating for a unit that has not been designed yet.

### Lifecycle

The design fixes four phases and closes the event list, and names no separate "phase changed"
event — so the phase is **derived from the events**, never stored beside them.

| Phase | Entered by | Events legal in it |
| --- | --- | --- |
| `DRAFT` | `created` (seq 1, and nowhere else) | `candidate-admitted`, `candidate-rejected`, `wave-planned`, `closed` |
| `EXPLORING` | the first `wave-planned` | every event except `created` |
| `CONFIRMING` | `promotion-run-sealed` | `matrix-assembled`, `report-recorded`, `frontier-updated`, `closed` |
| `CLOSED` | `closed` | nothing |

- **`wave-planned` is the `EXPLORING` boundary**, because a wave is where a campaign starts spending
  evaluation budget and §6.3 requires the promotion gate to be committed and unrevealed before that
  happens. Seed admission stays legal in `DRAFT`: it spends the owner's own budget (§12) and reveals
  nothing about the promotion set.
- **`CONFIRMING` admits exactly one `promotion-run-sealed`** — the event enters the phase and the
  phase does not admit it.
- **`CLOSED` refuses every append, including a second `closed`.** A replay of an entry already
  recorded remains a no-op, closed or not.

### Restart recovery and replay

`createCampaign` is idempotent for the same campaign and refuses a different one. Writing the
document and appending the first journal line cannot be one atomic act, so a crash between them is
reachable; a `create` that refused on sight of an existing document would turn that window into a
directory nobody can finish or reuse. An empty journal is therefore a legal state, and re-running
`createCampaign` resumes it through the ordinary idempotent-replay path.

`openCampaign(directory)` is the whole of recovery: it re-reads the sealed document, replays the
journal (contiguous `seq` from 1, unbroken `previous` chain, every entry naming this campaign,
non-decreasing `recordedAt`, every event legal where it sits) and derives the phase. The handle it
returns is indistinguishable from the one the appending process held.

`appendCampaignEvent` has three outcomes and no others:

- the `seq` is already recorded and the entry it would produce is byte-identical → **no-op** (the
  crash case: the line landed, the caller never saw the handle);
- the `seq` is already recorded and the entry differs → **`journal-conflict`** (two decisions
  cannot occupy one position in an ordering);
- the `seq` is the next one and every guard passes → the line is fsynced, then the new handle exists.

The last guard before that write compares the handle's view against the journal's tail on disk
(line count plus the tail entry's digest). Two live handles on one directory are ordinary — a
long-running campaign process beside a CLI invocation — and without the comparison the stale one
appends a line whose `previous` and `seq` both disagree with what precedes it, wedging every future
`openCampaign`. The comparison closes the stale-handle case completely; it is not a lock, so two
processes that both pass it and then both write are still caught at the next open rather than at
write time. Single-writer-per-campaign is the operating assumption, and this is what makes a
violation of it loud instead of silent.

## The wave engine

A wave **is** one sealed benchmarking Run (§6.1), so the engine is composition end to end:

```
decideAllocation(campaign, population, rows, Reports)   -> AllocationDecision   (pure)
planWave(campaign, candidates, allocation, dev bytes)   -> WavePlan             (planRun seals it)
executeWave(plan, backend, taskBytesFor)                -> WaveExecution        (launchAndWatch)
assembleWaveMatrix(plan, execution, evidence, venue)    -> Matrix               (assembleMatrix over localAssemblyPorts)
produceWaveReport(campaign, method, subjects)           -> signed Report        (benchmarking-aggregate's registry)
planPromotionRun(campaign, survivors, reveal)           -> WavePlan (promotion) (analysisPlan = the objective)
```

Each step has a journal payload builder beside it (`wavePlannedPayload`, `runSealedPayload`,
`allocationDecidedPayload`, `matrixAssembledPayload`, `reportRecordedPayload`,
`promotionRunSealedPayload`), and `appendWaveEvent` writes it at the handle's next sequence.

### Arms carry the whole tuple

Each arm's `pinning` is `expressAsRunPinning(tuple)` — every non-null axis, frozen ones included —
and `policy.submissionBaseline` is empty. The Run schema forbids an arm key colliding with a
baseline key, so hoisting the frozen axes into the baseline and expressing the tuple on the arm are
mutually exclusive; see F-C7b-1 for why the design's expression rule wins and what it costs.

### The allocator

`campaign.allocation.policyRef` selects one of three v0 policies. An unrecognized reference is
refused rather than treated as uniform.

| Policy | Parameters | What it decides |
| --- | --- | --- |
| `uniform/1.0` | `replicates?` | Every admitted candidate, every task. |
| `drop-bottom-k/1.0` | `k`, `minCandidates?` (2), `replicates?` | Ranks arms by the campaign's **first** objective method's per-arm value as the Report sealed it, prunes the bottom `k`, floors at `minCandidates`. A candidate with no Report row is retained unranked. Ties break on the outcomes projection's organic bucket, then on `tupleDigest`. |
| `informativeness/1.0` | `minVerdicts`, `lower`, `upper`, `replicates?` | Drops tasks whose observed benchmark-bucket rate sits at or outside the caller-supplied bounds over at least `minVerdicts` verdicts. No default threshold exists. When every task looks saturated the whole slate is kept and the note says so. |

Every decision carries `inputs` — the Report digests and row references it read — and that block is
journaled with the decision (§6.2), so survivorship is post-hoc auditable. The organic bucket is
manipulable and is used only as a tie-break; §6.2's hazard is real and is exercised by a test rather
than only described.

Nothing here computes a statistic. Report values are ordered as exact decimals through
`benchmarking-records`' `parseExactDecimal`/`scaleDecimal`; observed rates are ordered by exact
integer cross-multiplication, mirroring curation's own `compareRateTo`. The source-boundary guard
sweeps for private estimators (ruling R3).

### Budgets and stopping

`budgets.evaluation.maxCells` bounds development waves; `budgets.hardCap.maxCells` bounds
development plus the promotion Run. Both totals are **derived from the journal**
(`committedCells`), never stored beside it. `stoppingRule` is evaluated immediately before a wave
would spend: `max-waves/1.0` and `budget-exhausted/1.0`, with an unknown reference refused rather
than read as "never stop".

### Promotion

`planPromotionRun` refuses unless the campaign is in `EXPLORING` (the only path that passed the
committed-and-unrevealed gate), the supplied bytes digest to `target.promotionBenchmark`, and every
committed item is revealed and digest-correct. It takes no allocation decision at all, which is how
§6.2's optional-stopping confinement holds by construction rather than by policy. The objective's
methods go into the Run's `analysisPlan` with their parameters verbatim, so
`benchmarking-aggregate` derives `preregistered: true` for the promotion Report and `false` for
every development one.

## Findings

### C7b — the wave engine

- **F-C7b-1 (design reading, with its cost named).** §6.1's "arms = policy tuples expressed as
  Submission run pinning per the substrate's expression rule […] every arm pinned byte-identically
  to the campaign's `frozenAxes` values" admits two implementations, and records §7.79 makes them
  mutually exclusive. Chosen: each arm carries the whole expression and `submissionBaseline` is
  empty, because `expressAsRunPinning` expresses a *tuple*, not the varying part of one. Rejected:
  hoisting the frozen axes into `policy.submissionBaseline`, which would make byte-identity
  structural but would mean no arm's `pinning` is ever a policy tuple. The cost of the choice is
  that byte-identity is now *checked* rather than guaranteed; `assertArmsAgreeOnFrozenAxes` runs on
  every plan and a test asserts it directly.
- **F-C7b-2 (expressive limit of one sealed Run).** §6.2 says the allocator "decides which
  candidates get how many cells next". A benchmarking Run carries one Run-wide `replicates` and
  runs the full cartesian product of its Benchmark's items (records §7.3), so the only allocation a
  single sealed Run can express is **arm membership × task membership × one replicate count**.
  Differential per-candidate replication, and true informativeness *weighting* (as opposed to
  selection), would need one Run per stratum — which is a change to the wave/Run correspondence,
  not a parameter, because "a sealed Run is never amended" (§6.1). Disposition: v0 implements
  pruning and task selection; weighting is deferred and named rather than approximated.
  Consequence: task selection materializes as a **derived Benchmark** — the development slate
  restricted to the selected items, sealed as its own record and carrying
  `network.jinn.policy-optimization.wave-derivation` so a restriction is not mistaken for the
  parent slate it shares a name and version with.
- **F-C7b-3 (integration finding, `benchmarking-aggregate`).** `produceReport` merges
  `verdictRule` into the method parameters it compares against the Run's `analysisPlan` when
  deriving `preregistered`. A campaign objective method whose `parameters` omit `verdictRule`
  therefore yields `preregistered: false` on a promotion Run that plainly did preregister it. Every
  v1 registry method already *requires* `verdictRule`, so a well-formed objective carries it — but
  nothing enforced that at campaign level. Disposition: `objectiveAnalysisPlan` refuses such a
  campaign at plan time rather than shipping a Report that understates its own discipline. No
  change proposed to `benchmarking-aggregate`: merging `verdictRule` is correct, and the product is
  the right place to require what the merge presupposes.
- **F-C7b-4 (integration finding, `task-execution-testing`).** The TEP conformance kit's in-memory
  fake backend is not separable from the kit's local-backend slice: `task-execution-testing`
  declares `task-execution-backend-local`, `-launchers`, `-supervisor`, and `-workspace` as
  *runtime* dependencies, so a consumer that wants only `createInMemoryBackend` inherits the whole
  tree (plus its evidence edges) in its install graph and its CI build order. `benchmarking-run`
  takes the same medicine. Disposition: followed the precedent — the packages appear as portal
  *resolutions* only, every one of them is denied by name in the source-boundary guard, none is a
  dependency, and none is packed. Proposed upstream fix, not taken here: publish the in-memory fake
  under its own subpath with its own dependency set, or split it into a `task-execution-testing-core`
  whose only edge is the backend contract.
- **F-C7b-5 (residual, not a defect).** A dispatched cell with no venue evidence assembles as
  `expired`, not `unjudged`: a cell is "delivered" to assembly by its Delivery digest, which the
  venue supplies, and a dispatch watched to a terminal is not by itself a delivery. The join does
  not promote one into the other. A test pins this so the distinction is asserted rather than
  discovered later by someone reading an attrition block.

No other integration finding was raised. `benchmarking-run`, `benchmarking-local`, and
`benchmarking-aggregate` composed as documented on first use; `benchmarking-local`'s required
`isolationInventory` argument is threaded through to this product's caller in the same required
position rather than defaulted.

### C7a — the core state layer

- **F-C7a-1 (addition).** The design names the campaign document's format token and the journal's
  event list but no token for the journal entries. One is added
  (`network.jinn.policy-optimization.campaign-journal-entry/1.0`): the journal is a host-persisted
  document this package re-reads across restarts, and a versionless envelope cannot refuse a future
  revision's bytes. Host-local state, never network truth (§5.2), so this is a product convention
  and not a protocol surface.
- **F-C7a-2 (scope of the constraint-shape rule).** "Never constraint-shaped" is checkable exactly
  where the stack registers constraint *membership*, which today is the `model` axis alone
  (`@jinn-network/policy-identity`'s `CONSTRAINT_MEMBERSHIP_KEYS`). Every other axis compares by
  byte-equality, so any non-`null` value there already names one treatment. A tripwire test fails
  the day that set grows, so the rule is extended deliberately rather than silently under-applying.
- **F-C7a-3 (added check).** A campaign whose `promotionBenchmark` equals its
  `developmentBenchmark` is refused. The design does not say this in so many words, but a dev wave
  reveals every item it runs, so the two being equal contaminates the gate by construction (§6.3).
- **F-C7a-4 (residual, not a defect).** `checkExploringEntry`'s unrevealedness leg can refute but
  not confirm: `checkRevealConsistency` verifies the bytes the *caller* supplies, so an owner who
  supplies none always passes. This is product §11's honesty residual restated at the code
  boundary — v0 promotion discipline protects an honest owner from self-deception and proves
  nothing to strangers. The checks that bind strangers are §6.3's post-reveal third-party re-run
  and, on an anchored venue, the promotion Benchmark's anchor preceding the earliest dev-cell anchor.
- **F-C7a-5 (residual, not a defect).** The journal's `previous` chain reaches every entry that has
  a successor. A rewritten **tail** chains to nothing and opens cleanly. Catching that needs an
  external commitment, which v0 has nowhere by design (§11: a v0 owner can "retro-write a
  host-local journal — invisibly"). The chain is here to catch a corrupted or half-written file,
  not a determined owner. A test asserts this limit rather than leaving it implied.

No integration finding was raised against a tier-3 package: `@jinn-network/benchmarking-records`
supplied every committed-benchmark predicate this unit needed (`parseBenchmark`, `documentDigest`,
`checkItemDistinctness`, `checkRevealConsistency`, `JudgeabilityRevealContext`,
`compareCalendarStrictRfc3339Instants`) and `@jinn-network/policy-identity` supplied the
canonicalization, digests, and tuple validation. Nothing was reimplemented and nothing was patched.

## Development

```bash
yarn install
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

The portal dependencies must be installed and built from source first, in dependency order:

```
task-execution/protocol -> task-execution/profiles -> task-execution/backend -> trust/core
  -> benchmarking/records -> benchmarking/run -> benchmarking/aggregate -> benchmarking/local
  -> policy/identity
```

`yarn test` additionally needs the TEP conformance kit built (F-C7b-4): `evidence/protocol`,
`evidence/repository`, `evidence/discovery`, `evidence/execution-recorder`, then
`task-execution/backend-local/{supervisor,workspace,launchers,assembly}`, then
`task-execution/testing`. None of that tail is a dependency of this package and none of it is
packed — `pack:smoke` and the packed-consumer canary build only the runtime chain above.
