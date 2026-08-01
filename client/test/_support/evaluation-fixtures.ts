import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { vi, type Mock } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  BASE_SEPOLIA_TODAY,
  computeRawCodecCid,
  createInMemoryPostingIntentStore,
  deriveMarketplaceAttemptUri,
  keccakEvidenceHash,
  type VerdictObservationGateInput,
} from '@jinn-network/marketplace-binding';
import type { VerdictPorts } from '@jinn-network/marketplace-venue-base';
import type { DeliveryRef, TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import { buildNamedCheckFixture } from '@jinn-network/marketplace-testing/named-check-fixtures';
import {
  EVALUATION_SPEC_FORMAT_URI,
  parseEvaluationSpec,
  sealEvaluationSpec,
  deriveEvaluationTask,
  buildEvaluationTaskProfile,
  canonicalJsonBytes,
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  VERDICT_DSSE_PAYLOAD_TYPE,
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
import { createOpportunitySource } from '../../src/evaluator/opportunities.js';
import type { EvaluatorLoopConfig } from '../../src/daemon/evaluator-loop.js';
import type { Store } from '../../src/store/store.js';

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

/** Subject material built from an arbitrary EvaluationSpec (public, private, grant-bearing). */
export async function subjectMaterialWithSpec(spec: EvaluationSpec): Promise<SubjectMaterial> {
  const sealedSpec = sealEvaluationSpec(spec);
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

function buildFailVerdictEnvelopeBytes(specDigest: `sha256:${string}`): Uint8Array {
  const specDigestHex = specDigest.slice('sha256:'.length);
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: 'verdict', digest: { sha256: '1'.repeat(64) } }],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: '2026-07-30T00:00:00.000Z',
      evaluator: { id: 'https://agents.example/jinn/evaluator-fixture' },
      evaluationSpecification: {
        name: 'evaluation-spec.json',
        digest: { sha256: specDigestHex },
      },
      taskSubject: 'task',
      resultSubjects: ['patch'],
      verdict: 'fail',
      measurements: [{ name: 'passed', value: false }],
    },
  };
  const envelope = {
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(canonicalJsonBytes(statement)).toString('base64'),
    signatures: [{ keyid: 'test:verdict', sig: Buffer.from([1, 2, 3]).toString('base64') }],
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function buildEvaluationDeliveryBytes(input: {
  readonly attemptUri: `urn:uuid:${string}`;
  readonly taskDigest: `sha256:${string}`;
  readonly specDigest: `sha256:${string}`;
}): Uint8Array {
  const verdictEnvelopeBytes = buildFailVerdictEnvelopeBytes(input.specDigest);
  return sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: input.attemptUri,
    task: input.taskDigest,
    outputs: [{
      name: 'verdict',
      digest: { sha256: documentDigest(verdictEnvelopeBytes).slice('sha256:'.length) },
      content: Buffer.from(verdictEnvelopeBytes).toString('base64'),
      mediaType: VERDICT_DSSE_PAYLOAD_TYPE,
    }],
    outcome: 'fulfilled',
    createdAt: '2026-07-30T00:00:00.000Z',
  });
}

const HARNESS_TASK_ID = 7n;
const HARNESS_ATTEMPT_INDEX = 1;
const HARNESS_VERDICT_INDEX = 0;
const HARNESS_REQUEST_ID = `0x${'cd'.repeat(32)}` as const;
const HARNESS_OPERATOR = '0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc';
const HARNESS_IDENTITY = {
  safeAddress: '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa',
  agentEoa: '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb',
  agentIri: 'https://agents.example/jinn/operator-1',
};

export interface EvaluatorLoopHarness {
  readonly config: EvaluatorLoopConfig;
  readonly venue: { readonly verdict: Record<keyof VerdictPorts, Mock> };
  readonly backend: { readonly submit: Mock };
  readonly order: string[];
  readonly skips: Array<{ readonly kind: string; readonly detail?: string }>;
  emitOpportunity(): void;
  emitOwnSolutionOpportunity(): void;
  settled(): Promise<void>;
  idle(): Promise<void>;
}

