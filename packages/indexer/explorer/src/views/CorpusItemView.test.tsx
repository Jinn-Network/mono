import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { CorpusItemView } from './CorpusItemView';
import type { CorpusItemResponse } from '../lib/api';

const CID = 'bafkreicorpusdetailaaaaaaaaaaaaaaaaaaaaa1';
const ANCHOR_TX = '0x7a2f9e01d44b8c3a6f5e2d90b1a4c7e8f3d6a9b2c5e8f1a4d7b0c3e6c0190abcd';

const FIXTURE: CorpusItemResponse = {
  cid: CID,
  chainId: 84532,
  summary: 'fix flaky retry in http client',
  cluster: 'jinn-agent',
  tags: ['cli', 'swe', 'retry'],
  tier: 'tests-passed',
  contributor: '0x91be44f0aa10e2c1b34c92e5f7d80337a90244a2',
  harness: 'jinn-agent 0.4.2',
  model: 'gpt-5.4-mini',
  tools: ['read', 'bash', 'edit'],
  stepCount: 6,
  provenance: 'contributed',
  anchorTx: ANCHOR_TX,
  createdAt: Math.floor(Date.now() / 1000) - 120,
  lastIndexedBlock: '43611254',
  lastIndexedAt: new Date(Date.now() - 30_000).toISOString(),
  behindHead: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWrapper(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const { hook } = memoryLocation({ path, static: true });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <Router hook={hook}>
          {/* Mount under the real route so useParams(":cid") resolves the deep link. */}
          <Route path="/corpus/:cid">{children}</Route>
        </Router>
      </QueryClientProvider>
    );
  }

  return { Wrapper, qc };
}

function mockFetchOk(fixture: CorpusItemResponse) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetch404() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error: 'unknown corpus item' }), { status: 404 }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CorpusItemView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the deep-link URL and requests the item by CID', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(`/explorer/corpus/${encodeURIComponent(CID)}`);
    });
  });

  it('renders the envelope summary, tier, harness, model, and tags', async () => {
    mockFetchOk(FIXTURE);
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('fix flaky retry in http client')).toBeInTheDocument();
      expect(screen.getByText('tests-passed')).toBeInTheDocument();
      expect(screen.getByText('jinn-agent 0.4.2')).toBeInTheDocument();
      expect(screen.getByText('gpt-5.4-mini')).toBeInTheDocument();
      expect(screen.getByText('retry')).toBeInTheDocument();
    });
  });

  it('renders the tool sequence rows', async () => {
    mockFetchOk(FIXTURE);
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/Tool sequence · 6 steps/i)).toBeInTheDocument();
      expect(screen.getByText('read')).toBeInTheDocument();
      expect(screen.getByText('bash')).toBeInTheDocument();
    });
  });

  it('renders the IPFS content ref and the basescan anchor as outbound links', async () => {
    mockFetchOk(FIXTURE);
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      // Wait for the detail to render (the "IPFS content" label appears once loaded).
      expect(screen.getByText('IPFS content')).toBeInTheDocument();
    });
    const links = screen.getAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs.some((h) => h?.includes('gateway.autonolas.tech') && h.includes(CID))).toBe(true);
    expect(hrefs.some((h) => h?.includes('sepolia.basescan.org/tx/') && h.includes(ANCHOR_TX))).toBe(true);
  });

  it('renders the not-found notice for an unknown CID (404)', async () => {
    mockFetch404();
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent('bafkreidoesnotexist')}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/No corpus item at this CID/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Back to Corpus')).toBeInTheDocument();
  });
});
