# TEP v1 Implementation Addendum — Carried Amendments and Follow-Ups

**Date:** 2026-07-28

**Status:** informational; not a design change

**Shape:** `design`

**Implements:** `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (TEP v1)

**Absorbs:** the three carried amendments recorded in
`docs/superpowers/specs/2026-07-27-task-profiles-and-evaluation-specs-design.md` §13

**Produced by:** `docs/superpowers/plans/2026-07-28-task-execution-protocol.md` (Milestone 4,
Task 4.2), per the coordinator brief instruction to record the carried amendments as a dated
addendum note.

This note records, for the historical record, exactly what the shipped
`@jinn-network/task-execution-{protocol,backend,testing}` packages implement beyond the literal
TEP v1 design text, and what they deliberately did not implement. It makes no new design
decisions; every item below traces to either the profiles §13 carried-amendment set or a
`2026-07-28-stack-implementation-program.md` §7 coordinator ruling.

## 1. The three carried amendments (profiles §13)

### 1.1 Submission-level requirements map / run-pinning keys (profiles §5)

The Task-level `requirements` map is work-intrinsic only. A Submission may additionally pin
*how* the work runs — `harness` (id + version|digest), `model` (constraint|pin), `loadout`
(a `ResourceDescriptor` with a typed `kind`, e.g. `jinn.skill.v1`, or opaque), and
`isolationPolicy` (a policy id within the `isolation` class family) — sharing the same
requirement vocabulary and comparison-class machinery as Task requirements.

Implemented in:

- `protocol/src/schemas/common.ts` — the core requirement-key vocabulary (`maxAttemptDurationMs`,
  cost/token budgets, isolation class, network policy, `evidenceCapture`, tool/model constraints,
  `effort` tiers `low|medium|high|xhigh|max`) plus the run-pinning keys, shared by both
  `RequirementsMap` (Task) and the Submission-level map.
- `protocol/src/schemas/submission.ts` — `SubmissionRecordSchema.requirements` (optional),
  documented as the carried-amendment-1 run-pinning map.
- `protocol/src/requirements.ts` — `mergeRequirements(taskRequirements, submissionRequirements,
  keyClasses)`, the tighten-only merge over the five profiles §5.1 comparison classes (`exact`,
  `ceiling`, `floor`, `constraint`, `addable`); see §2 below for the frozen signature detail.
- `backend/src/capabilities.ts` — `BackendCapabilities.runPinning: { keys: RunPinningKeySupport[]
  }`, each entry a `{ key, inventory, posture: "enforced" | "attested" }` record. `enforced`
  backends (direct-execution, e.g. local) guarantee the pinned configuration runs; `attested`
  backends (open-competition, e.g. marketplace) convey the pin as a claim-eligibility constraint
  and verify it after the fact against the recorded Execution.

A Submission pinning key a backend does not declare in `runPinning` is a typed
`unsupported-requirement` rejection at `submit` — a backend-capability-check product, not
something the pure `mergeRequirements` function ever produces (see §2).

### 1.2 `Task.profile` as a ResourceDescriptor (profiles §6.2)

TEP v1's design text described `Task.profile` loosely; the shipped schema fixes it as a
`ResourceDescriptor` (URI + digest), not a bare URI string, so a Task's profile binding is
digest-pinned the same way every other structural reference in the protocol is.

Implemented in `protocol/src/schemas/task.ts` —
`TaskSpecificationSchema.profile: ResourceDescriptorSchema`. The §6.2 resolution rule (a backend
must resolve the profile document and enforce its constraints before accepting a Submission) is
a `submit`-time obligation carried by the `TaskExecutionBackend` contract (`backend/src/backend.ts`),
not re-implemented as protocol-layer logic — the profiles package (sibling plan) owns the
resolvable document itself.

### 1.3 Correlation-annotations widening (profiles §5.3/§13)

The TEP v1 design's §6.4 "correlation annotations" concept is editorially widened to explicitly
admit application-context namespaced extensions (e.g. `runId`, `cellKey`), not just
protocol-internal correlation.

Implemented as `SubmissionRecordSchema.annotations: z.record(z.string(), z.unknown()).optional()`
plus the schema's overall `.loose()` posture (`protocol/src/schemas/submission.ts`), and carried
through to the `AttemptDescriptor.annotations` field an `observe()` call surfaces
(`protocol/src/fold.ts`).

## 2. Program §7 rulings implemented here

These are coordinator rulings from `2026-07-28-stack-implementation-program.md` §7 that this
plan's packages are the concrete implementation of.

- **§7.2 — `deriveAttemptUri` namespace + delimiter.** The UUIDv5 namespace constant
  `TEP_ATTEMPT_NAMESPACE` and the name-construction rule are owned and **exported** by
  `@jinn-network/task-execution-protocol` (`protocol/src/identifiers.ts`); the future marketplace
  binding consumes the exported constant and never re-derives its own. The frozen
  name-construction rule joins `bindingName` and each stringified correlation-tuple part with the
  ASCII unit separator `U+001F` — a control character absent from both reverse-DNS binding names
  and the marketplace correlation tuple, so variable-length parts can never concatenate
  ambiguously across a split boundary. Only the namespace UUID literal itself was a field-level
  refinement (§22); it was computed once, frozen, and pinned by `identifiers.test.ts`:
  `TEP_ATTEMPT_NAMESPACE = "158601b2-0cad-5f8b-89f2-c4a36f79fc78"` (a v5 UUID over the RFC 4122
  URL namespace and the name `"jinn.network/task-execution/attempt"`). The unit-separator
  delimiter is the frozen rule, not refinable.
- **§7.3 — `mergeRequirements` pinned signature.** One symbol, home
  `@jinn-network/task-execution-protocol`: `mergeRequirements(taskRequirements,
  submissionRequirements, keyClasses) → { ok: true; effective: EffectiveRequirements } | { ok:
  false; category: "invalid-document"; key }`. It returns the tightened merged map on success —
  `EffectiveRequirements` is itself a protocol export that backend-local's TaskView will consume.
  `keyClasses` is the fixed core-key classes plus the resolved profile document's
  `requirementKeys` classes, assembled by the caller — this package never resolves a profile
  document itself. `unsupported-requirement` is never produced by this pure merge; it is
  produced only by a backend's capability check against its declared `runPinning` inventory
  (§1.1 above). Implemented in `protocol/src/requirements.ts`; pinned by
  `requirements.test.ts` (one fixture per comparison class, plus the "not flagged here" case for
  an out-of-inventory key).
- **§7.14 — Canonical-serializer construction + I-JSON numbers.** `protocol/src/canonical.ts`
  builds its JCS output via explicit sorted-key iteration over an array of keys sorted by
  `compareCodeUnitStrings` — never by handing a rebuilt object to `JSON.stringify`, since
  JavaScript iterates integer-like string object keys in numeric order regardless of insertion
  order and would diverge from JCS's code-unit order. The integer-like-key case
  (`{"10":1,"2":2}` → `{"10":1,"2":2}`, not `{"2":2,"10":1}`) is pinned in `canonical.test.ts`
  against both the hand-computed expectation and the RFC 8785 reference `canonicalize` package.
  Every sealer (`sealTask`/`sealSubmission`/`sealDelivery`, `protocol/src/sealing.ts`) rejects any
  number not exactly representable as a safe I-JSON integer via `assertIJsonInteger`
  (`protocol/src/json.ts`); fractional quantities must be encoded as strings.
- **§7.16 — `foldObservations` clock/deadline seam + materialized `AttemptDescriptor`.** The
  frozen §22 name `foldObservations` gains an optional second parameter
  `{ now?, effectiveDeadline? }` (`protocol/src/fold.ts`, `FoldObservationsOptions`). Without it,
  the fold is a pure log fold — no provisional `expired` is ever derived from a clockless
  projection. With both `now` and `effectiveDeadline` supplied, and no authoritative
  `attempt-terminal` present in the log, the fold derives a provisional `expired` state per §10.4
  rule 5; a later authoritative terminal always supersedes the provisional `expired` without
  `contradictory`, whether or not `opts` was supplied on that later call. `AttemptDescriptor` —
  the §9/§22 Attempt projection — is defined in `protocol/src/fold.ts` alongside the fold so the
  frozen name is a real protocol export; it is *materialized* at the backend's `observe()` call
  (`backend/src/backend.ts` documents the contract; `testing/src/fake-backend.ts` is the first
  concrete materialization), which fills the descriptor's reference fields (the one Task digest,
  the one Submission URI, correlation annotations) from the Submission and dispatch context the
  backend already holds — never from a re-scan by the caller.
- **§13 error-category `retryable` defaults.** `TASK_EXECUTION_ERROR_CATEGORIES` is the frozen
  16-category tuple (`protocol/src/errors.ts`); each category's `retryable` default is a
  field-level refinement (§22), pinned by `errors.test.ts` and consumed by `backend`'s
  `TaskExecutionError` (`backend/src/errors.ts`) as the default unless a caller overrides it
  explicitly. The defaults shipped: `dependency-unavailable`, `backend-unavailable`,
  `operation-aborted`, `deadline-exceeded`, and `transport-failure` default `retryable: true`;
  every other category (`invalid-document`, `unsupported-profile`, `unsupported-requirement`,
  `unsupported-capability`, `invalid-reference`, `content-corruption`, `access-denied`,
  `submission-conflict`, `attempt-not-found`, `result-unavailable`, `protocol-violation`)
  defaults `retryable: false`. No `capacity`/`resource-exhausted` category exists (coordinator
  mandate 5) — capacity is expressed only via the `submission-closed.v1` observation
  `reason: capacity` plus a `backend-unavailable` detail.

## 3. Deferred / non-blocking follow-ups (not implemented here)

Recorded per the coordinator brief and the program's follow-ups registry
(`2026-07-28-stack-implementation-program.md` §8); none block this milestone or v1.

- **IANA media-type registration** for the `vnd.jinn.task-execution.*` vendor tree (TEP §28).
  The vendor-tree media types (`application/vnd.jinn.task-execution.{task,submission,delivery,
  dispatch-context}.v1+json`) are used as-is until registered.
- **Reserved profile URI publication.** `https://jinn.network/profiles/task-execution/1.0` must
  resolve to the published human-readable profile before any *external* conformance claim.
  Internal work in this plan does not gate on publication; this is a pre-release checklist item.
