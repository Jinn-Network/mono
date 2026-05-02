import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('records own activity for role independence', () => {
    store.recordOwnActivity('req-1', 'created');
    store.recordOwnActivity('req-2', 'claimed');
    expect(store.isOwnActivity('req-1')).toBe(true);
    expect(store.isOwnActivity('req-3')).toBe(false);
  });

  it('tracks shutdown state', () => {
    store.setShutdownState('clean');
    expect(store.getShutdownState()).toBe('clean');
  });

  it('aggregates own activity and config rows', () => {
    store.recordOwnActivity('r1', 'delivered');
    store.recordOwnActivity('r2', 'evaluated');
    store.setConfigValue('last_reward_claim_tick_at', '2026-01-02T00:00:00.000Z');
    expect(store.getOwnActivityCounts()).toEqual({ delivered: 1, evaluated: 1 });
    expect(store.getRecentOwnActivity(5)).toHaveLength(2);
    expect(store.getConfigValue('last_reward_claim_tick_at')).toBe('2026-01-02T00:00:00.000Z');
  });

  it('searches artifacts by taskId', () => {
    store.insertArtifact({
      id: 'art-1',
      taskId: 'my-state-id',
      requestId: 'req-1',
      title: 'Test artifact',
      content: 'Some content',
      tags: ['restoration', 'test'],
      outcome: 'SUCCESS',
    });
    store.insertArtifact({
      id: 'art-2',
      taskId: 'other-state-id',
      requestId: 'req-2',
      title: 'Other artifact',
      content: 'Other content',
      tags: ['test'],
      outcome: 'FAILURE',
    });

    const results = store.searchArtifacts({ taskId: 'my-state-id' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('art-1');

    const noMatch = store.searchArtifacts({ taskId: 'nonexistent' });
    expect(noMatch).toHaveLength(0);
  });

  it('stores durable task post records', () => {
    store.upsertTaskPostRecord({
      creatorSafeAddress: '0x00112233445566778899AABbCCdDeeFf00112233',
      sourceKey: 'manual:test-1',
      policyType: 'once_per_safe',
      scopeKey: '',
      taskId: 'test-1',
      requestId: 'req-1',
      firstPostedAt: '2026-04-23T10:00:00.000Z',
      lastPostedAt: '2026-04-23T10:00:00.000Z',
      postCount: 1,
    });

    expect(store.getTaskPostRecord({
      creatorSafeAddress: '0x00112233445566778899AABbCCdDeeFf00112233',
      sourceKey: 'manual:test-1',
      policyType: 'once_per_safe',
      scopeKey: '',
    })).toMatchObject({
      requestId: 'req-1',
      taskId: 'test-1',
      postCount: 1,
    });
  });
});
