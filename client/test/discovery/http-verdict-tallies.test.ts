import { describe, expect, it, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';

describe('HttpDiscoveryAPI.getVerdictTallies (#502)', () => {
  it('fails closed without querying permissionless verdict projections', async () => {
    const fetchImpl = vi.fn();
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(api.getVerdictTallies({ taskIds: ['100'] }))
      .resolves.toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cannot turn a sole fabricated projection into an activity tally', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        verdictEnvelopeMetas: {
          items: [{
            taskId: '100',
            evaluatorVerdict: 'PASS',
            chainId: 84532,
            requestId: '0xforged',
          }],
        },
      },
    }))) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl,
    });

    await expect(api.getVerdictTallies({ taskIds: ['100'] }))
      .resolves.toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('short-circuits an empty task list', async () => {
    const fetchImpl = vi.fn();
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(api.getVerdictTallies({ taskIds: [] }))
      .resolves.toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
