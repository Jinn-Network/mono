# `@jinn-network/policy-identity`

> **Kit and implementation, in one package.** It ships the frozen type vocabulary, the format
> tokens, the complete conformance fixture set, the production implementation under `src/`, and a
> naive reference implementation under `fixtures/reference/`. The same suite gates both: `yarn
> test` runs it against the shipped code, `yarn test:conformance:reference` runs the identical
> assertions against the reference. See *The conformance kit* below.

> Phase A/C maturity: experimental, `experimental-policy` release group, publication disabled.

Authority:
[`docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md`](../../../docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md)
§4–§5, §8 (the substrate design), and §1 C1 of
[`docs/superpowers/plans/2026-08-03-policy-optimization-implementation-program.md`](../../../docs/superpowers/plans/2026-08-03-policy-optimization-implementation-program.md).

## What this is

Canonicalize, digest, seal, and validate two documents:

- **The execution-policy tuple** — one canonical, *derived* identity for "the configuration that
  ran". It is a total function of exactly one input triple, the sealed Task, the sealed
  Submission, and the resolved task profile the Task pins by digest: profile pin-check →
  effective-requirements merge → closed key rule → byte-exact copy → canonicalize. Two honest
  derivers holding those documents must produce identical bytes.
- **The candidate manifest** — a sealed, attributable identity for "the configuration someone
  proposes": typed parent lineage, proposer, frozen evidence provenance, declared changes. It
  carries **no score and no self-assessment**; whether the candidate is better is established
  exclusively by subsequent evaluation records.

The package is **pure**: no clock, no network, no filesystem, no randomness. Filesystem access
exists in `src/fixtures.ts` and the tests only.

Nothing here is a record kind. Both documents carry *format tokens*
(`network.jinn.policy.execution-tuple/1.0`, `network.jinn.policy.candidate/1.0`), never media
types claiming tier-2 status. §5.4 of the design records the single graduation trigger:
cross-operator exchange.

## Bounded claims

An identity is only as good as its verification, and this package verifies nothing about
execution — it only says what was *requested*.

- A tuple digest names a **requested** treatment. Evidence Runtime Observations never mint one;
  observation feeds the per-axis fidelity status (§7) that says how much the requested tuple can
  be believed.
- **The weakest-axis rule.** Any claim keyed on a tuple digest is at most as strong as the
  weakest identity strength among the axes it depends on. Today `isolationPolicy` is `vacuous`
  everywhere (every launcher offers `unrestricted` only), and every marketplace axis is
  `attested`. Consumers apply the rule; this package only makes the disclosure possible.
- A **constraint-shaped** axis value identifies a configuration *family*, not a point. Nothing
  here resolves a constraint to a concrete value.
- Two Submissions differing only on an **excluded** requirement key share one tuple digest. A
  task family that needs an extra axis to be treatment-distinguishing must declare it in its
  profile's `requirementKeys`.
- Validation does not fetch parents, verify signatures, or materialize policies.

## The conformance kit

`src/conformance.ts` is the single swap point. Every test imports what it exercises from there
and nowhere else, so the same 165 assertions run against either implementation without a line of
test code changing:

| Command | Gates |
| --- | --- |
| `yarn test` | `src/` — the shipped implementation (`CONFORMANCE_TARGET = "implementation"`) |
| `yarn test:conformance:reference` | `fixtures/reference/` — the naive reference deriver |

Both are green, and both run in CI. The reference stays in the tree permanently: substrate §8
requires the derivation-equivalence fixture to be satisfied by **two structurally different
implementations**, and a kit provable only by the code it gates proves nothing.
`src/merge-parity.test.ts` additionally imports the reference's class maps directly.

Three mutation checks confirm the kit bites rather than merely passes:

| Mutation | Result |
| --- | --- |
| Sort object members by Unicode **code point** instead of UTF-16 code unit | 3 failures, all in `tuple/golden/utf16-code-unit-ordering` |
| Null-fill declared-but-unset profile `requirementKeys` instead of omitting them | 8 failures across the derivation family |
| Code-point sort in the **implementation** while the reference is untouched | 3 failures under `yarn test`, 0 under `yarn test:conformance:reference` — which is what proves the swap point is real |

## Layout

