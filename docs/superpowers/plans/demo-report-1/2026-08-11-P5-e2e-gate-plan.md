# P5 — End-to-End Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

| | |
|---|---|
| **Status** | **PROVISIONAL** — pending operator rulings on gap assignment (see Provisionality below) |
| **Version** | 0.1 |
| **Date** | 2026-08-11 |
| **Lane** | C4 (Slate & E2E) |
| **Packet** | P5, `test(benchmark-product)` |
| **Base** | `integration/evidence-v1` @ `04f309de8` — all citations verified against this head |
| **Budget** | 1–1.5 agent-days (P5 proper, gaps assigned elsewhere) |

**Goal:** Prove that the benchmark-product local venue runs a 3-task × 2-arm × 2-replicate SWE-bench-shaped micro-benchmark through `draft → import → arms → quote → lock → launch → collect → report → verify` with real container grading, zero manual intervention, every cell accounted.

**Architecture:** Mirror the existing real-local-venue integration pattern (`run-cancel.integration.test.ts`) but substitute `importSweBenchRows` for `sampleInit` — structurally sound because both intake operations converge on the same `attachBenchmarkToDraft` boundary (`operations/attach.ts`). Add a committed micro-slate fixture minted by a reproducible script, a walkthrough script mirroring `m1-walkthrough.mjs`, and a dated evidence doc mirroring the M1 evidence doc.

**Tech Stack:** TypeScript, Vitest, `packages/benchmark-product/core`, `@jinn-network/benchmarking-{records,run,aggregate}`, Docker (local only, never CI).

---

## Provisionality — read before starting

This plan is **provisional**. Three things can change it, and the affected tasks say so inline:

1. **Gap assignment is unratified.** The program coordinator has recommended homing the interop importer fixes + minting path as a new **P0-interop** packet in lane C4, and grader-image publication + registry + parser identity as **P3c** in lane C2, with `timeout = FAIL` as the declared default. **The operator has not ruled.** This plan assumes that recommendation holds and scopes P5 as the *pure e2e gate only*. If the gaps land back on P5, this plan is materially under-scoped and the lane must re-escalate rather than absorb them.

