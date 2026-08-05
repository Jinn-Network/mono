# Policy Optimization live host and guided journey

**Status:** approved implementation design
**Date:** 2026-08-05
**Base:** `integration/evidence-v1`
**Extends:** `2026-08-03-policy-optimization-product-design.md`

## 1. Decision

Jinn Policy Optimization remains the evidence-backed policy-improvement loop described by the
product design. It maintains identifiable policy candidates for a Task family, evaluates them
through ordinary Tasks, preserves attributable and recomputable evidence, and gives each operator
a recommendation rather than declaring a central winner. Candidate generation remains open and
replaceable. Adoption remains local.

This design adds the first complete operator journey and the missing live host. The standalone
`jinn-optimize` executable captures the exact policy a selected route would use next, freezes an
eligible SupplyPool into training, development, and promotion partitions, dispatches real solve
and evaluation Attempts, computes registry-owned comparisons, and prepares an operator-approved
configuration change and rollback.

The first venue is deliberately narrow: local, loadout-only, SWE-rebench-shaped, same operator,
same host, same OS user. Those are launch constraints rather than permanent product boundaries.
The public engine, proposer contract, policy identity, evidence records, recommendation semantics,
and adoption model remain venue-neutral.

## 2. Product guarantees and non-claims

The guided journey guarantees:

- the seed policy is derived from exact next-run Task, Submission, profile, route, and loadout
  bytes rather than a remembered or reconstructed setup;
- the split is one immutable content-addressed artifact with whole-source grouping and explicit
  exclusions;
- development chooses exactly one challenger before promotion is revealed;
- promotion is evaluated through ordinary Task Execution Protocol Attempts and signed evaluation
  evidence;
- every recommendation is a deterministic projection of exact Run, Matrix, Report, and registered
  method results;
- no live route or daemon configuration changes without the operator.

The v0 host does **not** claim confidential held-out material, hostile-candidate isolation,
cross-operator independence, party-independent evaluation, or tamper resistance against other
processes running as the same OS user. Its Runs declare `independence: "disclosed"` and explain:
"separate evaluator role and signer; same operator, host, and OS user."

Detailed progress/waiting UX, monetary budget displays, rich mid-run failure UX, continuous
optimization, automatic apply/canary, and hostile cross-operator execution remain deferred.

## 3. Operator journey

### 3.1 Entry points

`jinn-optimize` is this product's own executable. A bare invocation starts the guide only when
stdin and stdout are TTYs. A headless bare invocation prints help and exits without creating state,
sealing records, or dispatching work. Explicit flags and an authored campaign document compile to
the same artifacts as the guide; there is no separate easy-mode execution path.

The guide asks for one route when more than one is eligible. It never chooses the first route,
largest tuple class, or latest successful execution. It then:

1. reads a coherent next-run snapshot;
2. validates and groups the selected SupplyPool;
3. seals the split and objective preset;
4. captures the current policy tuple seed;
5. prepares candidate-generation evidence from training only;
6. shows the complete plan and same-operator limitation;
7. asks once for execution confirmation;
8. executes development, freezes one challenger, and executes promotion;
9. renders the recommendation and explicit adoption actions.

### 3.2 Next-run policy snapshot

`NextRunPolicySnapshot/1.0` is a versioned, read-only wire contract supplied by the operator host.
The request names the route and exact Task/profile inputs being audited. The response carries:

- one `configRevision` covering the complete batch;
- the resolved route and safe route diagnostics;
- exact canonical Submission bytes and digest for each Task;
- the resolved task profile, harness, model, plugins, isolation policy, and requirement bindings;
- the current policy tuple seed and its exact public loadout artifact bytes and digest;
- no secret values, credential references, private environment values, or signer material.

The consumer independently exact-parses every document, recomputes every digest and tuple, and
requires one unchanged `configRevision` through final adoption preparation. Revision drift is a
stable preflight refusal. The snapshot never fabricates a CandidateManifest and never falls back
to a previous successful attempt.

