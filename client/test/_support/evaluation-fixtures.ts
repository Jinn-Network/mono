import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import type { VerdictObservationGateInput } from '@jinn-network/marketplace-binding';
import { buildNamedCheckFixture } from '@jinn-network/marketplace-testing/named-check-fixtures';
import {
  EVALUATION_SPEC_FORMAT_URI,
  parseEvaluationSpec,
  sealEvaluationSpec,
  deriveEvaluationTask,
  buildEvaluationTaskProfile,
  type EvaluationSpec,
} from '@jinn-network/task-execution-profiles';
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealTask,
  type TaskSpecification,
} from '@jinn-network/task-execution-protocol';
import type { LocalProvisionerInput } from '@jinn-network/task-execution-backend-local';
import type {
  CapabilityGrant,
  TaskView,
  WorkspacePaths,
} from '@jinn-network/task-execution-workspace';
import { GRADER_RESULT_NAME } from '../../src/evaluator/grader-execution.js';
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

/** Deterministic-process EvaluationSpec for grader-execution provisioner tests. */
export function deterministicProcessSpec(): EvaluationSpec {
  return publicSpec();
}

interface ProvisionFixtureState {
  readonly provisionerInput: LocalProvisionerInput;
  readonly view: TaskView;
  readonly paths: WorkspacePaths;
  readonly resultsCarryGraderOutput: boolean;
}

const provisionFixtureByRoot = new Map<string, ProvisionFixtureState>();

function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    input: join(root, 'input'),
    work: join(root, 'work'),
    out: join(root, 'out'),
    logs: join(root, 'logs'),
    harnessState: join(root, 'harness-state'),
    secrets: join(root, 'secrets'),
    tmp: join(root, 'tmp'),
    meta: join(root, 'meta'),
  };
}

function buildProvisionFixtureState(input: {
  readonly root: string;
  readonly spec: EvaluationSpec;
  readonly resultsCarryGraderOutput?: boolean;
}): ProvisionFixtureState {
  const sealedSpec = sealEvaluationSpec(input.spec);
  const specBytes = sealedSpec.bytes;
  const graderOutputBytes = new TextEncoder().encode(JSON.stringify({ tests_passed: 3 }));
  const subjectResultBytes = new TextEncoder().encode('evaluation-fixture-result');
  const subjectTaskBytes = sealTask({
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
    task: documentDigest(subjectTaskBytes),
    outputs: [{
      name: 'patch',
      digest: { sha256: documentDigest(subjectResultBytes).slice('sha256:'.length) },
    }],
    outcome: 'fulfilled',
    createdAt: '2026-07-30T00:00:00Z',
  });

  const subjectResults = input.resultsCarryGraderOutput
    ? [
        { name: GRADER_RESULT_NAME, digest: documentDigest(graderOutputBytes) },
        { name: 'patch', digest: documentDigest(subjectResultBytes) },
      ]
    : [{ name: 'patch', digest: documentDigest(subjectResultBytes) }];

  const evaluationTask = deriveEvaluationTask({
    subjectTask: {
      name: 'subject-task.json',
      digest: documentDigest(subjectTaskBytes),
    },
    subjectDelivery: {
      name: 'subject-delivery.json',
      digest: documentDigest(deliveryBytes),
    },
    subjectResults,
    evaluationSpecDigest: sealedSpec.digest,
  });

  const taskDocument = evaluationTask.document as TaskSpecification & {
    readonly inputs: Array<{ readonly name: string; readonly content?: string; readonly digest?: { readonly sha256: string } }>;
  };
  const taskInputs = taskDocument.inputs.map((slot) => {
    if (slot.name === GRADER_RESULT_NAME) {
      return { ...slot, content: Buffer.from(graderOutputBytes).toString('base64') };
    }
    if (slot.name === 'subject-task.json') {
      return { ...slot, content: Buffer.from(subjectTaskBytes).toString('base64') };
    }
    if (slot.name === 'subject-delivery.json') {
      return { ...slot, content: Buffer.from(deliveryBytes).toString('base64') };
    }
    if (slot.name === 'patch') {
      return { ...slot, content: Buffer.from(subjectResultBytes).toString('base64') };
    }
    return slot;
  });

  const task: TaskSpecification = {
    ...taskDocument,
    inputs: [
      ...taskInputs,
      {
        name: 'evaluation-spec.json',
        digest: { sha256: sealedSpec.digest.slice('sha256:'.length) },
        content: Buffer.from(specBytes).toString('base64'),
      },
    ],
  };

  const dispatchContextBytes = new TextEncoder().encode(JSON.stringify({
    taskDigest: evaluationTask.digest,
    submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    nonce: 'evaluation-fixture-nonce',
    attempt: 'urn:uuid:22222222-2222-4222-8222-222222222222',
  }));

  const view: TaskView = {
    task,
    effectiveRequirements: {},
    profile: buildEvaluationTaskProfile(),
  };

  return {
    provisionerInput: {
      sealedTaskBytes: evaluationTask.bytes,
      dispatchContextBytes,
      task,
      submission: {
        submissionUri: 'urn:uuid:11111111-1111-4111-8111-111111111111',
        document: {},
      } as LocalProvisionerInput['submission'],
      attempt: {
        attemptUri: 'urn:uuid:22222222-2222-4222-8222-222222222222',
        nonce: 'evaluation-fixture-nonce',
        attemptNumber: 1,
      },
    },
    view,
    paths: workspacePaths(input.root),
    resultsCarryGraderOutput: input.resultsCarryGraderOutput === true,
  };
}

export function provisionInputFixture(input: {
  readonly root: string;
  readonly spec: EvaluationSpec;
  readonly resultsCarryGraderOutput?: boolean;
}): LocalProvisionerInput {
  const state = buildProvisionFixtureState(input);
  provisionFixtureByRoot.set(input.root, state);
  return state.provisionerInput;
}

provisionInputFixture.setupArgs = (input: {
  readonly root: string;
}): [TaskView, WorkspacePaths, readonly CapabilityGrant[]] => {
  const state = provisionFixtureByRoot.get(input.root);
  if (state === undefined) {
    throw new Error('provisionInputFixture must be called before setupArgs for this root');
  }
  return [state.view, state.paths, []];
};
