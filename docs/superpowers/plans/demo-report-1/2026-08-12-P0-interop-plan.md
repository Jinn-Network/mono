# P0-interop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

| | |
|---|---|
| **Status** | Operator-ratified 2026-08-11. Program critical path — **nothing official is minted before this lands.** |
| **Version** | 1.0 |
| **Date** | 2026-08-12 |
| **Lane** | C4 |
| **Branch** | `claude/demo1-p0-interop` off `integration/evidence-v1` @ `04f309de8` |
| **PR title** | `fix(benchmarking): repo-level provenance clusters + SWE intake spec re-seal` |

**Goal:** Make SWE-bench imports statistically honest and executable — provenance clusters group by source repo instead of degenerating to one cluster per task, the product retains the EvaluationSpec bytes the venue requires, and each task carries its own real creation date instead of one importer-chosen constant.

**Architecture:** Three independent halves on one PR. (a) drop `@${base_commit}` from the importer's `provenance.source` — a one-line change with a one-way-door consequence, guarded by a new regression test and a realistic-key conformance fixture. (b) the product's intake re-seals each row's EvaluationSpec and stores the bytes content-addressed, so the venue's existing `getSealedBytes(taskDoc.evaluation.digest.sha256)` lookup resolves — no platform type widens. (c) an optional per-instance timestamp map threads real `created_at` values through, defaulting to today's behavior when omitted.

**Tech Stack:** TypeScript, Vitest, `packages/benchmarking/{interop,records,aggregate,testing}`, `packages/benchmark-product/core`.

---

## ⚠️ Two governance facts that shape every task

**1. The one-way door.** Half (a) changes `provenance.source`, which is sealed into Task bytes — so **every task digest from `importSweBench` changes**. Any Benchmark minted before this lands cannot be reused after it. This is why nothing official mints first. Disclose explicitly in the PR body.

**2. Fixtures are append-only, enforced in CI.** `.github/workflows/stack-fixture-immutability.yml` runs `.github/scripts/fixture-immutability.mjs`, whose `compareFixtureManifests` refuses any in-place byte change to a published fixture id:

> `<id> changed from <sha> to <sha>; a published fixture is never edited, it is superseded by a new fixture plus a dated erratum`

So `interop/fixtures/swebench/expected.json` **must not be edited**. It is superseded: add `expected.v2.json`, add an erratum, leave the original bytes untouched. An erratum requires `{id, supersededBy, date (YYYY-MM-DD), reason}`, and **both** `id` and `supersededBy` must exist as fixtures in the manifest. `fixture-manifest.mjs --write` preserves stored errata (`fixture-manifest.mjs:58`), so regeneration is safe once the erratum is written.

## Global Constraints

- **Consumption contract holds:** public package exports only; no deep imports; no copied platform code; no product-implemented statistics.
- **No new record kinds; no tier-1–3 semantics changes.** `SweRebenchRow` and `ImportedBenchmark` are **not** widened — that is the ratified boundary.
- **Half (c) must keep the no-override path byte-deterministic.** `intake/swebench.test.ts:40-49` relies on the default path producing identical digests across two calls; an omitted map must fall through to exactly today's constant.
- **CI blindness rule:** the PR body records a local full-chain verification (portal build order from `benchmark-product-ci.yml:69-92` → core suite).
- **American English** throughout.

## File Structure

| File | Responsibility |
|---|---|
| `packages/benchmarking/interop/src/import/swebench.ts` | **Modify.** Halves (a) and (c): repo-level `source`; per-instance timestamp resolution. **C4 owns this file for this program.** |
| `packages/benchmarking/interop/src/import/swebench.cluster.test.ts` | **Create.** The regression test reproducing today's singleton degeneracy. |
| `packages/benchmarking/interop/fixtures/swebench/rows.multi-repo.json` | **Create.** Three rows, two sharing a repo at different commits — the realistic shape no fixture models today. |
| `packages/benchmarking/interop/fixtures/swebench/expected.v2.json` | **Create.** Post-fix golden digests. Supersedes `expected.json`. |
| `packages/benchmarking/interop/fixtures/manifest.sha256.json` | **Regenerate + hand-add erratum.** |
| `packages/benchmarking/testing/fixtures/methods/noninferiority-cluster-realistic.json` | **Create.** Realistic `https://github.com/owner/repo` cluster keys where several tasks share a repo. Closes the gap that hid the defect. |
| `packages/benchmarking/testing/fixtures/manifest.sha256.json` | **Regenerate.** |
| `packages/benchmark-product/core/src/intake/swebench.ts` | **Modify.** Half (b): re-seal each row's spec and return the bytes. **C4 owns this file for this program.** |
| `packages/benchmark-product/core/src/operations/import.ts` | **Modify.** Half (b): persist spec bytes; expose `evaluationSpecSha256s`. |

