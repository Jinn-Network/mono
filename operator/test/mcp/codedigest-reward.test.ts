import { describe, it, expect, vi } from 'vitest';
import { handleGetCodeDigestReward } from '../../src/mcp/get-codedigest-reward.js';
import { DiscoveryUnavailableError, type DiscoveryClient } from '../../src/discovery-client/types.js';

describe('handleGetCodeDigestReward (#764)', () => {
  it('returns ok:true with aggregated rows', async () => {
    const discovery = {
      getCodeDigestRewards: vi.fn(async () => [
        { codeDigest: 'sha256:A', attempts: 10, passes: 7, passRate: 0.7, avgScore: 0.6 },
      ]),
    } as unknown as DiscoveryClient;
    const out = await handleGetCodeDigestReward(discovery, { codeDigests: ['sha256:A'] });
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(1);
  });

  it('returns a structured discovery_unavailable error (no throw)', async () => {
    const discovery = {
      getCodeDigestRewards: vi.fn(async () => { throw new DiscoveryUnavailableError('down'); }),
    } as unknown as DiscoveryClient;
    const out = await handleGetCodeDigestReward(discovery, { codeDigests: ['sha256:A'] });
    expect(out.ok).toBe(false);
    expect((out.error as { kind: string }).kind).toBe('discovery_unavailable');
    expect(out.rows).toEqual([]);
  });

  it('returns a structured no_discovery error when discovery is null', async () => {
    const out = await handleGetCodeDigestReward(null, { codeDigests: ['sha256:A'] });
    expect(out.ok).toBe(false);
    expect((out.error as { kind: string }).kind).toBe('no_discovery');
  });

  it('rethrows non-DiscoveryUnavailable errors', async () => {
    const discovery = {
      getCodeDigestRewards: vi.fn(async () => { throw new Error('unexpected'); }),
    } as unknown as DiscoveryClient;
    await expect(handleGetCodeDigestReward(discovery, { codeDigests: ['sha256:A'] })).rejects.toThrow('unexpected');
  });
});
