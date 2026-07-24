import { describe, expect, it, vi } from 'vitest';
import {
  AutopilotDeliveryObservationRequestSchema,
  observeAutopilotMarketplaceDelivery,
} from '../../src/autopilot/marketplace-delivery-command.js';
import type {
  AutopilotMarketplaceDeliveryObserver,
} from '../../src/autopilot/marketplace-delivery-observer.js';
import {
  AutopilotDeliveryExpectationSchema,
  AutopilotDeliveryObservationSchema,
} from '@jinn-network/sdk/autopilot';

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
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
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
        targetBaseOid: '0'.repeat(40),
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
  it('uses the SDK expectation validator as its compatibility request export', () => {
    expect(AutopilotDeliveryObservationRequestSchema)
      .toBe(AutopilotDeliveryExpectationSchema);
  });

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
    const expected = request();
    const requestId = `0x${'3'.repeat(64)}`;
    const envelopeCid = 'bafy-envelope';
    const correlation = {
      taskId: '501',
      attemptIndex: 0,
      requestId,
      deliveryEnvelopeCid: envelopeCid,
      v2AttemptId: expected.session.v2AttemptId,
      claimOid: expected.session.claimOid,
      prNumber: expected.session.prNumber,
      expectedHead: expected.session.expectedHead,
    };
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
          requestId,
          operator: `0x${'4'.repeat(40)}`,
          createdAtBlock: 124,
        },
        delivery: {
          envelopeCid,
          envelopeDigest: `0x${'5'.repeat(64)}`,
          publisherAgentId: '7',
          transactionHash: `0x${'6'.repeat(64)}`,
          blockNumber: 125n,
        },
        envelope: {
          schemaVersion: 'jinn.execution.v1',
          solverType: 'jinn-repo.v1',
          role: 'solution',
          participant: {
            safeAddress: `0x${'4'.repeat(40)}`,
            agentEoa: `0x${'8'.repeat(40)}`,
          },
          signature: {
            signer: `0x${'8'.repeat(40)}`,
          },
          payload: { candidateControlled: true },
        },
        result: {
          schemaVersion: 'jinn-autopilot-mutation-result.v1',
          outcome: 'human',
          correlation,
          reason: {
            code: 'test-human',
            detail: 'Human intervention is required.',
          },
        },
        correlation,
      }),
    };
    const observation = await observeAutopilotMarketplaceDelivery(expected, {
      chainId: 84532,
      observer,
      latestBlockNumber: async () => 456n,
    });

    expect(observation).toMatchObject({
      status: 'verified',
      delivery: { blockNumber: 125 },
      session: expected.session,
      envelope: {
        cid: envelopeCid,
        digest: `0x${'5'.repeat(64)}`,
        executionSchema: 'jinn.execution.v1',
        solverType: 'jinn-repo.v1',
        role: 'solution',
        participant: {
          safeAddress: `0x${'4'.repeat(40)}`,
          agentEoa: `0x${'8'.repeat(40)}`,
        },
        signer: `0x${'8'.repeat(40)}`,
      },
    });
    expect(observation.envelope).not.toHaveProperty('payload');
    expect(AutopilotDeliveryObservationSchema.parse(observation))
      .toEqual(observation);
    expect(() => JSON.stringify(observation)).not.toThrow();
  });
});