---

## Task 1: Repo-level provenance clusters (half a)

The regression test comes first and must reproduce the *current* degeneracy, so the red is the bug itself rather than a missing symbol.

**Files:**
- Create: `packages/benchmarking/interop/fixtures/swebench/rows.multi-repo.json`
- Create: `packages/benchmarking/interop/src/import/swebench.cluster.test.ts`
- Modify: `packages/benchmarking/interop/src/import/swebench.ts:70-76`
- Create: `packages/benchmarking/interop/fixtures/swebench/expected.v2.json`
- Modify: `packages/benchmarking/interop/src/import/swebench.test.ts`
- Regenerate: `packages/benchmarking/interop/fixtures/manifest.sha256.json` (+ hand-written erratum)

**Interfaces:**
- Consumes: `importSweBench(rows, opts): ImportedBenchmark`; `resolveBenchmarkTaskProvenance(taskDigest, resolver)` from `@jinn-network/benchmarking-records` (`records/src/benchmark/checks.ts:35-71`, re-exported at `records/src/index.ts:63`), returning `{ok: true, provenance: {timestamp, cluster: {tag, value}}}`.
- Produces: repo-level `provenance.source`, consumed by every clustering method.

- [ ] **Step 1: Write the multi-repo row fixture**

Create `packages/benchmarking/interop/fixtures/swebench/rows.multi-repo.json` — three rows where **rows 1 and 2 share `astropy/astropy` at different base commits** and row 3 is a different repo. Reuse the existing golden row's `image`/`parser`/`testMaterial` shapes verbatim from `fixtures/swebench/row.json` so only the clustering-relevant fields differ.

```json
[
  {
    "instance_id": "swe-rebench-cluster-00001",
    "repo": "astropy/astropy",
    "base_commit": "1111111111111111111111111111111111111111",
    "problem_statement": "First astropy instance.",
    "language": "python",
    "image": {
      "uri": "https://example.org/images/swe-rebench-runner:cluster-00001",
      "digest": { "sha256": "e8d6cfe4f52e87a1292f3897bf0bea28e4bde32703e6792bb9b1bc60d3024817" }
    },
    "testMaterial": [{ "uri": "https://example.org/tests/cluster-00001/test_one.py" }],
    "parser": {
      "id": "jinn.parser.pytest-json-report",
      "version": "1.0.0",
      "digest": "sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897"
    },
    "transitions": { "failToPass": ["test_one.py::test_a"], "passToPass": [] },
    "timeout": 1800
  },
  {
    "instance_id": "swe-rebench-cluster-00002",
    "repo": "astropy/astropy",
    "base_commit": "2222222222222222222222222222222222222222",
    "problem_statement": "Second astropy instance, different commit.",
    "language": "python",
    "image": {
      "uri": "https://example.org/images/swe-rebench-runner:cluster-00002",
      "digest": { "sha256": "e8d6cfe4f52e87a1292f3897bf0bea28e4bde32703e6792bb9b1bc60d3024817" }
    },
    "testMaterial": [{ "uri": "https://example.org/tests/cluster-00002/test_two.py" }],
    "parser": {
      "id": "jinn.parser.pytest-json-report",
      "version": "1.0.0",
      "digest": "sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897"
    },
    "transitions": { "failToPass": ["test_two.py::test_b"], "passToPass": [] },
    "timeout": 1800
  },
  {
    "instance_id": "swe-rebench-cluster-00003",
    "repo": "psf/requests",
    "base_commit": "3333333333333333333333333333333333333333",
    "problem_statement": "A requests instance.",
    "language": "python",
    "image": {
      "uri": "https://example.org/images/swe-rebench-runner:cluster-00003",
      "digest": { "sha256": "e8d6cfe4f52e87a1292f3897bf0bea28e4bde32703e6792bb9b1bc60d3024817" }
    },
    "testMaterial": [{ "uri": "https://example.org/tests/cluster-00003/test_three.py" }],
    "parser": {
      "id": "jinn.parser.pytest-json-report",
      "version": "1.0.0",
      "digest": "sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897"
    },
    "transitions": { "failToPass": ["test_three.py::test_c"], "passToPass": [] },
    "timeout": 1800
  }
]
```

