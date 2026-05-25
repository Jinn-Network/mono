# SWE-rebench v2 Generator Pool Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the swe-rebench-v2 task generator survive HuggingFace outages by caching the task pool to disk and falling back to it — so task generation never silently stops when HF is unreachable.

**Architecture:** The generator currently loads its pool only from the HF datasets-server into memory (`loadSweRebenchV2Pool`); on failure `refreshPool` keeps the in-memory pool, which is empty on a cold start, so `tick()` posts nothing — silently. This plan adds a disk cache (`pool-cache.json`, alongside the existing `generator-state.json`/`validated-pool.json` in the generator state dir): every successful HF load is persisted; when an HF load fails and there is no usable in-memory pool, the cache is read back. The HF-fetch / cache-fallback decision is extracted into a pure function so it is exhaustively unit-testable; the generator's `refreshPool` closure becomes a thin call into it.

**Tech Stack:** TypeScript (Node 22, ESM), Vitest. No new dependencies.

**Issue:** [#466](https://github.com/Jinn-Network/mono/issues/466). Companion (separate plans): #471 (surface generator health in the operator app), #467 (HF throttle/backoff — also reduces how often this fallback is hit).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `client/src/solver-types/_swe-rebench-v2-pool-cache.ts` | Disk persistence of the pool (`PoolCacheStore`) + the pure HF-load-with-fallback orchestrator (`loadPoolWithCacheFallback`). | **Create** |
| `client/test/solver-types/_swe-rebench-v2-pool-cache.test.ts` | Unit tests for both exports above. | **Create** |
| `client/src/solver-types/swe-rebench-v2.ts` | Generator. `refreshPool` rewired to call `loadPoolWithCacheFallback`; `tick` refresh-gate updated so a cache-served pool keeps retrying HF. | **Modify** (`refreshPool` ~L295-310; declarations ~L285-293; tick gate ~L320-323) |

`_swe-rebench-v2-pool-cache.ts` lives next to the other `_swe-rebench-v2-*` support modules and mirrors the existing `GeneratorStateStore` persistence pattern in `_swe-rebench-v2-state.ts` (schema-versioned JSON file in the state dir, defensive read).

---

## Task 1: `PoolCacheStore` — disk persistence for the pool

**Files:**
- Create: `client/src/solver-types/_swe-rebench-v2-pool-cache.ts`
- Test: `client/test/solver-types/_swe-rebench-v2-pool-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/solver-types/_swe-rebench-v2-pool-cache.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PoolCacheStore } from '../../src/solver-types/_swe-rebench-v2-pool-cache.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

const sampleTasks: PoolTask[] = [
  { instance_id: 'octocat__hello-1', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2025_01', language: 'Python' },
  { instance_id: 'octocat__hello-2', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2025_02', language: 'TypeScript' },
];

describe('PoolCacheStore', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'swe-pool-cache-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('round-trips tasks through write() then read()', async () => {
    const store = new PoolCacheStore({ stateDir });
    await store.write(sampleTasks);

    const cached = await store.read();
    expect(cached).not.toBeNull();
    expect(cached!.tasks).toEqual(sampleTasks);
    expect(typeof cached!.savedAt).toBe('string');
    expect(Number.isNaN(Date.parse(cached!.savedAt))).toBe(false);
  });

  it('write() creates the state dir if it does not exist', async () => {
    const nested = join(stateDir, 'does', 'not', 'exist');
    const store = new PoolCacheStore({ stateDir: nested });
    await store.write(sampleTasks);
    expect((await store.read())!.tasks).toEqual(sampleTasks);
  });

  it('read() returns null when no cache file exists', async () => {
    const store = new PoolCacheStore({ stateDir });
    expect(await store.read()).toBeNull();
  });

  it('read() returns null on corrupt JSON', async () => {
    await writeFile(join(stateDir, 'pool-cache.json'), '{ "schemaVersion": ', 'utf8');
    const store = new PoolCacheStore({ stateDir });
    expect(await store.read()).toBeNull();
  });

  it('read() returns null on an unrecognised schemaVersion', async () => {
    await writeFile(
      join(stateDir, 'pool-cache.json'),
      JSON.stringify({ schemaVersion: 'swe-rebench-v2-pool-cache.v999', savedAt: new Date().toISOString(), tasks: [] }),
      'utf8',
    );
    const store = new PoolCacheStore({ stateDir });
    expect(await store.read()).toBeNull();
  });

  it('round-trips an empty task list', async () => {
    const store = new PoolCacheStore({ stateDir });
    await store.write([]);
    expect((await store.read())!.tasks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/_swe-rebench-v2-pool-cache.test.ts`
Expected: FAIL — `Cannot find module '../../src/solver-types/_swe-rebench-v2-pool-cache.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `client/src/solver-types/_swe-rebench-v2-pool-cache.ts`:

```ts
/**
 * Disk cache for the swe-rebench-v2 task pool. The pool is sourced from the
 * HuggingFace datasets-server; this cache lets the generator keep posting
 * tasks across HF outages instead of silently going idle (#466).
 *
 * Stored at `<stateDir>/pool-cache.json`, alongside `generator-state.json`
 * and `validated-pool.json`. Mirrors the GeneratorStateStore persistence
 * pattern in `_swe-rebench-v2-state.ts`.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolTask } from './_swe-rebench-v2-pool.js';

const SCHEMA_VERSION = 'swe-rebench-v2-pool-cache.v1' as const;

interface PoolCacheFile {
  schemaVersion: typeof SCHEMA_VERSION;
  savedAt: string;
  tasks: PoolTask[];
}

/** A pool read back from disk. */
export interface CachedPool {
  tasks: PoolTask[];
  /** ISO timestamp the cache was written. */
  savedAt: string;
}

export class PoolCacheStore {
  private cacheFile: string;

  constructor(opts: { stateDir: string }) {
    this.cacheFile = join(opts.stateDir, 'pool-cache.json');
  }

  /** Persist the pool. Creates the state dir if missing. */
  async write(tasks: PoolTask[]): Promise<void> {
    const payload: PoolCacheFile = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      tasks,
    };
    await mkdir(join(this.cacheFile, '..'), { recursive: true });
    await writeFile(this.cacheFile, JSON.stringify(payload));
  }

  /**
   * Read the cached pool. Returns null when the file is absent, unparseable,
   * or carries an unrecognised schema — never throws, so a corrupt cache
   * degrades to "no cache" rather than crashing the generator.
   */
  async read(): Promise<CachedPool | null> {
    let raw: string;
    try {
      raw = await readFile(this.cacheFile, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PoolCacheFile>;
      if (
        parsed.schemaVersion !== SCHEMA_VERSION ||
        typeof parsed.savedAt !== 'string' ||
        !Array.isArray(parsed.tasks)
      ) {
        return null;
      }
      return { tasks: parsed.tasks, savedAt: parsed.savedAt };
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/_swe-rebench-v2-pool-cache.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-pool-cache.ts client/test/solver-types/_swe-rebench-v2-pool-cache.test.ts
git commit -m "feat(client): add PoolCacheStore — disk cache for the swe-rebench-v2 pool (#466)"
```

---

## Task 2: `loadPoolWithCacheFallback` — pure HF-load-then-fallback orchestrator

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-pool-cache.ts` (add one export)
- Test: `client/test/solver-types/_swe-rebench-v2-pool-cache.test.ts` (add one describe block)

This is the decision logic the generator's `refreshPool` will delegate to. Keeping it a pure function (loader + cache injected) makes every branch unit-testable without constructing the whole generator.

- [ ] **Step 1: Write the failing test**

Append to `client/test/solver-types/_swe-rebench-v2-pool-cache.test.ts`:

```ts
import { loadPoolWithCacheFallback } from '../../src/solver-types/_swe-rebench-v2-pool-cache.js';

describe('loadPoolWithCacheFallback', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'swe-pool-fallback-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('returns the freshly loaded pool and writes it to the cache on success', async () => {
    const cache = new PoolCacheStore({ stateDir });
    const result = await loadPoolWithCacheFallback({
      loadPool: async () => sampleTasks,
      cache,
      currentPool: [],
    });

    expect(result.pool).toEqual(sampleTasks);
    expect(result.fromCache).toBe(false);
    expect(result.error).toBeUndefined();
    // The successful load was persisted for future fallbacks.
    expect((await cache.read())!.tasks).toEqual(sampleTasks);
  });

  it('keeps the existing in-memory pool when the load fails and a pool is already held', async () => {
    const cache = new PoolCacheStore({ stateDir });
    const result = await loadPoolWithCacheFallback({
      loadPool: async () => { throw new Error('HF datasets-server returned 429'); },
      cache,
      currentPool: sampleTasks,
    });

    expect(result.pool).toEqual(sampleTasks);
    expect(result.fromCache).toBe(false);
    expect(result.error?.message).toContain('429');
  });

  it('falls back to the disk cache when the load fails and no in-memory pool is held', async () => {
    const cache = new PoolCacheStore({ stateDir });
    await cache.write(sampleTasks);

    const result = await loadPoolWithCacheFallback({
      loadPool: async () => { throw new Error('HF unreachable'); },
      cache,
      currentPool: [],
    });

    expect(result.pool).toEqual(sampleTasks);
    expect(result.fromCache).toBe(true);
    expect(result.error?.message).toContain('HF unreachable');
  });

  it('returns an empty pool when the load fails, no in-memory pool, and no cache', async () => {
    const cache = new PoolCacheStore({ stateDir });
    const result = await loadPoolWithCacheFallback({
      loadPool: async () => { throw new Error('HF unreachable'); },
      cache,
      currentPool: [],
    });

    expect(result.pool).toEqual([]);
    expect(result.fromCache).toBe(false);
    expect(result.error?.message).toContain('HF unreachable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/_swe-rebench-v2-pool-cache.test.ts`
Expected: FAIL — `loadPoolWithCacheFallback` is not exported (the new describe block errors on import).

- [ ] **Step 3: Write the minimal implementation**

Append to `client/src/solver-types/_swe-rebench-v2-pool-cache.ts`:

```ts
/** Outcome of an HF pool load attempt with cache fallback. */
export interface PoolLoadResult {
  /** The pool to use. May be empty only when HF failed and no cache exists. */
  pool: PoolTask[];
  /** True when `pool` was served from the disk cache rather than a live load. */
  fromCache: boolean;
  /** Set when the live HF load failed (even if a fallback pool was found). */
  error?: { message: string; at: string };
}

/**
 * Load the pool from HF, falling back to the disk cache on failure.
 *
 *  - load succeeds            → return it, persist it to the cache.
 *  - load fails, pool held    → keep the in-memory pool (no cache read needed).
 *  - load fails, no pool, cache present → serve the cache (`fromCache: true`).
 *  - load fails, no pool, no cache      → empty pool (generator idle).
 *
 * Pure orchestration: the loader and cache are injected so every branch is
 * unit-testable. Never throws.
 */
export async function loadPoolWithCacheFallback(args: {
  loadPool: () => Promise<PoolTask[]>;
  cache: PoolCacheStore;
  currentPool: PoolTask[];
}): Promise<PoolLoadResult> {
  try {
    const pool = await args.loadPool();
    await args.cache.write(pool);
    return { pool, fromCache: false };
  } catch (err) {
    const error = {
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    };
    if (args.currentPool.length > 0) {
      return { pool: args.currentPool, fromCache: false, error };
    }
    const cached = await args.cache.read();
    if (cached && cached.tasks.length > 0) {
      return { pool: cached.tasks, fromCache: true, error };
    }
    return { pool: [], fromCache: false, error };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/_swe-rebench-v2-pool-cache.test.ts`
Expected: PASS — 10 tests (6 from Task 1 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-pool-cache.ts client/test/solver-types/_swe-rebench-v2-pool-cache.test.ts
git commit -m "feat(client): add loadPoolWithCacheFallback orchestrator (#466)"
```

---

## Task 3: Wire the cache fallback into the generator's `refreshPool`

**Files:**
- Modify: `client/src/solver-types/swe-rebench-v2.ts` (import; `makeSweRebenchV2Generator` internals ~L281-323)

The generator's `refreshPool` currently calls `loadSweRebenchV2Pool` directly and, on failure, keeps a possibly-empty in-memory pool. Replace it with a call to the tested `loadPoolWithCacheFallback`, and update the `tick` refresh-gate so a cache-served pool keeps retrying HF every poll (rather than waiting out the 24 h `POOL_REFRESH_MS`).

- [ ] **Step 1: Add the import**

In `client/src/solver-types/swe-rebench-v2.ts`, immediately after the existing `_swe-rebench-v2-pool.js` import block (ends at line 40), add:

```ts
import { PoolCacheStore, loadPoolWithCacheFallback } from './_swe-rebench-v2-pool-cache.js';
```

- [ ] **Step 2: Add the cache store + fallback flag to the generator state**

In `makeSweRebenchV2Generator` (starts line 281), the local declarations currently read:

```ts
  let pool: PoolTask[] = [];
  let poolLoadedAt = 0;
  let floorWarned = false;
```

Replace that block with:

```ts
  const poolCache = new PoolCacheStore({ stateDir: config.stateDir });
  let pool: PoolTask[] = [];
  let poolLoadedAt = 0;
  let poolFromCache = false;
  let floorWarned = false;
```

- [ ] **Step 3: Rewrite `refreshPool` to use the cache fallback**

Replace the entire `refreshPool` function (lines 295-310) — currently:

```ts
  async function refreshPool(): Promise<void> {
    try {
      pool = await loadSweRebenchV2Pool();
      poolLoadedAt = Date.now();
    } catch (err) {
      // Non-fatal: keep the existing pool if already loaded
      lastError = {
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      };
      console.warn(
        `[swe-rebench-v2-gen] pool refresh failed (using ${pool.length} cached tasks):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
```

with:

```ts
  async function refreshPool(): Promise<void> {
    const result = await loadPoolWithCacheFallback({
      loadPool: loadSweRebenchV2Pool,
      cache: poolCache,
      currentPool: pool,
    });
    pool = result.pool;
    poolFromCache = result.fromCache;
    lastError = result.error;
    if (!result.error) {
      // Fresh HF load — hold it for the full POOL_REFRESH_MS window.
      poolLoadedAt = Date.now();
    }
    if (result.fromCache) {
      console.warn(
        `[swe-rebench-v2-gen] HF pool refresh failed; serving ${pool.length} tasks from disk cache — ` +
        `generator stays live, will retry HF next poll: ${result.error?.message}`,
      );
    } else if (result.error) {
      console.warn(
        `[swe-rebench-v2-gen] pool refresh failed (pool size ${pool.length}): ${result.error.message}`,
      );
    }
  }
```

- [ ] **Step 4: Update the `tick` refresh-gate so a cached pool keeps retrying HF**

In `tick` the refresh-gate currently reads (lines 320-323):

```ts
    // Refresh pool if stale or empty
    if (pool.length === 0 || now - poolLoadedAt > POOL_REFRESH_MS) {
      await refreshPool();
    }
```

Replace with:

```ts
    // Refresh pool if stale, empty, or currently served from the disk cache
    // (a cache-served pool retries HF every poll so the generator self-heals
    // as soon as HF recovers — #466).
    if (pool.length === 0 || poolFromCache || now - poolLoadedAt > POOL_REFRESH_MS) {
      await refreshPool();
    }
```

- [ ] **Step 5: Typecheck**

Run: `cd client && yarn typecheck`
Expected: exit 0, no errors. (Confirms `loadSweRebenchV2Pool` — declared `export async function loadSweRebenchV2Pool(): Promise<PoolTask[]>` at line 112 — satisfies the `loadPool` parameter type, and that `pool`/`poolFromCache`/`poolLoadedAt` are all still consistently typed.)

- [ ] **Step 6: Run the solver-types test suite**

Run: `cd client && yarn vitest run test/solver-types`
Expected: PASS — all pre-existing `swe-rebench-v2` generator tests still green, plus the 10 new `_swe-rebench-v2-pool-cache` tests. If a pre-existing generator test mocked `loadSweRebenchV2Pool` and now also needs the cache to be empty, point its `stateDir` at a fresh `mkdtemp` dir (the cache is keyed off `stateDir`); do not weaken assertions.

- [ ] **Step 7: Build**

Run: `cd client && yarn build`
Expected: exit 0 (tsc + SPA bundle), 0 `error TS`.

- [ ] **Step 8: Commit**

```bash
git add client/src/solver-types/swe-rebench-v2.ts
git commit -m "fix(client): swe-rebench-v2 generator falls back to disk pool cache on HF failure (#466)

refreshPool delegated HF load failure handling to the tested
loadPoolWithCacheFallback orchestrator: a successful HF load is now
persisted to <stateDir>/pool-cache.json, and a cold-start HF failure
reads the cache back instead of leaving an empty pool and silently
posting nothing. The tick refresh-gate retries HF every poll while
serving from cache so the generator self-heals when HF recovers.

Closes #466"
```

---

## Manual verification (after Task 3)

Against the live operator daemon, with the generator's HF dependency exercised:

1. `cd client && yarn build && node dist/bin/jinn.js run` — let the generator complete one successful poll, then confirm `~/.jinn-client/swe-rebench-v2/pool-cache.json` exists and contains a `tasks` array.
2. Simulate an HF outage on the next run (e.g. temporarily block `datasets-server.huggingface.co` via `/etc/hosts`, or run offline) and restart the daemon. Confirm the daemon log shows `[swe-rebench-v2-gen] HF pool refresh failed; serving N tasks from disk cache` rather than going silent, and that the generator still selects/posts a candidate.
3. Restore HF; confirm the next poll logs a normal refresh and `poolFromCache` clears (no more cache-fallback warning).

---

## Self-Review

**1. Spec coverage (#466 acceptance criteria):**
- *"pool is cached to disk and survives HF outages"* → Task 1 (`PoolCacheStore`) + Task 3 (write on success, read on failure). ✓
- *"a transient HF failure does not zero out task posting"* → Task 2 fallback branches + Task 3 `tick` gate; covered by the "falls back to the disk cache" test. ✓
- *"an empty or failed pool refresh is surfaced ... not silent"* → `refreshPool` now emits a distinct `console.warn` for the cache-fallback and the no-cache cases; `lastError` is set on every failure (consumed by companion issue #471 for the dashboard surface). ✓
- *"generation continues from the last good cached pool when HF is unavailable"* → Task 3, verified by manual step 2. ✓

**2. Placeholder scan:** No TBD/TODO/"handle errors appropriately" — every code step carries complete code; every run step carries an exact command and expected result. ✓

**3. Type consistency:** `PoolCacheStore` constructor `{ stateDir }` matches `GeneratorStateStore`'s. `loadPoolWithCacheFallback` consumes `{ loadPool, cache, currentPool }` and returns `PoolLoadResult { pool, fromCache, error? }` — `refreshPool` (Task 3) destructures exactly those fields. `error` shape `{ message: string; at: string }` matches the existing `lastError` field type in `SweRebenchV2GeneratorStateSnapshot` (`swe-rebench-v2.ts:83`), so `lastError = result.error` typechecks. `loadPool` is typed `() => Promise<PoolTask[]>`; `loadSweRebenchV2Pool` returns `Promise<PoolTask[]>`. ✓

**Out of scope (separate plans):** #471 surfaces `lastError`/`lastPollSummary` in the operator app; #467 adds HF request throttling/backoff (which reduces how often this fallback triggers in the first place).
