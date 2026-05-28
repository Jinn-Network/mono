import { describe, it, expect, vi } from 'vitest';
import { withFallback } from '../../src/discovery/with-fallback.js';
import { DiscoveryUnavailableError, type DiscoveryAPI } from '../../src/discovery/types.js';

describe('withFallback.getCodeDigestRewards (#764)', () => {
  it('uses primary on success and never calls the floor', async () => {
    const primary = {
      getCodeDigestRewards: vi.fn(async () => [
        { codeDigest: 'sha256:A', attempts: 1, passes: 1, passRate: 1, avgScore: 1 },
      ]),
    } as unknown as DiscoveryAPI;
    const floor = {
      getCodeDigestRewards: vi.fn(async () => []),
    } as unknown as DiscoveryAPI;
    const wrapped = withFallback(primary, floor);
    const rows = await wrapped.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
    expect(rows).toHaveLength(1);
    expect(floor.getCodeDigestRewards).not.toHaveBeenCalled();
  });

  it('propagates DiscoveryUnavailableError (never falls through to floor)', async () => {
    const primary = {
      getCodeDigestRewards: vi.fn(async () => {
        throw new DiscoveryUnavailableError('down');
      }),
    } as unknown as DiscoveryAPI;
    const floor = {
      getCodeDigestRewards: vi.fn(async () => [
        { codeDigest: 'x', attempts: 9, passes: 9, passRate: 1, avgScore: 1 },
      ]),
    } as unknown as DiscoveryAPI;
    const wrapped = withFallback(primary, floor);
    await expect(
      wrapped.getCodeDigestRewards({ codeDigests: ['x'] }),
    ).rejects.toBeInstanceOf(DiscoveryUnavailableError);
    expect(floor.getCodeDigestRewards).not.toHaveBeenCalled();
  });
});
