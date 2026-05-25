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
import { join, dirname } from 'node:path';
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
    await mkdir(dirname(this.cacheFile), { recursive: true });
    await writeFile(this.cacheFile, JSON.stringify(payload, null, 2));
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
      const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
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
 *  - load succeeds            -> return it, persist it to the cache.
 *  - load fails, pool held    -> keep the in-memory pool (no cache read needed).
 *  - load fails, no pool, cache present -> serve the cache (`fromCache: true`).
 *  - load fails, no pool, no cache      -> empty pool (generator idle).
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
