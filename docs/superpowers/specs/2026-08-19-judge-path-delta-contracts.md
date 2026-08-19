# Judge-path delta contracts (LoCoMo judge report, packet P0)

| | |
|---|---|
| **Version** | 1.3 |
| **Date** | 2026-08-19 |
| **Author** | P0 design session (operator + Claude Fable 5); every seam cited path:line against `next` @ `4f4ad46f2` |
| **Revision** | v1.1 folded in an independent review of v1.0. Every paragraph marked "Correction to v1.0" is a v1.0 claim that was checked against code and found wrong: §7.2 (`paired-delta@1` cannot compute over a binary-judgment Matrix today), §1.6 and §3.1 (constants pinned in eight and eleven places, not three and four), §5 (a declaration v1.0 specified is inert), §8.3 (the singular-Report blast radius). **v1.2 folds in the mechanical constant sweep**, which classified 214 sites across four families and again found the counts short: stratum 11 to 23, arm count 8 to 9, admission **5 to 60** (§6.8a is new and P6 is now the largest packet), singular Report 7 to 35. The sweep also changed one recommendation (§8.3 now prefers N bundles over one bundle carrying N Reports) and produced §10.2, the coverage proof. **v1.3 folds in a delta re-review of v1.2**, which verified all 16 earlier findings closed and raised six more. Three were load-bearing: §1.4's v1.2 conditional was **not implementable** (the limitations function cannot see the model, so the profile is now sealed into the analysis parameters as an optional key whose absent case preserves the golden fixtures byte for byte); §6.8a's role mapping does **not** close in either direction, and `materialize.ts:366` is a site invisible to both the grep and the compiler; §8.3's option-5 residual cost omitted the producer side, and `report` turns out to be single-shot exactly as `publish` is. Two proposed citation corrections were checked and declined with evidence. **The whole document is frozen at merge** |
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

Two generation shapes, selected by profile, resolved from the enclosing instrument's
`model.requested`.

**The union cannot live inside `BinaryJudgmentGenerationSchema` itself**, and §0.5 requires saying
where it does live. That schema
(`packages/task-execution/profiles/src/binary-judgment/contracts.ts:126-139`) is consumed in three
places, and the discriminator is a sibling key in each, never a key of the generation block itself:

| Consumer | Sibling model key |
|---|---|
| `BinaryJudgmentInstrumentSchema.model.generation` (`contracts.ts:227-231`) | `model.requested` |
| `BinaryJudgmentSemanticRequestSchema.generation` (`contracts.ts:266-269`) | `model` |
| `InspectBinaryJudgeArmSchema.generation` (`verify/src/profile/binary-judge-manifest.ts:25-30`) | `model` |

**Frozen:** `BinaryJudgmentGenerationSchema` becomes the permissive union of the two shapes (two
strict objects, each internally complete), and the profile agreement is **three parent-level
refinements**, one per consumer above, each asserting that the generation variant matches the
profile its sibling model literal derives. The permissive union alone would admit a reasoning
generation block on a dated snapshot; the three refinements are what close it. Each is one
`superRefine` in a schema that already carries one.

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

**Third site, added at v1.2 from the constant sweep, and it is the one that publishes rather than
refuses.** `binaryInstrumentReportLimitations`
(`verify/src/profile/binary-qualification.ts:15-31`) builds the **Report's** `limitations` array,
and it emits `BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias` **unconditionally**. That
string names `gpt-5.6-luna` in prose and asserts the evidence does not prove invariant weights.

For a `dated-snapshot-sampling` run every clause of it is false, and nothing refuses: `report.ts:249`
writes it into the sealed Report, and `verify/src/profile/claim-consistency.ts:53` **recomputes the
same string and agrees with itself** at cold verification. A false limitation that both the
publisher and the verifier confirm is worse than a missing one, because it survives the check that
was supposed to catch it.

**Correction to v1.2, from delta review: v1.2 specified the conditional and it was not
implementable.** `binaryInstrumentReportLimitations(parameters)` takes exactly one argument, the
sealed binary-instrument method parameters, and **those parameters carry no model**.
`BINARY_INSTRUMENT_PARAMETER_SCHEMA` (`aggregate/src/binary-instrument-method.ts:86-113`) declares
nine properties under `additionalProperties: false` and none of them is a model or a profile. The
cold-verify call site passes `(plan?.parameters ?? {})` with no sealed-store resolver
(`verify/src/profile/claim-consistency.ts:53`), and the RunRecord's arm pinning carries the
**instrument digest**, not the model literal. Neither call site can derive the profile. A
conditional on a value the function cannot see is not a fix.

**Frozen, and the optionality is the whole design:**

