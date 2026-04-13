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
});
