# Benchmarking Application — Design

| | |
|---|---|
| **Version** | 0.3 |
| **Date** | 2026-07-28 |
| **Author** | Ritsu (design session, Claude Fable 5) |
| **Shape** | `design` (design-only session; no implementation, no implementation plan, no contract changes — contract-adjacent effects appear as declared impact only) |
| **Status** | proposed (architecture and adversarial reviews run 2026-07-28; five blocking findings across both, all resolved in this revision, plus sixteen non-blocking tightenings — see Appendix B) |
| **Supersedes** | `docs/superpowers/specs/2026-07-22-solvernet-benchmarking-primitive-design.md` v0.2 (draft PR #2002) — see §17 |
| **Depends on** | the 2026-07-27 protocol stack: TEP (`2026-07-27-task-execution-protocol-and-stack-design.md`), profiles (`2026-07-27-task-profiles-and-evaluation-specs-design.md`), trust (`2026-07-27-trust-and-identity-layer-design.md`), record discovery (`2026-07-27-record-discovery-protocol-design.md`), local execution backend (`2026-07-27-local-execution-backend-design.md`), marketplace binding (`2026-07-28-marketplace-binding-design.md`), evidence protocol (`2026-07-23-jinn-execution-evidence-protocol-design.md`) |

Revision note (v0.2 → v0.3): the #2038 disposition is strengthened per the
2026-07-28 session decision — #2040/#2041/#2043/#2045 are closed as
**re-homed** (their capabilities are owned by the stack designs and
implemented as stack-program work on the evidence-v1 lineage, not as issues
against `next`'s current engine); only #2044/PR #2219 runs to completion.
§17.2 and §18.3 updated accordingly. No record shape, check, or interface
changed.

Revision note (v0.1 → v0.2): resolves all review findings. Material changes:
the facts-card extension for shared record kinds is now an explicitly
**declared companion amendment** (§2, §11, §17.5) rather than a claimed
existing hook; evaluator independence is a pre-registered, venue-appropriate
policy rather than an unconditional gate (§7.1, §8.2); the outcome vocabulary
gains `unjudged` and `excluded` and the matrix representation of exclusions is
pinned (§8.1, §8.2); per-cell verdict multiplicity is resolved by a declared
`verdictRule` (§9.2); `closeAt` is mandatory (anti–optional-stopping, §7.1);
the pre-registration check is restated per backend with the local venue's
limits named honestly (§7.2, §12.2); the clustering key is pinned (§9.2); the
Report's required `disclosures` block widens (§9.1); arm execution allowlists
added (§7.1); comparability becomes a named check (§12.1); plus determinism,
grammar, scope-registration, and wording fixes throughout.

---

## 1. Problem statement

Jinn needs a way to answer, credibly, questions of the form *"is configuration A
better than configuration B at this kind of work?"* — where a configuration is a
harness, a model, a skill loadout, an isolation policy, or any combination, and
"credibly" means a skeptical third party can check the answer without trusting
whoever produced it.

Two prior lineages exist and do not talk to each other:

- **The internal lineage** — capability-eval v0 (`spec/2026-07-06-capability-eval-v0.md`,
  DR `log/decisions/2026-07-06-capability-eval-v0-gate.md`): a human-run
  measurement of whether the corpus-connected harness beats stock, built on
  content-addressed held-out slates, paired McNemar statistics, and a
  non-inferiority + cost gate. Methodologically strong; entirely local; its
  records are internal JSON files.
- **The market lineage** — the SolverNet benchmarking primitive
  (`2026-07-22-solvernet-benchmarking-primitive-design.md` v0.2, unmerged draft
  PR #2002; epic #2038 with sub-issues #2039–#2054, three merged): benchmarking
  as a paid marketplace service producing a frozen, anchored result matrix.
  Expressed in SolverNet vocabulary (solverTypes, manifest CIDs, launched-record
  generators) that the 2026-07-27 stack dissolves.

The 2026-07-27 protocol stack absorbed the primitive's *concepts* — the profiles
design retires "capsule" (a capsule is a sealed Task), defines a benchmark arm
as "a Submission with run pinning," makes replicates separate Submissions, and
lists the old `BenchmarkRunV1` as a superseded input — but deliberately did
**not** define the application. What no stack layer provides (by design; each
pushed it up to the application layer):

- a record naming a **benchmark** (a task set plus its judging),
- a record tying a **run's** cells together (pre-registration),
- a record accounting for a run's **results** as a complete set (the matrix),
- **aggregation semantics** (statistics, comparisons, reports),
- and a **discovery** convention making a run's records findable as a set.

This design supplies exactly those, and nothing below them.

External context (see §4): every existing benchmarking product anchors
credibility in reputation — self-run logs ("trust me"), a central grading
platform ("trust the platform" — and both major platform-anchored examples are
dead or dying: the HF Open LLM Leaderboard retired 2025-03; OpenAI's Evals
platform shuts down 2026-11), or an institution ("trust Epoch/METR"). None
offers execution by agent-distinct operators with recorded identities, signed
per-cell records, consumer-side re-derivation of headline numbers, or
resistance to selective disclosure. Those properties are what the Jinn stack
provides on anchored venues — with the honest caveat, maintained throughout
this spec, that the stack proves *agent-distinctness*, not party-independence
(the trust layer's named Sybil residual). The benchmarking application is the
first product-facing proof of it.

## 2. Position in the architecture

> **Graduated 2026-07-30 (DR-2026-07-30).** The four-tier layering law introduced in this
> section is now owned by
> [`2026-07-30-jinn-platform-architecture.md`](./2026-07-30-jinn-platform-architecture.md) §3,
> which builds the platform boundary on it. This section remains valid as the law's origin and
> as this design's own positioning; cite the platform-architecture spec for the law itself.

This design adopts (and this session introduces) a four-tier reading of the
stack. The tiers extend the frozen dependency direction one level up:

1. **Protocol** — sealed record families and their semantics: Task, Submission,
   Attempt, Delivery, evidence records, verdicts, announcements, key bindings.
   Records and meaning; no behavior.
2. **Protocol-extending records** — record kinds defined *above* the protocol
   layers using the same sealed-record discipline (I-JSON, JCS-once, sha256 of
   exact bytes, media types, DSSE where signed), so third parties can produce
   and verify them without running Jinn code.
3. **Applications** — reusable capabilities that consume protocol records and do
   work, each one job, none naming a product: task execution (the local
   backend and the marketplace binding — TEP's *bindings* are a subset of this
   tier; TEP §4.3/§4.4's binding-vs-application distinction is preserved
   within it), evidence capture / retrieval / contribution, discovery serving.
4. **Products** — compositions of applications that people actually use: the
   operator app, Autopilot, a marketplace benchmarking service, the skill
   factory, a leaderboard site.

The discipline that makes the tiers real: **nothing in tiers 1–3 ever names a
product**, and products are swappable compositions.

The benchmarking design spans tiers 2 and 3 and explicitly not tier 4:

- **Tier 2** — four record kinds: **Benchmark** (§6), **Run** (§7),
  **Matrix** (§8), **Report** (§9).
- **Tier 3** — one application: the run procedure (plan → quote → dispatch →
  watch → assemble) plus the aggregation library and the interop surfaces
  (§10).
- **Tier 4** — named consumers with declared seams, out of scope: the
  marketplace benchmarking service, the capability-eval gate, the skill
  factory, leaderboards (§17).

**Companion amendment (one, declared).** Cell context rides in the namespaced
Submission extension slot the profiles design explicitly reserved for it
(profiles §5.3, §10.2; carried TEP amendment 3, recorded in profiles §13).
Making that context *searchable*, however, requires the Submission and
Delivery **facts profiles** — owned by the task-execution profiles package —
to gain optional namespaced fields (§11). The discovery design lists
facts-profile governance for shared kinds as an open item (discovery §22), so
this design does not pretend the hook exists: it **declares a small additive
companion amendment** to those two facts profiles. It is additive-only
(optional namespaced fields, unknown-field-tolerant per discovery §15) and is
the only lower-layer change this design requires; everything else consumes the
stack as frozen.

A follow-up (not this session): a repo-wide docs pass adopting the
application/product vocabulary where earlier documents use "application"
loosely for tiers 2–4 mixed, and reconciling the tier-3 label with TEP's
binding/application vocabulary.

## 3. Decision and rationale

**One backend-neutral application.** The same four records describe a run
whether its cells execute on the operator's own machine through the local
execution backend (private, free, capability-eval-style) or are posted to the
marketplace (paid, open competition, agent-distinct operators). The
marketplace service of the superseded design becomes a tier-4 product over
this application; capability-eval becomes another. Rationale:

- The stack is backend-neutral by construction; a benchmark run is ordinary
  Submissions either way. Two record vocabularies for the same activity would
  be pure duplication.
- The superseded design's own staging ladder (local adapter → Anvil → testnet)
  already demanded a local mode; making local a first-class backend rather than
  a test rig removes throwaway shapes.
- Third-party implementers (a design principle of this session) get one
  contract, not a marketplace-entangled one.

Backend neutrality is about *record shape*, not *guarantee strength*: the
adversarial guarantees (pre-registration ordering, completeness against the
owner, selective-disclosure visibility) hold on **anchored venues** and are
explicitly weaker on self-run local venues (§7.2, §12.2, §13). A local run's
value is reproducibility and internal discipline, not proof against its own
owner.

**Records first, product surfaces second.** The verifiability properties live
entirely in the tier-2 records; the tier-3 surfaces (§10) are ergonomics. A
third party can ignore our application code entirely and still produce or
verify every record.

**Compose over build.** Wholesale adoption where the ecosystem has a real
standard; imitation where it has a good idea without a contract; invention only
for the genuinely missing piece (committed task sets with scheduled reveal).
See §4.

## 4. Standards audit

Research lanes surveyed eval harness formats (Inspect, lm-evaluation-harness,
HELM, lighteval, OpenAI Evals), the SWE-bench ecosystem, dataset metadata
standards (Croissant, HF dataset cards), result-reporting regimes (MLPerf,
eval-card efforts), statistics practice (Miller 2024, Chen 2021, Chatbot
Arena/Bradley-Terry), anti-contamination mechanisms (canary GUIDs, SWE-bench
Verified curation, LiveCodeBench temporal freshness, TRUCE commit-reveal), and
signed-result prior art (in-toto test-result predicate, SLSA VSA, Attestable
Audits), plus the product journeys of ~12 benchmark-running tools and
evaluator organizations.

| Concern | Adopt wholesale | Imitate | Define here |
|---|---|---|---|
| Repo-task item schema | SWE-bench instance fields (`instance_id`, `base_commit`, `FAIL_TO_PASS`, `PASS_TO_PASS`) + SWE-rebench `install_config` / quality labels — already the profiles design's `repository-work/1.0` lineage | SWE-bench Verified annotation rubric as quality metadata | — |
| Benchmark manifest metadata | — (Croissant is JSON-LD; poor fit for sealed bytes) | Croissant's SemVer discipline and per-file sha256 posture | the sealed Benchmark record (§6); deterministic Croissant **export** (§6.5) |
| Per-cell result semantics | SWE-bench outcome taxonomy (resolved / unresolved / error / empty-patch) as profile-level verdict vocabulary; Inspect EvalLog semantics retained as runtime-native source evidence | HELM's artifact split (spec / instances / raw trace / per-instance / aggregate) — realized as Task / Run / evidence / Matrix / Report | Matrix record (§8) |
| Signing | DSSE + in-toto Statements (already the stack's foundation); in-toto `test-result` predicate as a compatibility view | SLSA VSA shape for verified aggregates | Report record (§9.1) |
| Statistics | Miller 2024 (clustered SEs, paired differences, avg@k, power analysis); Chen 2021 unbiased pass@k; Wilson intervals (already implemented in-repo) | Bradley-Terry + bootstrap (Chatbot Arena) as an optional module | named method registry (§9.2) |
| Contamination | canary GUID convention; per-item provenance timestamps (LiveCodeBench pattern — already in the profiles `provenance` block) | TRUCE / Attestable Audits commit-reveal shape | committed Benchmark with scheduled reveal (§6.4) — the one genuinely novel piece, and it reduces to a publishing schedule over existing content addressing |
| Runner journey | — | Inspect's journey shape (declarative spec → one command → live view → bundleable logs); Braintrust's two-arm diff loop; sb-cli's quote-before-run | the six operations (§10.1) |
| Viewer / authoring | Inspect (`inspect view`) over native Inspect logs | — | **non-goal**: no viewer, no task-authoring framework (§19) |

Product-survey conclusions binding on this design (§10.3): comparison must not
be an afterthought; one declarative spec, no backend sprawl; per-cell price
before the run; live per-cell status for remote execution; content-addressed
task pinning (the three-divergent-MMLU-implementations lesson); credibility
must not depend on this platform's survival; no unlogged discretionary process.

## 5. Tenets

1. **Pre-registration before execution.** The full method — task set, arms,
   replicates, policy, stopping rule, budget — is a public record before any
   cell runs. Everything downstream is checked against it. *Trust-bearing on
   anchored venues; on self-run local venues this is a discipline, not a proof
   (§7.2, §12.2).*
2. **Items are verifiable; sets are claims.** Individual deliveries and
   verdicts are signed ground truth. The Matrix is the run owner's claim of
   completeness, made checkable by the pre-registered expected-cell set and
   deterministic assembly. *Checkable against the owner on anchored venues;
   owner-curated on self-run venues (§12.2).*
3. **The matrix never contains a conclusion.** No averages, no pass rates, no
   winner, no ranking. The moment it emits one, the consumer boundary has
   leaked (the superseded design's §1.5 test, kept verbatim).
4. **Aggregation is consumer-side and attributable.** Statistics are computed
   by consumers under named, versioned methods; publishing an interpretation is
   a signed, reputation-bearing act (the Report).
5. **Backend-neutral records.** No record field names a backend; the
   binding-conditional parts (budget, anchors) and the venue-conditional
   guarantee strengths are declared as such, never smoothed over.
6. **Content addressing is the commitment scheme.** Committed benchmarks,
   pre-registration identity, and matrix re-derivation all reduce to the
   stack's existing sealed-record discipline. No new cryptography.
7. **Missing is reported missing.** Never imputed, never silently dropped;
   asymmetric attrition is surfaced as a validity flag; residuals this design
   cannot close are named in §12, not hidden.
8. **Nothing here names a product**, and no lower layer learns what a
   "benchmark" is.

## 6. The Benchmark record

Media type (working): `application/vnd.jinn.benchmarking.benchmark.v1+json`.
A sealed record (I-JSON, JCS-once, sha256 over exact bytes) per the stack's
sealed-document discipline.

### 6.1 Fields

- `protocol` — `"jinn.benchmarking/1.0"` (working title).
- `name` — human label. Non-authoritative (see §6.3).
- `description` — prose.
- `author` — optional Agent IRI. Self-declaration, non-authoritative;
  publisher authority comes from the signed discovery announcement (§11).
- `version` — SemVer string (§6.2).
- `supersedes` — optional ResourceDescriptor naming the predecessor Benchmark
  record digest (same mechanism as Task lineage).
- `items[]` — ordered array; each item:
  - `task` — ResourceDescriptor for a sealed Task: `digest` required
    (sha256), `uri` acquisition hint optional. Item order defines the item
    index. Digests MUST be distinct within a benchmark.
- `reveal` — advisory declaration of the publishing schedule for item Task
  bytes: `{ policy: "immediate" | "scheduled" | "after-run", notBefore?:
  RFC 3339 }` (§6.4).
- `license`, `citation` — optional strings.
- Namespaced extensions per TEP §21.3 (core semantics never derive from them).

Constraints:

- Every referenced Task MUST carry a sealed `evaluation` descriptor
  (an EvaluationSpec digest). A benchmark item is judgeable by construction —
  "task and judge are inseparable" is inherited from the stack, not restated.
  Named check: `benchmark-judgeability`. For a committed benchmark this check
  is executable by third parties only at reveal (before reveal, only
  byte-holders can run it); a verifier reports it `unevaluated` rather than
  passed until then.
- Item digests distinct. Named check: `benchmark-item-distinctness`.
- Per-item provenance (source, creation timestamp, quality annotations,
  canary marker) lives **inside the Task payload** (the profiles design's
  `provenance` block, with its blindable `sourceCommitment`), never in the
  Benchmark record. The Benchmark stays a thin set-namer. Provenance values
  are author-sealed *claims* — sealing fixes bytes, it does not attest dates
  (see §9.2 `clean-subset@1` for the consequence).

### 6.2 Identity and versioning

Identity is the record digest. There is no separate `setHash`: the sealed item
list *is* the set commitment.

Versions are distinct sealed records linked by `supersedes`, carrying SemVer
with Croissant's discipline given operational meaning:

- **patch** — metadata-only change (name, description, license, reveal
  schedule). Item list byte-identical.
- **minor** — items added; no item removed or changed.
- **major** — items removed or changed, or any referenced Task's evaluation
  changed (which changes the Task digest, hence the item).

Comparability rule (normative for methods, §9, and mechanized as the named
check `benchmark-comparability`, §12.1): **scores are comparable only within
one Benchmark record digest.** A minor bump does not license comparing
new-version aggregates against old-version aggregates; paired methods pair on
shared Task digests and are version-robust by construction.

### 6.3 Names are claims, digests are facts

There is no registry (discovery deliberately defines none). Any publisher may
call their benchmark anything; which publishers' names a consumer accepts is a
trust-policy decision (suggested trust-policy purpose: `benchmark-publisher`,
using the trust layer's existing purpose-scoped policy documents). Serious
citation is always by record digest.

### 6.4 Committed benchmarks (reveal-later)

Motivation: public exams contaminate (training data, teaching-to-the-test);
secret exams are unverifiable (the examiner can swap questions after seeing
results). Commit-reveal resolves the tension, and in this stack it costs
nothing new:

- **Commit** — publish the Benchmark record (task digests) while withholding
  the Task bytes. Content addressing makes the digest list a binding
  commitment to the exact items, fixed before any result exists.
- **Execute** — executors receive Task bytes at execution time (dispatch
  necessarily discloses a task to its executor; by then it is too late to have
  trained on it). Because TEP dispatch (`submit(taskBytes, …)`) requires the
  dispatcher to hold the bytes, **pre-reveal a committed benchmark is
  dispatchable only by the author or parties the author shares bytes with**.
  On the marketplace, task bytes become public at post time — a committed
  benchmark run on an open backend therefore reveals items as cells dispatch;
  the commitment still proves the set predates the results. Fully-private-
  until-reveal execution requires the local backend or a future
  confidential-execution tier (§19).
- **Reveal** — publish the Task bytes; anyone verifies each against the
  committed digests. Named check: `reveal-consistency` — which verifies
  revealed bytes against committed digests **and reports reveal coverage**
  (revealed / committed counts): a partially revealed benchmark is flagged,
  never silently accepted, because "commit 100, reveal the favorable 40" is
  otherwise invisible to the casual consumer.

The `reveal` field is advisory intent, not enforcement — an author who never
(or only partially) reveals has a benchmark nobody should trust, and trust
policy is where that judgment lives. The internal held-out slate becomes
exactly this: a committed Benchmark version, revealed after its measurement
window.

### 6.5 Croissant export

A deterministic one-way projection of a Benchmark record (plus revealed Task
bytes) into an MLCommons Croissant JSON-LD document — dataset-level metadata,
one FileObject per item with `sha256`, `version` mapped through. Posture
identical to the marketplace binding's ERC-8004 export: the sealed record is
authoritative; the projection is a courtesy view for ecosystem tools. The
export is specified (fixture-pinned) but carries no reverse path.

### 6.6 Out of v1

Named subsets/splits within one benchmark (today: separate versions or
separate benchmarks) and per-item weights. Both are extension-field candidates
that MUST NOT affect core semantics if experimented with.

## 7. The Run record

Media type (working): `application/vnd.jinn.benchmarking.run.v1+json`.
Sealed record. The Run is the **pre-registration**: the complete public
declaration of one execution campaign — including its stopping rule — sealed
before any cell executes.

### 7.1 Fields

- `protocol` — `"jinn.benchmarking/1.0"`.
- `benchmark` — ResourceDescriptor: the Benchmark record digest.
- `owner` — Agent IRI of the run owner. Required: a run is someone's
  attributable act (unlike requester-neutral Tasks). The owner assembles the
  Matrix and answers for it.
- `arms[]` — the configurations under comparison; each:
  - `armId` — string matching `[A-Za-z0-9_-]{1,64}`, unique within the run.
  - `pinning` — a Submission requirements map. Its core keys are the profiles
    design's §5.1 run-pinning vocabulary (`harness`, `model`, `loadout`,
    `isolationPolicy`), and it MAY include any other Submission requirement
    keys (e.g. an effort floor, per the marketplace binding's ordinary-
    Submission pinning) — an arm invents no new vocabulary. Arms MUST be
    pairwise distinct in their pinning. The four core keys are the
    evidence-verifiable axes of §8.1; other keys are honor-or-reject at
    dispatch but not retroactively verifiable.
  - `execution` — optional `{ allowlist: [Agent IRI] }`. When present, only
    deliveries whose solver resolves to a listed IRI are attributable to this
    arm; others are exclusion-hits (§7.4). Rationale (§12.3): on open
    competition, a rival can execute your arm badly on purpose — sandbagging
    under correct pinning is a genuine `judged` fail, indistinguishable from
    the arm being bad. Benchmark validity comes from independent
    *evaluation*, not open *execution*; the credible default is arms executed
    by their proponents or allowlisted operators. Open execution of an arm is
    permitted but is a declared validity risk, not the recommended posture.
- `replicates` — integer ≥ 1. Per profiles §5.3, each replicate is a separate
  Submission of the shared Task.
- `policy`:
  - `completenessFloor` — fraction (0, 1]; below it the run closes `partial`.
    Reports disclose the floor value (§9.1) — a low floor is legal but
    visible.
  - `cellWindow` — the per-cell execution window (duration from dispatch),
    mapped to each Submission's `deadline`. A cell (including a replacement)
    MUST NOT be dispatched with a deadline later than `closeAt`; if the
    remaining time is shorter than `cellWindow`, the deadline is clipped to
    `closeAt`.
  - `replacement` — `{ allowed: boolean, maxPerCell?: integer }`; whether an
    `expired`/`unscorable` cell may be re-dispatched, and how many times.
  - `independence` — `"gating" | "disclosed"`. Under `gating` (the default,
    and the required setting for `open-competition` venues), a verdict whose
    evaluator does not resolve agent-distinct from the solver cannot make a
    cell `judged` (§8.2). Under `disclosed` (the honest setting for single-
    identity self-runs), such verdicts count but every consuming Report must
    disclose the fact (§9.1). Solver self-*evaluation of its own delivery*
    under `gating` is thereby impossible; self-*solve* is always permitted.
  - `evaluation` — `{ minVerdicts?: integer, distinctEvaluator?: boolean }` —
    the evaluation-requirements policy, **pre-registered here** rather than
    left as a dispatch-time degree of freedom. Applied to cell Submissions
    only where the backend's deployment profile interprets it (marketplace);
    on the local backend the application dispatches evaluation cells itself
    and MUST NOT attach an `evaluationRequirements` block the backend would
    reject (local backend §9.1).
  - `submissionBaseline` — a run-level constant map of non-arm Submission
    requirement keys (e.g. `evidenceCapture: always`, backend-mandated
    isolation class). Cell correspondence (§7.3) is checked against
    `pinning ∪ submissionBaseline`.
  - `participantExclusions[]` — optional Agent IRIs excluded from solving
    and/or evaluating (declared conflicts).
- `analysisPlan[]` — optional, pre-registered analyses: each
  `{ method: <URI>, version, parameters }` (§9.2). A Report may claim
  conformance to a plan entry; §12.2 names the residual for reports without
  one.
- `budget` — optional; binding-conditional (required by the marketplace
  product profile, absent on local): `{ perCell: { solve, evaluate }, hardCap,
  unit }`, amounts as decimal strings.
- `venue` — advisory: `{ kind: "self-run" | "open-competition", note? }`.
  The label is a self-declaration; the Matrix records participation only to
  agent-distinctness, which cannot distinguish genuine open competition from
  Sybil self-claiming (trust §10). Consumers weigh the label accordingly.
- `closeAt` — **required** absolute RFC 3339 close instant (the
  pre-registered stopping rule). On anchored venues the close boundary is the
  first `finalized` block at or after `closeAt` (§8.1). Making this mandatory
  removes the optional-stopping lever: an owner who watches results stream in
  cannot choose when to stop.
- Namespaced extensions.

### 7.2 Identity is the pre-registration

The Run record digest is simultaneously the run's identity and its
pre-registration commitment. The superseded design's separate `runId` and
`preRegistrationHash` collapse into one sealed digest.

The named check `preregistration-precedes-dispatch` has three legs, stated
per backend honestly:

- **(a) Structural (all backends).** Every accounted cell Submission's
  benchmarking extension block contains the Run record digest (§7.3). A
  sealed Submission cannot reference a digest that did not yet exist, so
  every dispatched cell provably committed to its exact pre-registration
  before it was sealed — digest acyclicity, independent of any clock.
- **(b) Anchored ordering (marketplace).** The Run record's announcement (or
  its digest anchor) is observed at or before the block of the earliest cell
  post; transaction order provides third-party-visible time. In today-mode
  the anchor is the projector's announcement of the post; in revised-mode the
  Submission digest is chain-anchored directly (marketplace binding §5.1,
  §6.1). This leg is what makes tenets 1–2 trust-bearing against the owner.
- **(c) Chain corroboration (all published sources).** Within the owner's
  discovery announcement chain, the Run entry precedes every cell entry.
  Hash-chain order is append order — on a self-run local venue with no
  third-party time bound, an owner can execute everything first and append
  Run-then-cells afterward, so **this leg alone proves append-order, not
  registration-before-execution**. Local self-run runs therefore carry no
  pre-registration or completeness guarantee against their own owner; their
  value is reproducibility and discipline (§3, §12.2).

### 7.3 Cells and dispatch

A **cell** is one coordinate of the matrix:

- `cellKey` (string, unique within the run) =
  `"<taskDigest>/<armId>/<replicate>"`, where `taskDigest` is the item Task's
  digest in the stack's canonical lowercase-hex form, `armId` is as declared
  (its grammar excludes `/`), and `replicate` is **1-based**, minimal decimal,
  no padding. Fully recomputable from the Run and Benchmark records alone;
  globally qualified as (run digest, cellKey). The **expected cell set** is
  the full cartesian product `items × arms × replicates`; its size is
  `|items| × |arms| × replicates`.

Dispatching a cell is an ordinary TEP Submission of the item's Task:

- The Submission's full requirements map MUST equal
  `arm.pinning ∪ policy.submissionBaseline` (named check
  `cell-correspondence`; byte-level map equality after JCS). A tightened,
  loosened, or augmented map is a correspondence failure and the cell is
  attributable to no arm.
- `deadline` from `cellWindow` clipped to `closeAt` (§7.1); `attempts` per
  the binding's supported bounds (local backend v1: `1..1`; marketplace: as
  bound by the binding). *(Amended 2026-08-04: a Run's close boundary is
  evaluated against a **caller-supplied instant only**. `LaunchOptions.clock`
  is required, and `launchAndWatch` / `resumeRun` no longer fall back to
  wall-clock when it is absent; the deprecated epoch-ms `now` field is
  removed. The removed fallback made every call site that omitted a clock a
  dormant time bomb — it read real time against a fixture's absolute
  `closeAt`, so a suite that passed for months went red on a date rather than
  on a change. Requiredness moves that failure from a wall-clock date to
  compile time. A host that genuinely wants real time passes the exported
  `systemClock`, which makes the choice visible in the diff.)*
- Evaluation-requirements per `policy.evaluation`, backend-conditional
  (§7.1).
- Namespaced extension block (opaque to core, defined by this spec):
  `{ run: <runDigest>, cellKey, armId, replicate, dispatch: <n> }`.
- Idempotency key derived from `(runDigest, cellKey, dispatch)` — crash-safe
  resumption never re-posts a cell, and a *replacement* is visibly a new
  dispatch of the same cell, never a silent retry.

No protocol layer interprets any of this; the extension slot is the hook the
stack reserved, and searchability comes from the declared companion amendment
(§2, §11).

### 7.4 Replacement and exclusion-hits

If `policy.replacement.allowed`, a cell whose current dispatch terminated
`expired`, `unscorable`, or as an exclusion-hit MAY be re-dispatched with
`dispatch` incremented, up to `maxPerCell` and never past `closeAt`. All
dispatches of a cell remain in the record trail; the Matrix reports the full
lineage and which dispatch produced the accounted outcome (the last terminal
dispatch). `judged`, `unjudged`, and `invalidated` outcomes are never
replaced — a judged result you dislike and an invalidated arm-mismatch are
both final for the run (re-running preferences is a new Run).

An **exclusion-hit** is a dispatch claimed or delivered by a participant
barred for this cell — a `participantExclusions` match, or (for arms with an
execution allowlist) a solver outside the allowlist. Exclusion-hits are
treated like `unscorable` for replacement purposes; a cell whose accounted
dispatch is an exclusion-hit at the boundary carries outcome `excluded`
(§8.2). Nothing on-chain prevents an excluded party from claiming (the
marketplace accepts any operator); exclusion is an accounting rule, enforced
at matrix assembly and verifiable by anyone.

## 8. The Matrix record

Media type (working): `application/vnd.jinn.benchmarking.matrix.v1+json`.
Sealed record, assembled by the run owner at close, announced with the owner's
signature. The Matrix is the completeness claim over the pre-registered
expected cell set — and because assembly is deterministic (§8.3), it is a
claim anyone can recompute and byte-compare.

### 8.1 Fields

- `protocol`, `run` (ResourceDescriptor of the Run record).
- `closeBoundary` — `{ at: RFC 3339, anchor?: { chain, blockNumber,
  blockHash } }`. `at` MUST equal the Run's pre-registered `closeAt`; on
  anchored backends `anchor` is required and MUST be the first `finalized`
  block at or after `closeAt`. Only records within the declared input scope
  (§8.3) at the boundary enter assembly.
- `cells[]` — **exactly one entry per expected cell** (the full cartesian
  product; excluded cells included), ordered per §8.3; each:
  - `cellKey`, `taskDigest`, `armId`, `replicate`.
  - `dispatches` — total dispatch count; `accounted` — the dispatch index the
    outcome refers to (absent when the cell was never dispatched).
  - `submission` — Submission record digest (of the accounted dispatch);
    `attempt` — Attempt URI where one exists; `delivery` — Delivery record
    digest where one exists; `verdicts[]` — all verdict record digests within
    the input scope (sorted by digest); `validVerdicts[]` — the subset
    passing §8.2's validity conditions (sorted; ⊆ `verdicts[]`).
  - `outcome` — `judged | unjudged | unscorable | expired | invalidated |
    excluded` (§8.2).
  - `verification` — per core pinning axis (`harness`, `model`, `loadout`,
    `isolation`): `match | mismatch | unverifiable`, derived by comparing the
    arm's pinning against the evidence Runtime Observation / effective-
    execution attestation (#2041). *(Amended 2026-08-03, DF-2 of the C4
    review: on venues whose backend **enforces** a pinning axis — admission
    gate plus digest-verified materialization, per the policy
    identity/outcomes design §4.3/§7 — the admission-gate leg is a valid
    `match` source for that axis, corroborated by observation where one
    exists. Attested venues still reach `match` only via a corroborating
    Runtime Observation. The first producer implementing both legs is
    `@jinn-network/benchmarking-local`.)* Plus `checksFailed[]` naming any failed
    named checks (including a non-gating independence failure under
    `independence: disclosed`).
  - `integrityTier` — `re-derivable | attested-only` (§8.4).
  - `solver`, `evaluator` — Agent IRIs as resolved via the trust layer under
    the §8.3 resolution rule; `unresolved` markers where resolution fails
    (fail-closed for independence accounting).
  - `cost` — optional `{ value, unit, source: "reported" | "settled" }`;
    `latencyMs` — optional. Sources pinned by the assembly procedure (§8.3).
- `exclusions[]` — `{ cellKey, reason }` for every cell with outcome
  `excluded`; `reason` MUST reference the Run policy clause applied
  (participant exclusion or arm allowlist). This array is a convenience view;
  the authoritative representation is the cell entry itself.
- `attrition` — `{ perArm: { armId → { expected, judged, unjudged,
  unscorable, expired, invalidated, excluded, replacements } },
  asymmetryFlags[] }`. An asymmetry flag is raised when non-`judged` outcomes
  or replacement counts distribute unevenly across arms beyond the assembly
  procedure's declared thresholds — a validity threat surfaced, never
  absorbed. (Named limit: attrition that is arm-*symmetric* — e.g. items
  withheld across all arms — does not trip these flags; it is visible only in
  `completeness`, which is why Reports must carry it, §9.1.)
- `completeness` — `{ expected, judged, floor, runOutcome: "complete" |
  "partial" | "cancelled" }`. `expected` counts the full cartesian product.
  The floor test is `judged / (expected − excluded) ≥ floor`. `partial` =
  floor missed; `cancelled` = owner closed early (before `closeAt`); both
  still publish a full accounting of what exists.
- `assembly` — `{ procedure: <identifier>, version }` naming the assembly
  rules used (§8.3), so re-derivation is versioned.
- Namespaced extensions.

The matrix contains **no aggregate of any kind** (tenet 3).

### 8.2 Outcome derivation

Deterministic, per accounted dispatch, evaluated at the close boundary. A
**valid verdict** is an evaluation record that (i) passes the profiles §7.7
spec-digest equality rule (named here `verdict-spec-match`: its
`evaluationSpecification` digest equals the Task's sealed `evaluation`
digest), (ii) passes the profiles design's named evaluation checks, and (iii)
under `policy.independence: gating`, has an evaluator that resolves
agent-distinct from the solver (`evaluator-independence`); under `disclosed`,
condition (iii) is recorded in `checksFailed` instead of gating.

1. If the accounted dispatch is an exclusion-hit (§7.4) → `excluded`.
2. Else if the cell's verification has any `mismatch` axis → `invalidated`
   (delivered work not attributable to the arm; the delivery and verdicts
   remain referenced — nothing is erased, the cell is simply not evidence
   about the arm).
3. Else if at least one valid verdict exists → `judged`.
4. Else if every in-scope evaluation of the delivery terminally
   could-not-grade (the evaluation-task lineage's unscorable signal) →
   `unscorable`.
5. Else if a delivery exists (no valid verdict, not unscorable-terminal) →
   `unjudged` (evaluation lag or absent evaluation at the boundary —
   distinguished from `expired` so attrition attributes execution health and
   evaluation health separately).
6. Else if the Submission deadline passed without a delivery → `expired`.
7. A never-dispatched cell → `expired` with `dispatches: 0` (the boundary is
   the run's clock; late records remain valid TEP records but are outside
   this matrix).

`unjudged`, `unscorable`, `expired`, and `excluded` never enter any
denominator downstream (§9.3); `invalidated` enters only invalidation-rate
reporting.

### 8.3 Deterministic assembly

Given (Run record, Benchmark record, the declared input scope at
`closeBoundary`, the assembly procedure version), any party MUST produce a
byte-identical Matrix:

- Expected cells enumerated from the cartesian product; `cells[]` ordered
  lexicographically by `cellKey`; all digest arrays sorted; all optional
  absent fields omitted (never null); sealed serialization is JCS as
  everywhere.
- **Input scope is declared by the assembly procedure**: the run owner's
  announcement chain plus the backend's authoritative records (on the
  marketplace: chain events at `finalized` up to the close anchor, with the
  marketplace binding's projector derivation annotations). `verdicts[]`
  means all verdict records **within this scope** — never "known to" any
  particular party. A verifier using the same scope reaches the same bytes;
  on anchored venues, a verifier who *finds* in-scope records the matrix
  omits has found evidence, not a formatting dispute. (On self-run local
  venues the scope is owner-curated; see §7.2 leg (c) and §12.2.)
- **Trust resolution is pinned**: `solver`/`evaluator` fields resolve via
  trust §7.5 steps 1–4 only (never step 5's consumer policy), at the
  evidence's effective time, using key bindings anchored at or before the
  close boundary. Later-anchored bindings are harmless by the trust layer's
  effective-time rule.
- **Optional-field sourcing is pinned**: the assembly procedure version
  enumerates exactly which records populate `cost` (settlement events where
  the backend provides them, else evidence resource observations) and
  `latencyMs`; presence differences are byte differences, so sourcing is
  never discretionary.
- Named check: `matrix-rederivation` (byte equality).

### 8.4 Integrity tiers

Copied per cell from the task's admission evidence, per the profiles design:
`re-derivable` only where an admission receipt exists showing ~zero replay
variance and no external capabilities for the EvaluationSpec; otherwise
`attested-only` — including when no admission receipt exists (conservative
default). Never self-declared; never launderable upward by any summary. A
Report over mixed tiers MUST disclose the mix (§9.1).

## 9. The Report record and aggregation methodology

### 9.1 The Report record

Media type (working): `application/vnd.jinn.benchmarking.report.v1+json`.
A sealed record, DSSE-signed by its author — the one record kind here that is
always signed at the record level (it is an interpretation, i.e. a claim
someone must own). Its DSSE envelope uses the registered namespaced trust
binding scope `benchmarking-reports` (§12.1).

- `protocol`.
- `subjects[]` — ResourceDescriptors of the Matrix record(s) interpreted.
- `method` — `{ id: <method URI>, version, parameters }` from the registry
  (§9.2). `preregistered` — optional boolean: true iff this exact
  (id, version, parameters) tuple appears in the subject Run's
  `analysisPlan[]` (checkable; false or absent otherwise).
- `results` — the method's declared output shape (JSON).
- `disclosures` — required block, carried whole from the consumed matrices:
  - `integrityTiers` — cell counts per tier (§8.4);
  - `pinning` — per-axis `match | mismatch | unverifiable` counts over the
    consumed cells (before enforcement legs #2040/#2041 land, marketplace
    cells are honestly `unverifiable` — a Report cannot silently score
    unverified configurations);
  - `independence` — count of cells judged under `independence: disclosed`
    with a failed distinctness check;
  - `completeness` — the subject matrices' `{ expected, judged, floor,
    runOutcome }`;
  - `attrition` — the subject matrices' asymmetry flags and per-arm
    non-judged counts.
- `limitations[]` — optional prose.
- `author` — Agent IRI (must resolve to the DSSE signing key via the trust
  layer's binding verification).
- Namespaced extensions.

Properties: **outside** the matrix (the boundary holds); **attributable**
(declaring a winner is a signed, reputation-bearing act); **checkable**
(matrix + the referenced verdict records + method id + parameters ⇒ anyone
recomputes `results`; named check `report-recompute`, which also enforces
`benchmark-comparability` — §12.1). A compatibility view as an in-toto
`test-result` predicate MAY be emitted alongside; the sealed Report is
authoritative.

Known consumers: the skill factory's benchmark report is a Report over a
matrix (candidate = arm; pass/fail = a non-inferiority method result); a
leaderboard is a curated collection of Reports — its editorial choices visible
rather than implicit.

### 9.2 Named methods

Methods are identified by URI + version; each method spec declares its inputs
(which matrix fields and referenced records), its exclusion discipline, its
parameters, and its output shape, and is implemented in the reference
aggregation library (§10.1 op 5). Two contract-wide inputs:

- **`verdictRule`** — how a cell's `validVerdicts[]` reduce to one value:
  `sole` (exactly one valid verdict, else the cell is `conflicted` and
  dropped-with-report), `unanimous` (all agree, else `conflicted`),
  `any-pass`, `majority`. Default: `unanimous`. Conflicted-cell counts and
  cellKeys always appear in `results`. Without this rule, verdict
  multiplicity (legal under TEP's non-exclusive evaluations and
  `minVerdicts > 1`) would make recomputation ambiguous.
- **Clustering**: where a method clusters standard errors, the clustering key
  is **pinned to the task provenance source** (repo/source family) and is not
  a report-time parameter — a report-author-chosen key could collapse
  clusters to singletons and manufacture the exact error understatement the
  correction exists to fix. A different key is expressible only as a distinct
  pre-registered `analysisPlan` entry.

Initial registry (working URIs under `jinn.benchmarking.method/`):

- `wilson@1` — marginal pass rate with Wilson score interval, per arm.
- `avg-at-k@1` / `pass-at-k@1` — per-task repetition estimators (mean success
  rate; Chen 2021 unbiased pass@k). Raw per-replicate outcomes come from the
  matrix; consumers derive either.
- `paired-mcnemar@1` — two-arm comparison by per-task paired differences on
  shared Task digests: exact McNemar, with standard errors clustered per the
  pinned clustering rule (the Miller 2024 correction; naive SEs on clustered
  suites understate error ≥3×). Pairing is native: arms share Task digests by
  construction.
- `provenance-cluster-sign@1` — two-arm comparison by one exact sign vote per
  provenance cluster: Task deltas are summed inside a cluster, ties disclosed
  and excluded, and the exact two-sided binomial tail reported. Requires
  `replicates == 1`.
- `paired-delta@1` — two-arm comparison by the paired mean difference in pass
  rate, with a two-sided BCa confidence interval bootstrapped over whole
  provenance clusters. Replicate-aware: a Task's per-arm rate averages all its
  judged replicates. Reports an estimate, not a gate; the interval is withheld
  (with a stated reason) below five paired Tasks or two source clusters.
- `noninferiority-iut@1` — the capability-eval composite gate: quality
  non-inferior (one-sided BCa bootstrap lower bound + relative-regression
  cap) AND cost strictly lower (one-sided Wilcoxon on both-solve pairs),
  intersection-union at α; verdicts PASS / FAIL / INCONCLUSIVE.
- `clean-subset@1` — contamination filter: restrict to items whose provenance
  time predicate passes a declared model-knowledge cutoff, then delegate to
  another method. Parameters declare the **basis**: `self-declared` (the
  author-sealed payload timestamp — a claim, not an attestation; a dishonest
  author can stamp an old contaminated task with a fresh date, and this
  residual is named, not solved) or `announcement-anchored` (the Benchmark
  record's signed announcement / anchor time — proves the *digest* existed by
  then; strictly weaker than item creation but externally verifiable).
  Reports carry the basis in `parameters`; consumers weigh accordingly.
- `bradley-terry@1` — optional module for pairwise-judged benchmarks (MLE
  Bradley-Terry + bootstrap CIs); registered but not part of the v1 reference
  set unless pairwise judging appears.

The in-repo implementations (`paired.ts`, `wilson.ts`, `capability-stats.ts`,
the three-arm measurement) are the seed of the reference library — adoption,
not invention.

### 9.3 Exclusion discipline (normative for all methods)

- Only `judged` cells enter any score. `unjudged`, `unscorable`, `expired`,
  `invalidated`, `excluded`, and `conflicted` (per `verdictRule`) never enter
  a denominator.
- Paired methods pair only tasks judged in **both** arms; the excluded
  remainder is reported (count + cellKeys) in `results`.
- Every method output rides in a Report whose `disclosures` block (§9.1)
  carries the input matrices' attrition, completeness, tier, pinning, and
  independence facts — a report that hides attrition is malformed, not
  conservative.
- Scores compare only within one Benchmark digest (§6.2, check
  `benchmark-comparability`); `clean-subset@1` is the only sanctioned way to
  score a subset, and it names its predicate and basis.

## 10. The application surface (tier 3)

### 10.1 Six operations

Working verbs, keyed to the runner's journey; names settle at implementation
planning.

1. **Import** — `bench import`: convert an existing dataset into sealed Tasks
   + a Benchmark record. First importer: SWE-bench-shaped rows (the
   `repository-work/1.0` profile already fits them). Also `bench define` for
   hand-authored sets. Content addressing kills ruler drift: cite the digest,
   get byte-identical tasks and judging forever.
2. **Plan** — a small declarative file (benchmark digest, arms, replicates,
   policy, analysis plan, budget) → the sealed Run record. One spec;
   execution venue is a dispatch choice, not a different toolchain.
3. **Quote** — side-effect-free validate + price: expected cell count, per-cell
   fees × cells, hard cap check, estimated duration; on local, time/disk
   estimates. Nothing signs, posts, or spends.
4. **Launch & watch** — dispatch cells as Submissions through the configured
   backend; live per-cell status (dispatch/claimed/delivered/judged), infra
   failures shown as infra (`unscorable` ≠ fail); crash-safe by construction
   via cell idempotency keys — interruption resumes the matrix, never
   restarts it. Cancel drains to a boundary and still assembles a matrix
   (`runOutcome: cancelled`).
5. **Report** — the reference consumer: `bench report <matrix>` → the two-arm
   diff with per-task regression/improvement highlighting, rates with error
   bars by default (replicates + clustered SEs; single-replicate point
   estimates are labeled as such), per-cell drill-down to transcripts via the
   evidence records; exports: native evaluation-runtime artifacts when present,
   a Jinn-owned Matrix projection, and a self-contained static bundle (private by default),
   and optionally a sealed Report record when the consumer wants to publish
   the interpretation.
6. **Verify** — the skeptic's command: `bench verify <matrix>` re-derives the
   matrix byte-for-byte (§8.3), verifies every signature and trust join,
   re-runs `re-derivable` verdicts where asked, and recomputes any Report
   presented against it. Exits nonzero on any divergence, with the specific
   named check that failed.

### 10.2 Inspect seams

Inspect (UK AISI) is becoming the substrate of the credible-evaluator
ecosystem (Epoch runs on it; METR's Hawk builds on it; lighteval backends onto
it). Posture: complementary, never competitive — Inspect standardizes how one
party runs an eval; this application standardizes how strangers believe each
other's evals. Three seams:

1. **Select from it** — a Tier 4 runtime adapter resolves an official Inspect
   task reference, records its exact task/package/environment identity, and
   creates Jinn Tasks that bind the resolved samples without translating the
   task, solver, or scorer into a Jinn-native implementation.
2. **Execute with it** — an Inspect executor launcher in the local backend
   (one more launcher beside claude-code/codex/hermes/cursor): the operator's
   machine runs Inspect under supervision; our layer wraps the evidence,
   lifecycle, and verdict records Inspect doesn't produce. Caveat honored:
   arbitrary Python solvers/scorers cannot be sealed as verifiable data —
   such tasks pin "Inspect task X at version/digest Y" and carry
   `attested-only` integrity unless admission evidence shows re-derivability.
3. **Retain its native output** — Inspect itself produces the EvalLog. Jinn
   retains those exact bytes as Delivery/evidence artifacts and opens them with
   Inspect View instead of synthesizing a log or building a viewer. The
   `benchmarking-interop` Matrix projection is explicitly not an EvalLog.

### 10.3 Anti-patterns honored (from the product survey)

Comparison is the center of the report, not an afterthought; one declarative
spec, no backend sprawl; per-cell price before commitment (no metered
cliffs); live per-cell status for remote execution (no opaque queues);
content-addressed pinned tasks (no drifting rulers); credibility independent
of this platform's survival (records outlive the application); no unlogged
discretionary process (pre-registration + mandatory stopping rule + visible
replacement lineage); drill-down reaches raw records, not just scores.

## 11. Discovery integration

Two parts, one of them the declared companion amendment of §2:

**New kinds (no amendment needed).** Benchmark, Run, Matrix, and Report are
new record kinds; discovery explicitly supports new kinds with their own
facts profiles supplied by their defining package (discovery §12 — unknown
kinds are skipped by non-consumers). This design defines facts profiles for
all four (fields: benchmark digest, owner IRI, version; run→benchmark
reference; matrix→run reference; report→matrix references — reference-bearing
fields declared so `referrers()` walks work), homed in a
`discovery/facts/benchmarking` leaf (§15).

**Shared kinds (the companion amendment).** Announcements of cell Submissions
and their Deliveries carry filterable attributes `benchrun` (Run record
digest), `benchcell` (cellKey), `bencharm` (armId), copied from the
Submission's benchmarking extension block. These land as **optional
namespaced fields added to the Submission and Delivery facts profiles** owned
by the task-execution profiles package, declared as CloudEvents filter
attributes per discovery §12 — an additive amendment (§2), tolerated as
unknown fields by non-benchmarking consumers per discovery §15.

Consequences:

- "All records for run Z" becomes `search(kind, { benchrun: Z })` plus
  `referrers()` walks — a discovery query rather than an out-of-band manifest
  walk. Set answers remain claims (`complete: boolean` per discovery §8);
  the Matrix remains the authoritative accounting.
- The Run/Matrix announcements by the owner are the ordering spine of
  `preregistration-precedes-dispatch` leg (c) (§7.2) and selective-disclosure
  visibility (§12.2).

Core discovery semantics are untouched; the amendment is field-additive only.

## 12. Trust and verification

### 12.1 Named checks

Consolidated (all introduced above): `benchmark-item-distinctness`,
`benchmark-judgeability` (third-party-executable at reveal; `unevaluated`
before), `reveal-consistency` (byte verification + reveal-coverage
reporting), `preregistration-precedes-dispatch` (three legs, §7.2),
`cell-correspondence` (map equality against pinning ∪ baseline),
`pinning-observation` (the per-axis verification of §8.1, over the evidence
Runtime Observation / #2041 attestation), `verdict-spec-match` (the profiles
§7.7 spec-digest equality rule, named here), `evaluator-independence`
(agent-distinct via trust-layer resolution, fail-closed on unresolved
identities; gating or disclosed per Run policy §7.1; the Sybil residual is
named, not solved, per the trust design's independence model),
`matrix-rederivation` (byte equality under §8.3), `benchmark-comparability`
(all of a Report's subject matrices resolve to one Benchmark digest, unless
the method pairs on shared Task digests and declares itself version-robust),
`report-recompute` (results reproduce from matrix + referenced verdict
records + method + parameters; enforces `benchmark-comparability` and the
`disclosures` faithfulness).

Signing map: Tasks/EvaluationSpecs sealed by the benchmark author; Submissions
signed per backend profile; Deliveries executor-signed; verdicts are DSSE
Result Evaluation Statements (profiles §9.2); Benchmark/Run/Matrix authority
comes from their signed discovery announcements by the publisher/owner;
Reports are DSSE-signed records under the registered namespaced trust binding
scope `benchmarking-reports` (following the discovery design's
`discovery-announcements` precedent, so trust §7.5 step 4's scope check is
executable). Suggested trust-policy purposes: `benchmark-publisher`,
`run-owner`, plus the existing `evaluator-eligibility`.

### 12.2 Selective disclosure and its named residuals

The Leaderboard Illusion failure mode — run many private variants, publish the
winner — works because unpublished runs leave no trace. On **anchored
venues**, a Run record is committed before its cells execute (§7.2 legs a–b):
a Run announced but never followed by a Matrix is itself a public artifact.
Running ten and showing one leaves nine tombstones. Consumers and trust
policies can price that.

Residuals, named honestly rather than hidden:

- **Local retro-registration.** On a self-run local venue, even a single
  announced run's pre-registration ordering is retro-constructible (§7.2 leg
  c) — the owner can execute first and append Run-then-cells afterward. Local
  runs prove reproducibility, not owner-honesty.
- **Rehearsal.** An owner can rehearse privately — on a local backend without
  announcing, or on the marketplace as ordinary non-benchmarking Submissions
  (public substrate traces, but not linked to any Run). Venue disclosure and
  committed benchmarks bound rehearsal; nothing eliminates it.
- **Analysis shopping.** Pre-registration covers the run; the *analysis*
  (method, parameters, clean-subset cutoffs) is chosen at Report time, and
  privately computed unfavorable analyses leave no tombstone. The
  `analysisPlan[]` mechanism (§7.1) lets an author claim analysis integrity
  (`preregistered: true`, checkable); for reports without it, attribution and
  the pinned clustering/parameter rules (§9.2) are the deterrents. This is
  the run-layer illusion reopened one layer up; it is bounded, not closed.

### 12.3 Threat table (summary)

| Threat | Control | Residual |
|---|---|---|
| Question-swapping after results | commitment via item digests; `reveal-consistency` | — |
| Partial reveal (commit 100, reveal 40) | reveal-coverage reporting in `reveal-consistency`; completeness in Report `disclosures` | arm-symmetric withholding invisible to asymmetry flags (named §8.1) |
| Cherry-picking cells / hiding attrition | pre-registered expected set; `matrix-rederivation`; attrition + asymmetry flags; §9.3 | — |
| Best-of-N run selection | Run-before-cells anchoring; tombstoned unmatrixed runs (§12.2) | local retro-registration; rehearsal (§12.2) |
| Optional stopping (peeking) | `closeAt` mandatory and pre-registered; boundary pinned to it; cell windows clipped | `cancelled` closes early but is labeled and floor-checked |
| Method/analysis shopping | `analysisPlan[]` + `preregistered` flag; pinned clustering key; parameter bases disclosed | un-planned reports deterred by attribution only (§12.2) |
| Wrong config actually ran (model/loadout swap) | `cell-correspondence` + `pinning-observation`; mismatch ⇒ `invalidated`; Report `disclosures.pinning` | pre-#2040/#2041, axes are `unverifiable` — disclosed, not hidden |
| Targeted arm sandbagging / claim-griefing on open venues | arm execution allowlists (§7.1); replacement; attrition asymmetry flags; recommended proponent-executes posture | sandbagging by allowlisted or Sybil-distinct claimants; named, not solved |
| Self-judging | `evaluator-independence` gating (open venues); `disclosed` mode surfaces it in matrix + Report | single-party Sybil IRIs (below) |
| Sybil solver/evaluator pairs | named residual (trust §10); marketplace §7.5a settlement join raises cost; not claimed solved | party-independence unprovable |
| Sybil-evaluator induced unscorability + replacement (cell-level best-of-N) | all dispatches in the trail; per-arm replacement counts in attrition; asymmetry flags; permissive `recorded-inconclusive` predicates visible in the (public) EvaluationSpec | named; consider re-derivable-tier grading for replaced cells (product policy) |
| Grader with hidden input-keyed backdoor (private grader) | integrity tiers from admission receipts; `attested-only` never launderable; profiles §7.5 warning inherited: pass verdicts under requester-supplied private graders are not verified work without additional controls | named |
| Contamination-date forgery | `clean-subset@1` basis disclosure (`self-declared` vs `announcement-anchored`) | self-declared dates are unattested claims; named in §9.2 |
| Aggregator distortion | consumer-side re-derivation; `report-recompute`; mandatory `disclosures` | — |
| Platform death | records + announcements are backend-anchored and self-contained; nothing cites this application | — |

## 13. Backend profiles

What varies by execution venue, declared rather than smoothed over:

| Concern | Local backend | Marketplace binding |
|---|---|---|
| Run pinning | `enforced` (backend guarantees the pinned config runs) | `attested` (conveyed as claim constraint; verified after the fact against evidence; mismatch ⇒ `invalidated`) |
| Budget | absent | required (`perCell`, `hardCap`); escrow per binding |
| Attempts per Submission | `1..1` (backend v1 bound) — replicates are separate Submissions anyway | binding's declared bounds |
| Pre-registration strength (§7.2) | leg (a) structural + leg (c) append-order only — no third-party time bound; no guarantee against the owner | legs (a)+(b)+(c): anchored, trust-bearing |
| Close boundary | `closeAt` timestamp | `closeAt` + first `finalized` block at/after it (anchor required) |
| Cost fields | `reported` (from evidence resource observations) | `settled` (from escrow settlement) where available, else `reported` (per §8.3 sourcing) |
| Venue label | `self-run` | `open-competition` (self-declared; see §7.1) |
| Evaluation dispatch | application dispatches evaluation cells itself; no `evaluationRequirements` block (local backend §9.1 would reject it) | `policy.evaluation` mapped via the marketplace deployment profile |
| Committed-benchmark privacy | items private until reveal | items public at post time (§6.4) |

Evaluation cells run through the same machinery on both (evaluation-as-task;
the local backend's evaluation harness or marketplace evaluation legs).

## 14. Frozen interfaces

Frozen on approval of this design (working names; final names at
implementation planning, one naming pass):

1. The four sealed record kinds and their media types: Benchmark, Run,
   Matrix, Report (§6–§9), including field semantics and constraints (the
   six-value outcome vocabulary, the required `closeAt`, the Report
   `disclosures` block).
2. `cellKey` grammar and the expected-cell-set enumeration (§7.3): 1-based
   minimal-decimal replicate, `armId` charset, lowercase-hex task digest.
3. The Submission benchmarking extension block shape and the idempotency-key
   derivation (§7.3).
4. Outcome derivation rules (§8.2) and the deterministic assembly procedure
   contract (§8.3) — input scope, trust-resolution pinning (steps 1–4 at
   effective time), optional-field sourcing — versioned via
   `assembly.procedure`.
5. Integrity-tier sourcing rule (§8.4): receipts-or-attested-only, never
   self-declared.
6. The named checks of §12.1 (including `benchmark-comparability`) and the
   `benchmarking-reports` trust binding scope.
7. The method-registry contract (§9.2): URI+version identification, declared
   inputs/parameters/output shape, the `verdictRule` reduction, the pinned
   clustering rule, §9.3 exclusion discipline.
8. The benchmarking facts profiles for the four new kinds, and the companion
   amendment's namespaced fields on the Submission/Delivery facts profiles
   (§11).
9. The Jinn Matrix and Croissant exports as fixture-pinned projections;
   Inspect EvalLogs are validated native runtime artifacts (§10.2, §6.5).
10. The backend-profile table's normative rows (§13): pinning posture,
    pre-registration strength, close-boundary anchor requirement, cost
    source semantics, evaluation-dispatch conditionality.

## 15. Packages (working titles)

- `benchmarking/records` — the four record kinds, sealing, checks (tier 2;
  imports protocol layers only).
- `benchmarking/run` — plan/quote/dispatch/watch/assemble over the TEP
  backend contract (tier 3; backend injected).
- `benchmarking/aggregate` — the method registry + reference implementations
  + Report production/verification (consumes matrices; never imports the run
  orchestrator).
- `benchmarking/interop` — data importers such as SWE-bench and Jinn-owned
  projections such as Matrix JSON, Croissant, and static bundles. Real Inspect
  task selection/execution and native EvalLogs stay in a Tier 4 runtime adapter.
- `discovery/facts/benchmarking` — the facts-profile leaf for the four new
  kinds (the designed home for kind↔discovery edges), plus the companion-
  amendment fields delivered into the task-execution facts profiles per §11.
- `benchmarking/testing` — the conformance kit (§16).

Dependency direction: `records` ← {`run`, `aggregate`, `interop`}; the facts
leaf depends on `records` + discovery only; nothing imports a product; per
stack rule, kits precede implementations. New package trees get the
evidence-tree's executable-architecture guards.

## 16. Conformance kit

Golden fixtures, authored before implementation:

- Sealed fixtures of all four record kinds (valid + minimal + invalid-per-
  constraint variants, including a missing-`closeAt` rejection).
- A committed-benchmark reveal fixture (`reveal-consistency` positive +
  tampered-item negative + partial-reveal coverage report).
- A full miniature run: benchmark (3 items) × 2 arms × 2 replicates, with the
  complete record set (Submissions with extension blocks, Deliveries,
  verdicts, evidence stubs) and the byte-exact expected Matrix —
  the `matrix-rederivation` fixture, exercising every outcome (`judged`,
  `unjudged`, `unscorable`, `expired`, `invalidated`, `excluded`), a
  replacement lineage, a multi-verdict cell, and an asymmetry flag.
- Method fixtures: for each §9.2 method, an input matrix + parameters + exact
  expected `results` (the `report-recompute` fixture), including the pairing
  exclusion, `verdictRule` conflict, and clustering cases; a
  `benchmark-comparability` violation fixture (marginal method over
  cross-version matrices).
- Export fixtures: Jinn Matrix and Croissant projections of the miniature run;
  a real runtime adapter separately validates native Inspect logs with Inspect.
- Ordering fixture: an announcement-chain + anchor transcript exercising
  all three legs of `preregistration-precedes-dispatch` (anchored positive,
  anchored violation, and the local append-order-only case labeled as such).

## 17. Declared impact

Documents and issues only; nothing changes in code or on GitHub this session.

1. **`2026-07-22-solvernet-benchmarking-primitive-design.md` v0.2 (draft PR
   #2002)** — superseded by this spec. Its disciplines survive re-expressed:
   pre-registration (§7), consumer-side aggregation (§9), integrity tiers
   (§8.4), the §1.5 no-winner boundary (tenet 3), attrition/asymmetry
   honesty (§8.1). Disposition: close the draft PR with a pointer here, or
   land the old doc with a superseded header — either is acceptable; the
   epic's issue tree is the operative surface either way.
2. **Epic #2038** — by bucket:
   - *Merged, carries forward untouched*: #2039 (execution-profile pinning —
     the closest existing implementation of tasks-carry-profiles; vocabulary
     reframe tracked by the stack's own migration follow-ups, not here),
     #2042 (generator phase ledger).
   - *In-flight, runs to completion*: #2044 (lifecycle evidence through
     discovery) via PR #2219 — the one nearly-done item; it improves the
     live product now and its shape informs projector #1.
   - *Closed as re-homed (2026-07-28)*: #2040, #2041, #2043, #2045. Their
     capabilities are not dropped — they are owned by the stack designs at
     component boundaries, and are implemented as stack-program work on the
     evidence-v1 lineage rather than as issues against `next`'s current
     engine (building them there would pay for each twice). The homes:
     task-owned loadout materialization → the local backend's Workspace
     Provisioner (its §7.2/§8.1: digest-verified, fail-closed; the profiles
     `loadout` pinning key absorbs #2040's typed kinds); isolation → the
     local backend's per-attempt directory contract (ephemeral
     `harness-state/`, wiped `secrets/`, hermetic invocation) with
     effective-execution attestation → the evidence Runtime Observation
     (profiles §5.2 cites #2041 as this mechanism); post outcomes / exact
     escrow → the marketplace binding's posting and reservation-escrow
     sections plus the 2026-07-24 broadcast-intent design; evidence
     authentication → trust §7.5 plus the marketplace binding's settlement
     joins and discovery's per-item verification. (#2041's per-attempt
     credential isolation also has security value for the live fleet; if
     live-fleet hardening becomes urgent before the stack lands, reopen a
     narrowly-scoped fix rather than the full old-engine build.)
   - *Merged, superseded by design*: #2046's SDK contracts (`BenchmarkRunV1`,
     `ConfigV1`, `CellV1`, `BenchMatrixV1`, `BenchPreregistrationV1` in
     `packages/sdk/src/benchmarking.ts`). The code stays until the §6–§9
     records land; then it retires. No consumer migration is owed (nothing
     ships on those shapes).
   - *Open benchmarking-specific, to be re-derived from this spec*:
     #2047–#2054. Their intent maps nearly one-to-one (capsule admission →
     Benchmark import + admission receipts; preregister/price → Run + Quote;
     orchestrate-under-cap → §10.1 op 4; freeze/publish matrix → §8;
     validation/run-control surfaces → §10.1 ops 3–6; the local/Anvil/testnet
     proving rungs → conformance kit + backend profiles). Re-framing is a
     rewrite of vocabulary, not of substance.
3. **Capability-eval v0** — not superseded; promoted. Its statistics seed the
   reference library (§9.2); its held-out boundary becomes a committed
   Benchmark (§6.4); its DR and gate semantics stand. Future exam runs MAY
   execute as benchmark runs over the local backend; nothing forces migration.
4. **The skill-factory design** (unmerged) — its Block-2 dependency now points
   here; a candidate skill is an arm, its benchmark report is a Report. The
   factory itself remains a future product design.
5. **Companion amendments to the stack: one.** The Submission and Delivery
   facts profiles (task-execution profiles package) gain optional namespaced
   benchmarking fields per §11 — additive-only, unknown-field-tolerant,
   declared here rather than assumed. Everything else consumes the
   2026-07-27/28 stack as frozen. (The discovery design's open item on
   facts-profile governance for shared kinds, discovery §22, gets its first
   concrete data point from this amendment.)

## 18. Sequencing and dependencies

1. Requires the TEP stack implementation (protocol, profiles, trust,
   discovery, local backend) — in flight as the stack implementation program.
2. `benchmarking/records` + kit can begin once TEP/profiles records and
   sealing land; `benchmarking/run` needs the backend contract green;
   marketplace mode needs the marketplace binding implementation. The
   companion facts-profile amendment lands with the profiles package's facts
   work.
3. The run-pinning enforcement capabilities — task-owned loadout
   materialization and isolation + effective-execution attestation (formerly
   issues #2040/#2041, closed as re-homed into the stack program per §17.2)
   — gate honest `verification` fields on open backends; before they land,
   marketplace cells report `unverifiable` axes honestly (and Reports
   disclose it) rather than blocking.
4. The re-derived #2047–#2054 issue tree happens at implementation planning,
   not in this session.

## 19. Non-goals

- No ranking or leaderboard record beyond the Report; no "official" leaderboard.
- No task-authoring framework and no log viewer (Inspect's territory; §10.2).
- No group-verdict evaluation record: comparisons are consumer-side over
  per-cell verdicts (profiles keeps evaluation strictly per Task/Result pair).
- No confidential-execution tier (private-until-reveal on open backends waits
  on a confidential-execution design; §6.4 states the honest limit).
- No dynamic pricing (flat per-cell fees; deferred with knowledge-pricing).
- No further protocol amendments beyond the declared §17.5 facts-profile
  amendment; no product implementations.

## 20. Follow-ups

- Repo-wide taxonomy docs pass: applications vs products; reconcile with
  TEP's binding/application vocabulary (§2).
- Matrix-validation-as-a-task: a marketplace task that independently
  recomputes someone's matrix — a trust product candidate, not v1.
- `attested-only` admission thresholds (carried from the profiles design's
  open list).
- Facts-profile governance for shared kinds (discovery §22) — this design's
  companion amendment is the first data point; a general rule belongs to the
  discovery design's follow-up, not here.
- Named subsets/weights on Benchmark records (§6.6) if demand appears.
- Bradley-Terry activation if pairwise-judged benchmarks appear (§9.2).
- Re-derivable-tier grading requirement for replaced cells (product policy
  candidate; §12.3).

---

## Appendix A — Session decisions (resolved-question log)

1. **One backend-neutral application** (vs marketplace-only, vs two apps over
   a shared core) — decided: one; marketplace and capability-eval become
   products over it.
2. **Applications vs products taxonomy** — adopted; this design spans tiers
   2–3 only.
3. **Benchmark record is a thin set-namer** — per-item provenance lives in
   Task payloads; sealed digest replaces bespoke set hashes; commit-reveal is
   a publishing schedule over content addressing.
4. **Run identity = pre-registration** — `runId` and `preRegistrationHash`
   collapse into the sealed Run digest + announcement/anchor ordering.
5. **Matrix is a completeness claim** — deterministic byte-identical assembly;
   no aggregates ever; missing reported missing.
6. **Report as a fourth record kind** — signed, attributable, recomputable;
   the only always-DSSE-signed record here.
7. **Inspect posture** — use, never compete: select existing tasks, execute
   through Inspect, retain its native logs, and use its viewer; no synthetic
   EvalLog, viewer, or authoring framework.
8. **#2038 disposition** — (revised in v0.3) let #2044/PR #2219 finish;
   close #2040/#2041/#2043/#2045 as re-homed into the stack designs;
   supersede the SDK shapes; re-derive #2047–#2054 from this spec.

## Appendix B — Review disposition (2026-07-28)

Architecture review: sound-with-fixes (3 blocking, 6 non-blocking, 5 notes).
Adversarial review: hold-with-fixes (2 blocking, 8 strong non-blocking, 2
wording). Deduped blocking findings and their resolutions, all applied in
v0.2:

1. *Facts-profile hook for shared kinds does not exist* → declared companion
   amendment (§2, §11, §17.5); facts leaf package added (§15).
2. *Unconditional evaluator-independence makes honest single-identity local
   runs unjudgeable* → pre-registered `policy.independence: gating |
   disclosed` (§7.1, §8.2); evaluation-requirements made backend-conditional
   (§7.1, §13).
3. *Verdict multiplicity makes `report-recompute` ambiguous* → `verdictRule`
   contract input with `unanimous` default, `validVerdicts[]` on cells,
   recompute claim restated (§8.1, §9.1, §9.2).
4. *`cells[]`/`exclusions[]` representation ambiguity breaks byte-determinism*
   → exactly-one-entry-per-expected-cell pinned; `excluded` (and `unjudged`)
   outcomes added; floor arithmetic defined (§8.1, §8.2).
5. *Pre-registration unanchored on the local venue; tenets overclaimed* →
   three-leg check with per-backend strength (§7.2); tenets 1–2
   venue-qualified (§5); residuals named (§12.2); backend table row added
   (§13).

Non-blocking resolutions: mandatory `closeAt` + window clipping
(optional-stopping); pinned clustering key; `analysisPlan[]` + `preregistered`
flag (analysis shopping); arm execution allowlists + sandbagging threat row;
`clean-subset@1` basis disclosure; Report `disclosures` block (pinning,
independence, completeness, attrition); `benchmark-comparability` named
check; cellKey grammar; assembly determinism pinning (trust resolution steps
1–4, optional-field sourcing, input-scope wording); `benchmarking-reports`
DSSE scope; exclusion-hit semantics; committed-benchmark dispatchability and
check-timing notes; partial-reveal coverage; independence-wording softening
throughout (§1, §3, §7.1); citation fix (profiles §13, not TEP §13); tier-3 /
TEP-binding vocabulary note (§2).
