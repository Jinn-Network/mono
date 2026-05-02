import { describe, expect, it } from 'vitest';
import { PredictionV1Evaluator } from '../../../../src/harnesses/impls/prediction-v1-evaluator/index.js';
import { PredictionV1VerdictPayloadSchema } from '../../../../src/types/payloads/prediction-v1.js';
import { makeHarnessCtx } from '../../../_support/harness-ctx.js';
import {
  makeEvalTask,
  makePredictionV1Task,
  makeSignedSolutionEnvelope,
} from '../prediction-v1-test-helpers.js';

describe('PredictionV1Evaluator', () => {
  it('scores valid YES resolutions with Brier loss against consensus', async () => {
    const task = makePredictionV1Task();
    const envelope = await makeSignedSolutionEnvelope(task, {
      probabilityYes: '0.5700',
      submittedAt: '2026-05-02T01:00:00.000Z',
      format: 'decimal',
      modelId: 'solver-a',
    });
    const evaluator = new PredictionV1Evaluator({
      _testDeps: {
        getResolution: async () => ({
          venue: 'polymarket',
          marketId: 'mkt-1',
          conditionId: '0xabc',
          status: 'resolved',
          outcome: 'YES',
          resolvedAt: '2026-05-04T00:00:00.000Z',
          sourceUrl: 'https://polymarket.com/event/test-market',
        }),
      },
    });

    const out = await evaluator.run(makeHarnessCtx({
      task: makeEvalTask(task, envelope),
      taskCid: 'eval-task-cid',
    }));

    expect(out.gating).toMatchObject({
      verdict: 'SCORED',
      outcome: 'YES',
      solverBrier: '0.184900',
      consensusBrier: '0.144400',
      brierSpread: '0.040500',
    });
    const payload = PredictionV1VerdictPayloadSchema.parse(out.verdictPayload);
    expect(payload.scores).toEqual({
      scoreBasis: 'brier-loss.v1',
      solverBrier: '0.184900',
      consensusBrier: '0.144400',
      brierSpread: '0.040500',
    });
    expect(payload.solutionEnvelope.cid).toBe('bafy-solution-envelope');
  });

  it('rejects malformed probabilities without scoring', async () => {
    const task = makePredictionV1Task();
    const envelope = await makeSignedSolutionEnvelope(task, {
      probabilityYes: '1.2',
      submittedAt: '2026-05-02T01:00:00.000Z',
      format: 'decimal',
      modelId: 'solver-a',
    });
    const evaluator = new PredictionV1Evaluator({
      _testDeps: {
        getResolution: async () => ({
          venue: 'polymarket',
          marketId: 'mkt-1',
          conditionId: '0xabc',
          status: 'resolved',
          outcome: 'YES',
          sourceUrl: 'https://polymarket.com/event/test-market',
        }),
      },
    });

    const out = await evaluator.run(makeHarnessCtx({ task: makeEvalTask(task, envelope) }));
    const payload = PredictionV1VerdictPayloadSchema.parse(out.verdictPayload);

    expect(payload.verdict).toBe('REJECTED');
    expect(payload.scores).toBeUndefined();
    expect(payload.checks.some((check) => check.status === 'FAIL')).toBe(true);
  });

  it('marks invalid and unresolved markets as non-scored verdicts', async () => {
    const task = makePredictionV1Task();
    const envelope = await makeSignedSolutionEnvelope(task);

    const invalid = await new PredictionV1Evaluator({
      _testDeps: {
        getResolution: async () => ({
          venue: 'polymarket',
          marketId: 'mkt-1',
          conditionId: '0xabc',
          status: 'invalid',
          sourceUrl: 'https://polymarket.com/event/test-market',
        }),
      },
    }).run(makeHarnessCtx({ task: makeEvalTask(task, envelope) }));
    expect(PredictionV1VerdictPayloadSchema.parse(invalid.verdictPayload).verdict).toBe('INVALID');

    const unresolved = await new PredictionV1Evaluator({
      _testDeps: {
        getResolution: async () => ({
          venue: 'polymarket',
          marketId: 'mkt-1',
          conditionId: '0xabc',
          status: 'unresolved',
          sourceUrl: 'https://polymarket.com/event/test-market',
        }),
      },
    }).run(makeHarnessCtx({ task: makeEvalTask(task, envelope) }));
    expect(PredictionV1VerdictPayloadSchema.parse(unresolved.verdictPayload).verdict).toBe('INDETERMINATE');
  });
});