- [ ] **Step 2: Write the failing regression test**

Create `packages/benchmarking/interop/src/import/swebench.cluster.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveBenchmarkTaskProvenance } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { importSweBench, type SweBenchRow } from "./swebench.js";

const ROWS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/swebench/rows.multi-repo.json", import.meta.url)), "utf8"),
) as SweBenchRow[];

const OPTS = {
  name: "cluster regression",
  description: "Three instances across two source repos.",
  version: "1.0.0",
  provenanceTimestamp: "2026-07-29T00:00:00Z",
};

function clusterValues() {
  const imported = importSweBench(ROWS, OPTS);
  const byDigest = new Map(imported.tasks.map((task) => [task.digest, task.bytes]));
  return imported.tasks.map((task) => {
    const resolved = resolveBenchmarkTaskProvenance(task.digest, (digest) => byDigest.get(digest as `sha256:${string}`));
    if (!resolved.ok) throw new Error(`provenance did not resolve: ${resolved.reason}`);
    return resolved.provenance.cluster.value;
  });
}

describe("SWE-bench import — provenance clusters group by source repo", () => {
  test("three instances across two repos yield TWO clusters, not three", () => {
    // The defect this pins: with `@<base_commit>` in the source, every SWE instance is its own
    // singleton cluster, so the clustered bootstrap's between-repo correction never fires. Measured
    // on 100 real leaderboard rows: 100 distinct source keys against 77 distinct repos, zero
    // collisions. Two of these three rows are the same repo at different commits.
    expect(new Set(clusterValues()).size).toBe(2);
  });

  test("the cluster key is the repository, carrying no commit", () => {
    const values = [...new Set(clusterValues())].sort();
    expect(values).toEqual([
      "https://github.com/astropy/astropy",
      "https://github.com/psf/requests",
    ]);
    for (const value of values) expect(value).not.toContain("@");
  });

  test("tasks stay distinct even though their clusters merge", () => {
    // base_commit remains task identity — it is preserved losslessly in the Task's inputs
    // (`taskInputs[0].annotations.ref`, profiles/src/documents/swe-rebench.ts:81-85) and in
    // `payload.instance_id`. Merging clusters must never merge tasks.
    const imported = importSweBench(ROWS, OPTS);
    expect(new Set(imported.tasks.map((task) => task.digest)).size).toBe(3);
  });

  test("every imported task still passes judgeability", () => {
    const imported = importSweBench(ROWS, OPTS);
    expect(imported.benchmark.record.items).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails on the real defect**

```bash
cd packages/benchmarking/interop && yarn vitest run src/import/swebench.cluster.test.ts
```
Expected: the first two tests FAIL — `expected 3 to be 2`, and the cluster values still carry `@1111...`. Tests three and four PASS. **This red is the bug**, not a missing symbol. Record the exact output for the PR body.

- [ ] **Step 4: Make the fix**

In `packages/benchmarking/interop/src/import/swebench.ts`, in `sealRepositoryWorkTask`, change the provenance source to repo-level:

```ts
      provenance: {
        kind: "mined",
        // Repo-level, deliberately WITHOUT `@${row.base_commit}`. This string is the clustering
        // key (records/src/benchmark/checks.ts:65 uses it verbatim), so including the commit made
        // every SWE instance its own singleton cluster and silently defeated the clustered
        // bootstrap's between-repo correction. The base commit is not lost: it remains task
        // identity via `inputs[0].annotations.ref` and `payload.instance_id`.
        source: `https://github.com/${row.repo}`,
        timestamp: provenanceTimestamp,
      },
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd packages/benchmarking/interop && yarn vitest run src/import/swebench.cluster.test.ts
```
Expected: 4/4 PASS.

- [ ] **Step 6: Supersede the golden fixture (do NOT edit it)**

Run the existing golden test to capture the new digests:

```bash
cd packages/benchmarking/interop && yarn vitest run src/import/swebench.test.ts
```
Expected: FAIL, reporting the new `taskDigest` and benchmark digest. Copy those exact values into a **new** file `fixtures/swebench/expected.v2.json`, mirroring `expected.json`'s structure. Leave `expected.json` byte-identical — CI refuses in-place edits.

Then point the golden test at the new fixture, keeping the old one referenced nowhere:

```ts
const expected = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/swebench/expected.v2.json", import.meta.url)), "utf8"),
) as { taskDigest: string; benchmarkDigest: string; evaluationSpecDigest: string };
```

`evaluationSpecDigest` is provenance-independent and must be **unchanged** between `expected.json` and `expected.v2.json` — if it moved, the fix touched more than provenance and the task must stop and report.

- [ ] **Step 7: Regenerate the manifest and hand-write the erratum**

```bash
node .github/scripts/fixture-manifest.mjs --write
```
Then add the erratum by hand to `packages/benchmarking/interop/fixtures/manifest.sha256.json` (`--write` preserves stored errata, so ordering is not fragile):

```json
"errata": [
  {
    "id": "swebench/expected.json",
    "supersededBy": "swebench/expected.v2.json",
    "date": "2026-08-12",
    "reason": "Provenance source became repo-level so clustered-bootstrap groups by source repo; every imported task digest changed. The superseded fixture pins the pre-fix digests and is retained unedited."
  }
]
```

Verify both gates:
```bash
node .github/scripts/fixture-manifest.mjs --check
node .github/scripts/fixture-immutability.mjs --base origin/integration/evidence-v1
```
Expected: both pass.

- [ ] **Step 8: Run the full interop and records suites**

```bash
cd packages/benchmarking/interop && yarn test
cd ../records && yarn test
```
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add packages/benchmarking/interop/
git commit -m "fix(benchmarking): group SWE provenance clusters by source repo"
```

