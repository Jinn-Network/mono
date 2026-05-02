import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PredictionApyV0BaselineImpl } from '../../../../src/harnesses/impls/prediction-apy-v0-baseline/index.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

function makeCtx(overrides: Partial<HarnessContext> = {}): HarnessContext {
  const tmp = mkdtempSync(join(tmpdir(), 'apy-baseline-'));
  const now = Date.now();
  const startTs = now;
  const endTs = startTs + 3_600_000;
  const resolveTs = endTs + 900_000;
  return {
task: {
      id: 'test-apy-baseline-1',
      description: 'USDC supply APY TWA',
      window: { startTs, endTs },
      spec: {
        kind: 'prediction.apy.v0',
        oracle: {
          venue: 'aave-v3-base-sepolia',
          pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
          reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
          reserveSymbol: 'USDC',
        },
        metric: {
          type: 'supply-apy-twa-bps',
          twaWindowSeconds: 3600,
          sampleCount: 12,
          toleranceBps: 50,
        },
        question: { resolveTs },
      },
      eligibility: { maxSubmissionDelayMs: 60_000 },
    } as unknown as import('../../../../src/types/task.js').Task,
    implStateDir: tmp,
    workingDir: tmp,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 3_600_000,
    ...overrides,
  };
}

function stubDeps(twApyBps: number) {
  return {
    twApyBpsOverWindow: async () => ({ twApyBps, sampleCount: 12 }),
  };
}

describe('PredictionApyV0BaselineImpl', () => {
  it('supports only prediction.apy.v0 restorations', () => {
    const impl = new PredictionApyV0BaselineImpl({ _testDeps: stubDeps(350) });
    expect(impl.supports({ solverType: 'prediction.apy.v0', role: 'restoration' })).toBe(true);
    expect(impl.supports({ solverType: 'prediction.apy.v0' })).toBe(true);
    expect(impl.supports({ solverType: 'prediction.apy.v0', role: 'evaluation' })).toBe(false);
    expect(impl.supports({ solverType: 'prediction.v0', role: 'restoration' })).toBe(false);
  });

  it('writes prediction-apy.json and returns expected gating fields', async () => {
    const impl = new PredictionApyV0BaselineImpl({ _testDeps: stubDeps(350) });
    const ctx = makeCtx();
    const out = await impl.run(ctx);

    expect(out.gating.predictedBps).toBe('350');
    expect(out.gating.modelId).toBe('apy-persistence.v1');
    expect(typeof out.gating.submittedAt).toBe('string');

    const predictionJson = JSON.parse(readFileSync(join(ctx.workingDir, 'prediction-apy.json'), 'utf8'));
    expect(predictionJson.predictedBps).toBe('350');
    expect(predictionJson.modelId).toBe('apy-persistence.v1');

    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts![0]!.path).toBe('prediction-apy.json');
    expect(out.artifacts![0]!.artifactType).toBe('prediction_submission');
  });

  it('returns twApyBps and sampleCount in informational', async () => {
    const impl = new PredictionApyV0BaselineImpl({ _testDeps: stubDeps(425) });
    const out = await impl.run(makeCtx());
    expect(out.informational?.twApyBps).toBe(425);
    expect(out.informational?.sampleCount).toBe(12);
  });

  it('populates solutionPayload matching PredictionApyV0RestorationPayloadSchema', async () => {
    const { PredictionApyV0RestorationPayloadSchema } = await import('../../../../src/types/payloads/prediction-apy-v0.js');
    const impl = new PredictionApyV0BaselineImpl({ _testDeps: stubDeps(350) });
    const out = await impl.run(makeCtx());

    expect(out.solutionPayload).toBeDefined();
    const parsed = PredictionApyV0RestorationPayloadSchema.safeParse(out.solutionPayload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.prediction.predictedBps).toBe('350');
      expect(typeof parsed.data.prediction.submittedAt).toBe('number');
      expect(parsed.data.prediction.modelId).toBe('apy-persistence.v1');
    }
  });

  it('canAttempt rejects intents with an already-closed window', async () => {
    const impl = new PredictionApyV0BaselineImpl();
    const ctx = makeCtx();
    const startTs = 1_000_000;
    const endTs = startTs + 3_600_000;
    const resolveTs = endTs + 900_000;
    (ctx.task as unknown as Record<string, unknown>).window = { startTs, endTs };
    (ctx.task as unknown as Record<string, Record<string, Record<string, unknown>>>).spec.question.resolveTs = resolveTs;
    const r = await impl.canAttempt(ctx.task);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/window already closed/);
  });
});
