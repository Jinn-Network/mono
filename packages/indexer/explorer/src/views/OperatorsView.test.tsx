/**
 * OperatorsView tests (post-#610 roster).
 *
 * The view is a flat roster: operator (short-address link) / active? /
 * activity blocks / attempts / OLAS earned. No rank, no top-level
 * resolved-rate column, no filter UI.
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
      active: true,
      recentBlocks: [true, true, true, true, true, true, true, true],
      jinnEarned: '1000000000000000000',
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
      active: false,
      recentBlocks: [false, true, false, true, false, true, false, true],
      jinnEarned: '500000000000000000',
    },
  ],
  minVerdicts: 5,
  activeOperators: 1,
  sustainedOperators: 2,
  operatorsAtMilestone3: 2,
  activeWindow: {
    startTs: 1_700_000_000,
    endTs: 1_700_172_800,
    blockSeconds: 21_600,
    blockCount: 8,
    requiredOlasPerBlock: '3000000000000000000',
  },
  appliedFilters: {},
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

  it('renders the OLAS earned value for each operator', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('1.00 OLAS')).toBeInTheDocument();
    });
    expect(screen.getByText('0.50 OLAS')).toBeInTheDocument();
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

  it('renders Operator | Active? | Activity blocks | Attempts | OLAS earned column order', async () => {
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
        expect.stringMatching(/activity blocks/i),
        expect.stringMatching(/attempts/i),
        expect.stringMatching(/olas earned/i),
      ]),
    );
    const operatorIdx = headers.findIndex((h) => /operator/i.test(h));
    const activeIdx = headers.findIndex((h) => /active\?/i.test(h));
    const activityBlocksIdx = headers.findIndex((h) => /activity blocks/i.test(h));
    const attemptsIdx = headers.findIndex((h) => /attempts/i.test(h));
    const olasEarnedIdx = headers.findIndex((h) => /olas earned/i.test(h));
    expect(operatorIdx).toBeLessThan(activeIdx);
    expect(activeIdx).toBeLessThan(activityBlocksIdx);
    expect(activityBlocksIdx).toBeLessThan(attemptsIdx);
    expect(attemptsIdx).toBeLessThan(olasEarnedIdx);
    expect(headers.some((h) => /jinn earned/i.test(h))).toBe(false);
  });

  it('does not render legacy token copy on the operators page or tooltips', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
    });

    for (const trigger of screen.getAllByRole('button', { name: /definition/i })) {
      fireEvent.click(trigger);
    }

    expect(document.body.textContent).not.toMatch(/\bJINN\b/);
    expect(document.body.textContent).not.toMatch(/tJINN/);
    expect(document.body.textContent).not.toMatch(/collector-token/i);
  });

  it('renders 8 Y/N symbols separated by ` | ` per row in the Activity blocks column', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const activityTexts = rows.map((row) => row.querySelectorAll('td')[2]?.textContent);
    expect(activityTexts).toEqual([
      'Y | Y | Y | Y | Y | Y | Y | Y',
      'N | Y | N | Y | N | Y | N | Y',
    ]);
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

  it('Active? is Yes when row.active is true', async () => {
    const fixture: OperatorsResponse = {
      ...OPERATORS_FIXTURE,
      ranked: [
        {
          ...OPERATORS_FIXTURE.ranked[0]!,
          active: true,
        },
      ],
      lowVolume: [],
      activeOperators: 1,
    };
    mockFetchOperators(fixture);
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    expect(rows.length).toBe(1);
    const activeCell = rows[0]!.querySelectorAll('td')[1];
    expect(activeCell?.textContent).toBe('Yes');
  });

  it('renders Sustained and Milestone-3 KPIs from the OLAS reward window', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    expect(screen.getByText(/sustained \(48h\)/i)).toBeInTheDocument();
    expect(screen.getByText(/milestone 3/i)).toBeInTheDocument();
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
