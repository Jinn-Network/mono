/**
 * OperatorsView tests (post-#610 roster).
 *
 * The view is now a flat roster: operator (short-address link) / attempts /
 * JINN earned. No rank, no top-level resolved-rate column, no filter UI.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OperatorsView } from './OperatorsView';
import type { OperatorsResponse } from '../lib/api';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OPERATORS_FIXTURE: OperatorsResponse = {
  ranked: [
    {
      rank: 1,
      operator: '0xabc0000000000000000000000000000000000001',
      attempts: 12,
      settledContribution: 10,
      verdictsTotal: 8,
      verdictsPass: 7,
      resolvedRate: 7 / 8,
      jinnEarned: '1000000000000000000',
      active: true,
      dominantMode: 'train',
      dominantHarness: 'swe-bench',
    },
  ],
  lowVolume: [
    {
      operator: '0xdef0000000000000000000000000000000000002',
      attempts: 3,
      settledContribution: 2,
      verdictsTotal: 2,
      verdictsPass: 1,
      resolvedRate: 0.5,
      jinnEarned: '500000000000000000',
      active: false,
    },
  ],
  minVerdicts: 5,
  activeOperators: 1,
  activeWindow: {
    startTs: 1_700_000_000,
    endTs: 1_700_000_000 + 48 * 3600,
    blockSeconds: 6 * 3600,
    blockCount: 8,
    requiredTjinnPerBlock: '3000000000000000000',
  },
  appliedFilters: {},
  meta: { jinnAttribution: 'ok' },
  lastIndexedBlock: '12000000',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

// ── Wrapper ───────────────────────────────────────────────────────────────────

function makeWrapper(path = '/operators') {
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

function mockFetchOperators(
  operatorsFixture: OperatorsResponse = OPERATORS_FIXTURE,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/explorer/operators')) {
      return Promise.resolve(
        new Response(JSON.stringify(operatorsFixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

function mockFetchError() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response('Server Error', { status: 500 })),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OperatorsView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page heading', () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    expect(screen.getByText('Operators')).toBeInTheDocument();
  });

  it('does NOT render a rank/# column header (#610)', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    expect(screen.queryByText(/^rank$/i)).toBeNull();
    expect(screen.queryByText('#')).toBeNull();
  });

  it('does NOT render a top-level "resolved rate" column (#610)', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    expect(screen.queryByText(/resolved rate/i)).toBeNull();
  });

  it('renders short-address links for each operator row', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    expect(screen.getByText('0xdef0…0002')).toBeInTheDocument();
  });

  it('renders the Attempts count for each operator', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      // attempts = 12 (ranked) and 3 (low-volume)
      expect(screen.getByText('12')).toBeInTheDocument();
    });
    // Column header
    expect(screen.getByText(/^attempts$/i)).toBeInTheDocument();
  });

  it('renders the JINN earned value for each operator', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      // 1e18 wei = 1.00 JINN, 5e17 wei = 0.50 JINN
      expect(screen.getByText('1.00 JINN')).toBeInTheDocument();
    });
    expect(screen.getByText('0.50 JINN')).toBeInTheDocument();
    expect(screen.getByText(/jinn earned/i)).toBeInTheDocument();
  });

  it('renders loading state initially', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    const { Wrapper } = makeWrapper();
    const { container } = render(<OperatorsView />, { wrapper: Wrapper });
    const elevated = container.querySelectorAll('[style*="var(--bg-elevated)"]');
    expect(elevated.length).toBeGreaterThan(0);
  });

  it('renders error state when fetch fails', async () => {
    mockFetchError();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/Failed to load operators/i)).toBeInTheDocument();
    });
  });

  it('renders the ACTIVE OPERATORS stat strip with the value from data.activeOperators', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
    });
    // activeOperators === 1 in the fixture
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders an Active? column header between Operator and Attempts', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    const headers = Array.from(
      document.querySelectorAll('thead th'),
    ).map((th) => th.textContent ?? '');
    expect(headers).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/operator/i),
        expect.stringMatching(/active\?/i),
        expect.stringMatching(/attempts/i),
        expect.stringMatching(/jinn earned/i),
      ]),
    );
    const operatorIdx = headers.findIndex((h) => /operator/i.test(h));
    const activeIdx = headers.findIndex((h) => /active\?/i.test(h));
    const attemptsIdx = headers.findIndex((h) => /attempts/i.test(h));
    expect(operatorIdx).toBeLessThan(activeIdx);
    expect(activeIdx).toBeLessThan(attemptsIdx);
  });

  it('renders Yes/No per row driven by row.active', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    // ranked row active=true → "Yes"; lowVolume row active=false → "No"
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('opens the active-operator tooltip body when the trigger is clicked', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    // At least one InfoTooltip trigger renders on the page (stat strip + column header).
    const triggers = screen.getAllByRole('button', { name: /definition/i });
    expect(triggers.length).toBeGreaterThan(0);
    fireEvent.click(triggers[0]!);
    // Canonical definition copy.
    expect(
      screen.getAllByText(/Earned ≥3 tJINN in each of the last 8 completed UTC 6-hour blocks/i)
        .length,
    ).toBeGreaterThan(0);
    // The window dates render in the body — derived from activeWindow.startTs/endTs.
    expect(screen.getAllByText(/UTC/).length).toBeGreaterThan(0);
  });

  it('does not pass mode/harness/minVerdicts to useOperators (no filter UI)', async () => {
    // Decision 4: with the filter UI gone, useOperators is called with no
    // params. Verify the fetch URL has no filter query string.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/explorer/operators')) {
        return Promise.resolve(
          new Response(JSON.stringify(OPERATORS_FIXTURE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });

    const calls = fetchSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/explorer/operators'));
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) {
      expect(url).not.toContain('mode=');
      expect(url).not.toContain('harness=');
      expect(url).not.toContain('minVerdicts=');
    }
  });
});
