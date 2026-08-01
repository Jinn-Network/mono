# CE2 — the `state-predicate` evaluation family (profiles, additive)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans

- **Date:** 2026-07-31
- **Component:** CE2 of the chain environment family program
  ([`2026-07-31-chain-environment-program.md`](./2026-07-31-chain-environment-program.md)).
- **Design (law):** [`../specs/2026-07-31-chain-environment-family-design.md`](../specs/2026-07-31-chain-environment-family-design.md)
  §6 in full (§6.1 family block, §6.2 the closed vocabulary + evaluation-state rules + E16 +
  the "what admission proves and cannot" paragraph, §6.3 admission, §6.4 the solution script
  model), §5.1 step 7 (the canonical observation), §12 CF1 (the enum amendment this plan
  executes). Secondary law:
  [`../specs/2026-07-27-task-profiles-and-evaluation-specs-design.md`](../specs/2026-07-27-task-profiles-and-evaluation-specs-design.md)
  §7 — `deterministic-process` is the structural model this family copies.
- **Branch:** `chain/ce2-state-predicate`, based **directly on `origin/integration/evidence-v1`**
  (independent lane — CE2 touches `packages/task-execution/profiles` only and depends on no
  other component). CE5 merges this branch.
- **Target package:** `packages/task-execution/profiles` — amended additively. No new package,
  no new entrypoint, no new dependency.

## Goal

Ship the `state-predicate` evaluation family inside `@jinn-network/task-execution-profiles`:
the family enum amendment (CF1), the cross-validated family block, the **closed predicate
vocabulary** as typed Zod schemas, the **canonical chain observation** schema the evaluator
consumes, and `evaluatePredicates(observation, block)` — a **provably pure** function with no
I/O, no clock, no chain types, and no network, because admission (CE5) and evaluation (CE3's
replayer path) both compose it and neither may inherit the other's capabilities.

Success is: a chain scenario author can seal an EvaluationSpec whose family is
`state-predicate`; a canonical observation produced by any replayer resolves that spec's
predicates deterministically; a state predicate used as a safety constraint, an unknown
predicate kind, a bare extension key, and a post-replay ground truth read where a pre-replay
one was declared are all **rejected or reported unevaluable, never silently satisfied**; and
the whole thing runs with the package's existing zero-I/O posture intact.

## Architecture

Three layers, all inside `packages/task-execution/profiles/src`:

```
src/evaluation-spec/schema.ts          ← amend: GRADER_FAMILIES gains "state-predicate" (CF1)
src/evaluation-spec/family-blocks.ts   ← amend: StatePredicateBlockSchema + registry entry
src/evaluation-spec/state-predicate/
  decimal.ts       exact decimal/BigInt comparison + tolerance arithmetic  (internal)
  vocabulary.ts    the 14 predicate kinds, comparators, measurement sources, placement rules
  observation.ts   CanonicalChainObservationSchema (what a replayer/probe executor emits)
  reads.ts         stateReadKey / sourceReadKey / stateReadRequests(block)  — the projection contract
  evaluate.ts      evaluatePredicates(observation, block) — PURE
  spec-checks.ts   canonical verdict rule + checkStatePredicateSpec + checkStatePredicateBlock
fixtures/state-predicate-block/{golden,adversarial}/*.json
fixtures/state-predicate-evaluation/{golden,adversarial}/*.json
fixtures/evaluation-spec/golden/state-predicate-minimal.json + .sha256
src/testing.ts                         ← amend: two fixture families + two kit re-exports
```

**Why a pure evaluator needs a projection contract.** A predicate like
`erc20Balance{token, account, cmp, value}` is a *state read*. A pure function cannot perform
it. So the canonical observation carries a **state-read projection**: the resolved reads,
each tagged `baseline` or `post-replay`, each keyed by a canonical key that `reads.ts`
derives — by the *same* pure code the observation builder (CE3) calls to learn which reads to
perform. `stateReadRequests(block)` is that contract: block in, read requests out. The
evaluator then resolves by key and **never falls back to a differently-tagged read** — which
is precisely what makes the §6.2 pre-replay ground-truth rule enforceable instead of
aspirational.

**The same seam carries the declarative call form (coordinator ruling CR6).** A `callResult`
may name `{abiRef, function, args}` instead of calldata; the read request carries that
declaration through **unencoded**, and the observation producer encodes — CE3, which owns the
runtime port and is making the RPC call regardless. CE2 keys and compares; it never holds an
encoder. That is what lets `chain-scenarios` express a read at all — no ABI coder is available
in the `task-supply` tree, and a parameterized template has nothing to pre-encode because the
argument is not known until parameterization — without CE2 acquiring the chain dependency its
purity guard exists to exclude.

**Why the verdict runs through the existing machinery.** §6.2's verdict rule (all
`successPredicates` true AND no `safetyConstraint` violated; measurements never gate) is
implemented as three **reserved measurements** plus one **canonical `verdictRule`** that a
`state-predicate` spec MUST carry verbatim (`checkStatePredicateSpec` enforces it). The
existing `evaluateVerdictRule` then produces pass / fail / inconclusive with no parallel
verdict path — and an author cannot write a `verdictRule` that quietly ignores the safety
constraints.

## Tech Stack

- TypeScript 5.9 (ESM, `NodeNext`), Node 22, Yarn 4.13.0 — unchanged.
- `zod@4.4.3` for schemas; `@noble/hashes@2.2.0` (already a dependency) for `keccak_256` when
  an `eventEmitted` predicate declares a human-readable `signature` instead of a `topic0`.
- `vitest@4.1.8`. **No new dependency** — the profiles dependency inventory is asserted by
  `.github/scripts/task-execution-source-boundaries.test.mjs`; adding one would need a design
  amendment, not a guard edit.

## Global Constraints (program §4, rendered for CE2)

1. **Designs are law.** A defect is a Findings entry with a proposed disposition (below), never
   a silent patch.
2. **Kits and fixtures precede implementations.** Every task lands its fixtures with (or
   before) its code; `yarn test` is green at every commit.
3. **Sealing is not re-implemented here** — CE2 adds no new sealed kind; it uses the package's
   existing `sealEvaluationSpec`. (Contract 3 binds record-producing packages; CE2 produces no
   record.)
4. **Custody law.** No key material, no ambient authority. The evaluator takes *data*; it never
   holds a client, a signer, a socket, or a clock. Fail closed: an unresolvable predicate is
   `unevaluable`, never satisfied.
5. **No product names in tiers 1–3**; never import the frozen trio or `client/`. profiles
   imports `@jinn-network/task-execution-protocol` **only** (guarded).
6. **Digest discipline.** Record-body digests are `sha256:`-prefixed; in-toto DigestSet values
   are bare lowercase hex. The block's `environmentRecord` descriptor is a DigestSet
   (`digest.sha256` = bare hex); the observation's `environmentRecord` is a record-body
   reference (`sha256:`-prefixed). The confusion fixture is mandatory (Task 3).
7. **Bounded claims.** No API name, no returned field, no log line, and no doc sentence in this
   family says "verified", "verify", "correct", "proves", or "guarantees" about a predicate
   outcome. The vocabulary is **satisfied / violated / unevaluable**, always against the named
   information contract (`resolvedAgainst`). A mechanical guard enforces it (Task 7).
8. **Fixture keys are freshly generated per record, never reused**, and never a well-known dev
   mnemonic address someone might fund. CE2's fixtures use documentation addresses of the form
   `0x0000…` / clearly-synthetic non-mnemonic hex (Task 2 Step 1 pins the convention).
9. **Register in the existing tree guards in the same PR.** CE2 adds no package and no
   entrypoint, so the registration surface is: `FIXTURE_FAMILIES` in `src/testing.ts`, the
   README's kit section, and a green run of both `.github/scripts/task-execution-*.test.mjs`
   guards plus the packed-types consumer compile.
10. **TDD per task; verification before completion.** Typecheck, tests, and (final task) build,
    `check:documents`, `pack:smoke`, and the two guards run locally with output shown before a
    task is reported done.
11. **Stop on missing Consumes.** Every symbol this plan consumes is listed per task with its
    exact module path; if it is not on `origin/integration/evidence-v1`, stop and report.
12. **Docker-dependent tests: none here.** The whole component is pure; no test may require a
    daemon, a network, or a chain.

Package-local constraints inherited from the profiles plan and enforced by existing guards:

- **Sealed numbers are I-JSON safe integers** (`src/bytes.ts`). Every wei, gas, block-number,
  timestamp, and tolerance in this family is a **decimal string**, never a JSON number. The
  only JSON numbers this family admits are `timeout` (seconds) and array indices.
- **No locale-sensitive API** (`localeCompare`, `Intl`, `toLocale*`) anywhere in production
  source — guarded repo-wide for `packages/task-execution/*/src`.
- **Hex is lowercase, normalized by rejection, never by transformation.** Address and hex
  schemas reject uppercase rather than lower-casing it, so a read key is a pure concatenation
  and two authors cannot produce two keys for one read.

## Findings (2026-07-31)

Filed against the chain-environment design; each has a proposed disposition and is implemented
as proposed unless the design owner rules otherwise.

| # | Finding | Proposed disposition |
| --- | --- | --- |
| **CE2-F1** | §5.1 step 7 enumerates the canonical observation's members and adds, for replay, "the report(name,value) outputs and the source-consultation record" — but §6.2's `sourceValue` predicate reads a *value* out of the sealed corpus, and §6.2's state predicates (`nativeBalance`, `erc20Balance`, `callResult`, `storageValue`, `reportedValue.groundTruth`) read *state*. A pure evaluator can do neither. The observation must therefore also carry a **state-read projection** and a **source-read projection**. | Extend the canonical observation with `stateReads[]` (each tagged `baseline` \| `post-replay`) and `sourceReads[]` (each carrying the extracted scalar and a `resolved` \| `miss` \| `unavailable` resolution). CE2 owns the key derivation (`stateReadKey` / `sourceReadKey`) and publishes `stateReadRequests(block)` so CE3/CE5 build exactly the projection the block needs. Selector *evaluation* (JSONPath/CSS over corpus bytes) stays with the information-world runtime (CE6) — it needs the bytes and the media type; CE2 compares and reports. Recipient: design §5.1 step 7; consumers CE3, CE5, CE6. |
| **CE2-F2** — **SUPERSEDED by coordinator ruling CR6** (see below; kept because the reason it was deferred is worth reading next to the reason it was reversed) | §6.2 writes `callResult{to, encodedCall \| abiRef+args, …}`. `abiRef+args` requires an ABI encoder inside a module that must stay pure, small, and free of a canonical-encoding ambiguity (tuple/array/dynamic-type encodings differ across libraries). | ~~v1 accepts **`encodedCall` only** (hex calldata); `abiRef+args` parked as an extension owned by CE5 — scenario templates encode calldata at authoring time.~~ **Reversed:** the disposition assumed CE5 *could* encode. It cannot — `viem` is banned tree-wide in `task-supply` by the source-boundary guard, so a scenario package has no encoder at all; and a parameterized template (vary the amount, vary the token) has nothing to pre-encode at authoring time, because the argument is not known until parameterization. `encodedCall`-only would have left the entire scenario layer unable to express a read. |
| **CR6** (coordinator ruling, supersedes CE2-F2) | The declarative form is structurally required by CE5, and CE2 must stay pure. | **`abiRef+args` ships in v1**, and **CE2 performs no encoding**: the vocabulary admits `{abiRef, function, args}` alongside `{encodedCall}`; `stateReadRequests(block)` emits the *structured* request carrying the abi reference and typed arguments; the **observation producer encodes** — CE3's probe executor / replayer, which lives in the `environments` tree where an encoder may sit behind the runtime port, and which is already making the RPC call. Encoding belongs where the call happens. `stateReadKey` is deterministic over the **declarative** form, so two predicates naming the same call key identically whether or not anyone ever encodes them. |
| **CE2-F3** | §6.4 says "envelope violations during replay are refusals, not judgment calls", but the canonical observation as enumerated has no way to say "this replay was refused". Grading a refused or aborted replay as satisfied/violated would be a false statement about the solver's work. | The observation carries `replay: { status: "completed" \| "refused" \| "aborted", refusalClass? }`. A non-`completed` replay makes the entire outcome `unevaluable` with reason `replay-not-completed`; the canonical verdict rule maps that to `inconclusive`, never `fail`. Recipient: design §5.1/§6.4. |
| **CE2-F4** | §6.2 designates `sourceConsulted` "a *measurement*, not a gate" while listing it in the predicate vocabulary with a `countCmp`. As written it could be authored into `successPredicates` and would then gate. | Keep it in the closed vocabulary as a typed schema (its `countCmp` is optional), and make its **placement** a validation rule: legal only inside `measurements[]`. `sourceConsulted` in `successPredicates` or `safetyConstraints` is `invalid-document`. Adversarial fixture ships. |

