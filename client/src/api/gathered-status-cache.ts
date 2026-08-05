/**
 * Shared ~3s-TTL memoization of the `gatherGatheredStatusRaw` + `assembleStatusV1` pair
 * (issue #2408, PR #2424 review finding F3).
 *
 * `GET /v1/status`, `GET /v1/rewards`, and `GET /v1/notifications` each used to run this same
 * expensive pair independently — a live RPC round trip (`getBlockNumber`, `getChainId`,
 * `getBalance` ×2, per-service balance multicalls) plus an indexer read, on every poll of every
 * one of the three. Adding `/v1/notifications` as a fourth-ish caller (Overview polls status
 * *and* notifications) doubled the steady-state gather cost with no new information — the
 * three endpoints read the same underlying chain state.
 *
 * This module is a single process-wide cache slot (the daemon has exactly one `Store` and one
 * effective `StatusGatherConfig` at a time, so keying by identity would be pure overhead). A
 * cache hit returns a **shallow clone** of both `raw` and `assembled` — every existing caller
 * mutates top-level fields in place after gathering (`rewards-endpoint.ts`'s
 * `raw.pendingStakingRewardsWei = ...`, `gather-status.ts`'s `body.spend = ...` tail
 * enrichments), and those mutations must never leak into the shared cached copy or cross-
 * contaminate a sibling endpoint's read within the same TTL window.
 *
 * **Invalidation on config swap.** `server.ts`'s `ApiServer.setStatusConfig` (the daemon's
 * setup-mode → running-mode `StatusGatherConfig` hot-swap) calls
 * {@link invalidateGatheredStatusCache} so the very next read reflects the new config
 * immediately, rather than serving up to `ttlMs` of pre-swap data. Tests that spin up
 * independent `Store`/`StatusGatherConfig` fixtures back-to-back should call it too (exported
 * under the same name — this is real production behavior, not a test-only escape hatch).
 */
import type { Store } from '../store/store.js';
import { gatherGatheredStatusRaw, type StatusGatherConfig } from './gather-status.js';
import { assembleStatusV1, type GatheredStatusRaw } from './status-build.js';
import type { StatusV1Response } from './contract/status.js';

const DEFAULT_TTL_MS = 3000;

interface CacheEntry {
  raw: GatheredStatusRaw;
  assembled: StatusV1Response;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

export interface GatheredStatusCacheDeps {
  gatherRaw?: typeof gatherGatheredStatusRaw;
  assemble?: typeof assembleStatusV1;
  now?: () => number;
  ttlMs?: number;
}

export interface CachedGatheredStatus {
  raw: GatheredStatusRaw;
  assembled: StatusV1Response;
}

/**
 * Returns the cached `{ raw, assembled }` pair if still within its TTL window, otherwise
 * gathers fresh and repopulates the cache. Always returns a shallow clone — safe for the
 * caller to mutate top-level fields on its own copy.
 */
export async function getCachedGatheredStatus(
  store: Store,
  status: StatusGatherConfig | undefined,
  deps: GatheredStatusCacheDeps = {},
): Promise<CachedGatheredStatus> {
  const now = deps.now ?? Date.now;
  const nowMs = now();

  if (cache && cache.expiresAt > nowMs) {
    return { raw: { ...cache.raw }, assembled: { ...cache.assembled } };
  }

  const gatherRaw = deps.gatherRaw ?? gatherGatheredStatusRaw;
  const assemble = deps.assemble ?? assembleStatusV1;
  const raw = await gatherRaw(store, status);
  const assembled = assemble(raw);
  cache = { raw, assembled, expiresAt: nowMs + (deps.ttlMs ?? DEFAULT_TTL_MS) };
  return { raw: { ...raw }, assembled: { ...assembled } };
}

/**
 * Drops the cached pair so the next `getCachedGatheredStatus` call gathers fresh. Called by
 * `server.ts`'s `setStatusConfig` on every effective-config swap (real production behavior);
 * also the right call for a test that spins up a new `Store`/`StatusGatherConfig` and expects
 * an immediate fresh read rather than a stale cross-test cache hit (the module is a
 * process-wide singleton otherwise).
 */
export function invalidateGatheredStatusCache(): void {
  cache = null;
}
