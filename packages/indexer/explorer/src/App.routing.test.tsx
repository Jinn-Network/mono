/**
 * App routing tests — verifies that each route mounts the correct view.
 *
 * Uses wouter's memoryLocation to navigate without a real browser URL bar.
 * All API calls are mocked with minimal fixtures so hooks resolve cleanly.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { App } from './App';
import type { NetworkResponse, OperatorsResponse, OperatorResponse, SolverNetsResponse, SolverNetResponse } from './lib/api';

// ── Minimal fixtures ──────────────────────────────────────────────────────────

const NETWORK_FIXTURE: NetworkResponse = {
  tasksPosted: 5,
  tasksSettled: 4,
  tasksRefunded: 0,
  attempts: 10,
  distinctOperators: 1,
  solverNetsRunning: 1,
  verdicts: 8,
  verdictsPass: 7,
  resolvedRate: 0.875,
  onChainVerdictsPass: 0,
  onChainResolvedRate: null,
  verdictConsistency: { matched: 0, disagreed: 0, total: 0, agreementShare: null },
  enrichmentCoverageVerdicts: { enriched: 0, total: 0, share: 0 },
  jinnDistributedOperator: '0',
  jinnDistributedDao: '0',
  mostRecentSettlementBlock: null,
  composition: { byMode: [], byHarness: [], byModel: [], byPlugin: [] },
  enrichmentCoverage: { enrichedAttempts: 8, totalAttempts: 10, share: 0.8 },
  lastIndexedBlock: '100',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

const SOLVERNETS_FIXTURE: SolverNetsResponse = {
  solvernets: [],
  lastIndexedBlock: '100',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

const SOLVERNET_FIXTURE: SolverNetResponse = {
  cid: 'abc',
  name: 'Test',
  description: '',
  solverNetId: '',
  manifestEnrichmentStatus: 'pending',
  status: 'launched',
  launcherAgentId: null,
  tasksPosted: 1,
  tasksSettled: 1,
  attempts: 1,
  verdicts: 1,
  verdictsPass: 1,
  resolvedRate: 1.0,
  learningCurveBuckets: [],
  learningCurveRolling: [],
  trainBoard: { ranked: [], lowVolume: [] },
  frozenBoard: { ranked: [], lowVolume: [] },
  checkpointTimeline: { checkpoints: [], note: '' },
  freezeIntegrity: { violations: [], verifiedFrozenShare: 1.0, frozenAttempts: 0 },
  lastIndexedBlock: '100',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

const OPERATORS_FIXTURE: OperatorsResponse = {
  ranked: [],
  lowVolume: [],
  minVerdicts: 5,
  meta: { jinnAttribution: 'pending' },
  lastIndexedBlock: '100',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

const OPERATOR_FIXTURE: OperatorResponse = {
  operator: '0x123',
  dominantMode: 'train',
  dominantHarness: 'test',
  dominantSolverType: 'swe.v1',
  perSolverNet: [],
  totals: {
    attempts: 0,
    settledContribution: 0,
    verdictsTotal: 0,
    verdictsPass: 0,
    resolvedRate: null,
    jinnEarned: '0',
  },
  meta: { jinnAttribution: 'pending' },
  lastIndexedBlock: '100',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

// ── Mock fetch ────────────────────────────────────────────────────────────────

function setupMockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    const json = (data: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    if (u.includes('/explorer/network')) return json(NETWORK_FIXTURE);
    if (u.match(/\/explorer\/solvernets$/)) return json(SOLVERNETS_FIXTURE);
    if (u.includes('/explorer/slice')) {
      return json({
        params: {
          manifestDigest: 'abc',
          group: 'none',
          filter: {},
          includeUnenriched: false,
          bucket: 'auto',
        },
        enrichmentCoverage: 1,
        kpis: { attempts: 0, verdicts: 0, verdictsPass: 0, resolvedRate: null, jinnEarned: '0' },
        series: [
          {
            groupValue: null,
            buckets: [],
            rolling: [],
            kpis: { attempts: 0, verdicts: 0, verdictsPass: 0, resolvedRate: null, jinnEarned: '0' },
          },
        ],
        leaderboard: { train: [], frozen: [] },
        lastIndexedBlock: '100',
        lastIndexedAt: new Date().toISOString(),
        behindHead: null,
      });
    }
    if (u.match(/\/explorer\/solvernet\//)) return json(SOLVERNET_FIXTURE);
    if (u.match(/\/explorer\/operators$/)) return json(OPERATORS_FIXTURE);
    if (u.match(/\/explorer\/operator\//)) return json(OPERATOR_FIXTURE);
    return json({});
  });
}

// ── Wrapper ───────────────────────────────────────────────────────────────────

function makeWrapper(path: string, opts: { static?: boolean } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const isStatic = opts.static ?? true;
  const { hook } = memoryLocation({ path, static: isStatic });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>{children}</Router>
      </QueryClientProvider>
    );
  }

  return Wrapper;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('App routing', () => {
  beforeEach(() => {
    setupMockFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('/ → NetworkView mounts (Activity strip + Network composition)', async () => {
    const Wrapper = makeWrapper('/');
    render(<App />, { wrapper: Wrapper });
    await waitFor(() => {
      // The "Solve rate" hero was removed in #610; assert the surviving anchors
      // (Activity strip + Network composition eyebrow).
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/network composition/i)).toBeInTheDocument();
    expect(screen.queryByText(/^solve rate$/i)).not.toBeInTheDocument();
  });

  it('/solvernets → SolverNetsListView mounts', async () => {
    const Wrapper = makeWrapper('/solvernets');
    render(<App />, { wrapper: Wrapper });
    await waitFor(() => {
      // The view heading says "SolverNets"
      expect(screen.getAllByText('SolverNets').length).toBeGreaterThan(0);
    });
  });

  it('/solvernet/abc → SolverNetView mounts with the cid', async () => {
    const Wrapper = makeWrapper('/solvernet/abc');
    render(<App />, { wrapper: Wrapper });
    await waitFor(() => {
      // SolverNetView renders the CID in breadcrumb ("abc" is short enough to not shorten)
      expect(screen.getByText('abc')).toBeInTheDocument();
    });
  });

  it('/operators → OperatorsView mounts', async () => {
    const Wrapper = makeWrapper('/operators');
    render(<App />, { wrapper: Wrapper });
    // "Operators" appears both in the nav and in the view heading
    await waitFor(() => {
      expect(screen.getAllByText('Operators').length).toBeGreaterThan(0);
    });
  });

  it('/operator/0x123 → OperatorView mounts', async () => {
    const Wrapper = makeWrapper('/operator/0x123');
    render(<App />, { wrapper: Wrapper });
    await waitFor(() => {
      // The OperatorView renders the full address in the header
      expect(screen.getByText('0x123')).toBeInTheDocument();
    });
  });

  it('/explore/abc → redirects to /solvernet/abc (SolverNetView mounts)', async () => {
    const Wrapper = makeWrapper('/explore/abc', { static: false });
    render(<App />, { wrapper: Wrapper });
    await waitFor(() => {
      // After the redirect SolverNetView mounts. Its breadcrumb shows the
      // (very short) decoded CID "abc"; the chrome's nav also has "SolverNets".
      // The legacy "Explore Test" header should be gone.
      expect(screen.getAllByText('SolverNets').length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByText(/explore test/i)).not.toBeInTheDocument();
  });

  it('/explore/abc?filter[harness]=codex&window=30 redirects preserving the query string', async () => {
    const Wrapper = makeWrapper(
      '/explore/abc?filter[harness]=codex&window=30',
      { static: false },
    );
    render(<App />, { wrapper: Wrapper });
    await waitFor(() => {
      // The redirected SolverNetView reads the URL filter into the
      // FilterChipStrip (labeled region after #687 removed the legacy
      // active-slice-chips testid-anchored strip).
      const chips = screen.getByRole('region', { name: 'Active filters' });
      expect(chips).toHaveTextContent(/harness:codex/i);
    });
  });

  it('/garbage → 404 page mounts', () => {
    const Wrapper = makeWrapper('/garbage');
    render(<App />, { wrapper: Wrapper });
    expect(screen.getByText('404')).toBeInTheDocument();
  });

  it('/solvernet/:cid with URL-encoded CID decodes correctly', async () => {
    const cid = 'bafkreiabc000000000000000000000001';
    const encoded = encodeURIComponent(cid);
    const Wrapper = makeWrapper(`/solvernet/${encoded}`);
    render(<App />, { wrapper: Wrapper });
    await waitFor(() => {
      // shortCid('bafkreiabc000000000000000000000001') → 'bafkrei…000001'
      expect(screen.getByText(/bafkrei/i)).toBeInTheDocument();
    });
  });
});
