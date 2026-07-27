# Intermediate failure diffs (harness-emitted) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist §10 field 4 `intermediateFailureDiffs` from harness-emitted evidence on `Solution` at the single production-reachable `RUNNING → POST_SNAPSHOT` write, replacing dead Approach A overwrite archaeology.

**Architecture:** Coding/restoration harnesses (or a test stub) optionally set `Solution.intermediateFailureDiffs: string[]` during one `run()` when in-session verifier/test failures leave a non-empty working-tree diff (same semantics as `apps/jinn-agent/plugins/jinn/__init__.py` `_on_post_tool_call`). `TaskEngine.runImpl` normalizes that list (non-empty only, dedupe) and writes it into `task_runs.intermediate_failure_diffs_json` in the same POST_SNAPSHOT transition that already persists `solution_outputs_json`. Assemblers keep reading via `intermediateFailureDiffsFromTaskRun`. C7 stays closed: do **not** open `pack()` / Episode contribution from `requestId` alone.

**Tech Stack:** TypeScript, Vitest, better-sqlite3 (`TaskRunPersistence`), `TaskEngine` harness freeze-fence.

**Design note:** [`docs/superpowers/specs/2026-07-25-intermediate-failure-diffs-harness-emitted-design.md`](../specs/2026-07-25-intermediate-failure-diffs-harness-emitted-design.md)  
**Issue:** [#1643](https://github.com/Jinn-Network/mono/issues/1643) · supersedes closed PR [#1951](https://github.com/Jinn-Network/mono/pull/1951)

## Global Constraints

- **Order of work (mandatory):** delete Approach A → extend `Solution` → persist at POST_SNAPSHOT → wire one harness/stub emitter → keep reader helper.
- **C7 closed:** Do **not** change `pack()` to invent mineable/contribution refs from `requestId`. Do **not** open Episode contribution wiring in this plan. Existing `client/test/harnesses/engine/mineable-producer.test.ts` must stay green untouched except if a typebreak forces a trivial `Solution` literal update.
- **No SQL seeding of prior `solution_outputs_json` on RUNNING** to prove retention. Tests must drive a harness stub that returns `intermediateFailureDiffs`.
- **Keep:** additive column `intermediate_failure_diffs_json`, `PersistedTaskRun.intermediateFailureDiffsJson`, `intermediateFailureDiffsFromTaskRun`, `buildMineableRecord` consumer wiring.
- **Delete:** `recordPriorPatchOnOverwrite`, `extractSolutionPatch` (if only used by it), both `engine.ts` call sites, Approach A tests/comments framing overwrite-as-§10-seam.
- **Production harnesses:** stub emitter is enough for this issue. Real coding harnesses may omit the field (honest `[]` / undefined). Do not fabricate negatives from crash recovery.
- **American English** in identifiers/comments (`distill`, not `distil`).
- Work exclusively in this attempt worktree.

## Acceptance criteria → tasks map

| AC (design note) | Covered by |
|---|---|
| **AC1** Production path without SQL seeding — harness emits failed diffs → non-empty column after normal POST_SNAPSHOT | Task 1 (failing tests), Task 4 (persist), Task 5 (stub emitter) |
| **AC2** First-success / no-boundary stays empty; reader returns `[]` for null/malformed | Task 1, Task 4, Task 6 |
| **AC3** Dedupe + non-empty only | Task 1, Task 3 (`normalizeIntermediateFailureDiffs`), Task 4 |
| **AC4** Assembler feed unchanged (`intermediateFailureDiffsFromTaskRun`) | Task 6 |
| **AC5** C7 unchanged — `pack()` does not invent contribution refs | Task 7 (verify only; no pack/Episode work) |
| **AC6** Approach A removed | Task 2 |

## File map

| File | Responsibility |
|---|---|
| `client/test/harnesses/engine/intermediate-failure-diffs.test.ts` | Rewrite: harness-stub-driven runImpl tests; drop SQL-seeded overwrite cases |
| `client/src/harnesses/types.ts` | Optional `Solution.intermediateFailureDiffs?: string[]` |
| `client/src/harnesses/engine/persistence.ts` | Delete Approach A helpers; add `TaskRunPatch.intermediateFailureDiffsJson`; write column in `transition()`; fix column comment |
| `client/src/harnesses/engine/engine.ts` | Delete overwrite calls; persist normalized harness list on both POST_SNAPSHOT paths |
| `client/src/solver-types/_swe-rebench-v2-mineable-store.ts` | Keep `intermediateFailureDiffsFromTaskRun`; refresh JSDoc to harness-emitted semantics |
| `client/src/types/task-run.ts` | Refresh `intermediateFailureDiffsJson` JSDoc (harness evidence, not overwrite) |
| `client/test/harnesses/engine/mineable-producer.test.ts` | **Do not change behavior** (C7). Touch only if `Solution` literals need the new optional field (they do not — optional). |

**Out of scope / do not touch:** `pack()` Episode/contribution paths, jinn-agent plugin (already ships the reference pattern), production coding harness bodies beyond leaving the field undefined.

---

### Task 1: Rewrite failing tests for harness-emitted path (AC1–AC4)

**Files:**
- Modify: `client/test/harnesses/engine/intermediate-failure-diffs.test.ts`
- (No production code yet — expect RED)

**Interfaces:**
- Consumes: existing `TaskEngine`, `TaskRunPersistence`, `Harness`, `Solution`, `intermediateFailureDiffsFromTaskRun`, `buildMineableRecord`
- Produces: RED suite that encodes redesign ACs; later tasks turn it green

- [ ] **Step 1: Replace the Approach A test file with harness-stub-driven cases**

Overwrite `client/test/harnesses/engine/intermediate-failure-diffs.test.ts` with the following (keep the IPFS/contracts mocks and engine helper scaffolding; delete every `recordPriorPatchOnOverwrite` / raw-SQL prior-solution seed):

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import {
  TaskRunPersistence,
  type PersistedTaskRunInput,
} from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { TaskEngine, type TaskEngineOptions } from '../../../src/harnesses/engine/engine.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import {
  buildMineableRecord,
  intermediateFailureDiffsFromTaskRun,
} from '../../../src/solver-types/_swe-rebench-v2-mineable-store.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(`0x${'0'.repeat(64)}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi.fn().mockResolvedValue('0xdeliverytx'),
  claimDelivery: vi.fn().mockResolvedValue('0xclaimtx'),
  submitTask: vi.fn(), submitEvaluationJob: vi.fn(), claimJob: vi.fn(),
  getJobClaim: vi.fn(), getMechDeliveryRate: vi.fn(), getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(), decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(), scanTasks: vi.fn(), scanEvaluationJobs: vi.fn(),
}));

