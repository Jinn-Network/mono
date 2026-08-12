# P4b — Product-side method selection: scoping report

| | |
|---|---|
| **Version** | 1.1 |
| **Date** | 2026-08-12 |
| **Author** | C3 (Statistics) lane, Demo-1 Venue-Glue Implementation Program |
| **Shape** | `design` — scoping report and budgeting basis; the task-level TDD plan is a separate document |
| **Status** | **RATIFIED — Option A. P4b is demo-blocking, full scope, in progress.** |
| **Recon base** | `packages/benchmark-product` @ `04f309de8`; **all citations re-verified against `9e8b39049`** (§0) |
| **Parent program** | [`2026-08-11-demo1-venue-glue-implementation-program.md`](../2026-08-11-demo1-venue-glue-implementation-program.md) |
| **Unblocked by** | P4 (`paired-delta@1` registration) — merged |

## 0. Ratification and citation re-verification

**Operator ruling (2026-08-12): Option A — P4b is demo-blocking, full scope, start now.**

- **Budget ratified** at the scoped ~9–10.5 agent-days across the seven tasks in §8.
- **Decisions §5.1, §5.2, §5.4 ratified** exactly as written.
- **Decision §5.3 (editorial posture) RATIFIED 2026-08-12.** The full paired
  report states the candidate-minus-baseline estimate, interval or withheld
  state, exact alpha `0.0500`, and paired Task count. Compact badge, social-card,
  and share surfaces contain no result number and link relatively to the full
  report. Wilson output remains byte-frozen.
- **Sequencing:** the *official run* gates on P4b. **P5 does not** — it proves
  pipes on the existing plumbing and proceeds in parallel.

### Citations re-verified against `9e8b39049`

