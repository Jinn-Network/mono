# P4 — `paired-delta@1` Method Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register a ninth benchmarking method, `paired-delta@1`, that reports the paired mean difference in pass rate between two arms with a two-sided BCa confidence interval, replicate-compatible, computed entirely by delegation to existing numerics.

**Architecture:** The existing `clusteredPairedRateDiffBca` computes a one-sided BCa bound whose bootstrap distribution depends only on `seed`/`resamples` — `alpha` enters solely at the quantile-index step (`stats/noninferiority.ts:192`). Calling it twice with the same seed at `alpha/2` and `1 - alpha/2` therefore yields the two BCa endpoints of one central interval over an identical bootstrap distribution. A thin composition module (`stats/paired-delta.ts`) performs that composition; the registry method reuses `noninferiority-iut@1`'s replicate-aware pairing/exclusion logic with the cost leg and the verdict gate removed. **No new statistical mathematics is written.**

**2026-08-13 draw-accounting correction:** `draws` counts the unique PRNG variates in that one
shared bootstrap ensemble, so it equals `resamples × clusterCount`. The two endpoint calls replay
the same ensemble and are not two statistical resample sets. The composition fails closed unless
both calls agree on draw count, observed value, and cluster manifest. This correction predates the
official Demo-1 run. No public npm release, repository tag, committed canary tarball, or sealed
Demo-1 paired Report was found at correction time. If an untracked pre-correction artifact exists,
retain its exact package bytes to verify its old `2 × resamples × clusterCount` result; never rewrite
the sealed record. Wilson fixtures and public-bundle bytes have an independent byte-stability
obligation and remain unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node 22, Yarn 4 workspaces. Packages: `@jinn-network/benchmarking-records` (identifiers), `@jinn-network/benchmarking-aggregate` (registry + statistics), `@jinn-network/benchmarking-testing` (conformance kit + golden fixtures).

