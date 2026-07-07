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

/** URL-capturing mock: records every requested URL, always returns FIXTURE. */
function mockFetchCapturing(): string[] {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    calls.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(FIXTURE), {
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

  it('renders a row per attempt with its summary', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('fix flaky retry in http client')).toBeInTheDocument();
      expect(screen.getByText('null-deref in markdown table parser')).toBeInTheDocument();
    });
  });

  it('renders each attempt summary as a deep-link to /corpus/:cid', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      const link = screen.getByText('fix flaky retry in http client').closest('a');
      expect(link).toHaveAttribute('href', `/corpus/${encodeURIComponent(ITEM_A.cid)}`);
    });
  });

  it('links each contributor out to the on-chain record on basescan', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      const link = screen.getByText(/0x91be…44a2/).closest('a');
      expect(link).toHaveAttribute(
        'href',
        `https://sepolia.basescan.org/address/${ITEM_A.contributor}`,
      );
      expect(link).toHaveAttribute('target', '_blank');
    });
  });

  it('states the attempt total (no seed cruft)', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/^2 attempts$/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/seeds excluded/i)).toBeNull();
    expect(screen.queryByText(/task traces/i)).toBeNull();
  });

  it('renders the empty state in the explorer voice when there are no attempts', async () => {
    mockFetch(EMPTY_FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/No attempts yet/i)).toBeInTheDocument();
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

  it('renders the pruned column headers (Attempt · Cluster · Contributor · Age; no Tier/Steps)', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('Attempt')).toBeInTheDocument();
      expect(screen.getByText('Cluster')).toBeInTheDocument();
      expect(screen.getByText('Contributor')).toBeInTheDocument();
      expect(screen.getByText('Age')).toBeInTheDocument();
    });
    expect(screen.queryByText('Tier')).toBeNull();
    expect(screen.queryByText('Steps')).toBeNull();
    expect(screen.queryByText('Contribution')).toBeNull();
  });

  it('has no seed filter on this surface', async () => {
    mockFetch(FIXTURE);
    const { Wrapper } = makeWrapper();
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText('Cluster')).toBeInTheDocument());
    expect(screen.queryByText('include seeded')).toBeNull();
    expect(screen.queryByText('envelope-only')).toBeNull();
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
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain('sort=createdAt');
    expect(calls[0]).toContain('dir=desc');
  });

  it('clicking the Age header toggles the sort direction (server-side)', async () => {
    const calls = mockFetchCapturing();
    const { Wrapper } = makeWrapper('/corpus', { static: false });
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText('Age')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Age'));
    await waitFor(() =>
      expect(calls.some((u) => u.includes('sort=createdAt') && u.includes('dir=asc'))).toBe(true),
    );
  });

  it('changing sort resets pagination to the first page (offset=0)', async () => {
    const calls = mockFetchCapturing();
    const { Wrapper } = makeWrapper('/corpus?page=2', { static: false });
    render(<CorpusView />, { wrapper: Wrapper });
    await waitFor(() => expect(calls.some((u) => u.includes('offset=50'))).toBe(true));
    await waitFor(() => expect(screen.getByText('Cluster')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Cluster'));
    await waitFor(() =>
      expect(calls.some((u) => u.includes('sort=cluster') && u.includes('offset=0'))).toBe(true),
    );
  });
});
