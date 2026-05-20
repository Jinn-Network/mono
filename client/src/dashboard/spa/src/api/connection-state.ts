/**
 * Daemon-connection liveness probe for the operator SPA.
 *
 * Issue #335: when the daemon process dies (intentional shutdown, crash, or
 * a restart that fails to respawn — see #289), the SPA was rendering its
 * last-known state forever. Operators thought the node was still working;
 * only a manual page refresh surfaced the truth.
 *
 * This hook fires a small `/v1/status` HEAD-ish poll on a short cadence
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

async function probe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    // 401/403 still mean the daemon is alive and responding. Only treat
    // network-level failures + 5xx as "daemon is down". The auth surface
    // owns its own redirect.
    return res.status < 500;
  } catch {
    return false;
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
      const ok = await probe(probeUrl, probeTimeoutMs);
      if (cancelledRef.current) return;

      if (ok) {
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
            return { ...prev, attempts: prev.attempts + 1, lastError: 'probe failed' };
          }
          return {
            status: 'disconnected',
            since: Date.now(),
            lastError: 'probe failed',
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
