import { describe, it, expect } from 'vitest';
import { createOnchainDiscoveryAPI } from '../../src/discovery/onchain.js';

describe('OnchainDiscoveryAPI.getCodeDigestRewards (#764)', () => {
  it('returns an empty array (floor cannot reconstruct IPFS-enriched aggregates)', async () => {
    // Construct cheaply — the stub never makes RPC calls.
    const api = createOnchainDiscoveryAPI({
      rpcUrl: 'http://127.0.0.1:65535',
      chainId: 84532,
    });
    const rows = await api.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
    expect(rows).toEqual([]);
  });
});