**Grammar settlements** (§6.2: "Remaining field grammar is settled at implementation" — these
are settlements, not findings):

| Design shorthand | Shipped grammar | Why |
| --- | --- | --- |
| `sourceValue{world, request, jsonPath\|selector, …}` | `{world, requestKey, selector, …}` | The canonical request key is CE6's algorithm over a request; CE2 must not re-implement or approximate it. Authors bind the key at authoring time; CE2 matches strings. |
| `callResult{to, encodedCall \| abiRef+args, …}` (CR6) | `{to, call: {encodedCall} \| {abiRef, function, args}, decode, cmp, value, tolerance?}` | Both forms ship. The declarative form carries an `abiRef` ResourceDescriptor (digest authoritative — which ABI the author read the function out of), a canonical `function` signature (`"balanceOf(address)"`), and **typed** `args`, which is everything an encoder needs. CE2 keys and compares; CE3 encodes. |
| `args` grammar (CR6) | closed scalar set `{address, bool, uint256, int256, bytes32, bytes, string}` plus their single-dimension array forms; values are lowercase hex, decimal strings, or booleans — never JSON numbers | Keeps the key derivation a pure concatenation over already-canonical strings, and keeps the producer's encoder unambiguous. Nested tuples and multi-dimensional arrays are **not** in v1: if a CE5 template needs a tuple-argument read, that is a reported gap to widen deliberately, not something to approximate. |
| read-key identity (CR6) | `stateReadKey` is computed over the **declaration**, not over resolved calldata | CE2 cannot resolve calldata, so it cannot key over it. Consequence, stated rather than discovered: the same underlying call written once as `encodedCall` and once declaratively yields two keys and two projected reads. That is consistent and deterministic — it is not deduplication CE2 is able to perform. |
| `budget{gasTotalCmp \| txCountCmp \| valueOutCmp}` | `{metric: "gasTotal" \| "txCount" \| "valueOutWei", cmp, value}` | One metric per predicate keeps the outcome vector one-entry-per-predicate and the schema a clean discriminated union. |
| `timeBound{completedWithinBlocks \| completedWithinChainSeconds}` | `{metric: "completedWithinBlocks" \| "completedWithinChainSeconds", maximum}` | "within" *is* the comparator; a free comparator here would let an author write `gt` and invert the intent. |
| comparators "where applicable" | `{eq, ne, lt, lte, gt, gte, within-abs, within-rel}`, with `tolerance` required iff `within-*` and forbidden otherwise | Cross-field refinement makes a tolerance-without-`within` a document error instead of a silently ignored field. |
| predicate objects | **strict** (`z.strictObject`); namespaced extensions allowed at **block** level only | An unknown key inside a *gate* is an unenforced condition the author believes is enforced. Same reasoning the package already applies to `ParserIdentitySchema`. |
| `semanticsVersion` | family block carries `predicateSemanticsVersion: "1"`; the top-level `EVAL_SEMANTICS_VERSION` stays `"4"` | Bumping the global seed would churn the two sealed profile documents and the benchmarking fixtures for a change that alters no existing spec's semantics. A future vocabulary revision is visible in sealed bytes and an old evaluator fails closed on it. |

## Interfaces (component-level)

**Consumes** — all from `origin/integration/evidence-v1`, package
`packages/task-execution/profiles`:

| Symbol | Module |
| --- | --- |
| `GRADER_FAMILIES`, `GraderFamily`, `EvaluationSpecSchema`, `EvaluationSpec`, `MeasurementDeclarationSchema` | `src/evaluation-spec/schema.ts` |
| `FAMILY_BLOCK_SCHEMAS`, `withNamespacedExtras` (module-private — the block schema therefore lives *in* this file), `ParserIdentitySchema` (style precedent) | `src/evaluation-spec/family-blocks.ts` |
| `COMPARISON_OPS`, `ComparisonOp`, `DECIMAL_STRING_PATTERN`, `MeasurementMap`, `VerdictRule`, `VerdictRuleSchema`, `evaluateVerdictRule`, `VerdictOutcome` | `src/evaluation-spec/verdict-rule.ts` |
| `UnscorableClass`, `UNSCORABLE_DISPOSITIONS` | `src/evaluation-spec/unscorable.ts` |
| `ResourceDescriptorSchema`, `RESOURCE_DESCRIPTOR_SHAPE`, `resourceDescriptorHasLocator` | `src/resource-descriptor.ts` |
| `ProfilesError`, `ProfilesErrorCode` | `src/errors.ts` |
| `parseEvaluationSpec`, `sealEvaluationSpec` | `src/evaluation-spec/seal.ts` |
| `loadFixtureFamily`, `runStructuralCheck`, `FIXTURE_FAMILIES` | `src/testing.ts` |
| `EVALUATION_SPEC_FORMAT_URI`, `EVAL_SEMANTICS_VERSION` | `src/identifiers.ts` |

**Produces** — the program §3 pinned names, plus additive (non-pinned) exports CE3/CE5/CE6
need. Changing a pinned name is a program-plan amendment.

| Pinned (§3) | Shape |
| --- | --- |
| `STATE_PREDICATE_FAMILY` | `"state-predicate"` (`as const`) |
| `StatePredicateBlockSchema` | Zod schema; `StatePredicateBlock` inferred type |
| `evaluatePredicates(observation, block): PredicateOutcome` | **pure**; no I/O, no chain types |
| `CanonicalChainObservationSchema` | Zod schema; `CanonicalChainObservation` inferred type |
| family kit | `fixtures/state-predicate-block/*`, `fixtures/state-predicate-evaluation/*`, both in `FIXTURE_FAMILIES`; `evaluatePredicates`, `checkStatePredicateBlock`, `checkStatePredicateSpec` re-exported from `./testing` |

| Additive (not pinned; announce to CE3/CE5/CE6) | Shape |
| --- | --- |
| `stateReadRequests(block): StateReadRequest[]` | the projection contract the observation builder fulfils — a `call` read carries whichever CR6 form the author declared, **unencoded** |
| `stateReadKey(read): string`, `sourceReadKey(read): string` | canonical key derivation over the declaration, shared by producer and consumer |
| `CallTargetSchema`, `CallTarget`, `AbiArg` (CR6) | `{encodedCall}` \| `{abiRef, function, args}`; CE3 encodes the second form |
| `PREDICATE_KINDS`, `PredicateSchema`, `Predicate`, `PREDICATE_COMPARATORS` | the closed vocabulary |
| `SAFETY_CONSTRAINT_KINDS`, `SUCCESS_PREDICATE_KINDS`, `MEASUREMENT_ONLY_KINDS` | placement rules, as data |
| `STATE_PREDICATE_VERDICT_RULE`, `STATE_PREDICATE_RESERVED_MEASUREMENTS`, `STATE_PREDICATE_UNEVALUABLE_CLASS` | the canonical verdict wiring |
| `checkStatePredicateSpec(spec)`, `checkStatePredicateBlock(input)` | structural checks (kit surface) |
| `PredicateOutcome`, `PredicateEvaluation`, `PredicateState`, `PredicateUnevaluableReason` | result types |
| `PREDICATE_SEMANTICS_VERSION` | `"1"` |

---

## Task 1 — exact decimal arithmetic for predicate comparators

**Files**

- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/decimal.ts` (new)
- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/decimal.test.ts` (new)

**Interfaces**
*Consumes:* `DECIMAL_STRING_PATTERN` from `../verdict-rule.js`; `ProfilesError` from
`../../errors.js` (base: `origin/integration/evidence-v1`).
*Produces:* internal `parseDecimal`, `compareDecimalExact`, `withinAbsolute`,
`withinRelative`, `decodeUint256`, `decodeInt256`, `formatUint` (not exported from the package
index — the public comparator surface is `evaluatePredicates`).

Wei values exceed `Number.MAX_SAFE_INTEGER`, so every comparison is scaled-`BigInt` exact.
`verdict-rule.ts` already owns an equivalent private comparator for *measurements*; it stays
untouched (Rule 3 — no refactor of working code), and this module is the predicate-side
equivalent with the tolerance arithmetic `verdict-rule.ts` has no need for. The two are held
equal by a cross-check test in Step 4.

**Steps**

- [ ] **Step 1 — write the failing test first.** Create `decimal.test.ts` asserting:
      `compareDecimalExact("0.50", "0.5") === 0`; `compareDecimalExact("-1", "0") === -1`;
      `compareDecimalExact("115792089237316195423570985008687907853269984665640564039457584007913129639935", "0") === 1`
      (max uint256 — no float path survives this); `compareDecimalExact("1e3", "1000") === undefined`
      (exponent notation is not the grammar); `withinAbsolute("100", "101", "1") === true` and
      `withinAbsolute("100", "102", "1") === false`; `withinRelative("100", "101", "0.01") === true`
      and `withinRelative("100", "102", "0.01") === false`;
      `decodeUint256("0x" + "0".repeat(63) + "a") === "10"`;
      `decodeInt256("0x" + "f".repeat(64)) === "-1"`;
      `decodeUint256("0x1234") === undefined` (not a 32-byte word).
      Run `yarn vitest run src/evaluation-spec/state-predicate/decimal.test.ts` — expect
      `Cannot find module './decimal.js'`.
- [ ] **Step 2 — implement.** Create `decimal.ts`:

```ts
import { DECIMAL_STRING_PATTERN } from "../verdict-rule.js";

/**
 * Exact decimal arithmetic for the state-predicate comparators. Every quantity this family
 * compares (wei, gas, token amounts, chain seconds) is a decimal STRING — sealed bytes admit
 * only I-JSON safe integers (src/bytes.ts), and wei exceeds that range by 200+ bits. All
 * comparison is scaled-BigInt: no float, no epsilon, no locale.
 */
export interface DecimalParts {
  readonly negative: boolean;
  readonly intDigits: string;
  readonly fracDigits: string;
}

export function parseDecimal(operand: string): DecimalParts | undefined {
  if (!DECIMAL_STRING_PATTERN.test(operand)) return undefined;
  const negative = operand.startsWith("-");
  const unsigned = negative ? operand.slice(1) : operand;
  const [intDigits, fracDigits = ""] = unsigned.split(".");
  return { negative, intDigits: intDigits ?? "0", fracDigits };
}

function scaled(parts: DecimalParts, scale: number): bigint {
  return BigInt(
    (parts.negative ? "-" : "") + parts.intDigits + parts.fracDigits.padEnd(scale, "0"),
  );
}

function alignedPair(left: string, right: string): [bigint, bigint] | undefined {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (a === undefined || b === undefined) return undefined;
  const scale = Math.max(a.fracDigits.length, b.fracDigits.length);
  return [scaled(a, scale), scaled(b, scale)];
}

/** -1 | 0 | 1 when both operands parse as decimals; `undefined` when either does not. */
export function compareDecimalExact(left: string, right: string): -1 | 0 | 1 | undefined {
  const pair = alignedPair(left, right);
  if (pair === undefined) return undefined;
  const [a, b] = pair;
  return a < b ? -1 : a > b ? 1 : 0;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** |observed - expected| <= tolerance, exactly. `undefined` when any operand is not decimal. */
export function withinAbsolute(
  observed: string,
  expected: string,
  tolerance: string,
): boolean | undefined {
  const a = parseDecimal(observed);
  const b = parseDecimal(expected);
  const t = parseDecimal(tolerance);
  if (a === undefined || b === undefined || t === undefined) return undefined;
  const scale = Math.max(a.fracDigits.length, b.fracDigits.length, t.fracDigits.length);
  return absolute(scaled(a, scale) - scaled(b, scale)) <= absolute(scaled(t, scale));
}

/** |observed - expected| <= |expected| * tolerance, exactly (tolerance is a fraction: "0.01" = 1%). */
export function withinRelative(
  observed: string,
  expected: string,
  tolerance: string,
): boolean | undefined {
  const a = parseDecimal(observed);
  const b = parseDecimal(expected);
  const t = parseDecimal(tolerance);
  if (a === undefined || b === undefined || t === undefined) return undefined;
  const scale = Math.max(a.fracDigits.length, b.fracDigits.length);
  const toleranceScale = t.fracDigits.length;
  const difference = absolute(scaled(a, scale) - scaled(b, scale)) * 10n ** BigInt(toleranceScale);
  const bound = absolute(scaled(b, scale)) * absolute(scaled(t, toleranceScale));
  return difference <= bound;
}

const HEX_WORD = /^0x[0-9a-f]{64}$/;

/** A 32-byte big-endian word as an unsigned decimal string; `undefined` if not a word. */
export function decodeUint256(word: string): string | undefined {
  if (!HEX_WORD.test(word)) return undefined;
  return BigInt(word).toString(10);
}

/** A 32-byte big-endian word as a two's-complement signed decimal string. */
export function decodeInt256(word: string): string | undefined {
  if (!HEX_WORD.test(word)) return undefined;
  const raw = BigInt(word);
  const limit = 1n << 255n;
  return (raw >= limit ? raw - (1n << 256n) : raw).toString(10);
}

/** A non-negative count as a decimal string (measurements are never JSON numbers). */
export function formatUint(value: number | bigint): string {
  return BigInt(value).toString(10);
}
```

- [ ] **Step 3 — green.** `yarn vitest run src/evaluation-spec/state-predicate/decimal.test.ts`
      — expect all assertions passing.
- [ ] **Step 4 — cross-check against the package's existing comparator.** Append a test that,
      for the pairs `["0.50","0.5"], ["1","2"], ["-3","-3"], ["10","9.999"]`, the sign of
      `compareDecimalExact(a, b)` agrees with `evaluateVerdictRule({threshold:{measurement:"m",op:"lt",value:b}}, {m:a})`
      and its `gt`/`eq` siblings (import `evaluateVerdictRule` from `../verdict-rule.js`). Two
      comparators in one package must not be able to drift. Run the file — green.
- [ ] **Step 5 — verify.** `yarn typecheck` (0 errors) and `yarn test` (whole suite green,
      nothing else touched).

**Commit:** `feat(profiles): exact decimal and word-decoding helpers for state predicates`

---

## Task 2 — the closed predicate vocabulary

**Files**

- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/vocabulary.ts` (new)
- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/vocabulary.test.ts` (new)

**Interfaces**
*Consumes:* `z` (zod 4.4.3); `COMPARISON_OPS`, `ComparisonOp`, `DECIMAL_STRING_PATTERN` from
`../verdict-rule.js`.
*Produces:* `PREDICATE_KINDS`, `PredicateKind`, `PredicateSchema`, `Predicate`,
`PREDICATE_COMPARATORS`, `PredicateComparator`, `SUCCESS_PREDICATE_KINDS`,
`SAFETY_CONSTRAINT_KINDS`, `MEASUREMENT_ONLY_KINDS`, `MeasurementObservationSchema`,
`StatePredicateMeasurementSchema`, `EnvelopeTighteningsSchema`,
`EnvironmentRecordDescriptorSchema`, `PREDICATE_SEMANTICS_VERSION`,
`CRYPTO_ENVIRONMENT_MEDIA_TYPE`, and the primitive schemas `AddressSchema`, `HexSchema`,
`Hex32Schema`, `UintStringSchema`, `DecimalStringSchema`.

**Steps**

- [ ] **Step 1 — pin the fixture-address convention** in a header comment: every address in
      this family's tests and fixtures is a synthetic documentation address of the form
      `0x` + a repeated nibble or a `0x0000…00NN` counter — **never** a well-known dev-mnemonic
      address (program §4.8: no fixture address may be one someone might fund). Reviewers check
      this by eye; `0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266` and its siblings must appear
      nowhere in this component.
- [ ] **Step 2 — failing tests first.** `vocabulary.test.ts` asserting, via
      `PredicateSchema.safeParse`:
      - each of the 14 kinds parses in its minimal legal form (14 assertions);
      - `{kind: "nativeBalanceX", …}` fails (closed vocabulary);
      - `{kind: "nativeBalance", account, cmp: "eq", value: "1", extra: 1}` fails (strict);
      - `{… cmp: "eq", tolerance: "0.1"}` fails (tolerance without `within-*`);
      - `{… cmp: "within-rel"}` without `tolerance` fails;
      - `{… account: "0xAB…"}` (uppercase) fails;
      - `{… value: 1}` (JSON number where a decimal string is required) fails;
      - `eventEmitted` with **both** `topic0` and `signature` fails, with **neither** fails;
      - `callResult` with `decode: "raw"` and `cmp: "gt"` fails (ordered comparison needs a
        numeric decode); with `decode: "uint256"` and a hex `value` fails.
      And for the CR6 call target: `callResult` parses with `call: {encodedCall: "0x70a08231…"}`
      **and** with `call: {abiRef, function: "balanceOf(address)", args: [{type: "address",
      value: "0x…"}]}`; `{abiRef, function, args}` carrying `encodedCall` as well fails (the two
      forms are alternatives, not a merge); `function: "balanceOf(address owner)"` fails (not the
      canonical signature); an arity mismatch (`"balanceOf(address)"` with two args) fails; a type
      mismatch (`"balanceOf(address)"` with a `uint256` arg) fails; `{type: "uint256", value: 1}`
      (JSON number) fails; and a nested-tuple arg type fails as out-of-vocabulary.
      Run — expect module-not-found.
- [ ] **Step 3 — implement the primitives and comparators.**

```ts
import { z } from "zod";
import { COMPARISON_OPS, DECIMAL_STRING_PATTERN } from "../verdict-rule.js";

/**
 * The evaluation semantics version of THIS family's predicate vocabulary — distinct from the
 * spec-wide `EVAL_SEMANTICS_VERSION` seed, which is unchanged by an additive family. A block
 * declaring an unknown version fails closed rather than being graded by an evaluator that does
 * not implement its rules.
 */
export const PREDICATE_SEMANTICS_VERSION = "1" as const;

/**
 * The composite kind a task's EvaluationSpec references (chain design §4.1/§6.1, E11). The
 * constant is OWNED by `@jinn-network/chain-environment-record` (CE1); profiles imports
 * `@jinn-network/task-execution-protocol` only, so the literal is restated here and held equal
 * by CE5's cross-package fixture — the same posture this package takes for sealing.
 */
export const CRYPTO_ENVIRONMENT_MEDIA_TYPE = "application/vnd.jinn.crypto-environment.v1+json" as const;

// Lowercase-only hex: rejection, never normalization — a read key is a pure concatenation of
// these strings, so two spellings of one address must not produce two keys.
export const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/, "address must be lowercase 0x-hex (20 bytes)");
export const HexSchema = z.string().regex(/^0x(?:[0-9a-f]{2})*$/, "must be lowercase 0x-hex with whole bytes");
export const Hex32Schema = z.string().regex(/^0x[0-9a-f]{64}$/, "must be a lowercase 0x-hex 32-byte word");
/** A non-negative integer as a decimal string — wei and gas exceed I-JSON's safe-integer range. */
export const UintStringSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/, "must be a non-negative decimal string");
export const DecimalStringSchema = z.string().regex(DECIMAL_STRING_PATTERN, "must be a decimal string");

/** Comparators (design §6.2): the six ordered/equality ops plus the two tolerance forms. */
export const PREDICATE_COMPARATORS = [...COMPARISON_OPS, "within-abs", "within-rel"] as const;
export type PredicateComparator = (typeof PREDICATE_COMPARATORS)[number];
export const TOLERANCE_COMPARATORS = ["within-abs", "within-rel"] as const;
export const ORDERED_COMPARATORS = ["lt", "lte", "gt", "gte", "within-abs", "within-rel"] as const;
```

- [ ] **Step 4 — the numeric-comparison mixin and its cross-field rule.**

```ts
const NUMERIC_COMPARISON_SHAPE = {
  cmp: z.enum(PREDICATE_COMPARATORS),
  value: DecimalStringSchema,
  tolerance: DecimalStringSchema.optional(),
} as const;

/** `tolerance` is required by `within-*` and forbidden otherwise — a tolerance an author
 * believes is applied but which the comparator ignores is a silent grading error. */
function refineTolerance<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((predicate: { cmp: PredicateComparator; tolerance?: string }, ctx) => {
    const needsTolerance = (TOLERANCE_COMPARATORS as readonly string[]).includes(predicate.cmp);
    if (needsTolerance && predicate.tolerance === undefined) {
      ctx.addIssue({ code: "custom", path: ["tolerance"], message: `Comparator "${predicate.cmp}" requires a tolerance.` });
    }
    if (!needsTolerance && predicate.tolerance !== undefined) {
      ctx.addIssue({ code: "custom", path: ["tolerance"], message: `Comparator "${predicate.cmp}" must not carry a tolerance.` });
    }
  }) as unknown as T;
}
```

