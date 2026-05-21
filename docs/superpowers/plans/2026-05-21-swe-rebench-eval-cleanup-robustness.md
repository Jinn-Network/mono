# SWE-rebench Eval Cleanup Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SWE-rebench eval runner's count-based Docker image LRU (which fills operator disks) with prune-after-every-round plus a pre-eval disk-floor guard, so the eval pipeline never exhausts the disk.

**Architecture:** All changes are in `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts` (shared by `validate-pool` and the daemon evaluator). Task 1 removes the LRU and prunes each round's full Docker footprint (image + stopped containers + build cache) the moment the round ends. Task 2 adds a disk-headroom check before each round: prune broadly when low, abort the run cleanly (typed error) when the floor genuinely can't be met.

**Tech Stack:** TypeScript (Node 22, ESM), Vitest. No new dependencies (`node:fs/promises` `statfs` for the disk probe).

**Spec:** `docs/superpowers/specs/2026-05-21-swe-rebench-eval-cleanup-robustness-design.md` · **Issue:** [#476](https://github.com/Jinn-Network/mono/issues/476)

---

## File Structure

| File | Change |
|---|---|
| `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts` | **Modify** — remove the LRU (`imageLru`, `imageCacheMax`, `resolveImageCacheMax`, `DEFAULT_EVAL_IMAGE_CACHE_MAX`, `recordImageUsage`); add `pruneRound` + `defaultPruneRound`; add `InsufficientDiskError`, the disk probe, and `ensureDiskHeadroom`. |
| `client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts` | **Modify** — replace the `LRU image cache GC` describe block with prune-after-every-round tests; add disk-floor-guard tests; drop the `resolveImageCacheMax` import/tests. |

---

## Task 1: Prune-after-every-round (remove the LRU)

**Files:**
- Modify: `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts`
- Test: `client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts`

- [ ] **Step 1: Rewrite the eviction tests as prune-after-every-round tests**

In `eval-runner.test.ts`: remove `resolveImageCacheMax` from the import block at the top of the file. Delete the entire `describe('LRU image cache GC (jinn-mono-uy6v.11)', ...)` block and replace it with:

```ts
  // #476: the runner prunes each round's full Docker footprint immediately
  // after the eval, so disk usage never accumulates across instances.
  describe('prune-after-every-round (#476)', () => {
    it('prunes the round image after a successful eval', async () => {
      const pruned: string[] = [];
      const runner = makeRunnerWithReport(SUCCESS_REPORT, {
        pruneRound: async (image) => { pruned.push(image); },
      });
      await runner.runEval(baseArgs({ image: 'img-A' }));
      expect(pruned).toEqual(['img-A']);
    });

    it('prunes the round image even when the eval throws', async () => {
      const pruned: string[] = [];
      const runner = makeRunnerNoReport({
        pruneRound: async (image) => { pruned.push(image); },
      });
      await expect(runner.runEval(baseArgs({ image: 'img-B' }))).rejects.toThrow(
        EvalCouldNotGradeError,
      );
      expect(pruned).toEqual(['img-B']);
    });

    it('a throwing pruneRound never escapes runEval', async () => {
      const runner = makeRunnerWithReport(SUCCESS_REPORT, {
        pruneRound: async () => { throw new Error('docker rmi blew up'); },
      });
      await expect(runner.runEval(baseArgs({ image: 'img-C' }))).resolves.toBeDefined();
    });
  });
```

Match the existing test file's helpers: reuse however the existing tests build a runner + a fake report (the pre-existing eviction tests already did this — `makeRunnerWithReport` / `makeRunnerNoReport` / `baseArgs` / `SUCCESS_REPORT` are the names used here; if the file's helpers are named differently, use the file's actual helper names — the existing `'records the image in the LRU even when the eval throws'` and `'...report is missing/unparseable...'` tests are the templates for the success and no-report paths respectively).

- [ ] **Step 2: Run the tests — verify they fail**

Run: `cd client && yarn vitest run test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts`
Expected: FAIL — `pruneRound` is not an accepted option; `resolveImageCacheMax` import is unresolved.

- [ ] **Step 3: Remove the LRU machinery from `eval-runner.ts`**

Delete these from `eval-runner.ts`:
- `DEFAULT_EVAL_IMAGE_CACHE_MAX` (the `export const`) and `resolveImageCacheMax` (the whole `export function`).
- The `imageCacheMax?` field and its doc-comment from the `PythonEvalRunnerOptions` interface.
- The `imageLru`, `imageCacheMax` class fields from `PythonEvalRunner`.
- The entire `recordImageUsage` method.

- [ ] **Step 4: Add `pruneRound` + `defaultPruneRound`**

Replace the `cleanupImage?` option in `PythonEvalRunnerOptions` with:

```ts
  /**
   * Removes a completed round's entire Docker footprint — the round's image,
   * stopped containers, and build cache — so eval disk usage never
   * accumulates across instances (#476). Called once per `runEval`, in a
   * `finally`, even when the eval threw.
   *
   * Defaults to {@link defaultPruneRound}. Implementations MUST NOT throw —
   * `runEval` guards defensively, but cleanup failures should be swallowed
   * (logged elsewhere if desired) so a flaky `docker` never escapes `runEval`.
   */
  pruneRound?: (image: string) => Promise<void>;
```

Replace `defaultCleanupImage` with a shared `runDocker` helper and `defaultPruneRound`:

```ts
/**
 * Spawn `docker <args>`, resolving regardless of outcome — a failed cleanup
 * command is logged, never thrown (#476: cleanup must not break the eval loop).
 */
function runDocker(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        const status =
          code !== null ? `exited ${code}` : `terminated by signal ${signal ?? 'unknown'}`;
        console.warn(`[swe-rebench-v2] docker ${args.join(' ')} ${status}`);
      }
      resolve();
    });
    child.on('error', (err) => {
      console.warn(`[swe-rebench-v2] docker ${args.join(' ')} failed to spawn: ${err.message}`);
      resolve();
    });
  });
}

/**
 * Production `pruneRound`: remove the round's image, then prune stopped
 * containers and build cache. Each step is best-effort.
 */
async function defaultPruneRound(image: string): Promise<void> {
  if (image) await runDocker(['rmi', '-f', image]);
  await runDocker(['container', 'prune', '-f']);
  await runDocker(['builder', 'prune', '-f']);
}
```

- [ ] **Step 5: Wire `pruneRound` into `runEval`**

In `PythonEvalRunner`: replace the `imageLru` / `imageCacheMax` / `cleanupImage` fields with a single field, and set it in the constructor:

```ts
  private readonly pruneRound: (image: string) => Promise<void>;

  constructor(private readonly opts: PythonEvalRunnerOptions) {
    this.pruneRound = opts.pruneRound ?? defaultPruneRound;
  }
```

Replace the `runEval` body's `finally` so it prunes the round (defensively swallowing any throw):

```ts
  async runEval(args: Parameters<EvalRunner['runEval']>[0]): ReturnType<EvalRunner['runEval']> {
    try {
      return await this.runEvalImpl(args);
    } finally {
      // Prune this round's full Docker footprint — even when the eval threw,
      // a pull-and-crash still left an image on disk (#476).
      try {
        await this.pruneRound(args.image);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[swe-rebench-v2] pruneRound failed for ${args.image}: ${reason}`);
      }
    }
  }