2. **The grading design is contested.** Two designs now exist in-repo. P3 as specced wires the shipped `jinn.grader-context.v1` contract with per-instance grader images pushed to a registry (PR #2558, `client/deployments/evaluator/swe-rebench-v2-grader/`). PR #2556 landed a working alternative in `packages/policy-optimization/src/host-local/` that pulls the digest-pinned *upstream* image and bind-mounts a host-authored grader read-only — no build, no push, no registry. **This plan is deliberately grading-design-agnostic:** P5 consumes grading only through the seam P3 publishes (Task 3's `Interfaces: Consumes` block). A change of design costs P5 one interface line, not a rewrite.

3. **One statistics field name is outstanding.** C3 supplies the exact field for the no-interval outcome at P4 plan time. Task 4 asserts on *behavior* and names the field as a single, clearly-marked substitution point.

**Blocking precondition, non-negotiable:** the cluster-key importer fix must land before any slate is minted for official use. It changes sealed Task bytes and therefore every downstream digest. P5's own fixture is disposable and may be minted before the fix; **nothing minted before the fix may be reused for the official run.**

## Global Constraints

Copied verbatim from the program docs; every task's requirements implicitly include these.

- **Consumption contract holds:** public package exports only; no deep imports; no copied platform code; **no product-implemented statistics** — every number comes from a named `BENCHMARKING_METHOD_REGISTRY` method.
- **No new record kinds; no tier-1–3 semantics changes.**
- **Docker is local-only.** Container e2e is a local runbook plus recorded evidence. The CI-dockerized variant is explicitly out of scope. Nothing in this plan may make `packages/benchmark-product`'s CI suite require Docker.
- **CI blindness rule:** the packet PR body must record a local full-chain verification (portal build order from `benchmark-product-ci.yml:69-92` → core suite).
- **Prediction sample byte-stable:** the enumerated venue/quote/compile/integration test set must stay green unmodified. P5 adds files; it must not edit prediction-path literals.
- **American English** in identifiers, paths, and copy.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/benchmark-product/core/scripts/mint-micro-slate.mjs` | **Create.** Fetches the micro-slate rows from the public HF datasets-server, applies the R5 exclusion filters, resolves image digests, writes the fixture. Reproducible; not run in CI. |
| `packages/benchmark-product/core/fixtures/p5-micro-slate/rows.json` | **Create.** The committed 3-row `SweRebenchRow[]` micro-slate. |
| `packages/benchmark-product/core/fixtures/p5-micro-slate/provenance.json` | **Create.** Mint metadata — dataset, split, fetch timestamp, per-row source URL and resolved image digest. Makes the fixture auditable without a re-fetch. |
| `packages/benchmark-product/core/src/intake/p5-micro-slate.test.ts` | **Create.** Validates the committed fixture against the R5 exclusion rules and the `SweBenchRowSchema`. Runs in CI; no network, no Docker. |
| `packages/benchmark-product/core/scripts/p5-green-baseline.mjs` | **Create.** Grader-validity control: proves the grader returns PASS on the gold patch and FAIL on an empty patch, per exclusion rule 5. Local, Docker-gated. |
| `packages/benchmark-product/core/src/run/p5-e2e.integration.test.ts` | **Create.** The gate test. Docker-gated by env; skipped by default. |
| `packages/benchmark-product/core/scripts/p5-walkthrough.mjs` | **Create.** Drives the built CLI end-to-end as real child processes. Mirrors `m1-walkthrough.mjs`. |
| `docs/superpowers/plans/demo-report-1/P5-evidence.md` | **Create.** Recorded evidence: sealed digests, honest limits. Mirrors the M1 evidence doc. |

**Runbook correction (binding):** the program doc names `docs/runbooks/launch-swe-rebench-v2.md` as the runbook pattern. **That is the wrong artifact** — it is the on-chain daemon SolverNet launcher, verified via BaseScan transaction links, not a local-venue procedure and not a committed-evidence pattern. The correct pattern is `packages/benchmark-product/core/scripts/m1-walkthrough.mjs` plus `docs/superpowers/plans/2026-08-06-benchmark-product-m1-evidence.md` (records sealed digests and an "honest limits" section; the raw transcript is deliberately *not* committed, only reproducible on demand). Follow the M1 pattern. Do not create a `docs/runbooks/` file.

### How the expected-PASS cell is arranged (design note)

The coordinator requires that the gate exercise the pass path — "a gate that never exercises the pass path proves less than it claims." Picking an easy task and hoping the agent solves it is not a gate; it is a coin flip that makes the suite flaky.

Instead the pass path is proven **deterministically at the grader**, by Task 1's green-baseline control: run the real container grader against the instance's **gold patch** (must PASS) and against an **empty patch** (must FAIL). This is exclusion rule 5, and it proves both grader outcomes without depending on any agent succeeding. The gold patch enters only the grader-validation script — **never** the agent's context, never the sealed Task, never the fixture (PR #2556 enforces the same discipline: `parseHfRow` never reads the row's `patch` field, asserted at `swe-rebench-journey.test.ts:121`). Task 3 then asserts that the real run's cells are all *accounted*, which is the property a gate can actually guarantee.

---

## Task 1: Micro-slate fixture and its validation

Self-contained. Depends on no other packet — **start here regardless of operator rulings.**

**Files:**
- Create: `packages/benchmark-product/core/scripts/mint-micro-slate.mjs`
- Create: `packages/benchmark-product/core/fixtures/p5-micro-slate/rows.json`
- Create: `packages/benchmark-product/core/fixtures/p5-micro-slate/provenance.json`
- Test: `packages/benchmark-product/core/src/intake/p5-micro-slate.test.ts`

**Interfaces:**
- Consumes: `convertSweBenchRows(rowsInput: unknown, opts: ConvertSweBenchRowsOptions): ImportedBenchmark` from `../intake/swebench.js`; `SweBenchRowSchema` shape per `packages/task-execution/profiles/src/documents/swe-rebench.ts:16-27`.
- Produces: the committed fixture at `fixtures/p5-micro-slate/rows.json`, consumed by Tasks 2–5.

**The slate (R5-selected, all three images verified live on Docker Hub 2026-08-11):**

| instance_id | repo | F2P | P2P | image size |
|---|---|---|---|---|
| `gerlero__foamlib-329` | gerlero/foamlib | 1 | 1 | 1.49 GB |
| `qBraid__pyqasm-120` | qBraid/pyqasm | 1 | 4 | 1.30 GB |
| `python-wheel-build__fromager-626` | python-wheel-build/fromager | 1 | 6 | 1.26 GB |

**Three distinct repos is a hard requirement, not an accident.** The clustered bootstrap groups by provenance source. A single-repo slate is the lazy choice (one image, faster) and collapses to `clusterCount = 1`, which silently skips the clustering path entirely. Do not "optimize" this to one repo.

Note the image-name lowercasing convention: `qBraid` → `qbraid`, so `qBraid__pyqasm-120` maps to `swerebench/sweb.eval.x86_64.qbraid_1776_pyqasm-120`. The mint script must take `image_name` from the row rather than deriving it.

- [ ] **Step 1: Write the failing fixture-validation test**

Create `packages/benchmark-product/core/src/intake/p5-micro-slate.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { convertSweBenchRows } from "./swebench.js";

const ROWS_PATH = fileURLToPath(new URL("../../fixtures/p5-micro-slate/rows.json", import.meta.url));

type Row = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  language: string;
  image: { name?: string; uri?: string; digest?: Record<string, string> };
  testMaterial: unknown[];
  parser: { id: string; version: string; digest: string };
  transitions: { failToPass: string[]; passToPass: string[] };
  timeout: number;
};

function loadRows(): Row[] {
  return JSON.parse(readFileSync(ROWS_PATH, "utf8")) as Row[];
}

