import { describe, it, expect } from 'vitest';
import { HttpDeliveryReader } from '../../src/dispatcher/delivery-reader.js';
import liveIssueFixture from '../fixtures/delivery-live-issue-solution.json';

/** Minimal fetch-shaped response — only what HttpDeliveryReader reads. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

interface FakeFetchCfg {
  /** GraphQL envelope index rows (manifestCid list), most-recent-first. */
  rows: Array<{ manifestCid: string }>;
  /** manifestCid/taskCid → IPFS body. */
  ipfs: Record<string, unknown>;
}

function fakeFetch(cfg: FakeFetchCfg) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.method === 'POST') {
      return jsonResponse({ data: { envelopes: { items: cfg.rows } } });
    }
    const cid = url.split('/ipfs/')[1]!;
    if (!(cid in cfg.ipfs)) return jsonResponse({}, false, 404);
    return jsonResponse(cfg.ipfs[cid]);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('HttpDeliveryReader', () => {
  it('resolves envelope rows to DeliveredRecords for matching solverType', async () => {
    const { fetchImpl, calls } = fakeFetch({
      rows: [{ manifestCid: liveIssueFixture.manifestCid }],
      ipfs: {
        [liveIssueFixture.manifestCid]: liveIssueFixture.envelope,
        [liveIssueFixture.envelope.task.cid]: liveIssueFixture.task,
      },
    });
    const reader = new HttpDeliveryReader({
      indexerUrl: 'https://indexer.example',
      ipfsGatewayUrl: 'https://gateway.example',
      fetchImpl,
    });

    const records = await reader.pollSolutions();
    expect(records).toHaveLength(1);
    expect(records[0]!.manifestCid).toBe(liveIssueFixture.manifestCid);
    expect(records[0]!.envelope.solverType).toBe('jinn-repo.v1');
    expect(records[0]!.taskRaw).toEqual(liveIssueFixture.task);
    expect(calls[0]).toBe('https://indexer.example/graphql');
  });

  it('filters out envelopes for a different solverType without fetching their task doc', async () => {
    const otherEnvelope = { ...liveIssueFixture.envelope, solverType: 'prediction.v0', task: { cid: 'bafkreiOTHERTASK' } };
    const { fetchImpl, calls } = fakeFetch({
      rows: [{ manifestCid: 'bafkreiOTHER' }],
      ipfs: { bafkreiOTHER: otherEnvelope },
    });
    const reader = new HttpDeliveryReader({
      indexerUrl: 'https://indexer.example/graphql',
      ipfsGatewayUrl: 'https://gateway.example',
      fetchImpl,
    });

    const records = await reader.pollSolutions();
    expect(records).toEqual([]);
    // Only the envelope body was fetched — never the (nonexistent) task doc.
    expect(calls.filter((u) => u.includes('/ipfs/'))).toEqual(['https://gateway.example/ipfs/bafkreiOTHER']);
  });

  it('advances the cursor past generatedAt so a re-poll does not re-return the same envelope', async () => {
    const { fetchImpl } = fakeFetch({
      rows: [{ manifestCid: liveIssueFixture.manifestCid }],
      ipfs: {
        [liveIssueFixture.manifestCid]: liveIssueFixture.envelope,
        [liveIssueFixture.envelope.task.cid]: liveIssueFixture.task,
      },
    });
    const reader = new HttpDeliveryReader({
      indexerUrl: 'https://indexer.example',
      ipfsGatewayUrl: 'https://gateway.example',
      fetchImpl,
    });

    const first = await reader.pollSolutions();
    expect(first).toHaveLength(1);
    const second = await reader.pollSolutions();
    expect(second).toEqual([]);
  });

  it('skips a row whose envelope body fails to parse, without throwing the whole poll', async () => {
    const { fetchImpl } = fakeFetch({
      rows: [{ manifestCid: 'bafkreiMALFORMED' }, { manifestCid: liveIssueFixture.manifestCid }],
      ipfs: {
        bafkreiMALFORMED: { not: 'an envelope' },
        [liveIssueFixture.manifestCid]: liveIssueFixture.envelope,
        [liveIssueFixture.envelope.task.cid]: liveIssueFixture.task,
      },
    });
    const reader = new HttpDeliveryReader({
      indexerUrl: 'https://indexer.example',
      ipfsGatewayUrl: 'https://gateway.example',
      fetchImpl,
    });

    const records = await reader.pollSolutions();
    expect(records).toHaveLength(1);
    expect(records[0]!.manifestCid).toBe(liveIssueFixture.manifestCid);
  });
});
