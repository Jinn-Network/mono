import { describe, expect, it } from 'vitest';
import { createArchiveReads, extractTaskCreatedBlocks } from '../../src/archive/reads.js';
import { TASK_POST_WINDOW_BLOCKS } from '../../src/archive/types.js';

describe('createArchiveReads.getTaskPostCounts', () => {
  it('nests the windows: 1h subset of 6h subset of 24h', async () => {
    const head = 100_000;
    const reads = createArchiveReads({
      windowEndBlock: () => head,
      listTaskCreatedBlocks: () => [
        head - 10,
        head - TASK_POST_WINDOW_BLOCKS.h1 - 10,
        head - TASK_POST_WINDOW_BLOCKS.h6 - 10,
        head - TASK_POST_WINDOW_BLOCKS.h24 - 10,
      ],
      now: () => 1_715_600_000_000,
    });
    const counts = await reads.getTaskPostCounts();
    expect(counts.chain.h1).toBeLessThanOrEqual(counts.chain.h6);
    expect(counts.chain.h6).toBeLessThanOrEqual(counts.chain.h24);
    expect(counts.chain.h1).toBe(1);
    expect(counts.chain.h6).toBe(2);
    expect(counts.chain.h24).toBe(3);
    expect(counts.byCid).toEqual({});
  });

  it('returns zero byCid buckets for requested cids (TaskCreated has no manifestDigest)', async () => {
    const head = 50_000;
    const reads = createArchiveReads({
      windowEndBlock: () => head,
      listTaskCreatedBlocks: () => [head - 5, head - 15],
      now: () => 1_000_000,
    });
    const counts = await reads.getTaskPostCounts({ manifestCids: ['cid-a', 'cid-b'] });
    expect(counts.chain.h1).toBe(2);
    expect(counts.byCid['cid-a']).toMatchObject({ h1: 0, h6: 0, h24: 0 });
    expect(counts.byCid['cid-b']).toMatchObject({ h1: 0, h6: 0, h24: 0 });
  });
});

describe('createArchiveReads.getTaskStatuses', () => {
  it('degrades to an empty Map (launcher chips render unknown)', async () => {
    const reads = createArchiveReads({
      windowEndBlock: () => 1,
      listTaskCreatedBlocks: () => [1],
    });
    await expect(reads.getTaskStatuses({ manifestCid: 'any' })).resolves.toEqual(new Map());
  });
});

describe('extractTaskCreatedBlocks', () => {
  it('keeps TaskCreated observations and ignores other events and junk JSON', () => {
    expect(
      extractTaskCreatedBlocks([
        JSON.stringify({ derivation: { event: 'TaskCreated', blockNumber: 42 } }),
        JSON.stringify({ derivation: { event: 'TaskAttemptCreated', blockNumber: 43 } }),
        'not-json',
        JSON.stringify({ derivation: { event: 'TaskCreated', blockNumber: 'nope' } }),
        JSON.stringify({ derivation: { event: 'TaskCreated', blockNumber: 99 } }),
      ]),
    ).toEqual([42, 99]);
  });
});
