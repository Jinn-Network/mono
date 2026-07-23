import { describe, expect, it, vi } from 'vitest';
import {
  observeAutopilotMarketplaceDelivery,
} from '../../src/autopilot/marketplace-delivery-command.js';
import type {
  AutopilotMarketplaceDeliveryObserver,
} from '../../src/autopilot/marketplace-delivery-observer.js';

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'jinn-autopilot-delivery-observation-request.v1',
    role: 'solution',
    taskId: '501',
    taskCid: 'bafy-task',
    creationBlockNumber: 123,
    session: {
      schemaVersion: 'jinn-autopilot-session.v1',
      workflow: 'implement',
      repository: 'Jinn-Network/mono',
      issueNumber: 42,
      prNumber: 84,
      targetBase: 'next',
      branch: 'autopilot/42',
      claimOid: '1'.repeat(40),
      expectedHead: '1'.repeat(40),
      v2AttemptId: '11111111-1111-4111-8111-111111111111',
      runnerId: 'runner-a',
      taskSnapshot: {
        title: 'Implement the marketplace backend',
        body: 'Use the approved backend-neutral contract.',
        prBody: 'Closes #42',
        baseSha: '0'.repeat(40),
      },
      workflowContract: {
        skill: 'implement-issue',
        version: 'v2',
        resultSchema: 'jinn-autopilot-mutation-result.v1',
      },
      deadline: '2026-07-23T13:00:00.000Z',
      receiptAuthors: ['implementation-bot'],
    },
    ...overrides,
  };
}

describe('Autopilot marketplace delivery observation command', () => {
  it('anchors exact observation at Task creation and the latest chain block', async () => {
    const observe = vi.fn().mockResolvedValue({
      status: 'pending',
      reason: 'attempt-not-indexed',
    });
    const observer = { observe } satisfies AutopilotMarketplaceDeliveryObserver;

    await expect(observeAutopilotMarketplaceDelivery(request(), {
      chainId: 84532,
      observer,
      latestBlockNumber: async () => 456n,
    })).resolves.toEqual({
      status: 'pending',
      reason: 'attempt-not-indexed',
    });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      chainId: 84532,
      taskId: '501',
      fromBlock: 123n,
      toBlock: 456n,
    }));
  });

  it('requires paired attempt correlation and a solution operator for verdicts', async () => {
    const deps = {
      chainId: 84532,
      observer: { observe: vi.fn() } satisfies AutopilotMarketplaceDeliveryObserver,
      latestBlockNumber: async () => 456n,
    };
    await expect(observeAutopilotMarketplaceDelivery(
      request({ attemptIndex: 0 }),
      deps,
    )).rejects.toThrow('attemptIndex and requestId');
    await expect(observeAutopilotMarketplaceDelivery(
      request({ role: 'verdict' }),
      deps,
    )).rejects.toThrow('solutionOperator');
  });

  it('serializes the verified delivery block without losing precision', async () => {
    const observer: AutopilotMarketplaceDeliveryObserver = {
      observe: vi.fn().mockResolvedValue({
        status: 'verified',
        role: 'solution',
        task: {
          taskId: '501',
          taskCid: 'bafy-task',
          taskCidDigest: `0x${'1'.repeat(64)}`,
          createdAtBlock: 123,
          createdAtTx: `0x${'2'.repeat(64)}`,
        },
        attempt: {
          attemptIndex: 0,
          requestId: `0x${'3'.repeat(64)}`,
          operator: `0x${'4'.repeat(40)}`,
          createdAtBlock: 124,
        },
        delivery: {
          envelopeCid: 'bafy-envelope',
          envelopeDigest: `0x${'5'.repeat(64)}`,
          transactionHash: `0x${'6'.repeat(64)}`,
          blockNumber: 125n,
        },
        envelope: {},
        result: {},
        correlation: {},
      }),
    };
    const observation = await observeAutopilotMarketplaceDelivery(request(), {
      chainId: 84532,
      observer,
      latestBlockNumber: async () => 456n,
    });

    expect(observation).toMatchObject({
      status: 'verified',
      delivery: { blockNumber: 125 },
    });
    expect(() => JSON.stringify(observation)).not.toThrow();
  });
});
