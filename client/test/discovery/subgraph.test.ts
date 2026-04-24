import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  queryIntents,
  queryEnvelopes,
  querySourceBundles,
  queryKnowledgeTree,
  queryArtifacts,
  queryNodes,
  queryOperatorValidations,
  getIntent,
  getEnvelopesForIntent,
  getEnvelopesBySource,
  getKnowledgeTree,
  getMetadataValue,
  type SubgraphResult,
} from '../../src/discovery/subgraph.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(responseBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => responseBody,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const URL = 'https://subgraph.test';
const CFG = { url: URL };

// ── queryIntents ─────────────────────────────────────────────────────────────

describe('queryIntents', () => {
  it('queries the intents entity with kind + creator filters', async () => {
    const fetchMock = mockFetch({ data: { intents: [] } });

    await queryIntents(CFG, {
      kind: 'portfolio.v0',
      creator: '0x1111111111111111111111111111111111111111',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('intents(');
    expect(body.variables.kind).toBe('portfolio.v0');
    expect(body.variables.creator).toBe('0x1111111111111111111111111111111111111111');
  });

  it('passes startTs and endTs as BigInt strings', async () => {
    const fetchMock = mockFetch({ data: { intents: [] } });

    await queryIntents(CFG, { startTs: 1700000000, endTs: 1800000000 });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.variables.startTs).toBe('1700000000');
    expect(body.variables.endTs).toBe('1800000000');
  });

  it('returns typed Intent objects', async () => {
    const intent = {
      id: 'bafy-intent-1',
      kind: 'portfolio.v0',
      creator: '0xAAA',
      createdAt: '1700000000',
      requestId: '0x' + 'ab'.repeat(32),
    };
    mockFetch({ data: { intents: [intent] } });

    const results = await queryIntents(CFG, { kind: 'portfolio.v0' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject(intent);
  });
});

// ── getIntent ─────────────────────────────────────────────────────────────────

describe('getIntent', () => {
  it('returns null when the intent is not found', async () => {
    mockFetch({ data: { intent: null } });
    const result = await getIntent(CFG, 'bafy-not-found');
    expect(result).toBeNull();
  });

  it('returns the intent when found', async () => {
    const intent = {
      id: 'bafy-intent-1',
      kind: 'portfolio.v0',
      creator: '0xAAA',
      createdAt: '1700000000',
      requestId: '0x' + 'aa'.repeat(32),
    };
    mockFetch({ data: { intent } });

    const result = await getIntent(CFG, 'bafy-intent-1');
    expect(result).toMatchObject(intent);
  });

  it('passes the id variable in the request', async () => {
    const fetchMock = mockFetch({ data: { intent: null } });
    await getIntent(CFG, 'bafy-test-id');
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.variables.id).toBe('bafy-test-id');
    expect(body.query).toContain('intent(id: $id)');
  });
});

// ── queryEnvelopes ────────────────────────────────────────────────────────────

describe('queryEnvelopes', () => {
  it('queries executionEnvelopes with V1 filter fields', async () => {
    const fetchMock = mockFetch({ data: { executionEnvelopes: [] } });

    await queryEnvelopes(CFG, {
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('executionEnvelopes(');
    expect(body.variables).toMatchObject({
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
    });
  });

  it('projects V1 envelopes to SubgraphResult for backward compat', async () => {
    const envelope = {
      id: 'bafy-env-1',
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'attested',
      participant: '0xSafe',
      generatedAt: '1700000000',
      createdAtBlock: '12345',
      intent: { id: 'bafy-intent', kind: 'portfolio.v0' },
      parentEnvelope: null,
      agent: { id: '1', agentURI: 'envelope:bafy-env-1', owner: '0xSafe' },
    };
    mockFetch({ data: { executionEnvelopes: [envelope] } });

    const results = await queryEnvelopes(CFG, { intentCid: 'bafy-intent' });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    // SubgraphResult shape
    expect(r.id).toBe('bafy-env-1');
    expect(r.agentURI).toBe('envelope:bafy-env-1');
    // metadata projection
    const meta = (key: string) => r.metadata.find(m => m.key === key)?.value;
    expect(meta('role')).toBe('restoration');
    expect(meta('evidenceTier')).toBe('attested');
    expect(meta('intentCid')).toBe('bafy-intent');
    expect(meta('participant')).toBe('0xSafe');
  });

  it('lowercases participant filter', async () => {
    const fetchMock = mockFetch({ data: { executionEnvelopes: [] } });
    await queryEnvelopes(CFG, { participant: '0xABCDEF1234' });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.variables.participant).toBe('0xabcdef1234');
  });
});

// ── getEnvelopesForIntent ─────────────────────────────────────────────────────

describe('getEnvelopesForIntent', () => {
  it('passes intentCid and returns typed Envelope objects', async () => {
    const envelope = {
      id: 'bafy-env-2',
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'self-signed',
      participant: '0xSafe',
      generatedAt: '1700000001',
      createdAtBlock: '12346',
      intent: { id: 'bafy-intent', kind: 'portfolio.v0' },
      parentEnvelope: null,
      sourceBundle: null,
    };
    const fetchMock = mockFetch({ data: { executionEnvelopes: [envelope] } });

    const results = await getEnvelopesForIntent(CFG, 'bafy-intent');

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.variables.intentCid).toBe('bafy-intent');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('bafy-env-2');
    expect(results[0]!.role).toBe('restoration');
  });
});

// ── getEnvelopesBySource ──────────────────────────────────────────────────────

describe('getEnvelopesBySource', () => {
  it('queries by sourceBundle filter and returns typed Envelope objects', async () => {
    const envelope = {
      id: 'bafy-env-3',
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'committed',
      participant: '0xSafe',
      generatedAt: '1700000002',
      createdAtBlock: '12347',
      intent: { id: 'bafy-intent', kind: 'portfolio.v0' },
      parentEnvelope: null,
      sourceBundle: { id: 'bafy-bundle-1' },
    };
    const fetchMock = mockFetch({ data: { executionEnvelopes: [envelope] } });

    const results = await getEnvelopesBySource(CFG, 'bafy-bundle-1');

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('sourceBundle: $bundleCid');
    expect(body.variables.bundleCid).toBe('bafy-bundle-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.sourceBundle?.id).toBe('bafy-bundle-1');
  });

  it('returns empty array when no envelopes use the bundle', async () => {
    mockFetch({ data: { executionEnvelopes: [] } });
    const results = await getEnvelopesBySource(CFG, 'bafy-bundle-unknown');
    expect(results).toHaveLength(0);
  });
});

// ── querySourceBundles ────────────────────────────────────────────────────────

describe('querySourceBundles', () => {
  it('queries sourceBundles entity with measurement and publishedBy filters', async () => {
    const fetchMock = mockFetch({ data: { sourceBundles: [] } });

    await querySourceBundles(CFG, {
      measurement: '0x' + 'dd'.repeat(48),
      publishedBy: '0x4444444444444444444444444444444444444444',
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('sourceBundles(');
    expect(body.variables.measurement).toBe('0x' + 'dd'.repeat(48));
    expect(body.variables.publishedBy).toBe('0x4444444444444444444444444444444444444444');
  });

  it('projects to SubgraphResult with metadata including documentType', async () => {
    const bundle = {
      id: 'bafy-bundle-1',
      measurement: '0x' + 'ab'.repeat(48),
      buildRecipeKind: 'dockerfile',
      humanUrl: 'https://github.com/example/repo',
      publishedBy: '0xSafe',
      agent: { id: '5', agentURI: 'sourcebundle:bafy-bundle-1', owner: '0xSafe' },
    };
    mockFetch({ data: { sourceBundles: [bundle] } });

    const results = await querySourceBundles(CFG);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    const meta = (key: string) => r.metadata.find(m => m.key === key)?.value;
    expect(meta('documentType')).toBe('adw:SourceBundle');
    expect(meta('measurement')).toBe('0x' + 'ab'.repeat(48));
    expect(meta('buildRecipeKind')).toBe('dockerfile');
    expect(meta('humanUrl')).toBe('https://github.com/example/repo');
  });
});

// ── queryArtifacts ────────────────────────────────────────────────────────────

describe('queryArtifacts', () => {
  it('queries artifacts entity and projects to SubgraphResult', async () => {
    const artifact = {
      id: 'bafy-artifact-1',
      artifactType: 'trajectory',
      parentEnvelope: { id: 'bafy-env-1' },
      tags: ['tag-a', 'tag-b'],
      agent: { id: '3', agentURI: 'artifact:bafy-artifact-1', owner: '0xSafe' },
    };
    const fetchMock = mockFetch({ data: { artifacts: [artifact] } });

    const results = await queryArtifacts(CFG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('artifacts(');

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.id).toBe('bafy-artifact-1');
    const meta = (key: string) => r.metadata.find(m => m.key === key)?.value;
    expect(meta('documentType')).toBe('adw:Artifact');
    expect(meta('artifactId')).toBe('bafy-artifact-1');
    expect(meta('parentEnvelopeCid')).toBe('bafy-env-1');
    expect(meta('tags')).toBe(JSON.stringify(['tag-a', 'tag-b']));
  });

  it('passes owner filter as lowercase bytes', async () => {
    const fetchMock = mockFetch({ data: { artifacts: [] } });
    await queryArtifacts(CFG, { owner: '0xABCD' });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.variables.owner).toBe('0xabcd');
  });
});

// ── queryNodes ────────────────────────────────────────────────────────────────

describe('queryNodes', () => {
  it('queries agents with documentType adw:AgentCard', async () => {
    const fetchMock = mockFetch({ data: { agents: [] } });
    await queryNodes(CFG);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('agents(');
    expect(body.query).toContain('adw:AgentCard');
  });

  it('returns SubgraphResult with metadata from agent metadata array', async () => {
    const agent = {
      id: '7',
      agentURI: 'agent:bafy-card',
      owner: '0xNode',
      metadata: [
        { metadataKey: 'documentType', metadataValueString: 'adw:AgentCard' },
        { metadataKey: 'endpoint', metadataValueString: 'https://node.example.com' },
      ],
    };
    mockFetch({ data: { agents: [agent] } });

    const results = await queryNodes(CFG);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.agentURI).toBe('agent:bafy-card');
    // getMetadataValue must work
    expect(getMetadataValue(r, 'endpoint')).toBe('https://node.example.com');
  });
});

// ── queryOperatorValidations ──────────────────────────────────────────────────

describe('queryOperatorValidations', () => {
  it('queries validationResponses filtered by participant address', async () => {
    const response = {
      id: 'bafy-response-1',
      overall: 'valid',
      createdAtBlock: '99999',
      envelope: { id: 'bafy-env-1' },
    };
    const fetchMock = mockFetch({ data: { validationResponses: [response] } });

    const results = await queryOperatorValidations(CFG, '0xSafeAddress');

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('validationResponses(');
    expect(body.query).toContain('participant: $participant');
    expect(body.variables.participant).toBe('0xsafeaddress');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      envelopeCid: 'bafy-env-1',
      verdict: 'valid',
      blockNumber: 99999,
    });
  });

  it('returns empty array when no validation responses exist', async () => {
    mockFetch({ data: { validationResponses: [] } });
    const results = await queryOperatorValidations(CFG, '0xSafe');
    expect(results).toHaveLength(0);
  });
});

// ── queryKnowledgeTree (legacy / backward compat) ─────────────────────────────

describe('queryKnowledgeTree', () => {
  it('returns the aggregated tree for an intent CID (via queryEnvelopes)', async () => {
    const envelopes = [
      {
        id: 'bafy-env-r',
        kind: 'portfolio.v0',
        role: 'restoration',
        evidenceTier: 'self-signed',
        participant: '0xAAA',
        generatedAt: '1700000000000',
        createdAtBlock: '100',
        intent: { id: 'bafy-intent', kind: 'portfolio.v0' },
        parentEnvelope: null,
        agent: { id: '1', agentURI: 'envelope:bafy-rest', owner: '0xAAA' },
      },
      {
        id: 'bafy-env-v',
        kind: 'portfolio.v0',
        role: 'verdict',
        evidenceTier: 'self-signed',
        participant: '0xBBB',
        generatedAt: '1700000000500',
        createdAtBlock: '101',
        intent: { id: 'bafy-intent', kind: 'portfolio.v0' },
        parentEnvelope: { id: 'bafy-rest' },
        agent: { id: '2', agentURI: 'envelope:bafy-verdict', owner: '0xBBB' },
      },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { executionEnvelopes: envelopes } }),
    }));

    const tree = await queryKnowledgeTree(CFG, 'bafy-intent');
    expect(tree.intentCid).toBe('bafy-intent');
    expect(tree.restorations).toHaveLength(1);
    expect(tree.restorations[0]!.envelopeCid).toBe('bafy-rest');
    expect(tree.restorations[0]!.verdicts).toHaveLength(1);
    expect(tree.restorations[0]!.verdicts[0]!.envelopeCid).toBe('bafy-verdict');
  });
});