describe("P5 micro-slate fixture", () => {
  test("has exactly three tasks spanning three distinct source repos", () => {
    const rows = loadRows();
    expect(rows).toHaveLength(3);
    // The clustered bootstrap groups by provenance source. Three distinct repos keeps
    // clusterCount = 3 so the clustering path actually executes; one repo would collapse
    // it to 1 and silently skip that path.
    expect(new Set(rows.map((row) => row.repo)).size).toBe(3);
  });

  test("every image is digest-pinned", () => {
    // containerGraderReportSource refuses an unpinned image at grade time
    // (container-grader-source.ts:181-201). Failing here is far cheaper than failing mid-run.
    for (const row of loadRows()) {
      expect(row.image.digest?.["sha256"], row.instance_id).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  test("respects the declared transition-size caps", () => {
    // R5 exclusion rule 3, declared numerically before selection.
    for (const row of loadRows()) {
      expect(row.transitions.failToPass.length, row.instance_id).toBeGreaterThan(0);
      expect(row.transitions.failToPass.length, row.instance_id).toBeLessThanOrEqual(10);
      expect(row.transitions.passToPass.length, row.instance_id).toBeLessThanOrEqual(100);
    }
  });

  test("carries a positive integer timeout on every row", () => {
    // Upstream publishes no per-task timeout; it is assigned by policy at mint.
    for (const row of loadRows()) {
      expect(Number.isInteger(row.timeout), row.instance_id).toBe(true);
      expect(row.timeout, row.instance_id).toBeGreaterThan(0);
    }
  });

  test("never carries a gold solution", () => {
    // The gold patch belongs only to the green-baseline grader control, never to a sealed Task.
    const raw = readFileSync(ROWS_PATH, "utf8");
    expect(raw).not.toContain("\"patch\"");
  });

  test("converts to a sealed Benchmark over three distinct Task digests", () => {
    const imported = convertSweBenchRows(loadRows(), {
      name: "P5 micro-slate",
      description: "Three-task SWE-bench-shaped gate slate spanning three source repos.",
      version: "0.1.0",
      provenanceTimestamp: "2026-08-11T00:00:00Z",
    });
    expect(imported.tasks).toHaveLength(3);
    expect(new Set(imported.tasks.map((task) => task.digest)).size).toBe(3);
    expect(imported.benchmark.record.items).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/benchmark-product/core && yarn vitest run src/intake/p5-micro-slate.test.ts
```
Expected: FAIL — `ENOENT` on `fixtures/p5-micro-slate/rows.json`.

- [ ] **Step 3: Write the mint script**

Create `packages/benchmark-product/core/scripts/mint-micro-slate.mjs`. It fetches from the public, unauthenticated HF datasets-server (same endpoint PR #2556 uses at `swe-rebench-journey.ts:278`), applies the exclusion filters, resolves each image to a digest, and writes both files.

```js
#!/usr/bin/env node
// Mints the committed P5 micro-slate. Reproducible, never run in CI.
//   node scripts/mint-micro-slate.mjs
// Requires: network access to datasets-server.huggingface.co, and `docker` on PATH
// for image-digest resolution.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATASET = "nebius/SWE-rebench-leaderboard";
const SPLIT = "test";
const INSTANCES = ["gerlero__foamlib-329", "qBraid__pyqasm-120", "python-wheel-build__fromager-626"];
// Upstream publishes no per-task timeout (leaderboard `harbor_verifier_timeout_sec` is null on
// 856/860 rows). 1800s matches the upstream harness default and is declared here, before results.
const TIMEOUT_SECONDS = 1800;
const MAX_FAIL_TO_PASS = 10;
const MAX_PASS_TO_PASS = 100;

const outDir = fileURLToPath(new URL("../fixtures/p5-micro-slate/", import.meta.url));

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return JSON.parse(value);
  throw new Error(`expected an array or JSON-encoded array, received ${typeof value}`);
}

async function fetchRows() {
  const url = new URL("https://datasets-server.huggingface.co/rows");
  url.searchParams.set("dataset", DATASET);
  url.searchParams.set("config", "default");
  url.searchParams.set("split", SPLIT);
  url.searchParams.set("length", "100");
  const found = new Map();
  for (let offset = 0; offset < 900 && found.size < INSTANCES.length; offset += 100) {
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`datasets-server returned ${response.status}`);
    const page = await response.json();
    if (page.rows.length === 0) break;
    for (const entry of page.rows) {
      if (INSTANCES.includes(entry.row.instance_id)) found.set(entry.row.instance_id, entry.row);
    }
  }
  const missing = INSTANCES.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`instances not found upstream: ${missing.join(", ")}`);
  return INSTANCES.map((id) => found.get(id));
}

function resolveImageDigest(imageName) {
  const raw = execFileSync(
    "docker",
    ["buildx", "imagetools", "inspect", imageName, "--format", "{{json .Manifest}}"],
    { encoding: "utf8" },
  );
  const digest = JSON.parse(raw).digest;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`could not resolve a sha256 digest for ${imageName}`);
  }
  return digest.slice("sha256:".length);
}

const upstream = await fetchRows();
const rows = [];
const provenance = [];

for (const row of upstream) {
  const failToPass = asArray(row.FAIL_TO_PASS);
  const passToPass = asArray(row.PASS_TO_PASS);
  if (failToPass.length === 0 || failToPass.length > MAX_FAIL_TO_PASS) {
    throw new Error(`${row.instance_id} violates the fail-to-pass cap`);
  }
  if (passToPass.length > MAX_PASS_TO_PASS) {
    throw new Error(`${row.instance_id} violates the pass-to-pass cap`);
  }
  const digest = resolveImageDigest(row.image_name);
  // NOTE: `image` must reference whatever image the P3 grading design actually runs. Under a
  // per-instance grader-image design this is the built-and-pushed grader ref; under a
  // pull-and-mount design it is the upstream instance image resolved here. See Task 3.
  rows.push({
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    problem_statement: row.problem_statement,
    // The v1/leaderboard schema has no `language` column — the corpus is Python-only.
    language: "python",
    image: { name: row.image_name, digest: { sha256: digest } },
    // The schema permits an empty array (family-blocks.ts:82 has no .min(1)); the gold test
    // patch reaches the grader through the P3 grading seam, not through a slate descriptor.
    testMaterial: [],
    parser: {
      id: row.install_config.log_parser,
      version: "1.0.0",
      digest: `sha256:${"0".repeat(64)}`, // PLACEHOLDER — replaced by P3c's parser identity.
    },
    transitions: { failToPass, passToPass },
    timeout: TIMEOUT_SECONDS,
  });
  provenance.push({
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    sourceUrl: `https://huggingface.co/datasets/${DATASET}`,
    split: SPLIT,
    imageName: row.image_name,
    imageDigest: `sha256:${digest}`,
  });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}rows.json`, `${JSON.stringify(rows, null, 2)}\n`);
writeFileSync(
  `${outDir}provenance.json`,
  `${JSON.stringify({ dataset: DATASET, split: SPLIT, mintedAt: new Date().toISOString(), timeoutSeconds: TIMEOUT_SECONDS, rows: provenance }, null, 2)}\n`,
);
console.log(`minted ${rows.length} rows across ${new Set(rows.map((r) => r.repo)).size} repos`);
```

**Parser digest is a known placeholder.** `ParserIdentity` is `z.strictObject({id, version, digest})` (`family-blocks.ts:64-69`) and upstream supplies only a bare string id. Deciding what that digest is a digest *of* is gap (d), recommended to C2's P3c. Until it lands, the fixture carries a zeroed placeholder and this plan does not pretend otherwise. **Task 4's report assertions must not depend on the parser digest's value.**

- [ ] **Step 4: Run the mint script and the test**

```bash
cd packages/benchmark-product/core && node scripts/mint-micro-slate.mjs && yarn vitest run src/intake/p5-micro-slate.test.ts
```
Expected: mint prints `minted 3 rows across 3 repos`; all six tests PASS.

- [ ] **Step 5: Write the green-baseline grader control**

Create `packages/benchmark-product/core/scripts/p5-green-baseline.mjs`. This is exclusion rule 5 and the deterministic proof of the grader's PASS path. It fetches the gold patch **at run time** — never writing it to disk beside the fixture — applies it in the grading container, and asserts PASS; then asserts an empty patch yields FAIL.

Because it drives the grading seam, its exact invocation depends on the design P3 publishes. Write it against the seam named in Task 3's `Interfaces: Consumes` block, and structure it as:

```js
#!/usr/bin/env node
// Grader-validity control (R5 exclusion rule 5): the grader must return PASS on the gold
// patch and FAIL on an empty patch, for every slate row. Local + Docker only.
//
// The gold patch is fetched here at run time and never persisted next to the fixture — it must
// never enter a sealed Task or an agent's context.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rows = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/p5-micro-slate/rows.json", import.meta.url)), "utf8"));

for (const row of rows) {
  const goldPatch = await fetchGoldPatch(row.instance_id);      // defined against the P3 seam
  const good = await gradeWithPatch(row, goldPatch);            // defined against the P3 seam
  if (good.verdict !== "pass") throw new Error(`${row.instance_id}: gold patch did not PASS (${good.verdict})`);
  const bad = await gradeWithPatch(row, "");
  if (bad.verdict === "pass") throw new Error(`${row.instance_id}: empty patch PASSED — grader is not discriminating`);
  console.log(`${row.instance_id}: gold=pass empty=${bad.verdict} OK`);
}
console.log("green baseline: all rows discriminate correctly");
```

- [ ] **Step 6: Commit**

```bash
git add packages/benchmark-product/core/scripts/mint-micro-slate.mjs \
        packages/benchmark-product/core/scripts/p5-green-baseline.mjs \
        packages/benchmark-product/core/fixtures/p5-micro-slate/ \
        packages/benchmark-product/core/src/intake/p5-micro-slate.test.ts
git commit -m "test(benchmark-product): add P5 micro-slate fixture and its exclusion-rule validation"
```

---

## Task 2: The chain to lock — import, arms, quote, lock

**Depends on P1** (venue admits `repository-work/1.0`). Until P1 lands, Step 2's failure is the *expected* red and documents the seam.

**Files:**
- Create: `packages/benchmark-product/core/src/run/p5-e2e.integration.test.ts`

**Interfaces:**
- Consumes, all from `packages/benchmark-product/core/src/operations/` and all re-exported from the public barrel under identical names:
  - `initWorkspace(context: OperationContext): OperationResult<...>`
  - `createDraft(context, { draftId, name }): OperationResult<{ draft: DraftDocument }>`
  - `importSweBenchRows(context, { draftId, rows, name?, description?, version?, provenanceTimestamp? }): OperationResult<{ draft; benchmarkSha256: string; taskSha256s: readonly string[] }>`
  - `armAdd(context, { draftId, armId, pinning }): OperationResult<{ draft; warnings }>`
  - `runQuote(context, { draftId }, deps?): Promise<OperationResult<{ draft; quote; presentation: QuotePresentation }>>`
  - `runLock(context, { draftId }): OperationResult<{ draft; runSha256: string; closeAt: string }>` — **synchronous, unlike its neighbours**
  - `OperationContext = { workspaceDir: string; principal: string; clock: () => string }`
- Consumes from **P1**: a `repository-work/1.0`-capable arm pin. P1 must publish the pin constant it registers. This plan references it as `REPOSITORY_WORK_HARNESS_PIN`; substitute P1's actual exported name.
- Produces: `setUpLockedDraft()` and the module's fixtures, used by Tasks 3–4.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft } from "../operations/drafts.js";
import { importSweBenchRows } from "../operations/import.js";
import { initWorkspace } from "../operations/init.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";

// The gate is Docker-bound and must never run in CI (benchmark-product ships no Docker
// dependency anywhere). Gate it explicitly, matching the repo's existing convention
// (policy-optimization uses JINN_POLICY_OPTIMIZATION_REAL_SOURCE the same way).
const GATED = process.env["JINN_P5_E2E"] === "1";

const MICRO_SLATE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/p5-micro-slate/rows.json", import.meta.url)), "utf8"),
) as unknown[];

const REPLICATES = 2;

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "p5-e2e-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function clock(): string {
  return new Date().toISOString();
}

