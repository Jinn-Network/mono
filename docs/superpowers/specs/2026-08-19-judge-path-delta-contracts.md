# Judge-path delta contracts (LoCoMo judge report, packet P0)

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-08-19 |
| **Author** | P0 design session (operator + Claude Fable 5); every seam cited path:line against `next` @ `4f4ad46f2` |
| **Shape** | `design` (packet P0 of the judge-report implementation program) |
| **Closes** | [#2842](https://github.com/Jinn-Network/mono/issues/2842) |
| **Program** | [`2026-08-18-judge-report-implementation-program.md`](../plans/2026-08-18-judge-report-implementation-program.md) |
| **Design authority** | The experiment design posted in [snap-research/locomo#23](https://github.com/snap-research/locomo/issues/23#issuecomment-5334425775) (2026-08-18). Nothing here changes it |
| **Ratifies** | Operator decisions **D1** (§6) and **D2** (§7), from issue #2842 comments 1 and 2 |
| **Gate** | **G1**. This document merging, with the §11 decision points picked, is G1 |

## 0. Scope and standing rules

### 0.1 What this document is

One freeze of every judge-path schema delta the confirmatory run needs, so packets P1 to P7 can be
implemented in parallel without contract drift. Each section states the frozen shape, the refusal
rules, the seams, and the owning packet. Nothing here is implementation; nothing here is optional
for the packet that owns it.

### 0.2 What this document does not do

It does not change the posted experiment design. Every delta below serves the design as posted; no
contract required a design change, so no in-thread amendment is triggered by this spec.

It does not build composable admission primitives (quorum, blinding, sampling as declared data).
The operator ruled those a later refactor.

It does not spec beyond the packets. Where an existing surface already satisfies a requirement, the
finding is recorded as "no change" rather than generalized.

### 0.3 License law (program §8, restated as spec law)

Only original code, generic schemas, and synthetic fixtures land in this repository. No dataset
row, no third-party judge prompt byte, no audit-derived annotation, not even as an example in this
document or in a test fixture. Every token, field name, and example below is original to this
design. Arms are referred to by role ("the evidence-declaring arm", "its evidence-free twin"),
never by publisher.

### 0.4 The compatible-widening rule

This rule governs every version decision in this document, and it is the reason most of these
deltas move no digests at all.

> A schema URI, a registered method version, or a sealed-document version **stays fixed** when a
> change only adds accepted inputs, and every input accepted before the change still validates,
> still seals to identical bytes, and still produces identical output.
>
> It **bumps** when any previously accepted input changes its meaning, its bytes, or its output.

Every widening specified below is compatible by construction. §10 names the three documents whose
bytes genuinely move, and therefore whose digests move, and what regenerates as a consequence.

### 0.5 Enforcement point discipline

Where a rule could be enforced at more than one place, this document names exactly one. A rule
enforced twice drifts; a rule enforced nowhere is prose. The chosen point is always the first place
where every input the rule reads is simultaneously frozen and in scope.

---

## 1. Judge-model profiles and run shape (packet P1, issue #2836)

### 1.1 The closed profile set

A **judge-model profile** is a named triple of (accepted `model.requested` literal set, generation
block shape, observation limitations tuple). The set is closed and has exactly two members.

| Profile id | `model.adapter` | Accepted `model.requested` | Generation block | Observation `limitations` |
|---|---|---|---|---|
| `reasoning-2026-08` | `jinn-openai` | `gpt-5.6-luna` | existing shape, byte-unchanged | `["mutable-model-alias"]` |
| `dated-snapshot-sampling` | `jinn-openai` | any member of `DATED_SNAPSHOT_MODELS` | sampling shape (§1.3) | `[]` |

`DATED_SNAPSHOT_MODELS` is a closed literal set. **At ratification it has exactly one member:
`gpt-4o-mini-2024-07-18`.** Adding a member is a code change with a test, never configuration and
never a caller-supplied string.

### 1.2 The profile is derived, never declared

The instrument gains **no new field**. The profile is a total function of `model.requested`:

```
JUDGE_MODEL_PROFILES: Readonly<Record<AcceptedModelId, JudgeModelProfileId>> = {
  "gpt-5.6-luna":           "reasoning-2026-08",
  "gpt-4o-mini-2024-07-18": "dated-snapshot-sampling",
}
```

A `model.requested` outside the map keys refuses at seal
(`parseBinaryJudgmentInstrument` / `sealBinaryJudgmentInstrument`), which is P1 acceptance 5's
"undeclared model id refuses at seal".

This derivation is not a stylistic preference. Declaring the profile as an instrument field would
add a required key to `BinaryJudgmentInstrumentSchema`, moving every existing instrument's bytes and
therefore its digest, which breaks P1 acceptance 2 (existing fixtures byte-compatible, the 144-cell
lifecycle test green unmodified). Derivation keeps every existing sealed instrument byte-identical.

### 1.3 Generation blocks

`BinaryJudgmentGenerationSchema`
(`packages/task-execution/profiles/src/binary-judgment/contracts.ts:126-139`) becomes a union
discriminated by profile, resolved from the enclosing instrument's `model.requested`.

**`reasoning-2026-08` variant, byte-identical to today:**

```
reasoningEffort: "none" | "low"
maxOutputTokens: 128
store: false, background: false, stream: false, serviceTier: "default",
tools: [], fallbackModels: [], retries: 0, persistedConversation: false,
metadata: null, promptCacheIdentifier: null
```

**`dated-snapshot-sampling` variant:**

```
temperature: 0                  // the literal I-JSON integer 0, never a string, never 0.0
maxOutputTokens: 512
store: false, background: false, stream: false, serviceTier: "default",
tools: [], fallbackModels: [], retries: 0, persistedConversation: false,
metadata: null, promptCacheIdentifier: null
```

`reasoningEffort` is **absent** from the sampling variant, and `temperature` is **absent** from the
reasoning variant. Both are strict objects; a stray key from the other variant refuses. A dated
non-reasoning snapshot has no reasoning effort, and emitting a null or zero placeholder for one
would be a fabricated pin.

`maxOutputTokens: 512` is the wider cap the program calls for. It is a literal, not a range: a
range is a generation setting nobody can reproduce.

The selection manifest's cross-arm rule is unchanged and still binding: **all arms of one run share
one identical generation block**
(`packages/benchmark-product/verify/src/profile/binary-judge-manifest.ts`, the
`InspectBinaryJudgeSelectionManifestSchema` refinement). The run therefore uses one profile across
its whole panel, which is exactly the design's "this run isolates the prompt, not the model".

### 1.4 Limitations, and the snapshot-identity check

`BinaryJudgmentObservationSchema.limitations` (`contracts.ts:343`) is today
`z.tuple([z.literal("mutable-model-alias")])`: one value, always emitted. It becomes a sorted,
unique array over the unchanged closed vocabulary `["mutable-model-alias"]`, with an exact
per-profile requirement:

- `reasoning-2026-08` observations **must** carry exactly `["mutable-model-alias"]`.
- `dated-snapshot-sampling` observations **must** carry exactly `[]`.

A mutable alias is a real limitation of an undated model id and a false claim about a dated
snapshot. Emitting it where it is not true is the kind of decorative disclosure that makes real
disclosure worthless.

In its place, a dated-snapshot observation records the **snapshot-identity check**, which is not a
new field: it is the existing `provider.requestedModel` and `provider.resolvedModel` pair
(`contracts.ts:328-329`, today both pinned to the single literal), promoted from an incidental
equality to an enforced one.

> **Snapshot identity.** For a `dated-snapshot-sampling` observation, `provider.requestedModel` and
> `provider.resolvedModel` must both equal the enclosing instrument's `model.requested`. A
> mismatch refuses at collect, typed `record-integrity`.

That is P1 acceptance 5's "resolved-model mismatch refuses at collect", and it is the evidence that
replaces the alias limitation.

The aggregate side enforces the same rule and must be widened in lockstep:
`packages/benchmarking/aggregate/src/binary-instrument-method.ts:1107-1108` hard-compares both
provider model fields to the single `MODEL_ID` literal (`:46`), and `:1140-1144` requires
`limitations` to be exactly the one-element frozen tuple. Both become the per-profile rule.

### 1.5 The pre-run snapshot-serving probe

The posted design makes the probe a precondition: "A pre-run check confirms that snapshot is
actually served; if it is not, the design changes here first, in public." The program requires it as
a recorded, sealable lock input. Frozen shape:

```
protocol: "https://spec.jinn.network/binary-judgment/snapshot-serving-probe/v1"
requestedModel: <one member of DATED_SNAPSHOT_MODELS>
resolvedModel:  <non-empty string, exactly as the provider returned it>
responseId:     <non-empty string>
eventSha256:    sha256:<64 lowercase hex>     // digest of the recorded provider event bytes
probedAt:       <RFC 3339 with offset>
outcome:        "serving" | "not-serving"
```

Sealed with the package's existing `sealDocument`. Rules:

1. `outcome` is `"serving"` if and only if `resolvedModel === requestedModel`. It is derived, and a
   record whose `outcome` disagrees with its own two model fields refuses at parse.
2. **It is a lock input by construction.** `InspectBinaryJudgeSelectionManifestSchema` gains an
   optional `snapshotProbeSha256`, **required** when any bound arm's model is in
   `DATED_SNAPSHOT_MODELS` and **forbidden** otherwise. The selection manifest digest already flows
   into `draft.spec.evaluationRuntime.selectionManifestSha256` and from there into the sealed Run at
   `lock`, so the probe is bound into the run's identity with no new plumbing.
3. **Freshness.** The bind refuses a probe whose `probedAt` is in the future relative to the bind
   clock, or older than `SNAPSHOT_PROBE_MAX_AGE_MS`, frozen at 24 hours. The design says
   "immediately before the run"; 24 hours is the checkable bound, and the G4 checklist keeps the
   operational discipline tighter.
4. `outcome: "not-serving"` refuses at bind, typed `conflict`. This is the branch where the design
   changes in public first.
5. The probe record is sealed into the workspace CAS and published as a bundle asset alongside the
   selection manifest, so a cold verifier reads the same bytes. P1 wires the bundle inclusion; P8
   asserts it survives cold verification.

Because the field is optional and absent on every existing selection, every existing sealed
selection stays byte-identical.

### 1.6 Arm cardinality (new finding, not in the program document)

**This is the one delta recon surfaced that the program did not list, and it blocks the run
outright.**

`packages/benchmark-product/core/src/run/binary-instrument-profile.ts:324` refuses any draft whose
`spec.arms.length !== 4`; `:349` and `:352` require exactly four sorted-unique arm ids and four
distinct instrument digests. The posted design runs a **six-arm** panel. The run cannot lock today.

The constraint is local. The sealed selection manifest itself already allows `arms` of length two
or more with no upper bound, sorted, unique, distinct instruments, one shared generation block.

**Frozen:** `validateRuntimeAndArms` requires `spec.arms.length === selection.arms.length`, and the
selection's own schema supplies the floor of two and the sorted/unique/distinct constraints. The
literal `4` disappears from all three sites. The 144-cell qualification fixture (four arms) stays
valid and byte-stable.

**Owner:** P1, same file and same PR as the model-literal widening. Added to P1's acceptance: a
six-arm synthetic draft compiles and locks; the existing four-arm qualification test is green
unmodified.

### 1.7 P1 seam inventory

| Seam | Change |
|---|---|
| `profiles/src/binary-judgment/contracts.ts:126-139` | generation union |
| `contracts.ts:229` | `model.requested` literal to closed set |
| `contracts.ts:266` | `BinaryJudgmentSemanticRequestSchema.model` likewise |
| `contracts.ts:328-329,343` | observation model literals and per-profile `limitations` |
| `verify/src/profile/binary-judge-manifest.ts` | arm `model` set, generation union, optional `snapshotProbeSha256` |
| `core/src/runtime/inspect/binary-judge.ts:141-142,233-236,312` | requirement model check, arm/instrument agreement, enforced inventory |
| `core/src/run/binary-instrument-profile.ts:324,349,352,370-386` | arm cardinality, arm pinning model, instrument model agreement |
| `core/src/operations/inspect-binary-judge.ts` | probe binding, probe freshness refusal |
| `aggregate/src/binary-instrument-method.ts:46,913,1045,1107-1108,1140-1144` | model set and per-profile limitations |
| `profiles/src/identifiers.ts` | new probe protocol URI |

---

## 2. Per-item evidence channel (packet P2, issue #2843)

### 2.1 Where evidence lives, and why that placement is load-bearing

**Frozen: `evidence`, an optional `string`, on `BinaryJudgmentPayloadSchema`
(`contracts.ts:92-98`).**

The placement is not a convenience. The Task is per **item**; arms differ only by instrument
(`core/src/intake/binary-item-bank.ts` `buildTask`, which seals `payload: input.item` and nothing
arm-specific). Putting evidence on the payload therefore means:

- **One imported bank serves every arm.** The evidence-declaring arm and its evidence-free twin
  read the same items.
- **Task digests are identical across arms**, because the Task does not depend on the arm at all.
  This is what makes the paired evidence contrast work: `paired-delta@1`'s exclusion rule is "pair
  Task digests judged in both arms" (`aggregate/src/registry.ts:249-259`). Any arm-scoped placement
  would fork the Task per arm, and the pairing would find zero pairs.

Any alternative placement (on the arm, on the instrument, as a side manifest keyed by arm) is
therefore refused by this spec, not on taste but because it breaks §7's registered contrast.

### 2.2 Declaration: template fields

`BINARY_JUDGMENT_TEMPLATE_FIELDS` (`contracts.ts:101-105`) splits into two frozen lists:

```
BINARY_JUDGMENT_REQUIRED_TEMPLATE_FIELDS = ["question", "referenceAnswer", "candidateAnswer"]   // unchanged
BINARY_JUDGMENT_OPTIONAL_TEMPLATE_FIELDS = ["evidence"]
BINARY_JUDGMENT_TEMPLATE_FIELDS          = required followed by optional                        // the segment enum
```

The instrument superRefine (`contracts.ts:245-253`) keeps requiring that every **required** field is
interpolated at least once. It imposes nothing on optional fields.

**An instrument declares evidence if and only if at least one of its message segments is
`{field: "evidence"}`.** There is no second declaration mechanism: no boolean, no input-shape
enum, no manifest flag. One source of truth cannot drift from itself.

Rendering (`renderBinaryJudgmentMessages`, `contracts.ts:286-291`) is unchanged: segments
concatenate `payload[segment.field]`. An instrument that does not name `evidence` cannot render it,
which is the leak boundary stated as code rather than as policy.

### 2.3 The leak-refusal rule: direction and typing

> **Arms constrain items; items never constrain arms.**

| Combination | Ruling | Typing |
|---|---|---|
| Instrument interpolates `evidence`, bank items carry none | **Refuse** | `refuse("conflict", "spec.arms.<i>.instrument", "instrument interpolates evidence but the bound bank carries none")` |
| Bank items carry `evidence`, instrument does not interpolate it | **Allowed, and required by the design** | none |

The second row is the entire point of the contrast: one bank, one item set, one Task set, and two
arms that differ only in whether their prompt reads the evidence field. The declaring arm's twin
must be able to ignore evidence that is present.

**Enforcement point: lock (`core/src/run/binary-instrument-profile.ts`,
`validateRuntimeAndArms`).** Lock is the first moment where the arm set and the item set are both
frozen and both in scope. Binding is not, because a bind may precede the benchmark attachment.

**Leak test (P2 acceptance 2).** For a non-declaring instrument, the rendered messages from an
evidence-carrying bank must be byte-identical to the rendered messages from an otherwise-identical
evidence-free bank. Asserted on message bytes, not on absence of the substring.

### 2.4 Two import-time refusals

**Uniformity.** Within one bank, `evidence` is present on every item or on no item. Mixed banks
refuse: `refuse("validation", "items", "evidence must be present on every item or on none")`.
Uniformity turns §2.3's arm rule into a per-bank property rather than a per-item scan, and it
removes a whole class of silent per-item degradation where one arm quietly renders a hole.

**Anti-truth-channel invariant.** Within one bank, any two items whose `question` bytes are
identical must carry byte-identical `evidence`:
`refuse("validation", "items.<n>.item.evidence", "items sharing a question must carry identical evidence")`.

This is the enforceable half of the program's "adding one must not become a covert truth channel".
It does not prove the evidence is truth-free; nothing can. It forecloses the specific mechanism by
which evidence could vary with the label: tailoring the passage per candidate class, or per
reference-key variant in the corrupt-key pairs. Evidence is a property of the question, and this
check is that sentence made checkable.

Restated as a standing obligation on the research side: **evidence bytes are never derived from
`truthLabel`, `candidateClass`, or `stratum`.** Truth, class, and stratum remain evaluator-only, on
the analysis context, unchanged (`contracts.ts:364-374`).

Evidence is solver-visible by construction, and that is correct: it is source-dataset material, not
truth. Its provenance descriptor rides in the existing source manifest.

### 2.5 Digest joins: no new row is needed, and that is the finding

The program's P2 acceptance 4 asks for "the digest join extended to cover the evidence bytes". It
already is, exactly and transitively, because evidence rides inside the payload:

- `itemSha256 = recordDigest(canonicalJsonBytes(payload))` covers it, and feeds the
  `analysis context/item`, `analysis context/item id`, and `label resolution/item` equalities
  (`evaluator-adapters/src/binary-judgment/adapter.ts`, the `requireJoinedInputs` table).
- The sealed Task bytes cover it, feeding `evaluation context/Task` and `observation/Task`.
- For a **declaring** arm only, `binaryJudgmentSemanticRequestDigest` covers the rendered bytes,
  feeding `semantic request/observation`.

**Frozen: the join table gains no row.** P2 instead asserts coverage with a mutation test: flip one
byte of one item's `evidence` and the `analysis context/item` equality must fail. Adding a
redundant `evidenceSha256` equality would create a second commitment that can disagree with the
first, which is strictly worse than one commitment that cannot.

### 2.6 Digests that move

`BINARY_JUDGMENT_PROFILE_DIGEST`
(`profiles/src/documents/binary-judgment-1.0.ts:84-85`) **moves**: `payloadSchema.properties` gains
`evidence`, so the profile document's bytes change. Every Task's `profile.digest` moves, so every
task digest moves, so every judge fixture and the 144-cell test's expected values regenerate. This
is anticipated by P2 acceptance 4 and must be called out in the PR body with the before and after
digests.

Parser-semantics digests do **not** move for P2. See §10 for the full inventory and for the merge
ordering P2, P3, and P7 must observe, since all three regenerate the same fixture corpus.

---

## 3. Declared stratum vocabulary (packet P4, issue #2845)

### 3.1 The hard enum becomes a grammar plus a derived vocabulary

Today `BinaryJudgmentStratumSchema` (`contracts.ts:360`) is `z.enum(["core","stress"])`, and the
value is re-checked as a hard pair in three more places:
`aggregate/src/binary-instrument.ts:157-158` (`fail("unsupported-vocabulary", ...)`),
`BINARY_INSTRUMENT_PARAMETER_SCHEMA.strata` (`prefixItems [core, stress]`, min 2, max 2), and
`core/src/run/binary-instrument-profile.ts:299-300`
(`sameJson(verified.strata, ["core","stress"])`).

**Frozen:**

1. **Grammar.** `StratumNameSchema = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/`. This is deliberately the
   grammar `candidateClass` already uses (`contracts.ts:372`). One identifier dialect, not two.
2. **The declared vocabulary is derived, not declared twice.** It is the sorted, unique, non-empty
   set of `stratum` values over the admitted analysis contexts, obtained exactly as
   `candidateClasses` is obtained today (`deriveAdmissionProfile` returns `verified.classes`).
   `deriveAdmissionProfile` returns `strata: verified.strata` instead of the literal pair. No new
   manifest field, no new CLI flag, no second place for the vocabulary to disagree with the data.
3. **Sealed in the analysis plan.** `buildAnalysisPlan` (`core/src/run/compile.ts:82-100`) seals the
   derived vocabulary into the `binary-instrument@1` parameters, which are sealed into the Run at
   lock and published in the Report's method parameters. The vocabulary is therefore
   pre-registered before the run, which is the property that matters.
4. **Parameter schema.** `strata` becomes
   `{type: "array", minItems: 1, uniqueItems: true, items: {type: "string", pattern: <grammar>}}`
   with the same sorted-and-unique refinement `validateBinaryInstrumentParameters` already applies
   to `candidateClasses`. `["core","stress"]` is sorted, unique, and grammar-conforming, so existing
   parameter sets stay valid and compute identically. Under §0.4 this is a compatible widening:
   **`binary-instrument@1` does not bump to `@2`.**

### 3.2 Two refusals, at two different points, for two different reasons

| Point | Checks | Refusal |
|---|---|---|
| **Import** (`convertBinaryItemBank`, admission closure) | grammar only | `refuse("validation", ...)` on a stratum value that does not match `StratumNameSchema` |
| **Method compute** (`aggregate/src/binary-instrument.ts` `requireContext`) | membership in the sealed `parameters.strata` | `fail("unsupported-vocabulary", "<label>.stratum is not in the sealed stratum vocabulary")` |

The split is not arbitrary. At import there is no declared list to check against, because the list
**is** the observed set. At compute the list exists, is sealed, and predates the run, so membership
is the meaningful check: a context whose stratum is outside the sealed vocabulary is evidence that
the analysis context and the sealed plan disagree, which is exactly the class of drift
`unsupported-vocabulary` exists to catch.

Zero-denominator strata are unchanged: the slice is emitted with its counts and the interval is
withheld.

### 3.3 What this means for the run

For the LoCoMo run the stratum vocabulary is the four source-question categories, declared by the
bank as four grammar-conforming names. `core`/`stress` remains a valid vocabulary for any other
bank, byte-compatibly. **No new axis is added**: category is carried on the existing stratum axis,
not alongside it.

---

## 4. Parser identities and contracts (packet P3, issue #2844)

### 4.1 The mechanism

1. A **parser identity** is `{id, version, digest}`, where `digest` is the SHA-256 of the parser's
   own sealed, code-free semantics document. Unchanged pattern
   (`contracts.ts:150-175`, `evaluator-adapters/src/parser-identity.ts:18-23`).
2. The **umbrella** semantics document
   (`buildBinaryJudgmentEvaluationParserSemantics`, `contracts.ts:181-195`) lists the complete
   response-parser registry in `responseParsers`, code-unit sorted by `(id, version)`. Adding a
   parser changes the umbrella digest by construction. That tripwire is the point.
3. `ParserIdentitySchema` (`contracts.ts:212-216`), today three literals pinning the single parser,
   becomes: `id` is a member of the closed registry id set, and `version` and `digest` are exactly
   the registered pair for that `id`. Anything else refuses at instrument seal.
4. **Instrument selects; it never supplies.** `response.parser` names one registered identity. There
   is no arm-supplied, task-supplied, or configuration-supplied parser code anywhere, ever.
5. **Execution allowlist.** `evaluatorAdaptersParserAllowlist()`
   (`parser-identity.ts:51-57`) gains one `parserAllowlistKey` per new parser. A spec naming an
   unlisted identity is refused by the harness runtime before an adapter is selected. Unchanged
   mechanism.
6. **Version immutability.** A parser's semantics document is immutable at a version. Any change to
   normative behavior requires a new `version`, hence a new digest and a new allowlist key. Editing
   semantics without bumping the version breaks the build (the existing `parser-identity.test.ts`
   pin).
7. **Invalid-output policy belongs to the instrument, not the parser.** Every parser returns
   `{decision, parseValid, invalidReason?}`; the instrument's `response.invalidOutputDecision` maps
   `parseValid === false` to a decision. Frozen at `"REJECT"` for v1, which is the posted design's
   rule that unreadable output counts as a reject and reports as a parse failure.

### 4.2 The closed set of parser contracts

Five contracts. All read exact response bytes. All decode strict UTF-8 with `fatal: true` and
`ignoreBOM: true` (the BOM is **kept**, not stripped, and is therefore an unexpected code point).
All report `invalidReason: "invalid-utf8"` on a decode failure. All are pure: no locale, no Unicode
normalization, no regular-expression whitespace class, no model call, no clock.

**"Edge trim"** below always means exactly the four code points U+0020, U+0009, U+000D, U+000A,
trimmed at both ends only.

---

**PC-1. `network.jinn.parser.binary-accept-reject@1.0.0` (existing, byte-unchanged).**
Edge-trim the decoded text. Accept exactly `ACCEPT` (decision ACCEPT) or exactly `REJECT` (decision
REJECT), case-sensitively. Anything else: `parseValid = false`,
`invalidReason = "unexpected-token"`.

**PC-2. `network.jinn.parser.binary-yes-no@1.0.0` (new).**
Identical discipline to PC-1 over a different two-token alphabet: exactly `YES` maps to ACCEPT,
exactly `NO` maps to REJECT, case-sensitive.

**PC-3. `network.jinn.parser.binary-correct-wrong@1.0.0` (new).**
Identical discipline: exactly `CORRECT` maps to ACCEPT, exactly `WRONG` maps to REJECT,
case-sensitive.

PC-2 and PC-3 are separate identities rather than a widened PC-1 alphabet. A single parser that
accepts six tokens would silently make three prompt families behave identically, and the whole
point of the experiment is that each arm's parse behavior is declared as its own harness declares
it. A parameterized alphabet is rejected for the same reason: a parameter supplied per arm is
arm-supplied parser configuration in disguise, and rule 4 of §4.1 forbids it.

**PC-4. `network.jinn.parser.binary-json-verdict@1.0.0` (new).** JSON-wrapped verdict.
Edge-trim the decoded text. The result must parse as a **single** JSON value under strict RFC 8259:
no trailing content, no comments, no `NaN`, no `Infinity`. The value must be an **object** carrying
a member named exactly `verdict` whose value is a string. That string, after the same edge trim,
must be exactly `ACCEPT` or `REJECT`. Other members are ignored, so a judge that also emits a
rationale field still parses. A duplicate `verdict` member, a missing member, a non-string value, a
non-object root, or unparseable JSON: `parseValid = false`, `invalidReason = "unexpected-token"`.

Deliberately **not** tolerant of code fences or surrounding prose. A parser that scavenges JSON out
of a wrapper is a parser whose behavior nobody can state in a sentence, and this experiment's
deliverable is a disclosure specification. Unstatable behavior cannot be disclosed.

**PC-5. `network.jinn.parser.binary-label-in-prose@1.0.0` (new).** Label in prose.
Do **not** trim. Scan the decoded text for occurrences of the exact ASCII tokens `ACCEPT` and
`REJECT`, matched case-sensitively, each occurrence required to be delimited: the character
immediately before and immediately after, where one exists, must not be an ASCII letter, an ASCII
digit, or `_`. If exactly one of the two tokens occurs, any number of times, that token is the
decision and `parseValid = true`. If both occur, or neither occurs, `parseValid = false`,
`invalidReason = "unexpected-token"`.

No stemming, no case folding, no synonyms, and explicitly **no positional preference**: there is no
"last occurrence wins". A rule that silently resolves a self-contradicting response is a rule that
hides the self-contradiction, and the flip rate this experiment publishes exists to surface exactly
that kind of instability.

### 4.3 Adversarial cases (each becomes a P3 fixture)

| Case | PC-1 / PC-2 / PC-3 | PC-4 | PC-5 |
|---|---|---|---|
| empty output | invalid | invalid | invalid |
| whitespace only | invalid | invalid | invalid |
| leading and trailing newlines around a valid token | **valid** | **valid** | **valid** |
| lowercase token | invalid | invalid (lowercase `verdict` value) | invalid |
| interior whitespace inside the token | invalid | invalid | invalid |
| token followed by `.` | invalid | n/a | **valid** (delimiter rule) |
| token embedded in a word (`ACCEPTABLE`) | invalid | n/a | invalid (delimiter rule) |
| both tokens present | invalid | invalid | invalid |
| BOM prefixing a valid token | invalid (U+FEFF is not edge-trimmed) | invalid | **valid** (delimiter rule; U+FEFF is not a letter, digit, or `_`) |
| invalid UTF-8 | invalid, `invalid-utf8` | invalid, `invalid-utf8` | invalid, `invalid-utf8` |
| output truncated at the generation cap | ordinary rules apply; no length rule exists in any parser | same | same |
| JSON object with extra members | invalid | **valid** | depends on tokens present |
| JSON inside a code fence | invalid | invalid | depends on tokens present |
| JSON array root | invalid | invalid | depends on tokens present |
| duplicate `verdict` member | invalid | invalid | depends on tokens present |

The BOM row is stated explicitly so that a future reader does not "fix" it. Over-length output has
no parser rule by design: the generation block's `maxOutputTokens` bounds it upstream, and a
truncated response is just bytes.

### 4.4 The arm-to-parser map is data, not a repo contract

Which as-found arm uses which parser contract is **arm-pinning data**, sealed per instrument in
`response.parser` and published in the bundle. The research-side inventory decides it. **This
repository never records which published judge uses which parser**, in code, in fixtures, or in
documentation. P3 ships the five contracts and their fixtures; it ships no mapping.

### 4.5 Digests that move

The umbrella `BINARY_JUDGMENT_EVALUATION_PARSER_SEALED.digest` moves, because `responseParsers`
grows. That digest is the EvaluationSpec's `grader.digest`, `familyBlock.image.digest`, and
`familyBlock.parser.digest` (`evaluator-adapters/src/binary-judgment/adapter.ts:130-155`), so the
**EvaluationSpec digest moves too**, and with it the `evaluation context/specification` join and
every judge fixture. The mirrored literals at
`aggregate/src/binary-instrument-method.ts:64` (`EVALUATION_PARSER_SHA256`) and `:66`
(`RESPONSE_PARSER_DIGEST`) must be updated in the same commit. PC-1's own semantics document and
digest do **not** move.

---

## 5. Ungradeable classes for binary judgment (packet P7, issue #2846)

### 5.1 The declared class list

`EvaluationSpec.unscorable` for binary judgment is today `[]`
(`evaluator-adapters/src/binary-judgment/adapter.ts:158`). Frozen list, code-unit sorted by `name`
so the sealed bytes are deterministic, every entry disposition `retryable-infrastructure`:

```
[
  { name: "broker-error",         disposition: "retryable-infrastructure" },
  { name: "provider-unavailable", disposition: "retryable-infrastructure" },
  { name: "transport-timeout",    disposition: "retryable-infrastructure" },
]
```

**Why `retryable-infrastructure` and never `recorded-inconclusive`.** The class means "no judgment
was obtained", not "a judgment was obtained and is inconclusive". The disposition semantics match
exactly: no verdict, the attempt terminates `failed {blame: infrastructure}`, never FAIL and never
inconclusive (`profiles/src/evaluation-spec/unscorable.ts:4-9`).

Independently, `recorded-inconclusive` is not reachable here even if it were wanted. Finding C of
`evaluator-adapters/README.md` records that the harness runtime never forwards a declared unscorable
class to the verdict-consistency check, so an adapter can deliver `inconclusive` only when the
spec's `verdictRule` recomputes to inconclusive under a declared `inconclusiveWhen` predicate.
**Frozen: binary judgment declares no `inconclusiveWhen` and never delivers `inconclusive`.**

### 5.2 Mapping from operational errors

The mapping is total over the existing, verified retryable-failure vocabulary in the journal
(`core/src/run/journal.ts`, `evaluation-retryable-failure.category`):

| Journal `category` | Unscorable class |
|---|---|
| `backend-unavailable` | `provider-unavailable` |
| `dependency-unavailable` | `broker-error` |
| `transport-failure` | `transport-timeout` |

**The integrity split.** Operational errors carrying `recoveryAdvice: "do-not-retry"` map to **no
class at all**: `invalid-evaluator-output`, `subject-digest-mismatch`, and `subject-not-found`
(`adapter.ts`, the `malformed` / `mismatch` / `missing` helpers). These are integrity failures, not
infrastructure. They terminalize the cell as `could-not-grade` with `failureCategory` recorded, are
never retried, and are never scored. An integrity failure that gets a retry is an integrity failure
that gets a second chance to pass, which defeats the check.

### 5.3 Retry-once, and the accounted unscorable cell

`assurance.overrides.maxInfrastructureRetries` (`core/src/domain/draft.ts:63-64`) is `0 | 1`.
**Frozen at `1` for this run**, which is the design's retry-once rule expressed as pre-lock data
rather than as operator discipline.

Semantics:

1. The **first** failure in a declared class consumes the single allowed infrastructure retry:
   journal `evaluation-retryable-failure`, `recoveryAdvice: "new-attempt-required"`.
2. A **second** failure on the same cell leg terminalizes the cell as `could-not-grade`
   (`journal.ts`, `evaluationTerminal: "could-not-grade"`) with `failureCategory` set. This is the
   **accounted unscorable cell**: never a silent retry, never a scored REJECT.
3. **Exclusion.** `binary-instrument@1`'s exclusion rule already reads "exact k-cell Task/arm groups
   only; transport absence, inconclusive, conflict, or missing evaluation excludes the item-arm with
   exact cells" (`aggregate/src/registry.ts:280-298`). Frozen: an ungradeable cell excludes its
   **entire item-arm group**, with the exact cell keys listed in the method's exclusions output.
   There is no partial-k majority. This is the standing prohibition against treating replicates as
   items, applied to the failure path.

### 5.4 Matrix full-claim-closure disclosure

**Frozen:** a Matrix containing an accounted unscorable cell refuses full-claim closure unless that
cell appears in the accounting disclosure. Concretely, `publish`'s claim-consistency check refuses
when the Report's completeness and attrition disclosure does not account for every expected cell
that was not judged.

The run-stop itself stays an **operator** action: the design says a second failure stops the run
until the design is updated in public, and engineering does not auto-halt a daemon on a statistical
policy. What engineering guarantees is that the stop is **visible in artifacts**, not only in
operational discipline. That is P7 acceptance 3, and §5.4 is its mechanism.

### 5.5 Digests that move

The EvaluationSpec digest moves, because `unscorable` changes from `[]` to the three-entry list.
Same propagation as §4.5, and the same fixture regeneration. See §10 for the merge ordering.

---

## 6. Screening-model admission branch (packet P6, issue #2838; ratifies D1)

Operator decision **D1 is ratified as ruled**: build the branch before the run, in the simplified
shape below. The program's fallback stands unchanged: if the branch is not merged by the G2 target
date, the run uses `operator-only` plus prose disclosure and the branch lands post-run.

### 6.1 The mode name

**Frozen: `screened-operator-sampled`.**

The name is a claim, so it is chosen against the overclaim test. It contains no "human", no
"unanimous", no "independent". It reads as what it is: screened by a pinned model, sampled and
checked by the operator. It sits between `operator-only` and `two-human-unanimous` and never
presents as independent human truth. Rejected alternatives: `model-screened` (hides the operator
check entirely) and `screened-human-sampled` (borrows an independence claim the protocol does not
earn).

### 6.2 The screening instrument pin

**Frozen: the screening instrument is a `BinaryJudgmentInstrument`**, byte-identical grammar to a
judge arm: same schema, same seal, same digest rule, same §1 model-profile rule. Its `instrumentId`
names the screen. **It is never an arm of the run.**

This is the ruling's "same grammar as a judge arm" at zero new schema cost. It also composes with
§2 for free: the design screens each item against the question, the key, **and the dataset's own
evidence**, so the screening instrument is simply an evidence-declaring instrument over the same
payload shape. No screening-specific payload, no second rendering path.

### 6.3 The screening table

One signed record per bank. All the ruling's derived quantities (the flagged set, the sample, the
exclusions, the agreement rate) are **views** of this table, never stored fields that can disagree
with it.

```
protocol: "https://spec.jinn.network/binary-judgment/screening-table/v1"
draftId:                    <identity>
screeningInstrumentSha256:  sha256:<64 hex>
sampleSeed:                 <non-empty string, the exact authored seed>
sampleSize:                 <positive integer>
samplingScriptSha256:       sha256:<64 hex>
rawOutputsSha256:           sha256:<64 hex>          // digest-bound sidecar; the verifier never walks it
rows:                       [ ScreeningRow, ... ]     // sorted by itemSha256, unique, non-empty
sealedAt:                   <RFC 3339 with offset>
```

```
ScreeningRow = {
  itemSha256:       sha256:<64 hex>
  intendedLabel:    "CORRECT" | "WRONG"                       // from source provenance
  screeningVerdict: "CORRECT" | "WRONG" | "indeterminate"
  handChecked:      boolean
  handVerdict:      "confirm" | "exclude"                     // present iff handChecked === true, absent otherwise
}
```

`screeningModel` is deliberately **absent**: it is derivable from `screeningInstrumentSha256`, and a
second copy is a second thing to drift.

`handVerdict` deliberately does **not** reuse `BinaryJudgmentTruthLabelSchema`. The hand-check
outcome space is **confirm or exclude only, with no label corrections**, matching the posted design
text. A disposition typed as a label would invite exactly the correction the design forbids.

The table is signed **once**, over the whole record, on the existing DSSE signing path used by the
other admission records.

### 6.4 The per-row admission rule

```
agreed  := screeningVerdict === intendedLabel
admitted := handChecked ? (handVerdict === "confirm") : agreed
```

Stated in words: **the hand check, when it happened, decides; otherwise agreement decides.** A row
where the screen agreed but the hand check said `exclude` is **excluded**. That tie-break is the
only sane reading: if the machine overrode the human, the hand check would be decoration.

`screeningVerdict === "indeterminate"` never agrees, so such a row is admitted only by hand
confirmation.

Every non-admitted row is excluded and must appear in the existing replacement ledger
(`verify/src/admission/contracts.ts`, `HumanReviewReplacementLedgerEntrySchema`) with a **same-class,
same-stratum** replacement, and **the ledger must close**. The ledger's `reason` enum gains the
values this branch produces; the existing three values are byte-unchanged.

### 6.5 What the verifier recomputes

Four recomputations, all from the sealed table plus the frozen bank, and nothing else.

**(1) Sample membership.** Recomputed by a procedure specified here and implemented in
`@colophon-claims/verify`, **not** by executing the sealed sampling script. The script's digest
records what the operator actually ran; the verifier's independent recomputation is what makes the
sample checkable. A verifier that must execute an arbitrary sealed script to check a sample is not
a verifier.

> **Procedure `screening-sample/1`.** Given the table's sorted-unique `rows`, `sampleSeed`, and
> `sampleSize`: for each row compute
> `stream := HMAC-SHA256(key = utf8(sampleSeed), message = utf8(itemSha256))`; sort rows ascending
> by `stream` compared as 32 unsigned bytes, ties broken by `itemSha256` in code-unit order; the
> sample is the first `sampleSize` rows.

Deterministic, seedable, no PRNG state to carry, and reimplementable from this paragraph in any
language. If the recomputation and the sealed script disagree, **the recomputation wins and
admission refuses.**

**(2) Required hand checks.** `flagged := rows where NOT agreed`. Every row in
`flagged` union `sample` must carry `handChecked === true`. A flagged row without a hand check
refuses. This is the design's "anything it flags, plus a random sample, I check by hand", made
checkable.

**(3) Sample agreement rate.** One definition, so nobody computes it three ways:

```
sampleAgreementRate := |{ r in sample : r.agreed === (r.handVerdict === "confirm") }| / |sample|
```

This is the screen-versus-hand agreement rate on the random sample. A flagged sampled row the hand
confirms is a screen error; an unflagged sampled row the hand excludes is also a screen error. Both
count against the rate, which is why the definition is symmetric rather than a bare confirm rate.

**(4) Per-row admission and ledger closure**, per §6.4.

**Not recomputed, by design:** the raw screening outputs sidecar. It is digest-bound and opaque.
No schema is imposed on its bytes and no check reads them except the digest. Anyone can re-run the
pinned screen against the published instrument and diff.

### 6.6 Ordering: sealed before the first judge call

The ruling asks to reuse the existing ordering receipt. The existing receipt
(`HumanReviewRevealReceiptSchema`) is **per item**, and this branch's subject is the **bank**.

**Frozen:** a sibling record with the same primitive, the same attestor role, and the same
`judgeExecutionState: "not-started"` gate, differing only in its subject:

```
protocol: "https://spec.jinn.network/binary-judgment/screening-reveal-receipt/v1"
draftId:                <identity>
screeningTableSha256:   sha256:<64 hex>
truthFrozenAt:          <RFC 3339 with offset>
judgeExecutionState:    "not-started"
attestedBy:             <identity>
attestorKeyId:          <identity>
attestorRole:           "truth-reveal-attestor"
```

This is the faithful reading of "reuses the existing ordering receipt": same ordering primitive,
same gate, one receipt per bank. Literal reuse would require either widening the shipped
per-item schema (which the two-human branch's byte-compatibility forbids) or stuffing a table digest
into a field named `itemSha256` (a mislabel that would outlive everyone who understood it).
**Flagged for ratification** in case the operator meant literal record reuse.

### 6.7 Label resolution: the third union member

`BinaryJudgmentLabelResolutionSchema`
(`profiles/src/binary-judgment/label-resolution.ts:70-73`) gains a third member:

```
{
  protocol, itemSha256, itemId, truthLabel, candidateClass, stratum, resolvedAt,   // the seven common fields
  truthAdmission:                "screened-operator-sampled",
  screeningTableSha256:          sha256:<64 hex>,
  screeningRevealReceiptSha256:  sha256:<64 hex>,
}
```

`humanReviewEvaluationSpecSha256` is **not** inherited: for a row that was never hand-checked there
is no human-review evaluation, and carrying a required field whose meaning does not apply is a
fabricated reference.

**Frozen refactor, byte-preserving:** `CommonShape` (`label-resolution.ts:19-28`) is reduced to the
seven genuinely common fields, and `humanReviewEvaluationSpecSha256` moves into the two existing
branch object literals, where it already appears in every serialized record. Moving a field from a
shared spread into two branch literals changes **no serialized bytes**, so every existing
`two-human-unanimous` and `operator-only` resolution stays byte-identical. P6 asserts this with a
fixture.

`screeningRowIndex` is deliberately absent: the row is findable by `itemSha256`, and an index is a
second way to name the same row.

### 6.8 Admission manifest and downstream

- `BinaryJudgmentAdmissionManifestSchema.truthAdmission`
  (`verify/src/admission/contracts.ts:167-177`) gains `"screened-operator-sampled"`.
- The manifest gains `screeningTableSha256: DigestSchema.optional()`, with a refinement: present if
  and only if `truthAdmission === "screened-operator-sampled"`. Existing manifests stay
  byte-identical.
- `BINARY_INSTRUMENT_PARAMETER_SCHEMA.truthAdmission` gains the third value.
  `deriveAdmissionProfile` passes it through unchanged, so the admission grade is sealed into the
  Run's analysis parameters and published in the Report as data rather than prose. Compatible
  widening under §0.4: `binary-instrument@1` does not bump.
- The importer's closure check (`core/src/intake/binary-item-bank.ts`) accepts the branch through
  the same verified-closure path as the other two.

**Publication grade.** The screened branch is publication-grade: it is not `operator-only` and must
not carry `operator-only-not-publication-grade`, which is the whole reason D1 chose to build it. It
carries its own named limitation instead, emitted in the Report's `limitations` and rendered by the
site:

```
"screened-not-independently-labeled"
```

### 6.9 Deliberately dropped, recorded so nobody re-adds it

Per-item signatures, visibility and blinding receipts, and the reviewer roster. One key signing 240
rows separately proves nothing beyond one signature on the whole table, and a blindness claim by the
bank's own author would be theater. The table is signed once. This paragraph exists so that a
future reviewer reading the two-human branch does not "restore symmetry".

### 6.10 Byte-compatibility

`two-human-unanimous` and `operator-only` are byte-unchanged end to end: schemas, sealed records,
fixtures, and the verifier's recomputations. Asserted by fixture (P6 acceptance 2). The screening
model can never be confused with a human verdict: distinct evidence class, distinct measurement
names, distinct record protocol URIs, asserted by fixture (P6 acceptance 3).

---

## 7. Cross-arm projections (packet P5, issue #2837; ratifies D2)

Operator decision **D2 is ratified as ruled**: two registered comparisons, two sealed companions,
and the claim-table rule.

### 7.1 Registered: `pairwise-disagreement@1`

**New method id.** `jinn.benchmarking.method/pairwise-disagreement`, added to
`BENCHMARKING_METHOD_IDS` (`records/src/identifiers.ts:58-69`) at the shared version `"1"`.

**Registry row** (`aggregate/src/registry.ts`):

```
requiredInputs:      ["matrix.cells", "referenced-result-evaluations", "exact-analysis-context-bytes"]
parameterSchema:     required ["verdictRule","k","reduction","measurementProfile",
                               "candidateClasses","strata","parserInvalidPolicy","intervalAlpha"]
                     (all derived from the draft and sealed evidence, never caller-supplied,
                      exactly as binary-instrument@1 derives its own)
outputShape:         "per-arm-pair item-majority disagreement counts, rate, Wilson interval,
                      per-candidate-class slices, and exclusions"
exclusionRule:       "exact k-cell Task/arm groups only; an item excluded for either arm of a pair
                      is excluded from that pair, with exact cells"
clusteringRule:      "Task digest plus arm pair; strict majority over registered scientific replicates"
referenceSet:        "v1-reference"
deterministic:       true
computeAvailability: "available"
```

**Input.** Item-majority decisions per arm, reduced by strict majority over odd `k`, with
parser-invalid mapped to REJECT per the instrument's frozen invalid-output policy. **Frozen: the
majority reduction is single-sourced from the `binary-instrument@1` module and never
reimplemented.** Two implementations of one reduction is two numbers waiting to disagree in public.

**Parameters carry no arm pair.** The method computes **all unordered arm pairs in one pass**, so it
needs no `baseline` and no `candidate`, and one report pass covers the whole panel rather than one
pass per pair. The design's question 3 is about the panel, not about a chosen pair.

**Output shape (exact):**

```
{
  pairs: [                                        // all unordered pairs, sorted by (armA, armB)
    {
      armA, armB,                                 // code-unit sorted so armA < armB
      n,                                          // items with a majority decision in BOTH arms
      disagreements,                              // items whose majority decisions differ
      rate,                                       // fixed-4 decimal string
      interval: { lower, upper, alpha },          // Wilson, fixed-4 decimal strings
      byCandidateClass: [                         // sorted by candidateClass
        { candidateClass, n, disagreements, rate, interval }
      ],
      exclusions: [ { taskDigest, armId, reason } ]   // sorted
    }
  ]
}
```

**Determinism.** Integer counts plus the package's existing Wilson interval. No resampling, no seed.
Byte-stable on recompute, which the method-conformance suite asserts.

**No ranking.** The output is a symmetric pair count. There is no order, no score, no winner, and
no vendor name anywhere in it. The report may say the panel spreads; it may never say which
published number is right.

**Lock-time work.** `buildAnalysisPlan` (`core/src/run/compile.ts:82-100`) refuses unregistered
method ids at compile time, deliberately, so P5 adds the id to that allowlist and adds a
`compilePairwiseDisagreementProfile` sibling of `compileBinaryInstrumentProfile`: the same joins and
the same derivation, minus the arm-cardinality and baseline/candidate branches. This is real work,
sized here so it is not discovered late: a registered method is an id, a registry row, a derivation,
a lock-time allowlist entry, and a conformance fixture, not a statistics function.

### 7.2 Registered: the evidence contrast through `paired-delta@1`, unmodified

**Verified input mechanics** (`aggregate/src/registry.ts:249-259`):

```
requiredInputs: ["matrix.cells", "referenced-verdicts", "task-provenance-source"]
exclusionRule:  "pair Task digests judged in both arms; per-Task rates average all judged
                 replicates; report full remainder"
clusteringRule: "task-provenance-source"
parameters:     { verdictRule, baseline, candidate, seed, resamples, alpha }
```

**Does it carry the evidence contrast, given §2? Yes, and without an adapter for the join.** Because
§2 places evidence on the shared payload, the evidence-declaring arm and its evidence-free twin
judge the **same Task digests**, so "pair Task digests judged in both arms" joins them exactly.
Provenance clustering works because items already carry provenance descriptors
(`contracts.ts:74-79,97`). The measured quantity is the paired difference in per-item agreement
rate between the two arms, with a two-sided clustered BCa interval, which is precisely what the
design's row "the judge's input shape is a first-class disclosure entry" needs.

**One divergence, disclosed rather than engineered away.** `paired-delta@1`'s per-Task rate is the
**mean over judged replicates**, not the strict majority. D2 authorized an input adapter "only if it
cannot consume item-level majority decisions", and strictly it cannot.

**Frozen recommendation: use `paired-delta@1` unmodified and disclose the unit.** The report states
that the paired contrast's unit is the per-item mean over the `k` replicates, while every per-arm
headline count in the report is item-majority per `binary-instrument@1`.

Rationale. Adding a reduction parameter forks a v1-reference method's parameter schema and its
cold-verification surface. The difference it would buy is nil whenever the three calls agree, and
where they do not agree the mean is strictly more informative than a majority collapse (it is an
unbiased estimate of the per-call agreement-rate difference, which is the quantity the design's
flip-rate discussion is about). Forking a reference method days before the flagship run, to make a
number less informative, is the wrong trade. **Marked for ratification**, because it reads on D2's
own wording.

Name discipline: the number is reported as "agreement-rate difference, evidence-conditioned". Never
"accuracy".

### 7.3 Sealed companions

Neither enters registry verification in v1. Both publish digest-bound, with their inputs in the
published bundle and their scripts sealed.

**Corrupt-key readout.** Key-fidelity rate (how often a judge follows the broken key against a true
answer) and verdict-flip-on-key-change, over the paired tasks. It stays a companion because the
check **has no correct verdict to score against**: as the design says, a judge that rejects a true
answer is following its instructions and one that accepts it is right about the world and wrong
about its instructions. A registered method that emits a rate with no truth behind it is a category
error, and registering it would be a stronger claim than the check can support.

**Twelve-probe consistency gate.** Sealed companion. Too small for intervals; the design calls it a
gate, not a table row. It publishes as pass or fail per judge with the twelve probe digests listed.

Neither needs new machinery, and neither gets any: the corrupt-key pairing is expressed today by two
tasks per source question with differing reference-answer bytes, and the gate is a second, small
locked task set over the same frozen arms.

### 7.4 The claim-table rule

**Every published number is marked `registry-verified` or `sealed-companion`. Nothing is
unlabeled.** Concretely: the report's claim table carries a provenance column whose value set is
exactly those two strings, and R1 (#2849) renders it. A number with no mark is a defect, not a
style question, and P8's rehearsal asserts that every headline the real report will publish has a
marked synthetic analogue.

---

## 8. Method-operand citizenship and derived export (G1 decision points)

Three findings from the merged method-operand train (DR-2026-08-18-f, PR #2818 and #2820) that this
spec presents as decisions rather than absorbing. The first two are **for the operator at G1**. The
third is decided here, inside D2's delegated scope, and marked for ratification.

**Standing correction, not a decision.** The method-operand DR is **DR-2026-08-18-f**
(`log/decisions/2026-08-18-colophon-method-cli.md`). `DR-2026-08-18-d` is the DeepSWE v1.1 official
suite. The #2842 walkthrough note cites `-d`; every downstream citation uses `-f`.

### 8.1 G1-D-A: the judge bind path (recon C2)

The walkthrough note assumed the judge run path is the file-operand form of the `method` surface. It
is not, on `next`.

Verified: DR-2026-08-18-f decision 6 **explicitly kept** `runtime inspect bind-judge` alongside
`method`. The judge binding schema
(`jinn.network/benchmark-product/inspect-binary-judge-binding-request/1`) is absent from the method
resolver's `FILE_SCHEMA_KIND` table
(`core/src/operations/method-catalog.ts:79-91`), so `colophon method <judge-binding.json>` refuses
today at `method-catalog.ts:167`. The shapes also conflict: the judge binding carries its private
host binding **inside** the file, while decision 3 says a file operand may not carry a `--host`.

| Option | What it costs |
|---|---|
| **(a)** Make the judge a method-operand citizen | A new `FILE_SCHEMA_KIND` row, a new `MethodDocumentKind`, a `bindFile` dispatch case, a reconciliation of host-inside-the-file against decision 3, and therefore **a dated amendment to a DR ratified the previous day**, re-opening a decision it made explicitly. Moves the run path off already-shipped, already-tested surface days before the run |
| **(b) RECOMMENDED** Record that the judge path is the kept `runtime inspect bind-judge` verb | Nothing. It is what DR-2026-08-18-f ratified. Corrects the walkthrough note's phrasing and its DR citation. No amendment |

**Recommendation: (b).** If the operator wants one verb for everything, that is a post-run cleanup
with its own DR amendment, not a run-blocker.

### 8.2 G1-D-B: judge derived export (recon C3)

`export inspect view` does not exist as a CLI verb on `next`. `export --draft <id> --arm <armId>` on
a judge draft refuses `conflict` with "derived export has no suite-named bundle for this method"
(`core/src/operations/method.ts:256`), because the judge draft's `adapterId` is
`inspect-binary-judge`, which matches none of the four routed adapters and is not `"inspect"`. The
orphaned `exportInspectViewBundle` would refuse first anyway, on an adapter gate that requires
exactly `"inspect"`. **The judge path has no derived-export citizenship at all**; it is outside the
router, not inside it and coverage-refused.

| Option | What it costs |
|---|---|
| **(a)** Add a judge branch to the export router | A new bundle shape, a new mode decision, new conformance surface, and a public claim about what the bundle means, authored days before the run |
| **(b)** Wire the orphaned Inspect View export and widen its adapter gate | Adopting dead code, plus a selection-manifest parse that would still refuse a judge selection, plus re-opening the Inspect-eval path DR-2026-08-18-f decision 8 left refused |
| **(c) RECOMMENDED** No derived export by design | P8 asserts the typed refusal at `method.ts:256` as the correct expected outcome. Narrows R1 |

**Verified facts backing (c)** (read before writing this section, so the option is factual and not
hopeful):

- `inspect-binary-judge` declares `nativeArtifactPublication: "explicit-consent"`
  (`core/src/runtime/adapter.ts:215-224`), and `publish` **refuses** a run under that policy unless
  `--include-native-artifacts` is passed (`core/src/operations/publish.ts:91-99`). For a judge run
  the flag is **mandatory**, not optional.
- Under it, `core/src/bundle/materialize.ts:557-561` copies **every** `inspect-log` solve output into
  the published bundle at `native/inspect/<sha256>.eval`, in its own words so the copied bundle
  opens directly in the pinned Inspect reader and Inspect View. `isInspectRuntimeAdapterId` covers
  `inspect-binary-judge` (`runtime/adapter.ts:226-228`).
- The bundle's evidence graph records `solveDeliveries[]` with `cellKey` and the delivery's
  `outputs[]`, so each `.eval` file is attributable to an exact cell, arm, and replicate.
- The judge launcher emits the `inspect-log` output
  (`core/src/runtime/inspect/binary-judge.ts:50,165`).

**Recommendation: (c).** The per-cell logs are already in the published bundle by the mandatory
path. A derived export would be a second, weaker copy of evidence the bundle already carries under
digest.

**R1 consequence, named.** Under (c), R1 (#2849) item 4 loses the per-arm view-bundle download and
instead links per-cell `.eval` files from the published bundle's `native/inspect/` directory,
resolved through the evidence graph's cell-to-output mapping. That is a narrower surface and a
factually accurate one. R1's spec update must say so in the same PR.

### 8.3 G1-D-C: multiple registry-verified readouts over one collected cell set (recon C4)

**Decided here, inside D2's delegated scope. Marked for ratification.**

Verified constraint: `AnalysisSchema.method` is a single string
(`core/src/domain/draft.ts:178-184`); `buildAnalysisPlan` seals `[wilson]` or `[wilson, selected]`
(`compile.ts:82-100`); `report` reads the **last** plan entry
(`core/src/operations/report.ts:162-168`); `ReportRecordSchema.method` is one `MethodRefSchema`
(`records/src/report/schema.ts:55`). One `report` invocation yields exactly one non-wilson method's
results. D2 registers **two** comparisons on top of `binary-instrument@1`, so three registered
readouts are wanted over one collected cell set.

Options weighed:

1. **Multi-method Report record** (`records`: `method` becomes `methods[]`). Rejected. It changes a
   shipped record schema that every existing Report and every cold verifier depends on, forces a
   Report schema version bump, and ripples through claim-consistency, publication-report, the site
   renderer, and the standalone verifier, days before the flagship run.
2. **N report passes over N separately executed runs.** Rejected. It multiplies the design's ~5,300
   call budget and, worse, the comparisons would no longer be over one collected cell set, which is
   the property that makes them comparable at all.
3. **Fold the comparisons into `binary-instrument@1`'s output.** Rejected under §0.4: it changes a
   v1-reference method's output for inputs it already accepts.
4. **RECOMMENDED. Pre-register the additional methods in the sealed analysis plan, and emit one
   Report record per plan entry, over one Matrix.**

Option 4 uses a mechanism that already exists for exactly this purpose: `analysisPlan` is already a
**list**, sealed at lock, whose stated job (`compile.ts:72-75`) is to "honestly pre-register both
analyses at lock". Frozen mechanics:

- `DraftSpecSchema` gains `additionalAnalyses: z.array(AnalysisSchema).min(1).optional()`. Absent
  means today's behavior exactly. No entry is added to `DRAFT_SPEC_DEFAULTS`, no stored draft is
  migrated, and **no existing draft's `specSha256` moves** (the same reasoning the existing
  `analysis`, `budget`, and `anchoring` blocks already document).
- `buildAnalysisPlan` appends each additional entry after the primary, validating each exactly as it
  validates the primary: registered id, matching version, derived parameters, reserved-key refusals.
  Everything is pre-registered before the run, which is the property that matters scientifically.
- `report` emits **one sealed Report record per non-wilson plan entry**, in plan order, each with
  its own single `method` ref and its own `results`. **No records-schema change**: every Report
  stays single-method.
- The bundle carries N Report records; `bundle verify` recomputes each against the same Matrix.
  Cold verification gains "for each Report in the bundle" in place of "the Report".
- The claim table marks each number with the Report that produced it, satisfying §7.4 with no extra
  vocabulary.

**Cost, stated plainly:** this touches `draft.ts`, `compile.ts`, `report.ts`,
`publication-report.ts`, claim-consistency, `publish`, the bundle profile (which must carry a Report
list; P5 verifies whether the current profile pins exactly one Report and bumps the bundle format if
so), and the standalone verifier. It is a genuine P5 sub-packet, sized here so it is not discovered
in week two.

**Fallback if it does not fit the window:** `binary-instrument@1` is the single registered Report
and **both** cross-arm readouts drop to sealed companions. The claim table already supports that and
nothing else changes. This contradicts D2's "register the two headline comparisons", so it is a
fallback the operator invokes, never one the lane takes on its own.

---

## 9. Corrections for the rehearsal (P8, #2847) and the runbook (P9, #2848)

Operational facts the rehearsal and the runbook must be written against. All verified against `next`
@ `4f4ad46f2`.

1. **The DR is DR-2026-08-18-f**, not `-d`.
2. **The judge bind verb is `runtime inspect bind-judge --workspace <dir> --principal <id> --draft <id> --file <binding.json>`**, not `method <judge-doc>` (pending G1-D-A). `colophon method` on a
   judge binding refuses today.
3. **Operand-first argument grammar.** `parseArgs` (`core/src/cli/args.ts:32-71`) consumes
   positionals only until the first `--` token; any positional after a flag refuses
   `invalid-invocation` with "flags come after the verb". Every `method` line must be written
   `colophon method <ref> --workspace ... --principal ... --draft ...`. PR #2863 (open, not on
   `next`) would relax this; write against the strict grammar, which stays valid under both.
4. **There is no `method compute` verb.** Method computation is a side effect of `report`,
   parameterized by the sealed `analysisPlan`.
5. **`k` and the analysis selection are set only via `draft update --file <patch.json>`.** There is
   no `--replicates` flag and no `--method` flag.
6. **`publish --include-native-artifacts` is mandatory for a judge run.** The adapter's
   `nativeArtifactPublication` is `explicit-consent` and `publish` refuses without the flag. Per-cell
   `.eval` logs land at `native/inspect/<sha256>.eval`.
7. **`export` on a judge draft refuses `conflict`.** Expected, not a bug (pending G1-D-B).
8. **`publish` plus `bundle verify` are the claim-of-record path.**
   `bundle verify --bundle <dir> [--json]` is standalone: no workspace, no principal.
9. **`main.ts` line citations in the program document and in the child issues are stale** by roughly
   250 lines after #2820. Every other cited file resolves unchanged.
10. **The rehearsal's arm count is six**, which requires §1.6 to have landed. P8's fixture must
    exercise six arms, mixed parser identities, one evidence-declaring arm, and the dated-snapshot
    profile, exactly as the program describes.

---

## 10. Digest and version inventory

Every digest, schema version, and pinned literal that moves across P1 to P7, so implementers
recompute deliberately and reviewers can check completeness.

| # | Document or constant | Packet | Moves? | Consequence |
|---|---|---|---|---|
| 1 | `BINARY_JUDGMENT_PROFILE_DIGEST` (`documents/binary-judgment-1.0.ts:84`) | P2 | **YES** | `payloadSchema` gains `evidence`; every Task's `profile.digest` moves, therefore every task digest moves; all judge fixtures and the 144-cell expectations regenerate |
| 2 | `BINARY_ACCEPT_REJECT_PARSER_SEALED.digest` | none | no | PC-1 is byte-unchanged |
| 3 | PC-2 to PC-5 semantics digests | P3 | new | four new sealed documents and four new allowlist keys |
| 4 | `BINARY_JUDGMENT_EVALUATION_PARSER_SEALED.digest` (umbrella) | P3 | **YES** | `responseParsers` grows |
| 5 | EvaluationSpec digest (`buildBinaryJudgmentEvaluationSpecification`) | P3, then P7 | **YES, twice** | grader/image/parser digests (P3) and `unscorable` (P7); the `evaluation context/specification` join and every fixture regenerate |
| 6 | `EVALUATION_PARSER_SHA256` and `RESPONSE_PARSER_DIGEST` (`binary-instrument-method.ts:64,66`) | P3 | **YES** | mirrored literals; must move in the same commit as row 4 |
| 7 | `BinaryJudgmentInstrumentSchema` | P1, P2 | schema widens, **bytes stable** | model set, generation union, parser identity set, optional evidence template field; existing sealed instruments keep their digests |
| 8 | `BinaryJudgmentObservationSchema` | P1 | schema widens, **bytes stable** | model set and per-profile `limitations`; existing observations unchanged |
| 9 | `InspectBinaryJudgeSelectionManifestSchema` (`.../inspect-binary-judge-selection/1`) | P1 | schema widens, **URI stays `/1`** | model set, generation union, optional `snapshotProbeSha256`; existing selections byte-identical (§0.4) |
| 10 | `BinaryJudgmentStratumSchema` | P4 | enum to grammar, **bytes stable** | `core` and `stress` seal identically; analysis-context and label-resolution bytes unchanged |
| 11 | `BINARY_INSTRUMENT_PARAMETER_SCHEMA` | P4 (`strata`), P6 (`truthAdmission`) | widens, **method stays `@1`** | previously valid parameter sets still validate and compute identically (§0.4) |
| 12 | `BinaryJudgmentLabelResolutionSchema` | P6 | third member, **existing two byte-identical** | the `CommonShape` refactor (§6.7) changes no serialized bytes |
| 13 | `BinaryJudgmentAdmissionManifestSchema` | P6 | widens, **bytes stable** | enum value plus optional `screeningTableSha256` |
| 14 | New sealed records | P1, P6 | new | `snapshot-serving-probe/v1`, `screening-table/v1`, `screening-reveal-receipt/v1` |
| 15 | `BENCHMARKING_METHOD_IDS` and the registry | P5 | new row | `pairwise-disagreement`; plus a lock-time allowlist entry in `compile.ts` |
| 16 | `DraftSpecSchema.additionalAnalyses` | P5 | optional and additive | **no stored draft's `specSha256` moves** |
| 17 | Bundle profile (Report list) | P5 | **verify and possibly bump** | if the current profile pins exactly one Report, the format version bumps; P5 confirms before implementing |
| 18 | Replacement-ledger `reason` enum | P6 | widens | existing three values byte-unchanged |

### 10.1 Merge ordering (binding on the lane coordinator)

**Three packets regenerate the same judge fixture corpus: P2 (row 1), P3 (rows 4, 5, 6), and P7
(row 5).** They must land in the order **P2, then P3, then P7**, each rebased on its predecessor and
each regenerating the fixtures rather than resolving them by hand. Landing them in parallel produces
three mutually stale fixture sets and a conflict nobody can review.

P1, P4, and P6 move no sealed bytes and may land in any order relative to the chain. Two textual
conflicts to expect and plan around, neither of them a digest conflict:

- P1 and P4 both edit `core/src/run/binary-instrument-profile.ts` (arm cardinality and model
  literals for P1; the hard `["core","stress"]` join for P4).
- P4 and P6 both edit `BINARY_INSTRUMENT_PARAMETER_SCHEMA` (`strata` for P4, `truthAdmission` for
  P6).

Every packet PR body records its digest movements explicitly, before and after, per row of the table
above. `next` has zero required status checks, so each PR body also records local full-chain
verification (portal build order, affected package suites, architecture and catalog guards) per the
program's §5.

---

## 11. Ratification checklist (G1)

**Operator picks, at G1:**

| Ref | Decision | Recommendation |
|---|---|---|
| **G1-D-A** | Judge bind path: method-operand citizen, or the kept `runtime inspect bind-judge` verb (§8.1) | **(b)** the kept verb; no DR amendment |
| **G1-D-B** | Judge derived export: router branch, wire the orphan, or none by design (§8.2) | **(c)** none by design; P8 asserts the typed refusal; R1 links `native/inspect/*.eval` instead of a per-arm view bundle |

**Decided in this spec, marked for ratification:**

| Ref | Decision | Where |
|---|---|---|
| **G1-D-C** | Three registered readouts over one collected cell set, via `additionalAnalyses` plus one Report per plan entry, with the all-companions fallback | §8.3 |
| **R-1** | `paired-delta@1` used unmodified; the paired contrast's unit is the per-item replicate mean, disclosed, rather than forking a v1-reference method | §7.2 |
| **R-2** | The screened branch's ordering receipt is a bank-scoped sibling of the per-item reveal receipt, not a literal reuse of it | §6.6 |

**Ratified as ruled, no further decision needed:** D1 (§6) and D2 (§7).

**New finding requiring no decision but blocking the run if unimplemented:** arm cardinality
(§1.6). The panel is six arms; the compiler refuses anything but four.
