import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Switch, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { SolverNetView } from './SolverNetView';
import { useSlice, useSolverNet } from '../lib/api';
import { MILESTONE2_MANIFEST_CID } from '../lib/milestone2';

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
      },
    ],
    frozen: [
      {
        operator: '0xffff000000000000ffff',
        attempts: 10,
        verdictsTotal: 8,
        verdictsPass: 7,
        resolvedRate: 0.875,
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
        heldOutDelta: null,
        verifiedFrozen: true,
      },
    ],
    note: 'Last published checkpoint.',
  },
  heldOutSlateVersion: 'v1',
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

function makeWrapper(
  path = `/solvernet/${encodeURIComponent(CID)}`,
  opts: { static?: boolean } = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const isStatic = opts.static ?? true;
  const { hook } = memoryLocation({ path, static: isStatic });

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

  it('does not render an "Explore this slice" link', async () => {
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?k=50`,
    );
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('Learning curve')).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('link', { name: /explore this slice/i }),
    ).not.toBeInTheDocument();
  });
});

// ─── Slice control surface (spec §3 progressive-disclosure chrome) ───────────

describe('SolverNetView — slice control surface', () => {
  it('exposes the Group by dropdown trigger above the chart', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // The GroupByDropdown trigger reads "Group by: none ▾".
      expect(
        screen.getByRole('button', { name: /^group by: none$/i }),
      ).toBeInTheDocument();
    });
  });

  it('renders the WINDOW SegmentedControl with 20 / 30 / 50 / 100 / ALL options', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // The WINDOW selector now lives inline next to the chart caption.
      expect(screen.getByText(/^window$/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '20' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '50' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '100' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ALL' })).toBeInTheDocument();
  });

  it('opens the Raw toggle inside the ⚙ settings popover', async () => {
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // The ⚙ Slice settings trigger is the entry point.
      expect(
        screen.getByRole('button', { name: /slice settings/i }),
      ).toBeInTheDocument();
    });
    // Raw is hidden until the popover opens.
    expect(
      screen.queryByRole('switch', { name: /include raw data/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /slice settings/i }));
    expect(
      screen.getByRole('switch', { name: /include raw data/i }),
    ).toBeInTheDocument();
  });

  it('calls useSlice with group=harness when URL has ?group=harness', async () => {
    vi.mocked(useSlice).mockClear();
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?group=harness`,
    );
    render(<WrappedView />);
    await waitFor(() => {
      expect(useSlice).toHaveBeenCalled();
    });
    const calls = vi.mocked(useSlice).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0];
    expect(lastCall?.group).toBe('harness');
  });

  it('renders the FilterChipStrip with filter[harness]=codex from the URL', async () => {
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?filter[harness]=codex`,
    );
    render(<WrappedView />);
    await waitFor(() => {
      // The new chip strip is a labeled region (no longer a testid-anchored
      // div). Issue #687 deleted the legacy ActiveSliceChips duplicate.
      const chips = screen.getByRole('region', { name: 'Active filters' });
      expect(chips).toHaveTextContent(/harness:codex/i);
    });
  });

  it('does NOT render the legacy ActiveSliceChips strip below the new FilterChipStrip (#687)', async () => {
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?filter[harness]=codex&window=30`,
    );
    render(<WrappedView />);
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: 'Active filters' }),
      ).toBeInTheDocument();
    });
    // Regression guard for #687 bug 1: the static legacy strip from PR #676
    // must not coexist with the new dismissible chip strip.
    expect(screen.queryByTestId('active-slice-chips')).toBeNull();
  });

  it('migrates legacy ?k=30 to ?window=30 on mount (back-compat)', async () => {
    vi.mocked(useSlice).mockClear();
    // Use k=30 (not the default 50) and static:false so setSearchParams
    // actually mutates URL state — otherwise the migration is a no-op and
    // the assertion would pass coincidentally.
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?k=30`,
      { static: false },
    );
    render(<WrappedView />);
    await waitFor(() => {
      // The WINDOW SegmentedControl should select 30 (matching the legacy k)
      expect(screen.getByRole('button', { name: '30' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });
});

// ─── KPI hero uses aggregate kpis.resolvedRate (bug 6.2) ─────────────────────

describe('SolverNetView — KPI hero uses aggregate kpis.resolvedRate (bug 6.2)', () => {
  it('shows aggregate rate (slice.kpis.resolvedRate) when group !== none', async () => {
    // Spec §6.2: visiting /solvernet/<cid>?group=harness must show the gold
    // KPI hero as the slice's aggregate resolvedRate (63.5%) — NOT the first
    // series' resolvedRate (70.0%) and NOT a buggy per-bucket sample (2.6%).
    // Series array shapes the chart; the headline reflects the slice as a whole.
    const groupedSlice = {
      ...SLICE_DATA,
      params: { ...SLICE_DATA.params, group: 'harness' as const },
      kpis: {
        attempts: 500,
        verdicts: 400,
        verdictsPass: 254,
        resolvedRate: 0.635, // aggregate — the headline MUST be 63.5%
      },
      series: [
        {
          groupValue: 'codex',
          buckets: [],
          rolling: [0.7],
          kpis: {
            attempts: 200,
            verdicts: 150,
            verdictsPass: 105,
            resolvedRate: 0.7, // distractor — NOT the headline
          },
        },
        {
          groupValue: 'hermes-agent',
          buckets: [],
          rolling: [0.4],
          kpis: {
            attempts: 150,
            verdicts: 130,
            verdictsPass: 52,
            resolvedRate: 0.4,
          },
        },
        {
          groupValue: '(unknown)',
          buckets: [],
          rolling: [0.74],
          kpis: {
            attempts: 150,
            verdicts: 120,
            verdictsPass: 89,
            resolvedRate: 0.74,
          },
        },
      ],
    };
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: groupedSlice,
    } as any);

    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?group=harness`,
    );
    render(<WrappedView />);

    await waitFor(() => {
      expect(screen.getByTestId('kpi-hero-resolved-rate')).toBeInTheDocument();
    });

    const hero = screen.getByTestId('kpi-hero-resolved-rate');
    // The aria-label uses the un-animated value directly (pct of
    // slice.kpis.resolvedRate), making it the stable readout.
    expect(hero).toHaveAttribute('aria-label', 'Resolved rate: 63.5%');
    // And it must NOT be series[0]'s rate.
    expect(hero).not.toHaveAttribute('aria-label', 'Resolved rate: 70.0%');
  });
});

