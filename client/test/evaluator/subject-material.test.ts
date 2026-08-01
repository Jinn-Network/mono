import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  EVALUATION_SPEC_FORMAT_URI,
  sealEvaluationSpec,
  type EvaluationSpec,
} from '@jinn-network/task-execution-profiles';
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealTask,
} from '@jinn-network/task-execution-protocol';
import { recordDigest } from '@jinn-network/record-discovery-protocol';
import { deriveBridgeTask } from '../../src/bridge/legacy-task.js';
import { acquireSubjectMaterial, SubjectMaterialError } from '../../src/evaluator/subject-material.js';

const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;

const PROFILE_URI = 'https://jinn.network/task-profiles/repository-work/1.0';
const PROFILE_DIGEST_HEX = '6'.repeat(64);

const evaluationSpecDocument: EvaluationSpec = {
  protocol: EVALUATION_SPEC_FORMAT_URI,
  semanticsVersion: '4',
  family: 'deterministic-process',
  grader: { uri: 'https://jinn.network/graders/subject-material-fixture' },
  familyBlock: {
    image: { uri: 'https://jinn.network/images/subject-material-fixture' },
    platform: 'linux/amd64',
    workspace: { root: '/workspace' },
    testMaterial: [],
    parser: {
      id: 'jinn.parser.subject-material-fixture',
      version: '1.0.0',
      digest: `sha256:${'7'.repeat(64)}`,
    },
    transitions: { failToPass: [], passToPass: [] },
    timeout: 60,
  },
  measurements: [{ name: 'passed', type: 'boolean', required: true }],
  verdictRule: {
    threshold: { measurement: 'passed', op: 'eq', value: true },
  },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
};

function fixtures() {
  const sealedSpec = sealEvaluationSpec(evaluationSpecDocument);
  const specBytes = sealedSpec.bytes;
  const resultBytes = new TextEncoder().encode('result-artifact');
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: PROFILE_URI,
      digest: { sha256: PROFILE_DIGEST_HEX },
    },
    instructions: 'Subject material fixture task.',
    outputs: [{ name: 'patch', mediaType: 'text/plain', required: true }],
    evaluation: {
      name: 'evaluation-spec.json',
      digest: { sha256: sealedSpec.digest.slice('sha256:'.length) },
    },
  });
  const deliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    task: documentDigest(taskBytes),
    outputs: [{
      name: 'patch',
      digest: { sha256: documentDigest(resultBytes).slice('sha256:'.length) },
    }],
    outcome: 'fulfilled',
    createdAt: '2026-07-30T00:00:00Z',
  });
  return { taskBytes, specBytes, resultBytes, deliveryBytes };
}

function taskWithoutEvaluationFixture() {
  const resultBytes = new TextEncoder().encode('result-artifact');
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: PROFILE_URI,
      digest: { sha256: PROFILE_DIGEST_HEX },
    },
    instructions: 'Task without evaluation spec.',
    outputs: [{ name: 'patch', mediaType: 'text/plain', required: true }],
  });
  const deliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: 'urn:uuid:00000000-0000-4000-8000-000000000002',
    task: documentDigest(taskBytes),
    outputs: [{
      name: 'patch',
      digest: { sha256: documentDigest(resultBytes).slice('sha256:'.length) },
    }],
    outcome: 'fulfilled',
    createdAt: '2026-07-30T00:00:00Z',
  });
  return { taskBytes, deliveryBytes };
}

describe('acquireSubjectMaterial', () => {
  it('returns exact bytes for task, delivery, every result, and the evaluation spec', async () => {
    const f = fixtures();
    const material = await acquireSubjectMaterial(
      { deliveryCid: 'bafyDelivery' } as never,
      {
        byCid: async () => f.deliveryBytes,
        byDigest: async (digest) => {
          if (digest === documentDigest(f.taskBytes)) return f.taskBytes;
          if (digest === documentDigest(f.resultBytes)) return f.resultBytes;
          if (digest === sha256(f.specBytes)) return f.specBytes;
          throw new Error(`unexpected digest ${digest}`);
        },
      },
    );
    expect(material.task.bytes).toEqual(f.taskBytes);
    expect(material.results).toHaveLength(1);
    expect(material.results[0]!.name).toBe('patch');
  });

  it('refuses material whose bytes do not hash to the naming digest', async () => {
    const f = fixtures();
    await expect(acquireSubjectMaterial(
      { deliveryCid: 'bafyDelivery' } as never,
      { byCid: async () => f.deliveryBytes, byDigest: async () => new TextEncoder().encode('tampered') },
    )).rejects.toMatchObject({ kind: 'digest-mismatch' });
  });

  it('refuses a subject Task that declares no evaluation spec', async () => {
    const f = taskWithoutEvaluationFixture();
    await expect(acquireSubjectMaterial(
      { deliveryCid: 'bafyDelivery' } as never,
      { byCid: async () => f.deliveryBytes, byDigest: async () => f.taskBytes },
    )).rejects.toBeInstanceOf(SubjectMaterialError);
  });
});

describe('deriveBridgeTask cross-operator determinism', () => {
  const anchor = {
    chainId: 84532,
    taskCoordinator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
    taskId: 42n,
    creator: '0x5555555555555555555555555555555555555555' as const,
    manifestDigest: `0x${'9'.repeat(64)}` as const,
    taskCidDigest: `0x${'8'.repeat(64)}` as const,
    maxClaims: 2,
    solutionBudgetWei: 1_000_000n,
    verdictBudgetWei: 500_000n,
  };

  function legacyDocumentBytes(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
      schemaVersion: 'task.v1',
      id: 'legacy-task-1',
      solverType: 'prediction.v1',
      description: 'restore service health',
      spec: { contractId: 'prediction' },
    }));
  }

  it('derives byte-identical sealed Task bytes from independently constructed inputs', () => {
    const bytes = legacyDocumentBytes();
    const digest = recordDigest(bytes);

    const solverInput = { bytes, digest };
    const evaluatorInput = {
      bytes: Uint8Array.from(bytes),
      digest: recordDigest(Uint8Array.from(bytes)),
    };

    const solverResult = deriveBridgeTask(anchor, solverInput);
    const evaluatorResult = deriveBridgeTask(anchor, evaluatorInput);

    expect(solverResult.ok).toBe(true);
    expect(evaluatorResult.ok).toBe(true);
    if (!solverResult.ok || !evaluatorResult.ok) return;

    expect(solverResult.task.taskBytes).toEqual(evaluatorResult.task.taskBytes);
    expect(solverResult.task.taskDigest).toBe(evaluatorResult.task.taskDigest);
  });
});
