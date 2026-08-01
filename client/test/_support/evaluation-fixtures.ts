import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import type { VerdictObservationGateInput } from '@jinn-network/marketplace-binding';
import { buildNamedCheckFixture } from '@jinn-network/marketplace-testing/named-check-fixtures';
import {
  EVALUATION_SPEC_FORMAT_URI,
  parseEvaluationSpec,
  sealEvaluationSpec,
  type EvaluationSpec,
} from '@jinn-network/task-execution-profiles';
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealTask,
} from '@jinn-network/task-execution-protocol';
import type { DsseSigner } from '@jinn-network/trust-core';
import type { VerdictGateDeps } from '../../src/evaluator/verdict-gate.js';
import {
  synthesizeBridgeSubject,
  type BridgeSubject,
} from '../../src/evaluator/bridge-subject.js';
import type { SubjectMaterial } from '../../src/evaluator/subject-material.js';

ed.hashes.sha512 = (m: Uint8Array) => sha512(m);

const PROFILE_URI = 'https://jinn.network/task-profiles/repository-work/1.0';
const PROFILE_DIGEST_HEX = '6'.repeat(64);

function deterministicEd25519PrivateKey(seed: string): Uint8Array {
  return createHash('sha256').update(`jinn-test-dsse:${seed}`).digest();
}

/** Deterministic Ed25519 DSSE signer for evaluator conformance tests. */
export function testDsseSigner(seed: string): DsseSigner {
  const privateKey = deterministicEd25519PrivateKey(seed);
  const keyid = `test:${seed}`;
  return async (request) => {
    const signature = await ed.signAsync(request.preAuthEncoding, privateKey);
    return [{ signature, keyid }];
  };
}

function baseEvaluationSpecDocument(): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: '4',
    family: 'deterministic-process',
    grader: {
      uri: 'https://jinn.network/graders/evaluation-fixture',
      accessClass: 'public',
    },
    familyBlock: {
      image: { uri: 'https://jinn.network/images/evaluation-fixture' },
      platform: 'linux/amd64',
      workspace: { root: '/workspace' },
      testMaterial: [
        {
          uri: 'https://jinn.network/tests/evaluation-fixture.patch',
          accessClass: 'public',
        },
      ],
      parser: {
        id: 'jinn.parser.evaluation-fixture',
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
}

export function publicSpec(): EvaluationSpec {
  return parseEvaluationSpec(sealEvaluationSpec(baseEvaluationSpecDocument()).bytes);
}

export function privateSpec(): EvaluationSpec {
  const document = baseEvaluationSpecDocument();
  const block = document.familyBlock as {
    testMaterial: Array<{ uri: string; accessClass: string }>;
  };
  block.testMaterial = [
    { uri: 'https://jinn.network/tests/private.patch', accessClass: 'private' },
  ];
  return parseEvaluationSpec(sealEvaluationSpec(document).bytes);
}

export function grantBearingSpec(): EvaluationSpec {
  const document = baseEvaluationSpecDocument();
  document.grader = {
    name: 'grader-bundle',
    digest: { sha256: '8'.repeat(64) },
    accessClass: 'private',
  };
  return parseEvaluationSpec(sealEvaluationSpec(document).bytes);
}

export async function subjectMaterialFixture(): Promise<SubjectMaterial> {
  const sealedSpec = sealEvaluationSpec(publicSpec());
  const specBytes = sealedSpec.bytes;
  const resultBytes = new TextEncoder().encode('evaluation-fixture-result');
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: PROFILE_URI,
      digest: { sha256: PROFILE_DIGEST_HEX },
    },
    instructions: 'Evaluation fixture subject task.',
    outputs: [{ name: 'patch', mediaType: 'text/plain', required: true }],
    evaluation: {
      name: 'evaluation-spec.json',
      digest: { sha256: sealedSpec.digest.slice('sha256:'.length) },
    },
  });
  const deliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: 'urn:uuid:00000000-0000-4000-8000-000000000004',
    task: documentDigest(taskBytes),
    outputs: [{
      name: 'patch',
      digest: { sha256: documentDigest(resultBytes).slice('sha256:'.length) },
    }],
    outcome: 'fulfilled',
    createdAt: '2026-07-30T00:00:00Z',
  });

  return {
    task: { name: 'task', digest: documentDigest(taskBytes), bytes: taskBytes },
    delivery: { name: 'delivery', digest: documentDigest(deliveryBytes), bytes: deliveryBytes },
    results: [{
      name: 'patch',
      digest: documentDigest(resultBytes),
      bytes: resultBytes,
    }],
    evaluationSpec: { digest: sealedSpec.digest, bytes: specBytes },
  };
}

export async function bridgeSubjectFixture(
  material?: SubjectMaterial,
): Promise<BridgeSubject> {
  const subjectMaterial = material ?? await subjectMaterialFixture();
  return synthesizeBridgeSubject({
    subjectTaskDigest: subjectMaterial.task.digest,
    evaluationSpecDigest: subjectMaterial.evaluationSpec.digest,
    requesterAgentIri: 'https://agents.example/jinn/requester-fixture',
    admissionAgentIri: 'https://agents.example/jinn/admission-fixture',
    legacyAnchor: {
      chainId: 84532,
      taskId: 99n,
      blockHash: `0x${'ab'.repeat(32)}` as const,
    },
    now: '2026-07-30T00:00:00.000Z',
    signer: testDsseSigner('admission'),
  });
}

/** Kit-built gate input + deps for a passing decision-grade verdict observation. */
export async function buildDecisionGradeGateInvocation(): Promise<{
  readonly input: VerdictObservationGateInput;
  readonly deps: VerdictGateDeps;
}> {
  const fixture = await buildNamedCheckFixture();
  const deps: VerdictGateDeps = {
    policies: {
      admissionAgentPolicy: fixture.ports.admissionAgentPolicy,
      ...(fixture.ports.evaluatorPolicy === undefined
        ? {}
        : { evaluatorPolicy: fixture.ports.evaluatorPolicy }),
      ...(fixture.ports.requesterPolicy === undefined
        ? {}
        : { requesterPolicy: fixture.ports.requesterPolicy }),
    },
    bindingResolver: fixture.ports.bindingResolver,
    witnessVerifier: fixture.ports.witnessVerifier,
    dsseVerifier: fixture.ports.dsseVerifier,
  };
  return { input: fixture.input, deps };
}

export function withEvaluatorEqualsSolver(
  input: VerdictObservationGateInput,
): VerdictObservationGateInput {
  return {
    ...input,
    verdict: {
      ...input.verdict,
      evaluatorAddress: input.verdict.solver.address.toUpperCase(),
    },
  };
}