Before loadout sealing, the host applies the ratified `learner-public.v1` path profile and the
fail-closed secret/private-path scrub to every included file. The excluded roots include `.git`,
`operator-requests`, `secrets`, and `transcripts`; unknown roots and unsafe filesystem entries are
refused. Detection rejects the snapshot rather than redacting it. Captured bytes and object stores
remain private and are not published or exported in v0.

### 3.3 SupplyPool and split

The guide reads one selected local SupplyPool and verifies exact Task bytes, EvaluationSpec bytes,
environment record, admission receipt, and all referenced digests. Eligibility is established
before allocation. Items are excluded when malformed, unscorable, policy-incompatible, already
attempted, previously revealed, contaminated, duplicate-lineage, or missing an exact route-derived
tuple class.

Task derivation must seal an honest immutable upstream provenance timestamp alongside exactly one
of `source` or `sourceCommitment`. For SWE-rebench imports, the timestamp comes from immutable
upstream dataset/row provenance supplied to derivation. Host wall time is forbidden. Pools whose
Tasks predate that field must be regenerated and re-admitted; benchmarking admission is not
weakened.

Groups are connected components over both repository equality and source-lineage equality. If any
two Tasks share either relation, their transitive component is indivisible. Group identifiers are
normalized, domain-separated digests over the sorted member Task digests and normalized relation
keys, never caller-provided labels.

The authoritative attempted/consumed set is an append-only local campaign index, not SupplyPool
metadata. It includes every promotion Task or group ever revealed or dispatched by any campaign.
A promotion group is consumed on first reveal or dispatch; cancellation, infrastructure failure,
or an inconclusive result never makes it reusable.

`PolicyOptimizationSplitManifest/1.0` is strict RFC 8785/I-JSON. Duplicate object keys, invalid
Unicode scalars, unsafe numbers, non-canonical digest spellings, and unknown nested fields are
refused before ordinary JSON projection. Only namespaced top-level extensions are allowed. The
manifest records:

- protocol/version and allocation-algorithm version;
- SupplyPool snapshot digest and sorted eligible Task digests;
- deterministic inclusion and exclusion entries with reason codes;
- selected execution tuple class;
- group-extractor version and normalized connected components;
- a deterministic split seed;
- training, development, and promotion assignments;
- training evidence/query, revealed development Benchmark, and committed promotion Benchmark
  references.

Allocation reserves promotion first, development second, and assigns the remainder to training.
The minimums are 3 training groups, 3 development groups, and 6 promotion groups. All groups above
the twelve-group minimum go to promotion. An item-level fallback, padding, or silent ratio is
forbidden. The floor makes a proof outcome attainable but is not a power guarantee.

The product supplies only training evidence to its proposer. Development is available after
candidate sealing. Promotion is committed but not made available through the product proposer
interface until exactly one promotion Run is sealed. This is an interface discipline, not a
same-UID confidentiality guarantee.

## 4. Objectives and recommendation

Objective presets are versioned product intent which compile exclusively to registered
benchmarking MethodRefs. The product implements no estimator.

### 4.1 `more-tasks-succeed@1`

The default quality-first preset compiles to:

- `jinn.benchmarking.method/avg-at-k@1`, descriptive;
- `jinn.benchmarking.method/paired-mcnemar@1`, exact task-level paired comparison;
- `jinn.benchmarking.method/provenance-cluster-sign@1`, exact whole-provenance-group comparison.

`paired-mcnemar@1` remains byte-for-byte replay compatible. Its normal-approximation
`clusteredPValue` remains legacy descriptive output and is never a proof gate.

`provenance-cluster-sign@1` resolves the same paired judged baseline/challenger outcomes and the
same Task provenance clusters. Within each cluster it sums task deltas (`+1` improvement, `-1`
regression), turns positive/negative sums into one cluster vote, and excludes a zero sum as a tied
cluster. It reports favorable, unfavorable, tied, and non-tied clusters plus the exact two-sided
binomial sign-test probability for the non-tied votes. Six uniformly favorable groups yield
`2 / 2^6 = 0.03125`; five cannot cross `.05`.

