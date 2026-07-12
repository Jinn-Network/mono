/**
 * CorpusCard tests (spec §2.4).
 *
 * The Dashboard corpus card: two big stats (attempts · clusters), a Browse
 * button in the header, and the latest 5 attempts via the shared corpus table.
 * Critical behaviours:
 *   - titled "Corpus";
 *   - the attempt total + distinct-cluster count read as big stats;
 *   - the latest attempts render (from the corpus list endpoint);
 *   - a "Browse the corpus" button links into /corpus;
 *   - NO HBars, NO cluster breakdown table, NO seed toggle, NO footer legend;
 *   - the empty corpus renders the shared empty-state copy.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { CorpusCard } from './CorpusCard';
import type { CorpusListResponse, DistributionSignalResponse } from '../lib/api';

const SIGNAL: DistributionSignalResponse = {
  rows: [
    { cluster: 'typescript', envelopeCount: 9, contributorCount: 3, topTags: ['testing'] },
    { cluster: 'research', envelopeCount: 4, contributorCount: 2, topTags: [] },
    { cluster: 'niche', envelopeCount: 1, contributorCount: 1, topTags: [] },
  ],
  envelopeTotal: 14,
  contributorTotal: 4,
  seedsExcluded: 5,
  includeSeeds: false,
};

const LIST: CorpusListResponse = {
  items: [
    {
      cid: 'bafkreilatestaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      chainId: 84532,
      summary: 'add retry backoff to the poller',
      cluster: 'typescript',
      tier: 'user-accepted',
      contributor: '0x91be44f0aa10e2c1b34c92e5f7d80337a90244a2',
      model: 'm',
      stepCount: 4,
      createdAt: Math.floor(Date.now() / 1000) - 60,
    },
  ],
  total: 14,
  seedsExcluded: 5,
  includeSeeds: false,
  lastIndexedBlock: '43611254',
  lastIndexedAt: new Date().toISOString(),
  behindHead: null,
};

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const { hook } = memoryLocation({ path: '/', static: true });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>{children}</Router>
      </QueryClientProvider>
    );
  }
  return { Wrapper };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

function mockFetch(signal: DistributionSignalResponse | 'error', list: CorpusListResponse) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/distribution-signal')) return signal === 'error' ? json({}, 500) : json(signal);
    if (u.includes('/explorer/corpus')) return json(list);
    return json({});
  });
}

describe('CorpusCard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is titled "Corpus"', async () => {
    mockFetch(SIGNAL, LIST);
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText('add retry backoff to the poller')).toBeInTheDocument());
    expect(screen.getByText('Corpus')).toBeInTheDocument();
  });

  it('renders attempts + clusters as big stats', async () => {
    mockFetch(SIGNAL, LIST);
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() => {
      const total = screen.getByText('14');
      expect(total).toHaveStyle({ color: 'var(--accent-gold)' });
      expect(screen.getByText('attempts')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('clusters')).toBeInTheDocument();
    });
  });

  it('renders the latest attempts via the shared table', async () => {
    mockFetch(SIGNAL, LIST);
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() => {
      const row = screen.getByText('add retry backoff to the poller').closest('a');
      expect(row).toHaveAttribute('href', `/corpus/${encodeURIComponent(LIST.items[0].cid)}`);
    });
  });

  it('links a preview Cluster chip to the filtered index (#1414 AC3, shared table)', async () => {
    mockFetch(SIGNAL, LIST);
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() => {
      const chipLink = screen.getByText(LIST.items[0].cluster).closest('a');
      expect(chipLink).toHaveAttribute(
        'href',
        `/corpus?cluster=${encodeURIComponent(LIST.items[0].cluster)}`,
      );
    });
  });

  it('links to the corpus via a Browse button', async () => {
    mockFetch(SIGNAL, LIST);
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText('Browse the corpus →')).toBeInTheDocument());
    expect(screen.getByText('Browse the corpus →').closest('a')).toHaveAttribute('href', '/corpus');
  });

  it('carries no HBars, cluster breakdown, seed toggle, or footer legend', async () => {
    mockFetch(SIGNAL, LIST);
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText('attempts')).toBeInTheDocument());
    expect(screen.queryByText(/where contributions concentrate/i)).toBeNull();
    expect(screen.queryByText('include seeded')).toBeNull();
    expect(screen.queryByText(/every trace/i)).toBeNull();
    expect(screen.queryByText('Top tags')).toBeNull();
  });

  it('renders the shared empty-state copy for an empty corpus', async () => {
    mockFetch(
      { rows: [], envelopeTotal: 0, contributorTotal: 0, seedsExcluded: 0, includeSeeds: false },
      { ...LIST, items: [], total: 0 },
    );
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(
        screen.getByText('No attempts yet — the corpus grows as operators publish them.'),
      ).toBeInTheDocument(),
    );
  });

  it('offers a retry when the corpus fails to load', async () => {
    mockFetch('error', LIST);
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Failed to load the corpus/)).toBeInTheDocument());
    expect(screen.getByText('Retry')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
  });
});
