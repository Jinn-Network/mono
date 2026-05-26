import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Switch, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { SolverNetView } from './SolverNetView';
import { useSlice, useSolverNet } from '../lib/api';

// ── Fixtures (dual-hook: SliceResponse + SolverNetResponse) ──────────────────

const CID = 'bafkreiabc000000000000000000000001';

const SLICE_DATA = {
  params: {
    manifestDigest: CID,
    group: 'none' as const,
    filter: {},
    includeUnenriched: false,
    bucket: 'auto' as const,
  },
  enrichmentCoverage: 1,
  kpis: {
    attempts: 900,
    verdicts: 800,
    verdictsPass: 760,
    resolvedRate: 0.95,
    jinnEarned: '0',
  },
  series: [
    {
      groupValue: null,
      buckets: [
        { bucketStartBlock: '1000000', total: 20, pass: 15, rate: 0.75 },
        { bucketStartBlock: '1007200', total: 25, pass: 22, rate: 0.88 },
      ],
      rolling: [0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
      kpis: {
        attempts: 900,
        verdicts: 800,
        verdictsPass: 760,
        resolvedRate: 0.95,
        jinnEarned: '0',
      },
    },
  ],
  leaderboard: {
    train: [
      {
        operator: '0xaaaa000000000000000a',
        attempts: 200,
        verdictsTotal: 180,
        verdictsPass: 171,
        resolvedRate: 0.95,
        jinnEarned: '1000000000000000000',
      },
    ],
    frozen: [
      {
        operator: '0xffff000000000000ffff',
        attempts: 10,
        verdictsTotal: 8,
        verdictsPass: 7,
        resolvedRate: 0.875,
        jinnEarned: '0',
      },
    ],
  },
  lastIndexedBlock: '14500000',
  lastIndexedAt: new Date(Date.now() - 30_000).toISOString(),
  behindHead: null,
};

const SOLVERNET_META = {
  cid: CID,
  name: 'SWE-rebench v2',
  description: 'Test fixture description.',
  solverNetId: '1',
  manifestEnrichmentStatus: 'ok',
  status: 'launched',
  launcherAgentId: '0xdeadbeefdeadbeef0001',
  tasksPosted: 500,
  tasksSettled: 450,
  attempts: 900,
  verdicts: 800,
  verdictsPass: 760,
  resolvedRate: 0.95,
  learningCurveBuckets: [],
  learningCurveRolling: [],
  trainBoard: { ranked: [], lowVolume: [] },
  frozenBoard: { ranked: [], lowVolume: [] },
  checkpointTimeline: {
    checkpoints: [
      {
        cid: 'bafkreicheckpoint11111111111111111',
        agentId: '0xdeadbeef00000000aabb',
        publishedAtBlock: '1000000',
        name: 'claude-code-learner',
        version: '1.0.0',
        codeDigest: 'sha256:' + 'ab'.repeat(32),
        parentCheckpointCid: null,
        implName: 'claude-code-learner',
        implVersion: '1.0.0',
        sourceBundleCid: 'bafyreidummysourcebundle',
        enrichmentStatus: 'ok',
        frozenResolvedRate: 0.9,
        verifiedFrozen: true,
      },
    ],
    note: 'Last published checkpoint.',
  },
  freezeIntegrity: {
    violations: [],
    verifiedFrozenShare: 1.0,
    frozenAttempts: 50,
  },
  lastIndexedBlock: '14500000',
  lastIndexedAt: new Date(Date.now() - 30_000).toISOString(),
  behindHead: null,
};

vi.mock('../lib/api', () => ({
  useSlice: vi.fn(() => ({
    isLoading: false,
    isError: false,
    error: null,
    data: SLICE_DATA,
  })),
  useSolverNet: vi.fn(() => ({
    isLoading: false,
    isError: false,
    error: null,
    data: SOLVERNET_META,
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWrapper(path = `/solvernet/${encodeURIComponent(CID)}`) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const { hook } = memoryLocation({ path, static: true });

  // Render SolverNetView inside a Switch+Route so useParams gets the :cid param.
  function WrappedView() {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>
          <Switch>
            <Route path="/solvernet/:cid" component={SolverNetView} />
          </Switch>
        </Router>
      </QueryClientProvider>
    );
  }

  return { WrappedView, qc };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SolverNetView', () => {
  it('renders loading skeleton initially', () => {
    vi.mocked(useSlice).mockReturnValueOnce({
      isLoading: true,
      isError: false,
      error: null,
      data: undefined,
    } as any);
    vi.mocked(useSolverNet).mockReturnValueOnce({
      isLoading: true,
      isError: false,
      error: null,
      data: undefined,
    } as any);
    const { WrappedView } = makeWrapper();
    const { container } = render(<WrappedView />);
    // Skeleton blocks are rendered
    const skeletons = container.querySelectorAll(
      '[style*="var(--bg-elevated)"]',
    );
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders unknown-cid error state and back link', async () => {
    vi.mocked(useSlice).mockReturnValueOnce({
      isLoading: false,
      isError: true,
      error: new Error('unknown'),
      data: undefined,
    } as any);
    vi.mocked(useSolverNet).mockReturnValueOnce({
      isLoading: false,
      isError: true,
      error: new Error('unknown'),
      data: undefined,
    } as any);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(
        screen.getByText(/Unknown SolverNet or failed to load/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Back to SolverNets list')).toBeInTheDocument();
  });

  it('renders the gold headline resolved-rate', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // resolvedRate = 0.95 → "95.0%"
      // The headline is the aria-labelled element; use getByLabelText for exactness
      expect(screen.getByLabelText('Resolved rate: 95.0%')).toBeInTheDocument();
    });
    // It should be rendered in the display font gold color
    const rateEl = screen.getByLabelText('Resolved rate: 95.0%');
    expect(rateEl.style.color).toContain('accent-gold');
  });

  it('renders "VERDICT-SUCCESS RATE" label', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText(/verdict-success rate/i)).toBeInTheDocument();
    });
  });

  it('renders the status chip', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('launched')).toBeInTheDocument();
    });
  });

  it('renders supporting KPI values', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // tasksPosted = 500
      expect(screen.getAllByText('500').length).toBeGreaterThan(0);
      // verdicts = 800
      expect(screen.getByText('800')).toBeInTheDocument();
    });
  });

  it('renders the learning curve card', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('Learning curve')).toBeInTheDocument();
    });
  });

  it('renders the LearningCurve component (plot container or empty state)', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // The component renders either the plot container or empty-state
      const plotEl = document.querySelector('[data-testid="learning-curve-plot"]');
      const emptyEl = screen.queryByText('No data yet');
      expect(plotEl || emptyEl).toBeTruthy();
    });
  });

  it('renders checkpoint timeline card', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('Checkpoint timeline')).toBeInTheDocument();
      expect(screen.getByText('Last published checkpoint.')).toBeInTheDocument();
    });
  });

  it('renders freeze integrity card', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('Freeze integrity')).toBeInTheDocument();
      expect(
        screen.getByText('No freeze violations recorded.'),
      ).toBeInTheDocument();
    });
  });

  it('renders the leaderboards card with board toggle', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('Leaderboards')).toBeInTheDocument();
    });
    // Train board toggle visible
    expect(screen.getByText('Train')).toBeInTheDocument();
    expect(screen.getByText('Frozen')).toBeInTheDocument();
  });

  it('renders train board rows via the Leaderboard component', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // The train operator is 0xaaaa000... → shortAddr → "0xaaaa…000a"
      expect(screen.getByText('0xaaaa…000a')).toBeInTheDocument();
    });
  });

  it('renders frozenBoard data when board=frozen is in the URL', async () => {
    // Load the page with board=frozen pre-set in the URL
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?board=frozen`,
    );
    render(<WrappedView />);

    await waitFor(() => {
      // The frozen operator should now be visible (from SLICE_DATA.leaderboard.frozen)
      expect(screen.getByText('0xffff…ffff')).toBeInTheDocument();
    });
    // The train operator should NOT be visible
    expect(screen.queryByText('0xaaaa…000a')).not.toBeInTheDocument();
  });

  it('renders null resolvedRate as "—"', async () => {
    vi.mocked(useSolverNet).mockReturnValueOnce({
      isLoading: false,
      isError: false,
      error: null,
      data: { ...SOLVERNET_META, resolvedRate: null },
    } as any);
    vi.mocked(useSlice).mockReturnValueOnce({
      isLoading: false,
      isError: false,
      error: null,
      data: { ...SLICE_DATA, kpis: { ...SLICE_DATA.kpis, resolvedRate: null } },
    } as any);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // The big headline should show "—"
      expect(screen.getByLabelText(/Resolved rate: —/)).toBeInTheDocument();
    });
  });

  it('renders the breadcrumb link back to /solvernets', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('SolverNets')).toBeInTheDocument();
    });
  });
});
