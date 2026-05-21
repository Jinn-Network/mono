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

vi.mock('../api/client.js', () => ({
  api: {
    getStatus: vi.fn().mockResolvedValue({
      funds: { eth: '0.001', runwayDays: 1 },
      rewards: { claimableWei: '0' },
      harness: { ready: true, name: 'claude-code' },
      rpc: { reachable: true },
      restartPending: false,
      daemonVersion: '0.1.5',
      services: [],
      joinedSolverNets: {},
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
});
