import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { CorpusView } from './CorpusView';
import type { CorpusListResponse } from '../lib/api';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ITEM_A = {
  cid: 'bafkreicorpusaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
  chainId: 84532,
  summary: 'fix flaky retry in http client',
  cluster: 'jinn-agent',
  tier: 'tests-passed',
  contributor: '0x91be44f0aa10e2c1b34c92e5f7d80337a90244a2',
  model: 'gpt-5.4-mini',
  stepCount: 6,
  createdAt: Math.floor(Date.now() / 1000) - 120,
};

const ITEM_B = {
  cid: 'bafkreicorpusbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
  chainId: 84532,
  summary: 'null-deref in markdown table parser',
  cluster: 'codex-swe',
  tier: 'evaluator-verified',
  contributor: '0x3fA79bb210cD3a4E88c05B12aF0e6D97c441Be09',
  model: 'codex-52',
  stepCount: 9,
  createdAt: Math.floor(Date.now() / 1000) - 3600,
};

const FIXTURE: CorpusListResponse = {
  items: [ITEM_A, ITEM_B],
  total: 2,
  seedsExcluded: 3,
  includeSeeds: false,
  lastIndexedBlock: '43611254',
  lastIndexedAt: new Date(Date.now() - 30_000).toISOString(),
  behindHead: null,
};

const EMPTY_FIXTURE: CorpusListResponse = {
  items: [],
  total: 0,
  seedsExcluded: 0,
  includeSeeds: false,
  lastIndexedBlock: '43611254',
  lastIndexedAt: new Date(Date.now() - 30_000).toISOString(),
  behindHead: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWrapper(path = '/corpus', opts: { static?: boolean } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const { hook } = memoryLocation({ path, static: opts.static ?? true });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>{children}</Router>
      </QueryClientProvider>
    );
  }

  return { Wrapper, qc };
}

function mockFetch(fixture: CorpusListResponse) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/**
 * URL-capturing mock: records every requested URL and returns the seeded or
 * envelope-only fixture based on the `include` query param. Lets tests assert
 * the exact query string the view drove.
 */
function mockFetchCapturing(): string[] {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    calls.push(u);
    const seeded = u.includes('include=seeded');
    const body: CorpusListResponse = seeded
      ? { ...FIXTURE, includeSeeds: true, seedsExcluded: 0, total: 5 }
      : FIXTURE;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  return calls;
}

function mockFetchError() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('error', { status: 500 }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CorpusView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page headline "Corpus"', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getAllByText('Corpus').length).toBeGreaterThan(0);
    });
  });

  it('renders a row per corpus item with summary + tier chip', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('fix flaky retry in http client')).toBeInTheDocument();
      expect(screen.getByText('null-deref in markdown table parser')).toBeInTheDocument();
      expect(screen.getByText('tests-passed')).toBeInTheDocument();
      expect(screen.getByText('evaluator-verified')).toBeInTheDocument();
    });
  });

  it('renders each row as a deep-link to /corpus/:cid', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      const link = screen.getByText('fix flaky retry in http client').closest('a');
      expect(link).toHaveAttribute('href', `/corpus/${encodeURIComponent(ITEM_A.cid)}`);
    });
  });

  it('states the total and the seeds-excluded count', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/2 contributed task traces/i)).toBeInTheDocument();
      expect(screen.getByText(/3 seeds excluded/i)).toBeInTheDocument();
    });
  });

  it('renders the empty state in the explorer voice when there are no items', async () => {
    mockFetch(EMPTY_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/No contributions yet/i)).toBeInTheDocument();
    });
  });

  it('renders error state + retry on failure', async () => {
    mockFetchError();
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/Failed to load the corpus/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('renders the column headers', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('Contribution')).toBeInTheDocument();
      expect(screen.getByText('Cluster')).toBeInTheDocument();
      expect(screen.getByText('Tier')).toBeInTheDocument();
      expect(screen.getByText('Contributor')).toBeInTheDocument();
      expect(screen.getByText('Steps')).toBeInTheDocument();
      expect(screen.getByText('Age')).toBeInTheDocument();
    });
  });

  it('renders StatusBar with last indexed block', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      // block("43611254") → "43,611,254"
      expect(screen.getByText('43,611,254')).toBeInTheDocument();
    });
  });

  it('drives sort server-side: the request carries sort + dir query params', async () => {
    const calls = mockFetchCapturing();
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    // Default landing sort is createdAt desc — sent to the backend, not applied page-locally.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain('sort=createdAt');
    expect(calls[0]).toContain('dir=desc');
  });

  it('clicking a sort header refetches with the new sort key (server-side sort)', async () => {
    const calls = mockFetchCapturing();
    const { Wrapper } = makeWrapper('/corpus', { static: false });
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText('Steps')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Steps'));
    // A new request goes out keyed on the stepCount column.
    await waitFor(() => expect(calls.some((u) => u.includes('sort=stepCount'))).toBe(true));
  });

  it('changing sort resets pagination to the first page (offset=0)', async () => {
    const calls = mockFetchCapturing();
    // Land on page 2 (offset 50).
    const { Wrapper } = makeWrapper('/corpus?page=2', { static: false });
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => expect(calls.some((u) => u.includes('offset=50'))).toBe(true));
    // Wait for the header row to render before interacting with it.
    await waitFor(() => expect(screen.getByText('Cluster')).toBeInTheDocument());

    // Switch sort column; the follow-up request must be back at offset 0.
    fireEvent.click(screen.getByText('Cluster'));
    await waitFor(() =>
      expect(calls.some((u) => u.includes('sort=cluster') && u.includes('offset=0'))).toBe(true),
    );
  });

  it('the include-seeded toggle refetches with ?include=seeded and resets the page', async () => {
    const calls = mockFetchCapturing();
    const { Wrapper } = makeWrapper('/corpus?page=2', { static: false });
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => expect(calls.some((u) => u.includes('offset=50'))).toBe(true));
    await waitFor(() => expect(screen.getByText('include seeded')).toBeInTheDocument());

    fireEvent.click(screen.getByText('include seeded'));
    // New query carries include=seeded AND is reset to the first page.
    await waitFor(() =>
      expect(
        calls.some((u) => u.includes('include=seeded') && u.includes('offset=0')),
      ).toBe(true),
    );
  });
});
