import { privateKeyToAccount } from 'viem/accounts';
import type { PredictionV1Task } from '../../../../src/types/prediction.js';
import type { Task } from '../../../../src/types/task.js';
import type { SignedEnvelope } from '../../../../src/types/envelope.js';
import { signCanonical } from '../../../../src/harnesses/engine/signing.js';
import { SOLUTION_TASK_CID_CONTEXT_KEY, SOLUTION_ENVELOPE_CID_CONTEXT_KEY } from '../../../../src/harnesses/impls/evaluation-context.js';

export function makeValidTask(overrides: Partial<PredictionV1Task> = {}): PredictionV1Task {
  return {
    id: 'test-1',
    description: 'ETH > 3500',
    window: { startTs: 0, endTs: 3_600_000 },
    spec: {
      kind: 'prediction.v1',
      oracle: { venue: 'chainlink-base-sepolia', feed: '0x000000000000000000000000000000000000feed', feedDescription: 'ETH / USD' },
      question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: 4_500_000 },
    },
    eligibility: { maxSubmissionDelayMs: 60_000 },
    ...overrides,
  } as PredictionV1Task;
}

/**
 * Build a signed jinn.execution.v1 envelope for prediction.v1/solution.
 * Replaces the old makeSignedManifest that produced a PredictionSubmissionManifest.
 */
export async function makeSignedManifest(overrides: {
  probability?: string;
  submittedAt?: number;
  signerPk?: `0x${string}`;
  taskCid?: string;
  corruptSignature?: boolean;
} = {}): Promise<SignedEnvelope> {
  const pk = overrides.signerPk ?? ('0x' + '1'.repeat(64) as `0x${string}`);
  const account = privateKeyToAccount(pk);
  const unsigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    solverType: 'prediction.v1',
    role: 'solution' as const,
    generatedAt: 1000,
task: {
      cid: overrides.taskCid ?? 'task-cid',
      onchainCreationTx: ('0x' + '0'.repeat(64)) as `0x${string}`,
      onchainCreationBlock: 1,
      requestId: ('0x' + '0'.repeat(64)) as `0x${string}`,
    },
    participant: {
      safeAddress: ('0x' + '0'.repeat(40)) as `0x${string}`,
      agentEoa: account.address,
    },
    window: { startTs: 0, endTs: 3_600_000 },
    executor: {
      implName: 'claude-mcp-prediction',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: ('sha256:' + '0'.repeat(64)) as string,
      runtimeBundleDigest: ('sha256:' + '1'.repeat(64)) as string,
      plugins: [] as [],
      signingKey: { kind: 'agent-eoa' as const, pubkey: account.address },
    },
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [] as unknown[],
    payload: {
      prediction: {
        probability: overrides.probability ?? '0.55',
        submittedAt: overrides.submittedAt ?? 1_000_000,
        modelId: 'spot-carry.v1',
      },
    },
  };
  const s = await signCanonical(unsigned, pk, account.address);
  const sig = overrides.corruptSignature ? (('0x' + 'a'.repeat(130)) as `0x${string}`) : s.sig;
  return {
    ...unsigned,
    signature: { algo: 'secp256k1' as const, signer: account.address, hash: s.hash, sig },
  } as SignedEnvelope;
}

export function makeEvalTask(
  envelope: SignedEnvelope | Record<string, unknown>,
  task: PredictionV1Task,
  options?: { omitSolutionTaskCid?: boolean; solutionEnvelopeCid?: string },
): Task {
  const e = envelope as { task: { cid: string } };
  return {
    id: 'eval',
    description: 'evaluate',
    solverType: 'prediction.v1',
    role: 'evaluation',
    restorationRequestId: ('0x' + '0'.repeat(64)) as `0x${string}`,
    window: task.window,
    spec: task.spec,
    eligibility: task.eligibility,
    context: {
      restorationResult: JSON.stringify(envelope),
      ...(options?.omitSolutionTaskCid
        ? {}
        : { [SOLUTION_TASK_CID_CONTEXT_KEY]: e.task.cid }),
      ...(options?.solutionEnvelopeCid
        ? { [SOLUTION_ENVELOPE_CID_CONTEXT_KEY]: options.solutionEnvelopeCid }
        : {}),
    },
  } as unknown as Task;
}
