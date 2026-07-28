import type { Address, Hex, Log, PublicClient } from 'viem';
import {
  IssueRelayRoundV1Schema,
  IssueRelayVerdictV1Schema,
  JinnRepoLegacySolutionPayloadSchema,
  type IssueRelayRoundV1,
  type IssueRelayVerdictV1,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import { cidToDigestHex } from '../adapters/mech/ipfs.js';
import {
  decodeTaskCreatedLogs,
  findLatestDeliveryForRequest,
  getMarketplaceRequestDeliveryMech,
  ROUTER_TASK_CREATED_EVENT,
  verifyRouterAttemptProvenance,
  type DecodedTaskCreated,
} from '../adapters/mech/contracts.js';
import { authenticateExecutionEnvelope } from '../conformance/execution-envelope-authenticator.js';
import type { DiscoveryAPI } from '../discovery/types.js';
import type { SignedEnvelope } from '../types/envelope.js';

export interface IssueRelayDeliveryExpectation {
  readonly schemaVersion: 'jinn-issue-relay-delivery-expectation.v1';
  readonly role: 'solution' | 'verdict';
  readonly taskId: string;
  readonly taskCid: string;
  readonly creationBlockNumber: number;
  readonly round: IssueRelayRoundV1;
  readonly attemptIndex?: number;
  readonly requestId?: string;
  readonly deliveryEnvelopeCid?: string;
  readonly solutionOperatorSafe?: string;
}

/** Chain bounds are command-derived, never taken from the relay wire request. */
export interface IssueRelayMarketplaceDeliveryExpectation extends IssueRelayDeliveryExpectation {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export type IssueRelayDeliveryObservation =
  | { readonly status: 'pending'; readonly reason: string; readonly detail?: string }
  | { readonly status: 'contradiction'; readonly reason: string; readonly detail: string }
  | {
      readonly status: 'verified';
      readonly role: 'solution' | 'verdict';
      readonly task: { readonly taskId: string; readonly taskCid: string };
      readonly attempt: { readonly attemptIndex: number; readonly requestId: string; readonly operator: string };
      readonly delivery: { readonly envelopeCid: string; readonly transactionHash: string; readonly blockNumber: number };
      readonly round: IssueRelayRoundV1;
      readonly payload:
        | { readonly schemaVersion: 'jinn-repo-solution.v1'; readonly patch: string }
        | IssueRelayVerdictV1;
    };

export interface IssueRelayDeliveryObserverDeps {
  readonly discovery: Pick<DiscoveryAPI, 'getAutopilotDeliveryCandidates'>;
  readonly publicClient: PublicClient;
  readonly mechMarketplaceAddress: Address;
  readonly routerAddress: Address;
  readonly fetchEnvelopeBytes: (cid: string) => Promise<Uint8Array>;
  readonly resolvePublisherSafe: (chainId: number, publisherAgentId: string, publishedAtBlock: bigint) => Promise<string>;
}

export interface IssueRelayDeliveryObserver {
  observe(expected: IssueRelayMarketplaceDeliveryExpectation): Promise<IssueRelayDeliveryObservation>;
}

const TASK_CREATED_SCAN_CHUNK = 1000n;
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const pending = (reason: string, extra?: string): IssueRelayDeliveryObservation => extra === undefined ? { status: 'pending', reason } : { status: 'pending', reason, detail: extra };
const contradiction = (reason: string, error: string): IssueRelayDeliveryObservation => ({ status: 'contradiction', reason, detail: error });

function validExpectation(expected: IssueRelayMarketplaceDeliveryExpectation): IssueRelayDeliveryObservation | null {
  if (expected.schemaVersion !== 'jinn-issue-relay-delivery-expectation.v1' || !Number.isSafeInteger(expected.chainId) || expected.chainId <= 0 || !Number.isSafeInteger(expected.creationBlockNumber) || expected.creationBlockNumber < 0 || expected.fromBlock !== BigInt(expected.creationBlockNumber) || expected.toBlock < expected.fromBlock || !/^(0|[1-9][0-9]*)$/.test(expected.taskId) || !expected.taskCid || (expected.role !== 'solution' && expected.role !== 'verdict')) return contradiction('invalid-expectation', 'invalid Relay delivery identity or chain bounds');
  if (!IssueRelayRoundV1Schema.safeParse(expected.round).success) return contradiction('invalid-expectation', 'Relay round is invalid');
  if ((expected.attemptIndex === undefined) !== (expected.requestId === undefined)) return contradiction('invalid-expectation', 'attempt index and request ID must appear together');
  if (expected.attemptIndex !== undefined && (!Number.isSafeInteger(expected.attemptIndex) || expected.attemptIndex < 0 || !/^0x[0-9a-fA-F]{64}$/.test(expected.requestId!))) return contradiction('invalid-expectation', 'persisted attempt correlation is invalid');
  if (expected.role === 'verdict' && (!expected.solutionOperatorSafe || !/^0x[0-9a-fA-F]{40}$/.test(expected.solutionOperatorSafe))) return contradiction('invalid-expectation', 'verdict observation requires an authoritative solution Safe');
  return null;
}

async function exactTask(publicClient: PublicClient, routerAddress: Address, taskId: string, fromBlock: bigint, toBlock: bigint): Promise<DecodedTaskCreated[]> {
  const results: DecodedTaskCreated[] = [];
  for (let start = fromBlock; start <= toBlock; start += TASK_CREATED_SCAN_CHUNK + 1n) {
    const end = start + TASK_CREATED_SCAN_CHUNK > toBlock ? toBlock : start + TASK_CREATED_SCAN_CHUNK;
    const logs = await publicClient.getLogs({ address: routerAddress, event: ROUTER_TASK_CREATED_EVENT, args: { taskId: BigInt(taskId) }, fromBlock: start, toBlock: end });
    results.push(...decodeTaskCreatedLogs(logs as Log[]).filter((event) => event.taskId === taskId));
  }
  return results;
}

function sameRound(expected: IssueRelayRoundV1, actual: IssueRelayVerdictV1['correlation']): boolean {
  return expected.generation === actual.generation && expected.round === actual.round && expected.snapshotDigest === actual.snapshotDigest;
}

export function createIssueRelayDeliveryObserver(deps: IssueRelayDeliveryObserverDeps): IssueRelayDeliveryObserver {
  return { async observe(expected) {
    const invalid = validExpectation(expected); if (invalid) return invalid;
    let lookup: Awaited<ReturnType<typeof deps.discovery.getAutopilotDeliveryCandidates>>;
    try { lookup = await deps.discovery.getAutopilotDeliveryCandidates({ chainId: expected.chainId, taskId: expected.taskId, role: expected.role }); } catch (error) { return pending('discovery-unavailable', detail(error)); }
    if (lookup.status !== 'ready') return lookup.status === 'pending' ? pending(lookup.reason) : contradiction(lookup.reason, 'exact discovery returned contradictory rows');
    if (lookup.role !== expected.role || lookup.task.taskId !== expected.taskId || lookup.attempt.taskId !== expected.taskId || !same(lookup.envelope.requestId, lookup.attempt.requestId) || !/^0x[0-9a-fA-F]{40}$/.test(lookup.attempt.operator) || !/^0x[0-9a-fA-F]{40}$/.test(lookup.solutionOperator)) return contradiction('discovery-mismatch', 'exact discovery rows do not form the expected Task/attempt/envelope join');
    if (expected.role === 'verdict' && (same(lookup.attempt.operator, lookup.solutionOperator) || !same(expected.solutionOperatorSafe!, lookup.solutionOperator))) return contradiction('evaluator-is-solver', 'verdict evaluator must differ from the authoritative solution Safe');
    if (expected.attemptIndex !== undefined && (expected.attemptIndex !== lookup.attempt.attemptIndex || !same(expected.requestId!, lookup.attempt.requestId))) return contradiction('stale-attempt', 'persisted attempt differs from exact discovery');
    if (expected.deliveryEnvelopeCid !== undefined && expected.deliveryEnvelopeCid !== lookup.envelope.manifestCid) return contradiction('stale-delivery', 'persisted delivery CID differs from exact discovery');
    let publisher: string;
    try { publisher = await deps.resolvePublisherSafe(expected.chainId, lookup.envelope.publisherAgentId, BigInt(lookup.envelope.enrichedAtBlock)); } catch (error) { return pending('publisher-identity-unavailable', detail(error)); }
    if (!same(publisher, lookup.attempt.operator)) return contradiction('publisher-mismatch', 'publisher historical Safe differs from the delivery operator');
    let taskDigest: Hex; let created: DecodedTaskCreated[];
    try { taskDigest = cidToDigestHex(expected.taskCid); created = await exactTask(deps.publicClient, deps.routerAddress, expected.taskId, expected.fromBlock, expected.toBlock); } catch (error) { return pending('rpc-unavailable', detail(error)); }
    if (created.length !== 1 || !same(taskDigest, created[0]!.taskCidDigest) || !same(lookup.task.taskCidDigest, created[0]!.taskCidDigest) || lookup.task.createdAtBlock !== created[0]!.blockNumber || !created[0]!.transactionHash || !same(lookup.task.createdAtTx, created[0]!.transactionHash)) return contradiction('task-mismatch', 'expected CID or indexed Task provenance differs from Router TaskCreated');
    let envelopeDigest: Hex;
    try { envelopeDigest = cidToDigestHex(lookup.envelope.manifestCid); } catch (error) { return contradiction('invalid-envelope-cid', detail(error)); }
    let provenance: Awaited<ReturnType<typeof verifyRouterAttemptProvenance>>;
    try { provenance = await verifyRouterAttemptProvenance(deps.publicClient, deps.routerAddress, { role: expected.role, taskId: expected.taskId, attemptIndex: lookup.attempt.attemptIndex, requestId: lookup.attempt.requestId, operator: lookup.attempt.operator }, expected.fromBlock, expected.toBlock); } catch (error) { return pending('rpc-unavailable', detail(error)); }
    if (provenance !== 'verified') return contradiction('discovery-mismatch', `Router ${expected.role} attempt provenance is ${provenance}`);
    let delivery: Awaited<ReturnType<typeof findLatestDeliveryForRequest>>;
    try { const mech = await getMarketplaceRequestDeliveryMech(deps.publicClient, deps.mechMarketplaceAddress, lookup.attempt.requestId); delivery = await findLatestDeliveryForRequest(deps.publicClient, mech, lookup.attempt.requestId, expected.fromBlock, expected.toBlock); } catch (error) { return pending('rpc-unavailable', detail(error)); }
    if (!delivery) return pending('delivery-not-found');
    if (!same(delivery.requestId, lookup.attempt.requestId) || !same(delivery.deliveryDataHex, envelopeDigest) || !same(delivery.mechAddress, lookup.attempt.operator) || !delivery.transactionHash || delivery.blockNumber === undefined || delivery.blockNumber < expected.fromBlock || delivery.blockNumber > expected.toBlock || !Number.isSafeInteger(Number(delivery.blockNumber))) return contradiction('delivery-mismatch', 'Deliver request, digest, operator, transaction, or block differs');
    let envelopeBytes: Uint8Array;
    try { envelopeBytes = await deps.fetchEnvelopeBytes(lookup.envelope.manifestCid); } catch (error) { return pending('envelope-unavailable', detail(error)); }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(envelopeBytes)); } catch (error) { return contradiction('invalid-envelope', `invalid IPFS envelope bytes: ${detail(error)}`); }
    let signed: SignedEnvelope;
    try { signed = await authenticateExecutionEnvelope(raw, `Issue Relay delivery envelope ${lookup.envelope.manifestCid}`); } catch (error) { return contradiction('invalid-envelope', detail(error)); }
    if (signed.solverType !== 'jinn-repo.v1' || signed.role !== expected.role || !signed.task || signed.task.cid !== expected.taskCid || !same(signed.task.onchainCreationTx, created[0]!.transactionHash!) || signed.task.onchainCreationBlock !== created[0]!.blockNumber || !same(signed.task.requestId, lookup.attempt.requestId) || !same(signed.participant.safeAddress, lookup.attempt.operator) || !same(signed.signature.hash, lookup.envelope.manifestHash)) return contradiction('envelope-mismatch', 'authenticated envelope differs from indexed Task, attempt, role, operator, or hash');
    let payload: { readonly schemaVersion: 'jinn-repo-solution.v1'; readonly patch: string } | IssueRelayVerdictV1;
    if (expected.role === 'solution') {
      const parsedPayload = JinnRepoLegacySolutionPayloadSchema.safeParse(signed.payload);
      if (!parsedPayload.success) return contradiction('invalid-result', parsedPayload.error.message);
      payload = parsedPayload.data;
    } else {
      const parsedPayload = IssueRelayVerdictV1Schema.safeParse(signed.payload);
      if (!parsedPayload.success) return contradiction('invalid-result', parsedPayload.error.message);
      const verdict = parsedPayload.data as IssueRelayVerdictV1;
      if (!sameRound(expected.round, verdict.correlation) || verdict.correlation.taskId !== expected.taskId || verdict.correlation.attemptIndex !== lookup.attempt.attemptIndex || !same(verdict.correlation.requestId, lookup.attempt.requestId) || verdict.correlation.deliveryEnvelopeCid !== lookup.envelope.manifestCid) return contradiction('correlation-mismatch', 'verdict correlation differs from the complete Relay round and delivery tuple');
      payload = verdict;
    }
    return { status: 'verified', role: expected.role, task: { taskId: expected.taskId, taskCid: expected.taskCid }, attempt: { attemptIndex: lookup.attempt.attemptIndex, requestId: lookup.attempt.requestId, operator: lookup.attempt.operator }, delivery: { envelopeCid: lookup.envelope.manifestCid, transactionHash: delivery.transactionHash, blockNumber: Number(delivery.blockNumber) }, round: expected.round, payload };
  } };
}