function contextFor(principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpLockedDraft(draftId: string): Promise<{ runSha256: string }> {
  expect(initWorkspace(contextFor()).ok).toBe(true);
  expect(createDraft(contextFor(), { draftId, name: "P5 Gate" }).ok).toBe(true);

  const imported = importSweBenchRows(contextFor(), {
    draftId,
    rows: MICRO_SLATE,
    name: "P5 micro-slate",
    description: "Three-task SWE-bench-shaped gate slate spanning three source repos.",
    version: "0.1.0",
    provenanceTimestamp: "2026-08-11T00:00:00Z",
  });
  expect(imported.ok, JSON.stringify(imported)).toBe(true);
  if (!imported.ok) throw new Error("unreachable");
  expect(imported.result.taskSha256s).toHaveLength(3);

  // Two arms, byte-identical except the axis under test. P2 owns the real claude-code pins.
  expect(armAdd(contextFor(), { draftId, armId: "arm-a", pinning: ARM_A_PINNING }).ok).toBe(true);
  expect(armAdd(contextFor(), { draftId, armId: "arm-b", pinning: ARM_B_PINNING }).ok).toBe(true);

  const quoted = await runQuote(contextFor(), { draftId });
  expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
  if (!quoted.ok) throw new Error("unreachable");

  // The P1 acceptance made visible: a repository-work arm must draw ZERO coverage refusals.
  expect(quoted.result.presentation.coverage.refusals).toEqual([]);
  expect(quoted.result.presentation.runSize.totalCells).toBe(
    3 * 2 * REPLICATES + 3 * 2 * REPLICATES, // solve cells + evaluation cells
  );

  const locked = runLock(contextFor(), { draftId });
  expect(locked.ok, JSON.stringify(locked)).toBe(true);
  if (!locked.ok) throw new Error("unreachable");
  return { runSha256: locked.result.runSha256 };
}

describe.skipIf(!GATED)("P5 end-to-end gate", () => {
  test("imports the micro-slate and locks a Run with every expected cell planned", async () => {
    const { runSha256 } = await setUpLockedDraft("p5-lock");
    expect(runSha256).toMatch(/^[a-f0-9]{64}$/u);
  }, 240_000);
});
```

**Set `replicates` to 2, not 1.** `DRAFT_SPEC_DEFAULTS.replicates` is 1 (`domain/draft.ts:165`); a run at 1 cannot catch a bug where the replicate dimension is ignored. Two is the smallest value that proves the dimension multiplies cells. Supply it via `createDraft`'s `spec` argument or a `draft update` patch — `replicates` is a mutable spec field (`operations/drafts.ts:39`).

**`ARM_A_PINNING` / `ARM_B_PINNING` come from P2.** Pin `{id, version}`, never id-only — an id-only harness pin can never reach `match` (`pinning-bridge.ts:203-206`). Until P2 lands, substitute the venue's existing `SOLVE_HARNESS_PINS` entries to exercise the chain shape.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/benchmark-product/core && JINN_P5_E2E=1 yarn vitest run src/run/p5-e2e.integration.test.ts
```
Expected before P1: FAIL at the `coverage.refusals` assertion — the venue refuses `repository-work/1.0`, so both arms draw refusals. **This failure is the P1 seam, made executable.** Record the exact refusal text in the packet PR; it is the before-picture.

- [ ] **Step 3: Confirm the test passes once P1 has landed**

No implementation belongs to P5 here. Rebase onto P1's merged branch and re-run.

- [ ] **Step 4: Run the guard suites**

```bash
cd packages/benchmark-product/core && yarn vitest run   # unmodified prediction path must stay green
```
Expected: the full core suite PASSES, and the P5 file is SKIPPED (no `JINN_P5_E2E`).

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/core/src/run/p5-e2e.integration.test.ts
git commit -m "test(benchmark-product): chain the P5 micro-slate through import, arms, quote and lock"
```

---

## Task 3: Launch and collect with container grading

**Depends on P2** (claude-code arm) **and P3** (container grading bridge).

**Files:**
- Modify: `packages/benchmark-product/core/src/run/p5-e2e.integration.test.ts`

**Interfaces:**
- Consumes:
  - `runLaunch(context, { draftId }, deps?): Promise<OperationResult<{ draft }>>`
  - `runCollect(context, { draftId }): Promise<OperationResult<{ draft; matrixSha256: string }>>`
  - `parseMatrix(bytes)` from `@jinn-network/benchmarking-records`; `getSealedBytes(workspaceDir, sha256)` from `../workspace/sealed-store.js`
  - Matrix shape: `completeness: { expected, judged, runOutcome }`, `cells: [{ cellKey, armId, dispatches, outcome, failure? }]`, `attrition`
- Consumes from **P3 — the single grading seam.** P3 must publish how the venue's generated deployment module registers swe-rebench grading. **P5 touches nothing else about grading**, which is what keeps this plan agnostic between the two competing designs.
- Produces: a sealed Matrix digest consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Append to the `describe` block:

```ts
test("launches, grades in containers, and accounts every expected cell", async () => {
  const draftId = "p5-run";
  await setUpLockedDraft(draftId);

  const launched = await runLaunch(contextFor(), { draftId });
  expect(launched.ok, JSON.stringify(launched)).toBe(true);

  const collected = await runCollect(contextFor(), { draftId });
  expect(collected.ok, JSON.stringify(collected)).toBe(true);
  if (!collected.ok) throw new Error("unreachable");

  const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));

  // "Every expected cell accounted" — the gate's core property. 3 tasks x 2 arms x 2 replicates.
  expect(matrix.completeness.expected).toBe(12);
  expect(matrix.completeness.judged).toBe(12);
  expect(matrix.completeness.runOutcome).toBe("complete");
  expect(matrix.cells).toHaveLength(12);
  expect(matrix.cells.filter((cell) => cell.outcome === "judged")).toHaveLength(12);

  // Both arms carry the full complement — no silent asymmetry between arms.
  for (const armId of ["arm-a", "arm-b"]) {
    expect(matrix.cells.filter((cell) => cell.armId === armId), armId).toHaveLength(6);
  }

  // Every cell reached the grader exactly once. A cell judged with zero dispatches would mean
  // a verdict was produced without work.
  for (const cell of matrix.cells) {
    expect(cell.dispatches, cell.cellKey).toBeGreaterThanOrEqual(1);
  }
}, 3_600_000);
```

**The timeout is one hour, deliberately.** Measured image sizes are 1.26–1.75 GB each and the solve leg is the one component nobody publishes a figure for. R5's planning midpoint is ~10 min per cell; 12 cells plus one-time image setup projects to roughly two hours on a cold cache, well inside the bound but far outside the 240 s used by the prediction-path tests. **Record the observed wall-clock in Task 5's evidence doc** — P5 is where this number finally gets measured, and E2's power analysis is blocked on it.

- [ ] **Step 2: Run the green baseline first**

```bash
cd packages/benchmark-product/core && node scripts/p5-green-baseline.mjs
```
Expected: `green baseline: all rows discriminate correctly`. **If this fails, stop.** A grader that cannot distinguish the gold patch from an empty one makes every downstream number meaningless, and the run is not worth its hours.

- [ ] **Step 3: Run the gate test**

```bash
cd packages/benchmark-product/core && JINN_P5_E2E=1 yarn vitest run src/run/p5-e2e.integration.test.ts
```
Expected before P2/P3: FAIL at launch (no runnable arm) or at grading (no container bridge). After both land: PASS.

- [ ] **Step 4: Verify the non-gated suite is unaffected**

```bash
cd packages/benchmark-product/core && yarn vitest run
```
Expected: full suite PASSES, P5 file SKIPPED, no Docker required.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/core/src/run/p5-e2e.integration.test.ts
git commit -m "test(benchmark-product): grade the P5 micro-slate in containers and account every cell"
```