- [ ] **Step 5 — the 14 predicate schemas.** Every one is `z.strictObject` with a literal
      `kind`, an optional `label` (author-facing name carried into the outcome vector), and the
      fields below. Compose the union with `z.discriminatedUnion("kind", [...])` so an unknown
      kind is rejected structurally (E7's closed vocabulary is the whole point).

      First, the **call target** shared by `callResult` and `reportedValue.groundTruth`
      (coordinator ruling CR6 — both forms ship, and CE2 encodes neither):

```ts
/**
 * A read call, declared either as calldata the author already had, or declaratively. CE2 never
 * turns the declarative form into bytes: `stateReadRequests` passes the abi reference, the
 * function signature, and the typed arguments through to the observation producer (CE3's probe
 * executor / replayer), which is where an encoder may sit behind the runtime port and where the
 * RPC call is made anyway. This module stays free of every chain library — the property Task 7
 * asserts mechanically — while the scenario layer, which has no encoder available to it at all,
 * can still express a read whose arguments are only known at parameterization time.
 */
const ABI_ARG_SCALAR_TYPES = ["address", "bool", "bytes", "bytes32", "int256", "string", "uint256"] as const;

const AbiArgSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("address"), value: AddressSchema }),
  z.strictObject({ type: z.literal("bool"), value: z.boolean() }),
  z.strictObject({ type: z.literal("bytes"), value: HexSchema }),
  z.strictObject({ type: z.literal("bytes32"), value: Hex32Schema }),
  z.strictObject({ type: z.literal("int256"), value: DecimalStringSchema }),
  z.strictObject({ type: z.literal("string"), value: z.string() }),
  z.strictObject({ type: z.literal("uint256"), value: UintStringSchema }),
  // Single-dimension arrays of the same closed scalar set. Nested tuples and multi-dimensional
  // arrays are outside v1: a template that needs one is a gap to widen deliberately (report it),
  // not a shape to approximate here.
  z.strictObject({ type: z.literal("address[]"), values: z.array(AddressSchema) }),
  z.strictObject({ type: z.literal("bytes32[]"), values: z.array(Hex32Schema) }),
  z.strictObject({ type: z.literal("uint256[]"), values: z.array(UintStringSchema) }),
]);
export type AbiArg = z.infer<typeof AbiArgSchema>;

export const CallTargetSchema = z.union([
  z.strictObject({ encodedCall: HexSchema }),
  z.strictObject({
    // Which ABI the author read this function out of — digest authoritative, bare-hex DigestSet,
    // never inlined. Same descriptor discipline as `environmentRecord`.
    abiRef: ResourceDescriptorSchema,
    // The canonical Solidity signature, e.g. "balanceOf(address)" — no spaces, no parameter
    // names, no return clause. Rejected otherwise, so the producer's selector derivation and
    // this module's key derivation cannot disagree about what the author meant.
    function: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*\((?:[A-Za-z0-9\[\]]+(?:,[A-Za-z0-9\[\]]+)*)?\)$/),
    args: z.array(AbiArgSchema),
  }),
]).superRefine((target, ctx) => {
  if ("encodedCall" in target) return;
  const declared = target.function.slice(target.function.indexOf("(") + 1, -1);
  const types = declared === "" ? [] : declared.split(",");
  if (types.length !== target.args.length) {
    ctx.addIssue({ code: "custom", path: ["args"], message: `function "${target.function}" declares ${types.length} parameter(s); ${target.args.length} argument(s) supplied.` });
  }
  types.forEach((type, index) => {
    const arg = target.args[index];
    if (arg !== undefined && arg.type !== type) {
      ctx.addIssue({ code: "custom", path: ["args", index, "type"], message: `argument ${index} is "${arg.type}" but the signature declares "${type}".` });
    }
  });
});
export type CallTarget = z.infer<typeof CallTargetSchema>;
```

      The arity/type cross-check matters: a declarative call whose arguments do not match its
      own signature would encode to something the author never intended, and the producer —
      which has the encoder — would have no way to know that.

| kind | fields (beyond `kind`, `label?`) | class |
| --- | --- | --- |
| `nativeBalance` | `account: Address`, numeric comparison over **wei** | state read |
| `erc20Balance` | `token: Address`, `account: Address`, numeric comparison | state read |
| `callResult` | `to: Address`, `call: CallTarget` (CR6 — `{encodedCall: Hex}` **or** `{abiRef, function, args}`), `decode: "raw" \| "uint256" \| "int256"`, `cmp`, `value` (`Hex` when `raw`, `DecimalString` otherwise), `tolerance?` | state read |
| `storageValue` | `address: Address`, `slot: Hex32`, `decode`, `cmp`, `value`, `tolerance?` | state read |
| `eventEmitted` | `source?: Address`, exactly one of `topic0: Hex32` \| `signature: string`, `argFilters?: ArgFilter[]`, `countCmp: {cmp: ComparisonOp, value: Uint}` | log |
| `eventForbidden` | same matcher, no `countCmp` (violated when count > 0) | log |
| `txOutcome` | `selector: {all: true} \| {index: Uint}`, `status: "success" \| "reverted"` | tx |
| `approvalConstraint` | `token?: Address`, `owner?: Address`, `noUnlimited: boolean`, `allowedSpenders?: Address[]`, `maxAllowance?: Uint` | log |
| `addressForbidden` | `targets: Address[]` (non-empty) | tx + log |
| `budget` | `metric: "gasTotal" \| "txCount" \| "valueOutWei"`, `cmp: ComparisonOp`, `value: Uint` | tx |
| `reportedValue` | `name`, `cmp`, `tolerance?`, `groundTruth: {to: Address, call: CallTarget, decode: "uint256" \| "int256" \| "raw"}`, `groundTruthState?: "baseline" \| "post-replay"` | state read + report |
| `timeBound` | `metric: "completedWithinBlocks" \| "completedWithinChainSeconds"`, `maximum: Uint` | timeline |
| `sourceValue` | `world: string`, `requestKey: string`, `selector: string`, `cmp`, `value: string \| boolean`, `tolerance?` | source read |
| `sourceConsulted` | `world: string`, `requestKey: string`, `countCmp?: {cmp: ComparisonOp, value: Uint}` | source (measurement-only, CE2-F4) |

  `ArgFilter` is `z.discriminatedUnion("on", [ {on:"topic", index: 1|2|3, equals: Hex32},
  {on:"dataWord", index: Uint, cmp: ComparisonOp, decode: "uint256"|"int256"|"raw", value} ])`
  — indexed-topic equality and 32-byte non-indexed word comparison. Richer log decoding (dynamic
  types, tuples) is not in v1; unlike the CR6 call form it needs no encoder to work around, so a
  template that requires it is a reported gap, not a blocked layer.

  Write the `decode`/`cmp`/`value` cross-field refinement once and reuse it for `callResult`,
  `storageValue`, and `ArgFilter.dataWord`: `decode: "raw"` admits only `eq`/`ne` with a `Hex`
  value; a numeric decode admits every comparator with a `DecimalString` value.

- [ ] **Step 6 — placement rules as data.**

```ts
export const PREDICATE_KINDS = [
  "addressForbidden", "approvalConstraint", "budget", "callResult", "erc20Balance",
  "eventEmitted", "eventForbidden", "nativeBalance", "reportedValue", "sourceConsulted",
  "sourceValue", "storageValue", "timeBound", "txOutcome",
] as const;                                    // sorted by code unit (src/order.ts convention)
export type PredicateKind = (typeof PREDICATE_KINDS)[number];

/** Design §6.2: `safetyConstraints` evaluate over the replay's transaction/receipt/log record,
 * so in v1 "throughout" is bounded to log- and transaction-observable kinds. A STATE predicate
 * used as a safety constraint is a validation error, not a best-effort check — per-operation
 * state snapshots are a parked extension. */
export const SAFETY_CONSTRAINT_KINDS = [
  "addressForbidden", "approvalConstraint", "budget", "eventForbidden", "txOutcome",
] as const;
/** `sourceConsulted` records what the agent read; it never gates (design §6.2, finding CE2-F4). */
export const MEASUREMENT_ONLY_KINDS = ["sourceConsulted"] as const;
export const SUCCESS_PREDICATE_KINDS = PREDICATE_KINDS
  .filter((kind) => !(MEASUREMENT_ONLY_KINDS as readonly string[]).includes(kind));
```

- [ ] **Step 7 — measurement sources and envelope tightenings.**

```ts
export const MeasurementObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("gasTotal") }),
  z.strictObject({ kind: z.literal("txCount") }),
  z.strictObject({ kind: z.literal("valueOutWei") }),
  z.strictObject({ kind: z.literal("blocksElapsed") }),
  z.strictObject({ kind: z.literal("chainSecondsElapsed") }),
  z.strictObject({ kind: z.literal("reportedValue"), name: z.string().min(1) }),
  EventCountObservationSchema,        // the eventEmitted matcher without countCmp
  SourceConsultedPredicateSchema,     // the same schema the vocabulary defines
]);
export const StatePredicateMeasurementSchema = z.strictObject({
  name: z.string().min(1),
  observe: MeasurementObservationSchema,
});

/** Tighten-only restrictions on the record's envelope (design §6.1). profiles validates SHAPE
 * only: the tighten-only COMPARISON needs the environment record's envelope, which is never
 * inlined here (E11) — CE3/CE5 perform it against the resolved record. */
export const EnvelopeTighteningsSchema = z.strictObject({
  maxTransactions: UintStringSchema.optional(),
  maxAggregateNativeValueWei: UintStringSchema.optional(),
  maxGasTotal: UintStringSchema.optional(),
  maxBlocksAdvanced: UintStringSchema.optional(),
  maxChainSecondsAdvanced: UintStringSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "envelopeTightenings must tighten something");
```

- [ ] **Step 8 — the environment-record descriptor (E11 + digest discipline).**

```ts
/** The composite crypto-environment record, by digest. No environment content is inlined
 * (E11) — `content` is rejected outright. `digest.sha256` is an in-toto DigestSet value:
 * BARE lowercase hex, never `sha256:`-prefixed (program §4.6). */
export const EnvironmentRecordDescriptorSchema = ResourceDescriptorSchema.superRefine((descriptor, ctx) => {
  if (descriptor.content !== undefined) {
    ctx.addIssue({ code: "custom", path: ["content"], message: "environmentRecord must be referenced by digest; no environment content is inlined (E11)." });
  }
  const sha256 = descriptor.digest?.["sha256"];
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    ctx.addIssue({ code: "custom", path: ["digest", "sha256"], message: "environmentRecord requires digest.sha256 as bare lowercase hex (in-toto DigestSet)." });
  }
  if (descriptor.mediaType !== CRYPTO_ENVIRONMENT_MEDIA_TYPE) {
    ctx.addIssue({ code: "custom", path: ["mediaType"], message: `environmentRecord must reference the composite crypto-environment record (${CRYPTO_ENVIRONMENT_MEDIA_TYPE}).` });
  }
});
```

- [ ] **Step 9 — green + verify.**
      `yarn vitest run src/evaluation-spec/state-predicate/vocabulary.test.ts` — every
      assertion in Step 2 passes. Then `yarn typecheck` and `yarn test`.

**Commit:** `feat(profiles): the closed state-predicate vocabulary (chain design §6.2)`

---

## Task 3 — the family enum amendment (CF1) and the family block

**Files**

- `packages/task-execution/profiles/src/evaluation-spec/schema.ts` (amend — enum + comment)
- `packages/task-execution/profiles/src/evaluation-spec/family-blocks.ts` (amend — block schema
  + `FAMILY_BLOCK_SCHEMAS` entry)
- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/block.test.ts` (new)
- `packages/task-execution/profiles/fixtures/state-predicate-block/golden/*.json` (new, 3)
- `packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/*.json` (new, 9)

**Interfaces**
*Consumes:* `withNamespacedExtras` (module-private in `family-blocks.ts` — which is exactly why
the block schema lives in that file, beside its four siblings), `GRADER_FAMILIES`,
`FAMILY_BLOCK_SCHEMAS`, everything Task 2 produced, `loadFixtureFamily` / `runStructuralCheck`
from `../../testing.js`, `ProfilesError`.
*Produces:* `STATE_PREDICATE_FAMILY`, `StatePredicateBlockSchema`, `StatePredicateBlock`.

**Steps**

- [ ] **Step 1 — failing fixtures first.** Create the `state-predicate-block` family, each file
      `{ "input": { "family": "state-predicate", "block": … }, "expect": … }` so the existing
      `runStructuralCheck` shape applies unchanged:

      `golden/`
      - `minimal.json` — one `nativeBalance` success predicate, empty `safetyConstraints`,
        empty `measurements`, `timeout: 600`; `expect` = the parsed block (identity).
      - `namespaced-extra-key.json` — the same block plus `"jinn.chain.hint": "context"`;
        `expect` = identity including the extension key.
      - `measurements-and-tightenings.json` — `successPredicates` of three kinds, two
        log-observable `safetyConstraints`, three `measurements` (one `gasTotal`, one
        `reportedValue`, one `sourceConsulted`), and an `envelopeTightenings` block.

      `adversarial/` (all `expect`: `{ "ok": false, "code": "invalid-document" }`)
      - `unknown-predicate-kind.json` — `{"kind": "oracleWhispers", …}` in `successPredicates`.
      - `safety-constraint-state-predicate.json` — an `erc20Balance` predicate inside
        `safetyConstraints` (design §6.2: v1 bounds "throughout" to log/tx-observable kinds).
      - `bare-extra-key.json` — block-level `"shortcut": true`.
      - `predicate-bare-extra-key.json` — `"jinn.chain.note"` inside a *predicate* (namespaced
        extensions are a block-level affordance; a gate is strict).
      - `source-consulted-as-success-predicate.json` — CE2-F4.
      - `environment-record-inlined-content.json` — descriptor carrying `content`.
      - `environment-record-prefixed-digest.json` — `digest.sha256` written
        `"sha256:aaaa…"` (**the digest-confusion fixture**, program §4.6).
      - `tolerance-without-within-comparator.json`.
      - `reserved-measurement-name.json` — a measurement named
        `successPredicatesSatisfied`.

      Write `block.test.ts` in the shape of `family-blocks.test.ts` (load the family, run
      `checkStatePredicateBlock`, assert every case `ok: true`). Run it — expect failure
      (`checkStatePredicateBlock` does not exist and the family is not in the enum).

- [ ] **Step 2 — amend the enum (CF1).** In `schema.ts`:

```ts
/** Grader families (5, §7.1 + chain-environment design §6/CF1: `state-predicate` added
 * additively — an enum amendment plus a typed block, proposed explicitly, never an appeal to
 * extension rules the profiles design does not carry). */
export const GRADER_FAMILIES = [
  "deterministic-process",
  "model-graded",
  "human-review",
  "composite",
  "state-predicate",
] as const;
```

      Nothing else in `schema.ts` changes: `familyBlock` is already cross-validated through
      `FAMILY_BLOCK_SCHEMAS[spec.family]`.

- [ ] **Step 3 — add the block schema in `family-blocks.ts`**, after the `composite` section
      and before `FAMILY_BLOCK_SCHEMAS`:

```ts
// --- state-predicate (chain-environment design §6.1/§6.2, CF1) ---

export const STATE_PREDICATE_FAMILY = "state-predicate" as const;

const STATE_PREDICATE_SHAPE = {
  // The COMPOSITE crypto-environment record, by digest (E11). Never inlined: this family has
  // no inline-match rule to enforce because there is nothing inline to match.
  environmentRecord: EnvironmentRecordDescriptorSchema,
  predicateSemanticsVersion: z.literal(PREDICATE_SEMANTICS_VERSION),
  successPredicates: z.array(PredicateSchema).min(1),
  safetyConstraints: z.array(PredicateSchema),
  measurements: z.array(StatePredicateMeasurementSchema),
  envelopeTightenings: EnvelopeTighteningsSchema.optional(),
  timeout: z.number().int().positive(),
};

export const StatePredicateBlockSchema = withNamespacedExtras(
  z.looseObject(STATE_PREDICATE_SHAPE),
  Object.keys(STATE_PREDICATE_SHAPE),
).superRefine((block, ctx) => {
  block.successPredicates.forEach((predicate, index) => {
    if ((MEASUREMENT_ONLY_KINDS as readonly string[]).includes(predicate.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["successPredicates", index, "kind"],
        message: `"${predicate.kind}" records what the agent read; it never gates (design §6.2).`,
      });
    }
  });
  block.safetyConstraints.forEach((predicate, index) => {
    if (!(SAFETY_CONSTRAINT_KINDS as readonly string[]).includes(predicate.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["safetyConstraints", index, "kind"],
        message:
          `safetyConstraints are bounded to log- and transaction-observable kinds in v1 `
          + `(${SAFETY_CONSTRAINT_KINDS.join(", ")}); "${predicate.kind}" reads state, and `
          + "per-operation state snapshots are a parked extension (design §6.2).",
      });
    }
  });
  const names = new Set<string>();
  for (const [index, measurement] of block.measurements.entries()) {
    if ((STATE_PREDICATE_RESERVED_MEASUREMENTS as readonly string[]).includes(measurement.name)) {
      ctx.addIssue({ code: "custom", path: ["measurements", index, "name"], message: `"${measurement.name}" is reserved by the state-predicate verdict rule.` });
    }
    if (names.has(measurement.name)) {
      ctx.addIssue({ code: "custom", path: ["measurements", index, "name"], message: `duplicate measurement name "${measurement.name}".` });
    }
    names.add(measurement.name);
  }
});
export type StatePredicateBlock = z.infer<typeof StatePredicateBlockSchema>;
```

      and register it:

```ts
export const FAMILY_BLOCK_SCHEMAS: Record<GraderFamily, z.ZodTypeAny> = {
  "deterministic-process": DeterministicProcessBlockSchema,
  "model-graded": ModelGradedBlockSchema,
  "human-review": HumanReviewBlockSchema,
  composite: CompositeBlockSchema,
  "state-predicate": StatePredicateBlockSchema,
};
```

      `STATE_PREDICATE_RESERVED_MEASUREMENTS` is imported from
      `./state-predicate/spec-checks.js` — if that creates an import cycle
      (`spec-checks` → `family-blocks` for the block type), declare the constant in
      `vocabulary.ts` instead and re-export it from `spec-checks.ts`. Verify with
      `yarn typecheck`; prefer whichever placement leaves the import graph acyclic and say so
      in the commit body.

- [ ] **Step 4 — the check function** in `state-predicate/spec-checks.ts` (created here, filled
      out in Task 8):

```ts
/** Structural check for the `state-predicate-block` fixture family: parses a
 * `{family, block}` case and throws `ProfilesError("invalid-document")` on any violation, so
 * `runStructuralCheck` can project it to `{ok:false, code}`. */
