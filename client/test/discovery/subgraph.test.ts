import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  queryIntents,
  queryEnvelopes,
  querySourceBundles,
  queryKnowledgeTree,
} from '../../src/discovery/subgraph.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queryIntents', () => {
  it('builds a filter query for kind + creator', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await queryIntents({ url: 'https://subgraph.test' }, {
      kind: 'portfolio.v0',
      creator: '0x1111111111111111111111111111111111111111',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('adw:Intent');
    expect(body.variables.kind).toBe('portfolio.v0');
    expect(body.variables.creator.toLowerCase()).toBe(
      '0x1111111111111111111111111111111111111111',
    );
  });
});

describe('queryEnvelopes', () => {
  it('filters by kind + role + evidenceTier + intentCid', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await queryEnvelopes({ url: 'https://subgraph.test' }, {
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('adw:ExecutionEnvelope');
    expect(body.variables).toMatchObject({
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
    });
  });
});

describe('querySourceBundles', () => {
  it('filters by measurement + publishedBy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await querySourceBundles({ url: 'https://subgraph.test' }, {
      measurement: '0x' + 'dd'.repeat(48),
      publishedBy: '0x4444444444444444444444444444444444444444',
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('adw:SourceBundle');
    expect(body.variables.measurement).toBe('0x' + 'dd'.repeat(48));
  });
});

describe('queryKnowledgeTree', () => {
  it('returns the aggregated tree for an intent CID', async () => {
    const envelopes = [
      {
        id: '1',
        agentURI: 'envelope:bafy-rest',
        owner: '0xAAA',
        metadata: [
          { key: 'documentType', value: 'adw:ExecutionEnvelope' },
          { key: 'kind', value: 'portfolio.v0' },
          { key: 'role', value: 'restoration' },
          { key: 'evidenceTier', value: 'self-signed' },
          { key: 'intentCid', value: 'bafy-intent' },
          { key: 'participant', value: '0xAAA' },
          { key: 'generatedAt', value: '1700000000000' },
        ],
      },
      {
        id: '2',
        agentURI: 'envelope:bafy-verdict',
        owner: '0xBBB',
        metadata: [
          { key: 'documentType', value: 'adw:ExecutionEnvelope' },
          { key: 'kind', value: 'portfolio.v0' },
          { key: 'role', value: 'verdict' },
          { key: 'evidenceTier', value: 'self-signed' },
          { key: 'intentCid', value: 'bafy-intent' },
          { key: 'parentEnvelopeCid', value: 'bafy-rest' },
          { key: 'participant', value: '0xBBB' },
          { key: 'generatedAt', value: '1700000000500' },
        ],
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: envelopes } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const tree = await queryKnowledgeTree(
      { url: 'https://subgraph.test' },
      'bafy-intent',
    );
    expect(tree.intentCid).toBe('bafy-intent');
    expect(tree.restorations).toHaveLength(1);
    expect(tree.restorations[0]!.envelopeCid).toBe('bafy-rest');
    expect(tree.restorations[0]!.verdicts).toHaveLength(1);
    expect(tree.restorations[0]!.verdicts[0]!.envelopeCid).toBe('bafy-verdict');
  });
});