---

## Task 4: Report, verify, and the statistics assertions

**Depends on Task 3. Depends on P4** for the paired method.

**Files:**
- Modify: `packages/benchmark-product/core/src/run/p5-e2e.integration.test.ts`

**Interfaces:**
- Consumes:
  - `runReport(context, { draftId }): Promise<OperationResult<{ draft; reportSha256; reportEnvelopeSha256; preregistered; claimPackage }>>`
  - `runVerify(context, { draftId }): Promise<OperationResult<{ draftId; checks: readonly RunVerifyCheck[]; matrixSha256; reportEnvelopeSha256? }>>` where `RunVerifyCheck = "matrix-rederivation" | "report-verification" | "claim-consistency"`
  - `runVerify` reaches both `verifyMatrix` (`packages/benchmarking/run/src/verify.ts:19`) and `verifyReport` (`packages/benchmarking/aggregate/src/report.ts:373`) internally at `operations/verify.ts:116,143` — asserting on its `checks` array is how P5 satisfies "verifyMatrix + verifyReport green".
- Consumes from **C3 at P4 plan time**: the exact field path for the no-interval outcome. Marked inline.

- [ ] **Step 1: Write the failing test**

```ts
test("reports through a registry method and verifies, with honest clustered-bootstrap accounting", async () => {
  const draftId = "p5-report";
  await setUpLockedDraft(draftId);
  expect((await runLaunch(contextFor(), { draftId })).ok).toBe(true);
  const collected = await runCollect(contextFor(), { draftId });
  expect(collected.ok).toBe(true);
  if (!collected.ok) throw new Error("unreachable");

  const reported = await runReport(contextFor(), { draftId });
  expect(reported.ok, JSON.stringify(reported)).toBe(true);
  if (!reported.ok) throw new Error("unreachable");

  const claim = reported.result.claimPackage;
  // Only judged cells contribute to a denominator; six per arm, matching the Matrix.
  for (const armId of ["arm-a", "arm-b"]) {
    expect(claim.headline[armId]?.n, armId).toBe(6);
  }

  // --- Clustered-bootstrap accounting (C3's assertions) ---
  // The micro-slate spans three distinct source repos, so clusterCount must be 3. This is the
  // permanent regression guard on the singleton-cluster defect: if the importer ever reverts to
  // a per-instance cluster key, clusterCount becomes 3 by coincidence here but the unit and the
  // cluster manifest below will not agree.
  const stats = claim.method;                       // SUBSTITUTE: C3 supplies the exact accessor
  expect(stats.bootstrap.unit).toBe("source-cluster");
  expect(stats.bootstrap.draws).toBe(stats.bootstrap.resamples * stats.bootstrap.clusterCount);
  expect(stats.bootstrap.clusterCount).toBe(3);
  expect(new Set(stats.bootstrap.clusters)).toEqual(
    new Set(["gerlero/foamlib", "qBraid/pyqasm", "python-wheel-build/fromager"]),
  );

  // At three paired tasks the method is below its minimum paired-task count, so it must decline
  // to publish an interval and say why — asserted as BEHAVIOR, not as a numeric interval.
  // SUBSTITUTE the exact field name from C3 at P4 plan time.
  expect(stats.quality.verdict).toBe("inconclusive");
  expect(stats.quality.lowerBound).toBeNull();
  expect(stats.quality.reason).toMatch(/paired/iu);

  const verified = await runVerify(contextFor(), { draftId });
  expect(verified.ok, JSON.stringify(verified)).toBe(true);
  if (!verified.ok) throw new Error("unreachable");
  expect(verified.result.checks).toEqual(expect.arrayContaining([
    "matrix-rederivation",
    "report-verification",
    "claim-consistency",
  ]));
}, 3_600_000);
```

