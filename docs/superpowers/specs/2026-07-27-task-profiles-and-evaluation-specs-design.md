# Jinn Task Profiles and Evaluation Specifications v1

**Date:** 2026-07-27

**Status:** design approved section-by-section in session; architecture and adversarial review
findings resolved; written review pending

**Shape:** `design`

**Scope:** the semantic content layer over the Task Execution Protocol — the task-profile
document mechanism, the EvaluationSpec format, the repository-work and evaluation-task
profiles, and the disposition of every SolverNet manifest function (#1650)

**Out of scope:** implementation plan, marketplace contract changes, evaluator economics and
challenge policy, profile discovery services, the Autopilot session sub-profile (deferred to
the Autopilot adapter work), prediction and session-derived profile successors, and the
benchmarking system itself

## 1. Problem statement

The Task Execution Protocol
(`docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md`, "TEP")
defines the task-profile *mechanism* — a URI naming the versioned domain contract for what a
task means — but ships zero profiles, and its sealed `evaluation` descriptor points at a
document format that does not exist yet. Meanwhile the current semantic layer has structural
problems the TEP design already named:

- **Semantics are frozen in code.** The SolverNet manifest embeds task/solution/verdict
  schemas that nothing reads; the runtime resolves `contract.{id,version}` back into one of
  **four hard-coded SDK contracts** and validates against *their* Zod. A launcher cannot
  author new semantics; the manifest can only instantiate a bundled contract.
- **The manifest is three kinds of authority stapled together** — task semantics (schemas,
  evaluation function), operator deployment choices (harness, model, plugins), and marketplace
  eligibility (the manifest-CID claim key) — and most of it is declaratory: prices are
  fictional (the mech delivery rate is the real rate), `evaluationFunction.implementation` is
  a substring hint, the manifest signature is unverified on the read path, and
  `credentialRequirements` gate nothing.
- **Evaluation inputs are evaluator-authored.** The evaluation task document is assembled
  in-memory by the evaluator's own daemon and signed by the evaluator; the creator commits to
  nothing. Grading semantics — judge models, prompts, gate order, ground-truth resolution,
  the unscorable taxonomy — live unpinned in harness code and operator-local config.
- **Benchmarking and pairing need a config-invariant work identity.** A benchmark runs the
  same work under different arms; capability evaluation pairs arms on the same work item. If
  per-run execution pinning lands in sealed Task bytes, every arm mints a different Task
  digest and the evaluation graph fragments.

Issue #1650 ("Replace SolverNets with self-contained Tasks and EvaluationSpecs") demands a
ratified account of where every manifest field moves or why it is removed, and a baseline in
which create → discover → solve → evaluate works with **no launch or join lifecycle**.

This specification answers all of the above.

## 2. Decision summary

1. **The sealed Task is the config-invariant work identity.** Per-run execution pinning
   (harness, model, loadout, isolation policy) moves to a **Submission-level requirements
   map** — same vocabulary as Task requirements, per-key comparison classes, honor-or-reject,
   and tighten-only (a Submission may narrow or add, never relax). One Task digest joins
   arms, replicates, evaluations, corpus, and pairing. The former "capsule" concept collapses
   into the sealed Task. (Carried TEP amendment 1; §5.)
2. **SolverNets dissolve fully.** No SolverNet object exists anywhere in the stack. Semantics
   move to task-profile documents; dispatch content moves to operator deployment config;
   eligibility becomes operator-side task filters over discovery-visible facts; community
   boundaries are requester-identity filters; launchers become ordinary requester
   applications. (§4.)
3. **Task profiles are sealed, published documents** — digest-pinned from the Task
   (`profile` becomes a ResourceDescriptor; carried TEP amendment 2), with single-parent
   sub-profile extension whose substitutability is **structural** (`allOf` composition over
   the parent schema), and with hardened, self-contained schemas. The profile document is the
   runtime validation authority; compiled SDK validators are digest-keyed caches. (§6.)
4. **The EvaluationSpec is a sealed document family** with grader families
   (`deterministic-process`, `model-graded`, `human-review`, `composite`), declared
   measurements, a **declarative, closed-vocabulary verdict rule** with a named
   verdict-consistency check, a first-class unscorable taxonomy, measured — not declared —
   integrity tiers, and per-artifact access classification (spec bytes public; test material
   and graders may be private). Admission receipts are DSSE-signed in-toto Statements. (§7.)
5. **Two v1 profiles ship**: `repository-work/1.0` (the `jinn-repo.v1` successor; the old
   source-union variants dissolve into provenance plus EvaluationSpec choice) and the generic
   `evaluation-task/1.0` profile, whose full-document derivation template plus
   settlement-slot pair-fixing closes the evaluator-authored-input hole, and whose delivered
   verdict **is** the DSSE-signed Result Evaluation Statement — no separate claim-issuance
   step exists. The Autopilot session variant is a sub-profile of repository-work, deferred
   to the Autopilot adapter work. (§8, §9.)
6. **`swe-rebench-v2.v1` needs no successor profile**: a row becomes a repository-work Task
   plus a per-instance `deterministic-process` EvaluationSpec. (§13.)

## 3. Scope and vocabulary

**Deliverables of this design**: (1) the task-profile document mechanism; (2) the
EvaluationSpec format; (3) the repository-work profile family, base only; (4) the generic
evaluation-task profile; (5) the SolverNet dissolution map; plus the carried TEP amendments.

**Vocabulary** (fixing the three-meanings-of-"profile" collision):

- **Task profile** — TEP meaning kept: the URI naming a versioned domain contract (payload
  schema, input/output conventions, evaluation derivation). Successor of
  `contractId.contractVersion`.
- **Run pinning** — the new name for what benchmarking called an "execution/solve profile":
  the Submission-level requirements map pinning harness, model, loadout, isolation policy
  for one dispatch. Never called a "profile."
- **Deployment profile** — TEP meaning kept: a conformance tier (marketplace profile, local
  profile). Never a community.
- **Capsule** — retired. "An admitted capsule" becomes "a sealed Task under an admitted
  profile, with its admission receipt." The #2047 adapter boundary survives; its output is
  sealed Tasks.

URI namespace convention, stated to prevent a future "fix": protocol and deployment profiles
live under `https://jinn.network/profiles/…`; task profiles live under
`https://jinn.network/task-profiles/…`. The split is deliberate disambiguation.

Execution-terminology discipline per #1979: "operator runtime" (the daemon), "harness engine"
(the per-task state machine inside it), and "dispatcher" (Autopilot's host-side loop) remain
three distinct things in all prose.

## 4. The SolverNet replacement map

Every live manifest/SolverNet function and its new home. This is the #1650 AC 1 disposition.

| SolverNet function today | Replacement |
| --- | --- |
| Semantic contract (`contract.{id,version}` resolving to bundled SDK schemas) | Task-profile document: published, sealed, digest-pinned, referenced from the Task |
| Claim eligibility (manifest-CID digest set from `joinedSolverNets`) | Operator-side task filters over discovery-visible facts: task profile URI, requester IRI, terms. Policy, not an object |
| Community boundary (Launcher A ≠ Launcher B on the same contract) | Filtering on requester identity — no object, no lifecycle |
| Harness/model/plugins (joined entry) | Operator deployment config keyed by task profile URI |
| `evaluationFunction.implementation` (harness hint) | Operator deployment config; the evaluator's declaration of what actually ran goes in the Evidence `evaluationMethod` descriptor |
| `evaluationFunction.{id,deterministic,inputs,output}` (semantic half) | The Task's sealed `evaluation` descriptor → EvaluationSpec document (§7) |
| Generators, `generatorConfig`, launched records | Ordinary requester applications producing Submissions; no launch gate |
| Launch/anchor/join lifecycle (`setMetadata`, join flow) | Dies. Profile documents publish once and are referenced by digest; operators edit filters, not memberships |
| `solutionPriceWei` / `verdictPriceWei` (already fictional) | Marketplace-binding escrow terms, visible at discovery; never in a portable document |
| `openRoles` | Dies; a "role" is which filters an operator runs (solve-shaped vs evaluation-task-shaped profiles) |
| `credentialRequirements` | Task opaque input descriptors + Submission `capabilityGrants` (TEP §7.5/§8) |
| `claimPolicyDefaults` / per-task `claimPolicy` | Submission fields (`attempts`, deadline, `evaluationRequirements` — including self-evaluation allowance) seeded by requester tooling |
| `aggregationFunction` | Consumer-side (knowledge layer, bench consumers); no protocol home per TEP §10.5 |
| Corpus autoload + engine single-flight keyed on the `solverType` alias | Re-key on the task-profile **family URI** (§6.3; binding-internal mechanics; one-time alias→URI mapping) |
| Manifest signature/anchor integrity | Profile documents are digest-pinned from every Task; the anchor becomes unnecessary for semantics (marketplace MAY anchor profile digests as a binding choice) |

**Explicit supersessions** (so nothing is silently contradicted):

- **#1650 AC 2** ("Task v2 self-contains claim policy, rewards, budgets, eligibility,
  timeout") is superseded by the TEP split: claim policy, budgets, deadlines, and eligibility
  live in the Submission and binding; rewards live in the marketplace binding. The sealed
  Task carries none of them, by design.
- **#2039** ("pin execution profile inside the signed task") is satisfied by **signed
  Submissions** carrying run pinning (§5) — the signature-invalidation property it wanted is
  preserved; the identity-fragmentation cost is not.

**Baseline invariant** (#1650 AC 3): create → discover → solve → evaluate works end-to-end
with no launch, no join, and no membership object anywhere. Legacy manifests remain readable
as historical artifacts only.

## 5. Work identity and run pinning (carried TEP amendment 1)

**Decision.** The sealed Task carries only **work-intrinsic** requirements — constraints that
belong to what the work *means*. Per-run execution pinning lives in a **Submission-level
requirements map** sharing the Task-requirements vocabulary, extended with pinning keys:
`harness` (id + version or digest), `model` (constraint or pin), `loadout`
(ResourceDescriptor + typed kind per #2040: `jinn.skill.v1` vs opaque artifact; digest-
verified before harness start, fail-closed), and `isolationPolicy` (a policy id *within* the
core `isolation` class key — one key family, not two).

### 5.1 Comparison classes (the tighten-only semantics)

Every requirement key — core and profile-added — declares exactly one **comparison class**,
and the merge check is defined per class. A backend evaluates the merge at `submit` over both
byte documents:

| Class | Merge rule when the key appears in both Task and Submission |
| --- | --- |
| `exact` | values must be byte-equal; otherwise `invalid-document` |
| `ceiling` | numeric; Submission value ≤ Task value (budgets, durations) |
| `floor` | numeric/ordered tiers; Submission value ≥ Task value (`effort` is a floor) |
| `constraint` | the Submission value must satisfy the Task's constraint per the key's defined membership test (e.g. Task `model: {provider: anthropic}` admits Submission `model: {id: claude-…}`; a pin outside the constraint is `invalid-document`) |
| `addable` | key absent in the Task → the Submission may set it freely (loadout on an unconstrained Task) |

A key present in both documents whose class defines no applicable relation, or an unknown
class, is `invalid-document` on byte-inequality — the conservative default. Profile-added
keys (§6.1 `requirementKeys`) MUST declare their class. Same-key conflict fixtures are part
of the kit (§12).

### 5.2 Capability declaration and honor semantics

`BackendCapabilities` gains a **`runPinning`** block declaring which pinning keys the backend
supports and its inventories (available harnesses, model constraints, supported loadout
kinds, isolation policies) — closing the gap where TEP §15 requires rejection of undeclared
parameters but had no slot to declare these. The block also declares the backend's
**enforcement posture** per key:

- **`enforced`** — direct-execution bindings (local): the backend itself guarantees the
  pinned configuration runs.
- **`attested`** — open-competition bindings (marketplace): the binding cannot execute the
  work itself; "honor" means the pinning is conveyed to claimants as a claim-eligibility
  constraint, required of them, and **verified after the fact** by comparing the pinning
  against the Evidence Runtime Observation (effective-execution attestation, #2041). The
  requirement stays prospective; the recorded fact decides — TEP §18's posture. A mismatch
  is consumer-side invalidation (a bench cell is invalidated), never a protocol state.

Either way, a pinning key the backend does not declare support for is a typed
`unsupported-requirement` rejection at `submit`.

### 5.3 Consequences

- One Task digest is the config-invariant work identity. Benchmark arms are Submissions of
  the same Task differing only in run pinning; replicates are separate Submissions (a
  marketplace binding may post per-replicate as a binding-internal mapping). Cell context
  (`runId`, `cellKey`, `configId`) rides as namespaced Submission extensions — application
  context, signed where the deployment signs Submissions, opaque to core (the #2045
  posture).
- Evaluations, pairing, and corpus join on the Task digest with no second identity.
- **Loadouts are untrusted content.** Digest verification is an integrity check, not a trust
  decision: a pinned loadout faithfully delivers whatever the requester sealed, including
  hostile prompt-adjacent content. Backends declare supported loadout *kinds* and reject
  others; operators may filter on pinning content before claiming; an engaged operator may
  still terminate `rejected`. Loadout artifacts convey no authority (TEP §20's
  untrusted-content posture, restated here because pinning makes execution a requirement).

## 6. The task-profile document mechanism

A task profile is a sealed document — I-JSON, sealed per TEP §6.1, media type
`application/vnd.jinn.task-execution.task-profile.v1+json`. Authoring a new domain means
publishing a document, not shipping SDK code.

### 6.1 Contents

| Field | Content |
| --- | --- |
| `protocol` | the task-profile document-format URI (symmetry with every other sealed family) |
| `profile` | the profile URI, versioned (patch/minor/major per TEP §21.4) |
| `description` | domain semantics in prose — what this work means |
| `payloadSchema` | JSON Schema 2020-12 for `Task.payload` (hardened per §6.4) |
| `inputConventions` | named input slots the domain expects and what their descriptors must carry |
| `outputConventions` | required output slots, media types, schemas |
| `evaluationFamilies` | which EvaluationSpec families apply to this domain. **This is a whitelist only** — the evaluation-task derivation itself is fixed by `evaluation-task/1.0` (§9) and is not profile-overridable |
| `requirementKeys` | profile-specific additions to the requirements vocabulary, each with its declared comparison class (§5.1) |
| `extends?` | `{uri, digest}` of a single parent profile (§6.3) |
| namespaced extensions | TEP §21.3 rules |

### 6.2 Digest pinning and resolution (carried TEP amendment 2)

The sealed Task's `profile` field becomes a **ResourceDescriptor: URI + digest** (+ locator
hints). The URI answers "which domain contract and version"; the digest answers "exactly
which contract text," so a URI cannot silently serve different content to later Tasks.

Resolution is defined: backend support means **(URI, resolvable digest)**. A backend holding
only a different digest for the same URI (a newer patch) MUST NOT validate against its cached
document; it either resolves the pinned digest (locator hints, its own store) or rejects with
`unsupported-profile`, naming the unresolvable digest in the error detail. Compiled-validator
caches are keyed **by digest**, and the §6.4 drift check runs per digest.

### 6.3 Sub-profiles: structural substitutability, defined family

A profile may `extends` exactly one parent (chains allowed, digest-pinned, bounded depth: 8).
The promise is substitutability — *every conforming sub-profile Task is a conforming
parent-profile Task* — and it is enforced **structurally, not by fixtures alone**:

- a sub-profile's `payloadSchema` MUST be `allOf: [<parent payloadSchema, embedded by
  digest-verified copy>, <refinement>]` — JSON Schema 2020-12 defines no schema-subset
  relation, and `allOf` composition is the standard-correct construction that makes
  parent-validity hold *by construction* rather than by spot-check;
- parent `payloadSchema`s MUST be extension-tolerant (open to unknown properties), which is
  also what makes "a sub-profile may add required inputs/outputs/keys" well-formed;
- a sub-profile may add obligations and narrow ranges; it may never remove a parent
  obligation. Substitutability is a normative obligation on profile authors; the kit's paired
  fixtures are the regression floor, not the mechanism;
- family-keyed consumers get parent-validity for free from the `allOf` construction and need
  not validate against ancestors.

**Family URI, defined**: the family of a profile is the **unversioned URI of the root
ancestor of its `extends` chain** (walk `extends {uri, digest}` to the root, digest-verified,
depth-bounded; strip the version segment). Corpus, pairing, and operator filters join on the
family URI — so a parent *minor* bump does not fragment family joins. Version-exact
comparisons (a benchmark pinning grading semantics) additionally key on the versioned URI +
digest. Lineage is frozen: a sub-profile adopts a new parent version only by republishing
with a new `extends` digest.

### 6.4 The document is the runtime authority — and a hardened input

Conformant implementations validate Tasks, payloads, and deliveries against the profile
document's schemas; compiled validators are caches with a per-digest drift check. Because
anyone may publish a profile, profile and EvaluationSpec schemas are **validator input from
untrusted sources** and MUST be safe to load:

- schemas MUST be self-contained: no external `$ref`; validators MUST NOT perform network
  retrieval during validation;
- document size and schema nesting depth are bounded (profile-format constants);
- regular expressions in schemas MUST be evaluated with bounded/safe-regex semantics.

Violations are `invalid-document`. The kit carries schema-bomb adversarial fixtures
(remote-`$ref`, ReDoS pattern, depth bomb).

### 6.5 No registry

There is no profile-registry object in the protocol. Backends advertise supported profile
URIs via `capabilities.taskProfiles[]`; operators configure which profiles they execute;
anyone may publish a profile in a namespace they control. Jinn-authored profiles live in this
repository and publish from it. Finding profiles is an application/ecosystem concern — the
same posture as Evidence Repository discovery.

## 7. The EvaluationSpec format

A sealed document — I-JSON, sha256, media type
`application/vnd.jinn.task-execution.evaluation-spec.v1+json` — that the Task's `evaluation`
descriptor points at by digest. It makes "what correctly done means" operational: given
`(task, result)`, how a verdict and measurements are produced. Sealed before the Task that
references it; shared across many Tasks or per-task.

### 7.1 Shape

| Field | Content |
| --- | --- |
| `protocol` | the EvaluationSpec format URI |
| `semanticsVersion` | the grading-semantics version (today's `EVAL_SEMANTICS_VERSION`, promoted from a code constant into sealed bytes) |
| `family` | `deterministic-process` \| `model-graded` \| `human-review` \| `composite` |
| `grader` | ResourceDescriptor(s) for the grader implementation/bundle. MAY be private: digest + access classification — committed without being revealed |
| family block | typed per-family parameters (§7.2) |
| `measurements` | declared metric list: name, type, unit, direction, required/optional |
| `verdictRule` | §7.3 |
| `unscorable` | §7.4 |
| `evidenceConventions` | what the grader must attach as evidence refs (test logs, reports, oracle readings) |
| namespaced extensions | TEP §21.3 rules |

**Access classification generalizes to every referenced artifact**, not only graders: test
material, rubrics, and reference data each carry digest + media type + access class. The
recommended posture: **the spec document's own bytes are public** — so `verdictRule`,
`measurements`, and the unscorable taxonomy stay checkable by third parties — while test
material and grader bytes are private where grading validity demands it, resolved only via
the *evaluation* Submission's `capabilityGrants`. Nothing in a spec document ever carries a
credential.

`composite` declares weighted sub-specs, each a digest-referenced EvaluationSpec, with
bounds (depth ≤ 2, fan-out ≤ 32 — digest references preclude cycles) and defined
propagation: any sub-spec `retryable-infrastructure` outcome is an infrastructure outcome for
the whole evaluation; `inconclusive` propagation must be handled explicitly by the
composite's own `verdictRule`; sub-spec unscorable class names are namespaced by sub-spec.

### 7.2 Family blocks

- **`deterministic-process`** — the `TaskEnvironmentSpec.v1` content, sealed: digest-qualified
  OCI image + platform + workspace; test material by digest (test patch, per-path command
  templates) with access classification; **parser by `{id, version, digest}`** — the digest
  is the semantic commitment; the "trusted parser registry" is a *deployment-side execution
  allowlist*, never a condition of document validity — task- or spec-supplied parser code is
  never executed; expected-transition semantics stated (all fail-to-pass pass AND no
  pass-to-pass broke; extra tests do not invalidate); timeout; setup policy.
- **`model-graded`** — rubric/prompt by digest; judge model declared under the Evidence
  opaque-component rules (provider, model/deployment id, advertised version, effective
  parameters — no invented digests); required judge-output schema; structural gates bounding
  the judge.
- **`human-review`** — review form/rubric by digest; declarative reviewer-qualification
  requirements; what the reviewer attests. The qualification block is an *instrument*
  declaration (parallel to the judge-model declaration), not evaluator selection — who the
  reviewer is remains Submission/deployment policy, preserving TEP §7.3's spec/policy split.
  Verifying identity and qualification is the trust layer's job.

### 7.3 The verdict rule — declarative, checkable, checked

`verdictRule` is a **declarative structure in a closed vocabulary** over the declared
measurement names: threshold comparisons, boolean combinators, and explicit
inconclusive-predicates. No executable code, no external references, no reading anything
outside the delivered measurements — the same posture as the parser rule. This is what makes
"deterministic" verifiable rather than asserted.

The **`verdict-consistency` check**, named here and required by the marketplace deployment
profile before verdict settlement: the delivered verdict MUST equal
`verdictRule(measurements)`, and `inconclusive` is legal only when a declared
inconclusive-predicate or a declared `recorded-inconclusive` class (§7.4) holds. This closes
fail-laundering: an evaluator cannot emit `inconclusive` where the rule says `fail`.

The marketplace verdict-code projection (Pass/Fail; Invalid and Unresolved both project to
`inconclusive`) is an informative note; the normative mapping lives in the marketplace
binding.

### 7.4 The unscorable taxonomy

Named failure classes, each tagged with exactly one disposition:

- **`retryable-infrastructure`** — no verdict exists; the evaluation Attempt terminates
  `failed {blame: infrastructure}`; any retry is a new Attempt under TEP §9.2's rules. This
  is never a FAIL and never an `inconclusive`. Examples: grader substrate down, image
  unpullable, substrate drift.
- **`recorded-inconclusive`** — a verdict *is* emitted: `inconclusive`, carrying the named
  limitation. Examples: capability limit, evaluation window still open.

The declared taxonomy bounds the `recorded-inconclusive` vocabulary — an undeclared
limitation class is a `verdict-consistency` failure. It cannot bound the infrastructure
disposition, because TEP-core `failed {blame: infrastructure}` is available to any Attempt;
serial infrastructure-dodging is bounded by the Submission's attempt budgets, evaluator
competition, and the challenge economics (Phase B.2) — with the evaluation run's Execution
Evidence as the audit substrate for on-demand verification, not as a bound in itself.

### 7.5 Integrity is measured, not declared — and honestly limited

Whether a spec is **`re-derivable`** (≈zero replay variance, no network — disputes settled by
re-execution) or **`attested-only`** is determined by admission replay evidence carried in
the admission receipt, never asserted by the spec. For the `re-derivable` tier, admission
replays and deployment-side grader execution MUST run under a pinned/normalized clock, so
re-execution is a pure function of committed inputs (an unpinned clock lets a time-bombed
grader pass admission and flip later, with re-execution *confirming* the corrupt verdict).

Stated honestly: **admission receipts prove control-set behavior, not general honesty.** An
input-keyed backdoor in a private grader (passing any result bearing a colluder's marker) is
out of the receipt's reach. Deployments that grant economic credit MUST NOT treat pass
verdicts under requester-supplied private graders as verified work without additional
controls — spot re-grades under substituted graders, attested-tier requirements, or the
challenge mechanism. That boundary belongs to evaluator economics (B.2) and the credit
layer, and this spec names it rather than papering over it.

### 7.6 Admission receipts — signed statements, defined path

An admission receipt is a **DSSE-signed in-toto Statement** (TEP §21.2's
assertions-about-records slot): subjects = the sealed Task digest and the EvaluationSpec
digest; issuer = the admission agent's IRI (Evidence §5.1 identity rules); predicate = the
admission evidence (controls, replay variance, separation checks, policy version).

Data path, normative: the receipt reference rides the **subject Submission's** annotations;
the binding that derives the evaluation task MUST carry it into the evaluation task as an
input descriptor. Receipt discovery is a binding obligation, not a service.

The evaluator's required check (marketplace profile): DSSE signature validity; subject
digests equal to the subject Task's digest and its sealed `evaluation` descriptor digest;
issuer acceptable under deployment policy. A schema-valid but unsigned or subject-mismatched
receipt is invalid. (This replaces the "Admission receipt schema v2" deferral — the signed
shape is a v1 requirement; only the predicate details unify later.)

### 7.7 Evidence crosswalk (scoped precisely)

- For claims produced by executing this spec — and for any claim a deployment counts toward
  `evaluationRequirements` — the Result Evaluation `evaluationSpecification` digest MUST
  equal this document's digest. Other parties remain free to evaluate by other standards
  (TEP §7.3's non-exclusivity); those claims simply don't satisfy this task's requirements.
- The claim's `evaluationMethod` is the **evaluator's** declaration of how it actually ran
  the spec (harness version, observed image digest, actual model deployment) — produced at
  evaluation time, never part of this sealed document. Spec = the contract; method = the run.
- The claim's `measurements` MUST include every measurement this spec marks required.

## 8. The repository-work profile

**URI:** `https://jinn.network/task-profiles/repository-work/1.0` (reserved; must resolve to
the published document before external conformance claims, per the TEP/Evidence convention).

The `jinn-repo.v1` successor, slimmed to what is task-semantic:

- **Instructions** (TEP core field): the problem statement itself.
- **Payload**: domain keys and context only — `instance_id?` (the queryable work key
  capability-eval pairs on), `language`, `interface?` notes, and an optional `provenance`
  block (`kind: mined | synthetic | live`; blinded `sourceCommitment?`; the task-creator
  lineage requirements: minted work is marked synthetic, source lineage supports
  echo-collapse in distillation). No test material, no dispatch state, no effort field.
- **Inputs**: one required named slot, `repository-state` — repository URL + immutable 40-hex
  ref + optional tree digest; optional knowledge-packet inputs.
- **Outputs**: required `patch` (unified diff, UTF-8, profile-bounded size); optional
  `summary` (markdown); optional `evidence` (structured commands/tests/notes). Matches both
  today's solution payloads and the Autopilot mutation result, so the deferred sub-profile
  only tightens.
- **Evaluation families**: `deterministic-process` (gold tests; mechanical gates) and
  `model-graded` (review). The verdict leg derives per §9.

**The old `source` union dissolves**: `merged-pr` = mined provenance + a gold-test
deterministic spec (test material access-classified private for production use, §7.1);
`live-issue` = live provenance + a mechanical-gates spec; the Autopilot session variant = a
stricter sub-profile (workflow discriminator, workflow-contract pin, byte-budget strictness —
all tightenings, expressed via §6.3's `allOf` construction), **deferred** to the Autopilot
adapter work. One family URI; corpus and pairing key on it.

## 9. The evaluation-task profile

**URI:** `https://jinn.network/task-profiles/evaluation-task/1.0` (reserved).

The one generic, thin profile for evaluation-as-work. Evaluation *declaration* stays part of
the subject Task (the sealed `evaluation` descriptor). This profile exists because evaluation
*execution* is itself agentic work executed through the same claim → execute → deliver
machinery as any solve (TEP §7.6: no role enum). This is that task's shape.

### 9.1 The derivation — full-document template, slot-fixed pair

**Template.** The profile fixes the **entire evaluation Task document** as a deterministic
template over the pair `(T, D)` — not just the payload: fixed `instructions` text, fixed
input-slot construction, fixed output declaration, and the payload:

- `subjectTask` = `{name, digest}` of T;
- `subjectDelivery` = `{name, digest}` of D;
- `subjectResults[]` = the output slots of D as `{name, digest}` pairs, **sorted by name**;
- `evaluationSpec` = T's sealed `evaluation` descriptor digest.

Digests only, name-sorted, schema-fixed field order — so the sealed evaluation-task bytes,
and therefore its digest, are identical across independent derivers, and the `instructions`
field is template-fixed rather than an injection surface.

**Pair-fixing.** Determinism in the pair is necessary but not sufficient — the pair itself
must not be chosen by the party being checked. Normative rule: **the settlement context fixes
the pair.** A deployment's verdict slot exists for a specific delivery D of a specific task
T; the deployment's check is byte-equality of the evaluation task against `derive(T, D)` for
*the slot's own pair* — never consistency with some pair the evaluator selected. Default
evaluability rule: D is the latest non-superseded Delivery of its Attempt with outcome
`fulfilled`; evaluating `partial` or superseded deliveries requires the subject profile or
deployment to say so explicitly.

**Sealer.** Deployment profiles name who seals the evaluation Task and its Submission. In
the marketplace it is the requester-side binding (or requester tooling): the evaluation
Submission needs `capabilityGrants` for private graders and test material, and only the
subject requester holds authority over those grants (TEP §7.5) — a self-sealing evaluator
could not dispatch the private-grader case at all. Where a deployment permits
evaluator-sealed evaluation tasks (fully public specs), the slot-check above still applies
unchanged.

### 9.2 Inputs and outputs

- **Inputs**: the referenced artifacts as fetchable descriptors; the grader bundle and any
  private test material (access via the evaluation Submission's `capabilityGrants`); the
  admission receipt where present (§7.6).
- **Output — the verdict *is* the claim.** One required output slot, `verdict`, whose media
  type is a **DSSE envelope (`payloadType: application/vnd.in-toto+json`) containing the
  in-toto Result Evaluation Statement, signed by the evaluator Agent's key**:
  - subjects = the `subjectTask` and `subjectResults` entries (names + digests) from the
    payload — the *original* pair, per Evidence §7's rules including the multi-file
    Result-manifest convention;
  - predicate = `evaluatedAt`, `evaluator.id`, `evaluationSpecification` (= the spec digest;
    checked), `evaluationMethod` (evaluator-authored: what actually ran),
    `taskSubject`/`resultSubjects`, `verdict`, `measurements` (covering the spec's required
    list), `limitations`, `evidence` (per the spec's `evidenceConventions`).

  There is no separate claim-issuance or translation step, no second issuer, and no
  document-vs-claim divergence to check: the delivered bytes are the appendable Evidence
  record, signed by the party whose independence matters. The marketplace's on-chain verdict
  code is projected from the claim by the binding.

### 9.3 Termination (normative, because the question will recur)

Evaluation-as-a-task creates no regress:

1. **Claims bind downward.** An evaluation's output is a claim about the *original*
   `(task, result)` pair. Evaluations accumulate flat, side by side, on the thing being
   judged.
2. **Evaluation is opt-in per dispatch.** `evaluationRequirements` is a Submission field set
   by the requester; Submissions of evaluation tasks carry none by default, and the
   marketplace profile does not fund verdict legs for them. Termination is therefore by
   default and by economics — mirroring today's system, where solutions get verdicts and
   verdicts are recorded, never verdict-ed. (A deployment *may* explicitly commission
   co-evaluation of an evaluation; that is breadth, bounded by whoever pays.)
3. **Scrutiny of an evaluation has non-recursive instruments**: independent co-evaluation of
   the same base pair; Execution Verification of the evaluation run's evidence (process
   integrity: did the committed grader actually run — the `grader-ran-the-committed-bundle`
   check — over the right inputs, with the `dispatch-binding` check); or a `disputes` claim.
   All three attach flat.

The evaluation run is a first-class execution: its own Task (this profile), its own Attempt,
Execution Evidence (required by the marketplace profile — the audit substrate for the checks
above), and a Delivery under the same digest discipline as any other.

## 10. Data flows

### 10.1 Marketplace solve + verdict leg

Requester seals an EvaluationSpec, then a repository-work Task referencing it; submits with
`evaluationRequirements: {minVerdicts: 1, distinctEvaluator: true}` and an admission-receipt
annotation. A solver's Attempt delivers a patch. The requester-side binding derives the
evaluation task per §9.1 for the settlement slot's `(T, D)`, carrying the receipt and grants;
the evaluator's Attempt executes the spec and delivers the DSSE-signed Statement; the binding
runs the named checks (derivation byte-equality, receipt validity, `verdict-consistency`,
evaluator ≠ solver) and projects the verdict code on-chain. Settlement stays
binding-internal.

### 10.2 Benchmark arms

One repository-work Task; arm A = Submission with empty-loadout run pinning; arm B =
Submission pinning `loadout: {ref, sha256, kind: jinn.skill.v1}`. Replicates are further
Submissions. Cell context rides as namespaced Submission extensions. All cells share the Task
digest; verdicts from the same sealed EvaluationSpec are directly comparable;
effective-execution attestation vs pinning decides cell validity consumer-side.

### 10.3 swe-rebench migration

A row becomes: repository-work Task (`instructions` = problem statement; `repository-state` =
repo@base_commit; `instance_id` in payload) + a per-instance `deterministic-process`
EvaluationSpec (image digest, test material, parser identity, transitions, timeout — the
`TaskEnvironmentSpec.v1` content). `rowHash`'s drift-guard role is subsumed by sealed
digests. Access classes: swe-rebench rows are already public upstream, so their test material
stays public; production gold-test repository-work marks test material private (§7.1) —
today's operational solver/evaluator separation becomes a declared property.

### 10.4 Local development, no evaluation

An application seals a repository-work Task with no `evaluation` descriptor, submits locally
with no evaluation requirements, applies the patch itself. Fully conformant; a Task with no
`evaluation` descriptor has no derivable verdict leg, and deployments requiring evaluated
work require the descriptor at posting time (deployment rule, not core).

## 11. Security and adversarial considerations

- **Derivation checking** (§9.1): full-document template + settlement-slot pair-fixing makes
  a substituted, superseded, or self-serving evaluation input detectable byte-for-byte, and
  removes the evaluator's freedom to choose the pair.
- **Verdict-consistency** (§7.3): the declarative rule plus the named check close
  fail-laundering into `inconclusive`.
- **Receipt authentication** (§7.6): forged or reused receipts fail signature/subject
  checks; the integrity tier stays measured, not declared-in-a-second-document.
- **Profile-digest pinning + resolution** (§6.2) prevents URI-content drift and defines the
  cache-mismatch outcome; **schema hardening** (§6.4) removes the schema-bomb surface.
- **Sub-profile laundering** (§6.3): the `allOf` construction makes parent-validity
  structural; a "sub-profile" that widens simply fails to be one.
- **Trusted parser registry** (§7.2): the digest is the semantic commitment; the registry is
  a deployment execution allowlist, never a document-validity gate — no hidden central
  authority inside the format.
- **Private graders** (§7.5): receipts prove control-set behavior under pinned clocks;
  input-keyed backdoors are explicitly out of receipt reach and are handled by spot
  re-grades, attested-tier requirements, and challenge economics — deployments granting
  economic credit are told so in normative text.
- **Unscorable abuse** (§7.4): `recorded-inconclusive` vocabulary is spec-bounded and
  consistency-checked; infrastructure-dodging is bounded by attempt budgets, competition,
  and B.2 economics, with evaluation-run evidence as the audit substrate.
- **Hostile loadouts** (§5.3): digest verification is integrity, not trust; kinds are
  capability-gated; operators retain pre-claim filtering and post-claim rejection.
- **No secrets in sealed documents**, ever — profiles, specs, and receipts carry digests and
  access classifications; grants ride Submissions (TEP §7.5/§8 unchanged).

## 12. Conformance and fixtures

Extending the TEP kit, same golden/adversarial split, in the profiles package:

- profile-document schema validation; digest-pinning and resolution checks (unknown-digest
  rejection); compiled-validator drift checks per digest;
- sub-profile `allOf`-construction checks; substitutability pairs plus violation fixtures;
  family-URI resolution (chain walk, depth bound);
- schema-bomb adversarial fixtures: remote-`$ref`, ReDoS pattern, depth bomb, oversized
  document;
- requirement-merge fixtures per comparison class, including same-key conflicts and
  pinning-key inventory rejections;
- EvaluationSpec family-block schemas; `verdictRule` closed-vocabulary validation;
  `verdict-consistency` fixtures (rule-says-fail/delivered-inconclusive caught); unscorable
  classification fixtures (retryable-infrastructure vs recorded-inconclusive, never FAIL);
  measurements-coverage checks; composite bounds and propagation fixtures;
- evaluation-task derivation goldens (`(T, D)` → expected full-document bytes) plus
  adversarial variants: superseded-delivery substitution, competitor-delivery substitution,
  wrong spec digest, evaluator-modified template;
- receipt fixtures: valid signed receipt; forged (unsigned/wrong-subject/reused) receipts
  rejected;
- `jinn-repo.v1` → repository-work migration fixtures; a complete swe-rebench golden (row →
  Task + EvaluationSpec pair, sealed, digest-stable).

Measurement-coverage and claim checks are structural JSON inspection over the DSSE payload —
no evidence-package import; `profiles` never depends on `testing` (consumers of the fixtures
depend on `profiles`), keeping the graph acyclic.

## 13. Migration

- **`jinn-repo.v1` → repository-work/1.0**: `problem_statement` → `instructions`;
  `repo`/`base_commit` → `repository-state` input; `test_files`/`test_cmd` → gold-test
  deterministic EvaluationSpec (test material access-classified); `effort` → core requirement
  key; `source` union → provenance + spec choice (+ deferred sub-profile). The `solverType`
  alias retires; corpus autoload and single-flight re-key on the family URI with a one-time
  alias→URI mapping.
- **`swe-rebench-v2.v1`**: no successor profile; rows migrate per §10.3. Reference-by-lookup
  (`hf_dataset`/`hf_split`) becomes locator hints; row content promotes into sealed
  descriptors.
- **SolverNet retirement**: legacy manifests and launched records go read-only historical;
  generators re-home as requester applications; `joinedSolverNets` migrates mechanically into
  operator task filters + per-profile deployment config. Whether the marketplace binding
  reuses the on-chain `manifestDigest` slot to anchor profile digests is a binding-level
  decision, deliberately unmade here.
- **#1650 closure**: AC 1 = §4; AC 2 = explicitly superseded (§4); AC 3 = the baseline
  invariant; AC 4 (operator-app spec rewrite: memberships → capabilities/filters,
  launcher/generator → create-Task surfaces) and AC 5 (issue decomposition) are
  implementation-phase work this spec enables but does not perform.
- **Carried TEP amendments** (recorded here; the committed TEP v1 document absorbs them at
  implementation): (1) the Submission requirements map — run pinning, shared vocabulary with
  per-key comparison classes, tighten-only, honor-or-reject, with the `runPinning`
  capability block and enforcement postures of §5.2; (2) `Task.profile` as a
  ResourceDescriptor (URI + digest) with the §6.2 resolution rule; (3, editorial) TEP §6.4's
  "correlation annotations" definition widens to admit application context carried as
  namespaced extensions (the §5.3 cell-context usage).

## 14. Package and repository structure

One new package beside the TEP stack:

```text
packages/task-execution/
  profiles/            @jinn-network/task-execution-profiles
                       The EvaluationSpec format schema, the task-profile
                       document schema, the sealed repository-work/1.0 and
                       evaluation-task/1.0 documents as assets, compiled
                       validators (digest-keyed caches; documents
                       authoritative), the verdict-rule vocabulary, the
                       parser-registry convention, and the fixture families
                       of §12. Depends on protocol only.
```

Dependency rules unchanged and acyclic: `profiles` → `protocol`; nothing marketplace-flavored
enters it; evidence packages are not imported (claim inspection is structural). The
marketplace binding and Autopilot adapter consume `profiles` from their own trees.

## 15. Recommended delivery sequence

Dependency-forced order; implementation planning happens later:

1. **EvaluationSpec format** — schemas + verdict-rule vocabulary + fixtures + the
   parser-registry convention.
2. **Profile mechanism** — document schema, `allOf` extends validation, family resolution,
   schema hardening.
3. **The two profile documents** — repository-work/1.0, evaluation-task/1.0 (with the
   derivation template), goldens.
4. **swe-rebench migration** onto repository-work + per-instance deterministic specs —
   proving the format on the hardest deterministic case.
5. **Marketplace-binding adoption** — posting with profile descriptors; the named checks
   (derivation slot-equality, receipt validation, verdict-consistency) — alongside the TEP
   marketplace-binding work.
6. **Autopilot sub-profile** — with the Autopilot adapter work.
7. **SolverNet retirement** — operator filter config, generator re-homing, read-only legacy.

## 16. Explicit non-goals

This specification does not define: evaluator economics, quorum, or challenge policy (Phase
B.2); evaluator identity verification (the trust layer); any profile registry or discovery
service; aggregation semantics (consumer-side by TEP §10.5); corpus admission policy;
prediction and session-derived profile successors; the Autopilot session sub-profile (adapter
work); the benchmarking system (a consumer of this layer); marketplace contract changes; or
an implementation sequence beyond §15's dependency order.

## 17. Non-blocking follow-ups

- **Autopilot session sub-profile** — first consumer of §6.3, specified by the adapter work.
- **Prediction-family profile** — the oracle-resolution EvaluationSpec family (spanning-round
  semantics, score bases) deserves its own family block when that profile is designed.
- **Session-derived successor** — its composite evaluator maps to `composite`; its
  bond-style credential and evaluator economics await the trust layer.
- **Parser-registry and admission-agent governance** — who may add parsers, who runs
  admission agents, and how their identities are published (deployment policy today).
- **Profile document publication tooling** — sealing, URI hosting, and the resolve-before-
  external-claims check as reusable tooling.
- **Admission receipt predicate unification** — one predicate schema unifying the capsule
  admission and differential-admission evidence shapes (the signed-Statement envelope is
  already normative per §7.6).
- **Scheme IRIs** — register the `identifier` `propertyID` IRIs for profile URIs and task
  digests stamped into Evidence entities (shared follow-up with TEP §28).

## Appendix A. Sources used for the design audit

**This branch (`claude/task-execution-protocol-design-d04746`):**
`docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (TEP v1);
`docs/superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md` (§5–§10, §12);
`docs/superpowers/specs/2026-07-10-task-creator-generalized-task-capsules-design.md`;
`docs/superpowers/specs/2026-07-10-task-creator-public-repo-substrate-design.md`
(`TaskEnvironmentSpec.v1`);
`docs/superpowers/specs/2026-07-12-task-creator-real-jinn-differential-admission-design.md`;
`spec/2026-07-08-task-creator-v0.md` v0.4; `spec/2026-07-06-capability-eval-v0.md`;
`spec/2026-05-05-solvernet-creation-and-launch.md` §7–§17;
`docs/superpowers/specs/2026-07-23-autopilot-v2-marketplace-session-backend-design.md`.

**Branch `claude/jinn-skill-factory-design-1eaf45` (via `git show`):**
`docs/superpowers/specs/2026-07-22-solvernet-benchmarking-primitive-design.md` v0.2
(`BenchmarkRunV1`, `ConfigV1`, `jinn.bench-matrix.v1`, integrity tiers);
`docs/superpowers/specs/2026-07-16-jinn-skill-factory-design.md` §4.5 (loadout injection).

**origin/next (production behavior, via `git show`):**
`packages/sdk/src/solvernets/manifest-schema.ts`; `packages/sdk/src/contracts.ts`;
`packages/sdk/src/{jinn-repo,autopilot-session,task-submit,swe-rebench-v2}.ts`;
`packages/sdk/src/payloads/{jinn-repo,swe-rebench-v2}.ts`;
`client/src/solver-nets/registry.ts`; `client/src/solver-types/`;
`client/src/harnesses/impls/index.ts`, `_evaluator-base.ts`, `evaluation-context.ts`;
`client/src/harnesses/impls/{jinn-repo-evaluator,swe-rebench-v2-evaluator,prediction-v0-evaluator,session-derived-evaluator}/`;
`client/src/harnesses/engine/{engine,registry}.ts`;
`client/src/adapters/mech/{adapter,verdict-code,digest}.ts`;
`client/src/types/{task-document,task,payloads/index}.ts`;
`client/src/solvernets/{registry-client-erc8004,launched-record-dispatcher,manifest}.ts`;
`client/src/api/{setup-endpoints,solvernets-endpoints,launcher-tasks}.ts`;
`client/src/autopilot/official-profile-policy.ts`;
`contracts/src/tasks/TaskCoordinator.sol`; `docs/runbooks/add-solver-type.md`.

**GitHub issues:** #1650 (replace SolverNets — ACs disposed per §13); the #2038 train
(#2039–#2047, notably #2039 run pinning, #2040 loadouts, #2041 isolation/attestation, #2045
authenticated evidence, #2047 generic capsule adapter); #1979 (execution terminology);
#1891 (live-issue gates); #547 (evaluator enablement).

**Standards (primary sources):** UK AISI Inspect task/scorer model; OpenAI Evals YAML
registry format; EleutherAI lm-eval-harness task configuration — audited as prior art for the
EvaluationSpec shape (identity envelope, grader families, declared metrics adopted;
code-as-declaration and undigested dataset references rejected). JSON Schema 2020-12
(confirmed: no schema-subset relation; `allOf` composition as the narrowing construction;
retrieval of network-addressable `$ref`s implementation-defined — hence §6.4's
self-containment rule), RFC 8785, and the OCI descriptor grammar inherited via TEP; DSSE v1 +
in-toto Statement v1 for verdicts and receipts.
