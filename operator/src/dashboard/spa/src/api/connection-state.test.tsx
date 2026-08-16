import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useConnectionState } from './connection-state.js';

/**
 * Issue #335 — the connection-liveness probe. These tests drive the hook with
 * a stubbed `fetch` so we can simulate a dying / recovering daemon without a
 * real server, and assert the timing contract: surface a dead daemon within
 * the issue's ~5s target, and auto-recover when it answers again.
 */

type FetchResult = { status: number } | 'reject';

/**
 * A scriptable `fetch` stub. Each call shifts the next scripted result; once
 * the script is exhausted it keeps returning the final result so the polling
 * loop has a stable steady state.
 */
function makeFetch(script: FetchResult[]): typeof fetch {
  let lastResult: FetchResult = script[0] ?? { status: 200 };
  return vi.fn(async () => {
    const next = script.shift();
    if (next !== undefined) lastResult = next;
    if (lastResult === 'reject') throw new Error('network down');
    return { status: lastResult.status } as Response;
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useConnectionState', () => {
  it('starts connected and stays connected while the daemon answers OK', async () => {
    globalThis.fetch = makeFetch([{ status: 200 }]);
    const { result } = renderHook(() =>
      useConnectionState({ pollIntervalMs: 1000 }),
    );

    // Initial state is optimistically connected.
    expect(result.current.status).toBe('connected');

    // Let the first probe + a couple of poll cycles run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.status).toBe('connected');
  });

  it('flips to disconnected after the failure threshold (~4s with defaults)', async () => {
    // Every probe rejects — daemon is dead.
    globalThis.fetch = makeFetch(['reject']);
    const { result } = renderHook(() =>
      useConnectionState({ pollIntervalMs: 2000, failureThreshold: 2 }),
    );

    // First probe runs immediately and fails (failures=1, still connected).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe('connected');

    // Second probe after one poll interval crosses the threshold.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.status).toBe('disconnected');
    if (result.current.status === 'disconnected') {
      expect(result.current.attempts).toBeGreaterThanOrEqual(1);
      // The real rejection reason is threaded through, not a literal stub.
      expect(result.current.lastError).toBe('network down');
    }
  });

  it('treats 502/503/504 as down but a 401/403 as alive', async () => {
    // 503 then 503: an unavailable gateway counts as a daemon-down failure.
    globalThis.fetch = makeFetch([{ status: 503 }, { status: 503 }]);
    const { result } = renderHook(() =>
      useConnectionState({ pollIntervalMs: 1000, failureThreshold: 2 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.status).toBe('disconnected');
    if (result.current.status === 'disconnected') {
      expect(result.current.lastError).toMatch(/HTTP 503/);
    }

    // A 403 (auth surface) must NOT be read as a dead daemon.
    globalThis.fetch = makeFetch([{ status: 403 }]);
    const { result: authResult } = renderHook(() =>
      useConnectionState({ pollIntervalMs: 1000, failureThreshold: 2 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(authResult.current.status).toBe('connected');
  });

  it('treats a genuine 500 as alive-but-erroring, not offline', async () => {
    // A 500 from a *live* daemon is an uncaught throw in gatherStatusForApi.
    // The process answered, so it is up — the probe must NOT flip to
    // disconnected and wrongly tell the operator to re-run `jinn run`.
    globalThis.fetch = makeFetch([{ status: 500 }]);
    const { result } = renderHook(() =>
      useConnectionState({ pollIntervalMs: 1000, failureThreshold: 2 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.status).toBe('connected');
  });

  it('auto-reconnects when the daemon comes back', async () => {
    // Fail twice (cross threshold), then recover on every later probe.
    globalThis.fetch = makeFetch(['reject', 'reject', { status: 200 }]);
    const { result } = renderHook(() =>
      useConnectionState({
        pollIntervalMs: 1000,
        failureThreshold: 2,
        maxBackoffMs: 4000,
      }),
    );

    // Drive past the threshold into disconnected.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.status).toBe('disconnected');

    // The backoff retry eventually fires; the daemon now answers OK and the
    // hook flips back to connected. Advancing well past the (capped) backoff
    // window settles the state synchronously under fake timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(result.current.status).toBe('connected');
  });
});
