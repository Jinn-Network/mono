import { describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { JINN_ROUTER_ABI } from '../../src/adapters/mech/types.js';
import {
  MECH_DELIVER_EVENT,
  ROUTER_TASK_CREATED_EVENT,
} from '../../src/adapters/mech/contracts.js';
import {
  createApplicationDeliveryObserver,
  type ApplicationMarketplaceDeliveryExpectation,
} from '../../src/application-delivery/delivery-observer.js';
import type {
  AutopilotDeliveryCandidateLookup,
  DiscoveryAPI,
} from '../../src/discovery/types.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';

const CHAIN_ID = 84532;
const TASK_ID = '501';
const TASK_CID = `f01551220${'33'.repeat(32)}`;
const TASK_DIGEST = `0x${'33'.repeat(32)}` as Hex;
const TASK_TX = `0x${'44'.repeat(32)}` as Hex;
const REQUEST_ID = `0x${'11'.repeat(32)}` as Hex;
const ENVELOPE_CID = `f01551220${'55'.repeat(32)}`;
const ENVELOPE_DIGEST = `0x${'55'.repeat(32)}` as Hex;
const DELIVERY_TX = `0x${'77'.repeat(32)}` as Hex;
const SOLVER = `0x${'22'.repeat(20)}` as Address;
const EVALUATOR = `0x${'23'.repeat(20)}` as Address;
const MECH = `0x${'aa'.repeat(20)}` as Address;
const MARKETPLACE = `0x${'ab'.repeat(20)}` as Address;
const ROUTER = `0x${'ac'.repeat(20)}` as Address;
const PRIVATE_KEY = `0x${'ac'.repeat(32)}` as Hex;
const AGENT_EOA = privateKeyToAccount(PRIVATE_KEY).address;
const APPLICATION = { id: 'autopilot.issue-relay', version: 'v2' } as const;

const taskSpec = {
  schemaVersion: 'jinn-repo.v1' as const,
  source: 'live-issue' as const,
  instance_id: 'autopilot-issue-relay-501',
  repo: 'Jinn-Network/mono' as const,
  base_commit: '1'.repeat(40),
  problem_statement: 'Implement the frozen issue.',
  language: 'typescript' as const,
  issue_number: 501,
  application: {
    ...APPLICATION,
    payload: {
      creatorOwnedContract: {
        schemaVersion: 'autopilot-owned.v1',
        frozen: true,
      },
    },
  },
};

function taskEnvelope() {
  return {
    schemaVersion: 'task.v1',
    id: 'autopilot-issue-relay-task-501',
    solverType: 'jinn-repo.v1',
    solverNetManifestCid: 'jinn-repo.v1',
    contractId: 'jinn-repo',
    contractVersion: 'v1',
    role: 'restoration',
    description: 'Implement the frozen issue.',
    window: { startTs: 1, endTs: 2 },
    spec: taskSpec,
    eligibility: {},
    claimPolicy: { maxClaims: 1 },
    creator: { safeAddress: SOLVER, agentEoa: AGENT_EOA },
    createdAt: 1,
    signature: {
      algo: 'secp256k1',
      signer: AGENT_EOA,
      hash: `0x${'1'.repeat(64)}`,
      sig: `0x${'2'.repeat(130)}`,
    },
  };
}

async function executionEnvelope(
  role: 'solution' | 'verdict',
  participant: Address,
) {
  const unsigned = {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'jinn-repo.v1',
    role,
    generatedAt: 1_753_350_000,
    task: {
      cid: TASK_CID,
      onchainCreationTx: TASK_TX,
      onchainCreationBlock: 100,
      requestId: REQUEST_ID,
    },
    participant: { safeAddress: participant, agentEoa: AGENT_EOA },
    window: { startTs: 1_753_349_000, endTs: 1_753_351_000 },
    executor: {
      implName: 'external-application-harness',
      implVersion: '1.0.0',
      clientGitSha: '8'.repeat(40),
      codeDigest: `sha256:${'9'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'a'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: AGENT_EOA },
      mode: 'frozen',
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: role === 'solution'
      ? {
          schemaVersion: 'jinn-repo-application-payload.v1',
          application: APPLICATION,
          role: 'solution',
          payload: { schemaVersion: 'autopilot-solution.v2', patch: 'opaque' },
        }
      : {
          schemaVersion: 'jinn-repo-application-payload.v1',
          application: APPLICATION,
          role: 'verdict',
          projection: 'pass',
          payload: { schemaVersion: 'autopilot-evaluation.v2', lanes: {} },
        },
  };
  const signature = await signCanonical(unsigned, PRIVATE_KEY, AGENT_EOA);
  return {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: signature.signer,
      hash: signature.hash,
      sig: signature.sig,
    },
  };
}

function taskLog() {
  const topics = encodeEventTopics({
    abi: [ROUTER_TASK_CREATED_EVENT],
    eventName: 'TaskCreated',
    args: {
      creator: SOLVER,
      taskId: BigInt(TASK_ID),
      manifestDigest: `0x${'99'.repeat(32)}`,
    },
  });
  return {
    address: ROUTER,
    topics,
    data: encodeAbiParameters([
      { name: 'taskCidDigest', type: 'bytes32' },
      { name: 'maxClaims', type: 'uint32' },
      { name: 'solutionBudget', type: 'uint256' },
      { name: 'verdictBudget', type: 'uint256' },
    ], [TASK_DIGEST, 1, 1n, 1n]),
    transactionHash: TASK_TX,
    blockNumber: 100n,
  };
}

function attemptLog(role: 'solution' | 'verdict', operator: Address) {
  const eventName = role === 'solution'
    ? 'TaskAttemptCreated'
    : 'EvaluationAttemptCreated';
  const topics = encodeEventTopics({
    abi: JINN_ROUTER_ABI,
    eventName,
    args: {
      taskId: BigInt(TASK_ID),
      attemptIndex: 0,
      ...(role === 'solution' ? { requestId: REQUEST_ID } : { verdictIndex: 0 }),
    },
  });
  const inputs = role === 'solution'
    ? [
        { name: 'operator', type: 'address' },
        { name: 'priorityMech', type: 'address' },
        { name: 'deliveryRate', type: 'uint256' },
      ]
    : [
        { name: 'requestId', type: 'bytes32' },
        { name: 'evaluator', type: 'address' },
        { name: 'priorityMech', type: 'address' },
        { name: 'deliveryRate', type: 'uint256' },
      ];
  const values = role === 'solution'
    ? [operator, MECH, 1n]
    : [REQUEST_ID, operator, MECH, 1n];
  return {
    address: ROUTER,
    topics,
    data: encodeAbiParameters(inputs as never, values as never),
  };
}

function deliveryLog(operator: Address) {
  const topics = encodeEventTopics({
    abi: [MECH_DELIVER_EVENT],
    eventName: 'Deliver',
    args: { mech: MECH, mechServiceMultisig: operator },
  });
  return {
    address: MECH,
    topics,
    data: encodeAbiParameters([
      { name: 'requestId', type: 'bytes32' },
      { name: 'deliveryRate', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ], [REQUEST_ID, 1n, ENVELOPE_DIGEST]),
    transactionHash: DELIVERY_TX,
    blockNumber: 120n,
  };
}

async function fixture(input: {
  role?: 'solution' | 'verdict';
  evaluator?: Address;
  application?: typeof APPLICATION;
} = {}) {
  const role = input.role ?? 'solution';
  const participant = role === 'solution' ? SOLVER : (input.evaluator ?? EVALUATOR);
  const signed = await executionEnvelope(role, participant);
  const signature = signed.signature as { hash: Hex };
  const ready: AutopilotDeliveryCandidateLookup = {
    status: 'ready',
    role,
    task: {
      taskId: TASK_ID,
      taskCidDigest: TASK_DIGEST,
      createdAtBlock: 100,
      createdAtTx: TASK_TX,
    },
    attempt: {
      taskId: TASK_ID,
      attemptIndex: 0,
      requestId: REQUEST_ID,
      operator: participant,
      createdAtBlock: 110,
    },
    solutionOperator: SOLVER,
    envelope: {
      requestId: REQUEST_ID,
      manifestCid: ENVELOPE_CID,
      publisherAgentId: '7',
      manifestHash: signature.hash,
      enrichedAtBlock: 121,
    },
  };
  const getLogs = vi.fn(({ address, event }) =>
    address === ROUTER && event?.name === 'TaskCreated'
      ? [taskLog()]
      : address === ROUTER
        ? [attemptLog(role, participant)]
        : [deliveryLog(participant)]);
  const observer = createApplicationDeliveryObserver({
    discovery: {
      getAutopilotDeliveryCandidates: vi.fn().mockResolvedValue(ready),
    } as unknown as DiscoveryAPI,
    publicClient: {
      getLogs,
      readContract: vi.fn().mockResolvedValue({ deliveryMech: MECH }),
    } as unknown as PublicClient,
    mechMarketplaceAddress: MARKETPLACE,
    routerAddress: ROUTER,
    fetchEnvelopeBytes: vi.fn().mockResolvedValue(
      new TextEncoder().encode(JSON.stringify(signed)),
    ),
    fetchTaskBytes: vi.fn().mockResolvedValue(
      new TextEncoder().encode(JSON.stringify(taskEnvelope())),
    ),
    resolvePublisherSafe: vi.fn().mockResolvedValue(participant),
  });
  const expectation: ApplicationMarketplaceDeliveryExpectation = {
    schemaVersion: 'jinn-application-delivery-expectation.v1',
    role,
    taskId: TASK_ID,
    taskCid: TASK_CID,
    creationBlockNumber: 100,
    chainId: CHAIN_ID,
    fromBlock: 100n,
    toBlock: 150n,
    application: input.application ?? APPLICATION,
    taskSpec,
    ...(role === 'verdict'
      ? {
          solutionOperatorSafe: SOLVER,
          attemptIndex: 0,
          requestId: REQUEST_ID,
          deliveryEnvelopeCid: ENVELOPE_CID,
        }
      : {}),
  };
  return { observer, expectation };
}

describe('application delivery observer', () => {
  it('authenticates generic transport while preserving an opaque application result', async () => {
    const value = await fixture();
    await expect(value.observer.observe(value.expectation)).resolves.toMatchObject({
      status: 'verified',
      role: 'solution',
      task: { taskId: TASK_ID, taskCid: TASK_CID },
      attempt: { operator: SOLVER, requestId: REQUEST_ID },
      payload: {
        schemaVersion: 'jinn-repo-application-payload.v1',
        application: APPLICATION,
        role: 'solution',
        payload: { schemaVersion: 'autopilot-solution.v2', patch: 'opaque' },
      },
    });
  });

  it('rejects an application mismatch and evaluator self-review', async () => {
    const wrongApplication = await fixture({
      application: { id: 'another.application', version: 'v2' },
    });
    await expect(wrongApplication.observer.observe(wrongApplication.expectation))
      .resolves.toMatchObject({ status: 'contradiction', reason: 'invalid-task' });

    const selfReview = await fixture({ role: 'verdict', evaluator: SOLVER });
    await expect(selfReview.observer.observe(selfReview.expectation))
      .resolves.toMatchObject({
        status: 'contradiction',
        reason: 'evaluator-is-solver',
      });
  });
});