1. **The judge-model profile is sealed into the analysis-plan parameters as an OPTIONAL key.**
   `BINARY_INSTRUMENT_PARAMETER_SCHEMA` gains `judgeModelProfile`, an optional string over §1.1's
   two profile ids, derived at lock by `compileBinaryInstrumentProfile` from the arms' shared
   `model.requested` (§1.3's cross-arm rule guarantees there is exactly one). Under §0.4 this is a
   compatible widening: adding an **optional** property to a closed object still validates every
   parameter set valid today, seals identical bytes for them, and computes identically.
2. **Absent means emit the alias limitation, which is today's behavior byte for byte.** This is not
   a default chosen for convenience. It is what keeps §10.2's fixture ruling 1 true: the two frozen
   144-cell golden fixtures seal parameters with no `judgeModelProfile`, so they emit the same three
   strings in the same order and stay green **unmodified**. An implementation that made the key
   required, or that flipped the absent case to "emit nothing", would move those fixtures' bytes and
   destroy the compatibility proof this program depends on. **A naive reading of §1.4 breaks §10.2;
   this clause is why it is written out.**
3. **Present means per-profile.** `mutableModelAlias` is emitted only for `reasoning-2026-08`.
4. **The two reviewer-protocol strings are conditioned in the same edit and need no new key**,
   because `truthAdmission` is already a sealed parameter. `reviewerKeyPerson` and
   `cognitiveBlinding` are claims about a two-reviewer protocol and are emitted today for
   `operator-only` runs that have no reviewers and no visibility receipts at all.

**Consequence for the packet map: P1 now touches `BINARY_INSTRUMENT_PARAMETER_SCHEMA`**, which v1.2
recorded as a P4 and P6 surface. §10 row 11 and §10.1's conflict table both gain P1, which makes
`binary-instrument-method.ts` a four-packet file in the conflict table as well as in the seam
inventories.

The function is defined once in the verify package and re-exported through
`core/src/run/binary-instrument-profile.ts:64-65,87`, so one edit covers the publish path and the
cold-verify path. **Owner: P1** for the model conditional; **P6** adds the screened branch's own
string to the same array (§6.8).

This is §1.4's rule enforced where the claim is actually published. Emitting the alias limitation on
a dated snapshot is the exact decorative disclosure this section refuses by name, and v1.0 and v1.1
both specified the refusal sites and missed the projection site.

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
outright.** The posted design runs a **six-arm** panel; four is pinned as a literal across the lock,
report, publish, and cold-verify paths.

**Correction to v1.0 of this spec, from independent review: the constraint is NOT local.** Eight
verified sites, in the order a six-arm run would hit them:

| # | Site | Fires at | Effect on a six-arm run |
|---|---|---|---|
| 1 | `core/src/run/binary-instrument-profile.ts:324` | lock | refuses: `spec.arms.length !== 4` |
| 2 | `binary-instrument-profile.ts:349` | lock | refuses: `new Set(sortedArmIds).size !== 4` |
| 3 | `binary-instrument-profile.ts:352` | lock | refuses: four distinct instrument digests |
| 4 | `aggregate/src/binary-instrument-method.ts:955-960` | **report** | throws `binary-binding-mismatch`, "requires exactly four matching Run and Matrix arms", **after the spend** |
| 5 | `binary-instrument-method.ts:1488` | report, publish, cold verify | `Object.keys(arms).length !== 4` in the qualification-projection validator; called from `core/src/report/claim.ts:302`, `verify/src/profile/claim.ts:292`, `verify/src/assets.ts:293`, `benchmarking/evidence/src/binary-instrument.ts:196` |
| 6 | `binary-instrument-method.ts:1510` | same four callers | `new Set(instrumentByArm.values()).size !== 4` |
| 7 | `verify/src/schema.ts:186-189` | publish and cold verify | `BundleQualificationSchema.arms` is `z.array(...).length(4)`; written at `bundle/materialize.ts:419`, parsed at `verify.ts:406` |
| 8 | `verify/src/verify.ts:154` and `:1621` | cold verify | `armCount: 4` as a **hard-coded constant**, not a count |
| 9 | `verify/src/schema.ts:227` | publish and cold verify | **added at v1.2 from the constant sweep**: a `superRefine` on the same document requiring `new Set(arms.map(instrumentSha256)).size !== 4`, separate from site 7's array length. Site 7 alone would pass a six-arm bundle straight into this |

**The sweep confirmed the eight sites v1.1 named, added site 9, and confirmed four surfaces that are
already arm-count-agnostic and must not be touched:** the portable judge selection manifest
(`verify/src/profile/binary-judge-manifest.ts:63`, `.min(2)`), the generic Inspect selection manifest
(`verify/src/profile/inspect-manifest.ts:288` and its verbatim mirror at
`core/src/runtime/inspect/manifest.ts:289`), the base `DraftSpec.arms` array
(`core/src/domain/draft.ts:219`, no length constraint), and the entire reduction layer
(`aggregate/src/binary-instrument.ts:305` and `binary-instrument-method.ts:1570`, both derived from
the Matrix's own distinct arm ids). That last confirmation is what makes rule 1 below true rather
than hopeful: the floor of two already exists in the sealed manifest, so removing the literal `4`
invents no new rule.

Site 8 is the dangerous one. It does not refuse a six-arm run: it would **publish a false arm
count**. A bundle asserting four arms over a six-arm panel is exactly the class of fabricated
disclosure this program exists to make impossible.

**Frozen:**

1. `validateRuntimeAndArms` requires `spec.arms.length === selection.arms.length`. The sealed
   selection manifest's own schema already supplies the floor of two and the sorted, unique,
   distinct-instrument constraints, so the literal `4` disappears from sites 1 to 3 without
   inventing a new rule.
2. Sites 4, 5, 6 require the Run and Matrix arm sets to be equal, sorted, unique, of distinct
   instruments, and of size two or more. Never a literal count.
3. Sites 7 and 9: `arms` becomes `z.array(...).min(2)` with the sorted-unique refinement, and the
   distinct-instrument `superRefine` counts against `arms.length` rather than against `4`.
   **`BUNDLE_QUALIFICATION_FORMAT` stays at its current version** under §0.4: every four-arm bundle
   ever written still validates, byte-identically. P8 asserts that an existing four-arm bundle
   cold-verifies unchanged.
4. **Site 8's `armCount` becomes derived**, not declared: `armCount: qualification.arms.length`,
   with the type widened from the literal `4` to `number`. A count that is a constant is not a
   count.

**Owner: P1**, in the same PR as the model-literal widening, which already edits sites 1 to 3 and
site 4's file. **P1's acceptance gains:** a six-arm synthetic draft compiles, locks, reports,
publishes, and cold-verifies with `armCount: 6`; and the existing four-arm qualification lifecycle
test is green unmodified with `armCount: 4`.

### 1.7 P1 seam inventory

| Seam | Change |
|---|---|
| `profiles/src/binary-judgment/contracts.ts:126-139` | generation union |
| `contracts.ts:229` | `model.requested` literal to closed set |
| `contracts.ts:266` | `BinaryJudgmentSemanticRequestSchema.model` likewise |
| `contracts.ts:328-329,343` | observation model literals and per-profile `limitations` |
| `verify/src/profile/binary-judge-manifest.ts` | arm `model` set, generation union, optional `snapshotProbeSha256` |
| `core/src/runtime/inspect/binary-judge.ts:141-142,233-236,312` | requirement model check, arm/instrument agreement, enforced inventory |
| `core/src/run/binary-instrument-profile.ts:324,349,352,370-386` | arm cardinality (§1.6 sites 1 to 3), arm pinning model, instrument model agreement |
| `core/src/operations/inspect-binary-judge.ts` | probe binding, probe freshness refusal |
| `aggregate/src/binary-instrument-method.ts:46,913,1045,1107-1108,1140-1144` | model set and per-profile limitations |
| `aggregate/src/binary-instrument-method.ts:955-960,1488,1510` | arm cardinality (§1.6 sites 4 to 6) |
| `verify/src/schema.ts:186-189,227` | arm cardinality (§1.6 sites 7 and 9), bundle qualification document |
| `verify/src/verify.ts:154,1621` | arm cardinality (§1.6 site 8), `armCount` becomes derived |
| **`verify/src/profile/binary-qualification.ts:15-31`** | **per-profile Report `limitations` (§1.4)**; re-exported through `core/src/run/binary-instrument-profile.ts:64-65,87`, consumed at `report.ts:249` and `verify/src/profile/claim-consistency.ts:53` |
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

An instrument that does not name `evidence` cannot render it, which is the leak boundary stated as
code rather than as policy.

**Render-time behavior must be named, because rendering happens before lock.**
`renderBinaryJudgmentMessages` (`contracts.ts:286-291`) concatenates `payload[segment.field]`
directly. With `evidence` optional on the payload, a declaring instrument over an evidence-free item
would interpolate the literal string `undefined` into the prompt. §2.3 refuses that combination at
lock, but **`preview` runs before lock**, so the lock refusal is not the only path through this
code.

**Frozen:** `renderBinaryJudgmentMessages` refuses when any segment names a field absent from the
payload, through the module's existing document-assertion path, before any concatenation. This is
not a second enforcement point for §2.3's rule (§0.5): §2.3's rule is about the arm-to-bank
binding and is enforced once, at lock. This is a total-function guarantee on a renderer whose
inputs became optional, and it is what makes `preview` refuse rather than silently rehearse a
prompt containing the word `undefined`.

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
already is, exactly and transitively, because evidence rides inside the payload. The join table is
`requireJoinedInputs` (`evaluator-adapters/src/binary-judgment/adapter.ts:478-528`): 21 equalities
plus one EvaluationSpec analysis-descriptor check. Exactly these cover evidence:

- `itemSha256 = recordDigest(canonicalJsonBytes(payload))` covers it, and feeds the
  `analysis context/item` and `label resolution/item` equalities.
- The sealed Task bytes cover it, feeding `evaluation context/Task` and `observation/Task`.
- For a **declaring** arm only, `binaryJudgmentSemanticRequestDigest` covers the rendered bytes,
  feeding `semantic request/observation`.

**Correction to v1.0:** `analysis context/item id` does **not** cover evidence. It compares
`payload.itemId` alone (`adapter.ts:518`), so it is unaffected by an evidence mutation. The
mutation test in the next paragraph must therefore assert against `analysis context/item`, not
against the item-id equality.

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
ordering P2 and P3 must observe, since both regenerate the same fixture corpus.

### 2.7 P2 seam inventory

| Seam | Change |
|---|---|
| `profiles/src/binary-judgment/contracts.ts:92-98` | optional `evidence` on the payload |
| `contracts.ts:101-105` | required and optional template-field lists |
| `contracts.ts:245-253` | required-interpolation check unchanged, restated over the required list |
| `contracts.ts:286-291` | render-time absent-field refusal (§2.2) |
| `profiles/src/documents/binary-judgment-1.0.ts:25-55` | `payloadSchema` gains `evidence`; **profile digest moves** |
| `core/src/intake/binary-item-bank.ts` | the two import refusals (§2.4) |
| `core/src/runtime/inspect/binary-judge.ts:171,238` | launcher message construction, named by the program's P2 seam list and absent from v1.0 of this spec |
| `core/src/run/binary-instrument-profile.ts` | the lock-time arm-to-bank refusal (§2.3) |
| **`verify/src/admission/contracts.ts:31-40`** | **second, mirrored `BinaryJudgmentPayloadSchema`** |

The last row is a correction from review and is not optional. The verify package carries its **own**
strict copy of the payload schema, and `HumanReviewPacketSchema.item` (`:67`) is typed by it. Left
unchanged, it **refuses every evidence-carrying item on the human-review path**, which is the path
P6 and the two-human branch both run through. P2 must widen both copies in the same PR, and P2's
acceptance gains a fixture proving an evidence-carrying item survives packet creation.

---

## 3. Declared stratum vocabulary (packet P4, issue #2845)

### 3.1 The hard enum becomes a grammar plus a derived vocabulary

**Correction to v1.0, from independent review: v1.0 named four sites; there are eleven.** The
`["core","stress"]` pair is mirrored across three packages, including a **second copy of the stratum
schema** in `verify` and a hard two-element tuple in the **published bundle document**.

| # | Site | Layer | Effect on a four-category bank |
|---|---|---|---|
| 1 | `profiles/src/binary-judgment/contracts.ts:360` | analysis context | refuses at seal |
| 2 | `profiles/src/binary-judgment/label-resolution.ts:26` (imports #1) | label resolution | refuses at seal |
| 3 | `aggregate/src/binary-instrument.ts:157-158` | method compute | `fail("unsupported-vocabulary")` |
| 4 | `aggregate/src/binary-instrument-method.ts:104` | parameter JSON schema | `prefixItems [core, stress]`, min 2, max 2 |
| 5 | `aggregate/src/binary-instrument-method.ts:121` | `BinaryInstrumentParameters` TS type | `readonly strata: readonly ["core","stress"]` |
| 6 | `aggregate/src/binary-instrument-method.ts:166` | imperative check, separate from #4 | refuses (v1.1 cited `:167`; the sweep gives `:166`) |
| 7 | `aggregate/src/binary-instrument-method.ts:1500` | `expectedSlices` fallback | `byStratum` slice vocabulary pinned to the pair |
| 8 | `core/src/run/binary-instrument-profile.ts:299-300` | lock | `sameJson(verified.strata, ["core","stress"])` |
| 9 | **`verify/src/admission/contracts.ts:30`** | **second `BinaryJudgmentStratumSchema`** | every §6.4 replacement-ledger entry refuses here |
| 10 | **`verify/src/schema.ts:185`** | **published bundle document** | `strata: z.tuple([literal("core"), literal("stress")])` |
| 11 | `verify/src/admission/verification.ts:52,61,115,125,136` and `verify/src/verify.ts:153` | verify TS types | `"core" \| "stress"` |

Sites 9 and 10 are the ones v1.0 missed that matter most: site 9 refuses the replacement ledger this
run's admission depends on, and site 10 is **P8's acceptance path**, so a four-category bundle
cannot be published or cold-verified until it moves.

**Twelve more sites, added at v1.2 from the constant sweep.** Eleven was still short. The sweep
found the pair pinned in **five independently maintained copies across four packages**, not two, and
found six further imperative checks inside `binary-instrument-method.ts` alone.

| # | Site | Layer | Effect on a four-category bank |
|---|---|---|---|
| 12 | **`core/src/run/binary-instrument-profile.ts:315`** | lock | **The worst site in the family.** Three lines after site 8's gate passes, `deriveAdmissionProfile` returns `strata: ["core","stress"]` as a literal, **discarding the `verified.strata` it just checked** |
| 13 | `aggregate/src/binary-instrument-method.ts:396` | method compute | `validateLabelResolution`'s `expected` parameter type |
| 14 | `aggregate/src/binary-instrument-method.ts:443` | method compute | `validateLabelResolution` wire-format check |
| 15 | `aggregate/src/binary-instrument-method.ts:779` | method compute | analysis-context wire validator |
| 16 | `aggregate/src/binary-instrument-method.ts:1388` | report and publish | closed-shape validator for the public F6 projection |
| 17 | **`benchmarking/evidence/src/binary-instrument.ts:23`** | evidence reduction | a **fourth package** with its own copy, inside `EvidenceBinaryInstrumentContext`, used at `:109` to build the context handed to aggregate |
| 18 | `core/src/operations/import-item-bank.ts:53` and `core/src/intake/binary-item-bank.ts:130` | import | the imported-bank summary and converted-bank types |
| 19 | `core/src/operations/human-review.ts:135` | admission | `HumanAdmissionCandidateInput.stratum`, hand-written beside a zod field at `:179` that correctly imports site 1 and would widen on its own |
| 20 | **`evaluator-adapters/src/binary-judgment/adapter.ts:723`** | delivery registration | refuses any delivered outcome whose stratum is outside the pair. **It sits in the same compound condition as the two-branch `truthAdmission` check at `:715-716`**, so P4 and P6 edit one boolean expression |
| 21 | `verify/src/assets.ts:372` and `:637` | published HTML and Markdown | the literal caption `Core and stress buckets` rendered above the `byStratum` block. Not a refusal: a **published false label** over four categories |

**Site 12 is the argument for this whole section, and it is stronger than the design case v1.0
made.** The same `return` statement derives `candidateClasses: verified.classes` dynamically and
hardcodes `strata: ["core","stress"]` on the next line. The sweep found the identical asymmetry
three more times: at `binary-instrument-method.ts:443` and `:779` the adjacent `candidateClass`
checks validate against a caller-supplied vocabulary while the `stratum` checks compare to literals,
and at `:1500` `expectedSlices` resolves `byCandidateClass` from the dynamic list and pins
`byStratum` to the pair.

So §3.1 is not introducing a new pattern. **The dynamic pattern already exists, in the same
functions, one line away, for the sibling axis.** Every site in both tables is the same edit already
written next to it for `candidateClass`. That is also why the widening is low-risk: it has a
worked example in every file it touches.

Sites 20 and 21 are new *kinds*. Site 20 is the first stratum pin outside the analysis and admission
stack, on the delivery-registration path, and it is a P4/P6 collision inside one expression. Site 21
is a **projects-output** pin: like §1.6 site 8 and §1.4's limitations projection, it does not refuse,
it publishes something false.

**The sweep confirmed four consume-only sites that need no edit** because they import site 1 and
widen automatically: `profiles/src/binary-judgment/contracts.ts:373`,
`profiles/src/binary-judgment/label-resolution.ts:26`, `verify/src/admission/contracts.ts:138`, and
`core/src/operations/human-review.ts:179`. Row 2 of the first table describes `label-resolution.ts:26`
as refusing at seal; that is true of its behavior and misleading about its cost. It needs no edit.

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
5. **Every site in both tables above moves together**, in one PR. Sites 4, 5, and 6 are three
   separate expressions of one rule and must not be widened partially, and site 12 is the proof
   that a partial widening passes its own gate and then discards the result. Site 7's
   `expectedSlices` becomes the sealed vocabulary, so the `byStratum` slice set is checked against
   what the run declared rather than against a constant. Site 21's captions become a rendering of
   the sealed vocabulary rather than English prose about two buckets.
6. **The bundle document (site 10).** `BundleQualificationSchema.strata` becomes a sorted-unique
   array of grammar-conforming names, `minItems: 1`. **`BUNDLE_QUALIFICATION_FORMAT` stays at its
   current version** under §0.4: every `["core","stress"]` bundle ever written still validates,
   byte-identically. This is the same ruling as §1.6 site 7, and for the same reason; P8 asserts
   both with one unchanged four-arm two-stratum bundle.

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

### 5.0 What is already load-bearing, and what a declaration would not be

**Correction to v1.0, from independent review.** v1.0 specified a three-class `unscorable`
declaration and asserted a publish-time refusal, without naming the code that reads either. Both
claims were checked and both were wrong in the same direction: the declaration is **inert**, and the
refusal it was supposed to power **already exists by another mechanism**.

**The declaration is inert.** A spec's `unscorable` list is read in exactly one place:
`profiles/src/evaluation-spec/verdict-consistency.ts:28-46`, and only to bound the
`recorded-inconclusive` vocabulary a delivery may cite (`unscorable.ts:19-20`). Nothing anywhere
reads a `retryable-infrastructure` entry off a spec's list; a repository-wide search finds only
declarations (`core/src/runtime/inspect/artifacts.ts:252`,
`task-supply/chain-scenarios/src/seal-pair.ts:150-152`) and the composite propagation type
(`composite.ts:41-57`), which types a sub-spec **outcome**, not a spec list.

So declaring three `retryable-infrastructure` classes would cost a second EvaluationSpec digest
move plus a full fixture regeneration and change no behavior at all. That is decorative disclosure,
which §1.4 refuses by name when it is a limitation string. The rule does not get weaker because
this time it is a class list.

**The behavior P7's acceptance actually asks for exists today**, in three mechanisms P0 need only
pin as run configuration:

| P7 acceptance | Existing mechanism | P0 action |
|---|---|---|
| retry once, then stop | `assurance.overrides.maxInfrastructureRetries` (`core/src/domain/draft.ts:63-64`), driven at `core/src/run/drive.ts:385` and journaled at `journal.ts:695` | pin to `1` in the run's draft (data, not code) |
| accounted unscorable cell, never a scored REJECT | journal `evaluation-retryable-failure.category` and the `could-not-grade` terminal with `failureCategory`; `binary-instrument@1` excludes the whole item-arm group | pin `completenessFloor` (below) and assert |
| Matrix refuses full-claim closure unless disclosed | Matrix `completeness: {expected, judged, floor, runOutcome}` (`records/src/matrix/schema.ts:145`) is **schema-validated**: with `floor: "1"`, one unjudged cell forces `runOutcome: "partial"`, sealed in the Matrix and carried verbatim into the Claim (`core/src/report/claim.ts:677-678`) | pin `policy.completenessFloor` to `"1"` (already the default, `draft.ts:239`) and assert |

**Frozen: P7 declares no `unscorable` classes.** The three names below stay as the run's **reporting
vocabulary**, sourced from the journal category that is already recorded per cell, and appear in the
runbook and the report, not in a sealed spec field nothing reads. This drops the second EvaluationSpec
digest move and the fixture regeneration that came with it, which also removes P7 from §10.1's merge
chain entirely.

**Consequence for the coordinator: P7 is no longer `fix`-shaped.** Its content becomes pinning two
existing draft-policy values and proving the three behaviors with tests, which is `test`-shaped. This
is a real re-scope, not a trim, so it is decision point **G1-D-E** in §11 with the alternative
stated: keep the declaration as sealed-but-unread disclosure and accept the digest churn.

### 5.1 The class vocabulary

Three names, code-unit sorted, used in the report, the runbook, and the accounting prose:
`broker-error`, `provider-unavailable`, `transport-timeout`.

`EvaluationSpec.unscorable` for binary judgment **stays `[]`**
(`evaluator-adapters/src/binary-judgment/adapter.ts:158`), byte-unchanged, per §5.0.

**Why not `recorded-inconclusive`, in any case.** Even as a declaration it would be the wrong
disposition: the classes mean "no judgment was obtained", not "a judgment was obtained and is
inconclusive". And it is unreachable regardless. Finding C of `evaluator-adapters/README.md` records
that the harness runtime never forwards a declared unscorable class to the verdict-consistency
check, so an adapter can deliver `inconclusive` only when the spec's `verdictRule` recomputes to
inconclusive under a declared `inconclusiveWhen` predicate.
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

**Frozen, and it needs no new check.** The run pins `policy.completenessFloor` to `"1"` (already the
default, `core/src/domain/draft.ts:239`, sealed into the Run at `compile.ts:223`). The Matrix's
`completeness` block is `{expected, judged, floor, runOutcome}` and the records schema **validates
`runOutcome` against the floor** (`records/src/matrix/schema.ts:145`). One ungradeable cell makes
`judged < expected`, which forces `runOutcome: "partial"` in the sealed Matrix. The Claim copies
`completeness` and `attrition` verbatim from the Matrix (`core/src/report/claim.ts:677-678`), so the
partial outcome is published and cold-verifiable without anyone opting into disclosing it.

v1.0 asserted that "publish's claim-consistency check refuses" here. **That check does not exist**,
and it does not need to: a sealed Matrix that says `partial` is a stronger artifact than a refusal,
because it survives into the bundle where a reader can see it. P7 asserts the chain (unscorable cell
to `judged < expected` to `runOutcome: "partial"` to the published Claim) rather than adding a gate.

The run-stop itself stays an **operator** action: the design says a second failure stops the run
until the design is updated in public, and engineering does not auto-halt a daemon on a statistical
policy. What engineering guarantees is that the stop is **visible in artifacts**, not only in
operational discipline. That is P7 acceptance 3, and §5.4 is its mechanism.

### 5.5 Digests that move

**None.** This is the change from v1.0: with `unscorable` staying `[]` per §5.0, the EvaluationSpec
digest does not move for P7, no fixtures regenerate, and P7 leaves §10.1's merge chain.

### 5.6 P7 seam inventory

| Seam | Change |
|---|---|
| the run's draft, via `draft update --file` | `assurance.overrides.maxInfrastructureRetries: 1`; `policy.completenessFloor: "1"` (data, not code) |
| `evaluator-adapters/src/binary-judgment/adapter.ts:158` | **unchanged**, `unscorable` stays `[]` |
| `core/src/run/drive.ts:385`, `core/src/run/journal.ts:695` | asserted, not changed: first failure retries, second terminalizes `could-not-grade` with `failureCategory` |
| `records/src/matrix/schema.ts:145` | asserted, not changed: `runOutcome` follows the floor |
| `core/src/report/claim.ts:677-678` | asserted, not changed: completeness and attrition reach the Claim verbatim |
| `aggregate/src/registry.ts:280-298` | asserted, not changed: the whole item-arm group is excluded with exact cells |

**P7 verification obligation:** confirm the per-cell `failureCategory` survives into the published
bundle. If it does not, that gap is the packet's one genuine code change, and it is a bundle-evidence
change rather than a spec-declaration change.

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

**This is a departure from the literal ruling and is flagged as such.** D1 reads "admitted means
screening agreed or hand-confirmed", whose literal disjunction would admit a screen-agreed row the
operator hand-excluded. R-1 and R-2 are marked for ratification over narrower deviations than this
one, so it is carried into §11 as **R-3** rather than absorbed.

`screeningVerdict === "indeterminate"` never agrees, so such a row is admitted only by hand
confirmation.

Every non-admitted row is excluded and must appear in the existing replacement ledger
(`verify/src/admission/contracts.ts`, `HumanReviewReplacementLedgerEntrySchema`) with a **same-class,
same-stratum** replacement, and **the ledger must close**. The ledger's `reason` enum gains the
values this branch produces, in **both** copies (`verify/src/admission/contracts.ts` and the second
copy at `verify/src/schema.ts:199`); the existing three values are byte-unchanged in both.

**Terminology.** D1 says "same-class, same-**category**". This spec says same-**stratum** because
§3.3 makes stratum the axis that carries category for this run: the bank declares the four
source-question categories as its stratum vocabulary. Same-stratum is therefore the exact
translation of the ruling, not a weakening of it, and the ledger entry already carries `stratum`
(`HumanReviewReplacementLedgerEntrySchema`) so no field is added.

### 6.5 What the verifier recomputes

Five recomputations, all from the sealed table plus the frozen bank, and nothing else.

**(0) Coverage.** The table's `rows` must cover the frozen bank's candidate pool **exactly**: one
row per pool item, no row naming an item outside the pool, `itemSha256` sorted and unique.
`sampleSize` must satisfy `1 <= sampleSize <= rows.length`. Without this the other four
recomputations are computed over a set the operator chose after the fact, which would make the
agreement rate a number about a sample of a sample. This was absent from v1.0 and is the first
check to run, because every check below reads `rows`.

**(1) Sample membership.** Recomputed by a procedure specified here and implemented in
`@colophon-claims/verify`, **not** by executing the sealed sampling script. The script's digest
records what the operator actually ran; the verifier's independent recomputation is what makes the
sample checkable. A verifier that must execute an arbitrary sealed script to check a sample is not
a verifier.

> **Procedure `screening-sample/1`.** Let `rowsDigest` be the SHA-256 of the canonical-JSON bytes of
> the table's sorted-unique `rows` array. Given `sampleSeed` and `sampleSize`: for each row compute
> `stream := HMAC-SHA256(key = utf8(sampleSeed) || rowsDigest, message = utf8(itemSha256))`; sort
> rows ascending by `stream` compared as 32 unsigned bytes, ties broken by `itemSha256` in code-unit
> order; the sample is the first `sampleSize` rows.

Deterministic, seedable, no PRNG state to carry, and reimplementable from this paragraph in any
language. If the recomputation and the sealed script disagree, **the recomputation wins and
admission refuses.**

**Why the key binds the row set, added at v1.3 from delta review.** `sampleSeed` is authored by the
operator, and the rows it draws from are sealed in the same record the operator also authors.
Nothing in `screening-sample/1` as v1.2 wrote it stops an operator from grinding candidate seeds
against the known rows until the draw happens to miss the rows they would rather not hand-check.
The procedure made the sample **checkable**, which is not the same as making it **unbiased**, and
v1.2 conflated those.

Binding `rowsDigest` into the HMAC key does not remove the operator's ability to grind, because the
rows are still known when the seed is chosen. What it removes is the ability to grind **once and
reuse**: every edit to the row set, including the replacements §6.4 requires, changes `rowsDigest`
and therefore the entire draw. A seed ground against one row set is worthless against the row set
that actually seals. Combined with §6.5(0)'s exact-coverage check, which fixes the row set to the
frozen bank's pool before any of this runs, the remaining attack is a single grind against the final
pool, which the operator would then have to re-run after every replacement.

**The honest limit, stated rather than papered over:** this narrows the hole, it does not close it.
Closing it needs a seed commitment sealed **before** the rows are known, which the §6.6 ordering
receipt could carry. That is a larger change to a D1-ratified shape and it is not taken here. What
is taken is the version that costs one line and cannot be got wrong.

This reads on **R-4**'s own argument and strengthens it: R-4 rules that the verifier's independent
recomputation beats the operator's sealed script precisely because an operator-supplied procedure
over operator-supplied inputs verifies nothing. A seed the operator can grind against the rows is
the same defect one level down.

**This is a departure from the literal ruling and is flagged as such.** D1 says the verifier
recomputes "sample membership from seed plus script over the frozen bank", which reads as executing
the sealed script. This spec replaces execution with an independent, specified procedure and rules
the recomputation authoritative. The reason is that a verifier which must run an operator-supplied
script to check an operator-supplied sample is not verifying anything. Carried into §11 as **R-4**
rather than absorbed.

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

Numbered (0) to (4); five checks.

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

**Correction to v1.0, from independent review: `truthAdmission` is pinned in two places, and the
second one also encodes the publication-grade rule.**

- `BinaryJudgmentAdmissionManifestSchema.truthAdmission`
  (`verify/src/admission/contracts.ts:167-177`) gains `"screened-operator-sampled"`.
- **`verify/src/schema.ts:183`** carries a **second** `truthAdmission` enum, on the published bundle
  qualification document. It gains the value too, and `BUNDLE_QUALIFICATION_FORMAT` stays at its
  current version under §0.4 (every existing bundle still validates byte-identically), the same
  ruling as §1.6 site 7 and §3.1 site 10.
- **`verify/src/schema.ts:275-276`** is a `superRefine` coupling `truthAdmission` to
  `publicationGrade` with exactly two branches: `two-human-unanimous` must be publication-grade,
  `operator-only` must not be. A third value falls through **unconstrained**, which would let a
  screened bundle claim either grade. **This is where §6.8's publication-grade ruling is enforced**,
  and it must gain an explicit third branch: `screened-operator-sampled` **must** be
  publication-grade. Without it the whole point of D1 (not shipping the flagship bundle as
  `operator-only-not-publication-grade`) rests on nothing.
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

### 6.8a What the constant sweep added, and why P6 is the largest packet

**Correction to v1.1, from the constant sweep: `truthAdmission` and its coupled vocabularies are
pinned across sixty-one production sites in sixteen files, not the five §6.8 named.** The two corrections before
this one were about *count*. This one is about *kind*: four of the sites do not refuse a screened
admission, they accept it and do the wrong thing, and three of §6.8's own frozen rulings are
unreachable without sites §6.8 never named.

**Group A: the two rulings §6.8 made that its own named sites cannot deliver.**

| Site | What it does | Why §6.8 needs it |
|---|---|---|
| `verify/src/admission/verification.ts:640` | `publicationGrade: manifest.truthAdmission === "two-human-unanimous"` | **Derives** the boolean by equality. A screened manifest yields `false` |
| `core/src/operations/human-review.ts:744` | the same equality, at construction rather than verification | Same, at the other end |
| `verify/src/profile/binary-qualification.ts:26` | adds an admission limitation **only** when the value is exactly `operator-only` | A screened run publishes **zero** admission-mode disclosure. The `screened-not-independently-labeled` string above has no emitter |

The first two are the sharp one. §6.8 rules that the screened branch is publication-grade and pins
the enforcement at `schema.ts:275-276`. But `publicationGrade` is not asserted anywhere, it is
**derived** at these two sites, and both derive `false` for a screened manifest. So §6.8's third
`superRefine` branch, added exactly as specified, would refuse **every screened bundle**: the
branch requires `true` and the derivation supplies `false`. The rule and its input contradict each
other. **Frozen:** both derivations become `truthAdmission !== "operator-only"`, and the
`superRefine` branch stays as §6.8 specifies. One expression, two files, and the ruling becomes
reachable.

The third is §1.4's finding in the other direction, and it is the same function. The screened
branch's named limitation is a string in a document until
`binaryInstrumentReportLimitations` emits it, and today that function's only admission-conditional
arm tests for `operator-only`.

**Group B: the four sites with no compiler safety net.** These accept `screened-operator-sampled`
and route it into the two-human path at runtime.

| Site | Failure mode |
|---|---|
| `core/src/operations/human-review.ts:491` | `if (parsed.truthAdmission === "operator-only") { ... }` with an **implicit else** that validates the candidate shape as two-human |
| `core/src/operations/human-review.ts:642` | the same pattern in the resolution-construction half of the same function; the else builds a `two-human-unanimous` resolution input unconditionally |
| `verify/src/admission/verification.ts:407-419` | role to evidence-role ternary whose catch-all is `: "operator-assertion"`; a new attestor role is silently mis-mapped |
| `core/src/bundle/materialize.ts:371-375` | the bug-risk twin of the previous row, on the bundle-construction side, catch-all `: "operator-truth-attestor"` |

A widened enum plus an untouched `===` chain is worse than an unwidened enum, because the unwidened
enum refuses and the widened one proceeds. **Frozen: every one of these four becomes an exhaustive
switch over the three-member union with a `never`-typed default**, so a fourth admission mode in
future is a compile error rather than a silent reroute. This is the one place this spec asks for a
refactor rather than a widening, and the reason is that the current shape has already demonstrated
it fails open.

**Group B-bis: the attestor-role mapping is not closed by Group B's fix, in either direction.**
Added at v1.3 from delta review, which is right that an exhaustive switch is necessary and
insufficient here.

The screened branch's ordering receipt (§6.6) reuses `attestorRole: "truth-reveal-attestor"`, which
§6.8a above treats as the cheap choice. It is cheap only if the role determines the evidence role,
and at two sites it does, wrongly:

- **Output direction, `verify/src/admission/verification.ts:415-419`.** The ternary maps
  `truth-reveal-attestor` to the evidence role `review-reveal-receipt` **unconditionally**. An
  exhaustive switch over `AdmissionAuthorityRole` is well-typed and still produces this: the union
  has three members and the screened receipt is signed under one of them. The screening receipt then
  resolves under a role that is a member of `humanEvidenceRoles`, which is exactly what the third
  `superRefine` branch frozen above **refuses**. Group C's fix and Group B's fix defeat each other.
- **Input direction, `core/src/bundle/materialize.ts:366`.** This is the discriminator that decides
  whether a reachable record contributes an authority binding at all, and it is a hand-written
  three-term or-chain over string literals followed by `if (role === undefined) continue;`. A
  `screening-reveal-receipt` matches none of the three, is skipped, contributes no binding,
  `admissionAuthorityBindings` comes out empty, `authorities` is written empty, and
  `schema.ts:125-131` refuses. **§6.8a's frozen third authority set `["truth-reveal-attestor"]` is
  unreachable**, because nothing ever puts the screened receipt into that set. v1.2 named
  `:371-375`, which is the *output* ternary two lines later; it is the wrong site.

**Frozen:** both mappers take the **evidence role** (or the admission mode) as an input rather than
deriving it from the attestor role alone. Concretely, `materialize.ts:366`'s discriminator gains
`screening-reveal-receipt` and `screening-table` and maps them to `truth-reveal-attestor`, and
`verification.ts:415-419` receives the evidence role from its caller instead of reconstructing it.
P6 asserts the round trip with a fixture: a screened bundle materializes a non-empty `authorities`,
parses under the third authority set, and satisfies the third evidence-role branch.

**`materialize.ts:366` is a site with no tripwire at all, and it is the counterexample §10.2 must
carry.** Adding a role to the vocabulary does not make this or-chain fail to compile, so the
compiler does not catch it; and the line contains none of F3's search tokens (`operator-assertion`
is not `operator-only`), so the grep does not catch it either. §10.2's tripwire claim is amended
accordingly rather than left standing.

**Group C: the screened branch's evidence has nowhere to live.** §6.3 and §6.6 freeze two new
sealed records. The bundle's admission closure does not have roles for them.

- `verify/src/schema.ts:16` (`BUNDLE_V4_EVIDENCE_ROLES`) and `:49` (the admission-only subset) are
  the role vocabulary, **duplicated verbatim** at `verify/src/admission/verification.ts:75`
  (`BINARY_JUDGMENT_ADMISSION_RECORD_ROLES`, same entries, same order, hand-kept in sync).
  **Frozen:** two new roles, `screening-table` and `screening-reveal-receipt`, added to all three
  lists in one edit.
- `verify/src/schema.ts:259-270` is a `superRefine` requiring the evidence set to be **exactly** the
  six human-review roles **or** exactly the operator assertion, with an `else if` that catches
  everything non-two-human. A screened bundle carries neither. **Frozen:** a third branch requiring
  exactly the two screening roles and no human-review evidence and no operator assertion.
- `verify/src/schema.ts:125-131` requires the trust document's authority roles to be **exactly**
  `["roster-attestor","truth-reveal-attestor"]` or exactly `["operator-truth-attestor"]`. §6.6's
  receipt presents `truth-reveal-attestor` alone, which is neither. **Frozen:** a third legal
  authority set, `["truth-reveal-attestor"]`.
- `verify/src/schema.ts:104` and its hand-copy `verification.ts:83-86` (`AdmissionAuthorityRole`)
  keep the existing three roles unchanged. §6.6 deliberately reuses `truth-reveal-attestor` rather
  than minting a role, so this is one of the few admission sites that needs no edit.

**One disagreement with the sweep, recorded with its reason.** The sweep flags
`verify/src/schema.ts:119` (`reviewers.length === 1` refuses) as needing to be relaxed, reading the
screened branch as a single-reviewer admission. **It is not, and the line needs no change.** D1's
simplified shape is bank-scoped: one signed table, no per-item reviewer records, no roster (§6.9
records the roster as deliberately dropped). A screened admission therefore registers **zero**
reviewers, which `:119` already permits ("empty or a registry of at least two"). Relaxing it would
legalize a one-reviewer two-human admission, which is the shape the line exists to refuse. Left
alone.

**Consequence for the coordinator: P6 is the largest packet in the program**, and v1.0 and v1.1 both
sized it as a schema widening. It is a widening plus four exhaustive-switch refactors plus two new
evidence roles in three synchronized lists plus two publication-grade derivations. §10.2 carries the
full site inventory. The G2 fallback in §6's preamble (run `operator-only` with prose disclosure,
land the branch post-run) is unchanged and is now better justified than when it was written.

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
requiredInputs:      ["matrix.cells", "referenced-result-evaluations", "exact-run-bytes",
                      "exact-task-bytes", "exact-evaluation-specification-bytes",
                      "exact-analysis-context-bytes", "exact-label-resolution-bytes",
                      "exact-instrument-bytes"]
parameterSchema:     required ["verdictRule","k","reduction","measurementProfile",
                               "candidateClasses","strata","parserInvalidPolicy","intervalAlpha"]
                     (all derived from the draft and sealed evidence, never caller-supplied,
                      exactly as binary-instrument@1 derives its own)
outputShape:         "per-arm-pair item-majority disagreement counts, rate, Wilson interval,
                      per-candidate-class and per-stratum slices, and exclusions"
exclusionRule:       "exact k-cell Task/arm groups only; an item excluded for either arm of a pair
                      is excluded from that pair, with exact cells"
clusteringRule:      "Task digest plus arm pair; strict majority over registered scientific replicates"
referenceSet:        "registered-non-reference"
deterministic:       true
computeAvailability: "available"
```

**Three corrections to v1.0, from independent review:**

- **`requiredInputs` is the same eight entries `binary-instrument@1` declares**
  (`aggregate/src/registry.ts:281-290`), not the three v1.0 listed. A method that single-sources its
  majority reduction from `binary-instrument@1` reads exactly what that module reads; declaring
  fewer inputs than it consumes is a false declaration in the registry itself.
- **`strata` is a required parameter, so the output must have per-stratum slices.** v1.0 required
  the parameter and emitted only `byCandidateClass`, which would seal a parameter nothing reads.
  `byStratum` is added, mirroring `byCandidateClass`. This is also what the design's per-category
  reporting needs.
- **`referenceSet` is `registered-non-reference`, not `v1-reference`.** v1.0 asserted the stronger
  value with no argument. The v1 reference set is a frozen conformance corpus; a method registered
  after v1 cannot retroactively be part of what "v1-reference" named. The nearest analogue,
  `bradleyTerry`, is `registered-non-reference` (`registry.ts:276`). If P5 finds a definition of the
  reference set that admits later members, it may argue the stronger value in its PR; it may not
  assume it.

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
      byStratum: [                                // sorted by stratum, over the sealed vocabulary
        { stratum, n, disagreements, rate, interval }
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

**Lock-time work. Correction to v1.0: there is no allowlist.** `buildAnalysisPlan` has two paths
(`core/src/run/compile.ts`): a **bespoke branch per derived-parameter method**, of which
`binaryInstrument` is today the only one (`:115-124`, which builds the plan from
`binaryParameters` and **returns early**), and a generic path for caller-supplied-parameter methods
that does a registry lookup plus a `computeAvailability` check (`:126-133`). Adding an id to a list
is not the work.

Because `pairwise-disagreement@1` derives every parameter from the draft and the sealed closure, it
needs **a second bespoke branch**, plus a `compilePairwiseDisagreementProfile` sibling of
`compileBinaryInstrumentProfile` (the same joins and the same derivation, minus the arm-cardinality
and baseline/candidate branches), plus a conformance fixture. Sized here so it is not discovered
late: a registered method is an id, a registry row, a derivation function, a bespoke plan branch,
and a conformance fixture, not a statistics function.

### 7.2 The evidence contrast: `paired-delta@1` cannot compute over a binary-judgment Matrix today

**This is the most serious correction to v1.0, and it invalidates that version's central claim about
this contrast.** v1.0 said "no input adapter is needed to make the join work". That is false. Every
paired task fails admission before any pairing happens.

**The blocking chain, verified end to end:**

1. `pairedDelta.compute` calls `resolveTaskProvenance(taskDigest, input)` for **every** paired task
   (`aggregate/src/registry.ts:1161`), unconditionally, inside the pairing loop.
2. That delegates to `resolveBenchmarkTaskProvenance`
   (`records/src/benchmark/checks.ts:35-73`), which reads `task.payload.provenance` and requires it
   to be a **non-array object** carrying **exactly one** of `source` (non-empty string) or
   `sourceCommitment` (`sha256:<64 hex>`), **plus** a strict-calendar RFC 3339 `timestamp`.
3. A binary-judgment payload's `provenance` is `z.array(...).min(1)` of `{digest: {sha256}}`, with
   no `source`, no `sourceCommitment`, and no `timestamp`
   (`profiles/src/binary-judgment/contracts.ts:74-79,91-98`).
4. `Array.isArray(provenance)` is therefore true, so every task returns
   `{ok: false, reason: "invalid-provenance"}`, which
   `resolved-inputs.ts:319-323` turns into
   `MethodInputError("task-provenance-source-missing", ...)`.

**Every task fails. The method throws before producing any number.**

**An input adapter cannot fix this from outside the method.** `resolveTaskProvenance` is called
inside `compute`, and the Task bytes it reads are digest-checked against the task digest
(`checks.ts:41`), so no adapter can substitute reshaped bytes. D2's conditional ("adding an input
adapter only if it cannot consume item-level majority decisions") assumed the input was consumable
and the reduction was the question. The premise does not hold, so the decision returns to the
operator as **G1-D-D** in §11.

**A second, independent limitation, also missed by v1.0.** Even with admission fixed, the BCa
interval is withheld unless **both** `clusteredRates.length >= 5` (`MIN_PAIRED_DELTA_TASKS`,
`registry.ts:1095,1180-1181`) and `clusterCount >= 2` (`registry.ts:1182-1186`). Below either
threshold the method emits a point estimate plus `reasons` and **no interval**. A 240-item bank
clears the first easily; the second is a **bank-construction precondition**: the bank must span at
least two distinct provenance source clusters, or the contrast publishes as a point estimate with
its reasons and no interval. **Frozen reporting rule:** when the interval is withheld, the report
prints the point estimate, the two threshold values, the observed counts, and the method's own
`reasons` strings verbatim, marked `registry-verified` (the withholding is itself a registry-verified
output, not a gap).

#### Four options, of which two are unavailable on fact

| Option | What it costs | Verdict |
|---|---|---|
| **(A) RECOMMENDED. Make binary-judgment Tasks records-admitted** | A payload reshape (below), folded into P2 so the profile document moves **once**, not twice; a **profile-URI major bump**, which §0.4 requires because the reshape rejects payloads that validate today; one new required field on the source-manifest row; the importer's source cross-check reworked; both mirrored payload schemas widened; every digest join re-verified | Unlocks the whole provenance-clustered method family, not just this contrast |
| **(B) Spec the input adapter D2 anticipated** | **Not available.** `resolveTaskProvenance` runs *inside* `compute`, and the Task bytes it reads are checked against the task digest (`checks.ts:41`) **and** re-serialized and compared byte for byte against canonical JSON (`:48-49`). No adapter can hand the method reshaped provenance without changing the very digest the pairing joins on | Ruled out on fact, not on preference |
| **(C) Route the contrast through a different already-registered paired method** | **Not available.** Every registered paired method declares `task-provenance-source` in `requiredInputs` and `clusteringRule`: `paired-mcnemar` (`registry.ts:218-227`), `provenance-cluster-sign` (`:228-237`), `noninferiority-iut` (`:238-248`), `paired-delta` (`:249-259`). There is no paired escape hatch; the whole family is gated on the same admission | Ruled out on fact |
| **(D) Move the evidence contrast to a sealed companion** | Zero engineering risk. Contradicts D2's ruling to register it | The fallback if (A) does not fit the window |

Option (C) is listed because it is the first thing a reader will propose, and because its unavailability is
the strongest argument for (A): the blocker is not a quirk of one method, it is the records-admission
gate in front of every provenance-clustered read this product owns.

**Option (A), exact shape.** `resolveBenchmarkTaskProvenance` reads exactly `payload.provenance`, so
that key must become the records-admitted object and the existing digest-only descriptor list moves
aside:

```
provenance: { sourceCommitment: "sha256:<64 hex>", timestamp: "<strict RFC 3339>" }   // cluster key
sources:    [ { digest: { sha256 } }, ... ].min(1)                                    // today's list, renamed
```

`sourceCommitment` is the code-unit-least member of the item's source digest set, so clustering is
stable and an item with several sources still lands in exactly one cluster. It is derived at import
from data the bank already carries: the importer already maps every `provenance[].digest.sha256` to
a row of the source manifest and refuses an unmapped digest or an unused row
(`core/src/intake/binary-item-bank.ts:258,265-276`).

**`timestamp` comes from the source, not from the item.** `BinarySourceManifestEntrySchema`
(`verify/src/admission/intake.ts:33-43`) carries `provenanceSha256` plus three
`SourceDescriptor`s and **no instant**, so there is nothing to derive from today. **Frozen:** the
source-manifest row gains a required `publishedAt`, calendar-strict RFC 3339, and the importer
copies it onto the payload from the row `sourceCommitment` names.

Putting the instant on the source row rather than on the item is the load-bearing choice. It makes
"two items drawn from one source carry the same cluster key and the same timestamp" a **structural**
property of the manifest instead of a rule someone has to check, which is the same move §2.4 makes
for evidence and the same reason. Per-item timestamps would let the bank author encode an ordering
that correlates with the label.

There is prior art for exactly this repair on the import path:
`benchmarking/interop/src/import/rfc3339-from-source.ts` exists to convert upstream dataset
timestamps into the calendar-strict form `resolveBenchmarkTaskProvenance` requires, with explicit
shape repairs only and a refusal for anything unrecognized. The judge importer reuses it rather than
growing a second date parser.

**The profile URI bumps, and §0.4 is why.** Adding `evidence` (§2.6) is a widening: every payload
that validates today still validates. Reshaping `provenance` is not. A payload carrying the array
form **stops validating**, which is a stronger break than the "changes its meaning, its bytes, or
its output" clause §0.4 already bumps for. **Frozen:** under option (A),
`BINARY_JUDGMENT_PROFILE_URI` moves from `.../task-profiles/binary-judgment/1.0` to `.../2.0`
(`profiles/src/identifiers.ts:15-16`), the profile document module is renamed to match, and the
importer's hard-checked `--profile binary-judgment@1` literal becomes `binary-judgment@2`
(`core/src/cli/main.ts:110,465-466`, `core/src/operations/import-item-bank.ts:25`).

The bump is honest and it is cheap, and the spec says both. It is honest because the payload
contract genuinely changed. It is cheap because **no binary-judgment bank exists outside this
repository's own fixtures**: the only end-to-end judge lifecycle on the tree is the synthetic
fixture (`core/src/bundle/testing/v4-synthetic-fixture.ts`), and P2 already regenerates every judge
fixture for the `evidence` field. What the bump adds over that regeneration is a rename, not a
migration. P2's PR body records the old and new URI alongside the old and new profile digest.

**Leak analysis, required because the payload is solver-visible.** Both added values are safe, for
two independent reasons.

- **Neither is renderable.** `renderBinaryJudgmentMessages` interpolates only declared template
  fields (§2.2), and `provenance` is not one. No payload key outside that enum ever reaches the
  model.
- **Neither is a usable channel even if it did.** `sourceCommitment` is an opaque 64-hex digest,
  which is precisely the form `contracts.ts:69-73` already chose over a URI for this exact reason
  ("even an innocent-looking URI can become a covert truth/class channel"). This option keeps that
  decision: it adds the **commitment** variant the records schema accepts and never the `source`
  string variant. `timestamp` is the source's publication instant, shared across every item drawn
  from one source.
- **Structural, not merely obligatory.** Because both values are read off the source-manifest row,
  two items sharing a source carry identical values by construction. §2.4's anti-truth-channel
  invariant is asserted about `evidence` because evidence is authored per item; it does not need to
  be asserted here, because the shape does not admit the violation.

**Owner if (A) is chosen: P2**, so the profile document moves once and the URI bumps once. P5 then
consumes it, and P5's own acceptance gains one assertion: `paired-delta@1` computes over the
regenerated bank without a `task-provenance-source-missing` throw. **Owner if (D) is chosen:**
nobody; §7.3 gains a third companion.

**This is decision point G1-D-D in §11**, and the reason it is a decision rather than a ruling is
narrow. Option (A) is *inside* D2: it uses `paired-delta@1` unmodified, adds no input adapter, and
registers the contrast exactly as D2 ruled. What it does is present a cost D2 could not have known
about, because the blocker was undiscovered when D2 was written. Option (D) is *outside* D2, so the
lane may never take it on its own. The operator therefore picks between accepting (A)'s cost inside
P2's window and invoking (D) as a fallback.

#### Input mechanics, for whichever option lands

**Verified** (`aggregate/src/registry.ts:249-259`):

```
requiredInputs: ["matrix.cells", "referenced-verdicts", "task-provenance-source"]
exclusionRule:  "pair Task digests judged in both arms; per-Task rates average all judged
                 replicates; report full remainder"
clusteringRule: "task-provenance-source"
parameters:     { verdictRule, baseline, candidate, seed, resamples, alpha }
```

**The join needs no adapter; admission does. These are two different things, and v1.0 conflated
them.** Separating them is what makes option (A) a bounded change rather than an open-ended one.

- **The join is correct by construction and always was.** §2 places evidence on the shared payload,
  so the evidence-declaring arm and its evidence-free twin judge the **same Task digests**, and
  "pair Task digests judged in both arms" joins them exactly. Nothing about the pairing needs
  changing under any option. This is the §2.1 placement argument, and it survives review intact.
- **Admission is what fails, before the join runs.** v1.0's sentence "provenance clustering works
  because items already carry provenance descriptors (`contracts.ts:74-79,97`)" is the exact error:
  the items carry a **digest-only descriptor list**, which is not admitted provenance, and the array
  shape is precisely what `checks.ts:59` rejects. Option (A) does not add provenance to items that
  lacked it; it promotes provenance the items already carry into the shape the records layer admits.

Under option (A) the measured quantity is the paired difference in per-item agreement rate between
the two arms, with a two-sided clustered BCa interval, which is what the design's row "the judge's
input shape is a first-class disclosure entry" needs. Under option (D) the same quantity is computed
by a sealed script and published digest-bound, with no interval claim the registry stands behind.

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

### 7.5 P5 seam inventory

Given at the same grain as §1.7 and §5.6, because a registered method is five artifacts and a
reader who sees only "add a method" will size it as one.

| Seam | Change |
|---|---|
| `records/src/identifiers.ts:58-69` | `pairwise-disagreement` joins `BENCHMARKING_METHOD_IDS` at the shared version `"1"` |
| `aggregate/src/registry.ts` `METHOD_METADATA` | the row frozen in §7.1: eight `requiredInputs`, derived parameter schema, output shape, exclusion and clustering rules, `referenceSet: "registered-non-reference"` |
| `aggregate/src/registry.ts` method list (`:1244` neighborhood) | the `SingleSubjectMethod` implementation, its majority reduction **imported** from the `binary-instrument@1` module, never reimplemented |
| `core/src/run/compile.ts:115-124` | a **second bespoke derived-parameter branch**, appended past the `binaryInstrument` early return (§8.3 names the mechanics) |
| `core/src/run/binary-instrument-profile.ts` | `compilePairwiseDisagreementProfile`, sibling of `compileBinaryInstrumentProfile`: same joins, same derivation, minus the arm-cardinality and baseline/candidate branches |
| method-conformance fixture corpus | one fixture per §7.1's determinism claim: byte-stable output on recompute |
| `core/src/domain/draft.ts:178-186` | `DraftSpecSchema.additionalAnalyses` (§8.3), optional and additive |
| `core/src/operations/report.ts:165`, `publication-report.ts:313` | one Report record per non-wilson plan entry, in plan order (§8.3) |
| `core/src/report/claim.ts`, `core/src/run/state.ts`, `core/src/bundle/materialize.ts`, `verify/src/verify.ts`, `verify/src/assets.ts` | the Report-singularity pins itemized in §8.3, each of which must accept N Reports or the fallback is taken |
| **P2-owned, P5-consumed** | the payload provenance reshape under §7.2 option (A). P5 does not implement it and must not fork it |

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
(`core/src/operations/report.ts:165`); `ReportRecordSchema.method` is one `MethodRefSchema`
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
4. **Pre-register the additional methods in the sealed analysis plan, and emit one Report record per
   plan entry, into one bundle, over one Matrix.** Recommended at v1.1; **no longer recommended, see
   option 5.**
5. **RECOMMENDED at v1.2. Pre-register the additional methods in the sealed analysis plan exactly as
   in option 4, and publish one bundle per plan entry, over one Run and one Matrix.**

Options 4 and 5 share their entire front half, and it uses a mechanism that already exists for
exactly this purpose: `analysisPlan` is already a **list**, sealed at lock, whose stated job
(`compile.ts:72-75`) is to "honestly pre-register both analyses at lock". They differ only in
packaging, after the science is already settled. Frozen mechanics of the shared half:

- `DraftSpecSchema` gains `additionalAnalyses: z.array(AnalysisSchema).min(1).optional()`. Absent
  means today's behavior exactly. No entry is added to `DRAFT_SPEC_DEFAULTS`, no stored draft is
  migrated, and **no existing draft's `specSha256` moves** (the same reasoning the existing
  `analysis`, `budget`, and `anchoring` blocks already document).
- `buildAnalysisPlan` appends each additional entry after the primary. **The mechanics matter and
  v1.0 did not name them**, because the function does not have one exit to append to. It has
  **four**: `analysis === undefined` returns `[wilson]` (`compile.ts:93`), an explicit wilson
  selection returns `[wilson]` (`:112`), the bespoke `binaryInstrument` branch returns
  `[wilson, binaryInstrument]` (`:119`) **before the generic path is ever reached**, and the generic
  registered-method path returns at `:169`. An append written at any one of them is an append three
  callers skip.

  **Frozen:** the existing body becomes an inner function that yields the primary plan through its
  four returns unchanged, and `buildAnalysisPlan` becomes a wrapper that calls it and then appends.
  Nothing about the primary plan's construction or its refusals moves, so every existing draft seals
  the identical plan.

  **Per-entry validation dispatches the same three ways the primary does**, because the entries are
  not homogeneous: a `binary-instrument@1` entry takes its parameters from the caller-supplied
  derived `binaryParameters` (`:237`) and refuses if that derivation is absent (`:116-118`); a
  `pairwise-disagreement@1` entry runs its own derivation (§7.5); any other registered id takes the
  generic path's checks verbatim (registry lookup plus `computeAvailability` at `:126-133`, then the
  reserved-key refusal at `:134-141`). A wrapper that validated every entry as if it were generic would
  reject exactly the two entries this program needs.

  **Two refusals the wrapper adds, neither inherited:** an additional entry naming `wilson@1`
  refuses (wilson is always the head of the plan; a second copy is a duplicate readout), and an
  additional entry naming the same `(id, version)` as the primary or as an earlier additional entry
  refuses (two identical plan entries would emit two byte-identical Reports and make the claim
  table's Report attribution ambiguous). Everything is pre-registered before the run, which is the
  property that matters scientifically.
- `report` emits **one sealed Report record per non-wilson plan entry**, each with its own single
  `method` ref and its own `results`. **No records-schema change**: every Report stays
  single-method. `report.ts:165` and its independent twin `publication-report.ts:313` today select
  `planEntries[planEntries.length - 1]`; both become "select the named entry", kept in lockstep.
- The claim table marks each number with the Report that produced it, satisfying §7.4 with no extra
  vocabulary.

**Where the two options diverge, and why the sweep flipped the recommendation.**

Option 4 puts the N Reports in **one bundle**. Option 5 publishes **N bundles**, each carrying one
Report, all over the same `runSha256` and the same `matrixSha256`. The science is identical: the
plan is sealed at lock with every method pre-registered, and every readout is computed over one
collected cell set. What differs is how much shipped, published surface has to be rewritten before
the flagship can be verified at all.

**The sweep found four independent reimplementations of "one Report per bundle", not one.** Option 4
must widen all four. Option 5 touches none of them:

| Surface | Copies | Option 4 | Option 5 |
|---|---|---|---|
| Claim `records` block | **three**: `core/src/report/claim.ts:171`, its byte-identical mirror `verify/src/profile/claim.ts:167`, and the hand-maintained `verify/schemas/claim-package.schema.json:32` | all three widen; the claim package's own version moves | unchanged |
| `exactKeys` control check | two: `core/src/report/claim.ts:371`, `verify/src/profile/claim.ts:361` | both widen | unchanged |
| `PUBLIC_BUNDLE_FILES` | two: `core/src/bundle/materialize.ts:93`, `verify/src/materialize.ts:2` | a numbered or directory naming scheme, in both | unchanged |
| Bundle verifier | `verify/src/verify.ts:413` reads the fixed path `report.json`; `:438` re-derives the static bundle from a one-element array | both widen | unchanged |
| **`verify/scripts/external-verify.py:160,207-208`** | an **independent Python reimplementation** | must be rewritten, or it silently passes while checking one of N Reports | unchanged |
| **`benchmarking/evidence/src/portable.ts:133,245`** | a **third claim-package format** (evidence-native `claim-package/3`) with its own singular report reads | must be rewritten | unchanged |
| Published assets | `verify/src/assets.ts:528,531,554,557` render one Report digest into HTML, the footer, and the badge | templates loop | unchanged |

**"Unchanged" in this table means the bundle format and the code that reads it**, which is the
comparison the table exists to make. It does **not** mean option 5 is free on the producer side: the
residual-cost table above prices `publish.ts`, `materialize.ts`, and `claim.ts`, all of which option
4 pays as well. v1.2 conflated the two and delta review was right to catch it.

**Option 5's residual cost, corrected at v1.3.** v1.2 said "confined to four files, nine sites".
That was wrong, and delta review is right that the omission was entirely on the **producer** side.
The corrected cost is **eight files, roughly nineteen sites**, all of which option 4 pays too:

| File | Sites | What changes |
|---|---|---|
| `core/src/domain/draft.ts` | `:178,226` | `additionalAnalyses`, per the shared front half |
| `core/src/run/compile.ts` | `:82,119,169` | the plan wrapper and its four returns |
| `core/src/operations/report.ts` | `:125,165,272,340,351` | see the lifecycle ruling below |
| `core/src/operations/publication-report.ts` | `:313,326` | the second, independent copy of the last-entry select, and the single `produceReportV2` call |
| `core/src/run/state.ts` | `:151` | report identities recorded per plan entry |
| **`core/src/operations/publish.ts`** | `:81,157` | see the lifecycle ruling below |
| **`core/src/bundle/materialize.ts`** | `:182-186,188-189,198-199,252-253,865` | reads the singular run-state report digests that the `state.ts:151` change makes ambiguous. **v1.2's divergence table marked these "unchanged" and that was wrong**: they are unchanged with respect to *bundle format*, which is the row's point, and changed with respect to *which report identity this bundle is being built from* |
| **`core/src/report/claim.ts`** | `:723` | `writeClaimPackage` writes one Claim to a `draftId`-keyed path; N bundles need N Claims |

**The lifecycle ruling, which the evidence forces rather than the design choosing.** Delta review
found that `publish` is single-shot: `publish.ts:81` refuses unless `state === "reported"`, and
`:157` transitions the draft to the terminal `published-bundle` (`domain/lifecycle.ts:37-45`), so a
second `publish` is an `illegal-transition`. **`report` is single-shot in exactly the same way, and
that was not named by anyone:** `report.ts:125` refuses unless `state === "closed"`, and `:351`
transitions to `reported`. So "invoke `report` once per plan entry" is illegal on the second call.

**Frozen:** **one `report` invocation emits N sealed Report records**, one per non-wilson plan entry,
and **one `publish` invocation emits N bundle directories**, one per Report. Both verbs stay
single-shot, the lifecycle gains no state and no repeatable event, and each emitted bundle is
byte-structurally identical to a bundle published today. Run state records the N report identities
keyed by `(method, version)`, which is additive and moves no existing draft's bytes.

This also disposes of `report.ts:340`'s clobber, which v1.2 flagged as the only new work: with one
invocation writing N keyed identities there is no second call to clobber the first.

**A supporting fact delta review found, which the spec should have cited itself.**
`verify/src/profile/claim-consistency.ts:41` already resolves the plan entry by
**`method.id` plus `method.version`**, not by position: `analysisPlan?.find((entry) => entry.method
=== reportRecord.method.id && entry.version === reportRecord.method.version)`. Its core-side twin
does the same (`core/src/verification/claim-consistency.ts:83`). So consistency checking a bundle
whose Report is the *second* plan entry already works, unmodified, today. The surface that would
have been most tedious to make N-aware is already N-aware, and it is N-aware in precisely the way
option 5 needs: each bundle carries one Report, and the checker finds that Report's own plan entry
by identity rather than by index.

**The decisive argument is not the file count.** It is that option 5's bundles cold-verify with the
**already published, unmodified** verifier and the **already published** `external-verify.py`, while
option 4 produces a flagship bundle that no currently shipped verifier can read. For a program whose
entire deliverable is a disclosure specification, shipping evidence that requires a new verifier to
check is the wrong trade, and it is the trade v1.1 recommended without knowing the Python
reimplementation existed.

**The one property option 4 has that option 5 must supply differently:** option 4's single bundle
asserts "these three readouts are over one cell set" internally. Under option 5 a reader checks it
by observing that all N bundles carry the same `runSha256` and `matrixSha256`. That is a two-field
comparison across N published artifacts, it is stated in the runbook and rendered by R1, and it is
arguably the stronger disclosure, because each bundle independently re-derives its own Report
against the shared Matrix rather than asking the reader to trust one bundle's internal consistency.

**Cost of option 4, stated plainly and retained because it is the argument for option 5.**
v1.0 said "no records-schema change" and left it there; that sentence is true only of
`packages/benchmarking/records`. Seven surfaces pin **exactly one** Report, and under option 4 each
must accept N. Named here so the sizing is a table a reviewer can check rather than a claim they
have to trust:

**Cost, stated plainly. Correction to v1.0, from independent review: v1.0 said "no records-schema
change" and left it there. That sentence is true only of `packages/benchmarking/records`.** Six
further surfaces pin **exactly one** Report, and each must accept N or the fallback is taken. Named
here so the sizing is a table a reviewer can check rather than a claim they have to trust:

| # | Pin | What it is | What N Reports needs |
|---|---|---|---|
| 1 | `core/src/report/claim.ts:371` | `exactKeys(records, [... "reportSha256", "reportEnvelopeSha256"])` on the Claim's `records` block | a Claim `records` shape carrying a Report **list**, which moves the shipped claim package's own version |
| 2 | `core/src/run/state.ts:150-153` | one optional `reportSha256` plus one `reportEnvelopeSha256` (and the v2 pair at `:154-155`) | workspace run state records N, in plan order |
| 3 | `core/src/bundle/materialize.ts:188-189,198-199` | the publish gate reads the two singular run-state digests and loads exactly those bytes | loads and lays down N Report records and N envelopes |
| 4 | `materialize.ts:252-253` | cross-checks the Claim's singular Report digests against run state | cross-checks the two lists elementwise |
| 5 | `materialize.ts:865` | writes one `reportSha256` into the bundle manifest | writes the list |
| 6 | `verify/src/verify.ts:142-143,434-435,1574` | the standalone verifier's public result carries one `reportSha256` and one `reportEnvelopeSha256` | the public result carries N, and cold verification reads "for each Report in the bundle" |
| 7 | `verify/src/assets.ts:528,531,554,557` | the published HTML records section, the page footer, and the badge's `desc` and `metadata` each render one Report digest | the site renders the Report per readout, or names one as the qualification Report and lists the rest |

Row 1 is the expensive one and the reason the fallback exists: the Claim's `records` block is
`exactKeys`-pinned, so widening it is a version move on the artifact every cold verifier reads.
Row 7 is the one most likely to be forgotten, because it is presentation rather than schema, and a
site that renders one Report digest over a three-Report bundle is a fabricated singularity.

Row 1 understates itself: the sweep found the same `records` block in **three** hand-synchronized
copies, one of which is a JSON Schema document that goes stale silently. Beyond the pins, option 4
also touches claim-consistency (`core/src/verification/claim-consistency.ts:10` and its mirror
`verify/src/profile/claim-consistency.ts:11`), `publish`, and the bundle profile.

**Under option 5 none of this table is touched**, and the residual four-file cost is the one stated
above. This table is retained because it is the sizing that makes the choice legible, not because
option 4 is expected to be taken.

**Fallback if neither fits the window:** `binary-instrument@1` is the single registered Report and
**both** cross-arm readouts drop to sealed companions. The claim table already supports that and
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
| 5 | EvaluationSpec digest (`buildBinaryJudgmentEvaluationSpecification`) | P3 | **YES, once** | grader, image, and parser digests move with row 4; the `evaluation context/specification` join and every judge fixture regenerate. **Correction to v1.0: not twice.** P7 declares no `unscorable` classes (§5.0), so the second move is gone and P7 leaves the merge chain |
| 6 | `EVALUATION_PARSER_SHA256` and `RESPONSE_PARSER_DIGEST` (`binary-instrument-method.ts:64,66`) | P3 | **YES** | mirrored literals; must move in the same commit as row 4 |
| 7 | `BinaryJudgmentInstrumentSchema` | P1, P2 | schema widens, **bytes stable** | model set, generation union, parser identity set, optional evidence template field; existing sealed instruments keep their digests |
| 8 | `BinaryJudgmentObservationSchema` | P1 | schema widens, **bytes stable** | model set and per-profile `limitations`; existing observations unchanged |
| 9 | `InspectBinaryJudgeSelectionManifestSchema` (`.../inspect-binary-judge-selection/1`) | P1 | schema widens, **URI stays `/1`** | model set, generation union, optional `snapshotProbeSha256`; existing selections byte-identical (§0.4) |
| 10 | `BinaryJudgmentStratumSchema` | P4 | enum to grammar, **bytes stable** | `core` and `stress` seal identically; analysis-context and label-resolution bytes unchanged |
| 11 | `BINARY_INSTRUMENT_PARAMETER_SCHEMA` | **P1 (optional `judgeModelProfile`, §1.4)**, P4 (`strata`), P6 (`truthAdmission`) | widens, **method stays `@1`** | previously valid parameter sets still validate, seal identical bytes, and compute identically (§0.4). P1's key is **optional**, and its absent case must reproduce today's limitations output byte for byte or §10.2 fixture ruling 1 breaks |
| 12 | `BinaryJudgmentLabelResolutionSchema` | P6 | third member, **existing two byte-identical** | the `CommonShape` refactor (§6.7) changes no serialized bytes |
| 13 | `BinaryJudgmentAdmissionManifestSchema` | P6 | widens, **bytes stable** | enum value plus optional `screeningTableSha256` |
| 14 | New sealed records | P1, P6 | new | `snapshot-serving-probe/v1`, `screening-table/v1`, `screening-reveal-receipt/v1` |
| 15 | `BENCHMARKING_METHOD_IDS` and the registry | P5 | new row | `pairwise-disagreement`; plus a **second bespoke derived-parameter branch** in `compile.ts` and a derivation function (§7.1, §7.5). **Correction to v1.0: there is no allowlist** for an id to be added to |
| 16 | `DraftSpecSchema.additionalAnalyses` | P5 | optional and additive | **no stored draft's `specSha256` moves** |
| 17 | Bundle profile (Report list) | P5 | **verify and possibly bump** | if the current profile pins exactly one Report, the format version bumps; P5 confirms before implementing |
| 18 | Replacement-ledger `reason` enum, **both copies** | P6 | widens | `verify/src/admission/contracts.ts` and the second copy at `verify/src/schema.ts:199`; existing three values byte-unchanged in both |
| 19 | `BinaryJudgmentPayloadSchema.provenance` and the profile document's `payloadSchema.provenance` | P2, **only under G1-D-D option (A)** | **YES, and it is a break, not a widening** | the digest-descriptor array becomes `{sourceCommitment, timestamp}` and the list is renamed `sources`; payloads that validate today stop validating (§7.2) |
| 20 | `BINARY_JUDGMENT_PROFILE_URI` (`profiles/src/identifiers.ts:15-16`) and the `binary-judgment@1` importer literal | P2, same condition as row 19 | **YES, major bump** | `/1.0` to `/2.0`; `--profile binary-judgment@2` (`core/src/cli/main.ts:110,465-466`, `operations/import-item-bank.ts:25`); the profile document module renamed. §0.4 requires the bump; §7.2 sizes it |
| 21 | `BinarySourceManifestEntrySchema` (`verify/src/admission/intake.ts:33-43`) | P2, same condition as row 19 | gains a **required** `publishedAt` | the source publication instant the payload's `timestamp` is copied from; no existing manifest carries one |
| 22 | `BundleQualificationSchema` (`verify/src/schema.ts:183-189,199,275-276`) | P1 (`arms`), P4 (`strata`), P6 (`truthAdmission`, ledger `reason`, the publication-grade branch) | widens, **`BUNDLE_QUALIFICATION_FORMAT` stays** | §1.6 site 7, §3.1 site 10, §6.8. Every existing bundle still validates byte-identically (§0.4). This row was absent from v1.0 despite being P8's acceptance path |
| 23 | Verifier public result `armCount` (`verify/src/verify.ts:154,1621`) | P1 | literal `4` becomes derived | §1.6 site 8. Not a digest move; a **published-value correction**, and the only row here where leaving it alone publishes a false number rather than refusing |
| 24 | Claim `records` block (`core/src/report/claim.ts:371`) and the six other Report-singularity pins | P5, **only under G1-D-C option 4** | **YES if N Reports land** | §8.3's pin table; the claim package's own version moves with row 1 of it. Under the all-companions fallback nothing here moves |

### 10.1 Merge ordering (binding on the lane coordinator)

**Two packets regenerate the same judge fixture corpus: P2 (rows 1, and 19 to 21 under option (A))
and P3 (rows 4, 5, 6).** They must land in the order **P2, then P3**, with P3 rebased on P2 and
regenerating the fixtures rather than resolving them by hand. Landing them in parallel produces two
mutually stale fixture sets and a conflict nobody can review.

**Correction to v1.0: P7 is no longer in this chain.** v1.0 put it third on the strength of a second
EvaluationSpec digest move that §5.0 removed. P7 now moves no sealed bytes and may land at any time.

P1, P4, P6, and P7 move no sealed bytes and may land in any order relative to the chain. **Six
textual conflicts to expect and plan around, none of them a digest conflict.** v1.0 listed two; the
four added here all follow from the site tables §1.6 and §3.1 grew under review, and three of them
land in a single six-line block:

Rebuilt at v1.2 from the constant-sweep inventory. Eleven files, four of them touched by three or
more packets:

| File | Packets | What each touches |
|---|---|---|
| `core/src/run/binary-instrument-profile.ts` | P1, P4 | arm cardinality at `:324,349,352` and model literals (P1); the `["core","stress"]` gate at `:299` **and the re-hardcode at `:315`** (P4) |
| `aggregate/src/binary-instrument-method.ts` | **P1, P3, P4, P6** | model set, per-profile limitations, arm cardinality at `:955,1488,1510`, and the optional `judgeModelProfile` parameter at `:86-113,115-124` (P1); mirrored parser digests at `:64,66` (P3); ten stratum sites (P4); `truthAdmission` at `:109,123,172,412,415,446` (P6). **The most contended file in the program**, and P1's reach into it grew at v1.3 |
| `BINARY_INSTRUMENT_PARAMETER_SCHEMA` (same file, `:86-113`) | **P1, P4, P6** | optional `judgeModelProfile` (P1, §1.4); `strata` (P4); `truthAdmission` (P6). Called out separately because it is one object literal under `additionalProperties: false`, so all three edits land in the same braces |
| **`verify/src/schema.ts`** | **P1, P4, P6** | `arms` `.length(4)` at `:189` and the distinct-instrument `superRefine` at `:227` (P1); the `strata` tuple at `:185` (P4); `truthAdmission` at `:183`, the ledger `reason` copy at `:199`, the evidence-role lists at `:16,49`, the reviewer and authority checks at `:119-131`, and both `superRefine` blocks at `:259-270,275-276` (P6) |
| **`verify/src/verify.ts:150-155`** | **P1, P4, P6** | one six-line type block: `armCount` at `:154` (P1), `strata` at `:153` (P4), `truthAdmission` at `:151` (P6). Whichever lands first, the other two rebase through the same lines |
| **`verify/src/admission/contracts.ts`** | **P2, P4, P6** | the mirrored `BinaryJudgmentPayloadSchema` at `:31-40` (P2); `BinaryJudgmentStratumSchema` at `:30` (P4); the admission manifest at `:167-177`, the ledger `reason` at `:141`, the operator limitation at `:163` (P6) |
| **`verify/src/admission/verification.ts`** | P4, P6 | five inline stratum unions at `:52,61,115,125,136` (P4); the label-resolution view, role lists, `publicationGrade` derivation, and the two-reviewer functions (P6) |
| **`verify/src/profile/binary-qualification.ts:3-31`** | **P1, P6** | one small array: P1 conditions `mutableModelAlias` per profile (§1.4), P6 adds the screened branch's own string (§6.8a). Both edit the same return expression |
| **`evaluator-adapters/src/binary-judgment/adapter.ts:715-723`** | **P4, P6** | **one compound boolean expression**: the `truthAdmission` allowlist at `:715-716` (P6) and the stratum refusal at `:723` (P4) are operands of the same condition |
| `core/src/operations/human-review.ts` | P4, P6 | `HumanAdmissionCandidateInput.stratum` at `:135` (P4); the two implicit-else routers, the reason unions, and the `publicationGrade` derivation (P6) |
| `core/src/operations/import-item-bank.ts:50-53` | P4, P6 | adjacent lines of one interface: `truthAdmission` at `:50` (P6), `strata` at `:53` (P4) |

**Shared fixture builder, a hazard rather than a blocker.**
`core/src/bundle/testing/v4-synthetic-fixture.ts` is touched by **P1, P2, P4, and P6** and is
consumed by a dozen-plus test files across two packages. §10.2's fixture ruling keeps it safe:
each packet adds an **option** whose default reproduces today's output byte for byte, so the four
edits are additive and no existing caller's expectations move. Packets must not change its defaults,
and a packet that finds itself needing to is widening incompatibly.

**The `verify` package is where this program's packets collide**, and v1.0 named none of it because
v1.0 did not know the verify package carried second copies. Six of the eleven rows above are in
`verify`. The coordinator sequences the `verify`-touching packets rather than dispatching them
concurrently, and P6 goes last of the three that share `schema.ts`, because it touches the most of
it.

Every packet PR body records its digest movements explicitly, before and after, per row of the table
above. `next` has zero required status checks, so each PR body also records local full-chain
verification (portal build order, affected package suites, architecture and catalog guards) per the
program's §5.

### 10.2 Constant coverage proof

**Why this subsection exists.** Independent review found v1.0 naming three of eleven stratum sites,
three of eight arm-count sites, and one of two `truthAdmission` sites. In each case the omission was
the same shape: v1.0 recon covered `profiles` and `core` at depth and treated `aggregate` and
`verify` as downstream, when in fact both packages carry **second copies** of the constants. A prose
list is not a completeness argument, so this subsection replaces it with one a reviewer can check
mechanically.

**The obligation.** For each pinned constant below, this document names **every** file that pins it,
and the reviewer can falsify that claim by running the stated command and diffing its hits against
the table. A site in the command's output that is absent from the table is a defect in this spec,
not a judgment call.

**Status at v1.2: the mechanical sweep is complete and §10.2 is frozen.** It classified 214 sites
across the four families. The counts below are the coverage proof; the per-family inventories that
follow are the evidence.

| Family | Constant pinned | Owning section | Named at v1.1 | Production sites that must change | Confirmed already flexible | Test and fixture sites |
|---|---|---|---|---|---|---|
| **F1** | the `["core","stress"]` stratum pair | §3.1 | 11 | **23** | 2 | 8 |
| **F2** | the arm count `4` | §1.6 | 8 | **9** | 6 | 12 |
| **F3** | `truthAdmission` and its coupled vocabularies | §6.8, §6.8a | 5 | **61** (sweep 60 + 1 at v1.3) | 20 | 22 |
| **F4** | the singular Report | §8.3 | 7 | **35** under option 4, **19** under option 5 | 8 | 9 |

**The headline is F3.** v1.1 sized the screened-admission branch at five sites and it is sixty. §6.8a
is the section that finding produced, and it is why P6 is now the program's largest packet rather
than a schema widening. The second headline is F4's split column: the sweep is what showed that the
packaging choice, not the science, is what costs 35 sites, which is why §8.3 now recommends
option 5.

**Confirmed-flexible sites are load-bearing findings, not filler.** Thirty-six surfaces were
checked and found already generic. They are named in their owning sections so that no packet
"fixes" them: F2's `.min(2)` selection manifests and the whole reduction layer (§1.6), F1's four
consume-only schema references (§3.1), F3's twenty pass-through and equality-check sites, and F4's
`analysisPlan` array, which the platform records layer already accepts at any length
(`records/src/run/schema.ts:55,83`, `records/schemas/run.schema.json:207`).

Re-derivation, from the repository root, at `next` `4f4ad46f2`. These are deliberately
**over-broad**: they return the candidate set, not the answer, because a bare comparison to `4` and
an incidental read of `reportSha256` both match. **The classification is the work; the grep only
bounds it.** Each hit is either a pin, in which case it appears in the inventory above, or an
unrelated match. A hit classified as a pin and absent from the inventory is a defect in this spec.

**Three of these four commands were wrong when v1.1 wrote them, and running the sweep is how that
was found.** v1.1's F1 command required the literal `"core"` **with quotes**, so it could never have
found either `projects-output` site, whose text is the English caption `Core and stress buckets`.
Its F3 command matched two tokens out of the family's seven and returned 34 hits against 60 real
sites. Its F4 command excluded `*.py`, so it could not have found the independent Python verifier
that turned out to be the strongest argument in §8.3. A completeness command that is not a superset
is worse than no command, because it reports coverage it does not have. Each command below was
checked against the sweep's site list before being written down.

```
# F1  — 33 non-test hits, against 23 production sites
grep -rEin 'core.{0,40}stress' --include='*.ts' --include='*.json' packages | grep -v '\.test\.'
# F2  — 67 non-test hits, against 9 production sites
grep -rEn 'armCount|\.length\(4\)|[!=]== 4' --include='*.ts' packages/benchmark-product packages/benchmarking | grep -v '\.test\.'
# F3  — 140 non-test hits, against 60 production sites
grep -rEn 'truthAdmission|two-human-unanimous|operator-only|publicationGrade|-attestor|review-(disagreement|indeterminate|incomplete)' --include='*.ts' packages | grep -v '\.test\.'
# F4  — 240 non-test hits, against 35 production sites
grep -rEn 'reportSha256|reportEnvelopeSha256|report\.json|analysisPlan|AnalysisSchema|PUBLIC_BUNDLE_FILES' --include='*.ts' --include='*.py' --include='*.json' packages | grep -v '\.test\.'
```

**F1 and F2 are token families; F3 and F4 are contract families, and the difference decides how they
stay covered.** A stratum pin and an arm-count pin always contain their literal, so a grep bounds
them today and will keep bounding them. "One Report per bundle" and "the admission mode branches
here" are contracts, not tokens: a **new** singular `read("report.json")`, or a new
`if (mode === "operator-only")` with an implicit else, is a new site no token search will surface.

That is why §6.8a freezes exhaustive switches with a `never`-typed default rather than a widened
enum: for a switch over a named union, the compiler is a tripwire that grep cannot be.

**But the compiler is not a complete tripwire either, and §10.2 must say so.** Delta review supplied
the counterexample: `core/src/bundle/materialize.ts:366` decides whether a reachable record
contributes an authority binding, using a hand-written or-chain over three string literals followed
by `if (role === undefined) continue;`. Adding a role to the vocabulary does not make it fail to
compile, because it switches on nothing; and its line carries none of F3's tokens, because
`operator-assertion` is not `operator-only`. **It is invisible to both tripwires**, and §6.8a
records it as such.

So the honest statement of §10.2's coverage is narrower than "the compiler catches what grep cannot".
It is this: the greps bound the literal half of every family; the exhaustive switches bound the
branching half of F3 and F4; and a **string-matching discriminator that returns `undefined` on an
unknown value** is caught by neither and must be found by reading. The sweep found the one that
exists today. This document does not claim there cannot be another.

#### Per-family inventories

Grouped by package with line lists, so a reader can hold one package in mind at a time. Roles are
the sweep's own classification: **pins-schema** (a declared type or validator), **imperative-check**
(a hand-rolled comparison), **projects-output** (writes a value into a published artifact),
**consumes-type** (inherits a widened type without its own literal).

**F1, stratum, 23 production sites.** `profiles` 1 (`contracts.ts:360`, the canonical schema) ·
`aggregate` 10 (`binary-instrument.ts:13,157`; `binary-instrument-method.ts:104,121,166,396,443,779,1388,1500`) ·
`evidence` 1 (`binary-instrument.ts:23`) · `benchmark-product/verify` 6
(`admission/contracts.ts:30`; `admission/verification.ts:52,61,115,125,136`; `verify.ts:153`;
`schema.ts:185`; `assets.ts:372,637`) · `benchmark-product/core` 4
(`run/binary-instrument-profile.ts:299,315`; `operations/import-item-bank.ts:53`, whose identical
pattern recurs at `intake/binary-item-bank.ts:130` and is one site;
`operations/human-review.ts:135`) · `evaluator-adapters` 1
(`binary-judgment/adapter.ts:723`). Roles: 12 pins-schema, 9 imperative-check, **2
projects-output** (`assets.ts:372,637`, the published captions).

**F2, arm count, 9 production sites.** `benchmark-product/verify` 4
(`schema.ts:189,227`; `verify.ts:154,1621`) · `benchmark-product/core` 2
(`run/binary-instrument-profile.ts:324,349`, the second covering `:352`) · `aggregate` 3
(`binary-instrument-method.ts:955,1488,1510`). Roles: 2 pins-schema, 6 imperative-check, **1
projects-output** (`verify.ts:1621`, the false published count).

**F3, admission, 61 production sites across 16 files** (the sweep's 60, plus `materialize.ts:366`
added at v1.3 from delta review). Enumerated at `file:line` like the other
three, because §10.2's obligation says every file that pins the constant is named and F3 is the
family a grep cannot bound, so a package-granular proof would be the weakest evidence attached to
the strongest claim.

| File | Lines | Roles |
|---|---|---|
| `profiles/src/binary-judgment/label-resolution.ts` | 36, 60, 70 | pins-schema |
| `evaluator-adapters/src/binary-judgment/adapter.ts` | 716 | imperative-check |
| `aggregate/src/binary-instrument-method.ts` | 109, 123, 172, 397, 412, 415, 446 | pins-schema, consumes-type, imperative-check |
| `benchmark-product/verify/src/schema.ts` | 16, 49, 104, 119, 125, 183, 199, 259, 263, 275 | pins-schema, imperative-check |
| `benchmark-product/verify/src/admission/verification.ts` | 63, 75, 83, 116, 126, 407, 437, 443, 487, 566, 601, 640 | pins-schema, consumes-type, imperative-check, projects-output |
| `benchmark-product/verify/src/admission/contracts.ts` | 141, 163, 170 | pins-schema |
| `benchmark-product/verify/src/assets.ts` | 26, 455, 461 | consumes-type, projects-output |
| `benchmark-product/verify/src/profile/binary-qualification.ts` | 10, 26 | pins-schema, imperative-check |
| `benchmark-product/verify/src/verify.ts` | 151 | consumes-type |
| `benchmark-product/core/src/operations/human-review.ts` | 148, 162, 189, 491, 566, 598, 642, 651, 744 | pins-schema, consumes-type, imperative-check, projects-output |
| `benchmark-product/core/src/operations/import-item-bank.ts` | 50 | consumes-type |
| `benchmark-product/core/src/bundle/materialize.ts` | 313, 316, 366, 371 | consumes-type, imperative-check |
| `benchmark-product/core/src/bundle/testing/v4-synthetic-fixture.ts` | 98, 581 | consumes-type, imperative-check |
| `benchmark-product/core/src/cli/parity-map.ts` | 155 | docs-or-comment |
| `benchmark-product/core/README.md` | 67 | docs-or-comment |
| `benchmark-product/core/parity-matrix.v1.json` | 9 | docs-or-comment |

Roles across the family: 17 pins-schema, 21 imperative-check, 15 consumes-type, 4 projects-output,
3 docs-or-comment. `materialize.ts:366` is **added at v1.3** and was not in the sweep's own list; it
is the discriminator §6.8a Group B-bis names, and it is the family's one site invisible to both the
grep and the compiler. The last three rows are one sentence of prose in three places, regenerated by
`yarn generate:parity` rather than hand-edited.

The four sites with no compiler safety net, the three that defeat §6.8's own rulings, the two
mappers that do not close, and the evidence-role vocabulary in three synchronized lists are named
and frozen in §6.8a. The rest are mechanical widenings of the same enum.

**F4, singular Report, 35 sites under option 4 and 19 under option 5.** `benchmark-product/core` 20 ·
`benchmark-product/verify` 13 (including `scripts/external-verify.py:160,207-208` and
`schemas/claim-package.schema.json:32`) · `evidence` 2 (`portable.ts:133,245`). §8.3's divergence
table is the option-4 breakdown and §8.3's residual-cost table is option 5's nineteen, across eight
files. **Corrected at v1.3:** v1.2 said nine across four files and omitted the producer side
entirely, `publish.ts:81,157`, `materialize.ts:182-186,188-189,198-199,252-253,865`, and
`claim.ts:723`.

#### Citation precision, including two corrections this document declines

Delta review raised three one-line citation drifts. **One holds and is fixed; two do not, and are
recorded here with the reading that settles them**, so a later pass does not re-apply them.

| Claim | Verdict |
|---|---|
| `report.ts` last-entry select is `:165`, not `:164` | **Holds.** `planEntries[planEntries.length - 1]` is at `:165`. Corrected everywhere, including the two places that cited the range `:162-168` |
| `publication-report.ts` should cite `:325`, not `:326` | **Does not hold.** `:326` is `produced = await produceReportV2({`, which is what this document cites it as. The `method: { id: selected.method, ... }` reference is at **`:329`**. Neither `:325` nor `:326` is the method ref; `:326` is correct for the claim being made |
| `external-verify.py` report read is `:202`, not `:204` | **Does not hold.** `:202` is a verdict-record existence check. `def claim_mirror():` is at `:204`, its own `read("report.json")` is at `:207`, and the `perSubject[0]` indexing is at `:208`. This document now cites `:160,207-208`, which is more precise than either the sweep's `:204` or the proposed `:202` |

Both declined corrections were checked by reading the files, not by re-reading the sweep. The
general rule this illustrates is worth stating once: **a citation is to the line that does the thing
the sentence claims**, not to the enclosing function's declaration, and a proposed correction is
verified the same way as an original claim.

#### The fixture ruling, which is the opposite of what the sweep's `mustChange` column says

The sweep marks 33 test-and-fixture sites `mustChange: true`. **Under this document's design most of
them must not change, and §0.4 is why.** This is a disagreement with the sweep's classification,
recorded with its reason rather than silently resolved.

The sweep answered "what changes if the four-arm two-stratum world is **replaced** by a six-arm
four-category one". That is not what this document specifies. Every delta here except §7.2 option
(A) is a **compatible widening**, and a widening's only proof is that the *existing* fixture,
unmodified, still validates, still seals to identical bytes, and still produces identical output.
Regenerating the old fixture to the new shape does not update the proof, it **deletes** it.

**Frozen:**

1. **The two 144-cell lifecycle fixtures stay green unmodified**, at four arms and two strata.
   `benchmarking/evidence/src/golden-lifecycle.test.ts` is a frozen replay of PR #2706's real
   four-arm outcome and its own comment at `:270` says so; `core/src/conformance/binary-qualification-cold-lifecycle.external.test.ts`
   is its cold-verify sibling. Neither is regenerated by P1 or P4. **P1's acceptance already reads
   this way** ("the existing four-arm qualification lifecycle test is green unmodified with
   `armCount: 4`") and is correct as written; the sweep's cross-check confirms the wording does not
   imply that test exercises the new surface.
2. **The new surfaces get new fixtures, added alongside.** Six arms, four categories, the screened
   branch, and the evidence channel are each exercised by a fixture that did not exist before. A
   packet that finds itself editing a golden fixture to make its feature pass has widened
   incompatibly and should stop.
3. **`core/src/bundle/testing/v4-synthetic-fixture.ts` gains options, never new defaults.** It is
   the single shared builder behind a dozen-plus test files (`v4-materialize.test.ts`,
   `v6-materialize.test.ts`, `assets.test.ts`, the schema tests, and the cold-lifecycle
   conformance run). Its arm count, stratum split (`:213`), admission mode (`:98`, `:581`), and
   evidence presence become parameters whose defaults reproduce today's output byte for byte, so
   every existing caller's expectations are untouched. This makes it a **merge-order hazard rather
   than a merge-order blocker**, and §10.1 records it.
4. **Three fixture sites genuinely must change**, and only these three: 
   `core/src/run/binary-instrument-profile.test.ts:478` (a negative-path test asserting a three-arm
   draft refuses. Delta review confirmed it **still refuses under §1.6 rule 1, for a different
   reason**: it slices the draft's arms to three while the sealed selection still declares four, so
   the new `spec.arms.length === selection.arms.length` check fires exactly where the literal `4`
   used to. It stays green by coincidence, which is why P1 revisits **what boundary it tests**
   rather than deleting it or leaving it alone), `core/parity-matrix.v1.json:9` with its two prose
   twins at `cli/parity-map.ts:155` and `core/README.md:67` (regenerated by `yarn generate:parity`,
   not hand-edited), and every judge fixture under §7.2 option (A), which is not a widening and is
   already priced in §2.6 and rows 19 to 21.

   The same question was asked of F1's projection fixture and the answer is better.
   `aggregate/src/binary-instrument-qualification.test.ts` builds a `byStratum` fixture over
   `core`/`stress` and asserts the projection validator refuses a dropped slice. Under §3.1 rule 5
   `expectedSlices` becomes the **sealed** vocabulary rather than the literal pair, and that fixture
   declares its sealed vocabulary as `["core","stress"]`, so it refuses the same drift for the same
   reason it always did. That is not coincidence, it is the widening behaving as §0.4 requires, and
   the fixture stays unmodified.
5. **`profiles/src/binary-judgment/label-resolution.test.ts:42` is a byte-for-byte golden assertion
   over a serialized label resolution** containing `"stratum":"stress"`. It stays unmodified, and it
   is doing double duty: it is F1's proof that widening the stratum schema moves no sealed bytes,
   and it is §6.7's proof that the `CommonShape` refactor moves none either.

Three standing rules, which the sweep's result confirms rather than replaces:

1. **A packet that widens a constant widens every copy of it in the same PR.** Partial widening is
   how §3.1 site 9 would have refused the replacement ledger after §3.1 sites 1 to 8 were green.
2. **A count that is a constant is not a count** (§1.6 site 8). Where the sweep finds a pinned
   literal that is *reported* rather than *checked*, it is a published-value defect and outranks the
   refusal sites in priority, because a refusal is visible and a false published number is not.
3. **Every new pin is a regression.** Once a family is widened, no packet reintroduces a literal
   from it. The packets' tests assert the widened behavior, which is what keeps the literal from
   coming back.

---

## 11. Ratification checklist (G1)

**Operator picks, at G1:**

| Ref | Decision | Recommendation |
|---|---|---|
| **G1-D-A** | Judge bind path: method-operand citizen, or the kept `runtime inspect bind-judge` verb (§8.1) | **(b)** the kept verb; no DR amendment |
| **G1-D-B** | Judge derived export: router branch, wire the orphan, or none by design (§8.2) | **(c)** none by design; P8 asserts the typed refusal; R1 links `native/inspect/*.eval` instead of a per-arm view bundle |
| **G1-D-D** | The evidence contrast: accept option (A)'s payload provenance reshape and profile-URI major bump inside P2, or invoke option (D) and demote the contrast to a sealed companion (§7.2) | **(A)**. It is inside D2, it uses `paired-delta@1` unmodified, and it unlocks every provenance-clustered method rather than one contrast. (D) is a fallback the operator invokes, never one the lane takes |
| **G1-D-E** | P7's shape: declare no `unscorable` classes and pin two existing draft-policy values (`test`-shaped), or keep the three-class declaration as sealed-but-unread disclosure and accept a second EvaluationSpec digest move plus a full fixture regeneration (§5.0) | **Declare none.** Nothing reads a `retryable-infrastructure` entry; the behavior P7's acceptance asks for already exists. §1.4 refuses decorative disclosure by name, and the rule does not weaken because this time it is a class list |

**Decided in this spec, marked for ratification:**

| Ref | Decision | Where | Reads on |
|---|---|---|---|
| **G1-D-C** | Three registered readouts over one collected cell set, via `additionalAnalyses`; **at v1.2 the packaging recommendation changes from one bundle carrying N Reports (option 4) to N bundles over one Run and one Matrix (option 5)**, on the sweep's evidence that option 4 must rewrite four independent verifier implementations including a published Python script. All-companions fallback unchanged | §8.3 | D2's delegated scope |
| **R-1** | `paired-delta@1` used unmodified; the paired contrast's unit is the per-item replicate mean, disclosed, rather than forking a v1-reference method | §7.2 | D2's "adding an input adapter only if it cannot consume item-level majority decisions" |
| **R-2** | The screened branch's ordering receipt is a bank-scoped sibling of the per-item reveal receipt, not a literal reuse of it | §6.6 | D1's "sealing before the first judge call reuses the existing ordering receipt" |
| **R-3** | A hand check, where it happened, decides; a screen-agreed row the operator hand-excluded is **excluded** | §6.4 | D1's "admitted means screening agreed or hand-confirmed", whose literal disjunction would admit it |
| **R-4** | The verifier recomputes sample membership by the spec-defined `screening-sample/1` procedure, not by executing the sealed sampling script, and the recomputation wins on disagreement | §6.5 | D1's "sample membership from seed plus script over the frozen bank" |

R-3 and R-4 are here because the reviewer was right that they were larger deviations than R-1 and
R-2, and were carried silently while narrower ones were flagged. **This spec never absorbs an
operator ruling it is departing from; it names the departure and the reason and hands it back.**

**Ratified as ruled:** D1 (§6) and D2 (§7), **except** at R-1 through R-4, each of which names the
exact ruling sentence it reads on. No other clause of either ruling is reinterpreted anywhere in
this document.

**New findings requiring no decision but blocking the run if unimplemented:**

- **Arm cardinality (§1.6).** The panel is six arms; the compiler refuses anything but four at three
  lock sites and three report/publish sites, and at a seventh site it does not refuse at all: it
  publishes `armCount: 4` over whatever panel actually ran.
- **The verify package's second copies (§2.7 last row, §3.1 sites 9 to 11, §6.8).** The mirrored
  payload schema refuses every evidence-carrying item on the human-review path; the mirrored stratum
  schema refuses every four-category replacement-ledger entry; the bundle qualification document
  refuses a four-category or six-arm bundle at publish and at cold verify.
- **Three sites that publish a false value rather than refusing (§1.4, §1.6 site 8, §3.1 site 21).**
  `verify.ts:1621` writes `armCount: 4` over any panel; `binary-qualification.ts:23` writes the
  mutable-alias limitation over a dated snapshot, and the cold verifier recomputes it and agrees;
  `assets.ts:372,637` caption a four-category `byStratum` block as `Core and stress buckets`. A
  refusal is visible and a false published number is not, so these outrank the refusal sites.
- **`binary-instrument-profile.ts:315` (§3.1 site 12).** `deriveAdmissionProfile` checks
  `verified.strata` at `:299` and then discards it, returning the hardcoded pair. A partial widening
  of this family passes its own gate and throws the result away.
- **The screened branch's publication grade is derived, not asserted (§6.8a).** §6.8's third
  `superRefine` branch, implemented exactly as specified and with nothing else changed, would refuse
  every screened bundle, because `publicationGrade` is computed as
  `truthAdmission === "two-human-unanimous"` at two sites and yields `false`.

**§10.2 is frozen.** The mechanical sweep completed and classified 214 sites across the four
families; its result is folded into §1.4, §1.6, §3.1, §6.8a, §8.3, §10.1, and the owning seam
inventories. The whole document is now frozen on merge.
