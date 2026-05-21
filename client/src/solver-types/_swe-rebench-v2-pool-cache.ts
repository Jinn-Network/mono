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
