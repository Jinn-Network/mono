import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PredictionV0Evaluator } from '../../../../src/restorer/impls/prediction-v0-evaluator/index.js';
import { signCanonical } from '../../../../src/restorer/engine/signing.js';
import { makeValidIntent, makeSignedManifest, makeEvalDesiredState } from './test-helpers.js';

function makeCtx(intent: any, deps: any) {
  const tmp = mkdtempSync(join(tmpdir(), 'pred-eval-'));
  return {
    intent,
    intentCid: 'intent-cid',
    implStateDir: tmp,
    workingDir: tmp,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    _testDeps: deps,
  } as any;
}

function spanningDeps(priceAtResolve: string) {
  const answer = BigInt(Math.round(parseFloat(priceAtResolve) * 1e8));
  return {
    oraclePriceAtResolveTs: async () => ({
      round: { roundId: 1n, answer, startedAt: 4_499_999, updatedAt: 4_499_999, answeredInRound: 1n, decimals: 8 },
      nextRound: { roundId: 2n, answer: 0n, startedAt: 4_500_001, updatedAt: 4_500_001, answeredInRound: 2n, decimals: 8 },
      spanning: true,
    }),
  };
}

describe('PredictionV0Evaluator — verdict pipeline', () => {
  const evaluatorPk = ('0x' + 'e'.repeat(64)) as `0x${string}`;

  it('PASS with correct prediction (p=0.55, oracle > threshold)', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, intentCid: 'intent-cid' });
    const evalIntent = makeEvalDesiredState(manifest, intent);
    const evaluator = new PredictionV0Evaluator({
      evaluatorPk,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('PASS');
    expect(out.gating.score).toBe('797500000000000000');
    expect(out.gating.groundTruth).toBe('YES');
  });

  it('accepts the engine outer manifest produced by prediction restorations', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, intentCid: 'intent-cid' });
    const pk = ('0x' + '1'.repeat(64)) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    const unsignedOuter: Record<string, unknown> = {
      schemaVersion: 'portfolio.v0.manifest.v1',
      generatedAt: manifest.generatedAt,
      intent: manifest.intent,
      restorer: manifest.restorer,
      window: manifest.window,
      preSnapshot: { schemaVersion: 1, capturedAt: 0, venue: { name: 'chainlink' }, account: {}, positions: [], openOrders: [] },
      postSnapshot: { schemaVersion: 1, capturedAt: 0, venue: { name: 'chainlink' }, account: {}, positions: [], openOrders: [] },
      fills: [],
      gating: manifest.prediction,
      artifacts: [],
    };
    const s = await signCanonical(unsignedOuter, pk, account.address);
    const outerManifest = {
      ...unsignedOuter,
      signature: { algo: 'secp256k1' as const, signer: account.address, hash: s.hash, sig: s.sig },
    };
    const evalIntent = makeEvalDesiredState(outerManifest, intent);
    const evaluator = new PredictionV0Evaluator({
      evaluatorPk,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });

    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));

    expect(out.gating.verdict).toBe('PASS');
    expect(out.artifacts[0]?.metadata).toMatchObject({ schemaVersion: 'prediction.v0.verdict.v1' });
  });

  it('REJECTED when submittedAt > window.endTs', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ submittedAt: intent.window.endTs + 1, intentCid: 'intent-cid' });
    const evalIntent = makeEvalDesiredState(manifest, intent);
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('REJECTED');
    expect(out.gating.score).toBe('0');
  });

  it('FAIL on bad signature', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ corruptSignature: true, intentCid: 'intent-cid' });
    const evalIntent = makeEvalDesiredState(manifest, intent);
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('FAIL');
    expect(out.gating.score).toBe('0');
  });

  it('INDETERMINATE when context.restorationIntentCid is missing (legacy eval payload)', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ intentCid: 'intent-cid' });
    const evalIntent = makeEvalDesiredState(manifest, intent, { omitRestorationIntentCid: true });
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('INDETERMINATE');
  });

  it('INDETERMINATE when oracle has no spanning round', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ intentCid: 'intent-cid' });
    const evalIntent = makeEvalDesiredState(manifest, intent);
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, {
      oraclePriceAtResolveTs: async () => ({
        round: { roundId: 1n, answer: 350_000_000_000n, startedAt: 0, updatedAt: 0, answeredInRound: 1n, decimals: 8 },
        nextRound: null,
        spanning: false,
      }),
    }));
    expect(out.gating.verdict).toBe('INDETERMINATE');
  });
});
