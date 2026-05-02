import { describe, it, expect, vi } from 'vitest';
import { runCorpusQuery, buildSubgraphQuery } from '../../src/corpus/query.js';

describe('buildSubgraphQuery', () => {
  it('builds a query with solverType filter', () => {
    const { query, variables } = buildSubgraphQuery({ solverType: 'prediction.v0', limit: 10 });
    expect(query).toContain('executions(');
    expect(variables.first).toBe(10);
    // solverType isn't directly indexed (Execution.kind is ENVELOPE/EVALUATION/OTHER per spec §10 Q6),
    // so build a server-side filter on metadataKey or post-fetch filter — for v0, post-fetch.
    expect(variables.solverType ?? null).toBeNull();
  });

  it('translates evidenceTier into Execution.tier filter', () => {
    const { variables } = buildSubgraphQuery({ evidenceTier: 'attested', limit: 5 });
    expect(variables.tier).toBe('ATTESTED');
  });

  it('clamps limit to 500 when caller passes more', () => {
    const { variables } = buildSubgraphQuery({ limit: 5000 });
    expect(variables.first).toBe(500);
  });

  it('defaults limit to 50 when unset', () => {
    const { variables } = buildSubgraphQuery({});
    expect(variables.first).toBe(50);
  });
});

describe('runCorpusQuery', () => {
  it('throws CorpusQueryError on non-OK HTTP', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 502 }));
    await expect(
      runCorpusQuery('https://subgraph.test/graphql', { limit: 5 }, fetchImpl),
    ).rejects.toThrow(/CorpusQueryError|502/);
  });

  it('parses subgraph executions array into EnvelopeRef[]', async () => {
    const payload = {
      data: {
        executions: [{
          id: '1-0xabc',
          manifestCid: 'bafyManifest1',
          manifestHash: '0x' + 'a'.repeat(64),
          tier: 'COMMITTED',
          publishedAt: '1745978400',
          operator: { id: '1', agentId: '1', owner: '0x' + '2'.repeat(40), agentWallet: '0x' + '3'.repeat(40) },
        }],
      },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    const refs = await runCorpusQuery('https://subgraph.test/graphql', { limit: 5 }, fetchImpl);
    expect(refs).toHaveLength(1);
    expect(refs[0].manifestCid).toBe('bafyManifest1');
    expect(refs[0].evidenceTier).toBe('committed');
    expect(refs[0].operator.safeAddress).toBe('0x' + '3'.repeat(40));
  });
});