```

- [ ] **Step 6: Run the tests — verify they pass**

Run: `cd client && yarn vitest run test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts`
Expected: PASS — the 3 new prune tests plus all pre-existing non-LRU tests. If a non-LRU test still references `imageCacheMax`/`cleanupImage`, update it to `pruneRound` (do not weaken assertions).

- [ ] **Step 7: Typecheck + commit**

Run: `cd client && yarn typecheck` → exit 0. (Confirms no remaining references to the deleted `resolveImageCacheMax` / `imageCacheMax` / `cleanupImage` across the codebase — if the daemon evaluator harness or its setup passes `imageCacheMax`/`cleanupImage`, remove those args there too.)

```bash
git add client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts
git commit -m "fix(client): swe-rebench eval prunes each round's Docker footprint, no LRU (#476)"
```

---

## Task 2: Pre-eval disk-floor guard

**Files:**
- Modify: `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts`
- Test: `client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `eval-runner.test.ts`:

```ts
  // #476: before each eval the runner ensures disk headroom — prune when low,
  // abort cleanly when the floor genuinely can't be met.
  describe('pre-eval disk-floor guard (#476)', () => {
    const GB = 1_000_000_000;

    it('proceeds without pruning when free disk is above the floor', async () => {
      let systemPruned = false;
      const runner = makeRunnerWithReport(SUCCESS_REPORT, {
        pruneRound: async () => {},
        freeDiskBytes: async () => 50 * GB,
        systemPrune: async () => { systemPruned = true; },
        diskFloorBytes: 10 * GB,
      });
      await runner.runEval(baseArgs({ image: 'img-A' }));
      expect(systemPruned).toBe(false);
    });

    it('prunes and proceeds when a low disk recovers above the floor', async () => {
      let systemPruned = false;
      const free = [5 * GB, 20 * GB]; // before prune, after prune
      const runner = makeRunnerWithReport(SUCCESS_REPORT, {
        pruneRound: async () => {},
        freeDiskBytes: async () => free.shift() ?? 20 * GB,
        systemPrune: async () => { systemPruned = true; },
        diskFloorBytes: 10 * GB,
      });
      await runner.runEval(baseArgs({ image: 'img-A' }));
      expect(systemPruned).toBe(true);
    });

    it('throws InsufficientDiskError (clean abort) when disk stays below the floor', async () => {
      const runner = makeRunnerWithReport(SUCCESS_REPORT, {
        pruneRound: async () => {},
        freeDiskBytes: async () => 2 * GB, // stays low before and after prune
        systemPrune: async () => {},
        diskFloorBytes: 10 * GB,
      });
      await expect(runner.runEval(baseArgs({ image: 'img-A' }))).rejects.toThrow(
        InsufficientDiskError,
      );
    });
  });
```