**Why the cluster assertions belong in the gate.** They are not decoration. A measurement over 100 real leaderboard rows found 100 distinct `repo@base_commit` keys against 77 distinct repos — every task its own cluster, zero collisions, which defeats the clustering correction entirely on real data while synthetic conformance fixtures keep passing. These four lines make the e2e gate a permanent guard against that class of defect returning.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/benchmark-product/core && JINN_P5_E2E=1 yarn vitest run src/run/p5-e2e.integration.test.ts -t "reports through a registry method"
```
Expected: FAIL on the statistics accessor until P4 lands and C3 supplies the field names.

- [ ] **Step 3: Substitute C3's real field names and re-run**

Replace the three `SUBSTITUTE` markers. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/benchmark-product/core/src/run/p5-e2e.integration.test.ts
git commit -m "test(benchmark-product): verify the P5 report and its clustered-bootstrap accounting"
```

---

## Task 5: Walkthrough script and recorded evidence

**Files:**
- Create: `packages/benchmark-product/core/scripts/p5-walkthrough.mjs`
- Create: `docs/superpowers/plans/demo-report-1/P5-evidence.md`

**Interfaces:**
- Consumes: the built CLI at `dist/`, verbs `draft create`, `import swebench`, `arm add`, `quote`, `lock`, `launch`, `collect`, `report`, `verify` (dispatch table at `cli/main.ts:635-666`).
- Produces: the evidence doc — P5's durable deliverable.

