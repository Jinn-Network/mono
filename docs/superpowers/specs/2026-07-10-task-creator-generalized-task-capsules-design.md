# Task Creator generalized task capsules - design amendment

- **Version:** 0.1
- **Date:** 2026-07-10
- **Status:** conversation-approved; written-spec review pending
- **Shape:** `design`
- **Parent:** `spec/2026-07-08-task-creator-v0.md` v0.4
- **Implementation baseline:** Task Creator PR
  [#1485](https://github.com/Jinn-Network/mono/pull/1485), through commit
  `0ae4fc1a8c794d6490b8aa4c2f2b14d72e9e5a2c`
- **Reference runtime:**
  [rdi-berkeley/agents-last-exam](https://github.com/rdi-berkeley/agents-last-exam),
  inspected at commit `186691830cd6906a405cb997b39bc5f5ca82e2a4`

## 1. Decision

The Task Creator remains one pipeline that turns real agent work into new evaluable
Tasks. The shipped SWE-rebench minting path is its first task-family adapter, not the
domain model for every future task.

Before automatic environment construction, the pipeline gains a domain-neutral
**Task Capsule** boundary between mining and admission. A capsule describes:

- the public instruction and inputs;
- the environment required to solve and evaluate the Task;
- how a solver's result becomes a portable Solution;
- the committed, evaluator-only reference and grading bundle;
- the admission evidence proving that the Task distinguishes success from failure.

Agents' Last Exam (ALE) is the compatibility pilot and reference implementation for
this boundary. Jinn borrows its provider lifecycle, staged input/reference separation,
artifact scoring, and broad environment model. Jinn does not adopt ALE's Python task
package as a protocol schema and does not make ALE a runtime dependency of every
SolverNet.

The parent design's rung 4 is renamed **automatic environment synthesis**. The
runtime contract and provider seam land earlier; rung 4 remains the later ability to
generate a new environment recipe from a captured `jinn-agent` session.

## 2. Why the current boundary is insufficient

Task Creator PR #1485 proves the coding path:

```text
commit -> gold patch -> SWE-rebench row -> Docker admission
       -> minted-row artifact -> existing generator/evaluator
```

Its concrete candidate is a `PoolTask` plus an `HfRow` plus a gold patch. The
published artifact assumes `image_name`, `FAIL_TO_PASS`, `PASS_TO_PASS`,
`test_patch`, and `install_config`. That is the correct adapter for repository repair.
It cannot represent work whose result is a spreadsheet, a report, a set of images, a
database state, or a workflow completed through desktop software.

ALE demonstrates the broader shape:

```text
provision sandbox -> stage visible input -> task setup -> agent runs
                  -> stage hidden reference -> grade artifacts -> collect trajectory
```

But ALE evaluates in the same live sandbox in which the agent worked. Jinn separates
the solver and evaluator. A Jinn-compatible generalized Task must therefore add one
contract ALE does not need: a **submission projection** that extracts a portable
Solution from the solver environment and injects it into a clean evaluator
environment.

## 3. Scope

### 3.1 In scope

- A versioned, domain-neutral Task Capsule.
- A task-family adapter boundary that preserves the existing SWE-rebench path.
- Public solve-time data separated from evaluator-only reference data.
- Environment capability requirements and provider selection.
- A portable file-artifact Solution format for the first generalized family.
- Admission using positive controls, negative controls, clean replay, leak checks,
  and deterministic receipts.
- An ALE compatibility pilot over unlicensed, Docker-supported, artifact-producing
  tasks.
- Human review as the initial publication gate, with machine-produced complete
  candidates and receipts.
- A gated path to automatic publication.

### 3.2 Out of scope

- Importing the whole ALE catalog into Jinn.
- Replacing the SWE-rebench schemas or evaluator in PR #1485.
- Publishing private-repository or proprietary input snapshots.
- Licensed desktop software in the first pilot.
- Portable VM deltas, external SaaS state, or evaluator co-location in v1.
- Claiming cryptographic secrecy for evaluator references. The v1 reference store is
  access-controlled and commitment-checked; evaluator operators remain trusted with
  the reference, consistent with Jinn's current honest limits.
- Removing human review before admission telemetry supports a measured threshold.

### 3.3 Implementation unit

This is a program-level amendment, not one implementation tranche. Phases G0-G5 in
§10 are separate gated feature cycles. The current public-repository G0b bootstrap
does not start G1: it only hardens the existing SWE-rebench evaluator and defines
the hand-off vocabulary. G1 schemas, adapter boundaries, `session-derived.v2`, Docker
capability matching, and synthetic capsule proofs are explicitly out of scope until
their own approved plan begins. G2 begins only after G1's gate passes; later phases
receive their own design/plan review at their gate.

## 4. Domain model

### 4.1 Source Capture

A local, consented record of real `jinn-agent` work. It is raw material, not a Task
and not automatically public. For generalized task creation it must retain:

- the user's initial goal and accepted outcome;
- an environment fingerprint and starting-state recipe;
- visible input identities and content digests;
- tools, applications, packages, and capability use;
- commands or checks used to validate the result;
- the accepted output bundle or environment delta;
- intermediate failed states suitable as negative controls;
- skill-consumption events required by the parent design;
- separate local-mining and publication consent receipts.

Secrets are represented by typed credential handles, never captured values.

### 4.2 Task Candidate

A local, mutable compiler output. It contains the candidate instruction,
environment recipe, input bundle, output contract, accepted result, proposed
evaluator, negative controls, provenance, license assertions, and disclosure scan.
It may be rejected or reviewed. It is never posted directly.

### 4.3 Public Task Capsule

`jinn.task-capsule.v1` is the immutable solve-time description referenced by the
signed `task.v1` document:

```ts
interface TaskCapsuleV1 {
  schemaVersion: 'jinn.task-capsule.v1';
  taskFamily: string;
  taskId: string;
  instruction: string;
  environment: EnvironmentRequirementV1;
  inputs: Array<{
    artifact: InputArtifactV1;
    rightsRef: string; // independent redistribution evidence for this input
  }>;
  submission: SubmissionProjectionV1;
  evaluator: {
    semanticsVersion: string;
    bundleCommitment: `sha256:${string}`;
    requiredCapabilities: string[];
  };
  provenance: {
    sourceKind: 'solver-attempt' | 'local-session' | 'curated-import';
    sourceCommitment: `sha256:${string}`;
    license: string; // SPDX expression or LicenseRef
    consentReceiptRef?: string;
  };
  timeBudgetSeconds: number;
}
```

The public capsule contains no accepted output, gold artifact, reference file,
evaluator credential, or unblinded source pointer. The outer signed `task.v1`
document references both the capsule and its admission receipt. Keeping the receipt
reference outside the capsule avoids a content-addressing cycle: the receipt commits
to the already-final capsule digest.

Rights are input-scoped: every public artifact and environment layer has its own
`rightsRef`. A source repository licence is evidence for that repository input only;
it is not a blanket authorization for an unrelated setup bundle, fixture, or image.

### 4.4 Environment requirement

`EnvironmentRequirementV1` describes capabilities, not a specific cloud vendor:

- immutable base reference and digest;
- OS and architecture;
- CPU, memory, disk, GPU, and timeout requirements;
- shell, filesystem, desktop/CUA, and network capabilities;
- required system packages or licensed-software identifiers;
- setup bundle reference and digest;
- typed credential requirements without credential values.

Provider choice is operator-local. A Docker image, QEMU disk, or cloud snapshot may
satisfy the same requirement if it yields the committed starting state.

### 4.5 Evaluator bundle

`jinn.evaluator-bundle.v1` is held outside the public Task document. Its digest must
match `bundleCommitment` in the public capsule. It contains:

- evaluator code or evaluator-image digest;
- hidden reference artifacts;
- the Solution injection recipe;
- scoring signals, weights, thresholds, and normalization;
- evaluator-only credential requirements;
- expected infrastructure capabilities;
- the evaluator semantics version.

For v1 the Curator stores this bundle in an access-controlled artifact store and
provisions it to evaluator operators. The public commitment makes evaluator drift
detectable but does not prove that an evaluator kept the reference secret. Reusable
hidden-reference Tasks must not be described as cryptographically private until a
confidential-execution or equivalent key-release design exists.

### 4.6 Submission bundle

The first generalized Solution format is `jinn.submission-bundle.v1`:

```ts
interface SubmissionBundleV1 {
  schemaVersion: 'jinn.submission-bundle.v1';
  projectionId: string;
  artifactRef: string;
  sha256: string;
  files: Array<{ path: string; sha256: string; bytes: number; mediaType?: string }>;
  trajectoryCid?: string;
  cost?: { totalUsd: number };
}
```

The file projection uses a canonical archive, normalized relative paths, explicit
size limits, no symlinks, and a manifest hash. The evaluator creates a clean
environment, stages public inputs, injects the Solution at the declared output root,
stages the hidden reference, and runs the committed evaluator.

Environment-delta and external-state projections are separate future schema
versions. They do not silently widen the file projection.

### 4.7 Admission receipt

`jinn.task-admission-receipt.v1` records the evidence that made publication safe:

- public capsule digest and evaluator bundle commitment;
- environment and setup digests actually tested;
- positive-control score from the accepted result;
- every negative control and its score;
- repeated clean-replay scores and variance;
- input/reference separation check;
- output portability check;
- secret, PII, license, and held-out scans;
- evaluator cost and wall time;
- admission policy version;
- reviewer identity and decision while human review remains required.

The receipt is public. Sensitive controls are identified by commitments rather than
their contents.

## 5. Component boundaries

### 5.1 Task family adapter

Each task family owns only its domain-specific translation:

```ts
interface MaterializedTaskV1 {
  capsule: TaskCapsuleV1;
  evaluatorBundle: EvaluatorBundleV1;
  positiveControl: SubmissionBundleV1;
  negativeControls: SubmissionBundleV1[];
}

interface TaskFamilyAdapter<Source, Candidate> {
  readonly family: string;
  discover(source: Source): Promise<Candidate[]>;
  materialize(candidate: Candidate): Promise<MaterializedTaskV1>;
  admit(materialized: MaterializedTaskV1): Promise<TaskAdmissionReceiptV1>;
  toTaskDocument(
    capsule: TaskCapsuleV1,
    receipt: TaskAdmissionReceiptV1,
  ): Promise<Task>;
}
```

The interface is a design boundary, not a requirement to rewrite PR #1485 before it
merges. The first implementation wraps the existing coding modules at their current
mint/admission boundary.

### 5.2 SWE-rebench adapter

The existing Task Creator path remains in `swe-rebench-v2.v1`:

- `image_name` satisfies the environment requirement;
- repo at `base_commit` is the public input;
- the patch payload remains the Solution projection;
- F2P/P2P plus `test_patch` are the evaluator bundle;
- the gold patch is the local positive control;
- empty and known-bad patches are negative controls;
- `ValidatedPoolEntry` is adapted into the common admission receipt.

No generalized SolverNet is introduced for Tasks that already fit Rebench.

### 5.3 Generalized session-derived adapter

Tasks that cannot compile to an existing SolverNet use the existing
`session-derived` contract family through a new `session-derived.v2` contract. v2
references `jinn.task-capsule.v1` and accepts `jinn.submission-bundle.v1`. It does not
mutate the already-versioned v1 schemas in place:

```ts
interface SessionDerivedTaskV2 {
  schemaVersion: 'session-derived-task.v2';
  capsuleRef: string;
  capsuleSha256: string;
  admissionReceiptRef: string;
  admissionReceiptSha256: string;
}

interface SessionDerivedSolutionV2 {
  schemaVersion: 'session-derived-solution.v2';
  submissionBundleRef: string;
  submissionBundleSha256: string;
  trajectoryCid?: string;
  cost?: { totalUsd: number };
}
```

Its Verdict is `session-derived-verdict.v2`: a normalized score in `[0, 1]`, signal
breakdown, evaluator-bundle commitment, evaluator cost, and `SCORED | SKIPPED`
status. This avoids a third overlapping SolverNet while preserving the parent
design's decision not to fork SWE-rebench for coding mints.

Both SolverNets publish attempts into the same corpus. Distillation consumes the
attempt and verdict evidence, not the SolverNet name.

### 5.4 Sandbox provider (G1 runtime)

`SandboxProvider` is the later G1 runtime abstraction that materializes a committed
starting state and exposes a uniform sandbox handle. It must support:

- `supports(requirement)`;
- `acquire(requirement)`;
- `stageInputs(handle, inputs)`;
- `stageEvaluatorReference(handle, evaluatorBundle)` after solver completion only;
- `extractSubmission(handle, projection)`;
- `injectSubmission(handle, projection, submission)`;
- `release(handle)`.

Providers must report unsupported capabilities before a claim is attempted.
Provisioning, staging, transport, and cleanup failures are infrastructure failures,
not zero-scored solver results.

The signed `task.v1` copies solver and evaluator capability requirements into its
eligibility data. Joined operators advertise matching capabilities in their
SolverNet manifests. Claim preflight rejects a mismatch before escrowed work starts;
runtime `supports()` is the second, local fail-closed check.

The provider sequence is Docker, then local QEMU, then cloud VM/desktop. Licensed
snapshot providers are a separate opt-in capability class.

It is deliberately distinct from `EnvironmentRecipeResolver`, which discovers a
public-repository evaluator build recipe in G0b. The resolver does not acquire a
sandbox, and G0b does not implement this provider interface.

### 5.5 Capsule runtime

The capsule runtime is shared by solver and evaluator operators. It reads the public
capsule, selects a supporting provider, verifies environment/setup digests, stages
public inputs, and launches the SolverNet's configured agent Harness. The solver
environment is a clean solve-time environment and never receives evaluator-only
material. The evaluator environment is a distinct clean environment; it additionally
obtains the commitment-matching evaluator bundle, injects the delivered Solution only
after solver completion, stages the hidden reference, and invokes the evaluator.

This keeps task-family logic out of the daemon's claim loop. The claim loop sees
capabilities and versioned payloads; the runtime owns environment lifecycle.

## 6. ALE compatibility adapter

ALE's task package maps into the capsule as follows:

| ALE surface | Task Capsule surface |
|---|---|
| `task_card.json` prompt, VM, timeout | public instruction and environment requirement |
| visible `input/` | input artifact bundle |
| `main.py` `start()` | setup bundle |
| hidden `reference/` | evaluator-only reference bundle |
| `main.py` `evaluate()` | evaluator code bundle |
| output directory | file submission projection |
| provider snapshot tag | capability requirement resolved by a provider |
| score in `[0, 1]` | normalized Verdict score and signal breakdown |

The first adapter reuses the pinned ALE provider/task-driver runtime behind the
capsule runtime on both solver and evaluator operators. The evaluator Harness owns
the ALE `evaluate()` invocation; the solver side uses ALE setup/provider behavior but
never receives the reference bundle. The adapter does not translate every task's
Python hooks into TypeScript. This proves the contract while keeping replacement
possible: the protocol sees capsule and bundle digests, not an ALE-specific wire
format.

The pilot selects three unlicensed, Docker-supported tasks:

1. one deterministic single- or small-multi-file output Task;
2. one deterministic structured-data or scientific artifact Task;
3. one judge-based image or document Task, included only after the first two pass.

Every pilot Task must be solvable without licensed software, GPU-specific cloud
images, or agent-time credentials. The pilot is compatibility evidence, not a claim
that the ALE catalog has been imported.

## 7. Dynamic compilation from `jinn-agent`

The compiler runs locally after a session reaches an accepted outcome:

1. **Detect candidate.** Require a clear initial goal, accepted result, and
   observable output or state transition.
2. **Freeze source.** Commit hashes and content digests identify inputs and the
   environment before work began.
3. **Infer instruction.** Rewrite the original conversation into a self-contained
   Task without leaking the accepted result.
4. **Build environment recipe.** Prefer an already-supported base; otherwise queue
   the candidate for later automatic environment synthesis.
5. **Choose submission projection.** v1 accepts only portable file artifacts or an
   existing task-family payload such as a patch.
6. **Build evaluator.** Prefer deterministic validators, then reference comparison,
   then calibrated LLM/VLM signals. Judge-only evaluation is lower confidence.
7. **Construct controls.** Accepted output is the positive control. Empty output,
   intermediate failed states, and bounded mutations are negative controls.
8. **Admit.** Run from clean environments, repeat, scan disclosure, and issue a
   receipt or a typed rejection.
9. **Review.** Initially, a person approves or rejects the complete capsule and
   receipt. Review does not fill missing implementation fields.
10. **Publish.** The Curator posts only admitted capsules and funds normal claims.

Review decisions become labeled Task Creator evidence. They are not fed directly
into an auto-publish rule until a held-out calibration shows that the rule meets the
locked quality threshold.

## 8. Admission and scoring policy

### 8.1 Required checks

A candidate is admitted only when all applicable checks pass:

- the accepted Solution reaches the family-specific positive threshold;
- empty output fails;
- at least one realistic negative control scores below the negative threshold;
- positive and negative margins meet the policy minimum;
- repeated clean replay stays within the allowed variance;
- the reference never enters the solver environment;
- extraction from one environment and injection into another preserves the score;
- the public capsule and environment contain no hidden answer, secret, or forbidden
  source material;
- license and publication policy permit every disclosed input and environment layer;
- held-out denylist checks pass before admission spend;
- expected solve and evaluation cost fit Curator limits.

### 8.2 Signal priority

Signals are preferred in this order:

1. deterministic executable or structural checks;
2. deterministic comparison with hidden reference artifacts;
3. bounded statistical comparison with tolerances;
4. calibrated LLM/VLM judgment combined with hard structural gates;
5. judge-only scoring.

Lower-priority signals do not replace an available higher-priority signal. The
Verdict records each signal, its weight, whether it was present, and evaluator cost.

### 8.3 Typed outcomes

The pipeline distinguishes:

- `candidate_rejected`: the candidate cannot become a sound Task;
- `unsupported_environment`: no joined provider satisfies its requirements;
- `materialization_failed`: input or setup bundle could not be built;
- `positive_control_failed`: the accepted result did not pass clean replay;
- `negative_control_passed`: the evaluator cannot discriminate;
- `non_reproducible`: clean replays exceed the variance limit;
- `reference_leak`: solve-time state exposed evaluator-only material;
- `disclosure_blocked`: privacy, secret, license, or held-out policy failed;
- `evaluator_infrastructure_failure`: evaluation could not produce a valid score;
- `scored`: a valid Verdict was produced.

Only `scored` produces a Verdict. Infrastructure failures remain retryable and do
not become zero scores.

## 9. Automation levels

| Level | Behavior | Publication authority |
|---|---|---|
| A0 | Human authors the Task and evaluator | Human |
| A1 | Machine generates a complete candidate and receipt | Human review required |
| A2 | Machine continuously mines and admits candidates | Human publication approval |
| A3 | High-confidence deterministic families auto-publish | Policy threshold |
| A4 | Calibrated reference/judge families auto-publish | Policy threshold plus evaluator reputation |
| A5 | New environment recipes are synthesized and admitted automatically | Separate environment-synthesis gate |

The first product milestone is A2. A3 requires a predeclared calibration set and a
measured false-admission ceiling. A4 and A5 cannot inherit A3 approval merely because
they share a compiler.

## 10. Roadmap and gates

G0-G3 may build compatibility plumbing and small proof runs. They do not authorize
scaled minted supply. The parent design's cap-v0 and three-arm learning gates remain
binding; automatic publication in G4 requires the three-arm result to justify the
additional task supply as useful learning material.

### Phase G0 - finish the coding vertical

- Merge Task Creator PR #1485 after CI and review.
- Prove harvested Task posting, solving, independent evaluation, and corpus capture
  on-chain.
- Keep all existing SWE-rebench integrity and quota gates.

**Gate:** one harvested instance completes the full network loop through the
production generator and evaluator paths.

### Phase G1 - capsule contract and adapters

- Land SDK schemas for capsule, evaluator bundle, submission bundle, and receipt.
- Introduce the task-family adapter boundary around the existing coding path.
- Register `session-derived.v2` with capsule-backed artifact Solutions; leave the v1
  schemas unchanged.
- Add Docker provider capability matching and reference staging order.

**Gate:** existing SWE-rebench mint tests remain unchanged in behavior, and one
synthetic capsule-backed file Task passes independent solver/evaluator environments.

### Phase G2 - ALE compatibility pilot

- Package the pinned ALE runner as an evaluator Harness dependency.
- Adapt two deterministic unlicensed Docker Tasks, then one judge-based Task.
- Record evaluator cost, infrastructure failures, and admission receipts.

**Gate:** both deterministic Tasks pass positive, negative, leak, portability, and
clean-replay checks; at least one completes the Jinn network loop.

### Phase G3 - capture enrichment and local compiler

- Extend `jinn-agent` capture with the Source Capture fields in §4.1.
- Generate candidates from real dogfood sessions.
- Add the local review surface for capsule, disclosure, controls, and receipt.

**Gate:** ten real sessions produce at least three admitted, human-approved Tasks
without a reviewer writing missing task or evaluator code.

### Phase G4 - automatic artifact-task creation

- Run candidate discovery and admission continuously.
- Auto-publish only deterministic families that meet the measured policy threshold.
- Feed all passing and failing attempts into the shared corpus and distillation
  pipeline with source lineage preserved.

**Gate:** held-out review confirms the configured false-admission ceiling and no
reference leak across the calibration set, and the parent three-arm measurement is
positive rather than null.

### Phase G5 - environment synthesis and wider projections

- Synthesize Docker recipes for previously unsupported public work.
- Add QEMU and cloud desktop providers.
- Design and admit environment-delta Solutions before stateful desktop Tasks.
- Add licensed-software and private-work disclosure controls as separate opt-in
  capabilities.

**Gate:** each provider/projection pair passes the same portability, discrimination,
cleanup, and disclosure suite independently.

## 11. Verification strategy

### 11.1 Contract tests

- Strict parsing and canonical digest stability for every versioned artifact.
- Public capsule rejects hidden references and credential values.
- Submission archives reject traversal, absolute paths, symlinks, and size overflow.
- Evaluator bundle commitment mismatch fails closed.

### 11.2 Adapter tests

- SWE-rebench adapter maps existing row semantics without score drift.
- ALE task-card fields map to capsule requirements deterministically.
- Unsupported ALE tasks are rejected with a capability reason, not partially run.

### 11.3 Lifecycle integration tests

- Solver and evaluator use different clean environments.
- Reference never enters the solver environment and is staged in the evaluator
  environment only after Solution injection.
- Extract/inject round-trip preserves the positive score.
- Empty and realistic negative controls fail.
- Provision, staging, evaluator, and cleanup failures retain their typed outcome.

### 11.4 End-to-end proof

For one deterministic ALE-compatible capsule:

```text
candidate -> admission receipt -> signed task.v1 -> solver claim
          -> artifact Solution -> evaluator claim -> scored Verdict
          -> attempt in corpus -> available to distillation
```

The proof records Task, Solution, Verdict, capsule, bundle commitment, environment
digest, and admission-receipt references. Claims about automation remain limited to
the achieved automation level.

## 12. Honest limits

- A user-accepted result is a candidate positive control, not proof of correctness.
- Evaluator operators can inspect evaluator-only material in v1. Commitment checking
  proves which bundle was used, not that it stayed secret.
- File-artifact projection excludes meaningful classes of desktop and SaaS work.
- Environment fingerprints are not environment recipes; automatic synthesis is a
  separate learned capability with its own admission gate.
- Judge-based evaluation can drift and carries evaluator cost. It is never described
  as deterministic.
- A broad task distribution does not itself prove that distilled knowledge improves
  agents. The parent design's held-out three-arm measurement remains the learning
  gate.

## 13. Decisions locked by this amendment

| # | Decision | Resolution |
|---|---|---|
| D6 | Where ALE-style infrastructure enters Task Creator | At the domain-neutral Task Capsule boundary between mining and admission; ALE is the first compatibility adapter. |
| D7 | Runtime support vs. environment construction | Provider/runtime contracts land before broad tasks; rung 4 means automatic environment synthesis. |
| D8 | First generalized Solution | Canonical file-artifact bundle evaluated in a separate clean environment. Stateful projections are deferred. |
| D9 | SolverNet routing | Rebench-compatible mints stay in `swe-rebench-v2.v1`; generalized capsules use `session-derived.v2` in the existing contract family. v1 remains unchanged. |
| D10 | Initial automation | Build to A2 with human publication approval; auto-publication is earned per family through measured admission accuracy. |
| D11 | Hidden reference posture | Access-controlled evaluator bundle plus public commitment in v1; no claim of cryptographic secrecy. |

## 14. References

- `spec/2026-07-08-task-creator-v0.md` - parent Task Creator design.
- Task Creator PR [#1485](https://github.com/Jinn-Network/mono/pull/1485) and its
  [rung-1 handoff](https://github.com/Jinn-Network/mono/blob/0ae4fc1a8c794d6490b8aa4c2f2b14d72e9e5a2c/docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md)
  describe the implemented coding-path status and environment limits.
- `spec/2026-05-07-telemetry-collector-and-task-generator.md` - capture and
  `session-derived` lineage.
- `packages/sdk/src/payloads/session-derived.ts` - existing generalized payload
  scaffold.
- `packages/sdk/src/contracts.ts` - SolverNet contract registry.
- PR #1485
  [`_swe-rebench-v2-harvest.ts`](https://github.com/Jinn-Network/mono/blob/0ae4fc1a8c794d6490b8aa4c2f2b14d72e9e5a2c/client/src/solver-types/_swe-rebench-v2-harvest.ts)
  is the current coding candidate boundary.
- PR #1485
  [`_swe-rebench-v2-minted-pool.ts`](https://github.com/Jinn-Network/mono/blob/0ae4fc1a8c794d6490b8aa4c2f2b14d72e9e5a2c/client/src/solver-types/_swe-rebench-v2-minted-pool.ts)
  is the current coding task artifact.
- ALE
  [`sandbox.py`](https://github.com/rdi-berkeley/agents-last-exam/blob/186691830cd6906a405cb997b39bc5f5ca82e2a4/ale_run/base_interface/sandbox.py)
  defines the provider and sandbox boundary.
- ALE
  [`lifecycle.py`](https://github.com/rdi-berkeley/agents-last-exam/blob/186691830cd6906a405cb997b39bc5f5ca82e2a4/ale_run/orchestration/lifecycle.py)
  defines the stage/run/reference/evaluate lifecycle.
- ALE
  [`loader.py`](https://github.com/rdi-berkeley/agents-last-exam/blob/186691830cd6906a405cb997b39bc5f5ca82e2a4/ale_run/tasks/loader.py)
  and
  [`add-task.html`](https://github.com/rdi-berkeley/agents-last-exam/blob/186691830cd6906a405cb997b39bc5f5ca82e2a4/docs/ale-docs-site/pages/add-task.html)
  define the task package and authoring model.
