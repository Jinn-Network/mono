# Spike: Colophon publication across Harbor and the Jinn marketplace

- **Date:** 2026-08-13
- **Shape:** narrow design spike; no protocol or implementation change
- **Question:** What must Colophon persist so one published benchmark record remains honest and
  portable whether a task ran directly through Harbor or through a Jinn marketplace operator that
  used Harbor?
- **Out of scope:** marketplace scheduling, operator selection, settlement design, a Harbor remote
  provider, and implementation planning for either runtime adapter.
- **Follow-up:** [Benchmark Publication Interoperability Profile](../superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md)

> **Resolution after design review:** the follow-up profile is authoritative. It adds the reusable
> `BenchmarkAccounting` record, separates analysis preregistration from public-registration timing,
> preserves legacy raw Report v1 while introducing signed Report v2, and limits no-rerun
> publication to Jinn-managed runs. Arbitrary historical Harbor import remains deferred.

## Verdict

This is relevant to publication, but only at the execution-provenance seam.

Colophon must model **venue** and **runtime** as independent axes:

| Axis | Examples | Owner |
| --- | --- | --- |
| Venue: where execution is commissioned | direct/self-run; Jinn marketplace/open competition | benchmarking application + venue binding |
| Runtime: how an accepted attempt is executed | Harbor; Inspect; Jinn-native | runtime/executor adapter |
| Publication: what durable public account is emitted | Run, dispatch lineage, evidence, Matrix, Report | Colophon over Jinn publication machinery |

Do not introduce combined modes such as `harbor-local` and `harbor-marketplace`. A Jinn operator
can accept a marketplace Submission and execute it using Harbor. Conversely, a publisher can run
the same Harbor task directly without using the marketplace. The publication shape should remain
the same; the evidence and assurance level differ.

The narrow publication interoperability profile is worth designing now. A full Harbor execution
or marketplace-distribution profile is not.

## Intended composition

```text
                         one sealed Benchmark + Run
                                     |
                     one Submission per cell dispatch
                                     |
                     +---------------+---------------+
                     |                               |
              direct/self-run                Jinn marketplace
                     |                               |
              local executor                 operator accepts work
                     |                               |
                     +----------- Harbor Trial -----+
                                     |
                        Delivery + native evidence
                                     |
               BenchmarkAccounting -> Matrix -> signed Report v2
```

In the first marketplace composition, the Jinn benchmarking runner owns the cross-cell schedule.
The requester posts one ordinary TEP Submission per cell dispatch. The selected operator may use
Harbor to execute the corresponding Trial. Harbor therefore owns task execution inside an
Attempt, while Jinn owns distributed commissioning and public accounting around Attempts.

Do not initially run a Harbor Job scheduler and a Jinn marketplace scheduler over the same cells.
That creates two retry, concurrency, and cancellation authorities. A future Harbor provider or
remote-execution integration may batch work, but it must preserve the same one-cell-dispatch to
one-TEP-Attempt accounting boundary.

The Harbor adapter must also disable internal Trial retries beneath one Jinn dispatch. Any retry
that executes work is authorized by the Jinn runner as a visible replacement dispatch.

The mapping is therefore:

| Harbor / marketplace fact | Jinn publication meaning |
| --- | --- |
| Harbor task package | Material referenced by one Jinn Task |
| Harbor dataset snapshot | Material referenced by one Benchmark |
| Harbor Trial | One actual execution of a cell dispatch; normally one TEP Attempt |
| Harbor Job | Operational grouping only: it may correspond to the whole Run in direct mode, but marketplace operators may each create their own one-or-more-Trial Job |
| Marketplace request | The posted Submission at this venue |
| Marketplace claim/assignment | The operator engagement that creates or identifies the Attempt |
| Harbor result/reward | Native evidence supporting Delivery and Evaluation |

`Harbor Job == Jinn Run` is therefore a useful direct-mode correlation, not an identity rule.
Benchmark cell Submissions should explicitly seal `attempts.maxTotal = 1` and
`attempts.maxConcurrent = 1`; additional planned executions are replicates or visible replacement
dispatches, never multiple opaque competing Attempts under one cell Submission.

## Why the current stack fits

The platform already has the correct lower-level separation:

- `@jinn-network/benchmarking-run` dispatches through an injected, backend-neutral
  `TaskExecutionBackend`.