// ── getKnowledgeTree (V1) ─────────────────────────────────────────────────────

describe('getKnowledgeTree', () => {
  it('assembles KnowledgeTreeResult from KnowledgeTree entity + envelope list', async () => {
    const treeEntity = {
      id: 'bafy-intent',
      totalRestorations: 1,
      totalVerdicts: 1,
      attestedRestorations: 0,
      attestedVerdicts: 0,
      attestedFraction: '0',
      intent: {
        id: 'bafy-intent',
        kind: 'portfolio.v0',
        creator: '0xCreator',
        createdAt: '1700000000',
        requestId: '0x' + 'aa'.repeat(32),
      },
    };

    const envelopes = [
      {
        id: 'bafy-env-r',
        kind: 'portfolio.v0',
        role: 'restoration',
        evidenceTier: 'self-signed',
        participant: '0xSafe',
        generatedAt: '1700000001',
        createdAtBlock: '100',
        intent: { id: 'bafy-intent', kind: 'portfolio.v0' },
        parentEnvelope: null,
        sourceBundle: null,
      },
      {
        id: 'bafy-env-v',
        kind: 'portfolio.v0',
        role: 'verdict',
        evidenceTier: 'self-signed',
        participant: '0xEval',
        generatedAt: '1700000002',
        createdAtBlock: '101',
        intent: { id: 'bafy-intent', kind: 'portfolio.v0' },
        parentEnvelope: { id: 'bafy-env-r' },
        sourceBundle: null,
      },
    ];

    // First call: knowledgeTree query. Second call: getEnvelopesForIntent.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { knowledgeTree: treeEntity } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { executionEnvelopes: envelopes } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getKnowledgeTree(CFG, 'bafy-intent');

    expect(result.intent.id).toBe('bafy-intent');
    expect(result.intent.kind).toBe('portfolio.v0');
    expect(result.restorations).toHaveLength(1);
    expect(result.restorations[0]!.id).toBe('bafy-env-r');
    expect(result.verdicts['bafy-env-r']).toHaveLength(1);
    expect(result.verdicts['bafy-env-r']![0]!.id).toBe('bafy-env-v');
    expect(result.totals.totalRestorations).toBe(1);
    expect(result.totals.totalVerdicts).toBe(1);
    expect(result.totals.attestedFraction).toBe(0);
  });

  it('gracefully handles missing KnowledgeTree entity (intent has no envelopes yet)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { knowledgeTree: null } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { executionEnvelopes: [] } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getKnowledgeTree(CFG, 'bafy-no-envelopes');
    expect(result.restorations).toHaveLength(0);
    expect(result.totals.totalRestorations).toBe(0);
    expect(result.totals.attestedFraction).toBe(0);
  });
});

// ── getMetadataValue (utility) ────────────────────────────────────────────────

describe('getMetadataValue', () => {
  it('finds a value by key', () => {
    const r: SubgraphResult = {
      id: '1',
      agentURI: 'test',
      owner: '0x',
      metadata: [{ key: 'foo', value: 'bar' }],
    };
    expect(getMetadataValue(r, 'foo')).toBe('bar');
    expect(getMetadataValue(r, 'missing')).toBeUndefined();
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('throws on non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    }));
    await expect(queryIntents(CFG)).rejects.toThrow('503');
  });

  it('throws on GraphQL errors array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'field not found' }] }),
    }));
    await expect(queryIntents(CFG)).rejects.toThrow('field not found');
  });

  it('throws when data is missing from response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));
    await expect(queryIntents(CFG)).rejects.toThrow('no data');
  });
});