export async function evaluatorLoopHarness(
  options: { readonly spec?: 'public' | 'private' } = {},
): Promise<EvaluatorLoopHarness> {
  const spec = options.spec === 'private' ? privateSpec() : publicSpec();
  const material = await subjectMaterialWithSpec(spec);
  const deliveryCid = computeRawCodecCid(material.delivery.bytes).cid;
  const bytesByDigest = new Map<string, Uint8Array>([
    [material.task.digest, material.task.bytes],
    [material.delivery.digest, material.delivery.bytes],
    [material.evaluationSpec.digest, material.evaluationSpec.bytes],
    ...material.results.map((result) => [result.digest, result.bytes] as const),
  ]);

  const order: string[] = [];
  const skips: Array<{ readonly kind: string; readonly detail?: string }> = [];
  let idleResolve: (() => void) | null = null;
  let settledResolve: (() => void) | null = null;
  let idlePromise: Promise<void> = Promise.resolve();
  let settledPromise: Promise<void> = Promise.resolve();

  const finishProcessing = (): void => {
    idleResolve?.();
    idleResolve = null;
  };

  const finishSettled = (): void => {
    settledResolve?.();
    settledResolve = null;
    finishProcessing();
  };

  const beginWait = (): void => {
    idlePromise = new Promise<void>((resolve) => { idleResolve = resolve; });
    settledPromise = new Promise<void>((resolve) => { settledResolve = resolve; });
  };

  const verdictPorts = {
    canOpenVerdictAttempt: vi.fn(async () => ({ ok: true as const })),
    openVerdictAttempt: vi.fn(async () => {
      order.push('open-verdict');
      return {
        requestId: HARNESS_REQUEST_ID,
        verdictIndex: HARNESS_VERDICT_INDEX,
        txHash: `0x${'ee'.repeat(32)}`,
      };
    }),
    deliverVerdictToMarketplace: vi.fn(async () => ({ txHash: `0x${'ff'.repeat(32)}` })),
    claimVerdictDelivery: vi.fn(async () => {
      finishSettled();
      return { status: 'settled' as const };
    }),
  } satisfies Record<keyof VerdictPorts, Mock>;

  const attemptUri = deriveMarketplaceAttemptUri({
    chainId: BASE_SEPOLIA_TODAY.chainId,
    coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
    taskId: HARNESS_TASK_ID,
    attemptIndex: HARNESS_VERDICT_INDEX,
  });
  const evaluationDeliveryBytes = buildEvaluationDeliveryBytes({
    attemptUri,
    taskDigest: material.task.digest,
    specDigest: material.evaluationSpec.digest,
  });
  let storedDelivery: Uint8Array | undefined;

  const backend = {
    submit: vi.fn(async () => {
      storedDelivery = evaluationDeliveryBytes;
      return { accepted: true as const, submission: 'urn:uuid:50000000-0000-4000-8000-000000000005' as const, digest: material.task.digest };
    }),
    deliveries: vi.fn(async () => (
      storedDelivery === undefined
        ? []
        : [{ digest: documentDigest(storedDelivery), attempt: attemptUri } satisfies DeliveryRef]
    )),
    fetchDelivery: vi.fn(async () => {
      if (storedDelivery === undefined) throw new Error('no delivery');
      return storedDelivery;
    }),
  } satisfies Pick<TaskExecutionBackend, 'submit' | 'deliveries' | 'fetchDelivery'>;

  const ledger = {
    admitIntent: vi.fn(async () => {
      order.push('ledger');
    }),
  };

  const intents = createInMemoryPostingIntentStore();
  const store = {
    config: new Map<string, string>(),
    events: [] as unknown[],
    setConfigValue(key: string, value: string) {
      this.config.set(key, value);
    },
    getConfigValue(key: string) {
      return this.config.get(key) ?? null;
    },
    recordActivityEvent(event: unknown) {
      this.events.push(event);
    },
  } as unknown as Store;

  let emitObservation: (event: never) => void = () => {};
  const opportunities = createOpportunitySource({
    subscribeObservations: (handler) => {
      emitObservation = handler as never;
      return () => { emitObservation = () => {}; };
    },
    identity: HARNESS_IDENTITY,
    onSkip: (reason) => {
      skips.push({ kind: reason });
      finishProcessing();
    },
  });

  const config: EvaluatorLoopConfig = {
    chain: {
      chainId: BASE_SEPOLIA_TODAY.chainId,
      taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
    },
    venue: { verdict: verdictPorts },
    backend: backend as TaskExecutionBackend,
    opportunities,
    fetcher: {
      async byCid(cid: string) {
        if (cid === deliveryCid) return material.delivery.bytes;
        throw new Error(`unknown cid ${cid}`);
      },
      async byDigest(digest: `sha256:${string}`) {
        const bytes = bytesByDigest.get(digest);
        if (bytes === undefined) throw new Error(`unknown digest ${digest}`);
        return bytes;
      },
    },
    ledger,
    intents,
    creatorSafe: HARNESS_IDENTITY.safeAddress as `0x${string}`,
    pin: { pin: vi.fn(async () => undefined) },
    store,
    bridgeSigner: testDsseSigner('admission'),
    admissionAgentIri: 'https://agents.example/jinn/admission-fixture',
    requesterAgentIri: 'https://agents.example/jinn/requester-fixture',
    evaluatorAgentIri: 'https://agents.example/jinn/evaluator-fixture',
    wiring: {
      workKind: 'evaluation-fixture',
      harness: 'evaluation-harness',
      model: 'fixture',
      plugins: [],
      credentialRef: 'cred-eval',
      isolationPolicy: 'process',
    },
    evaluationDeadline: '2099-01-01T00:00:00.000Z',
    pollIntervalMs: 5,
    onSkip: (reason, _opportunity, detail) => {
      skips.push({ kind: reason, ...(detail === undefined ? {} : { detail }) });
      finishProcessing();
    },
  };

  function solutionClaimed(operator: string) {
    const { sha256Digest } = computeRawCodecCid(material.delivery.bytes);
    return {
      event: 'SolutionDeliveryClaimed',
      facts: {
        taskId: HARNESS_TASK_ID,
        attemptIndex: HARNESS_ATTEMPT_INDEX,
        requestId: `0x${'ab'.repeat(32)}`,
        operator,
      },
      derivation: { chainId: BASE_SEPOLIA_TODAY.chainId, blockHash: `0x${'ee'.repeat(32)}` },
      projection: {
        deliveryCorrespondence: {
          sha256Digest,
          keccakEvidenceHash: keccakEvidenceHash(material.delivery.bytes),
          onChainSha256CidDigest: sha256Digest,
          onChainKeccak: `0x${'cc'.repeat(32)}`,
        },
      },
    } as never;
  }

  return {
    config,
    venue: { verdict: verdictPorts },
    backend,
    order,
    skips,
    emitOpportunity() {
      beginWait();
      emitObservation(solutionClaimed(HARNESS_OPERATOR));
    },
    emitOwnSolutionOpportunity() {
      beginWait();
      emitObservation(solutionClaimed(HARNESS_IDENTITY.safeAddress));
    },
    settled() {
      return settledPromise;
    },
    idle() {
      return idlePromise;
    },
  };
}
