import { describe, expect, it, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';

describe('HttpDiscoveryAPI.getTaskLifecycleEvidence (#2044)', () => {
  it('short-circuits an empty task list with no network I/O', async () => {
    const fetchImpl = vi.fn();
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(api.getTaskLifecycleEvidence({ taskIds: [] }))
      .resolves.toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
