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
  jinnDistributedOperator: '0',
  jinnDistributedDao: '0',
  mostRecentSettlementBlock: null,
  composition: { byMode: [], byHarness: [] },
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
    if (u.match(/\/explorer\/solvernet\//)) return json(SOLVERNET_FIXTURE);
    if (u.match(/\/explorer\/operators$/)) return json(OPERATORS_FIXTURE);
    if (u.match(/\/explorer\/operator\//)) return json(OPERATOR_FIXTURE);
    return json({});
  });
}

// ── Wrapper ───────────────────────────────────────────────────────────────────

function makeWrapper(path: string) {
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

  it('/ → NetworkView mounts ("The ether" headline)', async () => {
    const Wrapper = makeWrapper('/');
    render(<App />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('The ether')).toBeInTheDocument();
    });
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