**Worked example to mirror:** commit `10fe0ebf1` (PR #2556) added `provenance-cluster-sign@1` and touched exactly the file set this plan touches. When in doubt about placement, ordering, or comment style, `git show 10fe0ebf1 -- packages/benchmarking/` is authoritative precedent.

## Global Constraints

- **Zero product-side statistics.** Every number ships from the registry. Nothing in `packages/benchmark-product` changes in this packet.
- **Deterministic AND byte-stable JSON.** `verifyReport` re-runs `compute` and requires exact JSON equality against the sealed Report (`aggregate/src/report.ts:510-514`). Identical inputs must produce byte-identical output forever.
- **Float discipline: `fixed4`** (`aggregate/src/registry.ts:254-256`) for every emitted float. Do **not** copy `provenance-cluster-sign@1`'s `String(pValue)` — that exception exists only because an exact binary-representable boundary (`2^-5 = 0.03125`) was worth preserving. BCa endpoints are bootstrap order statistics with no such boundary, and `String()` would expose last-bit floating-point noise to the byte-stability contract.
- **`versionRobust: true`** — matching every other Task-paired method. This obliges the results to carry `pairing.taskDigests` as a unique, code-unit-sorted array of 64-hex strings, or cross-Benchmark verification fails (`aggregate/src/report.ts:188-214, 249-257`).
- **Gates surface as typed no-interval outcomes**, never exceptions and never a fabricated number: fewer than 2 source clusters, or fewer than `MIN_PAIRED_TASKS = 5` paired tasks, yield `interval: null` plus a human-readable `reasons` entry.
- **Clustering is pinned, never a parameter** (design §9.2, `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md:741-746`). The cluster key comes from task provenance only.
- **`seed` stays an honest sealed parameter.** It is already required and sealed into the Run's `analysisPlan`; the method must not default, derive, or hide it.
- **Sealed records admit only exact I-JSON *integer* numbers.** `assertIJsonInteger` (`records/src/json.ts:93-95`) throws on any non-integer number anywhere in a sealed record, and method `parameters` are sealed into the Run's `analysisPlan`. Every inherently fractional parameter is therefore a **decimal string**, following the established `DecimalString` convention (`records/src/run/schema.ts:15-20`, used for `completenessFloor` and budget amounts). This binds `alpha`. It does **not** bind emitted results, which are already `fixed4` strings, nor the `parameterSchema` metadata, which is never sealed.
- **American English** in identifiers and copy (repo Rule 5).
- **Existing numerics are not modified.** `stats/noninferiority.ts` is read-only in this packet — its pinned BCa oracle (`fixtures/methods/noninferiority-cluster-bca.json`, asserted at `testing/src/method-conformance.ts:600-665`) must stay green untouched. Auditing those numerics is E3's job, not this packet's.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/benchmarking/records/src/identifiers.ts` | Method URI constant | Modify (+1 line) |
| `packages/benchmarking/records/src/identifiers.test.ts` | Pinned URI list | Modify (pinned literal) |
| `packages/benchmarking/aggregate/src/stats/paired-delta.ts` | Two-alpha BCa composition | **Create** |
| `packages/benchmarking/aggregate/src/stats/paired-delta.test.ts` | Composition + red-team edge tests | **Create** |
| `packages/benchmarking/aggregate/src/index.ts` | Public barrel export | Modify |
| `packages/benchmarking/aggregate/src/registry.ts` | Metadata, compute, registry list, doc comment | Modify |
| `packages/benchmarking/aggregate/src/registry.test.ts` | Registry membership + versionRobust | Modify (pinned literal) |
| `packages/benchmarking/testing/scripts/generate-method-fixtures.mjs` | Independent ground truth | Modify |
| `packages/benchmarking/testing/fixtures/methods/paired-delta.json` | Golden compute fixture | **Create (generated)** |
| `packages/benchmarking/testing/fixtures/methods/method-specs.json` | Declarative spec mirror | Modify (hand-edited) |
| `packages/benchmarking/testing/fixtures/methods/conformance-cases.json` | Conflict-reporting roster | Modify (hand-edited) |
| `packages/benchmarking/testing/fixtures/methods/conflict-cases.json` | Conflict compute case | Modify (hand-edited) |
| `packages/benchmarking/testing/src/fixture-contract.test.ts` | Pinned id lists | Modify (pinned literal) |
| `packages/benchmarking/testing/fixtures/manifest.sha256.json` | Fixture hash manifest | Regenerate (mechanical) |
| `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` | §9.2 registry list | Modify |
| `docs/superpowers/plans/2026-07-28-benchmarking-application.md` | Method-URI table | Modify |

**Not touched, deliberately:** `testing/src/method-conformance.ts`. The precedent modified it only to add `provenance-cluster-sign` to the `runReplicates: 1` list at `:1072-1075`. `paired-delta@1` accepts any replicate count, so it must **not** be added there — same as `noninferiority-iut@1`, which is absent from that list.

## Design decisions (locked — do not re-litigate during implementation)

1. **Method URI:** `jinn.benchmarking.method/paired-delta`, object key `pairedDelta`, version `"1"`.
2. **Registry ordering:** immediately **after** `noninferiorityIut` in `BENCHMARKING_METHOD_IDS`, `METHOD_METADATA`, and `SINGLE_SUBJECT_METHODS`, grouping the two clustered-BCa methods adjacently. Apply the same position in `method-specs.json` and `conformance-cases.json`.
3. **Parameters:** `verdictRule`, `baseline`, `candidate`, `seed`, `resamples`, `alpha`. `alpha` is enum-restricted to the **decimal strings** `["0.10", "0.05", "0.01"]` — a closed set prevents post-hoc fishing while letting the eval design pre-register its confidence level, which is sealed into the Run's `analysisPlan` at lock. **AMENDED 2026-08-12:** `alpha` was originally specced as a raw JSON number; that is unsealable (see the I-JSON constraint in Global Constraints), and the conformance kit caught it exactly as kit-precedes-implementation intends. The numeric `alpha` survives only in the internal stats API (`clusteredPairedDeltaInterval`), which is never sealed.
4. **`delta` is reported whenever at least one pair exists**, even when `interval` is null. An underpowered run must still be able to report its point estimate honestly rather than showing nothing.
5. **`referenceSet: "v1-reference"`**, `deterministic: true`, `computeAvailability: "available"`.
6. **Docs drift repair:** commit `10fe0ebf1` added `provenance-cluster-sign@1` without amending the two §9.2 doc lists, leaving them stale. Task 5 adds **both** that method and `paired-delta@1`. This is a 2-line repair of another commit's omission; it is called out in the PR body rather than done silently. Neither file is a canonical doc (`CLAUDE.md` §Canonical Docs), so no CODEOWNERS gate applies.

---

### Task 1: Method identifier

**Files:**
- Modify: `packages/benchmarking/records/src/identifiers.ts:34-44`
- Test: `packages/benchmarking/records/src/identifiers.test.ts:65-77`

**Interfaces:**
- Consumes: nothing.
- Produces: `BENCHMARKING_METHOD_IDS.pairedDelta` (string literal `"jinn.benchmarking.method/paired-delta"`), consumed by Tasks 3 and 4.

- [ ] **Step 1: Update the failing pinned-literal test**

In `packages/benchmarking/records/src/identifiers.test.ts`, change the test name and add the new URI in sorted position (the assertion sorts, so alphabetical order is required — `paired-delta` sorts before `paired-mcnemar`):

```ts
  test("the nine registered method URIs are pinned under jinn.benchmarking.method/ at version 1", () => {
    expect(Object.values(BENCHMARKING_METHOD_IDS).sort()).toEqual([
      "jinn.benchmarking.method/avg-at-k",
      "jinn.benchmarking.method/bradley-terry",
      "jinn.benchmarking.method/clean-subset",
      "jinn.benchmarking.method/noninferiority-iut",
      "jinn.benchmarking.method/paired-delta",
      "jinn.benchmarking.method/paired-mcnemar",
      "jinn.benchmarking.method/pass-at-k",
      "jinn.benchmarking.method/provenance-cluster-sign",
      "jinn.benchmarking.method/wilson",
    ]);
    expect(BENCHMARKING_METHOD_VERSION).toBe("1");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/benchmarking/records && yarn vitest run src/identifiers.test.ts
```

Expected: FAIL — the received array lacks `"jinn.benchmarking.method/paired-delta"`.

- [ ] **Step 3: Add the identifier**

In `packages/benchmarking/records/src/identifiers.ts`, add one line to `BENCHMARKING_METHOD_IDS` after `noninferiorityIut`:

```ts
  noninferiorityIut: "jinn.benchmarking.method/noninferiority-iut",
  pairedDelta: "jinn.benchmarking.method/paired-delta",
  cleanSubset: "jinn.benchmarking.method/clean-subset",
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/benchmarking/records && yarn vitest run src/identifiers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmarking/records/src/identifiers.ts packages/benchmarking/records/src/identifiers.test.ts
git commit -m "feat(benchmarking): reserve the paired-delta@1 method URI"
```

---

### Task 2: Two-alpha BCa composition

**Files:**
- Create: `packages/benchmarking/aggregate/src/stats/paired-delta.ts`
- Create: `packages/benchmarking/aggregate/src/stats/paired-delta.test.ts`
- Modify: `packages/benchmarking/aggregate/src/index.ts` (after the `paired-mcnemar` export block, around `:41-42`)

**Interfaces:**
- Consumes: `clusteredPairedRateDiffBca` and the `ClusteredTaskRate` type from `./noninferiority.js` (`stats/noninferiority.ts:42-45, 147-204`). `ClusteredTaskRate` is `{ pA: number; pB: number; taskDigest: string; cluster: readonly ["source" | "sourceCommitment", string] }`.
- Produces: `clusteredPairedDeltaInterval(rates, opts) => PairedDeltaIntervalResult`, consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `packages/benchmarking/aggregate/src/stats/paired-delta.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { clusteredPairedDeltaInterval } from "./paired-delta.js";
import type { ClusteredTaskRate } from "./noninferiority.js";

function rate(task: string, cluster: string, pA: number, pB: number): ClusteredTaskRate {
  return { taskDigest: task, cluster: ["source", cluster] as const, pA, pB };
}

/** Six clusters, mixed per-task deltas — a genuinely non-degenerate bootstrap. */
const mixed: readonly ClusteredTaskRate[] = [
  rate("t1", "repo-a", 0.0, 1.0),
  rate("t2", "repo-b", 0.5, 1.0),
  rate("t3", "repo-c", 1.0, 1.0),
  rate("t4", "repo-d", 1.0, 0.5),
  rate("t5", "repo-e", 0.5, 0.0),
  rate("t6", "repo-f", 0.0, 0.5),
];

describe("clusteredPairedDeltaInterval", () => {
  test("brackets the observed paired mean difference with a two-sided interval", () => {
    const result = clusteredPairedDeltaInterval(mixed, { seed: 123456789, resamples: 500, alpha: 0.05 });
    // mean of (pB - pA) over the six tasks = (1 + .5 + 0 - .5 - .5 + .5) / 6 = 1/6
    expect(result.delta).toBeCloseTo(1 / 6, 12);
    expect(result.low).toBeLessThan(result.delta);
    expect(result.high).toBeGreaterThan(result.delta);
    expect(result.low).toBeLessThan(result.high);
  });

  test("is deterministic — the same seed reproduces byte-identical endpoints", () => {
    const options = { seed: 42, resamples: 500, alpha: 0.05 };
    expect(clusteredPairedDeltaInterval(mixed, options))
      .toEqual(clusteredPairedDeltaInterval(mixed, options));
  });

  test("nests a 90% interval strictly inside a 99% interval at one seed", () => {
    const wide = clusteredPairedDeltaInterval(mixed, { seed: 7, resamples: 2000, alpha: 0.01 });
    const narrow = clusteredPairedDeltaInterval(mixed, { seed: 7, resamples: 2000, alpha: 0.1 });
    expect(narrow.low).toBeGreaterThanOrEqual(wide.low);
    expect(narrow.high).toBeLessThanOrEqual(wide.high);
    expect(narrow.delta).toBe(wide.delta);
  });

  test("collapses both endpoints onto the point estimate when every task delta is identical", () => {
    const degenerate = ["a", "b", "c", "d"].map((key, index) =>
      rate(`t${index}`, `repo-${key}`, 0, 1));
    const result = clusteredPairedDeltaInterval(degenerate, { seed: 9, resamples: 200, alpha: 0.05 });
    expect(result.delta).toBe(1);
    expect(result.low).toBe(1);
    expect(result.high).toBe(1);
  });

  test("counts zero-delta tasks in the mean rather than discarding them", () => {
    const withTies = [rate("t1", "repo-a", 0, 1), rate("t2", "repo-b", 1, 1), rate("t3", "repo-c", 1, 1)];
    const result = clusteredPairedDeltaInterval(withTies, { seed: 5, resamples: 200, alpha: 0.05 });
    // A sign test would drop the two ties; the mean must not.
    expect(result.delta).toBeCloseTo(1 / 3, 12);
  });

  test("reports unique draws in the shared bootstrap ensemble over whole clusters", () => {
    const result = clusteredPairedDeltaInterval(mixed, { seed: 11, resamples: 250, alpha: 0.05 });
    expect(result.draws).toBe(250 * 6);
    expect(result.unit).toBe("source-cluster");
    expect(result.clusters).toHaveLength(6);
  });

  test("groups multi-task clusters into a single resample position", () => {
    const grouped = [
      rate("t1", "repo-a", 0, 1),
      rate("t2", "repo-a", 0, 1),
      rate("t3", "repo-b", 0, 0),
    ];
    const result = clusteredPairedDeltaInterval(grouped, { seed: 3, resamples: 100, alpha: 0.05 });
    expect(result.clusters).toHaveLength(2);
    expect(result.draws).toBe(100 * 2);
  });

  test("computes at the two-cluster floor", () => {
    const two = [rate("t1", "repo-a", 0, 1), rate("t2", "repo-b", 1, 0)];
    expect(() => clusteredPairedDeltaInterval(two, { seed: 1, resamples: 100, alpha: 0.05 })).not.toThrow();
  });

  test("refuses a single source cluster", () => {
    const one = [rate("t1", "repo-a", 0, 1), rate("t2", "repo-a", 1, 0)];
    expect(() => clusteredPairedDeltaInterval(one, { seed: 1, resamples: 100, alpha: 0.05 }))
      .toThrow(/at least two source clusters/);
  });

  test("refuses an alpha outside (0,1)", () => {
    for (const alpha of [0, 1, -0.1, 1.5]) {
      expect(() => clusteredPairedDeltaInterval(mixed, { seed: 1, resamples: 100, alpha }))
        .toThrow(/alpha must be in \(0,1\)/);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/benchmarking/aggregate && yarn vitest run src/stats/paired-delta.test.ts
```

Expected: FAIL — cannot resolve `./paired-delta.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/benchmarking/aggregate/src/stats/paired-delta.ts`:

```ts
/**
 * `paired-delta@1`'s interval construction: the central two-sided BCa interval for the paired
 * mean rate difference, composed from two calls to the existing one-sided estimator.
 *
 * `clusteredPairedRateDiffBca`'s bootstrap distribution depends only on `seed` and `resamples`;
 * `alpha` enters solely at the quantile-index step. Two calls at the same seed with `alpha/2` and
 * `1 - alpha/2` therefore select the two BCa endpoints of ONE bootstrap distribution — the
 * standard BCa two-sided construction, with no new statistical mathematics and no modification
 * to the existing estimator or its pinned oracle.
 */

import { clusteredPairedRateDiffBca, type ClusteredTaskRate } from "./noninferiority.js";

export interface PairedDeltaIntervalOptions {
  readonly seed: number;
  readonly resamples: number;
  /** Two-sided significance level; the result is the central (1 - alpha) BCa interval. */
  readonly alpha: number;
}

export interface PairedDeltaIntervalResult {
  /** Observed mean over tasks of (pB - pA). */
  readonly delta: number;
  readonly low: number;
  readonly high: number;
  readonly unit: "source-cluster";
  /** Unique xorshift32-v1 draws in the shared bootstrap ensemble. */
  readonly draws: number;
  readonly clusters: readonly {
    readonly key: readonly ["source" | "sourceCommitment", string];
    readonly members: readonly string[];
  }[];
}

function sameClusterManifest(
  lower: PairedDeltaIntervalResult["clusters"],
  upper: PairedDeltaIntervalResult["clusters"],
): boolean {
  if (lower.length !== upper.length) return false;
  return lower.every((cluster, clusterIndex) => {
    const candidate = upper[clusterIndex];
    if (candidate === undefined
      || cluster.key[0] !== candidate.key[0]
      || cluster.key[1] !== candidate.key[1]
      || cluster.members.length !== candidate.members.length) return false;
    return cluster.members.every((member, memberIndex) => member === candidate.members[memberIndex]);
  });
}

export function clusteredPairedDeltaInterval(
  rates: readonly ClusteredTaskRate[],
  opts: PairedDeltaIntervalOptions,
): PairedDeltaIntervalResult {
  if (!(opts.alpha > 0 && opts.alpha < 1)) {
    throw new Error("clusteredPairedDeltaInterval: alpha must be in (0,1)");
  }
  const lower = clusteredPairedRateDiffBca(rates, {
    seed: opts.seed,
    resamples: opts.resamples,
    alpha: opts.alpha / 2,
  });
  const upper = clusteredPairedRateDiffBca(rates, {
    seed: opts.seed,
    resamples: opts.resamples,
    alpha: 1 - opts.alpha / 2,
  });
  if (lower.draws !== upper.draws) {
    throw new Error("clusteredPairedDeltaInterval: endpoint passes disagree on draw count");
  }
  if (!Object.is(lower.observed, upper.observed)) {
    throw new Error("clusteredPairedDeltaInterval: endpoint passes disagree on observed value");
  }
  if (!sameClusterManifest(lower.clusters, upper.clusters)) {
    throw new Error("clusteredPairedDeltaInterval: endpoint passes disagree on cluster manifest");
  }
  return {
    delta: lower.observed,
    low: lower.lowerBound,
    high: upper.lowerBound,
    unit: "source-cluster",
    draws: lower.draws,
    clusters: lower.clusters,
  };
}
```

- [ ] **Step 4: Export it from the package barrel**

In `packages/benchmarking/aggregate/src/index.ts`, immediately after the `paired-mcnemar` type export line:

```ts
export { clusteredPairedDeltaInterval } from "./stats/paired-delta.js";
export type { PairedDeltaIntervalOptions, PairedDeltaIntervalResult } from "./stats/paired-delta.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd packages/benchmarking/aggregate && yarn vitest run src/stats/paired-delta.test.ts && yarn typecheck
```

Expected: all PASS, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/benchmarking/aggregate/src/stats/paired-delta.ts \
        packages/benchmarking/aggregate/src/stats/paired-delta.test.ts \
        packages/benchmarking/aggregate/src/index.ts
git commit -m "feat(benchmarking): compose a two-sided BCa interval from the clustered estimator"
```

---

### Task 3: Register `paired-delta@1`

**Files:**
- Modify: `packages/benchmarking/aggregate/src/registry.ts` (imports `:23-27`; `METHOD_METADATA` after `noninferiorityIut` at `:221-231`; new compute section after `nonInferiorityIutMethod` ends at `:911`; `SINGLE_SUBJECT_METHODS` at `:1057-1066`; registry doc comment at `:1111-1112`)
- Test: `packages/benchmarking/aggregate/src/registry.test.ts:59-85`

**Interfaces:**
- Consumes: `BENCHMARKING_METHOD_IDS.pairedDelta` (Task 1); `clusteredPairedDeltaInterval` (Task 2).
- Produces: a registry entry retrievable as `registry.get("jinn.benchmarking.method/paired-delta", "1")`, consumed by Task 4's fixtures.

- [ ] **Step 1: Write the failing registry tests**

In `packages/benchmarking/aggregate/src/registry.test.ts`, add to the versionRobust test and the membership list:

```ts
  test("declares every Task-paired method version-robust for cross-Benchmark comparisons", () => {
    const registry = createMethodRegistry();
    expect(registry.get("jinn.benchmarking.method/paired-mcnemar", "1")?.versionRobust).toBe(true);
    expect(registry.get("jinn.benchmarking.method/provenance-cluster-sign", "1")?.versionRobust).toBe(true);
    expect(registry.get("jinn.benchmarking.method/noninferiority-iut", "1")?.versionRobust).toBe(true);
    expect(registry.get("jinn.benchmarking.method/paired-delta", "1")?.versionRobust).toBe(true);
    expect(registry.get("jinn.benchmarking.method/wilson", "1")?.versionRobust).toBe(false);
  });
```

and rename `"registers all eight methods"` to `"registers all nine methods"`, adding `["jinn.benchmarking.method/paired-delta", "1"],` after the `noninferiority-iut` entry.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/benchmarking/aggregate && yarn vitest run src/registry.test.ts
```

Expected: FAIL — `registry.get(...)` returns `undefined` for `paired-delta`.

- [ ] **Step 3: Add the import and the metadata entry**

Add to the imports near `registry.ts:24`:

```ts
import { clusteredPairedDeltaInterval } from "./stats/paired-delta.js";
```

Add to `METHOD_METADATA`, immediately after the `noninferiorityIut` entry:

```ts
  pairedDelta: metadata({
    requiredInputs: ["matrix.cells", "referenced-verdicts", "task-provenance-source"],
    parameterSchema: { type: "object", required: ["verdictRule", "baseline", "candidate", "seed", "resamples", "alpha"], properties: { verdictRule: VERDICT_RULE_PROPERTY, baseline: { type: "string" }, candidate: { type: "string" }, seed: { type: "integer", minimum: 1, maximum: 4_294_967_295 }, resamples: { type: "integer", minimum: 1, maximum: MAX_NONINFERIORITY_RESAMPLES_V1 }, alpha: { enum: ["0.10", "0.05", "0.01"] } }, additionalProperties: false },
    outputShape: "paired mean rate difference + two-sided clustered BCa interval + exclusions + conflicted cells",
    exclusionRule: "pair Task digests judged in both arms; per-Task rates average all judged replicates; report full remainder",
    clusteringRule: "task-provenance-source",
    referenceSet: "v1-reference",
    deterministic: true,
    resamplingProcedure: "xorshift32-v1; sample whole source clusters with replacement; one uint32 draw per cluster position; cluster jackknife acceleration; two passes at alpha/2 and 1-alpha/2 over one seed",
    computeAvailability: "available",
  }),
```

- [ ] **Step 4: (removed by AMENDMENT 1)**

No new parameter helper is needed. `alpha` arrives as an enum-restricted decimal string and is read with the existing `requireStringParam`, then converted with `Number(...)` — exact for all three permitted values. If a `requireNumberParam` helper was added by an earlier pass, **delete it**; an unused function will fail `noUnusedLocals` under `yarn typecheck`.

- [ ] **Step 5: Add the compute section**

Insert after `nonInferiorityIutMethod` closes (before the `bradleyTerryMethod` declaration):

```ts
// --- paired-delta@1 ---------------------------------------------------------------------------
// The A/B read: the paired mean difference in pass rate with a two-sided clustered BCa interval.
// Pairing, replicate averaging, and exclusion discipline mirror noninferiority-iut@1's quality
// leg; the cost leg and the intersection-union verdict are deliberately absent — this method
// estimates an effect, it does not gate one.

/** Below this many paired Tasks the interval is withheld rather than manufactured (design §9.3:
 * a method never manufactures confidence from too little data). Matches the seed library's minN. */
const MIN_PAIRED_DELTA_TASKS = 5;

const pairedDeltaMethod: SingleSubjectMethod = {
  ...METHOD_METADATA.pairedDelta,
  id: BENCHMARKING_METHOD_IDS.pairedDelta,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: true,
  compute(input) {
    const baseline = requireStringParam(input.parameters, "baseline");
    const candidate = requireStringParam(input.parameters, "candidate");
    const seed = requireIntegerParam(input.parameters, "seed");
    const resamples = requireIntegerParam(input.parameters, "resamples");
    // Sealed records admit only integer numbers, so alpha crosses the boundary as an
    // enum-restricted decimal string; Number() is exact for the three permitted values.
    const alpha = Number(requireStringParam(input.parameters, "alpha"));
    if (resamples <= 0 || resamples > MAX_NONINFERIORITY_RESAMPLES_V1) {
      throw new MethodInputError("method-incompatible-cost-unit", "resamples", `resamples must be in 1..${MAX_NONINFERIORITY_RESAMPLES_V1}`);
    }

    type RelevantCell = {
      readonly cellKey: string;
      readonly taskDigest: string;
      readonly armId: string;
      readonly value?: "pass" | "fail";
    };
    const relevant: RelevantCell[] = [];
    const conflictedCellKeys: string[] = [];
    for (const matrix of input.matrices) {
      for (const cell of matrix.cells) {
        if (cell.armId !== baseline && cell.armId !== candidate) continue;
        let value: "pass" | "fail" | undefined;
        if (cell.outcome === "judged") {
          const reduction = reduceValidVerdicts(
            cell.validVerdicts.map((digest) => resolveVerdictOutcome(digest, input)),
            input.verdictRule,
          );
          if ("conflicted" in reduction) conflictedCellKeys.push(cell.cellKey);
          else value = reduction.value;
        }
        relevant.push({
          cellKey: cell.cellKey,
          taskDigest: cell.taskDigest,
          armId: cell.armId,
          ...(value === undefined ? {} : { value }),
        });
      }
    }

    const byTask = new Map<string, RelevantCell[]>();
    for (const cell of relevant) {
      const cells = byTask.get(cell.taskDigest) ?? [];
      cells.push(cell);
      byTask.set(cell.taskDigest, cells);
    }
    const clusteredRates: {
      pA: number;
      pB: number;
      taskDigest: string;
      cluster: readonly ["source" | "sourceCommitment", string];
    }[] = [];
    const pairedTaskDigests: string[] = [];
    const includedCellKeys = new Set<string>();
    for (const taskDigest of [...byTask.keys()].sort(compareCodeUnitStrings)) {
      const cells = byTask.get(taskDigest)!;
      const baselineCells = cells.filter((cell) => cell.armId === baseline && cell.value !== undefined);
      const candidateCells = cells.filter((cell) => cell.armId === candidate && cell.value !== undefined);
      if (baselineCells.length === 0 || candidateCells.length === 0) continue;
      const provenance = resolveTaskProvenance(taskDigest, input);
      clusteredRates.push({
        pA: baselineCells.filter((cell) => cell.value === "pass").length / baselineCells.length,
        pB: candidateCells.filter((cell) => cell.value === "pass").length / candidateCells.length,
        taskDigest,
        cluster: [provenance.cluster.tag, provenance.cluster.value] as const,
      });
      pairedTaskDigests.push(taskDigest);
      for (const cell of [...baselineCells, ...candidateCells]) includedCellKeys.add(cell.cellKey);
    }
    const excludedCellKeys = relevant
      .filter((cell) => !includedCellKeys.has(cell.cellKey))
      .map((cell) => cell.cellKey)
      .sort(compareCodeUnitStrings);

    const clusterCount = new Set(clusteredRates.map((rate) => JSON.stringify(rate.cluster))).size;
    const clusterManifest = sourceClusterManifest(clusteredRates);
    const reasons: string[] = [];
    if (clusteredRates.length < MIN_PAIRED_DELTA_TASKS) {
      reasons.push(`fewer than minN=${MIN_PAIRED_DELTA_TASKS} paired tasks (got ${clusteredRates.length})`);
    }
    if (clusterCount < 2) {
      reasons.push(`fewer than two source clusters (got ${clusterCount})`);
    }
    const estimate = reasons.length === 0
      ? clusteredPairedDeltaInterval(clusteredRates, { seed, resamples, alpha })
      : undefined;
    // One source for the point estimate. When the bootstrap ran, its own `observed` IS the mean
    // (same values, same task-sorted order, so the same float) — reusing it removes any chance of
    // the reported delta and the interval it sits inside disagreeing in a last bit.
    const delta = estimate !== undefined
      ? estimate.delta
      : clusteredRates.length === 0
        ? null
        : clusteredRates.reduce((sum, rate) => sum + (rate.pB - rate.pA), 0) / clusteredRates.length;

    return {
      verdictRule: input.verdictRule,
      baseline,
      candidate,
      pairs: clusteredRates.length,
      delta: delta === null ? null : fixed4(delta),
      interval: estimate === undefined
        ? null
        : { alpha: fixed4(alpha), low: fixed4(estimate.low), high: fixed4(estimate.high) },
      reasons,
      pairing: { taskDigests: pairedTaskDigests },
      clustering: { basis: "task-provenance-source", clusters: clusterCount },
      excluded: { count: excludedCellKeys.length, cellKeys: excludedCellKeys },
      conflicted: { count: conflictedCellKeys.length, cellKeys: conflictedCellKeys.sort(compareCodeUnitStrings) },
      bootstrap: {
        procedure: "xorshift32-v1", seed, resamples, basis: "task-provenance-source-family",
        count: clusterManifest.length, unit: "source-cluster",
        draws: estimate === undefined ? 0 : estimate.draws,
        clusters: clusterManifest,
      },
    };
  },
};
```

- [ ] **Step 6: Add to the registry list and update the doc comment**

In `SINGLE_SUBJECT_METHODS`, add `pairedDeltaMethod,` immediately after `nonInferiorityIutMethod,`. Update the `createMethodRegistry` doc comment:

```ts
/** The method registry: URI + version identification over nine registered methods
 * (eight in the v1 reference set; `bradley-terry@1` registered but not part of it). */
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd packages/benchmarking/aggregate && yarn vitest run && yarn typecheck
```

Expected: the whole aggregate suite PASSES (including the untouched noninferiority oracle), zero type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/benchmarking/aggregate/src/registry.ts packages/benchmarking/aggregate/src/registry.test.ts
git commit -m "feat(benchmarking): register paired-delta@1 in the method registry"
```

---

### Task 4: Conformance kit — fixtures and pinned rosters

**Files:**
- Modify: `packages/benchmarking/testing/scripts/generate-method-fixtures.mjs` (add fixture after the `provenance-cluster-sign` block ending near `:411`; register in the `fixtures` map at `:607-617`)
- Create (generated): `packages/benchmarking/testing/fixtures/methods/paired-delta.json`
- Modify: `packages/benchmarking/testing/fixtures/methods/method-specs.json`
- Modify: `packages/benchmarking/testing/fixtures/methods/conformance-cases.json`
- Modify: `packages/benchmarking/testing/fixtures/methods/conflict-cases.json`
- Modify: `packages/benchmarking/testing/src/fixture-contract.test.ts:88-131`
- Regenerate: `packages/benchmarking/testing/fixtures/manifest.sha256.json`

**Interfaces:**
- Consumes: the registered method from Task 3.
- Produces: golden fixtures auto-discovered by `computeFixtureNames()` (`testing/src/method-conformance.ts:106-112`) and asserted by the "each fixture's method reproduces the pinned expectedResults" conformance test at `:1022-1041`.

**Ground-truth note for the implementer:** the generator computes expected values **independently of the registry** (kit-precedes-implementation). It deliberately does not re-implement BCa. Instead — exactly as the existing noninferiority fixtures do at `generate-method-fixtures.mjs:560` — the fixture uses inputs where every per-task delta is identical, so every bootstrap resample mean equals the observed mean and both BCa endpoints collapse onto it analytically. Endpoint *distinctness* is covered by Task 2's unit tests, which run against non-degenerate inputs; this fixture pins the contract, wiring, and replicate handling.

- [ ] **Step 1: Add the failing pinned-roster assertions**

In `packages/benchmarking/testing/src/fixture-contract.test.ts`, the `method-specs` assertion at `:91-99` becomes (this list is compared after sorting, so `paired-delta` goes before `paired-mcnemar`):

```ts
    expect([...byId.keys()].sort()).toEqual([
      "jinn.benchmarking.method/avg-at-k",
      "jinn.benchmarking.method/bradley-terry",
      "jinn.benchmarking.method/clean-subset",
      "jinn.benchmarking.method/noninferiority-iut",
      "jinn.benchmarking.method/paired-delta",
      "jinn.benchmarking.method/paired-mcnemar",
      "jinn.benchmarking.method/pass-at-k",
      "jinn.benchmarking.method/provenance-cluster-sign",
      "jinn.benchmarking.method/wilson",
    ]);
```

and the conflicts assertion at `:116-123` becomes (a `Set`, so order is irrelevant — append):

```ts
    expect(new Set(cases.conflicts)).toEqual(new Set([
      "jinn.benchmarking.method/wilson",
      "jinn.benchmarking.method/avg-at-k",
      "jinn.benchmarking.method/pass-at-k",
      "jinn.benchmarking.method/paired-mcnemar",
      "jinn.benchmarking.method/noninferiority-iut",
      "jinn.benchmarking.method/paired-delta",
      "jinn.benchmarking.method/clean-subset",
    ]));
```

**AMENDED 2026-08-12:** `provenance-cluster-sign` is deliberately absent from this inline roster. Commit `7a52b5c66` moved it to standalone `provenance-cluster-sign-conformance.json` / `-method-spec.json` fixtures, checked separately — it needs `replicates === 1`, which the shared inline conflict matrix does not provide. `paired-delta@1` accepts any replicate count, so it belongs in the inline roster with the other six. Do not re-add `provenance-cluster-sign` here.

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/benchmarking/testing && yarn vitest run src/fixture-contract.test.ts
```

Expected: FAIL — `method-specs.json` and `conformance-cases.json` lack the new id.

- [ ] **Step 3: Add the generator fixture**

In `packages/benchmarking/testing/scripts/generate-method-fixtures.mjs`, after the `provenance-cluster-sign` fixture block:

```js
// --- fixture 3c: paired-delta@1 -------------------------------------------------------------
// Six single-Task clusters at R=2. Both replicates agree within each arm, so every per-Task
// delta is exactly +1 and the bootstrap is degenerate: observed == low == high == 1, with no
// need to re-implement BCa here. Endpoint distinctness is unit-tested in `aggregate`.

const pairedDeltaLabels = Array.from({ length: 6 }, (_, index) => `paired-delta/t${index + 1}`);
const pairedDeltaCells = pairedDeltaLabels.flatMap((label) => [
  cell(label, "armA", 1, { outcome: "judged", verdicts: ["r1"], validVerdicts: ["r1"] }),
  cell(label, "armA", 2, { outcome: "judged", verdicts: ["r2"], validVerdicts: ["r2"] }),
  cell(label, "armB", 1, { outcome: "judged", verdicts: ["r1"], validVerdicts: ["r1"] }),
  cell(label, "armB", 2, { outcome: "judged", verdicts: ["r2"], validVerdicts: ["r2"] }),
]);
const pairedDeltaVerdictOutcomes = {};
const pairedDeltaTaskProvenance = {};
for (const label of pairedDeltaLabels) {
  const task = taskDigest(label);
  for (const replicate of ["r1", "r2"]) {
    pairedDeltaVerdictOutcomes[digest(`${label}/armA/verdict/${replicate}`)] = verdictOutcome("fail");
    pairedDeltaVerdictOutcomes[digest(`${label}/armB/verdict/${replicate}`)] = verdictOutcome("pass");
  }
  pairedDeltaTaskProvenance[task] = { source: `fixture-source/${task}` };
}
const pairedDeltaTasks = pairedDeltaLabels.map((label) => taskDigest(label)).sort();
const pairedDeltaFixture = {
  methodId: "jinn.benchmarking.method/paired-delta",
  methodVersion: "1",
  parameters: { baseline: "armA", candidate: "armB", seed: 123456789, resamples: 1000, alpha: "0.05" },
  verdictRule: "unanimous",
  matrices: [matrix(pairedDeltaCells)],
  verdictOutcomes: pairedDeltaVerdictOutcomes,
  taskProvenance: pairedDeltaTaskProvenance,
  runReplicates: 2,
  expectedResults: {
    verdictRule: "unanimous",
    baseline: "armA",
    candidate: "armB",
    pairs: 6,
    delta: fixed4(1),
    interval: { alpha: fixed4(0.05), low: fixed4(1), high: fixed4(1) },
    reasons: [],
    pairing: { taskDigests: pairedDeltaTasks },
    clustering: { basis: "task-provenance-source", clusters: 6 },
    excluded: { count: 0, cellKeys: [] },
    conflicted: { count: 0, cellKeys: [] },
    bootstrap: {
      procedure: "xorshift32-v1", seed: 123456789, resamples: 1000,
      ...sourceClusters(pairedDeltaTasks, 1000),
    },
  },
};
```

Pass `1000` to `sourceClusters`: both endpoints replay one seed-identical bootstrap ensemble, so
`draws` is `resamples * clusters`.

Register it in the `fixtures` map after `"provenance-cluster-sign"`:

```js
  "paired-delta": pairedDeltaFixture,
```

- [ ] **Step 4: Add the declarative spec entry**

In `packages/benchmarking/testing/fixtures/methods/method-specs.json`, insert an entry after the `noninferiority-iut` object, keys in alphabetical order to match the file's existing convention:

```json
  {
    "clusteringRule": "task-provenance-source",
    "computeAvailability": "available",
    "deterministic": true,
    "exclusionRule": "pair Task digests judged in both arms; per-Task rates average all judged replicates; report full remainder",
    "id": "jinn.benchmarking.method/paired-delta",
    "outputShape": "paired mean rate difference + two-sided clustered BCa interval + exclusions + conflicted cells",
    "parameterSchema": {
      "additionalProperties": false,
      "properties": {
        "alpha": { "enum": ["0.10", "0.05", "0.01"] },
        "baseline": { "type": "string" },
        "candidate": { "type": "string" },
        "resamples": { "maximum": 100000, "minimum": 1, "type": "integer" },
        "seed": { "maximum": 4294967295, "minimum": 1, "type": "integer" },
        "verdictRule": { "enum": ["sole", "unanimous", "any-pass", "majority"] }
      },
      "required": ["verdictRule", "baseline", "candidate", "seed", "resamples", "alpha"],
      "type": "object"
    },
    "referenceSet": "v1-reference",
    "requiredInputs": ["matrix.cells", "referenced-verdicts", "task-provenance-source"],
    "resamplingProcedure": "xorshift32-v1; sample whole source clusters with replacement; one uint32 draw per cluster position; cluster jackknife acceleration; two passes at alpha/2 and 1-alpha/2 over one seed",
    "version": "1"
  },
```

- [ ] **Step 5: Add the conflict-reporting roster and case**

In `conformance-cases.json`, add `"jinn.benchmarking.method/paired-delta"` to the `conflicts` array after `"jinn.benchmarking.method/noninferiority-iut"`.

In `conflict-cases.json`, add to the `cases` array after the `noninferiority-iut` entry:

```json
    {
      "methodId": "jinn.benchmarking.method/paired-delta",
      "parameters": {
        "baseline": "armA",
        "candidate": "armB",
        "seed": 123456789,
        "resamples": 100,
        "alpha": "0.05"
      }
    },
```

- [ ] **Step 6: Regenerate fixtures and the manifest**

```bash
cd packages/benchmarking/testing && node scripts/generate-method-fixtures.mjs
cd "$(git rev-parse --show-toplevel)" && node .github/scripts/fixture-manifest.mjs --write
```

- [ ] **Step 7: Run the full kit and the aggregate conformance suite**

```bash
cd packages/benchmarking/testing && yarn vitest run
cd ../aggregate && yarn vitest run
cd "$(git rev-parse --show-toplevel)" && node .github/scripts/fixture-manifest.mjs --check
```

Expected: all PASS; the manifest check reports "fixture manifests are current".

- [ ] **Step 8: Commit**

```bash
git add packages/benchmarking/testing
git commit -m "test(benchmarking): pin paired-delta@1 conformance fixtures and rosters"
```

---

### Task 5: §9.2 documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md:748-774`
- Modify: `docs/superpowers/plans/2026-07-28-benchmarking-application.md:56`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add both missing methods to the design spec's §9.2 registry list**

In `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md`, after the `paired-mcnemar@1` bullet, add:

```markdown
- `provenance-cluster-sign@1` — two-arm comparison by one exact sign vote per
  provenance cluster: Task deltas are summed inside a cluster, ties disclosed
  and excluded, and the exact two-sided binomial tail reported. Requires
  `replicates == 1`.
- `paired-delta@1` — two-arm comparison by the paired mean difference in pass
  rate, with a two-sided BCa confidence interval bootstrapped over whole
  provenance clusters. Replicate-aware: a Task's per-arm rate averages all its
  judged replicates. Reports an estimate, not a gate; the interval is withheld
  (with a stated reason) below five paired Tasks or two source clusters.
```

- [ ] **Step 2: Update the plan document's method-URI table row**

In `docs/superpowers/plans/2026-07-28-benchmarking-application.md:56`, replace the URI list so the braces read:

```
`"jinn.benchmarking.method/{wilson,avg-at-k,pass-at-k,paired-mcnemar,provenance-cluster-sign,paired-delta,noninferiority-iut,clean-subset,bradley-terry}"`
```

- [ ] **Step 3: Verify no docs gate regressed**

```bash
cd packages/benchmark-product/core && yarn vitest run src/docs-consistency.test.ts
```

Expected: PASS (this gate covers product docs; the run confirms no incidental coupling).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-28-benchmarking-application-design.md \
        docs/superpowers/plans/2026-07-28-benchmarking-application.md
git commit -m "docs(benchmarking): list paired-delta@1 and provenance-cluster-sign@1 in the §9.2 registry"
```

---

## Final verification before the PR

Run from the repository root. The benchmark-product CI does not trigger on `packages/benchmarking/**` paths, so this chain is the only evidence the PR body can cite (program §CI blindness rule).

```bash
# 1. The three touched packages
for pkg in records aggregate testing; do
  (cd packages/benchmarking/$pkg && yarn typecheck && yarn vitest run) || break
done

# 2. Fixture manifest currency (CI runs this with --check)
node .github/scripts/fixture-manifest.mjs --check

# 3. Downstream consumers of the registry
(cd packages/discovery/facts/benchmarking && yarn vitest run)

# 4. The benchmark-product suite — required by the CI blindness rule.
#    Build the portal chain first per benchmark-product-ci.yml:69-92.
(cd packages/benchmark-product/core && yarn vitest run)
```

PR body must record: every command above with its result, the statement **"benchmark-product suite run locally: green"**, the regenerated fixture manifest, and an explicit rationale line for each pinned literal changed (`records/src/identifiers.test.ts`, `aggregate/src/registry.test.ts`, `testing/src/fixture-contract.test.ts` ×2) plus the §9.2 drift-repair note from Design Decision 6.
