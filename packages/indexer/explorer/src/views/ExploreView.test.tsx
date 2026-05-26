import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Switch, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ExploreView } from './ExploreView';
import { useSlice, useSolverNet } from '../lib/api';

const CID = 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi';

// Long-enough rolling array (>= 130) so the milestone hairline renders.
const LONG_ROLLING = Array.from({ length: 200 }, (_, i) => 0.5 + i * 0.001);
const SHORT_ROLLING = [0.1, 0.2, 0.3];

function sliceFixture(rolling: number[], opts: {
  series?: { groupValue: string | null; rolling: number[] }[];
  group?: string;
} = {}) {
  const series = opts.series ?? [{ groupValue: null, rolling }];
  return {
    params: {
      manifestDigest: CID,
      group: opts.group ?? 'none',
      filter: { harness: ['codex'], model: ['gpt-5.4-mini'] },
      includeUnenriched: false,
      bucket: 'auto' as const,
      window: 30,
    },
    enrichmentCoverage: 0.92,
    kpis: {
      attempts: rolling.length,
      verdicts: rolling.length,
      verdictsPass: Math.round(rolling.length * 0.6),
      resolvedRate: 0.6,
      jinnEarned: '0',
    },
    series: series.map((s) => ({
      groupValue: s.groupValue,
      buckets: [],
      rolling: s.rolling,
      kpis: {
        attempts: s.rolling.length,
        verdicts: s.rolling.length,
        verdictsPass: Math.round(s.rolling.length * 0.6),
        resolvedRate: 0.6,
        jinnEarned: '0',
      },
    })),
    leaderboard: { train: [], frozen: [] },
    lastIndexedBlock: '14500000',
    lastIndexedAt: new Date().toISOString(),
    behindHead: null,
  };
}

const SOLVERNET_META = {
  cid: CID,
  name: 'SWE-rebench v2',
  description: '',
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
  checkpointTimeline: { checkpoints: [], note: '' },
  freezeIntegrity: { violations: [], verifiedFrozenShare: 1.0, frozenAttempts: 50 },
  lastIndexedBlock: '14500000',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    useSlice: vi.fn(),
    useSolverNet: vi.fn(),
  };
});

function makeWrapper(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const { hook } = memoryLocation({ path, static: false });
  return function Wrap() {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>
          <Switch>
            <Route path="/explore/:cid" component={ExploreView} />
          </Switch>
        </Router>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.mocked(useSolverNet).mockReturnValue({
    isLoading: false,
    isError: false,
    error: null,
    data: SOLVERNET_META,
  } as unknown as ReturnType<typeof useSolverNet>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExploreView — locked-config milestone URL', () => {
  it('renders the SolverNet name in the Instrument Serif header', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(LONG_ROLLING),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(
      `/explore/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&group=none`,
    );
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/explore swe-rebench v2/i)).toBeInTheDocument();
    });
  });

  it('renders active-slice chips for harness=codex and model=gpt-5.4-mini', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(LONG_ROLLING),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(
      `/explore/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&group=none`,
    );
    render(<Wrap />);
    await waitFor(() => {
      const chips = screen.getByTestId('active-slice-chips');
      expect(chips).toHaveTextContent(/harness:codex/i);
      expect(chips).toHaveTextContent(/model:gpt-5\.4-mini/i);
    });
  });

  it('renders exactly 1 series when group=none', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(LONG_ROLLING),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(
      `/explore/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&group=none`,
    );
    render(<Wrap />);
    const plot = await screen.findByTestId('learning-curve-plot');
    expect(plot).toBeInTheDocument();
    // And — crucially — no multi-series legend. The legend is rendered by
    // LearningCurve only when `series` has 2+ entries. A regression where
    // group=none accidentally flips into multi-series mode would surface
    // here.
    expect(screen.queryByTestId('learning-curve-legend')).not.toBeInTheDocument();
  });

  it('renders the t-99 hairline label when rolling has >= 130 entries', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(LONG_ROLLING),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(
      `/explore/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&group=none&window=30`,
    );
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/t − 99|t - 99/)).toBeInTheDocument();
    });
  });

  it('renders the below-floor empty state when rolling has < 130 entries', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(SHORT_ROLLING),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(
      `/explore/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&group=none`,
    );
    render(<Wrap />);
    await waitFor(() => {
      expect(
        screen.getByText(/need 130 envelope-enriched verdicts.*have 3/i),
      ).toBeInTheDocument();
    });
  });

  it('preselects window=30 when the URL has window=30', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(LONG_ROLLING),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(`/explore/${CID}?window=30`);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '30' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  it('preselects window=30 by default (no `window` in URL)', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(LONG_ROLLING),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(`/explore/${CID}`);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '30' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  it('preselects window=50 when the URL has window=50', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(LONG_ROLLING),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(`/explore/${CID}?window=50`);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '50' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });
});

describe('ExploreView — group=operator multi-series', () => {
  it('shows a legend entry per series when group=operator with 3 series', async () => {
    const threeSeries = [
      { groupValue: '0xaaa', rolling: LONG_ROLLING },
      { groupValue: '0xbbb', rolling: LONG_ROLLING },
      { groupValue: '0xccc', rolling: LONG_ROLLING },
    ];
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(LONG_ROLLING, { series: threeSeries, group: 'operator' }),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(`/explore/${CID}?group=operator`);
    render(<Wrap />);
    await waitFor(() => {
      const legend = screen.getByTestId('learning-curve-legend');
      expect(legend).toHaveTextContent('0xaaa');
      expect(legend).toHaveTextContent('0xbbb');
      expect(legend).toHaveTextContent('0xccc');
    });
  });
});

describe('ExploreView — interaction', () => {
  it('passes filter chips through; clicking the X strips a filter from the URL', async () => {
    vi.mocked(useSlice).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: sliceFixture(LONG_ROLLING),
    } as unknown as ReturnType<typeof useSlice>);
    const Wrap = makeWrapper(
      `/explore/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini`,
    );
    render(<Wrap />);
    await waitFor(() => {
      const chips = screen.getByTestId('active-slice-chips');
      expect(chips).toHaveTextContent(/harness:codex/i);
    });
    const removeHarness = screen.getByRole('button', { name: /remove harness=codex/i });
    fireEvent.click(removeHarness);
    // After click the pill is gone (slice query rerenders with the new filter set).
    await waitFor(() => {
      // chips strip still shows model:gpt-5.4-mini but not harness:codex
      // (the active-slice chips strip is the canonical surface)
      const chips = screen.getByTestId('active-slice-chips');
      expect(chips).not.toHaveTextContent(/harness:codex/i);
    });
  });
});