export function checkStatePredicateBlock(input: unknown): unknown {
  const { family, block } = input as { family: string; block: unknown };
  if (family !== STATE_PREDICATE_FAMILY) {
    throw new ProfilesError("invalid-document", `expected family "${STATE_PREDICATE_FAMILY}"`);
  }
  const parsed = StatePredicateBlockSchema.safeParse(block);
  if (!parsed.success) {
    throw new ProfilesError("invalid-document", "state-predicate block failed schema validation");
  }
  return parsed.data;
}
```

- [ ] **Step 5 — green.** `yarn vitest run src/evaluation-spec/state-predicate/block.test.ts`
      — all 12 fixture cases pass. Then `yarn vitest run src/evaluation-spec/family-blocks.test.ts`
      and `src/evaluation-spec/schema.test.ts` — both still green (the enum amendment is
      additive; the four existing families are untouched).
- [ ] **Step 6 — verify no exhaustive consumer broke.** From the repo root:
      `git grep -n "Record<GraderFamily\|GRADER_FAMILIES" -- packages` — expect hits only in
      `profiles`. Then `yarn typecheck` and `yarn test` in the package: 0 errors, all green.

**Commit:** `feat(profiles): add the state-predicate family and its block schema (CF1)`

---

## Task 4 — the canonical chain observation and the read-projection contract

**Files**

- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/observation.ts` (new)
- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/observation.test.ts` (new)
- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/reads.ts` (new)
- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/reads.test.ts` (new)

**Interfaces**
*Consumes:* Task 2's primitives; `StatePredicateBlock` from `../family-blocks.js`.
*Produces:* `CanonicalChainObservationSchema`, `CanonicalChainObservation`,
`CANONICAL_CHAIN_OBSERVATION_VERSION`, `StateReadRequest`, `SourceReadRequest`,
`stateReadKey`, `sourceReadKey`, `stateReadRequests`, `sourceReadRequests`.

**Steps**

- [ ] **Step 1 — failing tests.** `observation.test.ts`: a full golden observation parses; an
      observation with an unknown top-level key fails (**strict**: an unknown member means
      producer/consumer skew, and the verifier hashes these bytes); two `stateReads` entries
      with the same `(key, state)` fail (duplicate resolution would be order-dependent); an
      uppercase address fails. `reads.test.ts`: `stateReadRequests(block)` for a block with
      `nativeBalance` + `reportedValue` (default ground-truth state) returns exactly
      `[{key:"native-balance|0x…", state:"post-replay"}, {key:"call|0x…|encoded|0x…", state:"baseline"}]`
      — order-stable, deduplicated; the same block with `groundTruthState: "post-replay"`
      returns the call read tagged `post-replay`. For CR6: a declarative `callResult` yields a
      request whose `read` carries `{abiRef, function, args}` **unencoded** and whose key is
      `call|<to>|abi|<abiDigest>|<function>|<args>`; two predicates naming the same declarative
      call (different `label`, different `cmp`, different `value`) collapse to **one** request;
      and the declarative and `encodedCall` forms of the same underlying call yield **two**
      distinct keys (the documented consequence of keying over the declaration — assert it so
      nobody later reads it as a bug). Run — module-not-found.
- [ ] **Step 2 — implement `observation.ts`.** Members per design §5.1 step 7, plus CE2-F1 and
      CE2-F3. All numeric quantities are decimal strings; every array is required (empty when
      nothing occurred) so canonical bytes have no optional-key variance:

```ts
export const CANONICAL_CHAIN_OBSERVATION_VERSION = "1" as const;

const LogObservationSchema = z.strictObject({
  index: UintStringSchema,
  address: AddressSchema,
  topics: z.array(Hex32Schema).max(4),
  data: HexSchema,
});

const TransactionObservationSchema = z.strictObject({
  index: UintStringSchema,
  hash: Hex32Schema,
  from: AddressSchema,
  to: AddressSchema.nullable(),          // null = contract creation
  valueWei: UintStringSchema,
  status: z.enum(["success", "reverted"]),
  gasUsed: UintStringSchema,
  returnData: HexSchema,
  errorClass: z.string().optional(),     // negative probes declare their expected class
  logs: z.array(LogObservationSchema),
  blockNumber: UintStringSchema,
  blockTimestamp: UintStringSchema,
});

const StateReadObservationSchema = z.strictObject({
  key: z.string().min(1),                        // == stateReadKey(request)
  state: z.enum(["baseline", "post-replay"]),
  resolution: z.enum(["resolved", "unavailable"]),
  value: HexSchema.optional(),                   // absent iff unavailable
});

const SourceReadObservationSchema = z.strictObject({
  key: z.string().min(1),                        // == sourceReadKey(request)
  resolution: z.enum(["resolved", "miss", "unavailable"]),
  value: z.union([z.string(), z.boolean()]).optional(),
});

export const CanonicalChainObservationSchema = z.strictObject({
  observationVersion: z.literal(CANONICAL_CHAIN_OBSERVATION_VERSION),
  // The composite record the instance was materialized from — a record-body reference, so
  // `sha256:`-prefixed (the block's descriptor carries the bare-hex DigestSet form).
  environmentRecord: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  informationWorlds: z.array(z.string()),        // the worlds the criteria resolve in (E16)
  replay: z.strictObject({
    status: z.enum(["completed", "refused", "aborted"]),
    refusalClass: z.string().optional(),
  }),
  timeline: z.strictObject({
    initialBlockNumber: UintStringSchema,
    initialChainTimestamp: UintStringSchema,
    finalStateChangingBlockNumber: UintStringSchema,
    finalStateChangingChainTimestamp: UintStringSchema,
  }),
  transactions: z.array(TransactionObservationSchema),
  blocks: z.array(z.strictObject({ number: UintStringSchema, timestamp: UintStringSchema, hash: Hex32Schema })),
  touchedState: z.array(z.strictObject({
    address: AddressSchema,
    nativeBalanceWei: UintStringSchema,
    nonce: UintStringSchema,
    codeHash: Hex32Schema,
    storage: z.array(z.strictObject({ slot: Hex32Schema, value: Hex32Schema })),
  })),
  traceProjectionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  finalStateCommitment: Hex32Schema,
  errorClasses: z.array(z.string()),
  stateReads: z.array(StateReadObservationSchema),
  sourceReads: z.array(SourceReadObservationSchema),
  sourceConsultations: z.array(z.strictObject({ world: z.string(), requestKey: z.string(), count: UintStringSchema })),
  reports: z.array(z.strictObject({ name: z.string().min(1), value: z.union([z.string(), z.boolean()]) })),
}).superRefine((observation, ctx) => {
  const seen = new Set<string>();
  observation.stateReads.forEach((read, index) => {
    const identity = `${read.state}${read.key}`;
    if (seen.has(identity)) {
      ctx.addIssue({ code: "custom", path: ["stateReads", index], message: `duplicate state read for key "${read.key}" at ${read.state}.` });
    }
    seen.add(identity);
    if ((read.resolution === "resolved") !== (read.value !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["stateReads", index, "value"], message: "a resolved read carries a value; an unavailable read does not." });
    }
  });
  // …the same uniqueness/consistency rule for sourceReads and reports (by name).
});
export type CanonicalChainObservation = z.infer<typeof CanonicalChainObservationSchema>;
```

      Document at the top of the file, in one paragraph: *this is the shape a probe executor
      (§5.1 step 7) and a replayer (§6.4) both emit; the touched-state projection, trace digest,
      block commitments, and final state commitment exist so K runs can be compared for
      equality by CE3 — the evaluator does not read them; `stateReads`/`sourceReads` exist so a
      pure evaluator can resolve state and source predicates at all (finding CE2-F1).*

- [ ] **Step 3 — implement `reads.ts`.** The key grammar is a `|`-joined lowercase form; it is
      never parsed back, only compared:

```ts
export type StateRead =
  | { kind: "nativeBalance"; account: string }
  | { kind: "erc20Balance"; token: string; account: string }
  | { kind: "storageValue"; address: string; slot: string }
  // CR6: the call is carried in whichever form the author declared. The declarative variant
  // reaches the producer UNENCODED — CE3 encodes, because CE3 is where the encoder may live and
  // where the RPC call is made. Nothing downstream of this type needs CE2 to have touched bytes.
  | { kind: "call"; to: string; call: CallTarget };

