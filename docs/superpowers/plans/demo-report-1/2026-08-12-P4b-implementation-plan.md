# P4b — Product-side method selection: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the benchmark product select, seal, produce, and present a report from a method other than `wilson@1` — specifically `paired-delta@1` — without changing a single byte of any wilson-path output.

**Architecture:** Additive-only, in two stacked PRs. The draft gains an *optional* analysis block (mirroring the existing optional `evaluationRuntime` field), which `planFromSpec` turns into a two-entry sealed `analysisPlan`. The report operation selects from that plan. The claim package and bundle assets then dispatch on the produced Report's method, with the wilson shapes preserved byte-for-byte and guarded by golden tests that land *before* any mutation.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Zod schemas, Vitest, React Testing Library, Node 22, Yarn 4 workspaces. Package: `packages/benchmark-product` (`core` + `web`).

**Scoping report / plan of record:** [`P4b-scoping.md`](./P4b-scoping.md) — read §0 (ratification), §3 (the six sites), §5 (ratified decisions), §7 (one-way doors). This plan implements its §8 task table.

**Base:** `integration/evidence-v1` @ `9e8b39049`. All line numbers below were re-verified at that commit.

## Global Constraints

- **Wilson output is byte-frozen.** Every wilson-path artifact — claim package JSON and every published bundle asset — must serialize byte-identically to today. `bundle/verify.ts:637-651` recomputes assets and byte-compares, so any drift, even whitespace, invalidates every previously published bundle. Golden tests enforce this and land before any mutation (Task 4).
- **Claim schema id stays `benchmark-product.claim-package/1`** (`report/claim.ts:38,106`). New fields are additive and optional only. Ratified §5.2.
- **No publish-facing surface goes directional.** Build the entire paired path behind the product's existing neutral copy. `bundle/assets.ts:249` (HTML) and `:318` (Markdown) both carry "No comparative winner is stated" — neither changes in this packet. Ratified §5.3; a method-stream copy agent drafts replacements for operator sign-off, triggered when Task 5 begins.
- **No product-implemented statistics.** Every number comes from a `BENCHMARKING_METHOD_REGISTRY` method. The product selects and presents; it never computes.
- **Fractional method parameters are decimal strings.** Sealed records admit only exact I-JSON integers (`benchmarking/records/src/json.ts:93-95`). `paired-delta@1`'s `alpha` is the string `"0.05"`. A raw number crashes `sealRun`.
- **Provenance is required and fails closed** (ratified §5.4). `paired-delta@1` calls `resolveTaskProvenance`. The bundled sample benchmark destroys provenance at `core/src/intake/sample.ts:154`, so no paired run works on the sample path — out of scope here, tracked in scoping §6.1.
- **Fixtures are append-only** — supersede with an erratum, never rewrite.
- **Exhaustive-negative claims need whole-repo sweeps**, including `packages/policy-optimization`.
- **American English** in identifiers and copy (repo Rule 5).

## PR structure — two stacked PRs

**AMENDED 2026-08-12 (coordinator-approved re-scope). The original 1,2,3 / 4-8 split was wrong; the table below supersedes it.**

| PR | Tasks | Scope | Why the seam is here |
|---|---|---|---|
| **A — selection through claim** | 1, 2, 4, 5, then 3-completion | Draft field → sealed `analysisPlan` → Report produced with the selected method → claim package built from it, guards landing first | `runReport` is ONE operation spanning report production *and* claim building. This is the smallest boundary at which the capability actually works end to end. |
| **B — presentation** | 6, 7, 8 | Bundle assets, web, e2e + docs | All remaining byte-risk, fenced behind guards that already exist from PR A's Task 4. |

**The golden byte-equality guard (Task 4) is still the first task to touch this area, and still touches no production code.** It lands before the first commit that modifies `claim.ts` or `assets.ts`, satisfying the ratified guard-before-mutation constraint — which is exactly why Task 4 moved into PR A alongside Task 5 rather than Task 5 moving alone.

### Why the original split failed — recorded so the reasoning is reviewable

The first version of this plan split "produce the Report with the selected method" (Task 3) from "method-dispatching claim package" (Task 5) across two PRs. **That seam does not exist in the code.**

`operations/report.ts` produces the Report at `:144`, seals it at `:166-167`, then calls `buildClaimPackage` **unconditionally** at `:174`. `buildClaimPackage` calls `wilsonSubjectResults`, which throws at `report/claim.ts:206` for any results lacking wilson's `arms` shape. A selected non-wilson method therefore produces and seals a *correct* Report and then dies one step later inside the same function. This affects **every** non-wilson method, not only `paired-delta`: `avg-at-k@1` fails a step later at `HeadlineArmSchema`.

Found by the Task 3 implementer, which got a true RED for the right reason, made the Step-3 production change (correct, typecheck clean, 21 of 22 tests passing), then refused either to delete the failing test or to reach into `claim.ts` unauthorized, and stopped and reported. That was the right call and it is why the defect surfaced at implementation time rather than at review.

Two alternatives were considered and **rejected**:

- **(a) Fold a minimal `claim.ts` guard into Task 3.** Rejected: it breaks the ratified guard-before-mutation rule, which requires Task 4's golden byte guards to land before anything touches `claim.ts`.
- **(b) Narrow Task 3's paired test to assert that the operation *fails* with a documented reason.** Rejected: it would ship a PR A whose headline capability provably does not work, and bank a passing test on broken behavior. An honest characterization of a broken state is still a green test standing in for a capability we claimed to deliver.

