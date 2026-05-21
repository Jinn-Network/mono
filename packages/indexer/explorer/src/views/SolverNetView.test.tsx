import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Switch, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { SolverNetView } from './SolverNetView';
import type { SolverNetResponse } from '../lib/api';

// ── Fixture ───────────────────────────────────────────────────────────────────

const CID = 'bafkreiabc000000000000000000000001';

const FIXTURE: SolverNetResponse = {
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
  learningCurveBuckets: [
    { bucketStartBlock: '1000000', total: 20, pass: 15, rate: 0.75 },
    { bucketStartBlock: '1007200', total: 25, pass: 22, rate: 0.88 },
  ],
  learningCurveRolling: [0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
  trainBoard: {
    ranked: [
      {
        rank: 1,
        operator: '0xaaaa000000000000000a',
        attempts: 200,
        settledContribution: 180,
        verdictsTotal: 180,
        verdictsPass: 171,
        resolvedRate: 0.95,
        jinnEarned: '1000000000000000000',
      },
    ],
    lowVolume: [
      {
        operator: '0xbbbb000000000000000b',
        attempts: 5,
        settledContribution: 4,
        verdictsTotal: 4,
        verdictsPass: 3,
        resolvedRate: 0.75,
        jinnEarned: '10000000000000000',
      },
    ],
  },
  frozenBoard: {
    ranked: [],
    lowVolume: [],
  },
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

function mockFetch(fixture: SolverNetResponse) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchError() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error: 'unknown solvernet' }), {
      status: 404,
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SolverNetView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading skeleton initially', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    const { WrappedView } = makeWrapper();
    const { container } = render(<WrappedView />);
    // Skeleton blocks are rendered
    const skeletons = container.querySelectorAll(
      '[style*="var(--bg-elevated)"]',
    );
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders unknown-cid error state and back link', async () => {
    mockFetchError();
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
    mockFetch(FIXTURE);
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
    mockFetch(FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText(/verdict-success rate/i)).toBeInTheDocument();
    });
  });

  it('renders the status chip', async () => {
    mockFetch(FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('launched')).toBeInTheDocument();
    });
  });

  it('renders supporting KPI values', async () => {
    mockFetch(FIXTURE);
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
    mockFetch(FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('Learning curve')).toBeInTheDocument();
    });
  });

  it('renders the LearningCurve component (plot container or empty state)', async () => {
    mockFetch(FIXTURE);
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
    mockFetch(FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('Checkpoint timeline')).toBeInTheDocument();
      expect(screen.getByText('Last published checkpoint.')).toBeInTheDocument();
    });
  });

  it('renders freeze integrity card', async () => {
    mockFetch(FIXTURE);
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
    mockFetch(FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('Leaderboards')).toBeInTheDocument();
    });
    // Train board toggle visible
    expect(screen.getByText('Train')).toBeInTheDocument();
    expect(screen.getByText('Frozen')).toBeInTheDocument();
  });

  it('renders train board ranked rows via the Leaderboard component', async () => {
    mockFetch(FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // The ranked operator is 0xaaaa000... → shortAddr → "0xaaaa…000a"
      expect(screen.getByText('0xaaaa…000a')).toBeInTheDocument();
    });
  });

  it('renders low-volume section separator via the Leaderboard component', async () => {
    mockFetch(FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // Leaderboard renders the low-volume label
      expect(screen.getByText('New / Low-volume')).toBeInTheDocument();
    });
  });

  it('renders frozenBoard data when board=frozen is in the URL', async () => {
    // Give the frozen board a row so we can assert it renders when board=frozen is pre-set
    const fixtureWithFrozen = {
      ...FIXTURE,
      frozenBoard: {
        ranked: [
          {
            rank: 1,
            operator: '0xffff000000000000ffff',
            attempts: 10,
            settledContribution: 8,
            verdictsTotal: 8,
            verdictsPass: 7,
            resolvedRate: 0.875,
            jinnEarned: '0',
          },
        ],
        lowVolume: [],
      },
    };
    mockFetch(fixtureWithFrozen);
    // Load the page with board=frozen pre-set in the URL
    const { WrappedView } = makeWrapper(`/solvernet/${encodeURIComponent(CID)}?board=frozen`);
    render(<WrappedView />);

    await waitFor(() => {
      // The frozen operator should now be visible
      expect(screen.getByText('0xffff…ffff')).toBeInTheDocument();
    });
    // The train operator should NOT be visible
    expect(screen.queryByText('0xaaaa…000a')).not.toBeInTheDocument();
  });

  it('renders null resolvedRate as "—"', async () => {
    const fixture = { ...FIXTURE, resolvedRate: null };
    mockFetch(fixture);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // The big headline should show "—"
      expect(screen.getByLabelText(/Resolved rate: —/)).toBeInTheDocument();
    });
  });

  it('renders the breadcrumb link back to /solvernets', async () => {
    mockFetch(FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('SolverNets')).toBeInTheDocument();
    });
  });
});
