/**
 * Shared ~3s-TTL memoization of the `gatherGatheredStatusRaw` + `assembleStatusV1` pair
 * (issue #2408, PR #2424 review finding F3; single-flight added review round 2 finding N1).
 *
 * `GET /v1/status`, `GET /v1/rewards`, and `GET /v1/notifications` each used to run this same
 * expensive pair independently — a live RPC round trip (`getBlockNumber`, `getChainId`,
 * `getBalance` ×2, per-service balance multicalls) plus an indexer read, on every poll of every
 * one of the three. Adding `/v1/notifications` as a fourth-ish caller (Overview polls status
 * *and* notifications) doubled the steady-state gather cost with no new information — the
 * three endpoints read the same underlying chain state.
 *
 * This module is a single process-wide cache slot — **and it must be, not just may be**: all
 * three routes must resolve their `StatusGatherConfig` through the SAME enriched shape
 * (`server.ts`'s `resolveStatusGatherConfig`, review round 2 findings B1/B2) or whichever caller
 * fills the slot first silently decides what shape every sibling reads for the rest of the TTL
 * window. Keying by identity would defeat the sharing entirely (the daemon has exactly one
 * `Store` and one effective config at a time, but a fresh wrapper object is built per request).
 *
 * **Single-flight (review round 2 finding N1).** Concurrent callers within the same in-flight
 * gather (e.g. Overview's status poll and a notifications poll landing in the same tick) share
 * ONE underlying `gatherRaw`/`assemble` call via `inFlight`, not one each. The in-flight slot is
 * cleared on both success and rejection (`finally`), so a failed gather never poisons future
 * calls — the next call after a rejection retries fresh, it doesn't stay wedged. Only the
 * FIRST caller's `gatherRaw`/`assemble`/`ttlMs` overrides apply to an in-flight gather; late
 * arrivals share its result regardless of their own overrides — harmless in production (there
 * is only one real set of dependencies), and exactly what the single-flight tests pin.
 *
 * A cache hit (or single-flight join) returns a **shallow clone** of both `raw` and `assembled`
 * — every existing caller mutates TOP-LEVEL fields in place after gathering
 * (`rewards-endpoint.ts`'s `raw.pendingStakingRewardsWei = ...`, `gather-status.ts`'s
 * `body.spend = ...` tail enrichments), and those mutations must never leak into the shared
 * cached copy or cross-contaminate a sibling endpoint's read within the same TTL window. This is
 * a genuine constraint, not just today's convenience: a future caller that reaches into a
 * NESTED object (e.g. `assembled.fleet.services[0].x = ...`) would still mutate the shared
 * cached sub-object across the shallow-clone boundary. `structuredClone` would close that gap at
 * the cost of a full deep copy every read; not done here because every current mutation site is
 * top-level — revisit if that stops being true.
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
let inFlight: Promise<CacheEntry> | null = null;

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

async function gatherFresh(
  store: Store,
  status: StatusGatherConfig | undefined,
  gatherRaw: typeof gatherGatheredStatusRaw,
  assemble: typeof assembleStatusV1,
  now: () => number,
  ttlMs: number,
): Promise<CacheEntry> {
  const raw = await gatherRaw(store, status);
  const assembled = assemble(raw);
  const entry: CacheEntry = { raw, assembled, expiresAt: now() + ttlMs };
  cache = entry;
  return entry;
}

/**
 * Returns the cached `{ raw, assembled }` pair if still within its TTL window (joining an
 * in-flight gather if one is already running), otherwise starts a fresh single-flight gather.
 * Always returns a shallow clone — safe for the caller to mutate top-level fields on its own
 * copy (see module docstring for the exact constraint this relies on).
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

  if (!inFlight) {
    const gatherRaw = deps.gatherRaw ?? gatherGatheredStatusRaw;
    const assemble = deps.assemble ?? assembleStatusV1;
    const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    inFlight = gatherFresh(store, status, gatherRaw, assemble, now, ttlMs).finally(() => {
      inFlight = null;
    });
  }

  const entry = await inFlight;
  return { raw: { ...entry.raw }, assembled: { ...entry.assembled } };
}

/**
 * Drops the cached pair AND the in-flight-gather reference, so the next `getCachedGatheredStatus`
 * call starts a fresh gather against the CURRENT config rather than joining (or later being
 * overwritten by) one already running against the config being replaced. Called by `server.ts`'s
 * `setStatusConfig` on every effective-config swap (real production behavior); also the right
 * call for a test that spins up a new `Store`/`StatusGatherConfig` and expects an immediate
 * fresh read rather than a stale cross-test cache hit (the module is a process-wide singleton
 * otherwise).
 *
 * Residual, accepted race: if a gather was ALREADY in flight at the moment of invalidation, that
 * promise still runs to completion and still writes `cache` on resolution — briefly reinstating
 * stale (pre-swap) data until the next fresh gather (triggered by any request arriving after
 * this call) overwrites it again. Narrow window, bounded by one RPC round trip, and only
 * reachable at the one-time setup→running config swap; not closed here (would need a
 * generation/epoch counter, disproportionate to the risk).
 */
export function invalidateGatheredStatusCache(): void {
  cache = null;
  inFlight = null;
}
