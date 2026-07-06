/**
 * CorpusCard tests (#1407, spec §2.4).
 *
 * The card is the rename + restructure of the shipped "Distribution signal"
 * card. Critical behaviours:
 *   - it is titled "Corpus" (not "Distribution signal");
 *   - it reads as a plain-language summary ("N task traces contributed by M
 *     operators, in K clusters") over the envelope-only counts;
 *   - the clusters/contributors/tags data still renders (no data regression);
 *   - it links into the Corpus tab (/corpus) — cluster names + footer;
 *   - there is NO seed toggle on this surface (retired per design);
 *   - the empty corpus renders the shared empty-state copy.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { CorpusCard } from './CorpusCard';
import type { DistributionSignalResponse } from '../lib/api';

const SIGNAL_FIXTURE: DistributionSignalResponse = {
  rows: [
    { cluster: 'typescript', envelopeCount: 9, contributorCount: 3, topTags: ['testing', 'zod'] },
    { cluster: 'research', envelopeCount: 4, contributorCount: 2, topTags: [] },
    { cluster: 'niche', envelopeCount: 1, contributorCount: 1, topTags: [] },
  ],
  envelopeTotal: 14,
  contributorTotal: 4,
  seedsExcluded: 5,
  includeSeeds: false,
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

function mockFetchSignal() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/distribution-signal')) {
      return Promise.resolve(
        new Response(JSON.stringify(SIGNAL_FIXTURE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  return calls;
}

describe('CorpusCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is titled "Corpus", not "Distribution signal"', async () => {
    mockFetchSignal();
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getAllByText('typescript').length).toBeGreaterThan(0),
    );
    expect(screen.getByText('Corpus')).toBeInTheDocument();
    expect(screen.queryByText(/distribution signal/i)).toBeNull();
  });

  it('renders the plain-language summary sentence over the envelope-only totals', async () => {
    mockFetchSignal();
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    const sentence = await screen.findByText(/task traces contributed by/i);
    // Total (14), contributors (4), clusters (3) read within the one sentence.
    const text = sentence.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('14 task traces contributed by 4 operators, in 3 clusters.');
    // The corpus total takes gold — the Network view's single hero (spec §3.5).
    const total = screen.getByText('14');
    expect(total).toHaveStyle({ color: 'var(--accent-gold)' });
    // "Where contributions concentrate" — the analytical framing survives as
    // the bars' eyebrow (design §1407).
    expect(screen.getByText(/where contributions concentrate/i)).toBeInTheDocument();
  });

  it('renders the clusters/contributors/tags breakdown with no data regression', async () => {
    mockFetchSignal();
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getAllByText('typescript').length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText('research').length).toBeGreaterThan(0);
    // niche (envelopeCount 1) sits under the low-volume fold.
    expect(screen.getByText('Low-volume')).toBeInTheDocument();
    expect(screen.getAllByText('niche').length).toBeGreaterThan(0);
    // Tags still render.
    expect(screen.getByText('testing')).toBeInTheDocument();
    expect(screen.getByText('zod')).toBeInTheDocument();
  });

  it('links cluster names and the footer into the Corpus tab', async () => {
    mockFetchSignal();
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText('Browse the corpus →')).toBeInTheDocument(),
    );
    // Footer link → /corpus
    const browse = screen.getByText('Browse the corpus →').closest('a');
    expect(browse).toHaveAttribute('href', '/corpus');
    // Cluster name → /corpus (plain; pre-filtered link is a follow-up once the
    // index gains a cluster filter param — see #1414)
    const cluster = screen.getByRole('link', { name: 'typescript' });
    expect(cluster).toHaveAttribute('href', '/corpus');
  });

  it('has no seed toggle on this surface (retired per design)', async () => {
    mockFetchSignal();
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getAllByText('typescript').length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('include seeded')).toBeNull();
    expect(screen.queryByText('envelope-only')).toBeNull();
    expect(screen.queryByText(/seeded excluded/i)).toBeNull();
  });

  it('empty corpus renders the shared empty-state copy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            rows: [],
            envelopeTotal: 0,
            contributorTotal: 0,
            seedsExcluded: 0,
            includeSeeds: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(
        screen.getByText(
          'No contributions yet — the corpus grows as operators publish task traces.',
        ),
      ).toBeInTheDocument(),
    );
  });

  it('error state offers a retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('Server Error', { status: 500 })),
    );
    const { Wrapper } = makeWrapper();
    render(<CorpusCard />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText(/Failed to load the corpus/)).toBeInTheDocument(),
    );
    expect(screen.getByText('Retry')).toBeInTheDocument();
    // Retry re-fires the fetch without throwing.
    fireEvent.click(screen.getByText('Retry'));
  });
});