- `@jinn-network/benchmarking-marketplace` composes that same runner with marketplace-derived
  close, input-scope, cost, and ordering ports.
- The Run records only the broad venue posture (`self-run` or `open-competition`); it does not
  encode a particular backend implementation.
- Each Matrix cell already points to the accounted Submission, Attempt, Delivery, solver,
  evaluator, cost posture, and pinning result.
- Execution Evidence already separates Executor Agent from Runtime Specification, preserves
  native runtime artifacts, and permits stable references to external marketplace lifecycle
  records.

This follows the stack law: records describe portable semantics; bindings translate onto a
substrate; applications select backends and policy; products compose the experience. Harbor
should enter as an adapter/profile, not as a new record family.

## Publication profile: minimum durable closure

The profile defines mappings and evidence roles over existing records plus one small sealed
`BenchmarkAccounting` manifest. It adds no competing execution or benchmark identity system.

### Registration closure

Persist before public execution:

1. Exact Benchmark and Run bytes.
2. Exact Jinn Task bytes for every benchmark item.
3. The immutable Harbor task or dataset snapshot referenced by those Tasks: repository/reference,
   task-package digest, schema version, and container digest where applicable.
4. The runtime selection: Harbor version, adapter version, material configuration, and the
   evaluation/reward contract.
5. The Run's expected cells, stopping rule, replacement policy, and venue posture.

The runtime identity known before dispatch belongs in the pinned Run/Submission requirements or a
digest-bound runtime-selection artifact. A generated Harbor Job or Trial identifier cannot belong
in the registration closure because it does not exist yet.

### Per-dispatch accounting closure

Persist for every dispatch, including replacements and failed infrastructure attempts:

1. Exact sealed Submission bytes and digest.
2. Backend-minted Attempt URI and the complete observation stream available to the publisher.
3. Exact Delivery bytes and output descriptors, when present.
4. The correlation record connecting:
   - Run digest, cell key, and dispatch index;
   - Submission digest/URI and Attempt URI;
   - marketplace request, assignment, operator, chain/finality, and settlement references when
     the marketplace was used;
   - Harbor Job/Trial identifiers when Harbor was used; and
   - Execution Evidence execution identifier.
5. Harbor-native trial material needed to interpret the outcome: effective trial configuration,
   result, raw reward metrics, ATIF trajectory reference, artifact manifest, and relevant logs.
6. Execution Evidence, evaluations/verdicts, and verification attestations.

The accounting record also freezes its procedure/version and the authoritative Record Discovery
source or substrate streams through exact cutoffs. Completeness means complete within that declared
scope; an unreachable or incomplete stream produces an indeterminate verification result.

Marketplace and Harbor identifiers are correlation/locator facts, not replacements for Jinn
content identities. Exact bytes and digests remain canonical.

No execution may disappear inside an automatic retry. A planned replicate is a distinct cell. A
replacement is a new dispatch of the same cell. Any runtime or infrastructure retry that actually
executes work must remain visible in the dispatch/evidence lineage; otherwise public accounting is
incomplete.

### Terminal closure

Persist:

1. The full accounting bundle, including every expected cell and every dispatch lineage.
2. The terminal Matrix, including attrition and exclusions.
3. The signed Report v2 envelope and its exact supporting records when report publication is
   permitted; legacy raw Report v1 remains unchanged.
4. Public-safe native artifacts, or digest/locator plus the applicable withholding and scrub
   provenance where trajectories or outputs cannot be public.

Runtime-native artifacts remain native. Colophon should not translate ATIF into a private
trajectory format or reduce Harbor's metric map to pass/fail. It may derive presentation views,
but publication must retain the exact source evidence those views came from.

## Current product gaps exposed by the spike

These are Colophon gaps, not protocol defects:

1. The product draft schema currently permits only `self-run`, and launch/runtime construction is
   typed around `LocalVenue`. The platform's marketplace venue exists below the product but is not
   yet a Colophon composition.
2. The runtime adapter registry has native and Inspect adapters, but no Harbor adapter.
3. The portable bundle has a closed, product-specific evidence-role vocabulary and self-run trust
   document. It has no generic runtime-native trial roles or open-competition trust projection.
4. The product bundle assembly graph can represent solve/evaluation dispatches, but it does not yet
   define the complete Harbor and marketplace correlation transcript above.
