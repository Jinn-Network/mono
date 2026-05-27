/**
 * withFallback — DiscoveryAPI wrapper with health-tracking and floor routing.
 *
 * Wraps a primary DiscoveryAPI implementation with a floor (fallback)
 * implementation. On each method call the primary is tried first. If it throws
 * a `DiscoveryUnavailableError` or a network-shaped error, the call is routed
 * to the floor and the result returned to the caller as if nothing happened.
 *
 * Health tracking: after `unhealthyThreshold` consecutive primary failures the
 * primary is skipped entirely for `retryAfterMs` milliseconds (degraded mode).
 * A single `console.warn` is emitted when the primary enters degraded mode so
 * operators can see why their daemon is running slowly. After the window
 * elapses the wrapper probes the primary again on the next call.
 *
 * NOTE (2026-05-23): this wrapper is no longer engaged by default. The
 * factory installs it only when `discovery.fallbackToOnchain === true` (an
 * explicit opt-in). Without the opt-in, indexer outages propagate as
 * DiscoveryUnavailableError so the operator-app surfaces them rather than the
 * daemon silently storming shared RPC. The wrapper itself is unchanged for
 * operators who still want it.
 *
 * Spec: spec/2026-05-11-discovery-api-and-shared-indexer.md §9.3.
 */

import type { DiscoveryAPI } from './types.js';
import { DiscoveryUnavailableError } from './types.js';

// ── Network-error classifier ─────────────────────────────────────────────────

/**
 * Returns true for errors that indicate a transient infrastructure failure
 * rather than a logical error from the backing. We classify these the same way
 * as `isTransientEthReadError` in `chain-read-errors.ts` — the daemon should
 * route to the floor rather than propagate them to the caller.
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof DiscoveryUnavailableError) return true;
  if (!(error instanceof Error)) return false;

  // Code-based check mirrors `isTransientEthReadError` in chain-read-errors.ts.
  // Viem/RPC errors often carry a `.code` property with no matching message substring.
  const code = (error as { code?: string }).code;
  if (code === 'SERVER_ERROR' || code === 'TIMEOUT' || code === 'NETWORK_ERROR') {
    return true;
  }

  const msg = error.message.toLowerCase();

  if (
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('connection refused') ||
    msg.includes('connect timeout') ||
    msg.includes('request timed out') ||
    msg.includes('timeout')
  ) {
    return true;
  }

  if (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('bad gateway') ||
    msg.includes('service unavailable')
  ) {
    return true;
  }

  if (
    msg.includes('-32603') ||
    msg.includes('internal json-rpc error') ||
    msg.includes('-32005')
  ) {
    return true;
  }

  return false;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface WithFallbackOptions {
  /**
   * Number of consecutive primary failures before the primary is marked
   * unhealthy and skipped for `retryAfterMs`.
   * @default 3
   */
  unhealthyThreshold?: number;
  /**
   * How long (ms) to skip the primary after it enters degraded mode. After
   * this window the next call will probe the primary again.
   * @default 60_000
   */
  retryAfterMs?: number;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Wraps `primary` with health tracking and routes failing calls to `floor`.
 *
 * Returns a new DiscoveryAPI that is transparent when the primary is healthy
 * and invisible when the primary is in degraded mode — callers receive floor
 * results without an error.
 */
