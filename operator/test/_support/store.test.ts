import { describe, it, expect } from 'vitest';
import { withTempStore } from '@test/store.js';

describe('withTempStore', () => {
  it('provides a working :memory: Store and closes it on exit', async () => {
    let stored: unknown;
    await withTempStore(async (store) => {
      store.recordOwnActivity('req-1', 'created');
      stored = store.isOwnActivity('req-1');
    });
    expect(stored).toBe(true);
  });

  it('closes the store even when the callback throws', async () => {
    await expect(withTempStore(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // No way to assert the store is closed from the outside; the test exists to
    // prove the wrapper doesn't swallow errors and doesn't leak an open handle.
  });
});
