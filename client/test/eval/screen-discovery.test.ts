import { describe, it, expect, vi } from 'vitest';
import { fetchAttemptedInstanceIds } from '../../src/eval/screen-discovery.js';

describe('fetchAttemptedInstanceIds', () => {
  it('aborts before querying permissionless attempted-instance projections', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchAttemptedInstanceIds(
      'https://idx.example',
      'bafy-victim',
      fetchImpl as unknown as typeof fetch,
    )).rejects.toThrow(/authenticated attempted-instance projection unavailable/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