Development evaluates the baseline and all admitted candidates. Before promotion reveal it selects
exactly one challenger only when the candidate passes fidelity/constraints and has a strictly
higher registered `avg-at-k` result than the baseline and every other candidate. Ties or no
improvement select no challenger. Digest ordering is display ordering only.

Promotion contains exactly the baseline and frozen challenger with `replicates: 1`. The derived
recommendation is `proven-challenger` only when:

- the preregistered promotion Run is complete and all required cells are judged;
- fidelity, payload consent, and objective constraints pass;
- improved Tasks exceed regressed Tasks;
- exact McNemar `pValue < .05`;
- exact provenance-cluster sign `pValue < .05`.

Every other state produces `keep-current` and stable reason codes. The result is a deterministic
`RecommendationDecision` projection, not a new sealed authority record. Persisted caches or journal
events carry only input references and cannot replace re-derivation.

### 4.2 `same-success-lower-cost@1`

The alternate preset compiles to `noninferiority-iut@1` with `verdictRule: "sole"`, 10,000
resamples, and a non-zero uint32 seed derived by a versioned domain-separated hash of the split
manifest digest. It uses the registry method's frozen 5-point absolute and 15% relative quality
limits and its one-sided paired lower-cost gate. Cost and latency remain observations rather than
winner inputs under the quality-first preset.

### 4.3 Adoption and operator override

Normal adoption is a separate explicit command. It records consent bound to route, payload class,
tuple digest, recommendation input digests, and base `configRevision`, then prints the exact
next-run configuration change and exact rollback. It never writes the daemon configuration.

An inconclusive challenger may be prepared only through `--override-inconclusive`. The command
requires an override reason, repeats the evidence warning, requires explicit confirmation in the
interactive path, records the recommendation status and reason, and still performs all payload and
revision checks. The override preserves operator authority but does not change the evidence label
or manufacture proof.

## 5. Live local host

Concrete composition is private under `src/host-local/`; the package root does not re-export it and
the engine never imports it. Only the process wrapper may compose the host. The source-boundary
guard permits concrete task-execution, evidence, profile, launcher, workspace, and trust packages
from that subtree and continues to deny them everywhere else. No client implementation is reused
or imported.

The host creates two role-scoped instances of the local TaskExecutionBackend with separate private
state roots, attempt namespaces, OS locks, source/executor identities, and keys. This explicitly
amends the local-backend design's "one instance per hosting product" and "evaluation is the same
backend" wording: one hosting product may create one instance per declared execution role when
their namespaces and roots are exclusive. The abstract backend API and lifecycle remain unchanged.

For each cell the host:

1. resolves exact Task, profile, EvaluationSpec, environment, loadout, candidate, and Submission;
2. verifies positive pinning admission;
3. durably stores prepared Submission bytes and semantic identity before submit;
4. dispatches the solver Attempt and retrieves the exact Delivery and Results;
5. deterministically derives the evaluation Task and Submission from Run, cell, Delivery digest,
   and EvaluationSpec digest;
6. dispatches evaluation through the evaluator backend;
7. validates the unsigned canonical evaluator statement against exact Attempt subjects and bytes;
8. signs the Result Evaluation with the evaluator Agent key outside the sandbox;
9. assembles Matrix cells with pinning, admission, evidence, cost, and latency references.

The SWE-rebench grader is a host-owned implementation behind the evaluator adapter contract. Its
OCI image is pinned by manifest digest and platform tuple. It runs with bounded time, bounded output,
read-only inputs, ephemeral writable work, deterministic cleanup, no credentials or signing
material, and network disabled unless the profile explicitly requires and pins network behavior.
Operational failure remains unjudged infrastructure failure and never becomes a failing verdict.

The solver Delivery signer, evaluator verdict signer, Report author, and journal author use separate
keys and purpose-scoped trust bindings. The grader chooses none of those identities, subjects,
EvaluationSpecs, or keys. On ingest the host verifies DSSE key ID, author binding, payload type,
subjects, and exact predicate bytes.

