import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionState } from '../api/connection-state.js';
import type { StructuredEvent } from '../../../../api/contract/index.js';
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
      // Low-but-nonzero runway → funding_low fires (#1296). The adapter reads
      // the real runwayDaysExcess; runway 1 < 3-day threshold.
      masterGas: {
        address: '0xL2MASTER',
        balanceWei: '5000000000000000',
        runwayDaysExcess: '1',
        minEthWei: '1000000000000000',
      },
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

  // ── update_available wire mapping (issue #641) ─────────────────────────
  // The daemon reports the running build as `/v1/status.version` and the newest
  // published `@jinn-network/client` as `/v1/status.latestVersion` (string when
  // strictly newer, null otherwise). `mapStatusToDeriveInput` normalises these
  // into the deriver's `daemonVersion` / `latestVersion`. These tests pin the
  // wire mapping against the real /v1/status shape (the deriver's own emit rule
  // is pinned separately in derive.test.ts).

  it('emits update_available when /v1/status.latestVersion is strictly newer than version', async () => {
    apiMocks.getStatus.mockResolvedValue({
      masterGas: { balanceWei: '0' },
      fleet: { services: [] },
      version: '0.1.6',
      latestVersion: '0.1.8',
    });
    apiMocks.getBootstrap.mockResolvedValue({
      mode: 'running',
      joinedSolverNets: { 'bafkreic-x': {} },
    });

    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() =>
      expect(result.current.map(n => n.kind)).toContain('update_available'),
    );
    const update = result.current.find(n => n.kind === 'update_available');
    expect(update?.severity).toBe('info');
    expect(update?.message).toContain('0.1.8');
    expect(update?.message).toContain('0.1.6');
  });

  it('does not emit update_available when /v1/status.latestVersion is null', async () => {
    apiMocks.getStatus.mockResolvedValue({
      masterGas: { balanceWei: '0' },
      fleet: { services: [] },
      version: '0.1.6',
      latestVersion: null,
    });
    apiMocks.getBootstrap.mockResolvedValue({
      mode: 'running',
      joinedSolverNets: { 'bafkreic-x': {} },
    });

    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });

    // Wait until the status fetch has settled before asserting the negative.
    // Current gas-runway semantics do not manufacture a funding notification
    // from a status fixture that omits the threshold/runway fields.
    await waitFor(() => expect(apiMocks.getStatus).toHaveBeenCalled());
    expect(result.current.map(n => n.kind)).not.toContain('update_available');
  });

  it('does not create claim notifications from collector pending rewards', async () => {
    apiMocks.getStatus.mockResolvedValue({
      masterGas: {
        address: '0xL2MASTER',
        balanceWei: '5000000000000000',
        runwayDaysExcess: '1',
        minEthWei: '1000000000000000',
      },
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
  // The event-driven `claim_failed` notification kind from OPERATOR-APP-SPEC §2.10.
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

  // Regression for the SSE reconnect-replay path. `useEventStream`
  // accumulates events into a React state array; on reconnect the server
  // replays the last 50 events from its ring buffer (events-endpoint.ts
  // §/v1/events backfill) with their *original* ids. Without dedup, a single
  // burst would inflate the visible failure count on every reconnect — which
  // contradicts the issue's motivation (the dogfood operator who watched 26
  // failures should still see "26", not "52").
  it('deduplicates claim_failed events by id so reconnect-replay does not inflate the count', async () => {
    const nowIso = new Date().toISOString();
    eventsMock.useEventStream.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          id: 'evt-dup-1',
          ts: nowIso,
          kind: 'intent',
          message: 'Task claim failed',
          requestId: 'task-dup',
          errorCode: 'claim_failed',
        },
        // Same id replayed by the server on reconnect — must not double-count.
        {
          schemaVersion: 1,
          id: 'evt-dup-1',
          ts: nowIso,
          kind: 'intent',
          message: 'Task claim failed',
          requestId: 'task-dup',
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
    // Critical assertion: n is 1, not 2.
    expect(claimFailed[0].message).toMatch(/^1 claim attempt /);
    expect(claimFailed[0].message).not.toMatch(/^2 claim attempts /);
  });

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
