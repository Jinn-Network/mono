import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { NetworkView } from './NetworkView';
import type { NetworkResponse } from '../lib/api';

// ── Fixture ───────────────────────────────────────────────────────────────────

const NETWORK_FIXTURE: NetworkResponse = {
  tasksPosted: 1234,
  tasksSettled: 1100,
  tasksRefunded: 50,
  attempts: 2500,
  distinctOperators: 17,
  solverNetsRunning: 3,
  verdicts: 2000,
  verdictsPass: 1800,
  resolvedRate: 0.9,
  jinnDistributedOperator: '100500000000000000000',
  jinnDistributedDao: '50000000000000000000',
  mostRecentSettlementBlock: '14500000',
  composition: {
    byMode: [
      { value: 'train', count: 1500, share: 0.6 },
      { value: 'frozen', count: 1000, share: 0.4 },
    ],
    byHarness: [
      { value: 'swe-bench', count: 2000, share: 0.8 },
      { value: 'other', count: 500, share: 0.2 },
    ],
  },
  enrichmentCoverage: {
    enrichedAttempts: 2000,
    totalAttempts: 2500,
    share: 0.8,
  },
  lastIndexedBlock: '14500001',
  lastIndexedAt: new Date(Date.now() - 30_000).toISOString(),
  behindHead: null,
};

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const { hook } = memoryLocation({ path: '/', static: true });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>{children}</Router>
      </QueryClientProvider>
    );
  }

  return { Wrapper, qc };
}

function mockFetchNetwork(fixture: NetworkResponse) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchNetworkError() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('Internal Server Error', { status: 500 }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NetworkView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    // Fetch never resolves → stays in loading
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    // Skeleton tiles are present (bg-sunken divs in the kpi skeleton)
    const { container } = render(<NetworkView />, { wrapper: Wrapper });
    // Loading skeleton renders divs with bg-sunken style
    const skeletonTiles = container.querySelectorAll(
      '[style*="var(--bg-sunken)"]',
    );
    expect(skeletonTiles.length).toBeGreaterThan(0);
  });

  it('renders error state and retry button on fetch failure', async () => {
    mockFetchNetworkError();
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/Failed to load network stats/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('renders KPI values from fixture data', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      // tasksPosted = 1234
      expect(screen.getByText('1,234')).toBeInTheDocument();
    });
    // resolvedRate = 0.9 → "90.0%"
    expect(screen.getByText('90.0%')).toBeInTheDocument();
    // attempts = 2500 — appears in both KPI and enrichment line, use getAllByText
    expect(screen.getAllByText('2,500').length).toBeGreaterThanOrEqual(1);
    // distinctOperators = 17
    expect(screen.getByText('17')).toBeInTheDocument();
    // solverNetsRunning = 3
    expect(screen.getByText('3')).toBeInTheDocument();
    // verdicts = 2000 — appears in both the KPI tile and the enrichment section
    expect(screen.getAllByText('2,000').length).toBeGreaterThanOrEqual(1);
  });

  it('renders composition HBars with mode labels', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('train')).toBeInTheDocument();
      expect(screen.getByText('frozen')).toBeInTheDocument();
    });
    expect(screen.getByText('swe-bench')).toBeInTheDocument();
  });

  it('renders enrichment coverage line', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      // "2,000 / 2,500 attempts enriched (80.0%)"
      // 80.0% appears in HBars "By mode" frozen share AND the enrichment line
      const matches = screen.getAllByText('80.0%');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the page headline in Instrument Serif', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('The ether')).toBeInTheDocument();
    });
  });

  it('renders the status bar with the last indexed block', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      // block("14500001") → "14,500,001"
      expect(screen.getByText('14,500,001')).toBeInTheDocument();
    });
  });

  it('renders the "What\'s running" card', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("What's running")).toBeInTheDocument();
    });
  });
});
