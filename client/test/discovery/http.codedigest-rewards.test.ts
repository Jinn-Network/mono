import { describe, expect, it, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';

const BASE_URL = 'http://localhost:42069';

describe('getCodeDigestRewards', () => {
  it('fails closed without querying permissionless metadata projections', async () => {
    const fetchImpl = vi.fn();
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getCodeDigestRewards({
      codeDigests: ['sha256:target'],
      solverNetManifestCid: 'bafy-victim',
      window: 10,
    })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cannot verify a sole fabricated attempt/verdict projection', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        attemptEnvelopeMetas: {
          items: [{
            requestId: '0xforged',
            chainId: 84532,
            codeDigest: 'sha256:target',
          }],
        },
        verdictEnvelopeMetas: {
          items: [{
            requestId: '0xforged',
            chainId: 84532,
            actualPassed: true,
            actualScore: '1',
            passedCount: 1,
            totalCount: 1,
          }],
        },
      },
    }))) as unknown as typeof fetch;
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl });

    await expect(client.getCodeDigestRewards({
      codeDigests: ['sha256:target'],
    })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('short-circuits an empty digest list', async () => {
    const fetchImpl = vi.fn();
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getCodeDigestRewards({ codeDigests: [] }))
      .resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
