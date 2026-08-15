import { describe, expect, it } from 'vitest';
import { NativeMarketplaceEventRepository } from '../../src/daemon/native-canonical-observations.js';
import { Store } from '../../src/store/store.js';

function solution(
  blockHash: `0x${string}`,
  txHash: `0x${string}`,
  blockNumber: number,
  overrides: { readonly finalityTier?: 'safe' | 'finalized'; readonly taskId?: bigint } = {},
) {
  return {
    event: 'SolutionDeliveryClaimed',
    facts: {
      operator: `0x${'1'.repeat(40)}`,
      requestId: `0x${'2'.repeat(64)}`,
      taskId: overrides.taskId ?? 7n,
      attemptIndex: 0,
    },
    derivation: {
      chainId: 84532,
      contract: `0x${'3'.repeat(40)}`,
      contractGeneration: 'today',
      event: 'SolutionDeliveryClaimed',
      blockHash,
      blockNumber,
      txHash,
      logIndex: 4,
      finalityTier: overrides.finalityTier ?? 'safe',
    },
  } as never;
}

function rowFor(store: Store, blockHash: string): { finality: string; event_json: string } {
  return store.db.prepare(
    'SELECT finality, event_json FROM native_marketplace_events WHERE lower(block_hash) = ?',
  ).get(blockHash) as { finality: string; event_json: string };
}

describe('native raw canonical marketplace event journal', () => {
  it('retains safe candidates for an independent finalized read and appends reorg provenance', () => {
    const store = new Store(':memory:');
    const repository = new NativeMarketplaceEventRepository(store);
    const displaced = `0x${'a'.repeat(64)}` as const;
    const replacement = `0x${'b'.repeat(64)}` as const;

    repository.apply({ events: [solution(displaced, `0x${'c'.repeat(64)}`, 100)] });
    expect(repository.solutionCandidates()).toHaveLength(1);

    repository.apply({
      orphanedBlockHashes: [displaced],
      events: [solution(replacement, `0x${'d'.repeat(64)}`, 100)],
    });
    expect(repository.solutionCandidates()).toEqual([
      expect.objectContaining({ derivation: expect.objectContaining({ blockHash: replacement }) }),
    ]);
    expect((store.db.prepare('SELECT count(*) AS count FROM native_marketplace_events').get() as { count: number }).count)
      .toBe(2);
    expect((store.db.prepare(
      'SELECT orphaned_at FROM native_marketplace_events WHERE lower(block_hash) = ?',
    ).get(displaced) as { orphaned_at: string }).orphaned_at).not.toBeNull();
    store.close();
  });
});

// Defect #47 review. `finalityTier` is not decoded from the log — `chain-log-source.ts` computes it
// per fetch from the finalized head — so a re-offer of an already-journalled block routinely
// carries a HIGHER tier than the stored row. The replay tool (`rewindChainLogCursor`) makes that
// the normal case, not the exotic one: the catch-up fast path refetches the whole rewound range
// below `finalized`, so every row first seen `safe` near the tip comes back `finalized`.
describe('native raw canonical marketplace event journal: finality promotion', () => {
  const block = `0x${'a'.repeat(64)}` as const;
  const tx = `0x${'c'.repeat(64)}` as const;

  it('upgrades a safe row in place when the identical event is re-offered as finalized', () => {
    const store = new Store(':memory:');
    const repository = new NativeMarketplaceEventRepository(store);

    repository.apply({ events: [solution(block, tx, 100)] });
    expect(rowFor(store, block).finality).toBe('safe');

    expect(() => repository.apply({
      events: [solution(block, tx, 100, { finalityTier: 'finalized' })],
    })).not.toThrow();

    const row = rowFor(store, block);
    expect(row.finality).toBe('finalized');
    // The stored bytes are upgraded with the column, so a decoded candidate never disagrees with it.
    expect(JSON.parse(row.event_json).derivation.finalityTier).toBe('finalized');
    expect((store.db.prepare('SELECT count(*) AS count FROM native_marketplace_events')
      .get() as { count: number }).count).toBe(1);
    store.close();
  });

  it('keeps the batch — a promoted row must not roll back the new events beside it', () => {
    const store = new Store(':memory:');
    const repository = new NativeMarketplaceEventRepository(store);
    const fresh = `0x${'b'.repeat(64)}` as const;

    repository.apply({ events: [solution(block, tx, 100)] });
    // Exactly the shape a post-rewind poll delivers: the replayed range re-tiered `finalized`,
    // followed by blocks mined since the cursor was swept, which are never re-listed if lost.
    repository.apply({
      events: [
        solution(block, tx, 100, { finalityTier: 'finalized' }),
        solution(fresh, `0x${'d'.repeat(64)}`, 200, { finalityTier: 'finalized' }),
      ],
    });

    expect((store.db.prepare('SELECT count(*) AS count FROM native_marketplace_events')
      .get() as { count: number }).count).toBe(2);
    expect(rowFor(store, fresh).finality).toBe('finalized');
    store.close();
  });

  it('ignores a finalized -> safe re-observation rather than regressing the mark', () => {
    const store = new Store(':memory:');
    const repository = new NativeMarketplaceEventRepository(store);

    repository.apply({ events: [solution(block, tx, 100, { finalityTier: 'finalized' })] });
    expect(() => repository.apply({ events: [solution(block, tx, 100)] })).not.toThrow();

    expect(rowFor(store, block).finality).toBe('finalized');
    store.close();
  });

  it('still throws when any OTHER byte diverges for the same event key', () => {
    const store = new Store(':memory:');
    const repository = new NativeMarketplaceEventRepository(store);

    repository.apply({ events: [solution(block, tx, 100)] });

    expect(() => repository.apply({ events: [solution(block, tx, 100, { taskId: 8n })] }))
      .toThrow(/changed bytes/);
    // And the divergence still throws when it arrives alongside a tier promotion.
    expect(() => repository.apply({
      events: [solution(block, tx, 100, { taskId: 8n, finalityTier: 'finalized' })],
    })).toThrow(/changed bytes/);
    expect(rowFor(store, block).finality).toBe('safe');
    store.close();
  });
});