- **Scheme-IRI / propertyID registration** for did:pkh / did:key / CAIP-19 / GitHub spellings and
  the TEP scheme IRIs — one follow-up shared across TEP §28, profiles §17, and trust §20.
- **`capacity-exhausted` as a distinct error category.** v1 deliberately does *not* add this
  category (coordinator mandate 5; §13 stays a frozen 16-tuple). Whether TEP gains a dedicated
  category later is a recorded backend §20 follow-up.
- **The Jinn marketplace binding** (§16.2/§23) — lives in the marketplace application tree, drags
  chain/Mech/IPFS/Safe machinery, and is explicitly out of scope for this plan. It is the
  intended consumer of the exported `TEP_ATTEMPT_NAMESPACE` constant and the unit-separator
  delimiter (§2 above) and must reproduce both byte-for-byte rather than re-deriving them.
- **The Autopilot backend adapter** (§17/§25/§26 step 6) — an application-tree migration; out of
  scope here.
- **Carrier profiles** (HTTP service shape, queue, on-chain transports, §21.2/§28) — future
  packages; no v1 work in this plan gates on them.
- **Evaluation + verification integration** (§26 step 7) — evaluation-profile Tasks, the
  `evaluationSpecification`-digest crosswalk check, the `dispatch-binding` verification check,
  and verification-backed Attempt↔evidence binding are later work owned by the backend-local and
  profiles plans plus a minor Evidence-profile addition.