- [ ] **Step 1: Write the walkthrough script**

Model it directly on `packages/benchmark-product/core/scripts/m1-walkthrough.mjs` (243 lines): build first, then drive the CLI as real child processes, asserting each verb's exit code and capturing the sealed digests it prints. Where M1 calls `sample init`, call `import swebench --file ../fixtures/p5-micro-slate/rows.json`. Print a digest summary at the end for transcription into the evidence doc.

The test proves the chain through the public operations facade; the walkthrough proves the same chain through the **CLI**, which is the surface an operator actually touches. Both are required — an operations-only proof would miss CLI argument wiring entirely.

- [ ] **Step 2: Run it end to end**

```bash
cd packages/benchmark-product/core && yarn build && node scripts/p5-walkthrough.mjs
```
Expected: every verb exits 0; the script prints benchmark, run, matrix, report, and report-envelope digests.

- [ ] **Step 3: Write the evidence doc**

Create `docs/superpowers/plans/demo-report-1/P5-evidence.md` following the M1 evidence pattern — record, at minimum:

- the fixture's three instance ids, repos, and resolved image digests (from `provenance.json`);
- sealed digests: benchmark, run, matrix, report, report envelope;
- the green-baseline result per row (gold PASS / empty FAIL);
- **measured wall-clock**: per-cell mean, total run, and image-setup time — the number E2's power analysis is blocked on;
- a determinism cross-check (re-run `verify`, confirm identical digests);
- an **honest limits** section. It must state at least: this is a 3-task micro-slate and proves plumbing, not capability; the run is below the paired method's minimum task count so no interval is published; the parser digest is a placeholder pending P3c; the slate was minted from a pre-cutoff split and is disposable — **not** reusable for the official run if it was minted before the cluster-key fix; Docker grading is proven locally only, never in CI.

