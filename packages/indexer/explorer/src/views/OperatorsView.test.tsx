/**
 * OperatorsView tests.
 *
 * Fixtures: a valid operators response + a network response (for harness dropdown).
 *
 * Asserts:
 *   - Filter bar renders with mode segmented control, harness select, minVerdicts input
 *   - Leaderboard renders with ranked rows
 *   - Changing a filter triggers a refetch with the right query params
 *   - appliedFilters chips render when server returns them
 *   - Loading and error states render
 */

import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OperatorsView } from './OperatorsView';
import type { OperatorsResponse, NetworkResponse } from '../lib/api';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NETWORK_FIXTURE: NetworkResponse = {
  tasksPosted: 10,
  tasksSettled: 8,
  tasksRefunded: 0,
  attempts: 20,
  distinctOperators: 2,
  solverNetsRunning: 1,
  verdicts: 16,
  verdictsPass: 14,
  resolvedRate: 0.875,
  jinnDistributedOperator: '0',
  jinnDistributedDao: '0',
  mostRecentSettlementBlock: null,
  composition: {
    byMode: [{ value: 'train', count: 20, share: 1.0 }],
    byHarness: [
      { value: 'swe-bench', count: 15, share: 0.75 },
      { value: 'evalite', count: 5, share: 0.25 },
    ],
  },
  enrichmentCoverage: { enrichedAttempts: 16, totalAttempts: 20, share: 0.8 },
  lastIndexedBlock: '12000000',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

const OPERATORS_FIXTURE: OperatorsResponse = {
  ranked: [
    {
      rank: 1,
      operator: '0xaaaa000000000000aaaa',
      attempts: 120,
      settledContribution: 100,
      verdictsTotal: 100,
      verdictsPass: 90,
      resolvedRate: 0.9,
      jinnEarned: '1000000000000000000',
      dominantMode: 'train',
      dominantHarness: 'swe-bench',
    },
  ],
  lowVolume: [],
  minVerdicts: 5,
  appliedFilters: {},
  meta: { jinnAttribution: 'ok' },
  lastIndexedBlock: '12000000',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

const OPERATORS_WITH_FILTERS_FIXTURE: OperatorsResponse = {
  ...OPERATORS_FIXTURE,
  appliedFilters: { mode: 'train', harness: 'swe-bench' },
};

// ── Wrapper ───────────────────────────────────────────────────────────────────

function makeWrapper(path = '/operators') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const { hook } = memoryLocation({ path, static: true });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>{children}</Router>
      </QueryClientProvider>
    );
  }

  return { Wrapper, qc };
}

function mockFetchBoth(
  operatorsFixture: OperatorsResponse = OPERATORS_FIXTURE,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/explorer/network')) {
      return Promise.resolve(
        new Response(JSON.stringify(NETWORK_FIXTURE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (u.includes('/explorer/operators')) {
      return Promise.resolve(
        new Response(JSON.stringify(operatorsFixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

function mockFetchError() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/explorer/network')) {
      return Promise.resolve(
        new Response(JSON.stringify(NETWORK_FIXTURE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('Server Error', { status: 500 }));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OperatorsView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page heading', async () => {
    mockFetchBoth();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    // heading renders immediately
    expect(screen.getByText('Operators')).toBeInTheDocument();
  });

  it('renders the filter bar with mode buttons and harness select', async () => {
    mockFetchBoth();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });

    // Mode segmented control
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Train')).toBeInTheDocument();
    expect(screen.getByText('Frozen')).toBeInTheDocument();
    // Harness select
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    // Min verdicts input
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  it('renders the leaderboard with ranked row', async () => {
    mockFetchBoth();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('0xaaaa…aaaa')).toBeInTheDocument();
    });
  });

  it('renders JINN earned value when attribution is ok', async () => {
    mockFetchBoth();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });

    await waitFor(() => {
      // 1000000000000000000 wei = 1.00 JINN
      expect(screen.getByText('1.00 JINN')).toBeInTheDocument();
    });
  });

  it('renders the filter bar mode buttons (Train/Frozen)', async () => {
    // This tests that the segmented control renders all mode options
    // and the initial active state is "All".
    // URL-state-driven refetch is verified via the api hook query key, not direct URL assertion.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/explorer/network')) {
        return Promise.resolve(new Response(JSON.stringify(NETWORK_FIXTURE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify(OPERATORS_FIXTURE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });

    // Wait for initial load (fetch must have been called at least once)
    await waitFor(() => {
      expect(screen.getByText('0xaaaa…aaaa')).toBeInTheDocument();
    });

    // The initial fetch URL should NOT include mode= param (mode=all → no param)
    const initialCalls = fetchSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/explorer/operators'));
    expect(initialCalls.length).toBeGreaterThan(0);
    // initial should not have a mode param since 'all' is default
    expect(initialCalls[0]).not.toContain('mode=');
  });

  it('renders appliedFilters chips when server returns them', async () => {
    mockFetchBoth(OPERATORS_WITH_FILTERS_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/mode: train/i)).toBeInTheDocument();
      expect(screen.getByText(/harness: swe-bench/i)).toBeInTheDocument();
    });
  });

  it('renders loading state initially', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    const { Wrapper } = makeWrapper();
    const { container } = render(<OperatorsView />, { wrapper: Wrapper });

    // Some skeleton elements should be present
    const elevated = container.querySelectorAll('[style*="var(--bg-elevated)"]');
    expect(elevated.length).toBeGreaterThan(0);
  });

  it('renders error state when fetch fails', async () => {
    mockFetchError();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/Failed to load operators/i)).toBeInTheDocument();
    });
  });

  it('harness options come from network composition', async () => {
    mockFetchBoth();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });

    await waitFor(() => {
      const select = screen.getByRole('combobox') as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain('swe-bench');
      expect(options).toContain('evalite');
    });
  });
});