export interface StateReadRequest {
  readonly key: string;
  readonly state: "baseline" | "post-replay";
  readonly read: StateRead;
}

/** Canonical key for a state read. Inputs are lowercase-by-schema, so this is concatenation —
 * no normalization step exists that a producer and a consumer could implement differently. */
export function stateReadKey(read: StateRead): string {
  switch (read.kind) {
    case "nativeBalance": return `native-balance|${read.account}`;
    case "erc20Balance": return `erc20-balance|${read.token}|${read.account}`;
    case "storageValue": return `storage|${read.address}|${read.slot}`;
    case "call": return `call|${read.to}|${callTargetKey(read.call)}`;
  }
}

/**
 * The key of a call target, over the DECLARATION (CR6). CE2 cannot resolve the declarative form
 * to calldata, so it does not key over calldata: two predicates naming the same declarative call
 * key identically whether or not anyone ever encodes them, and the encoded and declarative
 * spellings of one underlying call are two keys — consistent, deterministic, and not something
 * this module is in a position to deduplicate.
 */
function callTargetKey(target: CallTarget): string {
  if ("encodedCall" in target) return `encoded|${target.encodedCall}`;
  const abiDigest = target.abiRef.digest?.["sha256"] ?? "";
  return `abi|${abiDigest}|${target.function}|${target.args.map(abiArgKey).join(",")}`;
}

/** One argument as a key segment. `type:value` for scalars, `type:[v1;v2]` for arrays — the
 * values are already canonical strings (lowercase hex, decimal, "true"/"false") by schema, so
 * this is projection, never formatting. */
function abiArgKey(arg: AbiArg): string {
  return "values" in arg ? `${arg.type}:[${arg.values.join(";")}]` : `${arg.type}:${String(arg.value)}`;
}

export function sourceReadKey(read: { world: string; requestKey: string; selector: string }): string {
  return `source|${read.world}|${read.requestKey}|${read.selector}`;
}

/**
 * The projection contract (finding CE2-F1): every state read the block's predicates require,
 * with the state each must be taken at. An observation builder (CE3's probe executor or
 * replayer) fulfils exactly this list; the evaluator resolves by key and NEVER substitutes a
 * differently-tagged read — which is what makes §6.2's pre-replay ground-truth rule enforceable.
 * Success/safety predicates read `post-replay`; `reportedValue.groundTruth` reads `baseline`
 * unless the author declared `groundTruthState: "post-replay"`.
 */
export function stateReadRequests(block: StatePredicateBlock): StateReadRequest[] { … }
```

      Deduplicate by `(key, state)`, preserving first-appearance order across
      `successPredicates` then `safetyConstraints` then `measurements`. Add
      `sourceReadRequests(block): SourceReadRequest[]` with the same discipline.

- [ ] **Step 4 — write the producer obligation into the module's own docs (CR6).** A one-
      paragraph block comment above `stateReadRequests`, addressed to the observation producer:
      *a `call` read arrives in whichever form the author declared. `{encodedCall}` is calldata,
      send it. `{abiRef, function, args}` is a declaration — resolve the selector from the
      canonical `function` signature and encode `args` by their declared types, then send that.
      Report the result under the `key` this module computed, unchanged: the key is over the
      declaration, so an encoder that normalizes, reorders, or re-spells anything must not feed
      that back into the key.* This is the entire CE2↔CE3 contract for the declarative form, and
      it lives next to the code that emits it rather than only in this plan.
- [ ] **Step 5 — green + verify.** Run both new test files, then `yarn typecheck` and
      `yarn test`.

**Commit:** `feat(profiles): canonical chain observation schema and the read-projection contract`

---

## Task 5 — `evaluatePredicates`: the pure core and the log/tx-observable kinds

**Files**

- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/evaluate.ts` (new)
- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/evaluate.test.ts` (new)
- `packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/*.json` (new, 3
  of 7 — the rest land in Task 6)
- `packages/task-execution/profiles/fixtures/state-predicate-evaluation/adversarial/*.json`
  (new, 3 of 5)

**Interfaces**
*Consumes:* Tasks 1–4; `MeasurementMap` (type) from `../verdict-rule.js`; `ProfilesError`;
`keccak_256` from `@noble/hashes/sha3.js`.
*Produces:* `evaluatePredicates`, `PredicateOutcome`, `PredicateEvaluation`, `PredicateState`,
`PredicateUnevaluableReason`.

**Steps**

- [ ] **Step 1 — confirm the keccak import path before writing code.** From the package
      directory: `node -e "import('@noble/hashes/sha3.js').then(m => console.log(typeof m.keccak_256))"`
      — expect `function`. If it prints anything else, drop the `signature` affordance from
      `eventEmitted` (require `topic0`), record it as a grammar settlement in this plan's
      Findings table, and continue. Do not add a dependency.
- [ ] **Step 2 — the result types, written to Global Constraint 7.**

```ts
/** A predicate is `satisfied` or `violated` **against the named information contract**, or
 * `unevaluable` when the observation does not carry what the predicate needs. Nothing here is
 * "verified" or "correct": the outcome states what the sealed world showed under the block's
 * criteria, and `resolvedAgainst` names the environment record and information worlds those
 * criteria resolve in (design §6.2 E16). */
export type PredicateState = "satisfied" | "violated" | "unevaluable";

export type PredicateUnevaluableReason =
  | "environment-mismatch"
  | "replay-not-completed"
  | "state-read-not-projected"
  | "state-read-unavailable"
  | "source-read-not-projected"
  | "source-miss"
  | "report-missing"
  | "value-not-decodable";

export interface PredicateEvaluation {
  readonly slot: "success" | "safety" | "measurement";
  readonly index: number;
  readonly kind: PredicateKind;
  readonly label?: string;
  readonly state: PredicateState;
  readonly reason?: PredicateUnevaluableReason;
  readonly observed?: string | boolean;
  readonly expected?: string | boolean;
}

export interface PredicateOutcome {
  /** The information contract this outcome resolves against — never "the truth" (E16). */
  readonly resolvedAgainst: { readonly environmentRecord: string; readonly informationWorlds: string[] };
  readonly successPredicatesSatisfied: boolean;
  readonly safetyConstraintsViolated: boolean;
  readonly unevaluable: boolean;
  readonly unevaluableReasons: PredicateUnevaluableReason[];   // sorted, deduplicated
  readonly evaluations: PredicateEvaluation[];
  readonly measurements: MeasurementMap;
  /** Transactions the replay committed — 0 means the script changed nothing. Reported, never
   * judged: a conjunction that a do-nothing script already satisfies is admission's problem
   * (design §6.3), and this evaluator states the fact rather than erroring on it. */
  readonly observedStateChangingOperations: number;
}
```

- [ ] **Step 3 — the entry point and its fail-closed gates.**

```ts
export function evaluatePredicates(
  observation: CanonicalChainObservation,
  block: StatePredicateBlock,
): PredicateOutcome {
  const parsedObservation = CanonicalChainObservationSchema.safeParse(observation);
  if (!parsedObservation.success) {
    throw new ProfilesError("invalid-document", "canonical chain observation failed schema validation");
  }
  const parsedBlock = StatePredicateBlockSchema.safeParse(block);
  if (!parsedBlock.success) {
    throw new ProfilesError("invalid-document", "state-predicate block failed schema validation");
  }
  const o = parsedObservation.data;
  const b = parsedBlock.data;

  // Gate 1 — the observation must come from the environment the block names. A record-body
  // reference (`sha256:…`) compared against an in-toto DigestSet value (bare hex): the two
  // forms are compared through one explicit projection, never by string equality (§4.6).
  const declared = bareHex(b.environmentRecord.digest?.["sha256"] ?? "");
  const observed = bareHex(o.environmentRecord);
  if (declared !== observed) return wholeOutcomeUnevaluable(o, b, "environment-mismatch");

  // Gate 2 — a refused or aborted replay is not a graded run (finding CE2-F3).
  if (o.replay.status !== "completed") return wholeOutcomeUnevaluable(o, b, "replay-not-completed");
  …
}

function bareHex(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}
```

      `wholeOutcomeUnevaluable` returns `unevaluable: true`,
      `successPredicatesSatisfied: false`, `safetyConstraintsViolated: false` (an unevaluable
      run must not accuse the solver of a violation it cannot show), one `PredicateEvaluation`
      per declared predicate with that reason, and the measurements it can still compute from
      the observation.

- [ ] **Step 4 — the log/tx-observable evaluators.** One function per kind, each pure over the
      already-parsed observation:
      - `eventEmitted` / `eventForbidden`: resolve the matcher's `topic0` (given, or
        `keccak_256` of the UTF-8 `signature` rendered as `0x`+hex), filter
        `observation.transactions[*].logs` by `source` (when declared) and `topics[0]`, apply
        `argFilters` (indexed-topic equality; `dataWord` slices bytes `[32*i, 32*i+32)` of
        `data` and compares through Task 1's decoders), then compare the count with `countCmp`
        (`eventForbidden` is satisfied iff the count is zero).
      - `txOutcome`: `{all: true}` requires every transaction's status to match; `{index}`
        requires that transaction to exist (missing ⇒ `violated`, with `observed: "absent"` —
        an absent transaction is a factual failure of the claim, not a missing projection).
      - `budget`: `gasTotal` = Σ `gasUsed`; `txCount` = `transactions.length`;
        `valueOutWei` = Σ `valueWei`. Exact BigInt sums, compared with Task 1.
      - `addressForbidden`: violated when any transaction's `to`, or any log's `address`,
        appears in `targets`. **Document the bound in the JSDoc**: internal calls are not
        observable here — the trace is a digest, not a projection — so this constrains
        externally-addressed interaction and log-emitting interaction only (§6.2's authoring
        obligation, not a completeness claim).
      - `approvalConstraint`: scans logs for the canonical ERC-20
        `Approval(address,address,uint256)` topic0, filtered by `token`/`owner` when declared;
        violated when `noUnlimited` and the amount word is `0xff…ff`, when a spender is outside
        `allowedSpenders`, or when the amount exceeds `maxAllowance`. **JSDoc bound:** only the
        canonical ERC-20 `Approval` layout is recognized; a non-standard approval path is an
        authoring-checklist concern (§7), not something this predicate silently covers.
      - `timeBound`: `blocksElapsed` = `finalStateChangingBlockNumber − initialBlockNumber`;
        `chainSecondsElapsed` = the timestamp difference; satisfied iff `<= maximum`. Zero
        elapsed (a do-nothing script) is satisfied — stated in the JSDoc so no reader mistakes
        it for a bug.
- [ ] **Step 5 — aggregation.** `successPredicatesSatisfied` = every success predicate
      `satisfied` (an `unevaluable` success predicate is not satisfied — fail closed);
      `safetyConstraintsViolated` = any safety predicate `violated`;
      `unevaluable` = any success **or** safety predicate `unevaluable`; measurements are
      computed and returned whatever the gates say (they never gate), always as decimal strings
      or booleans, and always including the three reserved names from Task 8.
- [ ] **Step 6 — fixtures.** `state-predicate-evaluation` cases are
      `{ "input": { "block": …, "observation": … }, "expect": <PredicateOutcome> }`. This task
      lands: `golden/success-conjunction-satisfied.json`,
      `golden/do-nothing-satisfies-conjunction.json` (**the admission-relevant case** — an
      observation with zero transactions whose success conjunction is nevertheless true; the
      expected outcome is `successPredicatesSatisfied: true`,
      `observedStateChangingOperations: 0`, no error and no special-casing, because reporting
      it faithfully is what lets CE5's admission reject the task),
      `golden/safety-violated-unlimited-approval.json`;
      `adversarial/environment-record-mismatch.json`, `adversarial/replay-refused.json`,
      `adversarial/duplicate-state-read.json` (`expect`:
      `{"ok": false, "code": "invalid-document"}`). Drive them from `evaluate.test.ts` with
      `loadFixtureFamily` + `runStructuralCheck`.
- [ ] **Step 7 — green + verify.** `yarn vitest run src/evaluation-spec/state-predicate/evaluate.test.ts`,
      then `yarn typecheck` and `yarn test`.

**Commit:** `feat(profiles): pure predicate evaluator — log- and transaction-observable kinds`

---

## Task 6 — state reads, reported values, and source reads

**Files**

- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/evaluate.ts` (extend)
- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/evaluate.test.ts` (extend)
- `packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/*.json` (4 more)
- `packages/task-execution/profiles/fixtures/state-predicate-evaluation/adversarial/*.json` (2 more)

**Interfaces**
*Consumes:* Task 4's `stateReadKey` / `sourceReadKey` / `stateReadRequests`.
*Produces:* no new exported symbol — the same `evaluatePredicates`, completed.

**Steps**

- [ ] **Step 1 — the resolution helper, written so substitution is impossible.**

```ts
/**
 * Resolves one projected state read. The `(key, state)` pair is the whole lookup: a read
 * projected at the OTHER state is not a fallback, it is a miss. This is the mechanism behind
 * design §6.2's rule that `reportedValue.groundTruth` evaluates against the baseline
 * (pre-replay) state by default — without it, an agent that moves the value it was asked to
 * report would be graded against the value it just created.
 */
