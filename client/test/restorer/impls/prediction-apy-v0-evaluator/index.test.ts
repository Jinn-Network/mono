import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PredictionApyV0Evaluator } from '../../../../src/restorer/impls/prediction-apy-v0-evaluator/index.js';
import { signCanonical } from '../../../../src/restorer/engine/signing.js';
import { RESTORATION_INTENT_CID_CONTEXT_KEY } from '../../../../src/restorer/impls/evaluation-context.js';
import { PredictionApyV0VerdictPayloadSchema } from '../../../../src/types/payloads/prediction-apy-v0.js';
import type { RestorationJob } from '../../../../src/types/desired-state.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';

const PK = ('0x' + 'e'.repeat(64)) as `0x${string}`;
const AGENT_PK = ('0x' + '1'.repeat(64)) as `0x${string}`;

const intentProv = (cid: string) => ({
  cid,
  onchainCreationTx: '0x' + 'ab'.repeat(32),
  onchainCreationBlock: 1,
  requestId: '0x' + 'cd'.repeat(32),
});

async function makeSignedApyManifestJson(overrides: { submittedAt?: number; intentCid?: string; corruptSignature?: boolean } = {}) {
  const account = privateKeyToAccount(AGENT_PK);
  const unsigned: Record<string, unknown> = {
    schemaVersion: 'prediction.apy.v0.submission.v1',
    generatedAt: 1_000,
    intent: intentProv(overrides.intentCid ?? 'expected-cid'),
    restorer: { safeAddress: '0x' + '44'.repeat(20), agentEoa: account.address },
    window: { startTs: 0, endTs: 600_000 },
    prediction: {
      predictedBps: '100',
      submittedAt: overrides.submittedAt ?? 100_000,
      modelId: 'apy-persistence.v1',
    },
  };
  const s = await signCanonical(unsigned, AGENT_PK, account.address);
  const full = {
    ...unsigned,
    signature: {
      algo: 'secp256k1' as const,
      signer: account.address,
      hash: s.hash,
      sig: overrides.corruptSignature ? (('0x' + 'a'.repeat(130)) as `0x${string}`) : s.sig,
    },
  };
  return JSON.stringify(full);
}

function makeEvalIntent(
  manifestJson: string,
  options?: { omitRestorationIntentCid?: boolean; restorationIntentCid?: string },
): RestorationJob {
  return {
    id: 'eval-apy',
    description: 'e',
    type: 'evaluation',
    window: { startTs: 0, endTs: 600_000 },
    spec: {
      kind: 'prediction.apy.v0',
      oracle: {
        venue: 'aave-v3-base-sepolia',
        pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
        reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
        reserveSymbol: 'USDC',
      },
      metric: { type: 'supply-apy-twa-bps', twaWindowSeconds: 3600, sampleCount: 12, toleranceBps: 100 },
      question: { resolveTs: 900_000 },
    },
    eligibility: {},
    context: {
      restorationResult: manifestJson,
      ...(options?.omitRestorationIntentCid
        ? {}
        : { [RESTORATION_INTENT_CID_CONTEXT_KEY]: options?.restorationIntentCid ?? 'expected-cid' }),
    },
  } as unknown as RestorationJob;
}

function makeCtx(intent: RestorationJob, intentCid: string, testDeps: Record<string, unknown> = {}): RestorationContext {
  const d = mkdtempSync(join(tmpdir(), 'apy-eval-'));
  return {
    intent,
    intentCid,
    implStateDir: d,
    workingDir: d,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    _testDeps: testDeps,
  } as unknown as RestorationContext;
}

describe('PredictionApyV0Evaluator', () => {
  it('PASS with stubbed TWA and matching intentCid', async () => {
    const manifest = await makeSignedApyManifestJson();
    const evalIntent = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalIntent, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('PASS');
  });

  it('REJECTED when submitted after window', async () => {
    const manifest = await makeSignedApyManifestJson({ submittedAt: 700_000 });
    const evalIntent = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalIntent, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('REJECTED');
  });

  it('FAIL when manifest intent cid does not match context.restorationIntentCid', async () => {
    const manifest = await makeSignedApyManifestJson({ intentCid: 'wrong' });
    const evalIntent = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalIntent, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('FAIL');
  });

  it('uses context.restorationIntentCid when it differs from ctx.intentCid (eval job vs restoration)', async () => {
    const manifest = await makeSignedApyManifestJson({ intentCid: 'restoration-cid' });
    const evalIntent = makeEvalIntent(manifest, { restorationIntentCid: 'restoration-cid' });
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalIntent, 'evaluation-desired-state-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('PASS');
  });

  it('INDETERMINATE when context.restorationIntentCid is missing (legacy eval payload)', async () => {
    const manifest = await makeSignedApyManifestJson();
    const evalIntent = makeEvalIntent(manifest, { omitRestorationIntentCid: true });
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalIntent, 'any-eval-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('INDETERMINATE');
  });

  it('FAIL on bad signature', async () => {
    const manifest = await makeSignedApyManifestJson({ corruptSignature: true });
    const evalIntent = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalIntent, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('FAIL');
  });

  it('verdictPayload conforms to PredictionApyV0VerdictPayloadSchema on PASS', async () => {
    const manifest = await makeSignedApyManifestJson();
    const evalIntent = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalIntent, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.verdictPayload).toBeDefined();
    const parsed = PredictionApyV0VerdictPayloadSchema.safeParse(out.verdictPayload);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.verdict).toBe('PASS');
      expect(parsed.data.scoreBasis).toBe('absolute-error-linear.v1');
      expect(parsed.data.restorationEnvelope.cid).toBe('bafy-unknown');
      expect(parsed.data.restorationEnvelope.sha256).toMatch(/^0{64}$/);
      expect(parsed.data.verificationOfRestoration.claimedTier).toBe('self-signed');
      expect(parsed.data.verificationOfRestoration.overall).toBe('valid');
      expect(parsed.data.claimed.predictedBps).toBe('100');
      expect(parsed.data.claimed.modelId).toBe('apy-persistence.v1');
    }
  });
});
