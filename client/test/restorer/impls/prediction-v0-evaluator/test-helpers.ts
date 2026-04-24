import { privateKeyToAccount } from 'viem/accounts';
import type { PredictionSubmissionManifest, PredictionV0Intent } from '../../../../src/types/prediction.js';
import type { RestorationJob } from '../../../../src/types/desired-state.js';
import { signCanonical } from '../../../../src/restorer/engine/signing.js';
import { RESTORATION_INTENT_CID_CONTEXT_KEY } from '../../../../src/restorer/impls/evaluation-context.js';

export function makeValidIntent(overrides: Partial<PredictionV0Intent> = {}): PredictionV0Intent {
  return {
    id: 'test-1',
    description: 'ETH > 3500',
    window: { startTs: 0, endTs: 3_600_000 },
    spec: {
      kind: 'prediction.v0',
      oracle: { venue: 'chainlink-base-sepolia', feed: '0x000000000000000000000000000000000000feed', feedDescription: 'ETH / USD' },
      question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: 4_500_000 },
    },
    eligibility: { maxSubmissionDelayMs: 60_000 },
    ...overrides,
  } as PredictionV0Intent;
}

export async function makeSignedManifest(overrides: {
  probability?: string;
  submittedAt?: number;
  signerPk?: `0x${string}`;
  intentCid?: string;
  corruptSignature?: boolean;
} = {}): Promise<PredictionSubmissionManifest> {
  const pk = overrides.signerPk ?? ('0x' + '1'.repeat(64) as `0x${string}`);
  const account = privateKeyToAccount(pk);
  const base: Omit<PredictionSubmissionManifest, 'signature'> = {
    schemaVersion: 'prediction.v0.submission.v1',
    generatedAt: 1000,
    intent: {
      cid: overrides.intentCid ?? 'intent-cid',
      onchainCreationTx: ('0x' + '0'.repeat(64)) as `0x${string}`,
      onchainCreationBlock: 1,
      requestId: ('0x' + '0'.repeat(64)) as `0x${string}`,
    },
    restorer: {
      safeAddress: ('0x' + '0'.repeat(40)) as `0x${string}`,
      agentEoa: account.address,
    },
    window: { startTs: 0, endTs: 3_600_000 },
    prediction: {
      probability: overrides.probability ?? '0.55',
      submittedAt: overrides.submittedAt ?? 1_000_000,
      modelId: 'spot-carry.v1',
    },
  };
  const s = await signCanonical(base, pk, account.address);
  const sig = overrides.corruptSignature ? (('0x' + 'a'.repeat(130)) as `0x${string}`) : s.sig;
  return { ...base, signature: { algo: 'secp256k1' as const, signer: account.address, hash: s.hash, sig } };
}

export function makeEvalRestorationJob(
  manifest: PredictionSubmissionManifest | Record<string, unknown>,
  intent: PredictionV0Intent,
  options?: { omitRestorationIntentCid?: boolean },
): RestorationJob {
  const m = manifest as { intent: { cid: string } };
  return {
    id: 'eval',
    description: 'evaluate',
    type: 'evaluation',
    restorationRequestId: ('0x' + '0'.repeat(64)) as `0x${string}`,
    window: intent.window,
    spec: intent.spec,
    eligibility: intent.eligibility,
    context: {
      restorationResult: JSON.stringify(manifest),
      ...(options?.omitRestorationIntentCid
        ? {}
        : { [RESTORATION_INTENT_CID_CONTEXT_KEY]: m.intent.cid }),
    },
  } as unknown as RestorationJob;
}