Follow M1's precedent and do **not** commit the raw transcript — it is reproducible via the walkthrough script; only the digests are durable.

- [ ] **Step 4: Commit**

```bash
git add packages/benchmark-product/core/scripts/p5-walkthrough.mjs \
        docs/superpowers/plans/demo-report-1/P5-evidence.md
git commit -m "test(benchmark-product): add the P5 CLI walkthrough and recorded evidence"
```

---

## Acceptance checklist

- [ ] 3-task × 2-arm × 2-replicate micro-benchmark runs `draft → import → arms → quote → lock → launch → collect → report → verify` with **zero manual intervention**.
- [ ] Micro-slate spans **3 distinct source repos**.
- [ ] Every expected cell accounted: `expected = judged = 12`, `runOutcome = "complete"`.
- [ ] Per-axis `match` on harness / model / loadout via **real** admission evidence (P2b's fix — never fabricated).
- [ ] `verifyMatrix` + `verifyReport` green, via `runVerify`'s three checks.
- [ ] Clustered-bootstrap accounting asserted: `draws === resamples × clusterCount`, `unit === "source-cluster"`, cluster manifest membership.
- [ ] No-interval outcome asserted behaviorally, with its stated reason.
- [ ] Green baseline passes for every row — grader PASS on gold, FAIL on empty.
- [ ] Walkthrough script green against the built CLI.
- [ ] Evidence doc committed with measured wall-clock and honest limits.
- [ ] Prediction-path suite green **unmodified**; benchmark-product CI requires no Docker.
- [ ] PR body records the local full-chain verification (CI blindness rule).

## Self-review notes

- **Spec coverage.** Every clause of the program's P5 acceptance maps to a task: the chain (2, 3), container grading (3), cell accounting (3), `match` on axes (checklist, delivered by P2b), verify green (4), runbook + evidence (5). R5's slate and exclusion rules land in Task 1.
- **Known non-placeholders.** Three substitution points are marked and justified rather than hidden: P1's arm-pin constant, P3's grading seam, C3's statistics field names. Each is a genuine cross-packet interface that does not exist at this head; inventing names for them would be worse than naming them as seams. The parser digest is a real placeholder and is called out as such, with an assertion-level guard that Task 4 must not depend on its value.
- **Type consistency.** `setUpLockedDraft` is defined once in Task 2 and reused verbatim in Tasks 3 and 4; `contextFor`, `clock`, `workspaceDir`, `MICRO_SLATE`, and `REPLICATES` are module-level and shared. Arm ids are `arm-a` / `arm-b` throughout. Cell arithmetic is 3 × 2 × 2 = 12 in every place it appears.
