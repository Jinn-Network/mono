import { Store } from '@/store/store.js';

/**
 * Creates a `:memory:` Store, invokes the callback with it, and guarantees the
 * store is closed on both success and failure. Replaces the per-file
 * beforeEach/afterEach dance that exists in ~10 test files today.
 */
export async function withTempStore<T>(
  fn: (store: Store) => T | Promise<T>,
): Promise<T> {
  const store = new Store(':memory:');
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}
