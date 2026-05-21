import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionState } from '../api/connection-state.js';
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

// Mock the real `/v1/status` wire shape (NOT the deriver's internal DeriveInput
// shape). useNotifications' adapter normalises this for the deriver. Keeping the
// mock honest to the wire shape prevents the class of bug Playwright caught
// where unit tests passed against an artificial input shape but production
// blew up on the real one.
vi.mock('../api/client.js', () => ({
  api: {
    getStatus: vi.fn().mockResolvedValue({
      masterGas: { balanceWei: '0' }, // zero balance → runway 0 → funding_low fires
      rewards: { pendingStakingRewardsWei: '0' },
      services: [],
      version: '0.1.5',
    }),
    getBootstrap: vi.fn().mockResolvedValue({ mode: 'running' }),
  },
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useNotifications', () => {
  it('returns derived notifications, ordered blocking-first then warning then info', async () => {
    connectionState = { status: 'connected', lastConnectedAt: Date.now() };
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
    connectionState = { status: 'connected', lastConnectedAt: Date.now() };
    const { result } = renderHook(() => useNotifications(), {
      wrapper: makeWrapper(),
    });
    // Real wire shape lacks funds.runwayDays / harness / rpc — the adapter
    // must default these and the hook must return without throwing.
    await waitFor(() => expect(result.current).toBeDefined());
    expect(() => result.current).not.toThrow();
  });
});
