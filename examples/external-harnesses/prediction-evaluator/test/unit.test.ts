import { describe, it, expect } from 'vitest';
import createEvaluator from '../src/index.js';
import type {
  ExternalHarnessEnv,
  HarnessContext,
} from '@jinn-network/sdk';

const env: ExternalHarnessEnv = {
  implName: '@jinn-examples/prediction-evaluator',
  implVersion: '0.1.0',
  network: 'base-sepolia',
  implStateDir: '/tmp/eval',
  secrets: Object.freeze({}),
  log: () => {},
  stub: false,
};

function makeCtx(
  taskId: string,
  forecastP: number | undefined,
): HarnessContext {
  return {
    task: {
      id: taskId,
      description: taskId,
      solverType: 'prediction.v0',
      role: 'evaluation',
      spec: {
        restorationUnderEvaluation:
          forecastP === undefined
            ? undefined
            : { forecastProbability: forecastP },
      },
    },
    taskCid: undefined,
    implStateDir: '/tmp/eval',
    workingDir: '/tmp/eval-work',
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => ({}) },
  };
}

describe('@jinn-examples/prediction-evaluator', () => {
  it('supports prediction.v0 only as evaluation', () => {
    const impl = createEvaluator(env);
    expect(impl.supports({ solverType: 'prediction.v0', role: 'evaluation' })).toBe(
      true,
    );
    expect(impl.supports({ solverType: 'prediction.v0', role: 'restoration' })).toBe(
      false,
    );
    expect(impl.supports({ solverType: 'other.v0', role: 'evaluation' })).toBe(false);
  });

  it('returns a numeric brier.v1 score for any forecast probability', async () => {
    const impl = createEvaluator(env);
    const out = await impl.run(makeCtx('eval-known-1', 0.7));
    expect(out.verdictPayload).toBeDefined();
    const v = out.verdictPayload as Record<string, unknown>;
    expect(v.scoringRule).toBe('brier.v1');
    expect(typeof v.score).toBe('number');
    expect(v.score as number).toBeGreaterThanOrEqual(0);
    expect(v.score as number).toBeLessThanOrEqual(1);
  });

  it('refuses with a structured error when restorationUnderEvaluation is missing', async () => {
    const impl = createEvaluator(env);
    const out = await impl.run(makeCtx('eval-known-2', undefined));
    const v = out.verdictPayload as Record<string, unknown>;
    expect(v.score).toBeNull();
    expect(v.error).toBe('missing restoration');
  });

  it('produces a deterministic score for the same Task + forecast', async () => {
    const impl = createEvaluator(env);
    const out1 = await impl.run(makeCtx('determinism-test', 0.6));
    const out2 = await impl.run(makeCtx('determinism-test', 0.6));
    const s1 = (out1.verdictPayload as Record<string, unknown>).score;
    const s2 = (out2.verdictPayload as Record<string, unknown>).score;
    expect(s1).toBe(s2);
  });

  it('reports stub readiness when env.stub=true', async () => {
    const impl = createEvaluator({ ...env, stub: true });
    const ready = await impl.isReady?.();
    expect(ready?.ready).toBe(false);
    expect(ready?.reason).toBe('stub mode');
  });

  it('reports ready when env.stub=false', async () => {
    const impl = createEvaluator({ ...env, stub: false });
    const ready = await impl.isReady?.();
    expect(ready?.ready).toBe(true);
  });
});