## 6. State, recovery, and cancellation

The state root defaults to the platform's private XDG data directory and may be overridden with
`--state-dir`. Directories are `0700`; ordinary files and keys are `0600`. Writes are atomic,
non-following, and reject symlinks or path escapes. Immutable artifacts are content-addressed;
mutable coordination is append-only.

A process-scoped OS advisory lock covers replay, external side effects, and journal append. The host
refuses to run when locking is unavailable. A stale lockfile is not treated as proof of ownership.

The journal reducer enforces relational, not merely phase-level, invariants:

- one plan precedes and binds each Run;
- arm identity is stable across plan, Run, Matrix, and Reports;
- every Matrix references the exact closed Run and prepared submissions;
- Reports follow their Matrix and registered MethodRefs;
- there is exactly one promotion Run;
- recommendation and closure require every gate and active attempt to resolve.

Prepared Submission bytes are journaled before first submit. Recovery exact-parses the bytes and
verifies Task, requester, requirements, run/cell/arm, nonce, dispatch, and idempotency bindings.
Evaluation Task and Submission identities are deterministically recomputed. Identical record
reannouncement deduplicates by digest; different records occupying one semantic scope are fatal.

Cancellation first persists `cancellation-requested`, transitions to `CANCELLING`, and forbids new
dispatch. Backend cancellation is then signalled, and a fresh non-aborted wait context drains every
solver and evaluator Attempt to a durable terminal state. A crash resumes in `CANCELLING` rather
than dispatching. Results that become terminal after `closeAt` remain valid evidence records but are
excluded from that Matrix and cannot revise its recommendation. Promotion never extends, reseals,
or changes its challenger after reveal.

## 7. Reconciliations from fresh review

The architecture review required and this design adopts:

- role-scoped two-backend composition as an explicit local-backend design amendment;
- immutable upstream provenance timestamps and pool regeneration;
- coherent batch snapshots and typed current-policy seeds;
- connected-component grouping and a separate attempted/consumed index;
- host-side verdict signing, exact identity/key roles, and private concrete composition;
- prepared-submission durability, exact recovery correspondence, and stale-adoption refusal.

The adversarial review required and this design adopts:

- replacement of the few-cluster normal approximation with an exact registry-owned cluster sign
  method;
- durable cancellation intent and real terminal draining;
- disclosed same-operator independence and refusal of imported/cross-operator candidates;
- exact recovered-Submission validation and semantic-scope conflict detection;
- relational journal invariants, OS advisory locking, strict canonical split parsing, consumed
  promotion sets, loadout scrubbing, exact signer authority, and a fully specified cost preset;
- `RecommendationDecision` as a local projection and no cross-operator or confidential-holdout
  claim.

Both review blockers are resolved by this document; their recommended optional interoperability
export to MLCommons Croissant remains deferred because Croissant does not carry Jinn's commitment,
grouping, exclusion, and withheld-Task semantics.

## 8. Acceptance

The implementation is accepted only when:

- six favorable clusters produce `.03125`, five cannot pass, and ties/mixed/relabelled clusters
  produce the documented deterministic result;
- derivation fixtures carry honest timestamps and regenerated SupplyPool Tasks pass benchmarking
  judgeability without weakening checks;
- two live backend instances prove exclusive roots, identities, keys, and locks;
- a tiny real container grader produces an unsigned statement which only the host can sign;
- no fixture verdict can satisfy the live host path;
- crash/restart succeeds at prepared, accepted, solver-delivered, evaluation-prepared,
  evaluation-delivered, cancellation, close, and late-result boundaries;
- adversarial substitution, signer confusion, secret-bearing loadouts, symlink escape, imported
  candidates, promotion replay, and post-reveal mutation fail closed;
- guided, flagged, and authored-document paths seal byte-identical campaign inputs;
- normal and override adoption both remain non-mutating and refuse configuration drift;
- package tests, source-boundary guard, dependency inventory, build, pack smoke, and a real
  SWE-rebench campaign pass.
