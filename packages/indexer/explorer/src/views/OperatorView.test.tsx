/**
 * OperatorView tests.
 *
 * Asserts:
 *   - Address header + dominant chips render
 *   - Totals KPI row renders (resolved rate in gold)
 *   - perSolverNet table renders with CID links
 *   - Empty perSolverNet → "No activity recorded for this address"
 *   - meta.jinnAttribution: 'pending' → JINN shows "—"
 *   - Loading and error states render
 */

import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Switch, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OperatorView } from './OperatorView';
import type { OperatorResponse } from '../lib/api';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADDR = '0xaaaa000000000000aaaa';

const OPERATOR_FIXTURE: OperatorResponse = {
  operator: ADDR,
  dominantMode: 'train',
  dominantHarness: 'swe-bench',
  dominantSolverType: 'swe.v1',
  perSolverNet: [
    {
      cid: 'bafkreiabc000000000000000000000001',
      status: 'launched',
      attempts: 120,
      settledContribution: 100,
      verdictsTotal: 100,
      verdictsPass: 90,
      resolvedRate: 0.9,
      modeBreakdown: [
        { value: 'train', count: 80, share: 0.8 },
        { value: 'frozen', count: 20, share: 0.2 },
      ],
    },
  ],
  totals: {
    attempts: 120,
    settledContribution: 100,
    verdictsTotal: 100,
    verdictsPass: 90,
    resolvedRate: 0.9,
    jinnEarned: '1500000000000000000',
  },
  meta: { jinnAttribution: 'ok' },
  lastIndexedBlock: '12000000',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

const EMPTY_OPERATOR_FIXTURE: OperatorResponse = {
  ...OPERATOR_FIXTURE,
  perSolverNet: [],
  totals: {
    attempts: 0,
    settledContribution: 0,
    verdictsTotal: 0,
    verdictsPass: 0,
    resolvedRate: null,
    jinnEarned: '0',
  },
};

const PENDING_JINN_FIXTURE: OperatorResponse = {
  ...OPERATOR_FIXTURE,
  meta: { jinnAttribution: 'pending' },
};

// ── Wrapper ───────────────────────────────────────────────────────────────────

function makeWrapper(addr = ADDR) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const path = `/operator/${encodeURIComponent(addr)}`;
  const { hook } = memoryLocation({ path, static: true });

  function WrappedView() {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>
          <Switch>
            <Route path="/operator/:addr" component={OperatorView} />
          </Switch>
        </Router>
      </QueryClientProvider>
    );
  }

  return { WrappedView, qc };
}

function mockFetch(fixture: OperatorResponse) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchError() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('Not found', { status: 500 }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OperatorView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the full operator address in the header', async () => {
    mockFetch(OPERATOR_FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    await waitFor(() => {
      expect(screen.getByText(ADDR)).toBeInTheDocument();
    });
  });

  it('renders dominant mode, harness, and type chips', async () => {
    mockFetch(OPERATOR_FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    await waitFor(() => {
      expect(screen.getByText(/mode: train/i)).toBeInTheDocument();
      expect(screen.getByText(/harness: swe-bench/i)).toBeInTheDocument();
      expect(screen.getByText(/type: swe.v1/i)).toBeInTheDocument();
    });
  });

  it('renders the totals KPI row', async () => {
    mockFetch(OPERATOR_FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    await waitFor(() => {
      // Attempts = 120 (appears in KPI tile and in perSolverNet table)
      expect(screen.getAllByText('120').length).toBeGreaterThanOrEqual(1);
      // Resolved rate = 90.0% — appears in KPI and in table column
      expect(screen.getAllByText('90.0%').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders JINN earned when attribution is ok', async () => {
    mockFetch(OPERATOR_FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    await waitFor(() => {
      // 1.5 JINN
      expect(screen.getByText('1.50 tJINN')).toBeInTheDocument();
    });
  });

  it('shows JINN as "—" when jinnAttribution is pending', async () => {
    mockFetch(PENDING_JINN_FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    await waitFor(() => {
      // The "—" with title attribute for JINN
      const pendingEl = document.querySelector('[title*="jinn-mono-ebu7.9"]');
      expect(pendingEl).toBeTruthy();
    });
  });

  it('renders the perSolverNet table with CID link', async () => {
    mockFetch(OPERATOR_FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    await waitFor(() => {
      // CID: bafkreiabc000000000000000000000001 → shortCid → "bafkrei…000001"
      const link = screen.getByRole('link', { name: /bafkrei/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', `/solvernet/${encodeURIComponent('bafkreiabc000000000000000000000001')}`);
    });
  });

  it('renders mode breakdown text for perSolverNet rows', async () => {
    mockFetch(OPERATOR_FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    await waitFor(() => {
      expect(screen.getByText('train')).toBeInTheDocument();
      expect(screen.getByText('frozen')).toBeInTheDocument();
    });
  });

  it('renders empty state for unknown address with empty perSolverNet', async () => {
    mockFetch(EMPTY_OPERATOR_FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    await waitFor(() => {
      expect(
        screen.getByText(/No activity recorded for this address/i),
      ).toBeInTheDocument();
    });
  });

  it('renders loading skeleton initially', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    const { WrappedView } = makeWrapper();
    const { container } = render(<WrappedView />);

    const elevated = container.querySelectorAll('[style*="var(--bg-elevated)"]');
    expect(elevated.length).toBeGreaterThan(0);
  });

  it('renders error state when fetch fails', async () => {
    mockFetchError();
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load operator/i)).toBeInTheDocument();
      expect(screen.getByText('Back to operators')).toBeInTheDocument();
    });
  });

  it('renders breadcrumb link back to /operators', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);

    expect(screen.getByText('Operators')).toBeInTheDocument();
  });

  it('renders "Explore this slice" links per SolverNet row, deep-linking to /solvernet/<cid> with filter[operator]', async () => {
    mockFetch(OPERATOR_FIXTURE);
    const { WrappedView } = makeWrapper();
    render(<WrappedView />);
    await waitFor(() => {
      const link = screen.getAllByRole('link', { name: /explore this slice/i })[0];
      expect(link).toBeDefined();
      const href = link.getAttribute('href') ?? '';
      expect(href).toMatch(/^\/solvernet\//);
      expect(href).toContain(`filter[operator]=${encodeURIComponent(ADDR)}`);
    });
  });
});
