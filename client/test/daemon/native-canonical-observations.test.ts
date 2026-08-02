import { describe, expect, it } from 'vitest';
import { NativeMarketplaceEventRepository } from '../../src/daemon/native-canonical-observations.js';
import { Store } from '../../src/store/store.js';

function solution(blockHash: `0x${string}`, txHash: `0x${string}`, blockNumber: number) {
  return {
    event: 'SolutionDeliveryClaimed',
    facts: {
      operator: `0x${'1'.repeat(40)}`,
      requestId: `0x${'2'.repeat(64)}`,
      taskId: 7n,
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
      finalityTier: 'safe',
    },
  } as never;
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
