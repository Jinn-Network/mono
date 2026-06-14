/**
 * Tests for OnchainDiscoveryAPI.getTaskStatuses (#579).
 *
 * The on-chain floor cannot cheaply reconstruct finalized state, so it returns
 * an empty Map — callers render 'unknown', the safe degraded default.
 */
import { describe, it, expect } from 'vitest';
import { createOnchainDiscoveryAPI } from '../../src/discovery/onchain.js';

describe('OnchainDiscoveryAPI.getTaskStatuses (#579)', () => {
  it('returns an empty Map (floor cannot reconstruct finalized state)', async () => {
    const api = createOnchainDiscoveryAPI({
      rpcUrl: 'http://127.0.0.1:65535',
      chainId: 84532,
    });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafyany' });
    expect(statuses).toBeInstanceOf(Map);
    expect(statuses.size).toBe(0);
  });
});
