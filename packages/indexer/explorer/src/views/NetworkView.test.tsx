import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { NetworkView } from './NetworkView';
import type { NetworkResponse } from '../lib/api';

// ── Fixture ───────────────────────────────────────────────────────────────────

const NETWORK_FIXTURE: NetworkResponse = {
  tasksPosted: 12,
  tasksSettled: 10,
  tasksRefunded: 1,
  attempts: 30,
  everAttemptedOperators: 7,
  solverNetsRunning: 2,
  verdicts: 18,
  verdictsPass: 14,
  resolvedRate: 14 / 18,
  onChainVerdictsPass: 0,
  onChainResolvedRate: null,
  verdictConsistency: { matched: 0, disagreed: 0, total: 0, agreementShare: null },
  enrichmentCoverageVerdicts: { enriched: 0, total: 0, share: 0 },
  mostRecentSettlementBlock: '14500000',
  composition: {
    byMode: [
      { value: 'train', count: 20, share: 2 / 3 },
      { value: 'frozen', count: 10, share: 1 / 3 },
    ],
    byHarness: [
      { value: 'swe-bench', count: 25, share: 25 / 30 },
      { value: 'other', count: 5, share: 5 / 30 },
    ],
    byModel: [],
    byPlugin: [],
  },
  enrichmentCoverage: {
    enrichedAttempts: 25,
    totalAttempts: 30,
    share: 25 / 30,
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
    // Some skeleton elements should be present
    const elevated = container.querySelectorAll('[style*="var(--bg-elevated)"]');
    expect(elevated.length).toBeGreaterThan(0);
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

  it('does NOT render a top-line "Solve rate" hero (#610)', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      // Wait for data — any of the activity strip labels signals data has landed.
      expect(screen.getByText('Active operators')).toBeInTheDocument();
    });
    // The cross-SolverNet "Solve rate" KPI was a regime-mixing roll-up per
    // spec §2/§5.1 and is removed in #610.
    expect(screen.queryByText(/^solve rate$/i)).toBeNull();
    // No top-line percentage rendering — the old SolveHero showed pct(resolvedRate).
    // (We can't easily assert "no percentage anywhere" — composition HBars may
    // render shares as percentages. The text-match above is the load-bearing assertion.)
  });

  it('renders the Activity strip with operators/SolverNets/settlement', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/solvernets running/i)).toBeInTheDocument();
    expect(screen.getByText(/last settlement/i)).toBeInTheDocument();
    // everAttemptedOperators = 7 (the surviving operator-count signal)
    expect(screen.getByText('7')).toBeInTheDocument();
    // solverNetsRunning = 2
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('reads the Active operators cell from data.everAttemptedOperators', async () => {
    // Post-pivot: the "active operator" signal is everAttemptedOperators
    // (distinct operators with ≥1 on-chain attempt).
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
    });
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('does NOT render the `last 8 × 6h, ≥3 tJINN each` subtitle on the Active operators cell (issue #905)', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/last 8/i)).toBeNull();
    expect(screen.queryByText(/≥3 tJINN each/)).toBeNull();
  });

  it('renders the NETWORK COMPOSITION eyebrow on the composition card (#610)', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      // Card title is rendered uppercased by the design system's mono eyebrow
      // styling; the underlying text-content is "Network composition".
      expect(screen.getByText(/network composition/i)).toBeInTheDocument();
    });
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
      // "25 / 30 attempts enriched (...)" — both numbers may render elsewhere
      // (HBars shares), so use getAllByText for resilience.
      expect(screen.getAllByText('25').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('30').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/attempts enriched/)).toBeInTheDocument();
    });
  });

  it('has no page-level headline', async () => {
    mockFetchNetwork(NETWORK_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
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

  it('does not render the on-chain vs envelope block on this view', async () => {
    // The block now lives on the SolverNet detail view (jinn-mono-ujlu).
    const fixtureWithDisagreement: NetworkResponse = {
      ...NETWORK_FIXTURE,
      onChainVerdictsPass: 12,
      onChainResolvedRate: 0.6,
      verdictConsistency: {
        matched: 14,
        disagreed: 4,
        total: 18,
        agreementShare: 14 / 18,
      },
    };
    mockFetchNetwork(fixtureWithDisagreement);
    const { Wrapper } = makeWrapper();
    render(<NetworkView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('On-chain vs envelope')).not.toBeInTheDocument();
    expect(screen.queryByText('Envelope-truth resolved')).not.toBeInTheDocument();
    expect(screen.queryByText('Agreement')).not.toBeInTheDocument();
  });
});