| Path | Contents |
| --- | --- |
| `src/canonical.ts` | I-JSON + JCS canonicalization, one recursive writer with path-tracked refusals |
| `src/digest.ts` | sha256 and the bare-versus-prefixed digest spellings (F9) |
| `src/merge.ts` | `CORE_KEY_CLASSES` (F2's pin) and the tighten-only requirements merge |
| `src/tuple.ts` | tuple validation, canonical bytes, digest, the expression rule |
| `src/derive.ts` | `deriveExecutionTuple` — the §4.1 total function in five stages |
| `src/manifest.ts` | candidate-manifest validation, sealing, exact-bytes parsing |
| `src/dsse.ts` | the DSSE in-toto Statement binding |
| `src/hash-profile.ts` | `learner-public.v1` and the fail-closed materialization rule |

The merge is **reproduced**, not imported: this package depends on no Jinn package, and
`.github/scripts/policy-identity-guards.test.mjs` pins its class map, membership registry, and
effort ordinals against `packages/task-execution/protocol/src/requirements.ts` so the two cannot
drift apart silently.

**Do not edit a fixture to make an implementation pass.** A fixture that is wrong is a finding
routed to the coordinator; a fixture that is inconvenient is a fixture doing its job.

## Findings

Every ambiguity, conflict, or silent gap the kit hit in the design, with a proposed disposition.
None was resolved by interpretation in code without being recorded here.

### F1 — `deriveExecutionTuple` is under-parameterized (interface change; the material one)

The program's frozen signature is `deriveExecutionTuple(task, submission)`. Substrate §4.1 step 1
needs the comparison classes of profile-added requirement keys, and step 2 needs
`requirementKeys` itself — both of which live in the **resolved task-profile document**, a
separate sealed document that `Task.profile` only pins by `{uri, digest}`. A two-argument
function cannot execute either step.

**Proposed disposition:** amend the C1 frozen interface to
`deriveExecutionTuple(task, submission, profile: ResolvedTaskProfile)`. The "total function of
the (Task, Submission) pair" claim survives intact, because the Task determines the profile
uniquely by digest — but the resolution is the caller's, and the derivation must **check** the
supplied profile against the Task's pin rather than trust it (see
`derivation/adversarial/profile-digest-mismatch.json`: handing two honest derivers different
revisions of the same profile URI is the quietest way to fork the identity space, and profiles
§6.2 already forbids exactly this in the validation path).

The kit implements the three-argument form. All derivation fixtures carry the profile document,
so a two-argument implementation that resolves internally can be adapted with a thin binding in
`conformance.ts` without touching a fixture.

**Disposition taken:** substrate §4.1 was amended in place ("input triple", with the pin-check
stated normatively) and the program's C1 charter follows it. `src/derive.ts` runs the pin-check as
stage 0, before anything reads `requirementKeys`.

### F2 — the core-axis comparison-class map is unpinned, and the shipped venues disagree

§4.1 step 1 says "`mergeRequirements` semantics" without naming the core-key class map. Two
shipped venues use different maps:

| Key | `marketplace/binding` | `backend-local/assembly` |
| --- | --- | --- |
| `harness` | `constraint` | `exact` |
| `model` | `constraint` | `constraint` |
| `loadout` | `addable` | `exact` |
| `isolationPolicy` | `constraint` | `exact` |

Read naively this forks the derivation. `src/merge-parity.test.ts` establishes the actual scope:
the disagreement is **behaviorally inert today**, because protocol's constraint-membership
registry registers a test for `model` only, so `constraint` on the other three keys falls
through to byte-equality — the same behavior `exact` has, and the same behavior `addable` has
when the key is present in both documents. The one key where the class *does* have a
consequence, `model`, is `constraint` in both maps.

**Proposed disposition:** `policy-identity` exports and pins one `CORE_KEY_CLASSES` map (the kit
pins the marketplace spelling, which cites profiles §5/§5.1 with its rationale), and both venues
migrate to it. The kit ships a tripwire test that fails the day a membership test is registered
for another core key — the day the two maps genuinely would fork.

**Disposition taken (C1):** `src/merge.ts` exports `CORE_KEY_CLASSES` with the marketplace
spelling. The tripwire now exists on both sides — `src/merge-parity.test.ts` inside the package,
and `.github/scripts/policy-identity-guards.test.mjs` at the tree level, which reads protocol's
`CONSTRAINT_MEMBERSHIP` and fails if any key other than `model` is ever registered. Migrating the
two venues onto the exported constant is a separate, cross-tree change and is **not** done here:
it edits `platform-v1` packages, which is outside C1's file scope.

### F3 — `isolationPolicy` versus the core `isolation` key family

profiles §5 describes `isolationPolicy` as "a policy id *within* the core `isolation` class key
— one key family, not two", but the local backend's class map declares `isolation` and
`isolationPolicy` as **two separate keys**, and every shipped launcher inventory, the preclaim
check, and the marketplace's attested key list use `isolationPolicy`. Substrate §4.1 pins the
tuple axis to `isolationPolicy` and separately notes the benchmarking Matrix calls it
`isolation`.