The integration branch moved substantially after the recon base (#2578, #2580,
#2585, P4, and the Inspect OCI-runtime series all landed). Every site in §3 was
re-checked:

- **All six wilson sites survive**, with only minor line drift:
  `compile.ts:109` · `report.ts:140` (exact) · `claim.ts:192`
  (`wilsonSubjectResults`, was `:184`) · `claim.ts:38,50,106,129,262,277` ·
  `assets.ts:118,446-447` (exact) · `web/.../results/page.tsx:27,124` (exact).
- **One additional copy site found:** `assets.ts:318` carries a second
  "No comparative winner is stated" string in the Markdown variant, alongside
  `:249`. Both are in scope for §5.3.
- **§6.1 has changed and is now half-closed.** See that section.

## Why this document exists

The Demo-1 program assumed P4 (a paired statistics method) was the only
statistics-side work standing between the product and a paired demo report.
It is not. **The product can only ever use one method — `wilson@1` — because
that method is hardcoded across six production sites.** No packet in the
program owned closing that gap. P4b is that packet.

This report was commissioned as an operator gate before P4b is budgeted. Its
headline finding is that **P4b is roughly 9–10.5 agent-days, not the 3–4 the
program's shape implied** — a >3× overrun that fires the program's escalation
rule. It is reported rather than absorbed.

Every claim below is `path:line`-cited against the recon base and was
verified read-only.

---

## 1. Headline findings

1. **The `wilson@1` assumption is six production sites, not three.** The
   program named `compile.ts`, `report.ts`, and `claim.ts`'s
   `wilsonSubjectResults`. Two more are load-bearing and were missed — they
   are the ones that break `bundle publish` and `bundle verify` — plus the
   claim **schema** itself. See §3.
2. **`analysisPlan` is single-entry by product convention, not platform
   constraint.** The platform imposes no cardinality and
   `derivePreregistered` already iterates the array. The genuinely
   single-valued object is the **Report**, not the plan. See §4.
3. **Two one-way doors** — the published-bundle byte contract and the claim
   schema id. Both are cheap to respect and expensive to breach. See §7.
4. **The product's bundled sample benchmark destroys task provenance**, so no
   clustered paired method can run on the sample/demo path until it is fixed.
   This is adjacent to, and should be scoped with, the SWE-bench importer
   cluster-key defect found by the C4 lane. See §6.
5. **Nothing validates method ids at seal time.** A typo seals into an
   immutable Run and only fails at `report` time — after the run has executed.
   See §6.
6. **Four decisions require a human before an implementer starts.** Three have
   recommended answers below for ratification; the fourth is reserved for the
   operator because it is a brand-authority call, not an engineering one. See
   §5.

---

## 2. Blocking dependency

P4b cannot start until `paired-delta@1` exists in
`@jinn-network/benchmarking-aggregate`: the method URI in
`packages/benchmarking/records/src/identifiers.ts`, the registry entry in
`packages/benchmarking/aggregate/src/registry.ts`, and its `parameterSchema`.
That is packet P4, complete and in review at the time of writing.

One P4 outcome binds P4b directly: `paired-delta@1` declares
`task-provenance-source` in `requiredInputs` and calls `resolveTaskProvenance`,
which **fails closed** when provenance is absent. That is deliberate — see
§5.4 and §6.

---

## 3. The change set, end to end

### 3a. Draft authoring

`DraftSpec` has **no method or analysis field today**.

| Site | Change |
|---|---|
| `core/src/domain/draft.ts:146-157` (`DraftSpecSchema`) | Add the analysis-selection field. Closest existing analogue is `assurance` (`:65-68`). |
| `core/src/domain/draft.ts:162-174` (`DRAFT_SPEC_DEFAULTS`) | Typed `Omit<DraftSpec, "name"\|"description"\|"budget">`. A new **required** field must be defaulted here or every existing draft fails `parseDraftDocument`. |
| `core/src/operations/drafts.ts:35-45` (`DRAFT_SPEC_FIELD_NAMES`) | Patch allowlist — a new top-level field is silently un-patchable unless added. |
| `core/src/operations/inspect.ts:62,128-131` | Surface the selected method, for parity with `assurance.preset`. |

**No new operation is needed, and none should be added.** Both surfaces author
drafts through a generic JSON patch: CLI at `core/src/cli/main.ts:79,243,638`;
web at `web/src/app/workspace/[draftId]/page.tsx:20`, whose placeholder is
literally `{"assurance":{"preset":"direct-check"}}`. Adding a verb would
cascade into the pinned operation count at `core/src/docs-consistency.test.ts:77,87,195`,
`core/parity-matrix.v1.json`, and `core/src/cli/parity-map.ts:48,81,113,155`.

### 3b. Compile → sealed `analysisPlan`

- `core/src/run/compile.ts:107-113` — the hardcoded entry.
- `core/src/run/compile.ts:81-123` (`planFromSpec`) is the **sole shared
  tail**, so one edit covers quote (`operations/run-quote.ts:259`), lock
  (`operations/run-lock.ts:77`), and preview (`operations/preview.ts:179` via
  `compile.ts:229`).
- `core/src/run/compile.ts:37-45` — imports the method-id constants.
- **No platform-side validation exists.** `benchmarking/run/src/plan.ts:48`
  assigns `analysisPlan` verbatim; `benchmarking/records/src/run/schema.ts:48-52`
  shape-checks `{method, version, parameters}` as free strings. The product
  must add its own compile-time refusal.
- **Parameters are load-bearing for preregistration.** `produceReport` merges
  `{...parameters, verdictRule}` (`aggregate/src/report.ts:299`), throws on
  conflict (`:293-297`), then runs `validateParameters` (`:300-303`). Paired
  methods require `baseline` and `candidate`, so the sealed entry must carry
  them, and `derivePreregistered`'s exact-JSON equality (`:182-186`) is over
  the merged tuple.
- **Note the decimal-string rule.** Sealed records admit only exact I-JSON
  *integer* numbers (`records/src/json.ts:93-95`); fractional parameters are
  decimal strings by convention (`records/src/run/schema.ts:15-20`).
  `paired-delta@1`'s `alpha` is therefore the string `"0.05"`, not `0.05`.
  Whatever surface authors the analysis block must preserve that.

### 3c. Report production

- `core/src/operations/report.ts:140` — hardcoded
  `method: { id: BENCHMARKING_METHOD_IDS.wilson, version: …, parameters: {} }`.
  The product's only `produceReport` call site.
- `core/src/operations/report.ts:1-13` — module header written around
  `wilson@1`; must be rewritten.
- Crash-safety ordering (`:19-29`) is unaffected: method selection is a pure
  read before `produceReport`.

### 3d. Claim package

- `core/src/report/claim.ts:184-215` (`wilsonSubjectResults`) — throws on
  non-wilson shapes; consumed at `:277`, `:305`, `:308`.
- `core/src/report/claim.ts:49-54,129` — **the claim schema.**
  `headline: z.record(z.string(), HeadlineArmSchema)` mandates
  `{n, passRate, wilsonInterval}`. A paired report has no `arms` at all
  (contrast `registry.ts:333-337` with `:561-577`), and `writeClaimPackage`
  (`:339`) parses before writing, so this fails closed. **This is the hardest
  coupling in the packet.**
- `core/src/report/claim.ts:262` — `analysisPlan?.[0]?.parameters` for the
  `verdictRule` cross-check; must select the entry matching the produced
  method once the plan carries more than one.
- `core/src/report/claim.ts:38,106` — `CLAIM_PACKAGE_SCHEMA_ID` as a
  `z.literal`. See §7.

### 3e. Verification

- `core/src/verification/claim-consistency.ts:67` — same `[0]` extraction;
  refuses at `:68-70`.
- `:76-99` rebuilds the claim via `buildClaimPackage` and byte-compares.
  **This needs no new input**: the method is already carried by the sealed
  Report (`claim.ts:298-303` reads `reportRecord.method`), so dispatching
  inside `buildClaimPackage` keeps verification consistent automatically.
  `bundle/schema.ts:77-86` carries only `assurancePreset`/`rehearsal` —
  **nothing to add**. This is the single largest piece of good news here.
- Call sites: `operations/verify.ts:182-196`; `bundle/verify.ts:620-631`.
  `publish` runs both (`operations/publish.ts:63,86,102`).

### 3f. Bundle presentation — the sites the program missed

- `core/src/bundle/assets.ts:118-156` (`requireWilsonFacts`), called **twice**
  at `:446-447` — against `input.report.results` *and* `input.claim.results`.
  A paired Report throws, killing `bundle publish` **and** `bundle verify`.
- Hardcoded copy needing method-awareness: `:249`, `:255`, `:193`, `:293`.
- Producers/consumers: `bundle/materialize.ts:475-485`;
  `bundle/verify.ts:637-651`.

### 3g. Web

- `web/src/app/workspace/[draftId]/results/page.tsx:24-28,124` — dereferences
  `headline.wilsonInterval.low` **unconditionally**, no undefined guard.
- `:156-194,200` — the stored-Report half already degrades gracefully to a
  `role="alert"`. Only the claim half is unsafe.

### 3h. Docs and scripts

- `packages/benchmark-product/PUBLIC-BUNDLE.md:91`
- `packages/benchmark-product/design-system/ADAPTATION.md:18`
- `core/scripts/m1-walkthrough.mjs:222`

---

## 4. Is `analysisPlan` single-entry by convention or constraint?

**By product convention. The platform imposes no cardinality.**

- `records/src/run/schema.ts:76` — `z.array(...).optional()`, no
  `.min()`/`.max()`.
- `records/schemas/run.schema.json` — plain array, no `minItems`/`maxItems`.
- `benchmarking/run/src/plan.ts:19,48` — passes through verbatim.
- `aggregate/src/report.ts:182-186` — `derivePreregistered` uses `.some()`.
  **Multiple entries are explicitly supported.**
- In-repo precedent for N>1: `packages/policy-optimization/src/promotion.ts:113,176`.

Only two production sites index `[0]` — `claim.ts:262` and
`claim-consistency.ts:67` — both merely to read `verdictRule`, which is
identical across entries. Both are one-line fixes.

**The genuinely single-valued object is the Report.** One Report carries one
method (`aggregate/src/report.ts:317,324`), and the product is single-Report
throughout: `run/state.ts:66-69`, `workspace/layout.ts:98-100`,
`bundle/materialize.ts` (`PUBLIC_BUNDLE_FILES`), and one
`closed --report--> reported` transition in `domain/lifecycle.ts`.

**Recommendation:** seal **both** methods into `analysisPlan` — honest
preregistration at near-zero cost — but **produce one Report with the selected
method**. Two Reports would require multi-report plumbing through RunState,
layout, bundle manifest, verify, and the lifecycle table: a different and much
larger packet.

---

## 5. Design decisions

Three were ratified by the operator on 2026-08-12 exactly as written. The
fourth remains reserved.

### 5.1 Where do `baseline` and `candidate` come from? — **RATIFIED**

The draft's `arms` (`domain/draft.ts:152`) is unordered with no role concept;
`operations/arms.ts` has no baseline/candidate notion.

**Recommend: explicit `baseline` and `candidate` fields on the new analysis
block**, each validated at compile time to name an existing arm.

Rejected alternatives: positional (`arms[0]`/`arms[1]`) is fragile and
silently reinterprets the comparison if arms are reordered; a `role` field on
`ArmSchema` has a far wider blast radius, touching arm mapping and every arms
test, to express something that belongs to the analysis rather than the arm.

### 5.2 Claim `headline` shape for a paired method — **RATIFIED**

**Recommend: keep `CLAIM_PACKAGE_SCHEMA_ID` at `/1` and make the new fields
purely additive** — `headline` becomes optional, and a sibling `comparison`
block carries the paired shape. A wilson claim then serializes byte-identically
to today, which must be enforced by a **golden byte-equality regression test**
on the wilson path as part of the same task.

Rationale: bumping to `/2` makes every stored `claim-package.json`
unparseable at `operations/run-results.ts:277`, `operations/verify.ts:171`, and
`bundle/verify.ts` — a one-way door with no upside here, since nothing about
the paired shape requires removing or reinterpreting an existing field.

Note that `conflicted` is common to both method shapes (`registry.ts:333-337`
vs `:561-577`), so `claim.conflicted` survives unchanged; only the headline
needs an alternative. The `{perSubject: [...]}` envelope is itself
method-independent — every method is wrapped by `subjectScopedMethod`
(`registry.ts:1068-1107`) — so the existing `perSubject.length !== 1` guards
(`claim.ts:195`, `assets.ts:132`) are correct as-is and should stay.

### 5.3 Editorial posture for a directional result — **RATIFIED 2026-08-12**

The operator approved a method-specific posture: the paired full report names
the direction explicitly as candidate minus baseline and keeps the estimate,
interval status, exact alpha `0.0500`, and paired Task count together. Compact
badge/social/share artifacts contain no result number and link relatively to
the full report.

`bundle/assets.ts:249` states: *"No comparative winner is stated; wilson@1
reports neutral per-arm facts only."* `PUBLIC-BUNDLE.md:91` repeats the
commitment, and `design-system/ADAPTATION.md:18` extends it. The current
product posture is that it never asserts a comparative winner.

**A paired delta is inherently a directional statement.** Publishing one
changes what the product claims about itself. The replacement copy — and the
question of whether the posture is being narrowed, restated, or genuinely
changed — needs someone with brand authority. An implementer must not invent
it, and neither should this lane.

The full report does not promote the estimate into a winner, verdict, threshold,
or selection. It includes a separate limitation stating that this method
estimates an effect and does not gate one. Interval-withheld and power/MDE
limitations stay distinct.

Both copy sites are in scope: `assets.ts:249` (HTML) and `assets.ts:318`
(Markdown), plus `PUBLIC-BUNDLE.md:91` and `design-system/ADAPTATION.md:18`.

### 5.4 Does `paired-delta@1` need task provenance? — **RATIFIED**

**Yes, and it should stay that way: required, failing closed.**

`paired-delta@1` declares `task-provenance-source` in `requiredInputs` and
calls `resolveTaskProvenance`, which raises a typed `MethodInputError` when
provenance is missing.

Making provenance optional would silently disable the whole-source-cluster
bootstrap and collapse the standard errors that the clustering correction
exists to widen — the design's pinned clustering rule
(`docs/superpowers/specs/2026-07-28-benchmarking-application-design.md:741-746`)
names singleton collapse as manufacturing "the exact error understatement the
correction exists to fix." A paired report with silently narrow intervals is
worse than no paired report.

The consequence is the sample-benchmark gap in §6, which should be fixed
rather than worked around.

---

## 6. Findings that reach beyond P4b

### 6.1 The bundled sample benchmark destroys provenance — **half-closed**

**UPDATE (re-verified at `9e8b39049`):** the *interop* half of this finding is
**CLOSED**. PR #2585 changed the SWE-bench importer to a repo-level cluster key
— `source: \`https://github.com/${row.repo}\`` at
`benchmarking/interop/src/import/swebench.ts:88`, with the `@<base_commit>`
suffix removed — so imported slates now cluster by repository as intended.

**The product half below is UNCHANGED and still open**: `sample.ts:154` is
byte-identical at the new head. It remains unowned.

**CORRECTION (2026-08-12): this section's diagnosis was wrong twice, and the
product half is now closed as NOT-FIXABLE-BY-DESIGN rather than open.**

The text below said `sample.ts:154` "removes `payload.provenance`". It removes
nothing — the upstream fixture
(`task-supply/admission/fixtures/prediction-snapshot-v1/task.json`) carries no
`provenance` key at all. Provenance would have to be *synthesized*, not
preserved, so the prescribed "merge rather than replace" fix was a no-op.

Synthesis is then blocked by a genuine contract conflict:

- `task-supply/admission/src/prediction-snapshot.ts:159-160` requires
  `Object.keys(payload).sort().join(",") === "forecast"` — the payload must be
  **exactly** `{forecast}`. `:125` likewise closes the Task object to exactly
  `evaluation,instructions,outputs,payload,profile,protocol`.
- `records/src/benchmark/checks.ts:56-58` reads provenance from **exactly one
  location**, `task.data.payload["provenance"]`, with no fallback.

**Documented architectural constraint:** *prediction-forecast tasks
structurally cannot carry payload provenance under the frozen
`PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1`, and therefore cannot be scored by
any clustered paired method (`paired-delta@1`, `paired-mcnemar@1`,
`provenance-cluster-sign@1`). This is a contract conflict, not an oversight.*
The bundled sample benchmark can never demo a paired method.

Amending the frozen policy, or weakening `sample.ts`'s admission sanity call,
were both considered and rejected — see the implementation plan's Task 8a
section. The open product question (*should prediction-forecast tasks be
paired-scoreable?*) is filed as a separate `design` issue and is explicitly not
scoped into this program.

**Consequence:** no clustered paired method can run on the sample/demo path.
SWE-bench-imported tasks do carry provenance
(`benchmarking/interop/src/import/swebench.ts:68-71`), so the real demo slate
is unaffected — but any rehearsal or preview on the sample benchmark is. P4b
Task 8b therefore builds its own `repository-work`-profile fixtures rather than
relying on the sample.

The original text follows, retained as the record of what was believed:

This originally compounded with the C4-lane finding that the SWE-bench importer
built its cluster key as `https://github.com/<repo>@<base_commit>`, making every
task its own singleton cluster. **#2585 closed that half.** The remaining
product-side half no longer needs a joint packet and can be absorbed as a small
standalone fix — but it must land before any rehearsal or preview runs a paired
method on the sample benchmark, or the method will fail closed with a typed
provenance error rather than producing a result.

### 6.2 No seal-time validation of method ids

`benchmarking/run/src/plan.ts:48` and `records/src/run/schema.ts:48-52` accept
any strings. A typo'd or unregistered method id seals into an immutable Run and
only fails at `report` time (`aggregate/src/report.ts:276`, surfaced as
`record-integrity` by `operations/report.ts:149-153`) — **after the run has
been executed and paid for.**

The compile-time refusal in Task 2 below is therefore not polish; it is the
guard against burning an entire run on a typo. Worth considering whether the
platform should also refuse unregistered ids at plan time, as a separate
platform-side issue.

---

## 7. Risks and one-way doors

| Risk | Detail | Mitigation |
|---|---|---|
| **Published-bundle byte invalidation** | `bundle/verify.ts:637-651` recomputes `buildPublicAssets` and byte-compares. **Any** change to `assets.ts` output — even whitespace — makes every previously published bundle fail `bundle verify`. `BUNDLE_FORMAT` (`bundle/manifest.ts:17`) has no presentation-version negotiation. | Golden byte-equality test on the wilson path proving output is unchanged; all paired markup additive and branch-gated. If wilson bytes must change, that is a format bump and a larger conversation. |
| **Claim schema id is a `z.literal`** | `claim.ts:38,106`. `/2` makes every stored claim unparseable (`run-results.ts:277`, `verify.ts:171`, `bundle/verify.ts`). | Per §5.2: stay at `/1`, additive fields only. Decide before any code lands. |
| **Sealed Run bytes change for new runs** | A second `analysisPlan` entry changes the sealed Run's canonical bytes and digest. Existing sealed Runs are immutable content-addressed bytes and are unaffected — but tests with pinned Run digests will break. | Grep for pinned run digests before Task 2. `run-path.integration.test.ts:135` is the known one. |
| **Ordering dependency** | Task 4 (claim schema) must land before Task 5 (assets), since `buildPublicAssets` consumes `input.claim.results` (`assets.ts:447`). Task 2 before Task 3. | Enforce the task order in §8. |
| **Non-replayable write** | `operations/report.ts:196-207` — the `closed → reported` transition is the one irreversible write; everything fallible runs before it. | No mitigation needed. It is the reason to keep new throws inside `buildClaimPackage`, before the transition. |

---

## 8. Recommended plan shape

Each task is one TDD cycle, in dependency order. Estimates are agent-days for
an implementer holding this report.

| # | Task | Est. | Acceptance criteria |
|---|---|---|---|
| **0** | **BLOCKING (P4, not this packet):** `paired-delta@1` registered. | — | Registry returns the method; its `parameterSchema` is known to P4b. |
| **1** | `DraftSpec` gains the analysis-selection block (method id + version + `baseline`/`candidate`), defaulted to wilson, patchable. Files: `domain/draft.ts:146,162`; `operations/drafts.ts:35`. | **0.5** | A draft patches to `paired-delta` and round-trips through `parseDraftDocument`; an existing draft without the field still parses; the field is reachable through the generic patch path from both CLI and web. |
| **2** | `planFromSpec` builds `analysisPlan` from the spec (both entries per §4), with compile-time refusals for an unregistered method and for a paired method whose `baseline`/`candidate` do not name two existing arms. Files: `run/compile.ts:81-123`. | **1.0** | The sealed Run carries both entries with exact parameters (`alpha` as a decimal string); both refusals fire with typed errors; quote, lock, and preview all inherit the behavior through the shared tail. |
| **3** | `report.ts` selects the method from the sealed plan and passes matching parameters. Files: `operations/report.ts:140` + header. | **1.0** | A paired-selected draft produces a Report with `method.id === "…/paired-delta"` **and `preregistered === true`** — the exact-JSON tuple equality is the whole point and is easy to get subtly wrong. |
| **4** | Claim schema and builder become method-dispatching. Files: `report/claim.ts:49-54,129,184-215,262,277,305,308`; `verification/claim-consistency.ts:67`. | **2.0–3.0** | A paired Report builds a claim; **a wilson Report builds a byte-identical claim to today** (golden regression); `assertClaimConsistency` round-trips both; schema id stays `/1`. |
| **5** | Bundle assets become method-dispatching. Files: `bundle/assets.ts:118-156,193,249,255,293,446-447`. | **2.0** | A paired bundle materializes and verifies; **wilson bundle bytes are unchanged** (golden byte assertion); ratified §5.3 copy applies only to the paired branch. |
| **6** | Web renders both shapes; `inspect` shows the selected method. Files: `web/.../results/page.tsx:24-28,124`; `operations/inspect.ts:128`. | **1.0** | RTL renders a paired claim and a wilson claim; no unguarded dereference of `wilsonInterval`. |
| **7** | End-to-end integration + docs. Extend `run-path.integration.test.ts`; update `PUBLIC-BUNDLE.md:91`, `ADAPTATION.md:18`, `m1-walkthrough.mjs:222`. | **1.5** | A paired draft runs create → arms → lock → launch → collect → report → verify → publish → bundle verify with no manual intervention. |

**Total: ~9–10.5 agent-days**, excluding the blocking platform packet and
excluding the §6.1 sample-benchmark fix (~1 day more if scoped here rather
than into a provenance-integrity packet).

For comparison, the three sites the program originally named account for
roughly 2.5 of those days. The remaining ~7 are the claim schema, the bundle
presentation layer with its byte-compatibility door, and the e2e/docs tail.

---

## 9. Test blast radius

**Must change** — pin wilson literals or the wilson shape:

- `core/src/run/compile.test.ts:147,163-165` — asserts the exact single-entry `analysisPlan`.
- `core/src/report/claim.test.ts:64,93,185,271,294` — `:294` asserts `claim.headline` deep-equals `results.perSubject[0].results.arms`.
- `core/src/bundle/assets.test.ts:64-65,85,136,238` — **exact literal output strings**: `:219` `"No comparative winner is stated"`, `:220-221` `"0.3333"`/`"0.6667"`, `:236-237` `"0.0615"`/`"0.9385"`, `:238` the wilson URI, `:232` `"Sealed Report arm results"`, `:222` `not.toMatch(/candidate (wins|beats|is best)/iu)`.
- `core/src/run/assurance-presets.integration.test.ts:120-137,306-308,346-360,414-431`.
- `core/src/run/run-path.integration.test.ts:135-136`.
- `core/src/operations/report.test.ts:322-339,1106,1138,1191-1195`.
- `core/src/report/ports.test.ts:21-25`.
- `web/src/app/workspace/[draftId]/results/page.test.tsx:97,103,115-116,161,171` — **exact literal strings**.

**Likely touched:** `operations/run-results.test.ts:629-631`,
`run/run-cancel.integration.test.ts:141-147`, `operations/verify.test.ts`,
`operations/preview-disclosure.test.ts`, `operations/preview-purity.test.ts`,
`cli/cli-lifecycle.integration.test.ts`, `index.test.ts`,
`cli/parity-matrix.test.ts`, `web/src/app/actions.integration.test.ts`,
`web/browser/production-flow.spec.ts`.

**Non-obvious tripwires:** `core/src/docs-consistency.test.ts:77,87,195` (the
27-operation pin) and `core/src/cli/lexicon.test.ts:15` (`BANNED_LEXICON` —
`delta`, `baseline`, and `candidate` are all clear).

---

## 10. Recommendation — superseded by the §0 ruling

The recommendation this report closed with was to budget P4b as a separate
packet and to make one scoping choice explicitly: P4b is not on the critical
path to the demo report's *statistics* (P4 delivers those), but it is on the
critical path to the product *producing* the report through its own machinery
rather than by hand. If the first report could be assembled outside the
product, P4b could follow the demo instead of blocking it.

**The operator ruled Option A: it blocks.** The demo report will be produced
through the product's own machinery, so P4b is demo-blocking and proceeds at
full scope. The remaining items from that recommendation resolve as:

1. §5.1, §5.2, §5.4 — **ratified** (§0).
2. Budget — **ratified** at ~9–10.5 agent-days against §8.
3. §6.1 — the joint provenance-integrity packet is **no longer needed**; #2585
   closed the interop half. The product-side half is a small standalone fix that
   must precede any paired rehearsal on the sample benchmark.
4. §6.2 — still worth filing as a separate platform-side issue; not in this
   packet's scope.
5. §5.3 — **ratified 2026-08-12**: the full report carries the directional
   estimate, interval state, exact alpha, and paired Task count; compact result
   surfaces are result-number-free and link to the full report.
