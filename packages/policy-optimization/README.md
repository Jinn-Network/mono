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

Sub-units **C7a — the core state layer**, **C7b — the wave engine**, **C7c — admission and
proposers**, and **C8 — the two observation adapters**:

| Surface | Design section | What it is |
| --- | --- | --- |
| The campaign document | §5.1 | A sealed product-convention document (JCS-once, sha256, format token `network.jinn.policy-optimization.campaign/1.0`) fixing *what is being optimized, what counts as better, and the budget*. Not a record kind. |
| The campaign journal | §5.2 | A host-persisted, append-only ordering of product decisions, with restart recovery and idempotent replay. Not network truth. |
| Arms | §6.1 | Admitted candidates' tuples expressed as Submission run pinning through the substrate's expression rule, byte-identical on the campaign's `frozenAxes`. |
| Wave planning | §6.1 | Campaign + candidates + allocation → one sealed benchmarking Run, its Benchmark, its cell count, its budget check, its stopping-rule check. |
| Wave execution and assembly | §6.1 | Dispatch through the injected `TaskExecutionBackend`, then a Matrix assembled over the local venue's ports with per-axis treatment-fidelity verification. |
| The dev-wave allocator | §6.2 | A pure decision function: rows and Reports in, a journaled decision out. Three v0 policies. |
| Promotion | §6.3 | One preregistered Run against the revealed committed Benchmark, flat, once. |
| The two observation adapters | §8.2 | `curateAnnouncements` and `deriveOutcomeObservations` — the seven joins, fail-closed, with tuple derivation and verdict-record dedupe on the policy side. Their module headers carry their own reasoning. |
| The evidence bundle | §6.3, §7.1 | A content-addressed manifest of digests only — saved query, snapshot receipt, exact ordered record list — **refused** rather than filtered when any record is inside the held-out boundary (ruling R5). Its provenance block is what a candidate manifest carries. |
| The proposer contract | §7.1 | `PolicyProposer.propose({parents, evidence, objective, mutationSurface, budget}) → CandidateManifest[]`. Product-local; implementations are invisible to the campaign. |
| The reference proposer | §7.2 | Deterministic skill ablation and recombination over the parent loadout. No model, no clock, no randomness. The replaceability falsifier, not a baseline. |
| Admission | §7.3, §7.4 | Eleven individually-reported checks, injected ports, a payload-class consent gate, and a `tupleDigest`-keyed population with first-admitted attribution. |

The archive and CLI (C7d) build on these types. This package
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

Every decision carries `inputs` — the Report digests and the verdict-record digests behind every row
it read — and that block is journaled with the decision (§6.2), so survivorship is post-hoc
auditable. The organic bucket is manipulable and is used only as a tie-break; §6.2's hazard is real
and is exercised by a test rather than only described.

### The adapter seam

The allocator's three row types are **mirrors**, because the adapters that produce them (§8.2) were
a parallel unit. `src/adapter-allocation-seam.test.ts` is the join: announcement fixtures →
`curateAnnouncements` / `deriveOutcomeObservations` (the real adapters) → `projectPolicyOutcomes`
(the real fold) → the mirrored ports → `decideAllocation`. It asserts the load-bearing equality
directly — the tuple the adapter derives digests to the policy the campaign admitted — because
nothing else coordinates the deriver, the projection's row key, and the allocator's population key.

Three mirror deltas were found and fixed **on the mirror side**, never in C8's adapters:

| Delta | What was wrong | Fix |
| --- | --- | --- |
| **M-C7b-1** | The rows carried one synthetic `rowRef`; the real rows carry `inputRefs[]` — every announcement folded in, "mandatory, per design finding F6". | `inputRefs: readonly string[]` (the refs' `record` digests). `AllocationInputRefs` is now the union of those, so the journal's audit trail points at digests a third party can resolve. |
| **M-C7b-2** | The curation half cannot reach its real fold: C8 mirrors `@jinn-network/task-curation`'s observation type rather than importing it, and the source boundary denies that tree. | Stated, not worked around. The seam test folds informativeness rows from the real adapter's real observations using `CurationRow.passRate`'s own `(pass, pass+fail)` definition. Re-deciding C8's dependency boundary is not this unit's call. |
| **M-C7b-3** | The two sides spell a Task digest differently: benchmarking uses bare lowercase hex (Benchmark items, `cellKey` segments), the supply side uses `sha256:<hex>`. The join silently matched nothing and selected every task. | The row keeps the producer's spelling; the allocator normalizes at the join via the exported `bareTaskDigest`. |

`WaveReportRow` needed no correction: no adapter produces it — a Report is read into rows by
whoever holds the sealed Report, and the product still never parses a `results` block itself.

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

## Admission and proposers

### The evidence bundle refuses; it does not filter

Ruling R5 says the exclusion filter is wired into bundle assembly and "a passthrough is a blocker by
definition". A filter that exists only as a helper the caller *may* call is a passthrough, so
`assembleEvidenceBundle` **refuses** a record list containing anything inside the boundary, naming
every offender. `partitionHeldOut` is exported for the caller that wants to drop excluded records at
the query layer first, and assembly independently re-checks. The consequence is the point: there is
no way to obtain a `CandidateEvidenceProvenance` from this package without naming a boundary, and
C6's learner refuses to seal a manifest without provenance (F-C6-1) — so no candidate exists that
was not proposed against a declared held-out boundary.

Three axes are checked. Instance and repo are exact set membership. The third, `unattributable`, is
the one a permissive implementation would omit: a record carrying neither an instance id nor a repo
cannot be shown to be *outside* the boundary, and "could not check" is not "checked and clean". The
bundle carries the boundary's digest and source reference and never its items — a bundle manifest is
the document most likely to be handed to a proposer, and the items are the secret a committed
Benchmark exists to keep.

### The admission pipeline

`admitCandidate` returns a result; it does not throw on rejection. A rejection is a product decision
the campaign journals (`candidate-rejected`) and continues past. Malformed *inputs* still throw.

| # | Check | Refusal category |
| --- | --- | --- |
| 1 | `manifest` — the bytes are the canonical sealed form and validate (substrate §5.3) | `manifest-invalid` |
| 2 | `signature` — cross-operator candidates require a verified DSSE binding (substrate §5.2) | `manifest-invalid` |
| 3 | `evidence-bundle` — the provenance matches a bundle this campaign issued (ruling R5) | `evidence-bundle-mismatch` |
| 4 | `frozen-axes` — the tuple byte-shares every campaign `frozenAxes` value | `frozen-axis-disagreement` |
| 5 | `mutation-surface` — mutable axes carry exact pins; no axis is unclassified | `constraint-shaped-pin`, `unclassified-axis` |
| 6 | `materialization` — `assertMaterializable`, then the package digests to the tuple's pin | `materialization-mismatch` |
| 7 | `mutable-paths` — ruling R2's additive per-file diff, when prefixes are declared | `mutation-surface` |
| 8 | `lexical-scan` — no held-out identifier in the materialized bodies or the declared changes | `held-out-contamination` |
| 9 | `payload-consent` — hostile classes need the owner's admission-time approval (§7.4) | `payload-consent-required` |
| 10 | `smoke-canary` — the optional canary completes | `smoke-canary-failed` |
| 11 | `population` — the arm is minted or joined, keyed by `tupleDigest` | `population-conflict` |

Every check is reported whatever the outcome; a check never reached is `skipped` with a stated
reason rather than omitted, so the report's shape does not depend on where it failed.

**The order is a security property, not a performance one.** The canary runs the candidate's code
(§7.4), so it sits behind the consent gate — an unconsented hostile payload is never executed to
find out whether it works. The lexical scan sits behind materialization because it scans the
*materialized bodies*; a scan of `declaredChanges.summary` alone would scan the one string a
contaminated proposer controls entirely.

Checks 4 and 5 call the wave engine's own `checkCandidateAgainstCampaign`, so the population and the
arms cannot disagree about what the campaign requires: one rule, one implementation, run at both
boundaries.

### Population and attribution

Membership is keyed by `tupleDigest` (§7.3). A second manifest proposing an already-admitted tuple
joins the existing arm; `attribution` is written once by the first-admitted manifest and is never
moved, because "later manifests are journaled against the same arm" is load-bearing for any future
paid-proposal economics — and displacing attribution is exactly the move such economics would create
an incentive for. Arm ids derive from the tuple digest (`arm-<first 12 hex>`) rather than from
insertion order, so a resumed campaign and a re-derived one agree on the ids a Run's bytes were
sealed over.

### The reference proposer's enumeration

Let `S` be the parent tree's skill names, sorted by UTF-16 code unit. In order, truncated at
`budget.maxProposals`: every single ablation `S` minus one skill, then every pair `S` minus two, for
each `i < j` in index order. Single removals come first because a budget affording only a few
proposals should spend them on the smaller step. A variant whose tree digest equals the parent's, or
repeats an earlier variant's, is dropped before sealing. A parent with no skills yields nothing,
reported as an empty list rather than as an error. No model call, no network, no clock, no
randomness — two hosts running it against one parent tree with one budget emit byte-identical
manifests.

## Findings

### C7c — admission and proposers

- **F-C7c-1 (the held-out mirror-vs-port decision).** The shipped exclusion machinery is
  `excludeHeldOutSlate` (instance) and `loadCapabilitySlateRepos` (repo), both in `client/` — tier 4
  like this package but a different product, and denied by the source-boundary guard. Importing was
  refused (the guard's stated rationale), and so was porting the *rule* as a host-supplied
  predicate: that satisfies R5 on paper while letting a permissive host admit the slate, which is a
  passthrough with extra steps. **Chosen: mirror the semantics, port the boundary.** The comparison
  rules live in `evidence-bundle/held-out.ts` where this package's fixtures pin them; the boundary's
  content arrives as a `HeldOutBoundary` value, so nothing is hardcoded and a committed Benchmark's
  revealed items are a legal source alongside a slate artifact (§6.3). A drift note in that module
  records exactly what would signal divergence: neither upstream normalizes, and neither does this.
  The lexical scan has no upstream to mirror — the capability slate's lexical axis is
  `attestation: "self-attested"`, a human's claim — so the rule is stated in full there instead.

- **F-C7c-2 (two format tokens added).** Neither design names a token for the evidence-bundle
  document or the population registry; both are host-persisted documents this package seals, hands
  out, and re-reads across restarts, and a versionless envelope cannot refuse a future revision's
  bytes. Added on C7a's precedent (F-C7a-1) as product conventions, not protocol surfaces.

- **F-C7c-3 (the contract returns manifests, so payload bytes travel out of band).** §7.1's return
  type is `CandidateManifest[]`, and a manifest names its loadout by digest. The bytes therefore
  reach admission through the materializer port, not through the proposer's return value. This is
  not a gap in the design — it is what §7.3's "materializes digest-correct through the provisioner"
  is for — but it means a proposer emitting manifests for packages nobody can fetch produces
  candidates that fail at check 6, which is the correct and legible failure.
  `enumerateReferenceCandidates` returns the trees alongside the manifests for hosts that drive both
  ends.

- **F-C7c-4 (the payload-class map is this unit's, not the design's).** §7.4 lists the gradient by
  example and never maps it onto `learner-public.v1`'s roots. The mapping is stated in full in
  `admission/payload-class.ts` under two rules: executability decides (so `tests/` is
  `hook-or-tool-config` — a learner-authored test is a script that runs during evaluation), and ties
  go to the more hostile class. A tripwire test asserts the map covers exactly the profile's
  classification, so a root added upstream fails here rather than defaulting. `harness-code` is
  unreachable from inside a harness-state tree by construction and is reached instead by an
  unrecognized *loadout kind* — a candidate proposing a runtime nobody has classified.

- **F-C7c-5 (materialization is ported, and the check stays here).** C5's workspace machinery does
  digest-correct materialization against a real filesystem, and the catalog would permit the
  dependency. It was refused: the guard denies `task-execution-workspace` because "naming a concrete
  backend is exactly what the injected-port posture exists to prevent", and admission runs against
  whatever venue the campaign uses. So the port supplies **only the bytes** and may not report
  success — a port returning a boolean "yes it matched" is the passthrough R5 warns about, one gate
  over. Both substrate §4.2 controls (`assertMaterializable`, then `hashTreeLearnerPublicV1`) run
  here, on the port's output. Running `assertMaterializable` again is not redundancy: the digest is
  blind to `.git/`, so a smuggled `.git/hooks/post-checkout` digest-verifies perfectly, and a test
  asserts that byte-equality directly. If the only refusal lived behind the port, a gate holding a
  non-conforming materializer would admit the package and the canary would fire the hook.

- **F-C7c-6 (`crossOperator` is declared, never inferred).** Whether a proposer is a stranger is a
  fact about the operator's setup. A package that guessed would either nag an owner about their own
  learner or wave a stranger's hooks through, and v0's bound on exposure is precisely the
  closed-proposer setup (§7.4). Same-operator hostile payloads are admitted and the report says so,
  naming the vacuity of isolation rather than implying a safety this venue does not have.

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
  -> policy/identity -> policy/outcomes
```

`yarn test` additionally needs the TEP conformance kit built (F-C7b-4): `evidence/protocol`,
`evidence/repository`, `evidence/discovery`, `evidence/execution-recorder`, then
`task-execution/backend-local/{supervisor,workspace,launchers,assembly}`, then
`task-execution/testing`. None of that tail is a dependency of this package and none of it is
packed — `pack:smoke` and the packed-consumer canary build only the runtime chain above.
