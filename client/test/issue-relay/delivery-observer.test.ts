import { describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createIssueRelayDeliveryObserver,
  type IssueRelayMarketplaceDeliveryExpectation,
} from '../../src/issue-relay/delivery-observer.js';
import { MECH_DELIVER_EVENT, ROUTER_TASK_CREATED_EVENT } from '../../src/adapters/mech/contracts.js';
import { JINN_ROUTER_ABI } from '../../src/adapters/mech/types.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';
import type { DiscoveryAPI, AutopilotDeliveryCandidateLookup } from '../../src/discovery/types.js';

const CHAIN_ID = 84532;
const TASK_ID = '501';
const TASK_CID = `f01551220${'33'.repeat(32)}`;
const TASK_DIGEST = `0x${'33'.repeat(32)}` as Hex;
const TASK_TX = `0x${'44'.repeat(32)}` as Hex;
const REQUEST_ID = `0x${'11'.repeat(32)}` as Hex;
const ENVELOPE_CID = `f01551220${'55'.repeat(32)}`;
const ENVELOPE_DIGEST = `0x${'55'.repeat(32)}` as Hex;
const DELIVERY_TX = `0x${'77'.repeat(32)}` as Hex;
const OPERATOR = `0x${'22'.repeat(20)}` as Address;
const EVALUATOR = `0x${'23'.repeat(20)}` as Address;
const MECH = `0x${'aa'.repeat(20)}` as Address;
const MARKETPLACE = `0x${'ab'.repeat(20)}` as Address;
const ROUTER = `0x${'ac'.repeat(20)}` as Address;
const PRIVATE_KEY = `0x${'ac'.repeat(32)}` as Hex;
const AGENT_EOA = privateKeyToAccount(PRIVATE_KEY).address;

const round = {
  schemaVersion: 'jinn-issue-relay-round.v1' as const,
  generation: 'relay:501', round: 0,
  snapshotDigest: `sha256:${'a'.repeat(64)}` as const,
  targetRepository: 'Jinn-Network/mono', workspaceRepository: 'Jinn-Network/mono',
  inputHead: '1'.repeat(40), purpose: 'initial' as const, findings: [],
};

async function envelope(role: 'solution' | 'verdict', payload: unknown, override: Record<string, unknown> = {}) {
  const unsigned = {
    schemaVersion: 'jinn.execution.v1', solverType: 'jinn-repo.v1', role,
    generatedAt: 1_753_350_000,
    task: { cid: TASK_CID, onchainCreationTx: TASK_TX, onchainCreationBlock: 100, requestId: REQUEST_ID },
    participant: { safeAddress: role === 'solution' ? OPERATOR : EVALUATOR, agentEoa: AGENT_EOA },
    window: { startTs: 1_753_349_000, endTs: 1_753_351_000 },
    executor: { implName: 'jinn-repo-relay', implVersion: '1.0.0', clientGitSha: '8'.repeat(40), codeDigest: `sha256:${'9'.repeat(64)}`, runtimeBundleDigest: `sha256:${'a'.repeat(64)}`, plugins: [], signingKey: { kind: 'agent-eoa', pubkey: AGENT_EOA }, mode: 'frozen' },
    evidenceTier: 'self-signed', attestation: null, trajectory: null, artifacts: [], payload, ...override,
  };
  const signature = await signCanonical(unsigned, PRIVATE_KEY, AGENT_EOA);
  return { ...unsigned, signature: { algo: 'secp256k1', signer: signature.signer, hash: signature.hash, sig: signature.sig } };
}

