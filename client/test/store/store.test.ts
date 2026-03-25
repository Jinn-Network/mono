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
});
