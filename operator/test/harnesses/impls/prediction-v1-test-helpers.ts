import { privateKeyToAccount } from 'viem/accounts';
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import type { PredictionV1Task } from '../../../src/types/prediction-v1.js';
import type { Task } from '../../../src/types/task.js';
import { signCanonical } from '../../../src/harnesses/engine/signing.js';
import {
  SOLUTION_ENVELOPE_CID_CONTEXT_KEY,
  SOLUTION_TASK_CID_CONTEXT_KEY,
} from '../../../src/harnesses/impls/evaluation-context.js';

/** A deterministic test CID stand-in. Real CIDs are 46+ chars; this is fine
 *  for unit tests that mock the registry client. */
export const TEST_PREDICTION_V1_MANIFEST_CID = 'bafy-prediction-v1-test-manifest';

/**
 * Test task type — `PredictionV1Task` plus the manifest-binding fields the
 * spec §14 validation pipeline reads (`solverNetManifestCid`,
 * `contractId`, `contractVersion`). The SDK's `PredictionV1TaskSchema` is a
 * pre-Task-24 shape and doesn't carry these fields; adding them here keeps
 * tests aligned with the post-Task-24 runtime `Task`.
 */
export type PredictionV1TestTask = PredictionV1Task & {
  contractId: 'prediction';
  contractVersion: 'v1';
  solverNetManifestCid: string;
};

export function makePredictionV1Task(
  overrides: Partial<PredictionV1TestTask> = {},
): PredictionV1TestTask {
  return {
    id: 'prediction-v1-polymarket-abc',
    description: 'Forecast a binary externally resolved prediction market.',
    solverType: 'prediction.v1',
    contractId: 'prediction',
    contractVersion: 'v1',
    solverNetManifestCid: TEST_PREDICTION_V1_MANIFEST_CID,
    role: 'restoration',
    window: {
      startTs: Date.parse('2026-05-02T00:00:00.000Z'),
      endTs: Date.parse('2026-05-02T06:00:00.000Z'),
    },
    claimPolicy: {
      kind: 'parallel',
      maxClaims: 25,
      maxClaimsPerSolver: 1,
      claimWindow: 'task-window',
      selection: 'all-valid-solutions-scored',
      economics: 'testnet-flat',
    },
    spec: {
      question: { kind: 'binary', text: 'Will test pass?', yesLabel: 'YES', noLabel: 'NO' },
      source: {
        type: 'prediction-market',
        venue: 'polymarket',
        url: 'https://polymarket.com/event/test-market',
        identifiers: {
          marketId: 'mkt-1',
          conditionId: '0xabc',
          yesTokenId: 'yes-token',
          noTokenId: 'no-token',
        },
      },
      resolution: {
        expectedResolutionTime: '2026-05-04T00:00:00.000Z',
        rulesText: 'Resolve according to UMA final market resolution.',
        rulesUrl: 'https://polymarket.com/event/test-market',
        timezone: 'UTC',
      },
      consensusSnapshot: {
        sampledAt: '2026-05-02T00:00:00.000Z',
        probabilityYes: '0.6200',
        method: 'best-bid-ask-midpoint',
        bestBidYes: '0.6000',
        bestAskYes: '0.6400',
        spread: '0.0400',
        source: 'polymarket-clob',
      },
      eligibilitySnapshot: {
        sampledAt: '2026-05-02T00:00:00.000Z',
        timeToResolutionHours: 48,
        liquidityUsd: '12000',
        volume24hUsd: '2600',
        orderbookAgeSeconds: 1,
        selectionReason: 'weekly-binary-liquid-clear-rules',
      },
    },
    eligibility: {
      dedupKey: 'polymarket:0xabc',
    },
    ...overrides,
  };
}

export async function makeSignedSolutionEnvelope(
  task: PredictionV1Task,
  payload: Record<string, unknown> = {
    probabilityYes: '0.5700',
    submittedAt: '2026-05-02T01:00:00.000Z',
    format: 'decimal',
    modelId: 'solver-a',
  },
): Promise<SignedEnvelope> {
  const pk = `0x${'1'.repeat(64)}` as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const unsigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    solverType: 'prediction.v1',
    role: 'solution' as const,
    generatedAt: Date.parse('2026-05-02T01:00:00.000Z'),
    task: {
      cid: 'bafy-solution-task',
      onchainCreationTx: `0x${'0'.repeat(64)}` as `0x${string}`,
      onchainCreationBlock: 1,
      requestId: `0x${'1'.repeat(64)}` as `0x${string}`,
    },
    participant: {
      safeAddress: `0x${'2'.repeat(40)}` as `0x${string}`,
      agentEoa: account.address,
    },
    window: task.window,
    executor: {
      implName: 'prediction-v1-baseline',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: `sha256:${'0'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'1'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa' as const, pubkey: account.address },
    },
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload,
  };
  const signed = await signCanonical(unsigned, pk, account.address);
  return {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: account.address,
      hash: signed.hash,
      sig: signed.sig,
    },
  } as SignedEnvelope;
}

export function makeEvalTask(task: PredictionV1Task, envelope: SignedEnvelope): Task {
  return {
    ...task,
    id: 'prediction-v1-eval',
    role: 'evaluation',
    restorationRequestId: `0x${'9'.repeat(64)}`,
    context: {
      restorationResult: JSON.stringify(envelope),
      [SOLUTION_TASK_CID_CONTEXT_KEY]: envelope.task.cid,
      [SOLUTION_ENVELOPE_CID_CONTEXT_KEY]: 'bafy-solution-envelope',
    },
  } as Task;
}