function resolveStateRead(
  observation: CanonicalChainObservation,
  key: string,
  state: "baseline" | "post-replay",
): { ok: true; value: string } | { ok: false; reason: PredicateUnevaluableReason } {
  const entry = observation.stateReads.find((read) => read.key === key && read.state === state);
  if (entry === undefined) return { ok: false, reason: "state-read-not-projected" };
  if (entry.resolution !== "resolved" || entry.value === undefined) {
    return { ok: false, reason: "state-read-unavailable" };
  }
  return { ok: true, value: entry.value };
}
```

- [ ] **Step 2 — the state predicates.** `nativeBalance`, `erc20Balance` (both `uint256` words
      ⇒ wei decimal strings), `storageValue` and `callResult` (per their `decode`). A decode
      failure ⇒ `unevaluable` with `value-not-decodable`, never a coerced comparison. `callResult`
      resolves through `stateReadKey({kind: "call", to, call})` — **identical code for both CR6
      forms**, because the key is over the declaration and the evaluator never looks at calldata:
      an encoded and a declarative predicate differ only in what the producer had to do before
      answering. Add a test asserting the two forms take the same code path (same resolution
      logic, same failure reasons) so no encode-shaped branch creeps in later.
- [ ] **Step 3 — `reportedValue`.** Look up `observation.reports` by `name` (missing ⇒
      `unevaluable`, `report-missing`); resolve the ground truth via
      `resolveStateRead(observation, stateReadKey({kind:"call", to, call}), block-declared state)`
      — again form-agnostic;
      compare reported against ground truth with the predicate's comparator and tolerance. The
      `observed` field carries the reported value and `expected` the ground truth, so the
      outcome vector shows both without anyone having to re-derive them.
- [ ] **Step 4 — `sourceValue` and `sourceConsulted`.** `sourceValue` resolves through
      `observation.sourceReads` by `sourceReadKey`: `miss` ⇒ `violated` with reason
      `source-miss` recorded (a captured-corpus miss is a fact about the dataset, and E16 says
      the criteria resolve *there*), `unavailable`/absent ⇒ `unevaluable`. `sourceConsulted`
      appears only under `measurements`: its value is the matching
      `observation.sourceConsultations[*].count` (0 when absent), and when `countCmp` is
      declared the evaluation entry records `satisfied`/`violated` **as metadata** — it is
      excluded from both aggregates by construction (the aggregation in Task 5 Step 5 folds
      only `slot === "success"` and `slot === "safety"` entries).
- [ ] **Step 5 — the two gaming fixtures (§6.2's adv-3 disposition).**
      - `golden/reported-value-baseline-ground-truth.json` — block omits `groundTruthState`;
        the observation projects the ground-truth call at **both** states with different values
        (baseline `"1000"`, post-replay `"1400"`); the agent reports `"1000"`. Expected:
        `satisfied`, `expected: "1000"` — the evaluator used the baseline read while a
        post-replay read sat right beside it.
      - `adversarial/reported-value-post-replay-only.json` — **the gaming fixture.** Block omits
        `groundTruthState` (so: baseline); the observation projects the ground-truth call
        **only at post-replay**, matching the agent's report exactly. Expected outcome:
        `unevaluable: true`, the predicate entry `{state:"unevaluable", reason:"state-read-not-projected"}`,
        `successPredicatesSatisfied: false`. A silent fall-through would have graded the agent
        against a number it created; this fixture is the regression test for that.
      - `golden/reported-value-post-replay-declared.json` — same world, block declares
        `groundTruthState: "post-replay"`, report `"1400"`. Expected: `satisfied`. The moved
        value is gradable *when the author said so*, which is exactly what the design's opt-out
        is for.
- [ ] **Step 6 — the remaining goldens.** `golden/time-bound-across-timewarp.json` (timeline
      spanning a `timeWarp`, satisfied at the declared maximum and violated one second past it
      — ship both directions as two cases) and `golden/source-value-and-consulted.json`.
      Adversarial: `adversarial/source-read-unavailable.json` ⇒ `unevaluable`. Also
      `golden/declarative-call-ground-truth.json` (CR6): the same reported-value scenario written
      with `call: {abiRef, function: "balanceOf(address)", args: […]}` instead of `encodedCall`,
      its projected read keyed `call|0x…|abi|…|balanceOf(address)|address:0x…` — the fixture a
      CE5 template's output actually looks like, and the one that proves the declarative path is
      gradable end to end without CE2 encoding anything.
- [ ] **Step 7 — a determinism + non-mutation test** in `evaluate.test.ts`: for the largest
      golden case, `JSON.stringify(evaluatePredicates(o, b))` equals itself across two calls,
      and `structuredClone`s of `o` and `b` taken before the call deep-equal the originals
      after it. Purity is a property, not a promise.
- [ ] **Step 8 — green + verify.** `yarn vitest run src/evaluation-spec/state-predicate/`,
      then `yarn typecheck` and `yarn test`.

**Commit:** `feat(profiles): pure predicate evaluator — state reads, reported values, source reads`

---

## Task 7 — prove purity and bounded claims mechanically

**Files**

- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/purity.test.ts` (new)

**Interfaces**
*Consumes:* `node:fs` and `node:path` **in the test only** (the module under test is what must
stay clean); the module closure rooted at `evaluate.ts`.
*Produces:* no runtime symbol — a guard.

**Steps**

- [ ] **Step 1 — write the closure walker.** Starting at
      `src/evaluation-spec/state-predicate/evaluate.ts`, follow every **value** import
      (relative specifiers resolved to `.ts` files) transitively, excluding `*.test.ts`.
      `import type …` statements are stripped before scanning — they are erased at compile time
      and cannot make a module impure (this matters: `src/errors.ts` type-imports
      `@jinn-network/task-execution-protocol`).
- [ ] **Step 2 — assert the external allowlist.** The set of non-relative value-import
      specifiers across the closure must deep-equal exactly:
      `["@noble/hashes/sha3.js", "zod"]` (sorted). Any other specifier fails with the offending
      file and specifier in the message. This is the "no chain package" assertion in its
      strongest form — an allowlist, not a blocklist, so a chain library nobody thought to name
      cannot slip in.
- [ ] **Step 3 — assert the forbidden-capability scan.** Across the same closure, zero matches
      for each of:

