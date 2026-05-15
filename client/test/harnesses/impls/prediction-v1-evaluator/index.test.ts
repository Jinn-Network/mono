import { describe, expect, it } from 'vitest';
import { PredictionV1Evaluator } from '../../../../src/harnesses/impls/prediction-v1-evaluator/index.js';
import { PredictionV1VerdictPayloadSchema } from '../../../../src/types/payloads/prediction-v1.js';
import { makeHarnessCtx } from '../../../_support/harness-ctx.js';
import {
  makeEvalTask,
  makePredictionV1Task,
  makeSignedSolutionEnvelope,
} from '../prediction-v1-test-helpers.js';
import { SOLUTION_TASK_CID_CONTEXT_KEY } from '../../../../src/harnesses/impls/evaluation-context.js';

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

  it('rejects invalid parseable probabilities without scoring', async () => {
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
    expect(out.gating).not.toHaveProperty('solverBrier');
    expect(payload.checks).toContainEqual(expect.objectContaining({
      name: 'solution.schema',
      status: 'FAIL',
    }));
  });

  it('rejects forged solution envelopes before scoring', async () => {
    const task = makePredictionV1Task();
    const envelope = await makeSignedSolutionEnvelope(task);
    const tamperedEnvelope = {
      ...envelope,
      payload: {
        ...envelope.payload,
        probabilityYes: '0.0100',
      },
    };

    const out = await new PredictionV1Evaluator({
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
    }).run(makeHarnessCtx({ task: makeEvalTask(task, tamperedEnvelope as typeof envelope) }));
    const payload = PredictionV1VerdictPayloadSchema.parse(out.verdictPayload);

    expect(payload.verdict).toBe('REJECTED');
    expect(payload.scores).toBeUndefined();
    expect(payload.checks).toContainEqual(expect.objectContaining({
      name: 'integrity.manifest_signature',
      status: 'FAIL',
    }));
  });

  it('does not score when solution task CID context is missing', async () => {
    const task = makePredictionV1Task();
    const envelope = await makeSignedSolutionEnvelope(task);
    const evalTask = makeEvalTask(task, envelope);
    delete evalTask.context![SOLUTION_TASK_CID_CONTEXT_KEY];
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

    await expect(evaluator.canAttempt(evalTask)).resolves.toEqual({
      ok: false,
      reason: 'context.solutionTaskCid required',
    });
    const out = await evaluator.run(makeHarnessCtx({ task: evalTask }));
    const payload = PredictionV1VerdictPayloadSchema.parse(out.verdictPayload);

    expect(payload.verdict).toBe('INDETERMINATE');
    expect(payload.scores).toBeUndefined();
    expect(payload.checks).toContainEqual(expect.objectContaining({
      name: 'integrity.signedTask_ref',
      status: 'INDETERMINATE',
    }));
  });

  it('rejects resolution snapshots that do not match task market identifiers', async () => {
    const task = makePredictionV1Task();
    const envelope = await makeSignedSolutionEnvelope(task);

    const out = await new PredictionV1Evaluator({
      _testDeps: {
        getResolution: async () => ({
          venue: 'polymarket',
          marketId: 'mkt-1',
          conditionId: '0xother',
          status: 'resolved',
          outcome: 'YES',
          sourceUrl: 'https://polymarket.com/event/test-market',
        }),
      },
    }).run(makeHarnessCtx({ task: makeEvalTask(task, envelope) }));
    const payload = PredictionV1VerdictPayloadSchema.parse(out.verdictPayload);

    expect(payload.verdict).toBe('REJECTED');
    expect(payload.scores).toBeUndefined();
    expect(payload.checks).toContainEqual(expect.objectContaining({
      name: 'market.identity',
      status: 'FAIL',
    }));
  });

  it('marks unresolved markets INDETERMINATE without scores', async () => {
    const task = makePredictionV1Task();
    const envelope = await makeSignedSolutionEnvelope(task);

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
    const payload = PredictionV1VerdictPayloadSchema.parse(unresolved.verdictPayload);

    expect(payload.verdict).toBe('INDETERMINATE');
    expect(payload.scores).toBeUndefined();
    expect(unresolved.gating).not.toHaveProperty('solverBrier');
    expect(payload.checks).toContainEqual({
      name: 'market.resolution',
      status: 'INDETERMINATE',
    });
  });

  it.each(['invalid', 'cancelled', 'ambiguous'] as const)(
    'marks %s market resolutions INVALID without scores and records a failed check',
    async (status) => {
      const task = makePredictionV1Task();
      const envelope = await makeSignedSolutionEnvelope(task);

      const out = await new PredictionV1Evaluator({
        _testDeps: {
          getResolution: async () => ({
            venue: 'polymarket',
            marketId: 'mkt-1',
            conditionId: '0xabc',
            status,
            sourceUrl: 'https://polymarket.com/event/test-market',
          }),
        },
      }).run(makeHarnessCtx({ task: makeEvalTask(task, envelope) }));
      const payload = PredictionV1VerdictPayloadSchema.parse(out.verdictPayload);

      expect(payload.verdict).toBe('INVALID');
      expect(payload.scores).toBeUndefined();
      expect(out.gating).not.toHaveProperty('solverBrier');
      expect(payload.checks).toContainEqual({
        name: 'market.resolution',
        status: 'FAIL',
        detail: status,
      });
    },
  );
});