// ─── Chart legend → filter ───────────────────────────────────────────────────

describe('SolverNetView — chart legend click adds filter', () => {
  it('clicking a legend value (group=harness) appends filter[harness]=<value>', async () => {
    // group=harness multi-series fixture
    const multiSeriesSlice = {
      ...SLICE_DATA,
      params: { ...SLICE_DATA.params, group: 'harness' as const },
      series: [
        {
          groupValue: 'codex',
          buckets: [],
          rolling: SLICE_DATA.series[0]!.rolling,
          kpis: SLICE_DATA.series[0]!.kpis,
        },
        {
          groupValue: 'claude',
          buckets: [],
          rolling: SLICE_DATA.series[0]!.rolling,
          kpis: SLICE_DATA.series[0]!.kpis,
        },
      ],
    };
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: multiSeriesSlice,
    } as any);

    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?group=harness`,
      { static: false },
    );
    render(<WrappedView />);

    await waitFor(() => {
      expect(screen.getByTestId('learning-curve-legend')).toBeInTheDocument();
    });
    // Find the legend button for 'codex'. The button contains a "→ filter to
    // this" hover-hint sibling span (Task 7), so match by partial text rather
    // than exact equality.
    const legend = screen.getByTestId('learning-curve-legend');
    const codexBtn = Array.from(legend.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('codex'),
    );
    expect(codexBtn).toBeDefined();
    fireEvent.click(codexBtn!);

    // After the click the FilterChipStrip should show harness:codex.
    await waitFor(() => {
      const chips = screen.getByRole('region', { name: 'Active filters' });
      expect(chips).toHaveTextContent(/harness:codex/i);
    });
  });
});

// ─── Degenerate filter+group auto-clear (bug 6.1) ────────────────────────────

describe('SolverNetView — degenerate filter+group auto-clears group (bug 6.1)', () => {
  it('drops group=<dim> from URL when filter[<dim>] is set for the same dim', async () => {
    // Spec §6.1: when group=harness AND filter[harness]=codex are both in the
    // URL, the resulting slice has exactly one series — equivalent to what
    // group=none would yield. The chart panel previously rendered "No data
    // yet" despite KPIs reading real verdicts. Fix option (b): auto-clear the
    // redundant group on mount.
    vi.mocked(useSlice).mockClear();
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?group=harness&filter[harness]=codex`,
      { static: false },
    );
    render(<WrappedView />);

    // After the auto-clear effect fires, useSlice should be called with
    // group: 'none' (not 'harness'). filter[harness]=['codex'] stays put.
    await waitFor(() => {
      const calls = vi.mocked(useSlice).mock.calls;
      const lastCall = calls[calls.length - 1]?.[0];
      expect(lastCall?.group).toBe('none');
      expect(lastCall?.filter).toEqual({ harness: ['codex'] });
    });
  });
});

