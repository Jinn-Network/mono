import { describe, expect, it } from 'vitest';
import { runLocalTaskFirstLifecycle } from './e2e/task-first-helpers.js';

describe('Task-first local lifecycle', () => {
  it('runs Task -> Solution -> Verdict through the local Task-native adapter/store path', async () => {
    const result = await runLocalTaskFirstLifecycle();

    expect(result.postedTaskId).toBe(result.request.taskId);
    expect(result.request.attemptIndex).toBe(0);
    expect(result.solutionDelivery.requestId).toBe(result.request.requestId);
    expect(result.solutionDelivery.task.role).toBe('restoration');

    expect(result.verdictRequest.task.role).toBe('evaluation');
    expect(result.verdictRequest.task.restorationRequestId).toBe(result.request.requestId);
    expect(result.verdictDelivery.requestId).toBe(result.verdictRequest.requestId);
    expect(result.verdictDelivery.task.role).toBe('evaluation');
    expect(result.verdict).toBe('SCORED');
    expect(result.score).toMatch(/^-?\d+(\.\d+)?$/);

    expect(result.conditionId).toBe('0xcondition-task-first-e2e');
    expect(result.attempts).toHaveLength(2);
    expect(new Set(result.attempts.map((attempt) => attempt.sharedTaskId))).toEqual(new Set([result.postedTaskId]));
    expect(new Set(result.attempts.map((attempt) => attempt.sharedTaskCid))).toEqual(new Set([result.postedTaskCid]));
    expect(new Set(result.attempts.map((attempt) => attempt.conditionId))).toEqual(new Set([result.conditionId]));
    expect(new Set(result.attempts.map((attempt) => attempt.solverSafeAddress)).size).toBe(2);
    expect(new Set(result.attempts.map((attempt) => attempt.request.requestId)).size).toBe(2);
    expect(result.attempts.map((attempt) => attempt.request.attemptIndex)).toEqual([0, 1]);
    for (const attempt of result.attempts) {
      expect(attempt.solutionPayload).toHaveProperty('probabilityYes');
      expect(attempt.solutionEnvelope.role).toBe('solution');
      expect(attempt.solutionEnvelope.payload).toEqual(attempt.solutionPayload);
      expect(attempt.verdict).toBe('SCORED');
      expect(attempt.verdictPayload).toMatchObject({
        verdict: 'SCORED',
        outcome: 'YES',
        benchmark: {
          probabilityYes: result.consensusSnapshot['probabilityYes'],
          sampledAt: result.consensusSnapshot['sampledAt'],
          method: result.consensusSnapshot['method'],
        },
      });
      expect(attempt.verdictRequest.task.restorationRequestId).toBe(attempt.request.requestId);
      expect(attempt.verdictDelivery.requestId).toBe(attempt.verdictRequest.requestId);
    }

    expect(result.secondRequest.taskId).toBe(result.postedTaskId);
    expect(result.secondRequest.attemptIndex).toBe(1);
    expect(result.secondRequest.requestId).not.toBe(result.request.requestId);
  });
});