5. The current public-bundle verifier contains Inspect-specific closure checks. Harbor needs its
   own adapter-owned closure verifier behind a generic runtime-verification seam, not another set of
   Harbor conditions embedded throughout product lifecycle code.
6. Benchmarking launch currently omits the Submission `attempts` block. Marketplace posting
   defaults that omission to one claim, but the one-Attempt-per-cell publication invariant should
   be explicit in the sealed Submission rather than inherited from a venue default.

The base Run, Matrix, TEP, Evidence, and marketplace record families do not need new venue/runtime
vocabulary. The reusable follow-up adds BenchmarkAccounting above them and an accounted Matrix
assembly procedure v2 because the current Matrix carries only a dispatch count and the selected
dispatch, not the full dispatch-reference lineage.

## Narrow interoperability profile to write now

The publishing-focused profile should freeze only:

1. **Identity mapping:** Harbor Task/Dataset/Trial/Job and marketplace request/assignment to Jinn
   Task/Benchmark/Submission/Attempt/Execution.
2. **Pinning:** exact versions, task packages, dataset references, OCI digests, effective reward
   contract, and runtime selection.
3. **Correlation:** the post-dispatch mapping record and which identifiers are facts versus
   canonical identities.
4. **Native evidence roles:** Harbor configuration, result/reward, ATIF, artifact manifest, logs,
   plus marketplace ordering/settlement references.
5. **Retry and replacement visibility:** one actual execution cannot be hidden by either system.
6. **Disclosure:** which native artifacts are mandatory public bytes, which may be digest-addressed,
   and how withholding/scrubbing is stated.
7. **Conformance fixtures:** direct Harbor, later publication of a Jinn-managed completed Job,
   refusal of synthetic TEP history for an arbitrary Job, marketplace operator using Harbor,
   failure/replacement, and byte-preserving public-bundle verification.

Defer the Harbor launcher implementation, Harbor Job parallelism policy, Jinn operator packaging,
remote-provider protocol, pricing, and marketplace UX to a separate execution-design session.

## Design gates for later implementation

- A completed Harbor Job captured by a Jinn-aware adapter can be published later without rerunning
  it; public-registration timing is disclosed independently from Report analysis preregistration.
- An arbitrary historical Harbor Job is not represented as a historical Jinn Submission/Attempt;
  retrospective native-evidence import needs a later attestation design.
- The same Harbor task package can be dispatched directly or through the marketplace without
  changing Benchmark identity.
- Every marketplace execution identifies the operator and stable marketplace lifecycle refs;
  every Harbor execution identifies the exact runtime and native trial refs.
- Raw Harbor reward metrics and native artifact digests survive publication byte-exactly.
- Local and marketplace paths produce the same Jinn accounting structure and different,
  accurately stated assurance disclosures.
- No Colophon code recreates Harbor task loading, sandbox providers, agent adapters, verifier
  execution, artifact collection, ATIF, or viewing.

## Repository basis

- Stack laws: [`../superpowers/specs/2026-07-30-stack-design-principles.md`](../superpowers/specs/2026-07-30-stack-design-principles.md)
- Backend-neutral benchmarking and venue posture: [`../superpowers/specs/2026-07-28-benchmarking-application-design.md`](../superpowers/specs/2026-07-28-benchmarking-application-design.md)
- Marketplace translation and operator sovereignty: [`../superpowers/specs/2026-07-28-marketplace-binding-design.md`](../superpowers/specs/2026-07-28-marketplace-binding-design.md)
- Existing benchmarking implementations: [`../superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`](../superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md)
- Evidence runtime and marketplace-reference boundary: [`../superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md`](../superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md)
- Existing Harbor seam: [`../superpowers/specs/2026-08-03-policy-optimization-product-design.md`](../superpowers/specs/2026-08-03-policy-optimization-product-design.md)
- Task-package interop research: [`../superpowers/notes/2026-07-31-task-supply-research-findings.md`](../superpowers/notes/2026-07-31-task-supply-research-findings.md)

Upstream references:

- [Harbor core concepts](https://harborframework.com/docs/core-concepts)
- [Harbor task format](https://harborframework.com/docs/tasks)
- [Harbor results and artifacts](https://harborframework.com/docs/run-jobs/results-and-artifacts)
- [Agent Trajectory Interchange Format](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md)