function taskLog() {
  const topics = encodeEventTopics({ abi: [ROUTER_TASK_CREATED_EVENT], eventName: 'TaskCreated', args: { creator: OPERATOR, taskId: BigInt(TASK_ID), manifestDigest: `0x${'99'.repeat(32)}` } });
  return { address: ROUTER, topics, data: encodeAbiParameters([{ name: 'taskCidDigest', type: 'bytes32' }, { name: 'maxClaims', type: 'uint32' }, { name: 'solutionBudget', type: 'uint256' }, { name: 'verdictBudget', type: 'uint256' }], [TASK_DIGEST, 1, 1n, 1n]), transactionHash: TASK_TX, blockNumber: 100n };
}
function attemptLog(role: 'solution' | 'verdict', operator: Address, requestId = REQUEST_ID) {
  const eventName = role === 'solution' ? 'TaskAttemptCreated' : 'EvaluationAttemptCreated';
  const topics = encodeEventTopics({ abi: JINN_ROUTER_ABI, eventName, args: { taskId: BigInt(TASK_ID), attemptIndex: 0, ...(role === 'solution' ? { requestId } : { verdictIndex: 0 }) } });
  const inputs = role === 'solution' ? [{ name: 'operator', type: 'address' }, { name: 'priorityMech', type: 'address' }, { name: 'deliveryRate', type: 'uint256' }] : [{ name: 'requestId', type: 'bytes32' }, { name: 'evaluator', type: 'address' }, { name: 'priorityMech', type: 'address' }, { name: 'deliveryRate', type: 'uint256' }];
  const values = role === 'solution' ? [operator, MECH, 1n] : [requestId, operator, MECH, 1n];
  return { address: ROUTER, topics, data: encodeAbiParameters(inputs as never, values as never) };
}
function deliveryLog(operator: Address, requestId = REQUEST_ID, digest = ENVELOPE_DIGEST) {
  const topics = encodeEventTopics({ abi: [MECH_DELIVER_EVENT], eventName: 'Deliver', args: { mech: MECH, mechServiceMultisig: operator } });
  return { address: MECH, topics, data: encodeAbiParameters([{ name: 'requestId', type: 'bytes32' }, { name: 'deliveryRate', type: 'uint256' }, { name: 'data', type: 'bytes' }], [requestId, 1n, digest]), transactionHash: DELIVERY_TX, blockNumber: 120n };
}

async function fixture(options: { role?: 'solution' | 'verdict'; payload?: unknown; envelopeOverride?: Record<string, unknown>; publisher?: Address; solutionOperator?: Address; expectation?: Partial<IssueRelayMarketplaceDeliveryExpectation>; rawEnvelopeBytes?: Uint8Array; mutate?: (value: Record<string, unknown>) => void } = {}) {
  const role = options.role ?? 'solution';
  const payload = options.payload ?? (role === 'solution'
    ? { schemaVersion: 'jinn-repo-solution.v1', patch: 'diff --git a/a.ts b/a.ts\n' }
    : { schemaVersion: 'jinn-issue-relay-verdict.v1', outcome: 'pass', correlation: { generation: round.generation, round: round.round, snapshotDigest: round.snapshotDigest, taskId: TASK_ID, attemptIndex: 0, requestId: REQUEST_ID, deliveryEnvelopeCid: ENVELOPE_CID }, evaluatedHead: round.inputHead, summary: 'looks good', findings: [] });
  const signed = await envelope(role, payload, options.envelopeOverride);
  options.mutate?.(signed);
  const signature = signed.signature as { hash: Hex };
  const ready: AutopilotDeliveryCandidateLookup = { status: 'ready', role, task: { taskId: TASK_ID, taskCidDigest: TASK_DIGEST, createdAtBlock: 100, createdAtTx: TASK_TX }, attempt: { taskId: TASK_ID, attemptIndex: 0, requestId: REQUEST_ID, operator: role === 'solution' ? OPERATOR : EVALUATOR, createdAtBlock: 110 }, solutionOperator: options.solutionOperator ?? OPERATOR, envelope: { requestId: REQUEST_ID, manifestCid: ENVELOPE_CID, publisherAgentId: '7', manifestHash: signature.hash, enrichedAtBlock: 121 } };
  const getLogs = vi.fn(({ address, event }) => address === ROUTER && event?.name === 'TaskCreated' ? [taskLog()] : address === ROUTER ? [attemptLog(role, role === 'solution' ? OPERATOR : EVALUATOR)] : [deliveryLog(role === 'solution' ? OPERATOR : EVALUATOR)]);
  const observer = createIssueRelayDeliveryObserver({ discovery: { getAutopilotDeliveryCandidates: vi.fn().mockResolvedValue(ready) } as unknown as DiscoveryAPI, publicClient: { getLogs, readContract: vi.fn().mockResolvedValue({ deliveryMech: MECH }) } as unknown as PublicClient, mechMarketplaceAddress: MARKETPLACE, routerAddress: ROUTER, fetchEnvelopeBytes: vi.fn().mockResolvedValue(options.rawEnvelopeBytes ?? new TextEncoder().encode(JSON.stringify(signed))), resolvePublisherSafe: vi.fn().mockResolvedValue(options.publisher ?? (role === 'solution' ? OPERATOR : EVALUATOR)) });
  const expectation: IssueRelayMarketplaceDeliveryExpectation = { chainId: CHAIN_ID, fromBlock: 100n, toBlock: 150n, schemaVersion: 'jinn-issue-relay-delivery-expectation.v1', role, taskId: TASK_ID, taskCid: TASK_CID, creationBlockNumber: 100, round, ...(role === 'verdict' ? { solutionOperatorSafe: OPERATOR } : {}), ...options.expectation };
  return { observer, expectation };
}

