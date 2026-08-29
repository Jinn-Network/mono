# Evidence-First Benchmarking — Design Amendment

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-08-16 |
| **Shape** | design amendment |
| **Status** | approved for implementation by the product owner; stacked on PR #2706 |
| **Issue** | [#2711](https://github.com/Jinn-Network/mono/issues/2711) |
| **Depends on** | [stack design principles](./2026-07-30-stack-design-principles.md), [benchmarking application](./2026-07-28-benchmarking-application-design.md), [execution evidence](./2026-07-23-jinn-execution-evidence-protocol-design.md), [evidence capture](./2026-07-26-execution-evidence-capture-design.md), [record discovery](./2026-07-27-record-discovery-protocol-design.md), and [benchmark publication interoperability](./2026-08-13-benchmark-publication-interoperability-profile.md) |
| **Foundation** | PR [#2706](https://github.com/Jinn-Network/mono/pull/2706), exact reviewed implementation base `a9773b27a7bc81d66887dc295e4423ea25e56caf` |
| **Implementation** | delivered; see [§11](#11-implementation-status) |

## 0. Decision in plain language

Colophon is an evidence, evaluation, and analysis layer around native benchmark runtimes. Harbor
and Inspect remain execution frameworks. Jinn does not need to replace their scheduling, retry,
task, agent, scorer, or native artifact models.

The durable unit in Jinn Data is one factual Task–Execution–Result atom:

- one Harbor Trial becomes one subject Execution Evidence record;
- one Inspect judge call becomes one evaluator Execution Evidence record;
- an automated judge's opinion becomes one Result Evaluation over the exact subject Task and
  Result digests; and
- one authenticated human decision becomes one independent Result Evaluation over those same
  subject digests.

Later evaluations append to the graph. They never rewrite the original execution or result. A
benchmark analysis selects an immutable cohort of those records and derives a Matrix and Report.
This makes it possible to ask new evaluators new questions about existing results without running
the original benchmark again.

TEP remains useful when Jinn commissions work through a backend. Submission, Attempt, Delivery,
and BenchmarkAccounting then describe that genuine commissioning history. They are not required
to describe a native Harbor or Inspect execution, and the evidence-native path must never
synthesize them after the fact.

## 1. Amendment to the current benchmarking design

The 2026-07-28 benchmarking application remains the compatibility design for commissioned,
dispatch-centric benchmarks. Its Benchmark v1, Run v1, BenchmarkAccounting v1, Matrix v1, Report
payload v1, and signed Report kind v2 remain immutable.

This amendment adds a second, evidence-native application profile. It does not reinterpret old
record kinds:

```text
native execution                 evaluation graph                  analysis

ExecutionBatchIntent?            Result Evaluation                 Benchmark Definition v2
Harbor / Inspect / human          Execution Verification           Analysis Manifest v1
Execution Evidence               HumanLabelResolution v1          Evidence Cohort v1
ExecutionBatchCapture                                              Matrix v2
ExecutionCommissioningLink?                                        Report payload v2 / kind v3
                                                                   claim-package/3
                                                                   public-bundle/5
```

Question marks identify optional provenance. An Execution Evidence record has the same exact
bytes whether or not a TEP commissioning link is later added.

## 2. Ownership and dependency direction

| Tier | Ownership |
|---|---|
| **1 — Evidence Protocol** | Existing Execution Evidence, Result Evaluation, and Execution Verification v1 semantics and validators; unchanged |
| **2 — evidence-native benchmark records** | Batch intent/capture, protocol-neutral Benchmark v2, Analysis Manifest, Cohort, Matrix v2, Report v2 payload/kind v3, and commissioning link |
| **3 — reusable applications** | pure evidence builder, native-run ingestion coordinator, evidence catalog selection, evaluation runner, cohort verification, matrix assembly, analysis and replay |
| **4 — Colophon** | Harbor/Inspect adapters, human-review UX, local storage, CLI/GUI orchestration, privacy choices, and bundle presentation |

Tier 1 never imports benchmarking. Tier-2 record packages never import discovery, TEP, a native
runtime, or Colophon. Evidence-native tier-3 packages do not import TEP. A separate optional
commissioning adapter may depend on both TEP and the evidence-native application.

## 3. Atomic subject and evaluator graph

### 3.1 Subject execution

For the golden lifecycle, the subject is the memory system's response:

- **Task** is the exact memory question plus solver-visible context.
- **Execution** is the memory system answering it.
- **Executor** is the selected memory agent/model.
- **Runtime** is the effective Harbor, agent, model, environment, and controlled-component
  closure.
- **Result** is the exact candidate answer and any task-declared deliverables.
- **Native trace** is the exact per-Trial trajectory/log.

Reference answers, admitted truth, reviewer data, and judge opinions are forbidden from the
solver-visible Task.

A Harbor Job is only a grouping and source-closure container. Every actual Trial, including
failed, cancelled, retried, and `source_trial`-related Trials, is inventoried independently. A
retry is not silently collapsed into a replicate.

### 3.2 Evaluator execution

Every automated judge call has its own execution graph:

- **Task** is the exact binary-judgment request and only the material that instrument may see.
- **Execution** is one Inspect judge call at one sample, epoch, and retry coordinate.
- **Executor** is the exact evaluator model/solver identity.
- **Runtime** includes the Inspect version, sealed instrument, model/provider, sandbox, tools, and
  controlled components.
- **Result** is the exact judge response and observation.
- **Native trace** is the exact per-call Inspect trace or a lossless member extraction bound to
  the immutable aggregate log.

The judge-opinion issuer parses that Result with the sealed instrument parser and issues a Result
Evaluation whose subjects are the original memory Task and Result. The evaluation references the
evaluator Execution Evidence as supporting provenance. Operational failure or non-admitted parse
failure is inconclusive; it is never converted into a fabricated binary opinion.

The evaluator's opinion and its qualification remain separate claims:

- **opinion** — ACCEPT, REJECT, or inconclusive for the subject result;
- **qualification** — whether that opinion agrees with the admitted human label.

PR #2706's truth-comparison adapter remains the qualification layer. Truth is never supplied to
the automated judge.

### 3.3 Human evaluation and resolution

PR #2706 already defines the reusable human contracts. This amendment reuses, rather than
duplicates, them:

- every authenticated reviewer issues an independent Result Evaluation;
- the reviewer sees the exact subject Task and Result, without another review or automated
  opinion before submission;
- each envelope preserves reviewer, evaluator, publisher, signer, and operator identities as
  distinct roles; and
- `HumanLabelResolution v1` references the exact human evaluation envelopes and applies the
  declared admission policy.

Two-human unanimity admits a label only when both independent decisions agree. Disagreement stays
unresolved unless a prospectively registered adjudication policy says otherwise. An imported
authoritative label is an operator admission, not a fabricated human review.

## 4. New record families

All records use I-JSON, one-time RFC 8785 JCS sealing, exact-byte SHA-256 identity, and explicit
media type/profile identifiers. Unknown old media types are never widened.

### 4.1 ExecutionBatchIntent v1

Prospectively seals a native invocation before process spawn:

- adapter and mapping version;
- fixed executable, argv, sanitized environment, working-directory policy, and runtime closure;
- input/source descriptor and expected native inventory scope;
- privacy and publication policy;
- optional external registration receipt; and
- owner, sealing time, and intended launch boundary.

It never contains a shell command string. Failure to durably persist the intent prevents launch.

### 4.2 ExecutionBatchCapture v1

Closes one immutable native source:

- exact archive root and source descriptor;
- adapter/mapping version and runtime compatibility result;
- stable ordered native-unit inventory;
- source-unit to Execution Evidence references;
- explicit failures, tombstones, exclusions, duplicates, and limitations;
- mutation and closure checks; and
- capture assurance and time.

Completeness is only relative to the declared frozen source. It cannot prove that an owner did not
run another undisclosed Job.

### 4.3 Benchmark Definition v2

Names a protocol-neutral exact Task set. It removes Benchmark v1's hidden requirement that each
item parse as a TEP TaskSpecification with an embedded evaluation descriptor. Items are exact
artifact descriptors plus optional profile/schema descriptors and reveal/versioning policy.

### 4.4 Benchmark Analysis Manifest v1

Prospectively or retrospectively fixes:

- comparison groups and source/cursor/cutoff boundaries;
- membership, multiplicity, duplicate, and assignment policy;
- exact-identity versus separately declared semantic-equivalence policy;
- evaluator and verification admission, trust, conflict, supersession, and quorum rules;
- human-label-resolution policy;
- completeness and exclusion policy;
- registered analysis method, version, parameters, and slices; and
- close time and preregistration disclosure.

It is a new family. Legacy Run v1 remains dispatch- and TEP-shaped.

### 4.5 Evidence Cohort v1

Is the evidence-native accounting closure. It binds exact Manifest bytes and an immutable source
boundary, then lists every considered, admitted, and excluded:

- Execution Evidence reference;
- Result Evaluation reference;
- Execution Verification reference; and
- HumanLabelResolution reference.

Members bind exact Task and all selected Result digests, group/slot assignment, correlation unit,
and exclusion reason where relevant. A dynamic query is only a candidate generator; the published
Cohort always contains a stable, sorted, explicit digest set. No BenchmarkAccounting v2 is added.

### 4.6 Matrix v2 and assembly procedure 3.0

Matrix v2 binds exact Manifest and Cohort bytes. Its cells are evidence-member-centric and contain
no mandatory Submission, Attempt, Delivery, dispatch, or TEP pinning fields. Each cell names:

- its exact execution member and Task/Result subjects;
- considered and admitted evaluations/verifications/resolutions;
- preserved conflicts and policy-selected reductions;
- outcome, integrity, measurements, cost, latency, and disclosures; and
- deterministic assembly procedure and version.

A verifier must reproduce the Matrix from exact Cohort member bytes and the registered policy.

### 4.7 Report payload v2 and signed kind v3

The payload subjects Matrix v2, derives disclosures from the evidence-native chain, and uses
Manifest v1 for preregistration meaning. The signed public record kind is v3 because signed Report
kind v2 already envelopes legacy Report payload v1. Existing v1/v2 Report behavior is unchanged.

### 4.8 ExecutionCommissioningLink v1

Optionally correlates an exact Execution Evidence record with genuine TEP Submission, Attempt,
Delivery, and observation/accounting references. It does not become part of the atomic evidence
identity. No link may be authored unless the underlying commissioning records exist and validate.

### 4.9 Portable closure versions

PR #2706 owns `claim-package/2` and `benchmark-product-public-bundle/4`. This amendment therefore
allocates:

- `claim-package/3` for evidence-native claims; and
- `benchmark-product-public-bundle/5` for the portable evidence-native closure.

Verifier v2 gains additive support for these formats without changing its v2–v4 behavior.

## 5. Native capture application

The pure builder is:

```ts
buildExecutionEvidence(input): Uint8Array
```

It performs deterministic graph construction and Evidence Protocol conformance without storage,
workspace, process, clock, network, or TEP dependencies. The prospective execution recorder
delegates to it. A safe importer may call it while declaring retrospective provenance; doing so
does not claim contemporaneous observation.

The product-neutral adapter port is:

```ts
interface NativeExecutionAdapter {
  probe(source: NativeSource): Promise<NativeCompatibility>;
  inventory(source: ImmutableNativeSnapshot): Promise<NativeRunInventory>;
  atomize(
    source: ImmutableNativeSnapshot,
    unit: NativeUnit,
    context: NativeAtomizationContext,
  ): Promise<NativeAtomDraft>;
  prepareLaunch?(input: NativeLaunchInput): Promise<NativeLaunchDescription>;
}
```

`prepareLaunch` returns executable, argv, environment, and working directory as separate fixed
values. The generic coordinator owns `plan`, `capture`, `import`, `resume`, and `verify`, plus
storage, publication, cancellation, and idempotency. Its idempotency key is adapter id, mapping
version, immutable source digest, and opaque native-unit coordinates. Re-importing identical bytes
returns the same record identities; an external-ID/content collision fails closed.

Before parsing, capture snapshots exact bytes without following links. Traversal, symlinks,
hardlinks, special files, archive bombs, unsupported versions, and source mutation are refused.

## 6. Runtime mappings

### 6.1 Harbor

The adapter inventories all Trial directories in an immutable Job snapshot. It maps the exact
task material when present, selected Agent/model as Executor, effective Harbor/environment/model
closure as Runtime, task-declared outputs as Results, and ATIF/trajectory/log as native trace.
Job, Trial, retry/source-Trial, task, agent, and model identifiers are correlations rather than
content identity. Harbor-native verifier outputs become separate evaluation claims.

### 6.2 Inspect

Eval/EvalSet/EvalLog is a group/source container. The adapter inventories every EvalSample at
every native epoch and retry boundary. The atomic unit key includes native eval/run, task, sample,
epoch, and retry coordinates. Outputs are Results; messages/events/log are trace; each scorer
output is a Result Evaluation; aggregate metrics and epoch reducers are analysis inputs rather
than duplicated per-atom outcomes.

A prospective per-call hook provides the strongest mapping for evaluator calls. Historical
aggregate logs may fill an exact role only through a lossless extraction profile that binds the
aggregate digest, member selector, extractor code/config/version, and total source-to-atom
coverage. Otherwise import is sparse or partial; the Evidence Protocol's derivative-role
prohibition is not weakened.

## 7. Assurance and trust

The product exposes independent axes instead of one `verified` badge:

- origin: `native-direct | aggregate-lossless-derived | historical-sparse-import`;
- timing: `prospective-controlled | prospective-native-observed | retrospective-artifacts-only | unverifiable`;
- closure: `complete-relative-to-sealed-source | partial | indeterminate`;
- task relation: `exact-digest | declared-semantic-equivalence | unmatched`;
- evaluation: `deterministically-rederived | independently-re-evaluated | runtime-native-attested | signer-asserted | unevaluated`;
- trust: signature-valid, identity-bound, purpose-authorized, policy-trusted, and
  party-independence-established as separate states; and
- availability/privacy: `public-exact | digest-only | scrub-derived | source-absent | collection-failed`.

Signing proves authorship and integrity. It does not by itself prove the evaluator's identity,
authorization, independence, truth, or timestamp. Reviewer, evaluator, invoking operator,
assembler, signer, publisher, identity resolver, and consumer trust policy remain distinct.

Scrubbing creates new bytes, identities, and derivation provenance. Existing evaluations do not
silently transfer to scrub-derived Task, Result, or trace bytes. A low-entropy sensitive value may
make even a public digest unsafe; the privacy policy may withhold the conforming commitment.

## 8. Discovery, reevaluation, and stable selection

The evidence catalog projection gains runtime digest, every Result digest, generic identifier
scheme/value, evaluator method/specification/instrument, measurements, evidence, limitations,
evaluator-execution reference, capture source, publication boundary, and assurance. Public facts
v1 remains byte-compatible; a coexisting facts v2 supplies multi-Result and runtime fields.

Stable snapshot enumeration returns exact record references plus a source cursor/cutoff. Cohort
construction retrieves and validates the exact bytes; discovery is acceleration, never proof.

A TEP-free evaluation runner accepts exact Task and Result material, Evaluation Specification,
evaluator registration/context, and cancellation. The existing TEP harness becomes an outward
wrapper supplying commissioning context. A later evaluation creates a new claim and, when
analyzed, a new Cohort → Matrix → Report chain. Prior records remain byte-identical.

## 9. Golden lifecycle

PR #2706's 12-subject, four-instrument, three-call binary qualification becomes the first complete
fixture:

1. Harbor produces twelve subject Task–Execution–Result atoms.
2. Two blind humans produce 24 independent Result Evaluations.
3. Twelve two-human resolutions admit labels or preserve disagreement.
4. Inspect instruments A, B, and C each make three calls per subject: 108 evaluator executions and
   108 opinions.
5. The first Manifest/Cohort/Matrix/Report chain is frozen.
6. Existing instrument D then makes three calls per subject: 36 evaluator executions and 36 new
   opinions over the same Task and Result bytes.
7. A second chain includes D while the first chain remains byte-identical.
8. Exact-byte replay reproduces #2706's disagreement, parser-invalid, majority, confusion, rate,
   slice, attrition, and qualification outputs.
9. A clean installed verifier checks bundle v5 after the builder workspace is deleted.

There is no fifth judge. The 144 automated claims are four instruments × three independent calls
× twelve subjects. Truth material never appears in an automated-judge Task.

A separate parity fixture commissions another execution of existing instrument D through TEP.
Inspect still evaluates. `ExecutionCommissioningLink` adds the genuine TEP lineage without
changing evidence semantics. Policy may distinguish or combine native and commissioned calls.

## 10. Compatibility and delivery sequence

The implementation is delivered as reviewable stacks:

1. this design amendment and conformance fixture vocabulary;
2. pure evidence builder extraction with recorder byte-equivalence;
3. tier-2 schemas/identifiers and exact-byte fixtures;
4. capture records, immutable snapshot coordinator, and discovery v2;
5. Harbor subject capture;
6. existing human evaluation/resolution integration;
7. Inspect evaluator capture and opinion issuance using #2706 instruments;
8. Cohort, Matrix v2, Report kind v3, claim-package/3, bundle/5, and independent replay;
9. staged A/B/C → D golden lifecycle; and
10. optional TEP commissioning link, dual-write, and explicit backfill.

Every stack preserves all Evidence v1, BenchmarkAccounting v1, Matrix v1, Report v1/signed v2,
claim-package 1–2, bundle 2–4, and managed Harbor/Inspect fixtures. No implementation stack may
merge ahead of its approved dependency. PR #2706 must land before these stacks merge; development
may proceed against its exact immutable head.

## 11. Implementation status

Every delivery stack in §10 has landed on `next`, and each of issue #2711's eight acceptance
criteria is carried by a test that runs in CI. This section records where each proof lives so a
reader can re-run it rather than take the claim on trust.

### 11.1 Acceptance criteria and their proofs

| Criterion | Proof |
|---|---|
| Evidence Protocol v1 and current benchmarking/publication bytes unchanged | Evidence v1 identifiers untouched (`packages/evidence/protocol/src/identifiers.ts`); the evidence-native work took a new namespace, `https://spec.jinn.network/protocols/benchmarking/v2` (`packages/benchmarking/protocol/src/identifiers.ts`); legacy bytes stay pinned by `packages/benchmarking/records/fixtures/manifest.sha256.json` and `packages/benchmark-product/verify/fixtures/manifest.sha256.json` |
| One Harbor Trial is one atomic Execution Evidence record | `packages/benchmarking/native-capture/src/harbor.test.ts` — "treats Job as a group and every Trial/retry as one independently accounted unit" |
| One Inspect judge call is evaluator Execution Evidence plus a Result Evaluation over the subject Task+Result | `packages/benchmarking/native-capture/src/inspect.test.ts` — "atomizes two samples by three epochs into six independent evaluator executions" and "refuses truth-bearing judge input and aggregate extraction in exact Evidence v1 roles"; `packages/benchmarking/evaluation/src/index.test.ts` — "issues a judge opinion over original Task+Result with evaluator execution provenance and no Attempt" |
| Two human reviews stay independent; unanimity is separately derived | `packages/benchmarking/evaluation/src/index.test.ts` — "preserves two human claims and derives a separately signed unanimous label" and "admits an authoritative imported label without inventing a human evaluation"; `packages/benchmarking/protocol/src/records.test.ts` — "keeps two human opinions separate from their unanimous label resolution" |
| Cohort, Matrix, and Report rebuild without Submission/Attempt/Delivery | `packages/benchmarking/evidence/src/evidence.test.ts` — "verifies exact Task+Result claim bindings with no commissioning records"; the golden Matrix bytes are asserted free of any commissioning term (`packages/benchmarking/evidence/src/golden-lifecycle.test.ts`) |
| 12 × 4 × 3 yields 144 automated and 24 human claims; appending D leaves A/B/C byte-identical | `packages/benchmarking/evidence/src/golden-lifecycle.test.ts` — "appends evaluator D without rerunning or mutating twelve original memory subjects", which re-asserts the frozen A/B/C cohort, matrix, report payload, and report envelope digests after the D chain is built |
| TEP commissioning adds lineage without changing evidence semantics | `packages/benchmark-product/core/src/conformance/evidence-native-commissioning-parity.test.ts` — "a real Submission/Attempt/Delivery link does not change evaluator-D evidence identity" |
| claim-package/3 and public-bundle/5 verify independently; claim-package/2 and bundle/4 still accepted | `SUPPORTED_BUNDLE_FORMATS` in `packages/benchmark-product/verify/src/manifest.ts` carries v2, v4, v5 (and the later anchored v6/v7) side by side; `packages/benchmark-product/verify/test/cli.test.mjs` exercises every format, including the seven evidence-native checks and the metadata-first deferral |

### 11.2 Residual work, outside this amendment

Two items are not carried by any acceptance criterion and remain open. They belong in their own
issues rather than in #2711's closure:

- **Commissioning dual-write and explicit backfill** (§10 stack 10). `ExecutionCommissioningLink`
  and its parity fixture ship; the operational dual-write and backfill paths do not exist.
- **A user-facing evidence-native production path.** The shipped `colophon` CLI reads and verifies a
  `public-bundle/5` closure, but the produce side (native capture, cohort sealing, Matrix v2, Report
  kind v3) is a library surface, `packages/benchmark-product/core/src/evidence-first.ts`, reached
  only from repository scripts. The `packages/benchmark-product/web` reader likewise has no
  evidence-native presentation.

## Appendix A. Review disposition

Two fresh independent reviews were completed before the product owner approved implementation:

1. **Platform-boundary review** rejected extending BenchmarkAccounting v1 or fabricating TEP
   records. It required frozen Evidence v1 and legacy benchmarking bytes, Cohort-as-closure, an
   evidence-centric Matrix, and an optional commissioning association. Sections 1, 2, and 4 adopt
   those findings.
2. **Runtime/adversarial review** required one native Trial/sample/call per atom, immutable
   no-follow snapshots, exact-versus-semantic task separation, explicit assurance axes, preserved
   conflicts, evaluator/signer/trust separation, and a narrowly bounded aggregate-extraction
   rule. Sections 3, 5, 6, 7, 8, and 9 adopt those findings.

The product discussion then resolved the remaining choices: Harbor owns original benchmark
execution, Inspect owns automated judge execution, humans are evaluators, A/B/C precede D without
a subject rerun, no fifth judge exists, and TEP parity is a separate commissioning fixture.
