import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { CorpusItemView } from './CorpusItemView';
import type { CorpusItemResponse } from '../lib/api';

const CID = 'bafkreicorpusdetailaaaaaaaaaaaaaaaaaaaaa1';
const TRACE_SRC_CID = 'bafkreitracesourceaaaaaaaaaaaaaaaaaaaaaa9';
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

// A full trace (manifest → donation artifact) for the happy-path payload test.
const TRACE_INNER = {
  environment: { model: 'gpt-5.4-mini', harness: { name: 'jinn-agent' } },
  steps: [
    {
      name: 'tool:terminal',
      attributes: { 'tool.args': { command: 'ls -la' }, 'tool.result': 'total 0\ndrwxr' },
      redactedKeys: ['api_key'],
    },
  ],
};
const MANIFEST = {
  artifacts: [
    {
      artifactType: 'jinn.trace-envelope.v0',
      sources: [{ kind: 'ipfs', cid: TRACE_SRC_CID, sha256: 'abc' }],
    },
  ],
};
const DONATION = {
  artifactType: 'jinn.trace-envelope.v0',
  encoding: 'jinn.artifact.donation.v1',
  data: Buffer.from(JSON.stringify(TRACE_INNER)).toString('base64'),
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

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

/**
 * URL-aware fetch mock. Item requests hit `/explorer/corpus/:cid`; the detail
 * view ALSO fetches the IPFS trace (gateway). `traceSource` controls whether a
 * full trace resolves ('full') or the trace fetch dead-ends so the view falls
 * back to the indexed tool-name list ('none').
 */
function mockFetch(traceSource: 'full' | 'none', item: CorpusItemResponse = FIXTURE) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/explorer/corpus/')) return json(item);
    if (traceSource === 'full' && u.includes(TRACE_SRC_CID)) return json(DONATION);
    if (traceSource === 'full' && u.includes(CID)) return json(MANIFEST);
    // 'none': gateway returns a manifest with no public trace source → fallback.
    return json({});
  });
}

function mockFetch404() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/explorer/corpus/')) return json({ error: 'unknown corpus item' }, 404);
    return json({});
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CorpusItemView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the deep-link URL and requests the item by CID', async () => {
    const spy = mockFetch('none');
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(`/explorer/corpus/${encodeURIComponent(CID)}`);
    });
  });

  it('renders the summary, harness, model and tags — and NO tier chip', async () => {
    mockFetch('none');
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      // summary appears twice (headline + Task card body)
      expect(screen.getAllByText('fix flaky retry in http client').length).toBeGreaterThan(0);
      expect(screen.getByText('jinn-agent 0.4.2')).toBeInTheDocument();
      expect(screen.getByText('gpt-5.4-mini')).toBeInTheDocument();
      expect(screen.getByText('retry')).toBeInTheDocument();
    });
    expect(screen.queryByText('tests-passed')).toBeNull();
  });

  it('renders the Task, Details and Provenance sections', async () => {
    mockFetch('none');
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('Task')).toBeInTheDocument();
      expect(screen.getByText('Details')).toBeInTheDocument();
      expect(screen.getByText('Provenance')).toBeInTheDocument();
      expect(screen.getByText('contributed')).toBeInTheDocument();
    });
  });

  it('renders the full per-step payloads fetched from IPFS', async () => {
    mockFetch('full');
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/Steps · 6/i)).toBeInTheDocument();
      // scrubbed args + result render in full
      expect(screen.getByText(/ls -la/)).toBeInTheDocument();
      expect(screen.getByText(/drwxr/)).toBeInTheDocument();
      // redacted-key count surfaces
      expect(screen.getByText(/1 redacted/)).toBeInTheDocument();
    });
  });

  it('falls back to the indexed tool-name list when no public trace source exists', async () => {
    mockFetch('none');
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/Steps · 6/i)).toBeInTheDocument();
      expect(screen.getByText('read')).toBeInTheDocument();
      expect(screen.getByText('bash')).toBeInTheDocument();
      expect(screen.getByText('edit')).toBeInTheDocument();
    });
  });

  it('shows "no steps recorded" (not the unreachable caption) when the trace loads but is stepless', async () => {
    const donationEmpty = {
      artifactType: 'jinn.trace-envelope.v0',
      encoding: 'jinn.artifact.donation.v1',
      data: Buffer.from(JSON.stringify({ environment: {}, steps: [] })).toString('base64'),
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/explorer/corpus/')) return json(FIXTURE);
      if (u.includes(TRACE_SRC_CID)) return json(donationEmpty);
      if (u.includes(CID)) return json(MANIFEST);
      return json({});
    });
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/No steps recorded on this attempt/i)).toBeInTheDocument());
    // The fetch succeeded, so the "not reachable" caption and the tool-name
    // fallback must NOT render.
    expect(screen.queryByText(/aren.t reachable/i)).toBeNull();
    expect(screen.queryByText('read')).toBeNull();
  });

  it('links the contributor and the IPFS/anchor refs out to the chain', async () => {
    mockFetch('none');
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent(CID)}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText('IPFS content')).toBeInTheDocument();
    });
    const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(hrefs.some((h) => h?.includes(`sepolia.basescan.org/address/${FIXTURE.contributor}`))).toBe(true);
    expect(hrefs.some((h) => h?.includes('gateway.autonolas.tech') && h.includes(CID))).toBe(true);
    expect(hrefs.some((h) => h?.includes('sepolia.basescan.org/tx/') && h.includes(ANCHOR_TX))).toBe(true);
  });

  it('renders the not-found notice for an unknown CID (404)', async () => {
    mockFetch404();
    const { Wrapper } = makeWrapper(`/corpus/${encodeURIComponent('bafkreidoesnotexist')}`);
    render(<CorpusItemView />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText(/No attempt at this CID/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Back to Corpus')).toBeInTheDocument();
  });
});
