import { describe, expect, it, vi } from 'vitest';

import { createOnchainDiscoveryAPI } from '../../src/discovery/onchain.js';
import {
  DiscoveryUnavailableError,
  type AutopilotDeliveryCandidateLookup,
  type DiscoveryAPI,
} from '../../src/discovery/types.js';
import { withFallback } from '../../src/discovery/with-fallback.js';

const query = { chainId: 84532, taskId: '501', role: 'solution' as const };

describe('exact Autopilot delivery discovery fallback policy', () => {
  it('reports the on-chain floor as explicitly unavailable without fabricating candidates', async () => {
    const api = createOnchainDiscoveryAPI({
      chainId: query.chainId,
      rpcUrl: 'http://127.0.0.1:65535',
    });

    await expect(api.getAutopilotDeliveryCandidates(query)).resolves.toEqual({
      status: 'pending',
      reason: 'exact-indexer-required',
      taskId: query.taskId,
      role: query.role,
    });
  });

  it('does not turn an indexer outage into a fabricated floor result', async () => {
    const floorResult: AutopilotDeliveryCandidateLookup = {
      status: 'pending',
      reason: 'exact-indexer-required',
      taskId: query.taskId,
      role: query.role,
    };
    const primary = {
      getAutopilotDeliveryCandidates: vi.fn(async () => {
        throw new DiscoveryUnavailableError('indexer down');
      }),
    } as unknown as DiscoveryAPI;
    const floor = {
      getAutopilotDeliveryCandidates: vi.fn(async () => floorResult),
    } as unknown as DiscoveryAPI;

    const api = withFallback(primary, floor);

    await expect(api.getAutopilotDeliveryCandidates(query))
      .rejects.toThrow(DiscoveryUnavailableError);
    expect(floor.getAutopilotDeliveryCandidates).not.toHaveBeenCalled();
  });
});
