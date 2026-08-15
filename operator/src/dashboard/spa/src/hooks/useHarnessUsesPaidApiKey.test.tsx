import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const getStatus = vi.fn();

vi.mock('../api/client.js', () => ({
  api: { getStatus: () => getStatus() },
}));

const { useHarnessUsesPaidApiKey } = await import('./useHarnessUsesPaidApiKey.js');

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useHarnessUsesPaidApiKey', () => {
  beforeEach(() => {
    getStatus.mockReset();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  afterEach(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
  });

  it('returns true while loading (conservative)', () => {
    getStatus.mockReturnValue(new Promise(() => {}));
    const { result, unmount } = renderHook(() => useHarnessUsesPaidApiKey('claude-code'), { wrapper });
    expect(result.current).toBe(true);
    unmount();
  });

  it('reads usesPaidApiKey from status.costSurface.harnesses', async () => {
    getStatus.mockResolvedValue({
      costSurface: {
        harnesses: {
          'claude-code': { credentialId: 'anthropic:api-key', usesPaidApiKey: true },
        },
      },
    });
    const { result } = renderHook(() => useHarnessUsesPaidApiKey('claude-code'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('returns false when harness is undefined', () => {
    getStatus.mockResolvedValue({
      costSurface: {
        harnesses: {
          'claude-code': { credentialId: 'anthropic:api-key', usesPaidApiKey: true },
        },
      },
    });
    const { result } = renderHook(() => useHarnessUsesPaidApiKey(undefined), { wrapper });
    expect(result.current).toBe(false);
  });

  it('returns false for subscription credential on status', async () => {
    getStatus.mockResolvedValue({
      costSurface: {
        harnesses: {
          'claude-code': { credentialId: 'anthropic:subscription', usesPaidApiKey: false },
        },
      },
    });
    const { result } = renderHook(() => useHarnessUsesPaidApiKey('claude-code'), { wrapper });
    await waitFor(() => expect(result.current).toBe(false));
  });
});