**Proposed disposition:** confirm `isolationPolicy` as the requirements-map key (it is, on every
shipped surface) and state explicitly that a bare `isolation` requirement key is an **excluded
foreign key** for tuple purposes unless a profile declares it. Recorded rather than silently
assumed, because a task family that pins `isolation` and expects it to be treatment-distinguishing
would get no error and no axis.

### F4 — the expression rule says "key" where it means "axis"

§4.1: "emit one requirement entry per non-null key". Read literally this emits `formatToken` as a
run-pinning requirement, which no backend declares in a `runPinning` inventory and which would be
rejected as an unsupported requirement at submit.

**Proposed disposition:** amend to "per non-null **axis**"; `formatToken` is document metadata.
The kit excludes it and pins the behavior in `tuple.test.ts`.

### F5 — a profile may declare `formatToken` as a requirement key

Nothing in profiles §6.1 reserves member names, so a profile author may legally declare
`formatToken` in `requirementKeys` — at which point §4.1 step 2 instructs the deriver to copy the
effective value over the tuple's own metadata member. The design states no rule.

**Proposed disposition:** reserve `formatToken`; a profile declaring it is invalid input and the
derivation fails closed. Silently dropping the requirement instead would violate the closed key
rule, and honoring it would produce a "tuple" whose format token is not the format token. Pinned
by `derivation/adversarial/profile-declares-format-token.json`.

### F6 — manifest field optionality is unstated

§5.1's table marks optionality only inside `compatibility`. Whether `parents`, `declaredChanges`,
or `compatibility` itself are required is left to the reader.

**Proposed disposition:** state in §5.1 that `formatToken`, `policy`, `parents`, `proposer`,
`evidenceProvenance`, and `declaredChanges` are required (`parents` may be empty for seeds) and
`compatibility` is optional. That is what the kit pins.

### F7 — the unrecognized-field rule is stated for top level only

§5.3 rejects "any unrecognized non-namespaced **top-level** field". No rule is given for unknown
members inside `parents[]` entries, `evidenceProvenance`, or `declaredChanges`.

**Proposed disposition:** state that the rule is top-level-only and that unknown nested members
are tolerated and preserved (the unknown-field-tolerant posture, applied consistently). The kit
implements that reading. Note the cost, so it is priced: a self-score hidden in
`declaredChanges.score` is not caught by validation, and falls under the same consumer-MUST-IGNORE
rule §5.3 already states for extension-borne self-assessment.

### F8 — duplicate `parents[]` entries have no stated rule

**Proposed disposition:** refuse. A repeated `(kind, digest)` pair is not a second parent; it is
free in-degree in the lineage graph C7d derives, and "most-derived-from" is exactly the statistic
a proposer would inflate at zero cost. Silent de-duplication is worse than either: it makes the
sealed bytes and the parsed meaning disagree, which a sealed document may never do.

### F9 — `learner-public.v1` returns bare hex; the loadout `digest` field is prefixed

C3's `hashImplStateDir` returns 64 bare hex digits. The `loadout.digest` field in §4.1's tuple
shape uses the stack's `sha256:<hex>` spelling. The conversion point is real and unnamed.

**Proposed disposition:** state in §4.2 that the profile's output is bare hex and that the
loadout pinning value carries the `sha256:` prefix, with the conversion owned by the
materialization/pinning bridge (C5). The kit pins both spellings so the two units cannot drift
into disagreeing about which one the constant is.

### F10 — the `undefined`-member canonicalization rule is unstated

"I-JSON, JCS" does not say what happens to an object member whose value is `undefined`.

**Proposed disposition:** no design change; record the precedent. The kit follows
`packages/benchmarking/records` — object members are **omitted** (mirroring `JSON.stringify`, so
an omitted optional field and an explicit-`undefined` one seal identically), array elements are
**rejected** (no key to omit by, and JCS has no undefined token). Because omission is the rule,
tuple validation must reject an explicitly-`undefined` core axis separately, or it would seal as
an omitted one — pinned by the `undefined-core-axis` case in `tuple.test.ts`.

### Scope note on §8's fork-healing fixture

§8 asks for "one fixture tree hashed under `learner-public.v1` yielding equal digests **across
the three post-#2118 surfaces**". A pure package cannot exercise the fence, delivery, and status
surfaces; C3's regression suite owns that. What this kit contributes is the second independent
implementation of the profile and the shared constant, which is the part that makes C3's
three-surface equality checkable from outside C3.