const PRIVATE_KEY = `0x${'1'.repeat(64)}` as `0x${string}`;
const SOLVER_TYPE = 'swe-rebench-v2.v1';

function patchSolution(
  patch: string,
  intermediateFailureDiffs?: string[],
): Solution {
  return {
    venueRef: { name: 'swe-rebench-v2' },
    gating: { ok: true },
    solutionPayload: { schemaVersion: 'swe-rebench-v2-solution.v1', patch },
    artifacts: [],
    ...(intermediateFailureDiffs !== undefined
      ? { intermediateFailureDiffs }
      : {}),
  };
}

/** Stub that simulates in-session failed attempt boundaries then a final patch. */
function makeEmittingImpl(opts: {
  patch: string;
  intermediateFailureDiffs?: string[];
}): Harness {
  return {
    name: 'ifd-emit-stub',
    version: '0.0.1',
    supports: (s) => s.solverType === SOLVER_TYPE && s.role !== 'evaluation',
    async run(): Promise<Solution> {
      return patchSolution(opts.patch, opts.intermediateFailureDiffs);
    },
  };
}

function engineOpts(store: Store, tmp: string, impl: Harness): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(tmp, 'work'), implStateDirRoot: join(tmp, 'impl') },
    implRegistry: { findFor: (s) => (impl.supports(s) ? impl : undefined) },
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: PRIVATE_KEY,
      safeAddress: `0x${'2'.repeat(40)}`,
    },
  };
}