---

## Task 2: A realistic-key clustering conformance fixture

Closes the gap that let the defect hide: every clustering fixture today uses synthetic tokens (`family-a`, or `fixture-source/<taskDigest>` — one singleton per task, literally the bug shape, pinned as correct).

**Files:**
- Create: `packages/benchmarking/testing/fixtures/methods/noninferiority-cluster-realistic.json`
- Modify: `packages/benchmarking/testing/src/fixture-contract.test.ts`
- Regenerate: `packages/benchmarking/testing/fixtures/manifest.sha256.json`

**Interfaces:**
- Consumes: the fixture shape of `fixtures/methods/noninferiority-cluster-bca.json` (hand-authored, not generator-produced — copy its structure); `taskProvenance` override honored at `testing/src/method-conformance.ts:439-442`.
- Produces: a conformance case where **six tasks across two repos yield two clusters**.

- [ ] **Step 1: Write the fixture**

Copy `noninferiority-cluster-bca.json`'s structure. Replace its opaque tokens with realistic repo-level sources, with several tasks sharing a repo — the shape real imports now produce:

```json
"taskProvenance": {
  "<taskDigest1>": { "source": "https://github.com/astropy/astropy" },
  "<taskDigest2>": { "source": "https://github.com/astropy/astropy" },
  "<taskDigest3>": { "source": "https://github.com/astropy/astropy" },
  "<taskDigest4>": { "source": "https://github.com/psf/requests" },
  "<taskDigest5>": { "source": "https://github.com/psf/requests" },
  "<taskDigest6>": { "source": "https://github.com/psf/requests" }
}
```

Its `expectedResults.bootstrap` must pin `unit: "source-cluster"`, `count: 2`, `clusters` with the two repo keys and their members, and `draws === resamples * 2`. Derive the numeric expectations by running the method, never by hand-computing.

**Guard against the regression that hid the defect:** the fixture must assert `count: 2` for six tasks. Were the importer ever to revert to per-instance keys, this case would report `count: 6` and go red.

- [ ] **Step 2: Run the conformance suite to verify it fails**

