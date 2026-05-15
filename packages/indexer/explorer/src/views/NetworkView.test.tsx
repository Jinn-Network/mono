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
  onChainVerdictsPass: 0,
  onChainResolvedRate: null,
  verdictConsistency: { matched: 0, disagreed: 0, total: 0, agreementShare: null },
  enrichmentCoverageVerdicts: { enriched: 0, total: 0, share: 0 },
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
    byModel: [],
    byPlugin: [],
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
    const { container } = render(<NetworkView />, { wrapper: Wrapper });
    // Hero skeleton renders bg-sunken divs
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

  it('leads with the solve-rate hero', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      // resolvedRate = 0.9 → "90.0%" rendered as the hero number
      expect(screen.getByText('90.0%')).toBeInTheDocument();
    });
    // Pill label + section eyebrow
    expect(screen.getByText('Solve rate')).toBeInTheDocument();
    expect(screen.getByText('Task pipeline')).toBeInTheDocument();
  });

  it('renders the pipeline (Posted → Attempted → Evaluated) with avg attempts/task', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('Posted')).toBeInTheDocument();
    });
    expect(screen.getByText('Attempted')).toBeInTheDocument();
    expect(screen.getByText('Evaluated')).toBeInTheDocument();
    // tasksPosted 1234 surfaces in the pipeline; "Out of 1,234 tasks posted"
    // is the hero caption — the same number can legitimately repeat.
    expect(screen.getAllByText('1,234').length).toBeGreaterThanOrEqual(1);
    // attempts 2500 / tasksPosted 1234 → "2.0× per task"
    expect(screen.getByText(/×\s*per task/)).toBeInTheDocument();
    expect(screen.getAllByText('2,500').length).toBeGreaterThanOrEqual(1);
    // verdicts 2000 in the evaluated step (also in enrichment line)
    expect(screen.getAllByText('2,000').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the Activity strip', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });
    expect(screen.getByText('Active operators')).toBeInTheDocument();
    expect(screen.getByText('SolverNets running')).toBeInTheDocument();
    expect(screen.getByText('Last settlement')).toBeInTheDocument();
    // distinctOperators = 17
    expect(screen.getByText('17')).toBeInTheDocument();
    // solverNetsRunning = 3
    expect(screen.getByText('3')).toBeInTheDocument();
    // block("14500000") → "14,500,000"
    expect(screen.getByText('14,500,000')).toBeInTheDocument();
  });

  it('renders the Economy panel with operator/DAO split', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('Economy')).toBeInTheDocument();
    });
    expect(screen.getByText('JINN distributed')).toBeInTheDocument();
    // total = 100.50 + 50.00 = 150.50 JINN
    expect(screen.getByText('150.50 JINN')).toBeInTheDocument();
    expect(screen.getByText(/100\.50 JINN to operators/)).toBeInTheDocument();
    expect(screen.getByText(/50\.00 JINN to DAO/)).toBeInTheDocument();
    expect(screen.getByText('How JINN flows')).toBeInTheDocument();
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
      // 80.0% also appears in HBars "By mode" frozen share
      const matches = screen.getAllByText('80.0%');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('has no page-level headline — the Solve rate hero leads', async () => {
    // The May 15 redesign drops the italic "The ether" headline; the chrome's
    // Network tab is the wayfinder and the gold hero card is the lead.
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('Solve rate')).toBeInTheDocument();
    });
    expect(screen.queryByText('The ether')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
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

  it('does not render the on-chain vs envelope block on this view', async () => {
    // The block now lives on the SolverNet detail view (jinn-mono-ujlu).
    const fixtureWithDisagreement: NetworkResponse = {
      ...NETWORK_FIXTURE,
      onChainVerdictsPass: 1500,
      onChainResolvedRate: 0.75,
      verdictConsistency: {
        matched: 1800,
        disagreed: 200,
        total: 2000,
        agreementShare: 0.9,
      },
    };
    mockFetchNetwork(fixtureWithDisagreement);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('Solve rate')).toBeInTheDocument();
    });
    expect(screen.queryByText('On-chain vs envelope')).not.toBeInTheDocument();
    expect(screen.queryByText('Envelope-truth resolved')).not.toBeInTheDocument();
    expect(screen.queryByText('Agreement')).not.toBeInTheDocument();
  });
});
