import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionState } from '../api/connection-state.js';
import type { NotificationV1 } from '../../../../api/contract/index.js';
import { useNotifications } from './useNotifications.js';

/**
 * Notification derivation moved server-side (issue #2408) — `useNotifications` is now a thin
 * fetcher over `GET /v1/notifications` plus the client-local disconnected overlay. The
 * pre-#2408 version of this file exercised `deriveNotifications` / `mapStatusToDeriveInput`
 * against mocked `/v1/status` + `/v1/bootstrap` + SSE events; that derivation logic (and its
 * test fixtures) moved to `operator/test/api/notifications-build.test.ts` as server-side parity
 * tests. This file now only pins the hook's own two responsibilities: fetching + sorting the
 * server payload, and the disconnected override.
 */

// Default to connected; individual tests override via the exported setter.
let connectionState: ConnectionState = {
  status: 'connected',
  lastConnectedAt: Date.now(),
};

vi.mock('../api/connection-state.js', () => ({
  useConnectionState: () => connectionState,
}));

const apiMocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
}));

vi.mock('../api/client.js', () => ({
  api: {
    getNotifications: apiMocks.getNotifications,
  },
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function notification(overrides: Partial<NotificationV1> & Pick<NotificationV1, 'kind' | 'severity'>): NotificationV1 {
  return {
    title: overrides.kind,
    message: overrides.kind,
    ...overrides,
  };
}

describe('useNotifications', () => {
  beforeEach(() => {
    connectionState = { status: 'connected', lastConnectedAt: Date.now() };
    apiMocks.getNotifications.mockReset();
    apiMocks.getNotifications.mockResolvedValue({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      notifications: [],
    });
  });

  it('returns the server-derived notifications', async () => {
    apiMocks.getNotifications.mockResolvedValue({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      notifications: [notification({ kind: 'funding_low', severity: 'warning' })],
    });

    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].kind).toBe('funding_low');
  });

  it('sorts blocking-first then warning then info, regardless of server order', async () => {
    apiMocks.getNotifications.mockResolvedValue({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      notifications: [
        notification({ kind: 'update_available', severity: 'info' }),
        notification({ kind: 'funding_empty', severity: 'blocking' }),
        notification({ kind: 'funding_low', severity: 'warning' }),
      ],
    });

    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.length).toBe(3));
    expect(result.current.map((n) => n.severity)).toEqual(['blocking', 'warning', 'info']);
  });

  it('emits rpc_unreachable immediately when the SPA is disconnected from the daemon, without waiting on the fetch', () => {
    connectionState = {
      status: 'disconnected',
      since: Date.now(),
      lastError: 'network down',
      attempts: 2,
    };
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper() });

    // Synchronous — the disconnected branch never awaits the query.
    expect(result.current).toHaveLength(1);
    expect(result.current[0].kind).toBe('rpc_unreachable');
    expect(result.current[0].severity).toBe('blocking');
  });

  it('returns an empty list when the server reports no active notices', async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper() });
    await waitFor(() => expect(apiMocks.getNotifications).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});