```bash
cd packages/benchmarking/testing && yarn vitest run src/fixture-contract.test.ts
```
Expected: FAIL — the fixture is not yet listed in the contract test's expected set.

- [ ] **Step 3: Register the fixture in the contract test**

Add `noninferiority-cluster-realistic.json` to `fixture-contract.test.ts`'s fixture inventory, following exactly how `noninferiority-cluster-bca.json` is registered.

- [ ] **Step 4: Run and regenerate**

```bash
cd packages/benchmarking/testing && yarn test
node .github/scripts/fixture-manifest.mjs --write
node .github/scripts/fixture-manifest.mjs --check
```
Expected: suite green; manifest check passes. This adds a **new** fixture id, so no erratum is needed.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmarking/testing/
git commit -m "test(benchmarking): pin realistic repo-level cluster keys in conformance"
```

---

## Task 3: Product-side EvaluationSpec re-seal at intake (half b)

Today the SWE Tasks reference an `evaluation.digest.sha256` whose bytes are **never persisted**, so the venue's lookup cannot resolve. The fix re-seals product-side and stores the bytes content-addressed. No platform type widens.

**Files:**
- Modify: `packages/benchmark-product/core/src/intake/swebench.ts`
- Modify: `packages/benchmark-product/core/src/operations/import.ts`
- Modify: `packages/benchmark-product/core/src/intake/swebench.test.ts`
- Modify: `packages/benchmark-product/core/src/operations/import.test.ts`

**Interfaces:**
- Consumes: `sweRebenchRowToTaskAndSpec(row): {evaluationSpec, evaluationSpecDigest, ...}` and `sealEvaluationSpec(spec): {bytes, digest}` from `@jinn-network/task-execution-profiles` (already a dependency); `putSealedBytes(workspaceDir, bytes): string` / `getSealedBytes` from `../workspace/sealed-store.js`.
- Produces: `convertSweBenchRows` returns `ConvertedSweBenchRows = { imported: ImportedBenchmark; evaluationSpecs: readonly { digest: string; bytes: Uint8Array }[] }` — **a product-side type. `ImportedBenchmark` is untouched.** `ImportSweBenchRowsResult` gains `evaluationSpecSha256s: readonly string[]`.
- **Storage key:** the spec's own digest (bare hex). Content-addressed, so no mapping table — the venue already recovers it via `getSealedBytes(workspaceDir, taskDoc.evaluation.digest.sha256)` (`run/drive.ts:358-374`, `run/assembly-ports.ts:54-70`).

- [ ] **Step 1: Write the failing test**

Add to `packages/benchmark-product/core/src/operations/import.test.ts`:

```ts
test("persists every imported task's EvaluationSpec bytes under the digest its Task references", () => {
  const context = contextFor(workspaceDir, clock);
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, { draftId: "d1", name: "Import" }).ok).toBe(true);
  const imported = importSweBenchRows(context, { draftId: "d1", rows: [GOLDEN_ROW] });
  expect(imported.ok, JSON.stringify(imported)).toBe(true);
  if (!imported.ok) throw new Error("unreachable");

  expect(imported.result.evaluationSpecSha256s).toHaveLength(1);

  // The binding property: the bytes must be retrievable under exactly the digest the sealed Task
  // points at, because that is the only key the venue's evaluation path ever looks up
  // (run/drive.ts:358-374). A digest that resolves to nothing is what made SWE tasks ungradeable.
  for (const taskSha256 of imported.result.taskSha256s) {
    const taskDoc = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, taskSha256))) as {
      evaluation?: { digest?: { sha256?: string } };
    };
    const specSha256 = taskDoc.evaluation?.digest?.sha256;
    expect(specSha256).toMatch(/^[a-f0-9]{64}$/u);
    const specBytes = getSealedBytes(workspaceDir, specSha256 as string);
    expect(specBytes.byteLength).toBeGreaterThan(0);
    expect(imported.result.evaluationSpecSha256s).toContain(specSha256);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/benchmark-product/core && yarn vitest run src/operations/import.test.ts
```
Expected: FAIL — `evaluationSpecSha256s` is undefined, and `getSealedBytes` refuses `not-found` for the spec digest.

- [ ] **Step 3: Re-seal in the intake**

In `packages/benchmark-product/core/src/intake/swebench.ts`, after the existing distinctness check, re-derive and return each row's spec bytes:

```ts
import { sealEvaluationSpec, sweRebenchRowToTaskAndSpec } from "@jinn-network/task-execution-profiles";

