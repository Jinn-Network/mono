import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PredictionV1BaselineImpl } from '../../../../src/harnesses/impls/prediction-v1-baseline/index.js';
import { PredictionV1RestorationPayloadSchema } from '../../../../src/types/payloads/prediction-v1.js';
import { makeHarnessCtx } from '../../../_support/harness-ctx.js';
import { makePredictionV1Task } from '../prediction-v1-test-helpers.js';

describe('PredictionV1BaselineImpl', () => {
  it('supports only prediction.v1 restoration tasks', () => {
    const impl = new PredictionV1BaselineImpl();
    expect(impl.supports({ solverType: 'prediction.v1', role: 'restoration' })).toBe(true);
    expect(impl.supports({ solverType: 'prediction.v1', role: 'evaluation' })).toBe(false);
    expect(impl.supports({ solverType: 'prediction.v0', role: 'restoration' })).toBe(false);
  });

  it('emits a schema-valid probability from the Task consensus snapshot', async () => {
    const task = makePredictionV1Task();
    const impl = new PredictionV1BaselineImpl();
    const out = await impl.run(makeHarnessCtx({ task }));

    expect(out.gating).toMatchObject({
      probabilityYes: '0.6200',
      modelId: 'prediction-v1-baseline/consensus',
    });
    const payload = PredictionV1RestorationPayloadSchema.parse(out.solutionPayload);
    expect(payload.probabilityYes).toBe('0.6200');
    expect(payload.format).toBe('decimal');
    expect(existsSync(join((out.artifacts![0] as any).path))).toBe(false);
  });

  it('writes the solution payload without requiring venue reads', async () => {
    const task = makePredictionV1Task();
    const ctx = makeHarnessCtx({ task });
    const impl = new PredictionV1BaselineImpl();

    const out = await impl.run(ctx);
    const payloadPath = join(ctx.workingDir, 'prediction-v1-solution.json');
    const payload = JSON.parse(readFileSync(payloadPath, 'utf-8'));

    expect(out.gating.probabilityYes).toBe('0.6200');
    expect(payload.probabilityYes).toBe('0.6200');
  });
});
