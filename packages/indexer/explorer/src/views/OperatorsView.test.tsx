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
      recentBlocks: [true, true, true, true, true, true, true, true],
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
      recentBlocks: [false, true, false, true, false, true, false, true],
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

  it('renders Operator | Active? | Activity blocks | Attempts | JINN earned column order (issue #905)', async () => {
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
        expect.stringMatching(/jinn earned/i),
      ]),
    );
    const operatorIdx = headers.findIndex((h) => /operator/i.test(h));
    const activeIdx = headers.findIndex((h) => /active\?/i.test(h));
    const recentIdx = headers.findIndex((h) => /activity blocks/i.test(h));
    const attemptsIdx = headers.findIndex((h) => /attempts/i.test(h));
    expect(operatorIdx).toBeLessThan(activeIdx);
    expect(activeIdx).toBeLessThan(recentIdx);
    expect(recentIdx).toBeLessThan(attemptsIdx);
  });

  it('does NOT render the `last 8 × 6h, ≥3 tJINN each` subtitle on the Active operators KPI (issue #905)', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/last 8/i)).toBeNull();
    expect(screen.queryByText(/≥3 tJINN each/)).toBeNull();
  });

  it('places the InfoTooltip `?` trigger in the KPI eyebrow next to the `Active operators` label (issue #905)', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/active operators/i)).toBeInTheDocument();
    });
    // The trigger must be reachable next to the eyebrow label, not nested
    // under the big numeric value (`.data` text). The DOM contract: the
    // `Active operators definition` trigger and the label text share a
    // common parent that does NOT contain the bare numeric value `1`.
    const trigger = screen.getByRole('button', {
      name: /active operators definition/i,
    });
    const labelNode = screen.getByText(/active operators/i);
    // Trigger and label share an ancestor — the eyebrow row. The value
    // `1` should not live inside that shared ancestor.
    const sharedAncestor = labelNode.parentElement;
    expect(sharedAncestor?.contains(trigger)).toBe(true);
    // Value "1" lives in the sibling `.data` div, not in the eyebrow row.
    expect(sharedAncestor?.textContent ?? '').not.toMatch(/^.*\b1\b.*$/s);
  });

  it('renders 8 Y/N symbols separated by ` | ` per row in the Activity blocks column (issue #905)', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    // Two rows, two body <tr> — read each row's Activity-blocks cell text content
    // (whitespace-collapsed) and compare to the ` | `-joined expected glyphs.
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    expect(rows.length).toBe(2);
    const cellTexts = rows.map((r) => {
      const tds = r.querySelectorAll('td');
      // Order: Operator | Active? | Activity blocks | Attempts | JINN earned
      return (tds[2]?.textContent ?? '').replace(/\s+/g, ' ').trim();
    });
    expect(cellTexts[0]).toBe('Y | Y | Y | Y | Y | Y | Y | Y');
    expect(cellTexts[1]).toBe('N | Y | N | Y | N | Y | N | Y');
  });

  it('gives each Activity blocks symbol a native `title` showing the block UTC window (issue #905)', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    // Window: 1_700_000_000 → 1_700_000_000 + 48 * 3600, 8 buckets of 6h.
    // Oldest block (index 0): 1_700_000_000 (2023-11-14 22:13:20 UTC) →
    //   1_700_021_600 (2023-11-15 04:13:20 UTC).
    // The title format mirrors the spec: `YYYY-MM-DD HH:MM → YYYY-MM-DD HH:MM UTC`.
    const symbolCells = document.querySelectorAll('[data-testid^="activity-block-cell-"]');
    expect(symbolCells.length).toBeGreaterThanOrEqual(8);
    for (const cell of Array.from(symbolCells)) {
      const t = cell.getAttribute('title') ?? '';
      expect(t).toMatch(/→/);
      expect(t).toMatch(/UTC/);
    }
  });

  it('renders an InfoTooltip in the Activity blocks column header with the encoding note (issue #905)', async () => {
    mockFetchOperators();
    const { Wrapper } = makeWrapper();
    render(<OperatorsView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    });
    const trigger = screen.getByRole('button', {
      name: /activity blocks definition/i,
    });
    fireEvent.click(trigger);
    expect(
      screen.getByText(
        /Each cell is one of the last 8 completed UTC 6-hour blocks \(oldest left\)\. Y = operator earned ≥3 tJINN in that block; N = did not\./,
      ),
    ).toBeInTheDocument();
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