export interface ConvertedSweBenchRows {
  readonly imported: ImportedBenchmark;
  /** One entry per row, keyed by its own digest. The platform's `ImportedBenchmark` deliberately
   *  carries only the digest, so the product re-seals to retain the bytes the venue requires. */
  readonly evaluationSpecs: readonly { readonly digest: string; readonly bytes: Uint8Array }[];
}
```

and, inside `convertSweBenchRows`, replacing the bare `return imported;`:

```ts
  const evaluationSpecs = (parsedRows.data as unknown as readonly SweBenchRow[]).map((row) => {
    const mapped = sweRebenchRowToTaskAndSpec(row);
    const sealed = sealEvaluationSpec(mapped.evaluationSpec);
    // Sealing is deterministic, so re-sealing reproduces the exact bytes the Task already commits
    // to. Assert rather than assume — a drift here would persist bytes under a digest no Task
    // references, which is silent and would only surface as an ungradeable cell mid-run.
    if (sealed.digest !== mapped.evaluationSpecDigest) {
      refuse("record-integrity", "rows", `re-sealed EvaluationSpec digest ${sealed.digest} does not match ${mapped.evaluationSpecDigest}`);
    }
    return { digest: sealed.digest.slice("sha256:".length), bytes: sealed.bytes };
  });

  return { imported, evaluationSpecs };
```

- [ ] **Step 4: Persist in the operation**

In `packages/benchmark-product/core/src/operations/import.ts`, unpack the new shape, store each spec, and expose the digests — mirroring the two existing `putSealedBytes` digest-match assertions:

```ts
    const converted = convertSweBenchRows(input.rows, { /* unchanged */ });
    const imported = converted.imported;

    const evaluationSpecSha256s = converted.evaluationSpecs.map((spec) => {
      const stored = putSealedBytes(clockedContext.workspaceDir, spec.bytes);
      if (stored !== spec.digest) {
        refuse("record-integrity", "rows", `stored EvaluationSpec digest ${stored} does not match ${spec.digest}`);
      }
      return stored;
    });
```

Add `evaluationSpecSha256s: readonly string[]` to `ImportSweBenchRowsResult` and include it in the returned object. Every other reference to `converted` becomes `imported`.

- [ ] **Step 5: Run the tests**

```bash
cd packages/benchmark-product/core && yarn vitest run src/operations/import.test.ts src/intake/swebench.test.ts
```
Expected: PASS. Update `intake/swebench.test.ts`'s existing assertions from `converted.tasks` to `converted.imported.tasks` — a mechanical rename, no assertion weakened.

- [ ] **Step 6: Run the full core suite**

```bash
cd packages/benchmark-product/core && yarn typecheck && yarn test
```
Expected: green. **The P5 micro-slate test on the sibling branch is unaffected** — it calls `convertSweBenchRows` only through `imported`-shaped assertions it will inherit when the branches merge.

- [ ] **Step 7: Commit**

```bash
git add packages/benchmark-product/core/
git commit -m "fix(benchmark-product): retain EvaluationSpec bytes at SWE-bench intake"
```

---

## Task 4: Per-task `created_at` provenance timestamps (half c)

Today one importer-chosen constant stamps every row, so `clean-subset@1`'s per-task contamination predicate collapses to a single global boolean the importer controls — it can retain 100% of any slate as "clean." Real per-instance dates make the claim auditable.

**Files:**
- Modify: `packages/benchmarking/interop/src/import/swebench.ts`
- Create: `packages/benchmarking/interop/src/import/rfc3339-from-source.ts`
- Create: `packages/benchmarking/interop/src/import/rfc3339-from-source.test.ts`
- Modify: `packages/benchmark-product/core/src/intake/swebench.ts`, `operations/import.ts`

**Interfaces:**
- Consumes: `isCalendarStrictRfc3339` from `@jinn-network/benchmarking-records` (`records/src/rfc3339.ts:132-134`).
- Produces: `DefineBenchmarkOptions.provenanceTimestamps?: Readonly<Record<string, string>>` keyed by `instance_id`; `toCalendarStrictRfc3339(value: string): string`.

**Design note:** keyed by `instance_id`, not a parallel array — `instance_id` is the row's own stable natural key (already `min(1)`-validated at `intake/swebench.ts:34`), while positional arrays silently mis-associate on reorder. Resolution mirrors the sibling importer's idiom at `inspect.ts:86`.

- [ ] **Step 1: Write the failing converter test**

Create `packages/benchmarking/interop/src/import/rfc3339-from-source.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { toCalendarStrictRfc3339 } from "./rfc3339-from-source.js";