- **`@jinn-network/task-execution-backend-local`** and **`@jinn-network/task-execution-profiles`**
  — sibling/later plans that consume the packages shipped here and register themselves into the
  guard files this plan created (program §7.6: guard-suite ownership).

## 4. Design-review rulings (2026-07-28, second pass)

A design review of the shipped `@jinn-network/task-execution-{protocol,testing}` packages
(`stack/s1-tep` design-review, 7 findings) produced coordinator rulings on four open points. All
four are implemented in this milestone's follow-up commits; recorded here per the review's
instruction to append them to this addendum.

### 4.1 Idempotency scope delimiter (reused, not newly introduced)

`testing/src/fake-backend.ts`'s `scopeKey(requester, idempotencyKey)` already delimited the two
caller-controlled fields with U+001F (the ASCII unit separator) in the original commit — the same
frozen delimiter `deriveAttemptUri` uses (§2 above, `protocol/src/identifiers.ts`) and for the
same reason: `requester`/`idempotencyKey` are arbitrary-length strings, so undelimited
concatenation lets two distinct `(requester, idempotencyKey)` pairs collide at a shared boundary
(e.g. requester `"ab"` + key `"c"` === requester `"a"` + key `"bc"`), producing a false
`submission-conflict` or a false idempotent hit across requesters — the cross-requester capture
§12.2 forbids. The delimiter byte was present but literally invisible in source (an unescaped
control character), which is almost certainly why the review's automated read of the file
concluded it was absent. The follow-up commit does not change scoping behavior; it names the
existing byte as `const SCOPE_DELIMITER = "\u001f"` so the delimiter is legible to both reviewers
and editors, and adds the Layer-2 contract coverage that was genuinely missing: same
`idempotencyKey` under two different requesters yields two distinct accepted Submissions (no
conflict, no capture), plus a concatenation-collision regression case
(`testing/src/backend-contract.ts`).

