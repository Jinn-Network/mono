import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectEnvelope } from '../../src/corpus/envelope-projection.js';
import { queryScoreablePredictionBrierVerdicts } from '../../src/corpus/index.js';
import { Store } from '../../src/store/store.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';
import type { Task } from '../../src/types/task.js';

const TASK_CID = 'bafy-task-shared';
const TASK_ID = 'prediction-v1-polymarket-abc';

describe('queryScoreablePredictionBrierVerdicts', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('includes only SCORED prediction Verdict projections with Brier score metadata', () => {
    for (const projection of [
      verdictProjection({
        generatedAt: 4000,
        signatureHash: `0x${'a'.repeat(64)}`,
        requestId: `0x${'1'.repeat(64)}`,
        solutionCid: 'bafy-scoreable-a',
        verdict: 'SCORED',
        scores: true,
      }),
      verdictProjection({
        generatedAt: 3000,
        signatureHash: `0x${'b'.repeat(64)}`,
        requestId: `0x${'2'.repeat(64)}`,
        solutionCid: 'bafy-invalid',
        verdict: 'INVALID',
        scores: false,
      }),
      verdictProjection({
        generatedAt: 2000,
        signatureHash: `0x${'c'.repeat(64)}`,
        requestId: `0x${'3'.repeat(64)}`,
        solutionCid: 'bafy-rejected',
        verdict: 'REJECTED',
        scores: false,
      }),
      verdictProjection({
        generatedAt: 5000,
        signatureHash: `0x${'d'.repeat(64)}`,
        requestId: `0x${'4'.repeat(64)}`,
        solutionCid: 'bafy-scored-no-brier',
        verdict: 'SCORED',
        scores: false,
      }),
    ]) {
      store.saveEnvelopeProjection(projection);
    }

    const results = queryScoreablePredictionBrierVerdicts(store, { taskCid: TASK_CID });

    expect(results.map((projection) => projection.solutionEnvelopeRef)).toEqual(['bafy-scoreable-a']);
    expect(results[0]?.metadata).toMatchObject({
      verdict: 'SCORED',
      'scores.solverBrier': '0.184900',
      'scores.consensusBrier': '0.144400',
      'scores.brierSpread': '0.040500',
    });

    expect(queryScoreablePredictionBrierVerdicts(store, { taskCid: TASK_CID, limit: 1 })).toHaveLength(1);
  });
});

function verdictProjection(args: {
  generatedAt: number;
  signatureHash: `0x${string}`;
  requestId: `0x${string}`;
  solutionCid: string;
  verdict: 'SCORED' | 'INVALID' | 'REJECTED' | 'INDETERMINATE';
  scores: boolean;
}) {
  return projectEnvelope(makeEnvelope({
    generatedAt: args.generatedAt,
    signatureHash: args.signatureHash,
    requestId: args.requestId,
    payload: {
      verdict: args.verdict,
      resolutionSource: {
        venue: 'polymarket',
        marketId: 'mkt-1',
        conditionId: '0xabc',
      },
      task: { cid: TASK_CID, id: TASK_ID },
      solutionEnvelope: { cid: args.solutionCid, sha256: '2'.repeat(64) },
      ...(args.scores
        ? {
            scores: {
              solverBrier: '0.184900',
              consensusBrier: '0.144400',
              brierSpread: '0.040500',
            },
          }
        : {}),
    },
  }), {
    task: makeEvaluationTask(),
    taskId: TASK_ID,
  });
}

function makeEvaluationTask(): Task {
  return {
    id: 'prediction-v1-eval',
    description: 'Evaluate a binary externally resolved prediction market.',
    solverType: 'prediction.v1',
    role: 'evaluation',
    window: { startTs: 1000, endTs: 2000 },
    context: { solutionTaskCid: TASK_CID },
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
      consensusSnapshot: {
        sampledAt: '2026-05-02T00:00:00.000Z',
        probabilityYes: '0.6200',
        method: 'best-bid-ask-midpoint',
      },
    },
    eligibility: { dedupKey: 'polymarket:0xabc' },
  };
}

function makeEnvelope(overrides: {
  generatedAt: number;
  requestId: `0x${string}`;
  signatureHash: `0x${string}`;
  payload: Record<string, unknown>;
}): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'prediction.v1',
    role: 'verdict',
    generatedAt: overrides.generatedAt,
    task: {
      cid: 'bafy-eval-task',
      onchainCreationTx: `0x${'0'.repeat(64)}`,
      onchainCreationBlock: 123,
      requestId: overrides.requestId,
    },
    participant: {
      safeAddress: `0x${'2'.repeat(40)}`,
      agentEoa: `0x${'3'.repeat(40)}`,
    },
    window: { startTs: 1000, endTs: 2000 },
    executor: {
      implName: 'prediction-v1-evaluator',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: `sha256:${'0'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'1'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: `0x${'3'.repeat(40)}` },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: overrides.payload,
    signature: {
      algo: 'secp256k1',
      signer: `0x${'3'.repeat(40)}`,
      hash: overrides.signatureHash,
      sig: `0x${'4'.repeat(130)}`,
    },
  } as SignedEnvelope;
}