describe("toCalendarStrictRfc3339", () => {
  test("passes through an already-strict instant unchanged", () => {
    expect(toCalendarStrictRfc3339("2026-03-09T12:34:56Z")).toBe("2026-03-09T12:34:56Z");
    expect(toCalendarStrictRfc3339("2026-03-09T12:34:56+02:00")).toBe("2026-03-09T12:34:56+02:00");
  });

  test("promotes a bare calendar date to midnight UTC", () => {
    expect(toCalendarStrictRfc3339("2026-03-09")).toBe("2026-03-09T00:00:00Z");
  });

  test("repairs a space-separated timestamp", () => {
    expect(toCalendarStrictRfc3339("2026-03-09 12:34:56")).toBe("2026-03-09T12:34:56Z");
  });

  test("refuses anything it cannot convert explicitly, rather than guessing", () => {
    // A lenient Date-based coercion is exactly what records/src/rfc3339.ts:126-131 warns against
    // inheriting. A wrong-but-valid-looking timestamp degrades the per-task granularity this
    // exists to add, and would never raise.
    expect(() => toCalendarStrictRfc3339("not-a-date")).toThrow(/cannot be converted/u);
    expect(() => toCalendarStrictRfc3339("2026-02-30")).toThrow(/cannot be converted/u);
    expect(() => toCalendarStrictRfc3339("1772000000")).toThrow(/cannot be converted/u);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/benchmarking/interop && yarn vitest run src/import/rfc3339-from-source.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the converter**

Create `packages/benchmarking/interop/src/import/rfc3339-from-source.ts`:

```ts
import { isCalendarStrictRfc3339 } from "@jinn-network/benchmarking-records";

/**
 * Converts an upstream dataset timestamp into the calendar-strict RFC 3339 form the provenance
 * cluster/timestamp resolver requires, using explicit shape repairs only.
 *
 * Deliberately never routes through `Date` parsing: a lenient parser silently normalizes
 * impossible dates (2026-02-30 becomes March 2) and would produce a wrong-but-valid timestamp,
 * which degrades contamination accounting without ever raising.
 */
export function toCalendarStrictRfc3339(value: string): string {
  const candidates = [
    value,
    /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00Z` : undefined,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value) ? `${value.replace(" ", "T")}Z` : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && isCalendarStrictRfc3339(candidate)) return candidate;
  }
  throw new Error(`timestamp ${JSON.stringify(value)} cannot be converted to calendar-strict RFC 3339`);
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd packages/benchmarking/interop && yarn vitest run src/import/rfc3339-from-source.test.ts
```
Expected: 4/4 PASS.

- [ ] **Step 5: Write the failing per-instance threading test**

Append to `packages/benchmarking/interop/src/import/swebench.cluster.test.ts`:

```ts
test("stamps each instance with its own provenance timestamp when supplied", () => {
  const imported = importSweBench(ROWS, {
    ...OPTS,
    provenanceTimestamps: {
      "swe-rebench-cluster-00001": "2026-01-03T00:00:00Z",
      "swe-rebench-cluster-00002": "2026-02-14T00:00:00Z",
    },
  });
  const byDigest = new Map(imported.tasks.map((task) => [task.digest, task.bytes]));
  const timestamps = imported.tasks.map((task) => {
    const resolved = resolveBenchmarkTaskProvenance(task.digest, (digest) => byDigest.get(digest as `sha256:${string}`));
    if (!resolved.ok) throw new Error("provenance did not resolve");
    return resolved.provenance.timestamp;
  });
  // Two overridden, the third falling back to the batch value — so clean-subset@1's per-task
  // predicate has real per-instance signal instead of one importer-chosen global boolean.
  expect(new Set(timestamps).size).toBe(3);
  expect(timestamps).toContain("2026-01-03T00:00:00Z");
  expect(timestamps).toContain("2026-02-14T00:00:00Z");
  expect(timestamps).toContain("2026-07-29T00:00:00Z");
});

test("omitting the map leaves the default path byte-identical", () => {
  // intake/swebench.test.ts:40-49 depends on this determinism.
  const first = importSweBench(ROWS, OPTS);
  const second = importSweBench(ROWS, OPTS);
  expect(second.tasks.map((task) => task.digest)).toEqual(first.tasks.map((task) => task.digest));
  expect(second.benchmark.digest).toBe(first.benchmark.digest);
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
cd packages/benchmarking/interop && yarn vitest run src/import/swebench.cluster.test.ts
```
Expected: the per-instance test FAILS — all three timestamps identical (set size 1, not 3).

- [ ] **Step 7: Thread the map through**

In `packages/benchmarking/interop/src/import/swebench.ts`, add to `DefineBenchmarkOptions`:

```ts
  /** Per-instance RFC 3339 provenance timestamps, keyed by `instance_id`. Falls back to
   *  `provenanceTimestamp`, then the batch default. Keyed rather than positional so a reordered
   *  row list can never silently mis-associate a date with an instance. */
  provenanceTimestamps?: Readonly<Record<string, string>>;
```

Change `sealRepositoryWorkTask` to take the resolved timestamp per row, and in `importSweBench`:

```ts
  const tasks = rows.map((row) =>
    sealRepositoryWorkTask(
      row,
      opts.provenanceTimestamps?.[row.instance_id] ?? provenanceTimestamp,
    ),
  );
```

- [ ] **Step 8: Thread through the product edge**

Add the same optional field to `ConvertSweBenchRowsOptions` (`intake/swebench.ts`) and `ImportSweBenchRowsInput` (`operations/import.ts`), using the conditional-spread pattern already at `import.ts:67`.

- [ ] **Step 9: Run everything**

```bash
cd packages/benchmarking/interop && yarn test
cd ../../benchmark-product/core && yarn typecheck && yarn test
```
Expected: green, including the untouched determinism tests.

- [ ] **Step 10: Commit**

```bash
git add packages/benchmarking/interop/ packages/benchmark-product/core/
git commit -m "feat(benchmarking): thread per-instance provenance timestamps through SWE import"
```

---

## Acceptance checklist

- [ ] Regression test reproduces today's singleton degeneracy **before** the fix and passes after.
- [ ] Cluster key is repo-level and carries no commit; tasks remain distinct.
- [ ] Realistic-key conformance fixture pins six tasks → two clusters, so this cannot silently regress.
- [ ] `expected.json` **unedited**; `expected.v2.json` added; erratum written; both fixture gates pass.
- [ ] `evaluationSpecDigest` unchanged across the supersession (proves only provenance moved).
- [ ] Spec bytes retrievable under exactly the digest each Task references.
- [ ] `ImportedBenchmark` and `SweRebenchRow` untouched.
- [ ] Per-instance timestamps produce distinct values; omitting the map is byte-deterministic.
- [ ] Converter refuses rather than guesses on unconvertible input.
- [ ] Full local chain green: interop, records, testing, benchmark-product core.
- [ ] PR body carries the one-way-door disclosure and the local verification record.

## Self-review notes

- **Coverage.** (a) Task 1 + Task 2; (b) Task 3; (c) Task 4. The coordinator's "regression test first" and "conformance gap" requirements are Tasks 1 and 2 respectively.
- **Type consistency.** `ConvertedSweBenchRows.evaluationSpecs[].digest` is bare hex (matching `putSealedBytes`'s return and the Task's `evaluation.digest.sha256`), while `sealEvaluationSpec` returns the `sha256:`-prefixed form — the prefix is stripped exactly once, in Task 3 Step 3, and asserted at both boundaries.
- **Fallback recorded.** Half (c)'s ratified fallback (drop the method for slate-level attestation if threading turns ugly) is not exercised: the seam is an optional options field with no change to `SweRebenchRow` and no change to default behavior. If Task 4 Step 7 proves otherwise, stop and record the choice in the PR body per the ruling.
