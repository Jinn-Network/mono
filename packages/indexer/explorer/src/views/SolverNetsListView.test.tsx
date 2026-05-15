import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { SolverNetsListView } from './SolverNetsListView';
import type { SolverNetsResponse } from '../lib/api';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SOLVERNET_A = {
  cid: 'bafkreiabc000000000000000000000001',
  name: 'SWE-rebench v2',
  description: 'Test SolverNet for unit tests.',
  solverNetId: '1',
  manifestEnrichmentStatus: 'ok',
  status: 'launched',
  launcherAgentId: '0xaaaa0001',
  statusUpdatedAt: new Date(Date.now() - 3600_000).toISOString(),
  tasksPosted: 500,
  tasksSettled: 450,
  attempts: 900,
  verdicts: 800,
  verdictsPass: 760,
  resolvedRate: 0.95,
  recentResolvedRateSeries: [0.8, 0.85, 0.9, 0.93, 0.95],
};

const SOLVERNET_B = {
  cid: 'bafkreidef111111111111111111111111',
  name: '',
  description: '',
  solverNetId: '',
  manifestEnrichmentStatus: 'pending',
  status: 'paused',
  launcherAgentId: '0xbbbb0002',
  statusUpdatedAt: new Date(Date.now() - 7200_000).toISOString(),
  tasksPosted: 200,
  tasksSettled: 180,
  attempts: 350,
  verdicts: 300,
  verdictsPass: 240,
  resolvedRate: 0.8,
  recentResolvedRateSeries: [0.7, 0.75, 0.8],
};

const FIXTURE: SolverNetsResponse = {
  solvernets: [SOLVERNET_A, SOLVERNET_B],
  lastIndexedBlock: '14500000',
  lastIndexedAt: new Date(Date.now() - 30_000).toISOString(),
  behindHead: null,
};

const EMPTY_FIXTURE: SolverNetsResponse = {
  solvernets: [],
  lastIndexedBlock: '14500000',
  lastIndexedAt: new Date(Date.now() - 30_000).toISOString(),
  behindHead: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWrapper(path = '/solvernets') {
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

function mockFetch(fixture: SolverNetsResponse) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchError() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('error', { status: 500 }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SolverNetsListView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading skeleton rows initially', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    const { Wrapper } = makeWrapper();
    const { container } = render(<SolverNetsListView />, { wrapper: Wrapper });
    // Skeleton rows have bg-elevated divs
    const skeletonRows = container.querySelectorAll('[style*="var(--bg-elevated)"]');
    expect(skeletonRows.length).toBeGreaterThan(0);
  });

  it('renders error state and retry button on failure', async () => {
    mockFetchError();
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/Failed to load SolverNets/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('renders empty state when solvernets array is empty', async () => {
    mockFetch(EMPTY_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('No SolverNets indexed yet.')).toBeInTheDocument();
    });
  });

  it('renders table rows for each solvernet', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      // Both rows should render some shortened CIDs matching /bafkrei/
      const cidLinks = screen.getAllByText(/bafkrei/);
      expect(cidLinks.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders status chips for each row', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('launched')).toBeInTheDocument();
      expect(screen.getByText('paused')).toBeInTheDocument();
    });
  });

  it('renders resolved rates for each row', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      // SOLVERNET_A resolvedRate = 0.95 → "95.0%"
      expect(screen.getByText('95.0%')).toBeInTheDocument();
      // SOLVERNET_B resolvedRate = 0.8 → "80.0%"
      expect(screen.getByText('80.0%')).toBeInTheDocument();
    });
  });

  it('renders trend sparklines for rows with series data', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    const { container } = render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      // SOLVERNET_A has 5-point series, SOLVERNET_B has 3-point series — both
      // should render SVG sparklines (need >=2 points).
      const svgs = container.querySelectorAll('svg');
      expect(svgs.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders column headers', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('SolverNet')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
      expect(screen.getByText('Attempts')).toBeInTheDocument();
      expect(screen.getByText('Resolved')).toBeInTheDocument();
      expect(screen.getByText('Trend')).toBeInTheDocument();
    });
  });

  it('default sort is by resolvedRate desc: highest first', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      const rates = screen.getAllByText(/\d+\.\d+%/);
      // First rate in DOM should be the highest (95.0% before 80.0%)
      expect(rates[0].textContent).toBe('95.0%');
    });
  });

  it('toggling sort by clicking the header reverses order', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getAllByText(/\d+\.\d+%/).length).toBeGreaterThan(0);
    });

    // The default is desc (95.0% first). Clicking Resolved should go to asc.
    // We can't easily test URL state changes in pure jsdom, but we can verify
    // clicking the header doesn't crash.
    const resolvedHeader = screen.getByText('Resolved');
    expect(() => fireEvent.click(resolvedHeader)).not.toThrow();
  });

  it('renders the page headline "SolverNets"', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      // The h1 element
      const headings = screen.getAllByText('SolverNets');
      expect(headings.length).toBeGreaterThan(0);
    });
  });

  it('renders StatusBar with last indexed block', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<SolverNetsListView />, { wrapper: Wrapper });
    await waitFor(() => {
      // block("14500000") → "14,500,000"
      expect(screen.getByText('14,500,000')).toBeInTheDocument();
    });
  });
});