describe('Issue Relay delivery observer', () => {
  it('verifies a signed solution bound to the exact task and chain facts', async () => {
    const value = await fixture();
    await expect(value.observer.observe(value.expectation)).resolves.toMatchObject({ status: 'verified', role: 'solution', task: { taskId: TASK_ID, taskCid: TASK_CID }, attempt: { requestId: REQUEST_ID, operator: OPERATOR }, delivery: { envelopeCid: ENVELOPE_CID, transactionHash: DELIVERY_TX, blockNumber: 120 }, round, payload: { schemaVersion: 'jinn-repo-solution.v1' } });
  });

  it('rejects an unknown expectation schema version and malformed fetched bytes', async () => {
    const unknownSchema = await fixture({ expectation: { schemaVersion: 'other.v1' as never } });
    await expect(unknownSchema.observer.observe(unknownSchema.expectation)).resolves.toMatchObject({ status: 'contradiction', reason: 'invalid-expectation' });
    const malformedBytes = await fixture({ rawEnvelopeBytes: new Uint8Array([0xff]) });
    await expect(malformedBytes.observer.observe(malformedBytes.expectation)).resolves.toMatchObject({ status: 'contradiction', reason: 'invalid-envelope' });
  });

  it.each([
    ['wrong task', { taskId: '502' }, 'discovery-mismatch'],
    ['wrong task CID', { taskCid: `f01551220${'88'.repeat(32)}` }, 'task-mismatch'],
    ['stale delivery pin', { deliveryEnvelopeCid: `f01551220${'88'.repeat(32)}` }, 'stale-delivery'],
    ['stale request pin', { attemptIndex: 0, requestId: `0x${'88'.repeat(32)}` }, 'stale-attempt'],
  ] as const)('fails closed on %s', async (_name, expectation, reason) => {
    const value = await fixture({ expectation });
    await expect(value.observer.observe(value.expectation)).resolves.toMatchObject({ status: 'contradiction', reason });
  });

  it.each([
    ['wrong role', { role: 'verdict' }, 'envelope-mismatch'],
    ['wrong signer', {}, 'invalid-envelope'],
    ['wrong publisher Safe', {}, 'publisher-mismatch'],
    ['invalid solution payload', {}, 'invalid-result'],
  ] as const)('rejects %s', async (kind, _ignored, reason) => {
    const value = kind === 'wrong role'
      ? await fixture({ envelopeOverride: { role: 'verdict' } })
      : kind === 'wrong signer'
        ? await fixture({ mutate: (raw) => { (raw.signature as { signer: string }).signer = EVALUATOR; } })
        : kind === 'wrong publisher Safe'
          ? await fixture({ publisher: EVALUATOR })
          : await fixture({ payload: { schemaVersion: 'jinn-repo-solution.v1', patch: '' } });
    await expect(value.observer.observe(value.expectation)).resolves.toMatchObject({ status: 'contradiction', reason });
  });

  it('requires a distinct evaluator and a verdict correlation bound to the round snapshot', async () => {
    const selfEvaluated = await fixture({ role: 'verdict', solutionOperator: EVALUATOR });
    await expect(selfEvaluated.observer.observe(selfEvaluated.expectation)).resolves.toMatchObject({ status: 'contradiction', reason: 'evaluator-is-solver' });
    const snapshotMismatch = await fixture({ role: 'verdict', payload: { schemaVersion: 'jinn-issue-relay-verdict.v1', outcome: 'pass', correlation: { generation: round.generation, round: round.round, snapshotDigest: `sha256:${'b'.repeat(64)}`, taskId: TASK_ID, attemptIndex: 0, requestId: REQUEST_ID, deliveryEnvelopeCid: ENVELOPE_CID }, evaluatedHead: round.inputHead, summary: 'looks good', findings: [] } });
    await expect(snapshotMismatch.observer.observe(snapshotMismatch.expectation)).resolves.toMatchObject({ status: 'contradiction', reason: 'correlation-mismatch' });
    const roundMismatch = await fixture({ role: 'verdict', expectation: { round: { ...round, round: 1 } } });
    await expect(roundMismatch.observer.observe(roundMismatch.expectation)).resolves.toMatchObject({ status: 'contradiction', reason: 'correlation-mismatch' });
  });
});