function makeInput(overrides: Partial<PersistedTaskRunInput> = {}): PersistedTaskRunInput {
  return {
    requestId: 'req-ifd-1',
    taskCid: 'bafy-task',
    onchainCreationTx: '0xtx',
    onchainCreationBlock: 1,
    solverType: 'swe-rebench-v2.v1',
    windowStartTs: Date.now() - 1_000,
    windowEndTs: Date.now() + 60_000,
    task: {
      id: 'req-ifd-1',
      description: 'fix',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      spec: { repo: 'org/widget', base_commit: 'a'.repeat(40), instance_id: 'i-1' },
    },
    ...overrides,
  };
}

async function driveToPostSnapshot(
  store: Store,
  tmp: string,
  requestId: string,
  impl: Harness,
): Promise<ReturnType<TaskRunPersistence['getByRequestId']>> {
  const engine = new TaskEngine(engineOpts(store, tmp, impl));
  const p = new TaskRunPersistence(store.db);
  await engine.observe(makeInput({
    requestId,
    task: {
      id: requestId,
      description: 'fix',
      solverType: SOLVER_TYPE,
      role: 'restoration',
      spec: {},
    },
  }));
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  await engine.process(requestId);
  return p.getByRequestId(requestId);
}

describe('intermediateFailureDiffs column (#1643 redesign)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('adds intermediate_failure_diffs_json via additive migration', () => {
    const columns = (store.db.pragma('table_info(task_runs)') as Array<{ name: string }>)
      .map((r) => r.name);
    expect(columns).toContain('intermediate_failure_diffs_json');
  });
});