Add `InsufficientDiskError` to the imports from `../../../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js`.

- [ ] **Step 2: Run the tests — verify they fail**

Run: `cd client && yarn vitest run test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts`
Expected: FAIL — `InsufficientDiskError`, `freeDiskBytes`, `systemPrune`, `diskFloorBytes` are not exported / not accepted options.

- [ ] **Step 3: Add `InsufficientDiskError`, the disk probe, and the floor constant**

In `eval-runner.ts`, add to the imports: `import { mkdtemp, writeFile, readFile, rm, statfs } from 'node:fs/promises';` (extend the existing `node:fs/promises` import).

Add near `EvalCouldNotGradeError`:

```ts
/**
 * Thrown by `runEval` when the disk cannot be brought above the eval
 * disk-floor even after a broad prune. A clean abort — the caller stops
 * gracefully; no instance is graded, nothing is marked. Distinct from
 * `EvalCouldNotGradeError`: this is operator-environment, retryable, and must
 * never be turned into a `scorable: false` admission (#476).
 */
export class InsufficientDiskError extends Error {
  readonly freeBytes: number;
  readonly floorBytes: number;
  constructor(freeBytes: number, floorBytes: number) {
    const gb = (n: number): string => (n / 1_000_000_000).toFixed(1);
    super(
      `insufficient disk for swe-rebench eval: ${gb(freeBytes)} GB free, ` +
        `need ≥ ${gb(floorBytes)} GB`,
    );
    this.name = 'InsufficientDiskError';
    this.freeBytes = freeBytes;
    this.floorBytes = floorBytes;
  }
}

/** Default free-disk floor required before an eval round: 10 GB. */
export const DEFAULT_EVAL_DISK_FLOOR_BYTES = 10_000_000_000;

/** Resolve the disk floor: explicit option > `JINN_EVAL_DISK_FLOOR_GB` env > default. */
export function resolveDiskFloorBytes(opt: number | undefined): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt > 0) return Math.floor(opt);
  const envRaw = process.env['JINN_EVAL_DISK_FLOOR_GB'];
  if (envRaw !== undefined) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed * 1_000_000_000);
    console.warn(
      `[swe-rebench-v2] JINN_EVAL_DISK_FLOOR_GB=${JSON.stringify(envRaw)} is not a positive ` +
        `number — using default ${DEFAULT_EVAL_DISK_FLOOR_BYTES / 1_000_000_000} GB`,
    );
  }
  return DEFAULT_EVAL_DISK_FLOOR_BYTES;
}

/** Production disk probe: free bytes on the filesystem backing the temp dir. */
async function defaultFreeDiskBytes(): Promise<number> {
  const s = await statfs(tmpdir());
  return s.bavail * s.bsize;
}
```

- [ ] **Step 4: Add the three new options**

In `PythonEvalRunnerOptions`, add after `pruneRound`:

```ts
  /**
   * Required free disk (bytes) before an eval round starts. Explicit value >
   * `JINN_EVAL_DISK_FLOOR_GB` env > {@link DEFAULT_EVAL_DISK_FLOOR_BYTES}.
   */
  diskFloorBytes?: number;
  /** Probe of free disk (bytes). Defaults to a `statfs` on the temp dir. */
  freeDiskBytes?: () => Promise<number>;
  /**
   * Broad reclaim invoked when free disk is below the floor. Defaults to
   * `docker system prune -f`. MUST NOT throw.
   */
  systemPrune?: () => Promise<void>;
```

- [ ] **Step 5: Wire the guard into `runEval`**

In `PythonEvalRunner`, add the fields + constructor wiring:

```ts
  private readonly pruneRound: (image: string) => Promise<void>;
  private readonly diskFloorBytes: number;
  private readonly freeDiskBytes: () => Promise<number>;
  private readonly systemPrune: () => Promise<void>;

  constructor(private readonly opts: PythonEvalRunnerOptions) {
    this.pruneRound = opts.pruneRound ?? defaultPruneRound;
    this.diskFloorBytes = resolveDiskFloorBytes(opts.diskFloorBytes);
    this.freeDiskBytes = opts.freeDiskBytes ?? defaultFreeDiskBytes;
    this.systemPrune = opts.systemPrune ?? (() => runDocker(['system', 'prune', '-f']));
  }
```

Add the guard method:

```ts
  /**
   * Ensure enough free disk for an eval round. Below the floor → broad prune →
   * re-probe; still below → `InsufficientDiskError` (clean abort). (#476)
   */
  private async ensureDiskHeadroom(): Promise<void> {
    const free = await this.freeDiskBytes();
    if (free >= this.diskFloorBytes) return;
    console.warn(
      `[swe-rebench-v2] low disk (${(free / 1e9).toFixed(1)} GB) — running docker system prune`,
    );
    await this.systemPrune();
    const afterPrune = await this.freeDiskBytes();
    if (afterPrune < this.diskFloorBytes) {
      throw new InsufficientDiskError(afterPrune, this.diskFloorBytes);
    }
  }
```

Call it at the very top of `runEval`, before the `try`:

```ts
  async runEval(args: Parameters<EvalRunner['runEval']>[0]): ReturnType<EvalRunner['runEval']> {
    await this.ensureDiskHeadroom();
    try {
      return await this.runEvalImpl(args);
    } finally {
      try {
        await this.pruneRound(args.image);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[swe-rebench-v2] pruneRound failed for ${args.image}: ${reason}`);
      }
    }
  }
```

(`ensureDiskHeadroom` throwing before the `try` means a clean abort with no `pruneRound` — correct: nothing ran, nothing to prune.)

- [ ] **Step 6: Run the tests — verify they pass**

Run: `cd client && yarn vitest run test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts`
Expected: PASS — all prune + disk-guard tests plus the pre-existing suite.

- [ ] **Step 7: Typecheck, build, commit**

Run: `cd client && yarn typecheck` → exit 0. Then `cd client && yarn build` → exit 0, 0 `error TS`.

```bash
git add client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts
git commit -m "fix(client): swe-rebench eval aborts cleanly below the disk floor (#476)

Closes #476"
```

---

## Manual verification (after Task 2)

`cd client && yarn build`, then run a small validation batch on a machine with Docker:
`node dist/bin/jinn.js solver-nets validate-pool swe-rebench-v2 --limit 5` — confirm `docker system df` after the run shows no accumulated eval images/containers (each round pruned), and that Docker disk usage stays flat across the 5 instances instead of growing ~3 GB each.

---

## Self-Review

**1. Spec coverage:**
- §1 prune-after-every-round → Task 1 (image + container-prune + builder-prune; LRU removed). ✓
- §2 pre-eval disk-floor guard → Task 2 (`ensureDiskHeadroom`: probe → prune → re-probe → `InsufficientDiskError`). ✓
- §3 failure semantics — `InsufficientDiskError` is a distinct typed error (not `EvalCouldNotGradeError`), so it never becomes a `scorable: false`; it propagates to callers which stop via existing error handling. **Partial:** the residual caller-side nicety — `validate-pool` recognising `EvalCouldNotGradeError(reason='docker_storage_io_error')` as retryable rather than writing `scorable:false` — is *not* in this plan; with §2 in place the disk no longer reaches 100%, so `docker_storage_io_error` becomes rare. Tracked as a fast-follow on #476 (needs `client/src/cli/commands/solver-nets.ts`).
- §4 scope → all in `eval-runner.ts`; both consumers inherit it. ✓

**2. Placeholder scan:** Every code step carries complete code; every run step an exact command + expected result. The one soft spot — "use the file's actual helper names" in Task 1 Step 1 — is a deliberate instruction to match existing test helpers (the implementer reads the test file), not a vacuous placeholder.

**3. Type consistency:** `pruneRound: (image: string) => Promise<void>` — same signature in the option, the field, and `defaultPruneRound`. `freeDiskBytes: () => Promise<number>`, `systemPrune: () => Promise<void>`, `diskFloorBytes: number` — consistent across option/field/constructor. `InsufficientDiskError` exported and imported in the test. `resolveDiskFloorBytes` mirrors the (now-deleted) `resolveImageCacheMax` shape.
