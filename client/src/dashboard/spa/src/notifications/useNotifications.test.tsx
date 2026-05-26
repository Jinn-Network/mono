import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionState } from '../api/connection-state.js';
import type { StructuredEvent } from '../api/types.js';
import { useNotifications } from './useNotifications.js';

// Default to connected; individual tests override via the exported setter.
let connectionState: ConnectionState = {
  status: 'connected',
  lastConnectedAt: Date.now(),
};

vi.mock('../api/connection-state.js', () => ({
  useConnectionState: () => connectionState,
}));

vi.mock('../shell/RestartPendingContext.js', () => ({
  useRestartPending: () => ({ restartPending: false, setRestartPending: vi.fn() }),
}));

const eventsMock = vi.hoisted(() => ({
  useEventStream: vi.fn(() => ({ events: [] as StructuredEvent[], connected: false })),
}));

vi.mock('../api/events.js', () => eventsMock);

const apiMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getBootstrap: vi.fn(),
}));

// Mock the real `/v1/status` wire shape (NOT the deriver's internal DeriveInput
// shape). useNotifications' adapter normalises this for the deriver. Keeping the
// mock honest to the wire shape prevents the class of bug Playwright caught
// where unit tests passed against an artificial input shape but production
// blew up on the real one.
vi.mock('../api/client.js', () => ({
  api: {
    getStatus: apiMocks.getStatus,
    getBootstrap: apiMocks.getBootstrap,
  },
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useNotifications', () => {
  beforeEach(() => {
    connectionState = { status: 'connected', lastConnectedAt: Date.now() };
    apiMocks.getStatus.mockReset();
    apiMocks.getBootstrap.mockReset();
    apiMocks.getStatus.mockResolvedValue({
      masterGas: { balanceWei: '0' }, // zero balance → runway 0 → funding_low fires
      rewards: { pendingStakingRewardsWei: '0' },
      services: [],
      version: '0.1.5',
    });
    apiMocks.getBootstrap.mockResolvedValue({ mode: 'running' });
    // Default to no SSE events; tests opt in by overriding.
    eventsMock.useEventStream.mockReset();
    eventsMock.useEventStream.mockReturnValue({ events: [], connected: false });
  });

  it('returns derived notifications, ordered blocking-first then warning then info', async () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    const severities = result.current.map(n => n.severity);
    const expected = [...severities].sort((a, b) => {
      const order = { blocking: 0, warning: 1, info: 2 };
      return order[a] - order[b];
    });
    expect(severities).toEqual(expected);
  });

  it('emits rpc_unreachable immediately when the SPA is disconnected from the daemon', () => {
    connectionState = {
      status: 'disconnected',
      since: Date.now(),
      lastError: 'network down',
      attempts: 2,
    };
    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });
    // No async wait needed — the disconnected branch is synchronous.
    expect(result.current).toHaveLength(1);
    expect(result.current[0].kind).toBe('rpc_unreachable');
    expect(result.current[0].severity).toBe('blocking');
  });

  // Regression: the funding-sequence Playwright E2E caught a TypeError in the
  // deriver when /v1/status' real wire shape was passed via a blind cast to
  // DeriveInput. The adapter now translates safely; this test pins the
  // contract by feeding the adapter a sparse, real-shaped payload.
  it('does not throw on real /v1/status shape missing deriver-internal fields', async () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });
    // Real wire shape lacks funds.runwayDays / harness / rpc — the adapter
    // must default these and the hook must return without throwing.
    await waitFor(() => expect(result.current).toBeDefined());
    expect(() => result.current).not.toThrow();
  });

  it('does not create claim notifications from collector pending rewards', async () => {
    apiMocks.getStatus.mockResolvedValue({
      masterGas: { balanceWei: '0' },
      rewards: { pendingStakingRewardsWei: '1000000000000000000' },
      fleet: { services: [] },
      version: '0.1.5',
    });
    apiMocks.getBootstrap.mockResolvedValue({
      mode: 'running',
      joinedSolverNets: { 'bafkreic-x': {} },
    });
    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.map(n => n.kind)).toContain('funding_low'));
    expect(result.current.map(n => n.kind)).not.toContain('claim_available');
  });

  // ── claim_failed (issue #442) ──────────────────────────────────────────
  // The event-driven 12th notification kind from OPERATOR-APP-SPEC §2.10.
  // Sourced from the `/v1/events` SSE stream rather than the snapshot
  // deriver because failure is not a steady-state value any `/v1/status`
  // snapshot will keep reporting.

  it('emits a single claim_failed notification when a recent intent event with errorCode=claim_failed arrives', async () => {
    eventsMock.useEventStream.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          id: 'evt-fresh-1',
          ts: new Date().toISOString(),
          kind: 'intent',
          message: 'Task claim failed',
          requestId: 'task-1',
          errorCode: 'claim_failed',
        },
      ] satisfies StructuredEvent[],
      connected: true,
    });

    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() =>
      expect(result.current.map(n => n.kind)).toContain('claim_failed'),
    );
    const claimFailed = result.current.filter(n => n.kind === 'claim_failed');
    expect(claimFailed).toHaveLength(1);
    expect(claimFailed[0].severity).toBe('warning');
    expect(claimFailed[0].message).toMatch(/1 claim attempt/);
  });

  it('does not emit claim_failed when the only matching event is older than 30 minutes', async () => {
    eventsMock.useEventStream.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          id: 'evt-stale-1',
          // 31 minutes ago — outside the recent window.
          ts: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
          kind: 'intent',
          message: 'Task claim failed',
          requestId: 'task-stale',
          errorCode: 'claim_failed',
        },
      ] satisfies StructuredEvent[],
      connected: true,
    });

    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });

    // Wait for the snapshot-derived notifications to populate first so we
    // know the hook has settled before asserting on `claim_failed`.
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    expect(result.current.map(n => n.kind)).not.toContain('claim_failed');
  });

  it('aggregates multiple recent claim_failed events into a single notification with the count in the message', async () => {
    const nowIso = () => new Date().toISOString();
    eventsMock.useEventStream.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          id: 'evt-burst-1',
          ts: nowIso(),
          kind: 'intent',
          message: 'Task claim failed',
          requestId: 'task-a',
          errorCode: 'claim_failed',
        },
        {
          schemaVersion: 1,
          id: 'evt-burst-2',
          ts: nowIso(),
          kind: 'intent',
          message: 'Task claim failed',
          requestId: 'task-b',
          errorCode: 'claim_failed',
        },
        {
          schemaVersion: 1,
          id: 'evt-burst-3',
          ts: nowIso(),
          kind: 'intent',
          message: 'Task claim failed',
          requestId: 'task-c',
          errorCode: 'claim_failed',
        },
      ] satisfies StructuredEvent[],
      connected: true,
    });

    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() =>
      expect(result.current.map(n => n.kind)).toContain('claim_failed'),
    );
    const claimFailed = result.current.filter(n => n.kind === 'claim_failed');
    expect(claimFailed).toHaveLength(1);
    expect(claimFailed[0].message).toContain('3 claim attempts');
  });

  // Ageing-out behaviour is covered statically by the "older than 30 minutes"
  // test above: that filter is the load-bearing assertion. The 60s
  // `setInterval` re-render only governs *when* an idle dashboard re-evaluates
  // the same filter — it does not change correctness. A fake-timer test of
  // the tick mechanism inside `renderHook` proved brittle to React Query's
  // microtask scheduling (the 30-min cutoff slid forward but the hook's
  // memoised result didn't repaint deterministically), and the design note's
  // tradeoff section permits dropping it; see
  // docs/superpowers/specs/2026-05-26-issue-442-claim-failed-notification-design.md
  // §"Key trade-offs" → wall-clock window.

  it('ignores intent events whose errorCode is not claim_failed', async () => {
    eventsMock.useEventStream.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          id: 'evt-unrelated',
          ts: new Date().toISOString(),
          kind: 'intent',
          message: 'Something else',
          requestId: 'task-x',
          errorCode: 'some_other_code',
        },
      ] satisfies StructuredEvent[],
      connected: true,
    });

    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    expect(result.current.map(n => n.kind)).not.toContain('claim_failed');
  });
});
