import { describe, expect, it } from 'vitest';
import { parseApplicationDeliveryCommandResult } from '../../src/cli/commands/tasks-observe-application.js';

describe('tasks observe-application-delivery protocol', () => {
  it('preserves an opaque verdict and its generic projection', () => {
    const value = {
      schemaVersion: 1,
      generatedAt: '2026-08-07T10:00:00.000Z',
      verb: 'tasks observe-application-delivery',
      observation: {
        status: 'verified',
        role: 'verdict',
        task: { taskId: '1', taskCid: 'f01551220' + 'a'.repeat(64) },
        attempt: {
          attemptIndex: 0,
          requestId: '0x' + 'b'.repeat(64),
          operator: '0x' + 'c'.repeat(40),
        },
        delivery: {
          envelopeCid: 'f01551220' + 'd'.repeat(64),
          transactionHash: '0x' + 'e'.repeat(64),
          blockNumber: 20,
        },
        payload: {
          schemaVersion: 'jinn-repo-application-payload.v1',
          application: { id: 'autopilot.issue-relay', version: 'v2' },
          role: 'verdict',
          projection: 'pass',
          payload: { creatorOwned: true },
        },
      },
    };
    expect(parseApplicationDeliveryCommandResult(value)).toEqual(value);
  });
});