### 4.2 `attempts` bounds semantics (honor-or-reject, §8/§15)

The reference backend now declares `attempts: { maxTotal: [1, 1], maxConcurrent: [1, 1] }`
(`DEFAULT_ATTEMPT_BOUNDS`, `testing/src/fake-backend.ts`) — mirroring backend-local v1's
single-Attempt-per-Submission posture — and `submit` honors a supplied `attempts.maxTotal` /
`attempts.maxConcurrent` only when the requested value falls within the declared `[min, max]`
range, rejecting an out-of-range or undeclared-key request with `unsupported-requirement` naming
the field (`attempts.maxTotal` / `attempts.maxConcurrent`). `evaluationRequirements` and
`capabilityGrants` are rejected unconditionally when supplied, since this fake declares no
evaluation profile and does not resolve capability grants — the same honor-or-reject discipline
§8 already applies to Task-level `requirements` extends to these three Submission-level dispatch
parameters. Layer-2 contract cases cover all three rejection paths plus the in-range acceptance
already exercised by the concurrent-Attempts fixture.

### 4.3 Task-digest binding: `invalid-reference`, not silently ignored (§8)

`submit` now rejects when `documentDigest(taskBytes)` does not equal the Submission's `task`
descriptor digest, with `category: "invalid-reference"` (`retryable: false`, the §13 default for
that category) — closing the gap where a Submission naming Task A's digest could be paired with
Task B's bytes and silently executed as Task B. The Submission schema
(`protocol/src/schemas/submission.ts`) now requires the `task` `ResourceDescriptor` to carry a
sha256 digest entry (`TaskReferenceSchema`, a `.refine()` over the general
`ResourceDescriptorSchema`): §8's text already mandated "the sealed Task digest plus locator
hints", so a `task` reference satisfiable by `uri` alone was the bug, not a deliberate looseness.
Layer-2 contract test: `testing/src/backend-contract.ts`, digest-mismatch case.

### 4.4 `foldObservations` self-filters to the authoritative source (§10.1/§10.4)

`foldObservations` (`protocol/src/fold.ts`) now pins the authoritative observation-producer
source from the first `attempt-engaged` observation in sequence order (its `data.source` field,
§10.1) and excludes every subsequent observation whose envelope `source` does not match — so a
non-authoritative or forged observation (e.g. a corroborating observer's own `attempt-terminal`,
or an attacker-supplied one) can never alter derived state or raise a false `contradictory`. If
multiple `attempt-engaged` observations from different sources appear, the first by sequence wins
as the engagement; every other `attempt-engaged`, including a later one from a different source,
is itself non-authoritative and filtered the same way. This is documented on the function
(`fold.ts`) as the SELF-FILTER precondition, and pinned by three new adversarial fixtures in
`fold.test.ts`: a forged non-authoritative `attempt-terminal`, a forged non-authoritative
`attempt-started`, and a forged non-authoritative `attempt-engaged` racing the genuine one.

This ruling had a downstream consequence worth recording: the Layer-2 backend-contract fixtures
and `fake-backend.test.ts`'s happy path previously drove test observations from an arbitrary,
non-authoritative `source` (a per-attempt placeholder, or a fixed `"urn:jinn:conformance-kit:…"`
string) — behavior the pre-fix fold accepted regardless of source. Both were updated to derive
and reuse the attempt's actual authoritative source (read off the `attempt-engaged` observation
`submitAccepted`/`submit` returns) rather than weakening any assertion.

## 5. Pointer

Full design text: `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md`.
Carried-amendment source: `docs/superpowers/specs/2026-07-27-task-profiles-and-evaluation-specs-design.md`
§5, §6.2, §13. Cross-plan rulings: `docs/superpowers/plans/2026-07-28-stack-implementation-program.md`
§7. Implementation plan: `docs/superpowers/plans/2026-07-28-task-execution-protocol.md`.