// ─── New filter chrome (spec §3) ─────────────────────────────────────────────

describe('SolverNetView — new filter chrome (spec §3)', () => {
  it('renders PersistentControlsRow when no filters are active', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: SLICE_DATA,
    } as any);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      // The + filter chip is the persistent affordance.
      expect(
        screen.getByRole('button', { name: /^add filter$/i }),
      ).toBeInTheDocument();
    });
    // Group by: none ▾ dropdown trigger visible.
    expect(
      screen.getByRole('button', { name: /^group by: none$/i }),
    ).toBeInTheDocument();
    // FilterChipStrip region MUST NOT render when no filters are active.
    expect(
      screen.queryByRole('region', { name: /active filters/i }),
    ).not.toBeInTheDocument();
  });

  it('renders FilterChipStrip + inline GroupByDropdown when filters are active', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: SLICE_DATA,
    } as any);
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(
        CID,
      )}?filter[harness]=codex&filter[model]=gpt-5.4-mini`,
    );
    render(<WrappedView />);
    await waitFor(() => {
      const region = screen.getByRole('region', { name: /active filters/i });
      expect(region).toHaveTextContent(/harness:codex/i);
      expect(region).toHaveTextContent(/model:gpt-5\.4-mini/i);
    });
    // Group by dropdown is still rendered alongside the chip strip.
    expect(
      screen.getByRole('button', { name: /^group by: /i }),
    ).toBeInTheDocument();
  });

  it('removes a filter when its × is clicked', async () => {
    vi.mocked(useSlice).mockClear();
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(CID)}?filter[harness]=codex`,
      { static: false },
    );
    render(<WrappedView />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /remove harness=codex/i }),
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole('button', { name: /remove harness=codex/i }),
    );
    // After removal, useSlice should be called with empty filter set.
    await waitFor(() => {
      const calls = vi.mocked(useSlice).mock.calls;
      const lastCall = calls[calls.length - 1]?.[0];
      expect(lastCall?.filter).toEqual({});
    });
  });

  it('does NOT render the legacy ExploreControls section labels (GROUP BY, FILTERS)', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: SLICE_DATA,
    } as any);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      expect(screen.getByText('Learning curve')).toBeInTheDocument();
    });
    // The legacy "GROUP BY" and "FILTERS" section labels must not render as
    // standalone caps-mono labels. The WINDOW chart-caption inline selector is
    // allowed; that label still lives alongside the chart.
    expect(screen.queryByText(/^group by$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^filters$/i)).not.toBeInTheDocument();
  });
});

// ─── Leaderboard row click → filter ──────────────────────────────────────────

describe('SolverNetView — leaderboard row click adds filter[operator]', () => {
  it('clicking the operator body appends filter[operator]=<addr> to chip strip', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: SLICE_DATA,
    } as any);
    const { WrappedView } = makeWrapper(undefined, { static: false });
    render(<WrappedView />);
    await waitFor(() => {
      // Train operator address rendered short
      expect(screen.getByText('0xaaaa…000a')).toBeInTheDocument();
    });
    const opBtn = screen.getByRole('button', { name: /0xaaaa…000a/i });
    fireEvent.click(opBtn);
    await waitFor(() => {
      const chips = screen.getByRole('region', { name: 'Active filters' });
      expect(chips).toHaveTextContent(/operator:0xaaaa/i);
    });
  });

  it('renders a trailing arrow link with href=/operator/<addr>', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: SLICE_DATA,
    } as any);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      const arrowLink = screen.getByRole('link', {
        name: /open operator detail/i,
      });
      expect(arrowLink).toHaveAttribute(
        'href',
        `/operator/${encodeURIComponent('0xaaaa000000000000000a')}`,
      );
    });
  });
});

// ─── Cold-landing `+ filter` lookup (bug 2, #687) ─────────────────────────────

