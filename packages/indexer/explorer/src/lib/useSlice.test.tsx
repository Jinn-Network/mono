/**
 * useSlice URL-encoding tests — verify that SliceParams round-trips to the
 * request URL the engine expects. We don't need React-Query semantics, just
 * the pure encodeSliceParams behaviour. To assert the URL we spy on fetch.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSlice } from './useSlice';
import type { SliceParams } from './slice-types';
import type { ReactNode } from 'react';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return function Wrap({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useSlice URL encoding', () => {
  afterEach(() => vi.restoreAllMocks());

  it('appends window=<n> when SliceParams.window is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        params: {},
        enrichmentCoverage: 0,
        kpis: { attempts: 0, verdicts: 0, verdictsPass: 0, resolvedRate: null, jinnEarned: '0' },
        series: [],
        leaderboard: { train: [], frozen: [] },
      }), { status: 200 }),
    );

    const params: SliceParams = {
      manifestDigest: 'bafy',
      group: 'none',
      filter: {},
      includeUnenriched: false,
      bucket: 'auto',
      window: 30,
    };

    renderHook(() => useSlice(params), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('window=30');
  });

  it('omits window when SliceParams.window is undefined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const params: SliceParams = {
      manifestDigest: 'bafy',
      group: 'none',
      filter: {},
      includeUnenriched: false,
      bucket: 'auto',
    };
    renderHook(() => useSlice(params), { wrapper: makeWrapper() });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).not.toContain('window=');
  });

  it('encodes filter[harness]=codex&filter[model]=gpt-5.4-mini as raw filter[...] keys', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const params: SliceParams = {
      manifestDigest: 'bafy',
      group: 'none',
      filter: { harness: ['codex'], model: ['gpt-5.4-mini'] },
      includeUnenriched: false,
      bucket: 'auto',
    };
    renderHook(() => useSlice(params), { wrapper: makeWrapper() });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('filter[harness]=codex');
    expect(calledUrl).toContain('filter[model]=gpt-5.4-mini');
  });
});
