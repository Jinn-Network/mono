/**
 * Daemon-connection liveness probe for the operator SPA.
 *
 * Issue #335: when the daemon process dies (intentional shutdown, crash, or
 * a restart that fails to respawn — see #289), the SPA was rendering its
 * last-known state forever. Operators thought the node was still working;
 * only a manual page refresh surfaced the truth.
 *
 * This hook fires a small `GET /v1/status` poll on a short cadence
 * (default 2s) and counts consecutive failures. After two failures (~4s) it
 * flips into `disconnected`; the SPA renders the offline banner. While
 * disconnected the poll keeps trying with exponential backoff (capped at
 * 30s) until the daemon answers OK again, at which point the state flips
 * back to `connected` and the rest of the app's react-query refetches
 * naturally resume.
 *
 * The hook is intentionally independent of `useEventStream`: SSE alone
 * can't distinguish "no events lately" from "socket dead", and the daemon
 * may be alive but not emitting. A small dedicated probe gives the SPA a
 * cheap, deterministic dead-daemon signal.
 */
import { useEffect, useRef, useState } from 'react';

export type ConnectionState =
  | { status: 'connected'; lastConnectedAt: number }
  | {
      status: 'disconnected';
      since: number;
      lastError: string | null;
      attempts: number;
    };

export interface UseConnectionStateOptions {
  /** Base poll cadence while connected, ms. Default 2000. */
  pollIntervalMs?: number;
  /**
   * Consecutive probe failures before the hook flips into `disconnected`.
   * Default 2 — combined with the default 2s poll this surfaces a dead
   * daemon within ~4s (within the issue's "~5s" target).
   */
  failureThreshold?: number;
  /** Reconnect backoff cap while disconnected, ms. Default 30000. */
  maxBackoffMs?: number;
  /** Probe timeout, ms. Default 3500. */
  probeTimeoutMs?: number;
  /**
   * Endpoint used for the liveness probe. Default `/v1/status`. Override
   * mainly exists so tests can target a stub URL.
   */
  probeUrl?: string;
}

interface ProbeResult {
  /** True when the daemon process is reachable (it answered at all). */
  ok: boolean;
  /** Human-readable failure reason when `ok` is false; null otherwise. */
  error: string | null;
}

async function probe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    // The daemon answered, so its process is alive. Distinguish "process
    // down" from "process up but erroring":
    //  - A genuine 500 is the daemon catching an uncaught throw in
    //    `gatherStatusForApi` — the process is *up*, just erroring. Telling
    //    the operator to re-run `jinn run` would be wrong, so treat 500 as
    //    alive.
    //  - 401/403 also mean the daemon is alive; the auth surface owns its
    //    own redirect.
    //  - Only 502/503/504 (gateway / unavailable / timeout) mean the
    //    process is genuinely unreachable behind whatever is fronting it.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return { ok: false, error: `daemon unavailable (HTTP ${res.status})` };
    }
    return { ok: true, error: null };
  } catch (err) {
    // Network-level rejection (connection refused, abort/timeout) — the
    // daemon process is not answering at all.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export function useConnectionState(
  opts: UseConnectionStateOptions = {},
): ConnectionState {
  const {
    pollIntervalMs = 2000,
    failureThreshold = 2,
    maxBackoffMs = 30_000,
    probeTimeoutMs = 3500,
    probeUrl = '/v1/status',
  } = opts;

  const [state, setState] = useState<ConnectionState>({
    status: 'connected',
    lastConnectedAt: Date.now(),
  });

  // Refs keep the polling loop stable across renders without re-arming
  // timers on every state flip.
  const consecutiveFailuresRef = useRef(0);
  const backoffRef = useRef(pollIntervalMs);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (cancelledRef.current) return;
      timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      const result = await probe(probeUrl, probeTimeoutMs);
      if (cancelledRef.current) return;

      if (result.ok) {
        consecutiveFailuresRef.current = 0;
        backoffRef.current = pollIntervalMs;
        setState((prev) =>
          prev.status === 'connected'
            ? prev
            : { status: 'connected', lastConnectedAt: Date.now() },
        );
        schedule(pollIntervalMs);
        return;
      }

      consecutiveFailuresRef.current += 1;
      const failures = consecutiveFailuresRef.current;

      if (failures >= failureThreshold) {
        setState((prev) => {
          if (prev.status === 'disconnected') {
            return {
              ...prev,
              attempts: prev.attempts + 1,
              lastError: result.error,
            };
          }
          return {
            status: 'disconnected',
            since: Date.now(),
            lastError: result.error,
            attempts: 1,
          };
        });
        // Exponential backoff while disconnected so we don't hammer a
        // crashed daemon, but always retry — when the operator runs
        // `jinn run` again the SPA must notice quickly.
        backoffRef.current = Math.min(
          Math.max(backoffRef.current * 2, pollIntervalMs * 2),
          maxBackoffMs,
        );
        schedule(backoffRef.current);
      } else {
        schedule(pollIntervalMs);
      }
    };

    // Kick off the first probe immediately so the test for "renders banner
    // on disconnect" doesn't have to wait for an initial interval.
    void tick();

    return () => {
      cancelledRef.current = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [pollIntervalMs, failureThreshold, maxBackoffMs, probeTimeoutMs, probeUrl]);

  return state;
}
