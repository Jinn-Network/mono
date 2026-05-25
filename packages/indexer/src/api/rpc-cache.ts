/**
 * Tiny TTL-cached wrapper for an async RPC call.
 *
 * Both successful results and thrown errors (mapped to `null`) are cached for
 * the same TTL so a degraded RPC endpoint does not get retry-stormed by every
 * request handler that depends on it.
 *
 * Used by chain-head.ts (eth_blockNumber) and next-task-id.ts
 * (TaskCoordinator.nextTaskId view) — the two on-chain reads the /explorer and
 * /health/task-coverage routes depend on.
 */

/** TTL applied to both successful and null (error) results. */
export const RPC_CACHE_TTL_MS = 60_000;

/** Client-side RPC timeout — keeps slow endpoints from blocking handlers. */
export const RPC_TIMEOUT_MS = 1_500;

interface CacheCell<T> {
  value: T | null;
  fetchedAt: number;
}

/** A TTL-cached async RPC reader with a `reset()` for tests. */
export interface CachedRpcCall<T> {
  (): Promise<T | null>;
  reset(): void;
}

/**
 * Build a `CachedRpcCall<T>` from an async loader. The loader is invoked at
 * most once per `ttlMs` window; any thrown error is cached as `null` for the
 * same window to avoid retry-storming a failing endpoint.
 */
export function createCachedRpcCall<T>(
  loader: () => Promise<T>,
  ttlMs: number = RPC_CACHE_TTL_MS,
): CachedRpcCall<T> {
  let cache: CacheCell<T> = { value: null, fetchedAt: 0 };

  const call = (async () => {
    const now = Date.now();
    if (now - cache.fetchedAt < ttlMs) {
      return cache.value;
    }
    try {
      const value = await loader();
      cache = { value, fetchedAt: now };
      return value;
    } catch {
      cache = { value: null, fetchedAt: now };
      return null;
    }
  }) as CachedRpcCall<T>;

  call.reset = () => {
    cache = { value: null, fetchedAt: 0 };
  };

  return call;
}