The Task 3 production change survives the re-scope unaltered under every option considered, so no implementation work was lost — only the ordering changed. Task 3's *test* completes after Task 5 makes the whole operation succeed, which is why it appears as "3-completion" at the end of PR A.

## Worktree and branch protocol

Each implementer works in **its own worktree on its own branch**, never the coordinator's. Because a branch cannot be checked out in two worktrees at once, tasks chain:

```bash
# coordinator creates, per task N, off the previous task's tip
git worktree add ../jinn-mono_worktrees/p4b-tN -b claude/demo1-p4b-tN <previous-tip>
```

The implementer commits in its own worktree only, using `git -C "<its worktree>"`. The coordinator fast-forwards the PR branch after each task and verifies every worktree is clean before dispatching the next.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `core/src/domain/draft.ts:165-177` | Optional `analysis` block on `DraftSpecSchema` | 1 |
| `core/src/operations/drafts.ts:35-46` | Patch allowlist | 1 |
| `core/src/run/compile.ts:107-113` | Build `analysisPlan` from the spec; compile-time refusals | 2 |
| `core/src/operations/report.ts:140` | Select the method from the sealed plan | 3 |
| `core/src/report/claim.test.ts`, `core/src/bundle/assets.test.ts` | Golden byte guards (no production change) | 4 |
| `core/src/report/claim.ts:49-54,129,192-215,262,277` | Method-dispatching claim builder | 5 |
| `core/src/verification/claim-consistency.ts:67` | Select the matching plan entry | 5 |
| `core/src/bundle/assets.ts:118-156,446-447` | Method-dispatching asset rendering | 6 |
| `web/src/app/workspace/[draftId]/results/page.tsx:24-28,124` | Render both claim shapes | 7 |
| `core/src/run/run-path.integration.test.ts`, docs | End-to-end + documentation | 8 |

## Design decisions locked before implementation

1. **The `analysis` field is OPTIONAL, not required.** Precedent: `evaluationRuntime` (`draft.ts:176`) is optional and deliberately absent from `DRAFT_SPEC_DEFAULTS` (`:182-194`). An absent `analysis` means `wilson@1` — exactly today's behavior — so **every existing draft keeps parsing and `DRAFT_SPEC_DEFAULTS` is not touched at all.** This is a refinement of scoping §3a, which assumed a required field needing a default; optional is strictly lower-risk and removes a migration concern.
2. **`analysisPlan` carries two entries** — `wilson@1` always, plus the selected paired method when one is chosen. Honest preregistration at near-zero cost (scoping §4). Consumers that read `analysisPlan?.[0]` for `verdictRule` keep working because `verdictRule` is identical across entries; Task 5 makes them select by method rather than by index.
3. **One Report per Run, carrying one method.** Two Reports would require multi-report plumbing through RunState, layout, bundle manifest, verify, and the lifecycle table — a different and much larger packet (scoping §4).
4. **Additive optional claim fields under schema id `/1`.** Precedent: the `rehearsal` block (`claim.ts:142-144`), whose own comment reads "Optional and additive; absent on every claim package built before this change." `headline` becomes optional; a sibling `comparison` block carries the paired shape.

---

## PR A — selection

### Task 1: Optional analysis block on the draft spec

**Files:**
- Modify: `packages/benchmark-product/core/src/domain/draft.ts:165-177`
- Modify: `packages/benchmark-product/core/src/operations/drafts.ts:35-46`
- Test: `packages/benchmark-product/core/src/domain/draft.test.ts`, `packages/benchmark-product/core/src/operations/drafts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AnalysisSchema` / `DraftSpec["analysis"]`, shape
  `{ method: string; version: string; baseline?: string; candidate?: string; parameters?: Record<string, unknown> }`, all optional at the top level. Consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Add to `packages/benchmark-product/core/src/domain/draft.test.ts`:

```ts
  test("accepts an optional analysis block naming a paired method and its two arms", () => {
    const spec = DraftSpecSchema.parse({
      ...validSpecFixture(),
      analysis: {
        method: "jinn.benchmarking.method/paired-delta",
        version: "1",
        baseline: "armA",
        candidate: "armB",
        parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
      },
    });
    expect(spec.analysis?.method).toBe("jinn.benchmarking.method/paired-delta");
    expect(spec.analysis?.parameters?.["alpha"]).toBe("0.05");
  });

  test("keeps parsing a spec with no analysis block, and adds no default for it", () => {
    const spec = DraftSpecSchema.parse(validSpecFixture());
    expect(spec.analysis).toBeUndefined();
    expect(DRAFT_SPEC_DEFAULTS).not.toHaveProperty("analysis");
  });
```

Use the file's existing valid-spec helper; if it has none, build the object inline from `DRAFT_SPEC_DEFAULTS` plus `name`.

Add to `packages/benchmark-product/core/src/operations/drafts.test.ts`:

```ts
  test("permits patching the analysis field", async () => {
    const draft = await createDraftFixture();
    const patched = await patchDraft({ draftId: draft.draftId, patch: {
      analysis: { method: "jinn.benchmarking.method/paired-delta", version: "1", baseline: "armA", candidate: "armB" },
    } });
    expect(patched.spec.analysis?.candidate).toBe("armB");
  });
```

