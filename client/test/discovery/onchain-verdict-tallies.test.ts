/**
 * Tests for OnchainDiscoveryAPI.getVerdictTallies (#502).
 *
 * The on-chain floor cannot decode the IPFS-enrichment-backed verdict poles, so
 * it returns an empty Map — callers render 'awaiting', the safe degraded default.
 */
import { describe, it, expect } from 'vitest';
import { createOnchainDiscoveryAPI } from '../../src/discovery/onchain.js';

describe('OnchainDiscoveryAPI.getVerdictTallies (#502)', () => {
  it('returns an empty Map (floor cannot reconstruct verdict poles)', async () => {
    const api = createOnchainDiscoveryAPI({
      rpcUrl: 'http://127.0.0.1:65535',
      chainId: 84532,
    });
    const tallies = await api.getVerdictTallies({ taskIds: ['100', '101'] });
    expect(tallies).toBeInstanceOf(Map);
    expect(tallies.size).toBe(0);
  });
});
