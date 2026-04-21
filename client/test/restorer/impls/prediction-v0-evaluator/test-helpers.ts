import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToHex } from 'viem';
import type { PredictionSubmissionManifest, PredictionV0Intent } from '../../../../src/types/prediction.js';
import type { DesiredState } from '../../../../src/types/desired-state.js';

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
  const canonical = JSON.stringify(base);
  const hash = keccak256(stringToHex(canonical));
  // account.sign({hash}) is raw ECDSA (no EIP-191). recoverAddress in
  // checkManifestSignature must use the same semantic.
  const sig = overrides.corruptSignature ? ('0x' + 'a'.repeat(130)) as `0x${string}` : await account.sign({ hash });
  return { ...base, signature: { algo: 'secp256k1' as const, signer: account.address, hash, sig } };
}

export function makeEvalDesiredState(manifest: PredictionSubmissionManifest, intent: PredictionV0Intent): DesiredState {
  return {
    id: 'eval',
    description: 'evaluate',
    type: 'evaluation',
    restorationRequestId: ('0x' + '0'.repeat(64)) as `0x${string}`,
    window: intent.window,
    spec: intent.spec,
    eligibility: intent.eligibility,
    context: { restorationResult: JSON.stringify(manifest) },
  } as unknown as DesiredState;
}
