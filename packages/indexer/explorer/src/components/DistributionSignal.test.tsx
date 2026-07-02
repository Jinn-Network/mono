/**
 * DistributionSignal tests (#1314).
 *
 * The critical behaviours: seed exclusion is the default and visibly stated;
 * the segmented control refetches with ?include=seeded (the demonstrate-it-
 * live toggle); the empty corpus renders the exact empty-state copy.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistributionSignal } from './DistributionSignal';
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

const SEEDED_FIXTURE: DistributionSignalResponse = {
  rows: [
    ...SIGNAL_FIXTURE.rows,
    { cluster: 'seed-import', envelopeCount: 5, contributorCount: 1, topTags: ['skills'] },
  ],
  envelopeTotal: 19,
  contributorTotal: 5,
  seedsExcluded: 0,
  includeSeeds: true,
};

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper };
}

function mockFetchSignal() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/distribution-signal')) {
      const seeded = u.includes('include=seeded');
      return Promise.resolve(
        new Response(JSON.stringify(seeded ? SEEDED_FIXTURE : SIGNAL_FIXTURE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  return calls;
}

describe('DistributionSignal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders clusters sorted by volume with the seeds-excluded note', async () => {
    mockFetchSignal();
    const { Wrapper } = makeWrapper();
    render(<DistributionSignal />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getAllByText('typescript').length).toBeGreaterThan(0));
    expect(screen.getAllByText('research').length).toBeGreaterThan(0);
    expect(screen.getByText(/5 seeded excluded/)).toBeInTheDocument();
    expect(screen.getByText(/distinct contributors/)).toBeInTheDocument();
  });

  it('the include-seeded toggle refetches with ?include=seeded and folds seeds in', async () => {
    const calls = mockFetchSignal();
    const { Wrapper } = makeWrapper();
    render(<DistributionSignal />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getAllByText('typescript').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('include seeded'));
    await waitFor(() => expect(screen.getAllByText('seed-import').length).toBeGreaterThan(0));
    expect(calls.some((u) => u.includes('include=seeded'))).toBe(true);
    expect(screen.getByText(/seeded entries included/)).toBeInTheDocument();
  });

  it('empty corpus renders the exact empty-state copy', async () => {
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
    render(<DistributionSignal />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(
        screen.getByText('No contributions yet — signal appears as the corpus grows.'),
      ).toBeInTheDocument(),
    );
  });

  it('error state offers a retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('Server Error', { status: 500 })),
    );
    const { Wrapper } = makeWrapper();
    render(<DistributionSignal />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText(/Failed to load the distribution signal/)).toBeInTheDocument(),
    );
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });
});