```ts
const FORBIDDEN = [
  { name: "node builtin", pattern: /["']node:[a-z_/]+["']/g },
  { name: "network", pattern: /(?<![\w$."'`])(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/g },
  { name: "clock", pattern: /(?<![\w$."'`])(?:Date|performance|hrtime)\b/g },
  { name: "randomness", pattern: /Math\s*\.\s*random\b/g },
  { name: "ambient host", pattern: /(?<![\w$."'`])(?:process|globalThis|global)\b/g },
];
```

      with a message naming the file, the capability, and the match. Then a **meta-test** (the
      repo's existing guard convention): write a temporary fixture file containing one of each
      forbidden form and assert the scanner finds exactly five — a scanner nobody has seen fail
      is not a guard.
- [ ] **Step 4 — assert no encoder exists here (CR6).** The declarative call form makes an
      encoder tempting: the next reader will see `{function, args}` and a comparison that wants
      bytes, and reach for one. Across the closure, assert zero matches for
      `/\b(?:encodeFunctionData|encodeAbiParameters|abiCoder|AbiCoder|keccak256|toFunctionSelector|encodePacked)\b/`
      — `keccak_256` (the `eventEmitted` signature hash, snake_case, allowlisted in Step 2) is
      deliberately not on that list, and the message states the rule: **CE3 encodes, CE2 keys and
      compares**. Add the matching meta-test case.
- [ ] **Step 5 — assert bounded claims (Global Constraint 7).** Across the same closure **plus**
      the two fixture directories' file names, zero matches for
      `/\b(?:verified|verifies|verify|verification|correct|correctly|proves|proven|guarantees)\b/i`.
      The vocabulary is satisfied / violated / unevaluable. If a comment genuinely needs to
      reference the verification protocol, it references it as "§5.1" or "the closed-state
      protocol" — the scan is the forcing function, and the message says so.
- [ ] **Step 6 — run and fix.** `yarn vitest run src/evaluation-spec/state-predicate/purity.test.ts`
      — expect failures on the first pass (the JSDoc written in Tasks 5–6 will contain at least
      one banned word); rewrite those comments rather than weakening the scan. Then the full
      `yarn test` and `yarn typecheck`.

**Commit:** `test(profiles): prove the predicate evaluator is pure and its claims bounded`

---

## Task 8 — verdict wiring, spec checks, kit registration, docs, and full verification

**Files**

- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/spec-checks.ts` (extend)
- `packages/task-execution/profiles/src/evaluation-spec/state-predicate/spec-checks.test.ts` (new)
- `packages/task-execution/profiles/src/index.ts` (amend — 5 export lines)
- `packages/task-execution/profiles/src/testing.ts` (amend — 2 fixture families, 3 kit re-exports)
- `packages/task-execution/profiles/fixtures/evaluation-spec/golden/state-predicate-minimal.json` (new)
- `packages/task-execution/profiles/fixtures/evaluation-spec/golden/state-predicate-minimal.sha256` (new)
- `packages/task-execution/profiles/README.md` (amend — one subsection)

**Interfaces**
*Consumes:* `VerdictRule`, `evaluateVerdictRule`, `MeasurementMap` from `../verdict-rule.js`;
`UnscorableClass` from `../unscorable.js`; `EvaluationSpec`, `sealEvaluationSpec`,
`parseEvaluationSpec`.
*Produces:* `STATE_PREDICATE_VERDICT_RULE`, `STATE_PREDICATE_RESERVED_MEASUREMENTS`,
`STATE_PREDICATE_UNEVALUABLE_CLASS`, `checkStatePredicateSpec`, plus the kit registration.

**Steps**

- [ ] **Step 1 — the canonical verdict rule.**

```ts
export const STATE_PREDICATE_UNEVALUABLE_CLASS = "state-predicate-unevaluable" as const;
export const STATE_PREDICATE_RESERVED_MEASUREMENTS = [
  "safetyConstraintsViolated",
  "statePredicateUnevaluable",
  "successPredicatesSatisfied",
] as const;

/**
 * Design §6.2's verdict rule, expressed in the package's existing declarative vocabulary
 * (§7.3) rather than as a second verdict path: all success predicates satisfied AND no safety
 * constraint violated; an unevaluable run resolves `inconclusive` under a declared
 * `recorded-inconclusive` class, never `fail`. A `state-predicate` spec MUST carry this rule
 * verbatim — otherwise an author could write a rule that reads `successPredicatesSatisfied`
 * and quietly ignores `safetyConstraintsViolated`.
 */
export const STATE_PREDICATE_VERDICT_RULE: VerdictRule = {
  all: [
    {
      inconclusiveWhen: { threshold: { measurement: "statePredicateUnevaluable", op: "eq", value: true } },
      class: STATE_PREDICATE_UNEVALUABLE_CLASS,
    },
    { threshold: { measurement: "successPredicatesSatisfied", op: "eq", value: true } },
    { not: { threshold: { measurement: "safetyConstraintsViolated", op: "eq", value: true } } },
  ],
};
```

- [ ] **Step 2 — `checkStatePredicateSpec(spec)`** returning `{ok: true} | {ok: false; code:
      "invalid-document"; reason: string}` (the `checkVerdictConsistency` result convention),
      asserting, for a spec whose `family` is `state-predicate`: the block parses; `verdictRule`
      deep-equals `STATE_PREDICATE_VERDICT_RULE`; the three reserved measurements are declared
      `type: "boolean", required: true`; every block measurement `name` is also declared in the
      spec's top-level `measurements`; and `unscorable` declares
      `{name: STATE_PREDICATE_UNEVALUABLE_CLASS, disposition: "recorded-inconclusive"}`. Reuse
      the package's deep-equality style; do not add a dependency.
- [ ] **Step 3 — the end-to-end test** in `spec-checks.test.ts`: build the golden
      `state-predicate-minimal` spec, `sealEvaluationSpec` it, assert the digest equals the
      pinned `.sha256`, `parseEvaluationSpec` round-trips it, `checkStatePredicateSpec` returns
      `{ok: true}`, and then — the loop closing —
      `evaluateVerdictRule(spec.verdictRule, evaluatePredicates(observation, block).measurements)`
      returns `{verdict: "pass"}` for the satisfied golden observation, `{verdict: "fail"}` for
      a safety-violated one, and `{verdict: "inconclusive", inconclusiveClass:
      "state-predicate-unevaluable"}` for the gaming fixture's observation. Generate the pinned
      digest with
      `node -e "import('./dist/index.js').then(m => console.log(m.sealEvaluationSpec(require('./fixtures/evaluation-spec/golden/state-predicate-minimal.json')).digest))"`
      after `yarn build`, and paste it into the `.sha256` file (no trailing content beyond a
      newline, matching the two existing pins).
- [ ] **Step 4 — negative spec checks:** a spec with a hand-rolled `verdictRule` omitting the
      safety clause ⇒ `{ok:false}`; a spec missing the unscorable class ⇒ `{ok:false}`; a spec
      whose block declares a measurement absent from the top-level declarations ⇒ `{ok:false}`.
- [ ] **Step 5 — export surface.** Append to `src/index.ts`:

```ts
export * from "./evaluation-spec/state-predicate/vocabulary.js";
export * from "./evaluation-spec/state-predicate/observation.js";
export * from "./evaluation-spec/state-predicate/reads.js";
export * from "./evaluation-spec/state-predicate/evaluate.js";
export * from "./evaluation-spec/state-predicate/spec-checks.js";
```

      `decimal.ts` stays internal. Confirm no name collides with an existing export
      (`yarn build` fails loudly on duplicate re-exports).
- [ ] **Step 6 — kit registration.** In `src/testing.ts`: add `checkStatePredicateBlock`,
      `checkStatePredicateSpec`, and `evaluatePredicates` to the re-export block (imported from
      their modules, keeping the file's import-then-re-export shape), and insert
      `"state-predicate-block"` and `"state-predicate-evaluation"` into `FIXTURE_FAMILIES`
      between `"schema-hardening"` and `"sub-profile"` (the list is code-unit sorted). Extend
      `src/testing.test.ts`'s existing coverage so the two new families are loadable through
      the kit path.
- [ ] **Step 7 — README.** Add one subsection under "Package contents" / the kit section: what
      the `state-predicate` family is (a sealed criteria document over a sealed chain world),
      that `evaluatePredicates` is pure and composed by both admission and evaluation, that the
      block references the **composite** environment record by digest, and the three-word
      outcome vocabulary (satisfied / violated / unevaluable) with the one-line reason it is
      not "verified". Two short paragraphs plus the fixture-family names — no narration of what
      the code already says.
- [ ] **Step 8 — full local verification, output shown.** From
      `packages/task-execution/profiles`:

```bash
yarn install --immutable
yarn typecheck        # 0 errors
yarn test             # whole suite green, including all 5 families' fixtures
yarn build
yarn check:documents  # the two sealed profile documents are untouched by this component
yarn pack:smoke
```

      From the repo root:

```bash
node --test .github/scripts/task-execution-package-inventory.test.mjs
node --test .github/scripts/task-execution-source-boundaries.test.mjs
node .github/scripts/task-execution-packed-types.test.mjs
```

      All three pass unchanged — CE2 adds no package, no entrypoint, and no dependency, so a
      failure in the inventory or boundary guard means something was added that this plan did
      not sanction. Investigate rather than editing the guard.
- [ ] **Step 9 — downstream sanity.** From the repo root, build the two packages that consume
      profiles' EvaluationSpec surface and run their suites to confirm the enum amendment is
      additive in practice, not just in principle:
      `(cd packages/task-execution/evaluation-harness && yarn install --immutable && yarn typecheck && yarn test)`.
      If a green build is not reachable locally for unrelated reasons, say so explicitly in the
      PR body rather than claiming it passed.

**Commit:** `feat(profiles): state-predicate verdict wiring, spec checks, family kit, and docs`

---

## Self-review

### §6 coverage, predicate by predicate

| Design §6.2 element | Where it lands | Fixture |
| --- | --- | --- |
| `nativeBalance{account, cmp, wei}` | vocabulary T2.5; evaluator T6.2 | golden success-conjunction; block minimal |
| `erc20Balance{token, account, cmp, value}` | T2.5 / T6.2 | golden measurements-and-tightenings |
| `callResult{to, encodedCall \| abiRef+args, cmp, expected, tolerance?}` | T2.5 `CallTargetSchema` (**both forms**, CR6) / T6.2, form-agnostic resolution | golden reported-value pair + golden declarative-call-ground-truth |
| `storageValue{address, slot, cmp, value}` | T2.5 / T6.2 | golden source-value-and-consulted |
| `eventEmitted{source?, signature\|topics, argFilters?, countCmp}` | T2.5 / T5.4 | golden success-conjunction |
| `eventForbidden{…}` | T2.5 / T5.4 | adversarial safety-constraint set |
| `txOutcome{index\|all, status}` | T2.5 / T5.4 | golden do-nothing (all, vacuous) |
| `approvalConstraint{noUnlimited, allowedSpenders?, maxAllowance?}` | T2.5 / T5.4 | golden safety-violated-unlimited-approval |
| `addressForbidden{targets[]}` | T2.5 / T5.4 | block measurements-and-tightenings |
| `budget{gasTotal\|txCount\|valueOut}` | T2.5 / T5.4 | golden safety-violated |
| `reportedValue{name, cmp, groundTruth, groundTruthState?, tolerance?}` | T2.5 / T6.3 | 3 fixtures (T6.5) |
| `timeBound{blocks\|chainSeconds}` | T2.5 / T5.4 | golden time-bound-across-timewarp ×2 |
| `sourceValue{world, requestKey, selector, cmp, expected}` | T2.5 / T6.4 | golden source-value-and-consulted |
| `sourceConsulted{world, requestKey, countCmp?}` | T2.5 / T6.4, measurement-only | adversarial source-consulted-as-success-predicate |
| Comparators `{eq,ne,lt,lte,gt,gte,within-abs,within-rel}` | T1 + T2.4 | vocabulary tests + tolerance adversarial |
| Closed vocabulary (E7): unknown kind rejected | T2.5 discriminated union | adversarial unknown-predicate-kind |
| Evaluation state: post-replay default | T4.3 `stateReadRequests` | golden reported-value-baseline |
| `reportedValue` ground truth pre-replay by default | T4.3 + T6.1 non-substituting resolver | **adversarial reported-value-post-replay-only** |
| `groundTruthState` opt-out explicit | T2.5 / T6.5 | golden reported-value-post-replay-declared |
| `timeBound` anchor = initial block/timestamp → last state-changing op, counting simulated time | T4.2 `timeline`, T5.4 | golden time-bound-across-timewarp |
| "Throughout" bounded to log/tx-observable kinds | T3.3 `SAFETY_CONSTRAINT_KINDS` refinement | adversarial safety-constraint-state-predicate |
| E16 information contract | T5.2 `resolvedAgainst`; T5.3 gate 1 | adversarial environment-record-mismatch |
| "What admission proves and cannot" | T5.6 do-nothing golden (reported, not errored); §6.3 stays CE5's | golden do-nothing-satisfies-conjunction |
| Verdict rule: conjunction AND no violation; measurements never gate | T8.1–T8.2 | spec-checks negative cases |
| Author-supplied grading code excluded | never introduced; predicates are strict data | (structural) |
| §6.1 family block: environmentRecord / success / safety / measurements / envelopeTightenings / timeout / namespaced extras | T3.3 | golden namespaced-extra-key, adversarial bare-extra-key |
| §6.4 solution-script model | consumed as observation members (`reports`, timeline, tx record) | T4.2 |

### Placeholder scan

No `TODO`, no `…` standing in for a decision, no unnamed file, no "TBD". Every path is exact,
every command is runnable from the stated directory, every commit message is written out. The
three ellipses that appear inside code blocks (`stateReadRequests` body, the observation's
second uniqueness refinement, the entry point's continuation) are explicitly delegated to the
adjacent step prose, which states the required behavior in full — they are not undecided
design.

### Signature consistency

- `evaluatePredicates(observation, block): PredicateOutcome` — argument order matches program
  §3 exactly, and the function is pure by construction and by Task 7's guard.
- `STATE_PREDICATE_FAMILY`, `StatePredicateBlockSchema`, `CanonicalChainObservationSchema` —
  pinned names, spelled as §3 spells them.
- Additive exports (`stateReadRequests`, `stateReadKey`, `sourceReadKey`, `checkStatePredicateSpec`,
  `STATE_PREDICATE_VERDICT_RULE`, …) are listed in the Interfaces table so CE3/CE5/CE6 planners
  can consume them without discovering them by grep. They extend §3; they do not change it.
- Result-shape conventions match the package: `{ok: true} | {ok: false; code: "invalid-document";
  reason}` for checks (`checkVerdictConsistency` precedent), thrown `ProfilesError` for fixture
  checks that `runStructuralCheck` projects (`checkFamilyBlock` precedent), decimal strings for
  every fractional or oversized quantity (`DecimalStringSchema` precedent), and `withNamespacedExtras`
  for the block (all four existing families' precedent).