Adapt the helper names to the file's existing patterns.

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/benchmark-product/core && yarn vitest run src/domain/draft.test.ts src/operations/drafts.test.ts
```

Expected: FAIL — `analysis` stripped by the schema; the patch rejected as an unknown key.

- [ ] **Step 3: Add the schema**

In `packages/benchmark-product/core/src/domain/draft.ts`, above `DraftSpecSchema`:

```ts
/**
 * Which registered §9.2 method produces this run's Report. Optional and additive: an absent
 * block means `wilson@1`, exactly the behavior every draft had before this field existed, so
 * no default is added to DRAFT_SPEC_DEFAULTS and no stored draft needs migrating.
 *
 * `baseline`/`candidate` are explicit rather than positional over `arms` (ratified decision
 * §5.1): arms are unordered, and a positional reading would silently reinterpret the comparison
 * if they were ever reordered. `parameters` are sealed verbatim into the Run's analysisPlan, so
 * fractional values must be decimal strings — sealed records admit only I-JSON integers.
 */
export const AnalysisSchema = z.object({
  method: z.string().min(1),
  version: z.string().min(1),
  baseline: z.string().min(1).optional(),
  candidate: z.string().min(1).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
```

Add one field to `DraftSpecSchema`, after `evaluationRuntime`:

```ts
  analysis: AnalysisSchema.optional(),
```

**Do not touch `DRAFT_SPEC_DEFAULTS`.**

- [ ] **Step 4: Add the patch allowlist entry**

In `packages/benchmark-product/core/src/operations/drafts.ts`, add `"analysis",` to `DRAFT_SPEC_FIELD_NAMES` after `"evaluationRuntime"`.

- [ ] **Step 5: Run to verify they pass**

```bash
cd packages/benchmark-product/core && yarn vitest run src/domain/draft.test.ts src/operations/drafts.test.ts && yarn typecheck
```

Expected: PASS, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/benchmark-product/core/src/domain/draft.ts \
        packages/benchmark-product/core/src/domain/draft.test.ts \
        packages/benchmark-product/core/src/operations/drafts.ts \
        packages/benchmark-product/core/src/operations/drafts.test.ts
git commit -m "feat(benchmark-product): accept an optional analysis block on the draft spec"
```

---

### Task 2: Compile the analysis block into a sealed `analysisPlan`

**Files:**
- Modify: `packages/benchmark-product/core/src/run/compile.ts:81-123` (`planFromSpec`)
- Test: `packages/benchmark-product/core/src/run/compile.test.ts:147-175`

**Interfaces:**
- Consumes: `DraftSpec["analysis"]` (Task 1).
- Produces: a sealed Run whose `analysisPlan` is `[wilson, <selected>]` when an analysis block names a non-wilson method, and `[wilson]` otherwise. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `packages/benchmark-product/core/src/run/compile.test.ts`:

```ts
  test("seals both wilson and the selected paired method into analysisPlan", async () => {
    const compiled = await compileDraftFixture({
      arms: [{ armId: "armA", pinning: {} }, { armId: "armB", pinning: {} }],
      analysis: {
        method: "jinn.benchmarking.method/paired-delta", version: "1",
        baseline: "armA", candidate: "armB",
        parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
      },
    });
    expect(compiled.plannedRun.record.analysisPlan).toEqual([
      { method: "jinn.benchmarking.method/wilson", version: "1", parameters: { verdictRule: "sole" } },
      { method: "jinn.benchmarking.method/paired-delta", version: "1", parameters: {
        verdictRule: "sole", baseline: "armA", candidate: "armB",
        seed: 123456789, resamples: 1000, alpha: "0.05",
      } },
    ]);
  });

  test("refuses an unregistered method at compile time", async () => {
    await expect(compileDraftFixture({
      analysis: { method: "jinn.benchmarking.method/does-not-exist", version: "1" },
    })).rejects.toThrow(/not a registered method/i);
  });

  test("refuses a paired method whose baseline or candidate does not name an arm", async () => {
    await expect(compileDraftFixture({
      arms: [{ armId: "armA", pinning: {} }, { armId: "armB", pinning: {} }],
      analysis: {
        method: "jinn.benchmarking.method/paired-delta", version: "1",
        baseline: "armA", candidate: "armZ",
        parameters: { seed: 1, resamples: 10, alpha: "0.05" },
      },
    })).rejects.toThrow(/candidate/i);
  });

  test("refuses parameters the method's own schema rejects", async () => {
    await expect(compileDraftFixture({
      arms: [{ armId: "armA", pinning: {} }, { armId: "armB", pinning: {} }],
      analysis: {
        method: "jinn.benchmarking.method/paired-delta", version: "1",
        baseline: "armA", candidate: "armB",
        parameters: { seed: 1, resamples: 10, alpha: 0.05 },
      },
    })).rejects.toThrow(/alpha/i);
  });
```

The last test is the one that matters most: `alpha: 0.05` as a raw number is exactly the defect the benchmarking conformance kit caught during P4. It must be refused at compile time, not at seal time, because a seal-time failure happens after the operator has committed to the run. Adapt `compileDraftFixture` to the file's existing helper (`compile.test.ts` already builds drafts around `compileDraft`).

**Corrected plan-level oversight (found in review, applied in the P4b-T3 fix pass):** the `parameters` object below spreads `...(analysis.parameters ?? {})` **last**, which lets a caller-supplied `analysis.parameters.baseline` / `.candidate` / `.verdictRule` silently override the values this function just validated — a non-arm `baseline` seals straight into the immutable Run, and a conflicting `verdictRule` only detonates later at report time. The implementation must refuse (not silently strip, not merely reorder the spread) when `analysis.parameters` carries any of the three reserved keys `verdictRule`, `baseline`, `candidate`, with a test per reserved key. The step-level code sample below is left as originally written for the historical record; do not implement it as shown.

Also **keep the existing single-entry assertion at `:163-169` passing unchanged** for a draft with no analysis block — that is the backward-compatibility guarantee.

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/benchmark-product/core && yarn vitest run src/run/compile.test.ts
```

Expected: FAIL — `analysisPlan` still hardcoded to a single wilson entry; no refusals exist.

- [ ] **Step 3: Implement**

In `packages/benchmark-product/core/src/run/compile.ts`, replace the hardcoded `analysisPlan` array at `:107-113` with a call to a new local helper, and add the helper above `planFromSpec`:

```ts
/**
 * The sealed analysis plan. `wilson@1` is always present — it is the product's baseline read and
 * every existing consumer expects it — and a selected non-wilson method is appended, so the plan
 * honestly pre-registers both analyses at lock.
 *
 * Refusals happen HERE, at compile time, deliberately. Neither `planRun` nor the records schema
 * validates method ids (`benchmarking/run/src/plan.ts:48`, `records/src/run/schema.ts:48-52`
 * accept free strings), so an unregistered id or a malformed parameter would otherwise seal into
 * an immutable Run and only fail at `report` time — after the run has been executed and paid for.
 */
function buildAnalysisPlan(spec: DraftSpec, verdictRule: VerdictRuleName): RunAnalysisPlanEntry[] {
  const wilson = {
    method: BENCHMARKING_METHOD_IDS.wilson,
    version: BENCHMARKING_METHOD_VERSION,
    parameters: { verdictRule },
  };
  const analysis = spec.analysis;
  if (analysis === undefined || analysis.method === BENCHMARKING_METHOD_IDS.wilson) return [wilson];

  const method = BENCHMARKING_METHOD_REGISTRY.get(analysis.method, analysis.version);
  if (method === undefined) {
    refuse("validation", "spec", `analysis.method "${analysis.method}@${analysis.version}" is not a registered method`);
  }
  if (method.computeAvailability !== "available") {
    refuse("validation", "spec", `analysis.method "${analysis.method}@${analysis.version}" is registered but its compute is unavailable`);
  }

  const armIds = new Set(spec.arms.map((arm) => arm.armId));
  const needsPair = method.parameterSchema.required.includes("baseline")
    || method.parameterSchema.required.includes("candidate");
  if (needsPair) {
    for (const role of ["baseline", "candidate"] as const) {
      const armId = analysis[role];
      if (armId === undefined) {
        refuse("validation", "spec", `analysis.${role} is required by ${analysis.method} but is absent`);
      }
      if (!armIds.has(armId)) {
        refuse("validation", "spec", `analysis.${role} "${armId}" does not name an arm of this draft`);
      }
    }
  }

  const parameters = {
    verdictRule,
    ...(analysis.baseline === undefined ? {} : { baseline: analysis.baseline }),
    ...(analysis.candidate === undefined ? {} : { candidate: analysis.candidate }),
    ...(analysis.parameters ?? {}),
  };
  const validated = method.validateParameters(parameters);
  if (!validated.ok) {
    refuse("validation", "spec", `analysis.parameters rejected by ${analysis.method}: ${validated.issues.join("; ")}`);
  }
  return [wilson, { method: analysis.method, version: analysis.version, parameters }];
}
```

Then at `:107-113`:

```ts
      analysisPlan: buildAnalysisPlan(spec, resolvedAssurance.verdictRule),
```

Import `BENCHMARKING_METHOD_REGISTRY` from `@jinn-network/benchmarking-aggregate` alongside the existing `BENCHMARKING_METHOD_IDS` import from `@jinn-network/benchmarking-records` (`compile.ts:37-45`). Derive the entry and verdict-rule types from what `planRun` already accepts rather than inventing new ones; if no exported name fits, define a local `type RunAnalysisPlanEntry = { method: string; version: string; parameters: Record<string, unknown> }`.

- [ ] **Step 4: Run to verify they pass**

```bash
cd packages/benchmark-product/core && yarn vitest run src/run/compile.test.ts && yarn typecheck
```

Expected: PASS, including the untouched single-entry assertion.

- [ ] **Step 5: Run the quote / lock / preview integration suites**

```bash
cd packages/benchmark-product/core && yarn vitest run src/run src/operations
```

`planFromSpec` is the shared tail for quote, lock, and preview, so all three inherit this change. Expected: PASS. If a pinned Run digest fails, that is a real consequence — a second plan entry changes the sealed bytes for drafts that select one. Report it rather than editing the pin.

- [ ] **Step 6: Commit**

```bash
git add packages/benchmark-product/core/src/run/compile.ts packages/benchmark-product/core/src/run/compile.test.ts
git commit -m "feat(benchmark-product): compile the selected analysis method into the sealed plan"
```

---

### Task 3: Produce the Report with the selected method

**Files:**
- Modify: `packages/benchmark-product/core/src/operations/report.ts:140` and the module header `:1-13`
- Test: `packages/benchmark-product/core/src/operations/report.test.ts`

**Interfaces:**
- Consumes: the sealed two-entry `analysisPlan` (Task 2).
- Produces: a Report record whose `method.id` is the selected method and whose `preregistered` is `true`. Consumed by PR B.

- [ ] **Step 1: Write the failing test**

```ts
  test("produces the Report with the selected paired method and derives preregistered", async () => {
    const { reportRecord } = await runReportFixture({
      analysis: {
        method: "jinn.benchmarking.method/paired-delta", version: "1",
        baseline: "armA", candidate: "armB",
        parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
      },
    });
    expect(reportRecord.method.id).toBe("jinn.benchmarking.method/paired-delta");
    expect(reportRecord.method.parameters).toMatchObject({ alpha: "0.05", baseline: "armA", candidate: "armB" });
    // The whole point: the produced tuple must be exactly-JSON-equal to a sealed plan entry.
    expect(reportRecord.preregistered).toBe(true);
  });

  test("still produces a wilson Report, preregistered, when no analysis block is set", async () => {
    const { reportRecord } = await runReportFixture({});
    expect(reportRecord.method.id).toBe("jinn.benchmarking.method/wilson");
    expect(reportRecord.preregistered).toBe(true);
  });
```

`preregistered: true` is the assertion that catches subtle breakage. `derivePreregistered` (`benchmarking/aggregate/src/report.ts:182-186`) compares the produced `{method, version, parameters}` tuple against sealed plan entries with exact JSON equality, and `produceReport` merges `{...parameters, verdictRule}` (`:299`) and throws on conflict (`:293-297`). If the selected parameters are assembled even slightly differently from what Task 2 sealed, this silently becomes `false`.

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/benchmark-product/core && yarn vitest run src/operations/report.test.ts
```

Expected: FAIL — `method.id` is wilson regardless of selection.

- [ ] **Step 3: Implement**

In `packages/benchmark-product/core/src/operations/report.ts`, select the last plan entry (the selected method when present, wilson otherwise) instead of hardcoding at `:140`:

```ts
  // The sealed plan is [wilson] or [wilson, selected] (see run/compile.ts's buildAnalysisPlan).
  // The selected method is the last entry; passing its EXACT sealed parameters is what makes
  // derivePreregistered's exact-JSON comparison succeed.
  const planEntries = runRecord.analysisPlan ?? [];
  const selected = planEntries[planEntries.length - 1];
  if (selected === undefined) {
    refuse("record-integrity", "run", "sealed Run carries no analysisPlan entry to report from");
  }
```

and pass `method: { id: selected.method, version: selected.version, parameters: selected.parameters }`. Pass the `verdictRule` exactly as today — `produceReport` merges it and throws on conflict, so do not also include it in `parameters` if it is already there; strip it from the passed parameters if the merge conflicts.

Rewrite the module header at `:1-13`, which currently states the operation recomputes `wilson@1`. It must now say the operation recomputes whichever method the sealed plan selected, and that the crash-safety ordering (`:19-29`) is unaffected because selection is a pure read before `produceReport`.

- [ ] **Step 4: Run to verify it passes**

```bash
cd packages/benchmark-product/core && yarn vitest run src/operations && yarn typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/core/src/operations/report.ts packages/benchmark-product/core/src/operations/report.test.ts
git commit -m "feat(benchmark-product): produce the Report with the plan-selected method"
```

---

### PR A readiness

```bash
cd packages/benchmark-product/core && yarn typecheck && yarn vitest run
cd ../web && yarn vitest run
```

Both green, plus a three-dot merge-base diff review (`git diff <merge-base>...HEAD`). PR body records the full local chain per the program's CI-blindness rule, and states plainly that **no publish-facing surface changed in PR A**.

---

## PR B — presentation

### Task 4: Golden byte-equality guards (no production change)

**This task must land before any commit that modifies `claim.ts` or `assets.ts`.** It changes no production code; it characterizes current output so the later tasks cannot drift it.

**Files:**
- Modify: `packages/benchmark-product/core/src/report/claim.test.ts`
- Modify: `packages/benchmark-product/core/src/bundle/assets.test.ts`
- Create: `packages/benchmark-product/core/src/bundle/__fixtures__/wilson-golden/` (or the directory convention those tests already use)

**Interfaces:** none — tests only.

- [ ] **Step 1: Write the guards**

Pin the exact serialized bytes of a wilson claim package and of every wilson bundle asset, produced from a fixed fixture. Assert with exact string equality against a committed golden file, not `toMatchObject` and not a snapshot that auto-updates.

```ts
  test("wilson claim package serializes byte-identically to the committed golden", async () => {
    const claim = buildClaimPackage(wilsonGoldenInput());
    const serialized = `${JSON.stringify(claim, null, 2)}\n`;
    expect(serialized).toBe(await readGolden("wilson-golden/claim-package.json"));
  });

  test("wilson bundle assets serialize byte-identically to the committed goldens", async () => {
    const assets = buildPublicAssets(wilsonGoldenAssetInput());
    for (const [name, bytes] of Object.entries(assets)) {
      expect(bytes, name).toBe(await readGolden(`wilson-golden/${name}`));
    }
  });
```

Match the real signatures of `buildClaimPackage` (`report/claim.ts`) and `buildPublicAssets` (`bundle/assets.ts:446`), and match how the existing tests in each file already construct their inputs. Serialize exactly as the production writer does — check `writeClaimPackage` (`claim.ts:339`) and `bundle/materialize.ts:475-485` for the precise encoding, including trailing newline.

- [ ] **Step 2: Generate the goldens from current behavior and commit them**

Run once, write the output to the golden files, and **inspect the diff before committing** — these files are the definition of "unchanged" for the rest of the packet.

- [ ] **Step 3: Prove the guards bite**

Temporarily alter one character of the neutral copy at `bundle/assets.ts:249`, re-run, and confirm the asset guard FAILS. Revert exactly (`git checkout -- packages/benchmark-product/core/src/bundle/assets.ts`) and confirm green. A guard that cannot fail is not a guard. Report both runs.

- [ ] **Step 4: Commit**

```bash
git add packages/benchmark-product/core/src/report/claim.test.ts \
        packages/benchmark-product/core/src/bundle/assets.test.ts \
        packages/benchmark-product/core/src/bundle/__fixtures__/wilson-golden
git commit -m "test(benchmark-product): pin wilson claim and bundle asset bytes before method dispatch"
```

---

### Tasks 5–8 — acceptance criteria

Task 5 shipped in PR A. Tasks 6–8 are PR B; their step-level detail follows the table, appended once PR A merged (`e9db60afa`) so it is written against real line numbers rather than predicted ones.

Their **acceptance criteria are fixed and binding** — they are the contract PR B is reviewed against.

| # | Task | Est. | Acceptance criteria |
|---|---|---|---|
| **5** | Method-dispatching claim package. `claim.ts:49-54,129` (`headline` optional + sibling `comparison`), `:192-215` (`wilsonSubjectResults` becomes one branch of a dispatch on `reportRecord.method.id`), `:262` and `verification/claim-consistency.ts:67` (select the plan entry matching the produced method rather than `[0]`). | **2.0–3.0** | A paired Report builds a claim carrying `comparison`; **the wilson golden from Task 4 still passes byte-identically**; `assertClaimConsistency` round-trips both shapes; `CLAIM_PACKAGE_SCHEMA_ID` unchanged at `/1`; a claim missing both `headline` and `comparison` is refused. |
| **6** | Method-dispatching bundle assets. `assets.ts:118-156` (`requireWilsonFacts` becomes a dispatch), `:446-447` (both call sites). All neutral copy **unchanged** — see the seven-surface list below. | **2.0** | A paired bundle materializes and `bundle verify` passes on it; **every wilson golden from Task 4 still passes byte-identically**; no directional language appears on any publish-facing surface. |
| **7** | Web renders both claim shapes. `web/.../results/page.tsx:27,124` — the unguarded `headline.wilsonInterval.low` dereference must become shape-aware. `inspect` surfaces the selected method (`operations/inspect.ts`). Also `core/scripts/m1-walkthrough.mjs:222`, which emits `armHeadline: report.claimPackage.headline` and yields a silent `undefined` on the paired branch under §5.2's optional-headline shape. | **1.0** | RTL renders a paired claim and a wilson claim; no unguarded dereference; the existing stored-Report `role="alert"` degradation path preserved; the walkthrough transcript never emits `undefined` for either branch. |
| **8a** | **Sample-benchmark provenance fix.** `core/src/intake/sample.ts:154` overwrites `payload` wholesale, destroying `payload.provenance`, which `resolveBenchmarkTaskProvenance` requires. No clustered paired method can run on the sample path until this lands, so it is a **prerequisite for 8b**, not a tidy-up. | **1.0** | A sample-benchmark task retains `payload.provenance`; a paired method runs on the sample path without a typed provenance refusal. Sample-benchmark digest changes — every fixture pinned to it updated deliberately, each called out in the PR body. |
| **8b** | **Paired end-to-end coverage.** Extend `run-path.integration.test.ts` across all three render states. | **1.5** | A paired draft runs create → arms → lock → launch → collect → report → verify → publish → `bundle verify` with zero manual intervention. **All three states covered: interval-present, interval-withheld (both reason strings surfaced), and zero-pairs.** As of PR A only zero-pairs is exercised anywhere in-tree — the other two are 8b's to write, not assumed present. |
| **8c** | **Copy surfaces — OPERATOR-GATED, LANDS LAST.** The seven neutrality surfaces plus `PUBLIC-BUNDLE.md` and `ADAPTATION.md`. | **0.5** | Blocked on the operator's §5.3 pick. Structured as the final commit of PR B so 6, 7, 8a and 8b can be reviewed and merged without it. **Nothing in 6–8b may pre-empt the wording.** |

#### The neutrality promise ships on SEVEN surfaces, not three

Verified in-tree at the PR A chain tip. Partial editing would ship a bundle whose badge contradicts its HTML, so any copy change touches all seven together or none:

| Surface | Location |
|---|---|
| HTML body | `bundle/assets.ts:249` |
| `badge.svg` | `bundle/assets.ts:278` — `<title>` **and** the `data-field="neutral-status"` text |
| `social-card.svg` | `bundle/assets.ts:288` — `<title>` **and** `data-field="neutral-status"` (two occurrences) |
| `README.md` | `bundle/assets.ts:318` |
| `share.txt` | `bundle/assets.ts:440` |
| Public bundle doc | `PUBLIC-BUNDLE.md:91-94` and `:105-106` |
| Design-system doc | `design-system/ADAPTATION.md:16-19` |

**Wilson-branch strings must stay byte-identical on all seven**, including the checked-in proof bundle. Task 4's goldens already cover the five in-code surfaces — `index.html`, `badge.svg`, `social-card.svg`, `README.md`, `share.txt` — because they pin every asset `buildPublicAssets` emits, not just the large ones. The two documentation surfaces are not byte-guarded by tests and need manual care.

#### Three render states, pinned per surface

Whatever copy the operator approves, the paired branch has **three** distinct states, and compact assets route through `boundedVisual` with roughly a 90-character budget:

1. **Interval present** — delta and interval both rendered.
2. **Interval withheld with reasons** — fewer than five paired tasks, or fewer than two provenance clusters; `delta` still renders, `interval` is null, and the reason strings must surface rather than silently vanish.
3. **Zero pairs** — no `delta` either.

Task 8's acceptance criteria pin all three per surface. State 2 is the one most likely to be dropped, and it is exactly the state the C4 lane's end-to-end gate asserts against.

#### A distinct limitations entry is required

The report's limitations need an entry separate from the MDE line:

> this method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered

The interval-withheld branch and the below-MDE branch are **different failures** and must not read as one caveat. Conflating them would let an underpowered run be mistaken for a null result.

### PR B test blast radius

Enumerated in scoping §9. The assertions that pin **exact literal strings** and will need deliberate updates: `bundle/assets.test.ts:219-222,232,236-238`; `web/.../results/page.test.tsx:97,103,115-116,161,171`; `report/claim.test.ts:294` (asserts `claim.headline` deep-equals the wilson `arms`). Every such change is called out in the PR body with rationale, per the program's blast-radius rule.

---

## PR B — step-level detail

Written against `e9db60afa` (PR A merged). Branch `claude/demo1-p4b-prb`; one worktree per task chained off the previous tip, as in PR A.

**Commit order is load-bearing.** `8c` is the copy commit and must be the last commit on the branch, so that 6 → 7 → 8a → 8b can be reviewed, and if necessary merged, while the operator's §5.3 decision is still outstanding. Nothing in 6–8b may pre-empt the wording: the paired branch renders **structure with no directional sentence**, and the sentence is added in 8c or not at all.

### Task 6 — bundle assets dispatch

**Files:** `core/src/bundle/assets.ts` · `core/src/bundle/assets.test.ts`

`requireWilsonFacts` (`assets.ts:118-156`) currently throws for any results lacking wilson's `arms` shape, and is called twice at `:446-447` — once on `input.report.results`, once on `input.claim.results`. Both call sites must dispatch on the produced method instead.

1. **Failing test first.** A paired claim + paired Report must produce assets without throwing, and the rendered HTML must contain the paired facts (pairs, delta, and — when present — the interval). Assert on *structure*, never on a directional sentence.
2. Turn `requireWilsonFacts` into a dispatch keyed on `reportRecord.method.id`, mirroring `claim.ts`'s `methodProjection`. Reuse the same shape names so the two dispatches read as one pattern.
3. **The three render states each get an assertion here**, not only in 8b: interval-present, interval-withheld (both reason strings visible), zero-pairs (no delta). Compact assets route through `boundedVisual` with roughly a 90-character budget — the withheld state is the one that silently truncates to nothing, so assert its rendered output is non-empty.
4. **The Task 4 goldens must still pass byte-identically.** A wilson bundle is unchanged. If a golden fails, fix the code — never the golden.
5. Neutral copy at `:249`, `:278`, `:288`, `:318`, `:440` **unchanged**.

**Gate:** paired bundle materializes; `bundle verify` passes on it; all six goldens byte-identical; `git diff -- '*wilson-golden*'` empty.

### Task 7 — web and walkthrough render both shapes

**Files:** `web/src/app/workspace/[draftId]/results/page.tsx` · its test · `core/src/operations/inspect.ts` · `core/scripts/m1-walkthrough.mjs`

PR A left `page.tsx:124` behind a minimal `claim.headline ? … : null` guard, so **a paired claim currently renders nothing at all**. That is correct under the deferral and wrong to ship.

1. **Failing test first**, and note the acceptance is *"a paired claim renders something"* — not merely "no unguarded dereference". A test asserting absence would pass against the current stub.
2. Render the `comparison` block: pairs, delta, interval or the withheld reasons. Structure only; no directional sentence.
3. `m1-walkthrough.mjs:222` emits `armHeadline: report.claimPackage.headline`, which is a silent `undefined` on the paired branch. Branch it so the transcript never prints `undefined`.
4. `inspect` surfaces the selected method.

**Gate:** RTL renders paired and wilson claims; the wilson branch is visually unchanged; the stored-Report `role="alert"` degradation path preserved; walkthrough prints no `undefined` on either branch; `web` **`yarn typecheck` exit 0** — the leg PR A added after it caught a break `vitest` structurally could not.

### Task 8a — DROPPED (2026-08-12). Superseded by a documented architectural constraint.

**What it was:** make the bundled sample benchmark carry task provenance, so a clustered paired method could run on the sample path. Two successive stop-and-report findings retired it.

**First finding — the plan's diagnosis was wrong.** This section originally read "`sample.ts:154` … discarding `payload.provenance`. Preserve provenance by merging rather than replacing." The upstream fixture (`task-supply/admission/fixtures/prediction-snapshot-v1/task.json`) carries **no `provenance` key at all**, so nothing was being discarded and the prescribed merge would have merged `{}` into `{}` — a silent no-op that a weaker test would have reported as a pass. Provenance had to be *synthesized*, not preserved.

**Second finding — synthesis is impossible under the frozen contract.** Two contracts are mutually exclusive for the prediction-forecast profile:

- `task-supply/admission/src/prediction-snapshot.ts:159-160` requires `Object.keys(payload).sort().join(",") === "forecast"` — the payload must be **exactly** `{forecast}`.
- `benchmarking/records/src/benchmark/checks.ts:56-58` reads provenance from **exactly one location**, `task.data.payload["provenance"]`, with no fallback and no alternative accepted location.

There is no third attachment point: `prediction-snapshot.ts:125` also closes the Task object to exactly `evaluation,instructions,outputs,payload,profile,protocol`, so provenance cannot be a top-level sibling either.

**The recorded constraint:** *prediction-forecast tasks structurally cannot carry payload provenance under the frozen `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1`, and therefore cannot be scored by any clustered paired method — `paired-delta@1`, `paired-mcnemar@1`, or `provenance-cluster-sign@1`. This is a contract conflict, not an oversight.* The bundled sample benchmark can never demo a paired method.

**Why this costs nothing here.** The demo's real path is SWE-imported `repository-work/1.0` tasks, which carry provenance natively (`interop/src/import/swebench.ts`) and never pass through the prediction-specific admission policy. And the sample's only reachable paired state was interval-withheld anyway — it has three tasks against a `minN` of five — which Task 8b's purpose-built fixture now covers along with interval-present.

**Rejected, deliberately:** amending `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1` to admit a provenance key (a frozen, versioned, cross-package contract change to satisfy a test fixture — the tail wagging the dog), and weakening `sample.ts`'s admission sanity call (it exists to prove the frozen contract holds; neutering it would pass CI while destroying the property it guarantees).

The open product question — *should prediction-forecast tasks be paired-scoreable?* — is filed as a `design` issue against whoever owns prediction admission. It is explicitly **not** scoped into this program.

### Task 8b — paired end-to-end coverage

**Files:** `core/src/run/run-path.integration.test.ts` · a new purpose-built test benchmark fixture

**The bundled sample benchmark structurally cannot reach interval-present.** It has exactly three tasks (`sample-market-alpha`, `-bravo`, `-charlie`) and `paired-delta@1`'s floor is `minN = 5` paired tasks. No provenance decision changes this — it is a task-count fact. Recorded here so it is not rediscovered.

So **8b builds its own test benchmark** for interval-present: ≥5 tasks across ≥2 provenance clusters. It is a test fixture, not a product surface, and ships no user-visible behavior. Task 8a's one-cluster synthesis already covers interval-withheld on the sample path without extra fixture work.

If the fixture-builder pushes this task meaningfully past its 1.5-day budget, flag rather than trim coverage — interval-withheld is what the slate/e2e lane's gate asserts against, and interval-present is the state a reader of the demo report will actually look at.

One paired draft, full lifecycle, **three states**:

| State | Setup | Assert |
|---|---|---|
| interval-present | ≥5 paired tasks across ≥2 provenance clusters | `interval` non-null; delta and bounds render |
| interval-withheld | <5 paired tasks, or 1 cluster | `interval: null`; **both reason strings surfaced**; delta still present |
| zero-pairs | no task judged in both arms | no delta, no interval; no crash |

Interval-withheld is the state the slate/e2e lane's gate asserts against, and the one most likely to be dropped, since it looks like a degenerate case rather than a supported outcome.

**Gate:** all three run create → … → `bundle verify` with zero manual intervention.

### Task 8c — copy surfaces (OPERATOR-GATED, LAST COMMIT)

**Do not start until the operator's §5.3 decision lands.** All seven surfaces move together or none — a bundle whose badge contradicts its HTML is worse than one that says nothing. Wilson-branch strings stay byte-identical on all seven, which the Task 4 goldens enforce for the five in-code ones; the two documentation surfaces are not test-guarded and need manual care.

Also in this commit: the distinct limitations entry (*"this method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered"*), kept separate from the MDE line, because an interval-withheld run and a below-MDE run are different failures and must not read as one caveat.

---

## Verification chain (both PRs)

Benchmark-product CI does not trigger on every path this touches, so the local chain is the evidence:

```bash
cd packages/benchmark-product/core && yarn typecheck && yarn vitest run
cd ../web && yarn typecheck && yarn vitest run
cd ../../.. && node .github/scripts/fixture-manifest.mjs --check
```

`web`'s `yarn typecheck` is load-bearing, not optional: `web` is strict-mode and `next build` fails on a
type error, but `yarn vitest run` alone strips types and structurally cannot catch one (found in
review: `results/page.tsx`'s unguarded `Object.entries(claim.headline)` after `headline` became
optional in Task 5 typechecked-red while every `vitest` run stayed green). Both legs are mandatory
on every pass through this chain, not just PR B's.

Plus, for PR B, an explicit statement that the Task 4 goldens are unmodified — `git diff <merge-base>...HEAD -- '*wilson-golden*'` must be empty.
