import { describe, expect, it } from 'vitest';
import { projectEnvelope } from '../../src/corpus/envelope-projection.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';
import type { Task } from '../../src/types/task.js';

const TASK_CID = 'bafy-task-shared';
const TASK_ID = '42';
const REQUEST_ID = `0x${'1'.repeat(64)}`;

describe('projectEnvelope', () => {
  it('projects prediction.v1 Solution metadata from envelope and Task context', () => {
    const task = makePredictionTask();
    const projection = projectEnvelope(makeEnvelope({
      role: 'solution',
      taskCid: TASK_CID,
      requestId: REQUEST_ID,
      signatureHash: `0x${'a'.repeat(64)}`,
      payload: {
        probabilityYes: '0.5700',
        submittedAt: '2026-05-02T01:00:00.000Z',
        format: 'decimal',
        modelId: 'solver-a',
      },
    }), {
      envelopeCid: 'bafy-solution-envelope',
      envelopeSha256: '2'.repeat(64),
      task,
      taskId: TASK_ID,
    });

    expect(projection).toMatchObject({
      envelopeId: 'bafy-solution-envelope',
      solverType: 'prediction.v1',
      role: 'solution',
      taskCid: TASK_CID,
      taskId: TASK_ID,
      requestId: REQUEST_ID,
      participantSafeAddress: `0x${'2'.repeat(40)}`,
      participantAgentEoa: `0x${'3'.repeat(40)}`,
      executorImplName: 'prediction-v1-baseline',
      executorRuntimeBundleDigest: `sha256:${'1'.repeat(64)}`,
      solutionEnvelopeRef: null,
    });
    expect(projection.metadata).toMatchObject({
      'source.venue': 'polymarket',
      'source.marketId': 'mkt-1',
      'source.conditionId': '0xabc',
      'question.kind': 'binary',
      'participant.safeAddress': `0x${'2'.repeat(40)}`,
      'participant.agentEoa': `0x${'3'.repeat(40)}`,
      'executor.implName': 'prediction-v1-baseline',
      'executor.runtimeBundleDigest': `sha256:${'1'.repeat(64)}`,
    });
    expect(projection.metadata.verdict).toBeUndefined();
  });

  it('projects prediction.v1 Verdict metadata and solution backref', () => {
    const projection = projectEnvelope(makeEnvelope({
      role: 'verdict',
      taskCid: 'bafy-eval-task',
      requestId: `0x${'4'.repeat(64)}`,
      signatureHash: `0x${'b'.repeat(64)}`,
      payload: {
        verdict: 'SCORED',
        resolutionSource: {
          venue: 'polymarket',
          marketId: 'mkt-1',
          conditionId: '0xabc',
        },
        task: {
          cid: TASK_CID,
          id: TASK_ID,
        },
        solutionEnvelope: {
          cid: 'bafy-solution-envelope',
          sha256: '2'.repeat(64),
        },
        scores: {
          solverBrier: '0.184900',
          consensusBrier: '0.144400',
          brierSpread: '0.040500',
        },
      },
    }), {
      task: {
        ...makePredictionTask(),
        id: 'eval-task-local',
        role: 'evaluation',
        context: { solutionTaskCid: TASK_CID },
      },
      taskId: TASK_ID,
    });

    expect(projection.taskCid).toBe(TASK_CID);
    expect(projection.taskId).toBe(TASK_ID);
    expect(projection.solutionEnvelopeCid).toBe('bafy-solution-envelope');
    expect(projection.solutionEnvelopeSha256).toBe('2'.repeat(64));
    expect(projection.solutionEnvelopeRef).toBe('bafy-solution-envelope');
    expect(projection.metadata).toMatchObject({
      'source.venue': 'polymarket',
      'source.marketId': 'mkt-1',
      'source.conditionId': '0xabc',
      verdict: 'SCORED',
      'scores.solverBrier': '0.184900',
      'scores.consensusBrier': '0.144400',
      'scores.brierSpread': '0.040500',
      'solutionEnvelope.cid': 'bafy-solution-envelope',
      'solutionEnvelope.sha256': '2'.repeat(64),
    });
  });

  it('projects generic non-prediction envelopes without prediction metadata', () => {
    const projection = projectEnvelope(makeEnvelope({
      solverType: 'portfolio.v0',
      role: 'solution',
      taskCid: 'bafy-portfolio-task',
      requestId: `0x${'5'.repeat(64)}`,
      signatureHash: `0x${'c'.repeat(64)}`,
      payload: {
        preSnapshot: { capturedAt: 1, payload: {} },
        postSnapshot: { capturedAt: 2, payload: {} },
      },
    }));

    expect(projection.solverType).toBe('portfolio.v0');
    expect(projection.taskCid).toBe('bafy-portfolio-task');
    expect(projection.metadata['source.venue']).toBeUndefined();
    expect(projection.metadata.verdict).toBeUndefined();
    expect(projection.metadata['executor.implName']).toBe('prediction-v1-baseline');
  });
});

function makePredictionTask(): Task {
  return {
    id: 'prediction-v1-polymarket-abc',
    description: 'Forecast a binary externally resolved prediction market.',
    solverType: 'prediction.v1',
    role: 'restoration',
    window: { startTs: 1000, endTs: 2000 },
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
  solverType?: string;
  role: 'solution' | 'verdict';
  taskCid: string;
  requestId: string;
  signatureHash: `0x${string}`;
  payload: Record<string, unknown>;
}): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: overrides.solverType ?? 'prediction.v1',
    role: overrides.role,
    generatedAt: 1_777_680_000_000,
    task: {
      cid: overrides.taskCid,
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
      implName: 'prediction-v1-baseline',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: `sha256:${'0'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'1'.repeat(64)}`,
      plugins: [{ name: 'polymarket', version: '1.0.0', sha256: '9'.repeat(64) }],
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