describe('runImpl persists harness-emitted intermediateFailureDiffs (#1643)', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = join(tmpdir(), `ifd-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('AC2: first success with no failed-boundary evidence leaves column null', async () => {
    const row = await driveToPostSnapshot(
      store,
      tmp,
      'req-first',
      makeEmittingImpl({ patch: 'diff --git a/x b/x\n+ok\n' }),
    );
    expect(row!.state).toBe(TaskRunState.POST_SNAPSHOT);
    expect(row!.intermediateFailureDiffsJson).toBeNull();
  });

  it('AC1: harness-emitted failed diffs persist after normal RUNNING → POST_SNAPSHOT (no SQL seed)', async () => {
    const failedA = 'diff --git a/x b/x\n+A\n';
    const row = await driveToPostSnapshot(
      store,
      tmp,
      'req-emit',
      makeEmittingImpl({
        patch: 'diff --git a/x b/x\n+B\n',
        intermediateFailureDiffs: [failedA],
      }),
    );
    expect(row!.state).toBe(TaskRunState.POST_SNAPSHOT);
    expect(JSON.parse(row!.intermediateFailureDiffsJson!)).toEqual([failedA]);
    expect(JSON.parse(row!.solutionOutputsJson!).solutionPayload.patch).toBe(
      'diff --git a/x b/x\n+B\n',
    );
  });

  it('AC3: empty strings dropped; identical diffs deduped at persist', async () => {
    const failed = 'diff --git a/x b/x\n+A\n';
    const row = await driveToPostSnapshot(
      store,
      tmp,
      'req-dedupe',
      makeEmittingImpl({
        patch: 'diff --git a/x b/x\n+ok\n',
        intermediateFailureDiffs: ['', failed, failed, ''],
      }),
    );
    expect(JSON.parse(row!.intermediateFailureDiffsJson!)).toEqual([failed]);
  });

  it('AC2: empty array from harness leaves column null', async () => {
    const row = await driveToPostSnapshot(
      store,
      tmp,
      'req-empty-arr',
      makeEmittingImpl({
        patch: 'diff --git a/x b/x\n+ok\n',
        intermediateFailureDiffs: [],
      }),
    );
    expect(row!.intermediateFailureDiffsJson).toBeNull();
  });
});

describe('intermediateFailureDiffsFromTaskRun (#1643 AC4)', () => {
  it('returns [] for null / malformed / missing', () => {
    expect(intermediateFailureDiffsFromTaskRun({ intermediateFailureDiffsJson: null })).toEqual([]);
    expect(intermediateFailureDiffsFromTaskRun({ intermediateFailureDiffsJson: '{' })).toEqual([]);
    expect(intermediateFailureDiffsFromTaskRun({ intermediateFailureDiffsJson: '"nope"' })).toEqual([]);
  });

  it('parses the retained list for buildMineableRecord', () => {
    const diffs = intermediateFailureDiffsFromTaskRun({
      intermediateFailureDiffsJson: JSON.stringify(['diff --git a/x b/x\n+A\n']),
    });
    const record = buildMineableRecord({
      sourceId: 'ep-1',
      kind: 'solvernet-execution',
      repo: 'org/widget',
      baseCommit: 'a'.repeat(40),
      acceptedDiff: 'diff --git a/x b/x\n+B\n',
      intermediateFailureDiffs: diffs,
      publishMinedTasksConsent: false,
      now: () => '2026-07-22T00:00:00.000Z',
    });
    expect(record.intermediateFailureDiffs).toEqual(['diff --git a/x b/x\n+A\n']);
  });
});
```

- [ ] **Step 2: Run tests — expect RED**

```bash
cd client && yarn vitest run test/harnesses/engine/intermediate-failure-diffs.test.ts
```

Expected: FAIL — `Solution` has no `intermediateFailureDiffs` and/or engine does not write the column from the stub (Approach A helpers may still exist but are unused by the new tests). Type errors on the optional field count as RED.

- [ ] **Step 3: Commit the RED test rewrite**

```bash
git add client/test/harnesses/engine/intermediate-failure-diffs.test.ts
git commit -m "$(cat <<'EOF'
test(#1643): rewrite IFD suite for harness-emitted evidence

Drop SQL-seeded RUNNING overwrite cases; drive a stub that emits
intermediateFailureDiffs through runImpl → POST_SNAPSHOT.
EOF
)"
```

---

### Task 2: Delete Approach A (AC6)

**Files:**
- Modify: `client/src/harnesses/engine/persistence.ts` (delete `extractSolutionPatch`, `recordPriorPatchOnOverwrite`; rewrite column comment)
- Modify: `client/src/harnesses/engine/engine.ts` (remove both `recordPriorPatchOnOverwrite` call sites ~1559 and ~1615)
- Modify: `client/src/types/task-run.ts` (JSDoc on `intermediateFailureDiffsJson` — harness evidence, not overwrite)

**Interfaces:**
- Consumes: none from Task 1 beyond RED tests
- Produces: no `recordPriorPatchOnOverwrite` / `extractSolutionPatch` symbols remaining in `client/`

- [ ] **Step 1: Remove Approach A from persistence**

In `client/src/harnesses/engine/persistence.ts`:

1. Replace the column DDL comment (~105–108) with:

```sql
  -- Additive column (#1643, intermediateFailureDiffs / spec §10 field 4):
  -- intermediate_failure_diffs_json: JSON string[] of harness-emitted
  --   failed working-tree diffs from in-session attempt boundaries,
  --   written once at RUNNING → POST_SNAPSHOT. NULL when empty / absent.
```

2. Delete the entire `extractSolutionPatch` function (~344–355).
3. Delete the entire `recordPriorPatchOnOverwrite` method (~764–796), including its Approach A JSDoc.

- [ ] **Step 2: Remove engine call sites**

In `client/src/harnesses/engine/engine.ts`:

1. Skipped path (~1558–1559): delete the `recordPriorPatchOnOverwrite` line and the “Retain prior failed patch…” comment if present.
2. Success path (~1612–1615): delete the overwrite call and its comment. Leave `nextSolutionOutputsJson` / `transition(... solutionOutputsJson ...)` intact for now (Task 4 adds the new patch field).

- [ ] **Step 3: Update PersistedTaskRun JSDoc**

In `client/src/types/task-run.ts` replace the `intermediateFailureDiffsJson` comment (~77–80) with:

```typescript
  /**
   * JSON array of harness-emitted failed unified diffs from in-session
   * attempt boundaries (#1643 / spec §10 field 4). Written once at
   * RUNNING → POST_SNAPSHOT from `Solution.intermediateFailureDiffs`.
   * Null when none (first success / no boundaries, or pre-migration rows).
   */
  intermediateFailureDiffsJson: string | null;
```

- [ ] **Step 4: Confirm Approach A is gone**

```bash
rg -n 'recordPriorPatchOnOverwrite|extractSolutionPatch' client/
```

Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/engine/persistence.ts \
  client/src/harnesses/engine/engine.ts \
  client/src/types/task-run.ts
git commit -m "$(cat <<'EOF'
refactor(#1643): remove Approach A overwrite retention

Delete recordPriorPatchOnOverwrite and engine call sites; column
remains for harness-emitted evidence at POST_SNAPSHOT.
EOF
)"
```

---

### Task 3: Extend `Solution` + normalize helper (AC3 type surface)

**Files:**
- Modify: `client/src/harnesses/types.ts` (`Solution`)
- Modify: `client/src/harnesses/engine/persistence.ts` (export `normalizeIntermediateFailureDiffs`)

**Interfaces:**
- Consumes: none
- Produces:
  - `Solution.intermediateFailureDiffs?: string[]`
  - `export function normalizeIntermediateFailureDiffs(raw: unknown): string[]`

- [ ] **Step 1: Add optional field on Solution**

In `client/src/harnesses/types.ts`, after `rationale?: RationaleEntry[];` inside `Solution` (~117), add:

```typescript
  /**
   * Failed working-tree diffs captured at in-session verifier/test
   * attempt boundaries during this run (#1643 / spec §10 field 4).
   * Harnesses that cannot observe boundaries omit this (engine treats
   * as []). Reference: apps/jinn-agent/plugins/jinn `_on_post_tool_call`.
   * Empty strings must not appear; engine dedupes on persist.
   */
  intermediateFailureDiffs?: string[];
```

Do **not** require SDK `packages/sdk/src/types.ts` parity in this issue (client engine types are the seam). Leave production harness return sites unchanged (field stays undefined → honest empty).

- [ ] **Step 2: Add normalize helper in persistence**

In `client/src/harnesses/engine/persistence.ts`, near other helpers (where `extractSolutionPatch` was), add:

```typescript
/**
 * Sanitize harness-emitted failed diffs for §10 field 4 (#1643).
 * Keeps non-empty strings only; first-seen order; drops duplicates.
 */
export function normalizeIntermediateFailureDiffs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}
```

- [ ] **Step 3: Optional tiny unit assertion via vitest in the same suite later** — covered by Task 1 AC3 case once Task 4 wires persist. No separate file.

- [ ] **Step 4: Commit**

```bash
git add client/src/harnesses/types.ts client/src/harnesses/engine/persistence.ts
git commit -m "$(cat <<'EOF'
feat(#1643): add Solution.intermediateFailureDiffs + normalize helper

Optional harness-emitted failed-diff list; engine will persist at
POST_SNAPSHOT after sanitize/dedupe.
EOF
)"
```

---

### Task 4: Persist at `RUNNING → POST_SNAPSHOT` (AC1–AC3)

**Files:**
- Modify: `client/src/harnesses/engine/persistence.ts` (`TaskRunPatch` + `transition` UPDATE)
- Modify: `client/src/harnesses/engine/engine.ts` (both POST_SNAPSHOT transitions)

**Interfaces:**
- Consumes: `Solution.intermediateFailureDiffs?`, `normalizeIntermediateFailureDiffs`
- Produces: `TaskRunPatch.intermediateFailureDiffsJson: string | null`; column written in the same transition as `solutionOutputsJson`

- [ ] **Step 1: Extend TaskRunPatch + transition writer**

In `TaskRunPatch` (`persistence.ts` ~178–210), add after `solutionOutputsJson`:

```typescript
  /**
   * JSON string[] of harness-emitted intermediate failure diffs (#1643).
   * Null clears / leaves empty (prefer null when no evidence).
   */
  intermediateFailureDiffsJson: string | null;
```

In `transition()` after the `solutionOutputsJson` block (~535–538), add:

```typescript
    if (patch.intermediateFailureDiffsJson !== undefined) {
      setClauses.push('intermediate_failure_diffs_json = @intermediateFailureDiffsJson');
      params['intermediateFailureDiffsJson'] = patch.intermediateFailureDiffsJson;
    }
```

- [ ] **Step 2: Wire engine success path**

In `engine.ts` success POST_SNAPSHOT (~1598–1626), replace the Approach A comment/call area with:

```typescript
      const output = fence.output;
      this.solutionOutputs.set(task.requestId, output);
      // ... trajectory collector unchanged ...

      const nextSolutionOutputsJson = JSON.stringify(output);
      const intermediateFailureDiffs = normalizeIntermediateFailureDiffs(
        output.intermediateFailureDiffs,
      );
      this.persistence.transition(task.requestId, TaskRunState.POST_SNAPSHOT, {
        postSnapshotCapturedAt: Date.now(),
        postSnapshotPayload: output.postSnapshot ?? { capturedAt: Date.now(), hlTime: 0, payload: null },
        fillsPayload: output.fills ?? [],
        gatingClaim: output.gating,
        informationalClaim: output.informational ?? null,
        solutionOutputsJson: nextSolutionOutputsJson,
        intermediateFailureDiffsJson:
          intermediateFailureDiffs.length > 0
            ? JSON.stringify(intermediateFailureDiffs)
            : null,
        implName: impl.name,
        runtimePluginsJson: JSON.stringify(attributedPlugins),
        consumedRefsJson,
      });
```

Import `normalizeIntermediateFailureDiffs` from `./persistence.js` at the top of `engine.ts` (alongside existing persistence imports).

- [ ] **Step 3: Wire skipped path**

On the `SkippableError` POST_SNAPSHOT path, pass the same field from the synthetic skipped `Solution` (usually undefined → null):

```typescript
          const intermediateFailureDiffs = normalizeIntermediateFailureDiffs(
            skippedOutput.intermediateFailureDiffs,
          );
          const nextSolutionOutputsJson = JSON.stringify(skippedOutput);
          this.persistence.transition(task.requestId, TaskRunState.POST_SNAPSHOT, {
            // ... existing fields ...
            solutionOutputsJson: nextSolutionOutputsJson,
            intermediateFailureDiffsJson:
              intermediateFailureDiffs.length > 0
                ? JSON.stringify(intermediateFailureDiffs)
                : null,
            // ...
          });
```

- [ ] **Step 4: Run targeted tests — expect GREEN for engine cases**

```bash
cd client && yarn vitest run test/harnesses/engine/intermediate-failure-diffs.test.ts
```

Expected: PASS (AC1–AC4 cases).

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/engine/persistence.ts client/src/harnesses/engine/engine.ts
git commit -m "$(cat <<'EOF'
feat(#1643): persist harness intermediateFailureDiffs at POST_SNAPSHOT

Copy normalized Solution.intermediateFailureDiffs into the additive
column in the same transition as solution_outputs_json.
EOF
)"
```

---

### Task 5: Confirm stub emitter is the minimal wire (AC1)

**Files:**
- Verify only: `client/test/harnesses/engine/intermediate-failure-diffs.test.ts` (`makeEmittingImpl` from Task 1)
- No production harness edits required

**Interfaces:**
- Consumes: `Solution.intermediateFailureDiffs` from Task 3
- Produces: documented that production coding harnesses honestly omit/`[]` until they can observe attempt boundaries

- [ ] **Step 1: Assert stub is sufficient**

Confirm Task 1’s `makeEmittingImpl` is the only emitter required for AC1. Do **not** implement live Claude/Codex/Hermes attempt-boundary capture in this issue — that is a follow-up when a harness can see verifier failures (mirror jinn-agent `_on_post_tool_call`).

Optional one-line note in `client/src/harnesses/types.ts` is already the contract; skip drive-by comments elsewhere.

- [ ] **Step 2: No commit if nothing changed** — if Task 1 already committed the stub, skip. Otherwise fold any stub fix into a docs-only commit:

```bash
# only if you had to tweak the stub after Task 4
git add client/test/harnesses/engine/intermediate-failure-diffs.test.ts
git commit -m "$(cat <<'EOF'
test(#1643): tighten IFD stub emitter for POST_SNAPSHOT path
EOF
)"
```

---

### Task 6: Keep reader helper + refresh JSDoc (AC4)

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-mineable-store.ts` (`intermediateFailureDiffsFromTaskRun` JSDoc only — behavior unchanged)

**Interfaces:**
- Consumes: column JSON written by Task 4
- Produces: unchanged `intermediateFailureDiffsFromTaskRun(run): string[]` signature and filter semantics

- [ ] **Step 1: Refresh JSDoc only**

Replace the helper’s comment (~121–124) with:

```typescript
/**
 * Safe read of harness-emitted failed diffs for §10 field 4 assemblers (#1643).
 * Source column is written at RUNNING → POST_SNAPSHOT from
 * Solution.intermediateFailureDiffs — not from solution overwrite archaeology.
 * Returns [] for null, empty, malformed, or non-array JSON.
 */
```

Do **not** change the function body.

- [ ] **Step 2: Re-run reader tests**

```bash
cd client && yarn vitest run test/harnesses/engine/intermediate-failure-diffs.test.ts
```

Expected: PASS, including `intermediateFailureDiffsFromTaskRun (#1643 AC4)`.

- [ ] **Step 3: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-mineable-store.ts
git commit -m "$(cat <<'EOF'
docs(#1643): point IFD reader at harness-emitted POST_SNAPSHOT seam
EOF
)"
```

---

### Task 7: Verification + C7 guardrail (AC5)

**Files:**
- Read-only: `client/test/harnesses/engine/mineable-producer.test.ts`
- No `pack()` / Episode contribution edits

**Do NOT:**
- Open `pack()` to append mineable/contribution refs from `requestId`
- Wire Episode contribution candidates from engine IFD in this plan
- Reintroduce overwrite helpers

- [ ] **Step 1: Run C7 regression**

```bash
cd client && yarn vitest run test/harnesses/engine/mineable-producer.test.ts
```

Expected: PASS — `ignores a legacy mineableStore option instead of enqueueing a requestId-only record`.

- [ ] **Step 2: Full IFD suite + typecheck**

```bash
cd client && yarn vitest run test/harnesses/engine/intermediate-failure-diffs.test.ts
cd client && yarn typecheck
```

Expected: all IFD tests PASS; `yarn typecheck` exits 0.

- [ ] **Step 3: Grep gate for Approach A + C7 scope**

```bash
rg -n 'recordPriorPatchOnOverwrite|extractSolutionPatch|archive prior patch|solution overwrite' client/
rg -n 'intermediateFailureDiffs' client/src/harnesses/engine/engine.ts
```

Expected: no Approach A symbols; `engine.ts` only references IFD via normalize + POST_SNAPSHOT patch (not pack).

- [ ] **Step 4: Final commit only if typecheck/docs needed** — otherwise stop. If typecheck forced a trivial fix:

```bash
git add -u client/
git commit -m "$(cat <<'EOF'
chore(#1643): typecheck clean after harness-emitted IFD wire
EOF
)"
```

---

## Self-review checklist (plan author)

1. **Spec coverage:** AC1→Tasks 1/4/5 · AC2→Tasks 1/4 · AC3→Tasks 1/3/4 · AC4→Task 6 · AC5→Task 7 · AC6→Task 2. C7 explicitly closed.
2. **No placeholders:** concrete file paths, code blocks, and commands included.
3. **Type consistency:** `Solution.intermediateFailureDiffs?: string[]` → `normalizeIntermediateFailureDiffs` → `TaskRunPatch.intermediateFailureDiffsJson` → column → `intermediateFailureDiffsFromTaskRun`.
4. **Order honored:** delete Approach A (Task 2) before persist wire (Task 4); tests first (Task 1).

## Execution handoff

Plan complete. Implement with `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`, task-by-task, keeping C7 closed.