export function withFallback(
  primary: DiscoveryAPI,
  floor: DiscoveryAPI,
  opts: WithFallbackOptions = {},
): DiscoveryAPI {
  const unhealthyThreshold = opts.unhealthyThreshold ?? 3;
  const retryAfterMs = opts.retryAfterMs ?? 60_000;

  let consecutiveFailures = 0;
  let degradedSince: number | null = null;
  // True when the next primary call is a probe — the first attempt after the
  // `retryAfterMs` degraded window elapsed. A probe that fails should re-degrade
  // immediately rather than burn `unhealthyThreshold` more failed round-trips
  // before re-entering degraded mode; this flag lets `recordPrimaryFailure`
  // distinguish "probe failed" from "Nth consecutive failure from a fresh
  // healthy state". It is only set after a degraded→retry cycle, so first-boot
  // behaviour (degrade after N failures) is unchanged.
  let nextCallIsProbe = false;

  function isPrimaryHealthy(): boolean {
    if (degradedSince === null) return true;
    if (Date.now() - degradedSince >= retryAfterMs) {
      // Probe window has elapsed — re-engage primary on a probe call.
      degradedSince = null;
      consecutiveFailures = 0;
      nextCallIsProbe = true;
      return true;
    }
    return false;
  }

  function recordPrimaryFailure(): void {
    consecutiveFailures += 1;
    const wasProbe = nextCallIsProbe;
    nextCallIsProbe = false;
    if (degradedSince !== null) return;
    // A failed probe (the call right after the retry window) means the primary
    // is still broken — go straight back to degraded mode rather than waiting
    // for `unhealthyThreshold` more failures.
    if (wasProbe || consecutiveFailures >= unhealthyThreshold) {
      degradedSince = Date.now();
      console.warn(
        `[discovery] primary DiscoveryAPI marked unhealthy after ${consecutiveFailures} consecutive failure(s)` +
        `${wasProbe ? ' (failed probe)' : ''}. Routing to floor implementation for ${retryAfterMs}ms.`,
      );
    }
  }

  function recordPrimarySuccess(): void {
    consecutiveFailures = 0;
    degradedSince = null;
    nextCallIsProbe = false;
  }

  /**
   * Shared dispatch helper. Tries the primary (unless in degraded mode), falls
   * back to the floor on network/unavailable errors.
   */
  async function dispatch<T>(
    primaryFn: () => Promise<T>,
    floorFn: () => Promise<T>,
  ): Promise<T> {
    if (isPrimaryHealthy()) {
      try {
        const result = await primaryFn();
        recordPrimarySuccess();
        return result;
      } catch (err) {
        if (isNetworkError(err)) {
          recordPrimaryFailure();
          return floorFn();
        }
        throw err;
      }
    }
    return floorFn();
  }

  return {
    findClaimableTasks(args) {
      return dispatch(
        () => primary.findClaimableTasks(args),
        () => floor.findClaimableTasks(args),
      );
    },

    listLaunchedSolverNets(args) {
      return dispatch(
        () => primary.listLaunchedSolverNets(args),
        () => floor.listLaunchedSolverNets(args),
      );
    },

    getLifecycleStatus(manifestCid) {
      return dispatch(
        () => primary.getLifecycleStatus(manifestCid),
        () => floor.getLifecycleStatus(manifestCid),
      );
    },

    getSolverNetOperatorCount(manifestCid) {
      return dispatch(
        () => primary.getSolverNetOperatorCount(manifestCid),
        () => floor.getSolverNetOperatorCount(manifestCid),
      );
    },

    queryEnvelopes(query) {
      return dispatch(
        () => primary.queryEnvelopes(query),
        () => floor.queryEnvelopes(query),
      );
    },

    listPluginPublications(args) {
      return dispatch(
        () => primary.listPluginPublications(args),
        () => floor.listPluginPublications(args),
      );
    },

    getPluginScores(args) {
      return dispatch(
        () => primary.getPluginScores(args),
        () => floor.getPluginScores(args),
      );
    },

    listBuilderArtifacts(args) {
      return dispatch(
        () => primary.listBuilderArtifacts(args),
        () => floor.listBuilderArtifacts(args),
      );
    },

    getInstanceSuccessCounts(args) {
      // Never fall through to the floor for this method — an empty Map from
      // the floor is indistinguishable from "all instances have 0 successes",
      // which is the under-count bug this method was introduced to fix (#669).
      // If the primary is degraded, propagate the error so the launcher aborts
      // its tick rather than silently posting against local-only counters.
      // The DiscoveryAPI.getInstanceSuccessCounts JSDoc encodes this contract
      // ("callers MUST NOT silently fall through to local-only counts").
      return primary.getInstanceSuccessCounts(args);
    },
  };
}