describe('SolverNetView — + filter surfaces values on cold landing (#687 bug 2)', () => {
  it('fires a lookup slice and renders values when a dim is picked at cold landing', async () => {
    vi.mocked(useSlice).mockClear();
    // Mock: primary slice (group=none) returns the default SLICE_DATA. Lookup
    // slice (group=harness) returns multi-series data with distinct harness
    // values. Without the fix, AddFilterPopover would render "No values to
    // filter by" because availableValues was empty for ungrouped dims.
    const harnessLookup = {
      ...SLICE_DATA,
      params: { ...SLICE_DATA.params, group: 'harness' as const },
      series: [
        { ...SLICE_DATA.series[0], groupValue: 'codex' },
        { ...SLICE_DATA.series[0], groupValue: 'hermes-agent' },
      ],
    };
    vi.mocked(useSlice).mockImplementation((params: any) => {
      if (params.group === 'harness') {
        return {
          isLoading: false,
          isError: false,
          error: null,
          data: harnessLookup,
        } as any;
      }
      return {
        isLoading: false,
        isError: false,
        error: null,
        data: SLICE_DATA,
      } as any;
    });

    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    // Cold landing: only the persistent `+ filter` chip + group dropdown.
    const addFilterBtn = await screen.findByRole('button', {
      name: /^Add filter$/i,
    });
    fireEvent.click(addFilterBtn);
    // Popover opens — pick harness.
    const dialog = screen.getByRole('dialog', { name: /Add filter/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'harness' }));

    // Lookup slice fires (mock returns immediately), values render.
    await waitFor(() => {
      expect(
        within(dialog).getByRole('button', { name: 'codex' }),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole('button', { name: 'hermes-agent' }),
      ).toBeInTheDocument();
    });
    // No "No values to filter by" empty state.
    expect(
      within(dialog).queryByText(/No values to filter by/i),
    ).toBeNull();

    // Lookup useSlice call: confirm the second invocation used group: 'harness'.
    const calls = vi.mocked(useSlice).mock.calls;
    const lookupCall = calls.find((c: any[]) => c[0]?.group === 'harness');
    expect(lookupCall).toBeDefined();
    expect((lookupCall![1] as any)?.enabled).toBe(true);
  });

  it('renders a loading state while the lookup slice is pending', async () => {
    vi.mocked(useSlice).mockClear();
    vi.mocked(useSlice).mockImplementation((params: any) => {
      if (params.group === 'harness') {
        return {
          isLoading: true,
          isError: false,
          error: null,
          data: undefined,
        } as any;
      }
      return {
        isLoading: false,
        isError: false,
        error: null,
        data: SLICE_DATA,
      } as any;
    });

    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    fireEvent.click(
      await screen.findByRole('button', { name: /^Add filter$/i }),
    );
    const dialog = screen.getByRole('dialog', { name: /Add filter/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'harness' }));

    expect(
      within(dialog).getByRole('status', { name: /Loading values/i }),
    ).toBeInTheDocument();
    // The "no values" empty state does NOT show while loading.
    expect(
      within(dialog).queryByText(/No values to filter by/i),
    ).toBeNull();
  });
});

// ── Milestone 2 gate card (#647) ──────────────────────────────────────────────

describe('SolverNetView — Milestone 2 gate card', () => {
  // A passing M2 slice: 140 verdicts, trailing-30 = 0.70 now vs 0.50 at t-99.
  function m2PassingSlice() {
    const rolling = new Array(140).fill(0.42);
    rolling[40] = 0.5; // t-99 baseline (index n-100)
    rolling[139] = 0.7; // current (index n-1)
    return {
      isLoading: false,
      isError: false,
      error: null,
      data: {
        ...SLICE_DATA,
        kpis: { ...SLICE_DATA.kpis, verdicts: 140 },
        series: [{ ...SLICE_DATA.series[0], rolling, kpis: { ...SLICE_DATA.series[0].kpis, verdicts: 140 } }],
      },
    };
  }

  it('renders the gate card with PASS on the Milestone 2 SolverNet', async () => {
    vi.mocked(useSlice).mockReturnValue(m2PassingSlice() as any);
    const { WrappedView } = makeWrapper(
      `/solvernet/${encodeURIComponent(MILESTONE2_MANIFEST_CID)}`,
    );
    render(<WrappedView />);
    expect(
      await screen.findByText(/Milestone 2 — solvers improving/i),
    ).toBeInTheDocument();
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(screen.getAllByText(/\+20\.0pp/).length).toBeGreaterThan(0);
  });

  it('does not render the gate card on a non-Milestone-2 SolverNet', async () => {
    vi.mocked(useSlice).mockReturnValue(m2PassingSlice() as any);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await screen.findByTestId('kpi-hero-resolved-rate');
    expect(screen.queryByText(/Milestone 2 — solvers improving/i)).toBeNull();
  });
});
