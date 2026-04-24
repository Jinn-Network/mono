import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PredictionV0BaselineImpl } from '../../../../src/restorer/impls/prediction-v0-baseline/index.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';

function makeCtx(overrides: Partial<RestorationContext> = {}): RestorationContext {
  const tmp = mkdtempSync(join(tmpdir(), 'pred-baseline-'));
  return {
    intent: {
      id: 'test-1',
      description: 'ETH > 3500 at T',
      type: 'restoration',
      window: { startTs: 0, endTs: 3_600_000 },
      spec: {
        kind: 'prediction.v0',
        oracle: { venue: 'chainlink-base-sepolia', feed: '0x000000000000000000000000000000000000feed', feedDescription: 'ETH / USD' },
        question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: 4_500_000 },
      },
      eligibility: { maxSubmissionDelayMs: 60_000 },
    } as any,
    implStateDir: tmp,
    workingDir: tmp,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 3_600_000,
    ...overrides,
  };
}

function stubDeps(price: string) {
  return {
    readChainlink: async () => ({
      roundId: 42n,
      answer: BigInt(Math.round(parseFloat(price) * 1e8)),
      startedAt: 0,
      updatedAt: 1000,
      answeredInRound: 42n,
      decimals: 8,
    }),
  };
}

describe('PredictionV0BaselineImpl', () => {
  it('supports only prediction.v0 restorations', () => {
    const impl = new PredictionV0BaselineImpl({ _testDeps: stubDeps('3600') });
    expect(impl.supports({ kind: 'prediction.v0', type: 'restoration' })).toBe(true);
    expect(impl.supports({ kind: 'prediction.v0', type: 'evaluation' })).toBe(false);
    expect(impl.supports({ kind: 'portfolio.v0', type: 'restoration' })).toBe(false);
  });

  it('writes prediction.json with probability 0.55 when current price > threshold (GT)', async () => {
    const impl = new PredictionV0BaselineImpl({ _testDeps: stubDeps('3600') });
    const ctx = makeCtx();
    const out = await impl.run(ctx);
    expect(out.gating.probability).toBe('0.55');
    const predictionJson = JSON.parse(readFileSync(join(ctx.workingDir, 'prediction.json'), 'utf8'));
    expect(predictionJson.probability).toBe('0.55');
    expect(predictionJson.modelId).toBe('spot-carry.v1');
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts![0].path).toBe('prediction.json');
    expect(out.artifacts![0].artifactType).toBe('prediction_submission');
  });

  it('returns oracleSnapshot in informational', async () => {
    const impl = new PredictionV0BaselineImpl({ _testDeps: stubDeps('3400') });
    const out = await impl.run(makeCtx());
    expect(out.informational?.oracleSnapshot).toMatchObject({ feed: expect.any(String), answer: expect.any(String) });
  });

  it('populates restorationPayload matching PredictionV0RestorationPayloadSchema', async () => {
    const { PredictionV0RestorationPayloadSchema } = await import('../../../../src/types/payloads/prediction-v0.js');
    const impl = new PredictionV0BaselineImpl({ _testDeps: stubDeps('3600') });
    const out = await impl.run(makeCtx());
    expect(out.restorationPayload).toBeDefined();
    const parsed = PredictionV0RestorationPayloadSchema.safeParse(out.restorationPayload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.prediction.probability).toBe('0.55');
      expect(typeof parsed.data.prediction.submittedAt).toBe('number');
      expect(parsed.data.oracleSnapshot).toBeDefined();
      expect(parsed.data.oracleSnapshot?.feed).toBe('0x000000000000000000000000000000000000feed');
    }
  });
});
