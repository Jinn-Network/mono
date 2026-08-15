import type { Address, Hex, Log, PublicClient } from 'viem';
import {
  AutopilotCorrelationSchema,
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
  AutopilotSessionCapsuleSchema,
  autopilotCorrelationMatches,
  type AutopilotCorrelation,
  type AutopilotMutationResult,
  type AutopilotReviewResult,
  type AutopilotSessionCapsule,
} from '@jinn-network/sdk/autopilot';

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
// One-swap R3b (issue #2494) relocated the indexer read this observer drives
// (`getAutopilotDeliveryCandidates`) onto `discovery-client/`. Typing against
// the relocated client — not the legacy `DiscoveryAPI` — is what keeps the
// `jinn tasks observe-autopilot-delivery` verb free of any path into
// `operator/src/discovery/`, so the D-wave can delete that tree without taking
// the published external boundary down with it.
import type {
  AutopilotDeliveryCandidateLookup,
  AutopilotDeliveryRole,
  DiscoveryClient,
} from '../discovery-client/types.js';
import type { SignedEnvelope } from '../types/envelope.js';

export interface AutopilotMarketplaceDeliveryObserverDeps {
  discovery: Pick<DiscoveryClient, 'getAutopilotDeliveryCandidates'>;
  publicClient: PublicClient;
  mechMarketplaceAddress: Address;
  routerAddress: Address;
  /** Fetch the exact bytes stored for one IPFS CID. */
  fetchEnvelopeBytes(cid: string): Promise<Uint8Array>;
  /** Resolve the publisher agent's Safe at the exact metadata anchor block. */
  resolvePublisherSafe(
    chainId: number,
    publisherAgentId: string,
    publishedAtBlock: bigint,
  ): Promise<string>;
}

export interface AutopilotExpectedCorrelationExtension {
  resultingHead?: string;
  reviewedHead?: string;
  reviewGeneration?: string;
  reviewRefOid?: string;
}

/**
 * Locally authoritative facts for one marketplace-backed Autopilot session.
 *
 * attempt/request and delivery fields are optional crash-recovery pins. When
 * present, the observer requires the newly resolved exact facts to match them.
 */
export interface AutopilotMarketplaceDeliveryExpectation {
  chainId: number;
  role: AutopilotDeliveryRole;
  taskId: string;
  taskCid: string;
  session: AutopilotSessionCapsule;
  fromBlock: bigint;
  toBlock: bigint;
  attemptIndex?: number;
  requestId?: string;
  deliveryEnvelopeCid?: string;
  deliveryTransactionHash?: string;
  deliveryBlockNumber?: bigint;
  /** Authoritative solution-attempt Safe, required when observing a verdict. */
  solutionOperator?: string;
  expectedCorrelation?: AutopilotExpectedCorrelationExtension;
}

type DiscoveryPendingReason = Extract<
  AutopilotDeliveryCandidateLookup,
  { status: 'pending' }
>['reason'];

type DiscoveryContradictionReason = Extract<
  AutopilotDeliveryCandidateLookup,
  { status: 'contradiction' }
>['reason'];

export type AutopilotMarketplaceDeliveryPendingReason =
  | DiscoveryPendingReason
  | 'discovery-unavailable'
  | 'delivery-not-found'
  | 'rpc-unavailable'
  | 'publisher-identity-unavailable'
  | 'envelope-unavailable';

export type AutopilotMarketplaceDeliveryContradictionReason =
  | DiscoveryContradictionReason
  | 'invalid-expectation'
  | 'discovery-mismatch'
  | 'publisher-mismatch'
  | 'evaluator-is-solver'
  | 'stale-attempt'
  | 'stale-delivery'
  | 'task-mismatch'
  | 'invalid-envelope-cid'
  | 'delivery-mismatch'
  | 'invalid-envelope'
  | 'envelope-mismatch'
  | 'invalid-result'
  | 'correlation-mismatch';

export interface VerifiedAutopilotMarketplaceDelivery {
  status: 'verified';
  role: AutopilotDeliveryRole;
  task: {
    taskId: string;
    taskCid: string;
    taskCidDigest: Hex;
    createdAtBlock: number;
    createdAtTx: Hex;
  };
  attempt: {
    attemptIndex: number;
    requestId: Hex;
    operator: Address;
    createdAtBlock: number | null;
  };
  delivery: {
    envelopeCid: string;
    envelopeDigest: Hex;
    /** Historical ERC-8004 publisher agent resolved to the attempt Safe. */
    publisherAgentId: string;
    transactionHash: Hex;
    blockNumber: bigint;
  };
  envelope: SignedEnvelope;
  result: AutopilotMutationResult | AutopilotReviewResult;
  correlation: AutopilotCorrelation;
}

export type AutopilotMarketplaceDeliveryObservation =
  | {
      status: 'pending';
      reason: AutopilotMarketplaceDeliveryPendingReason;
      detail?: string;
    }
  | {
      status: 'contradiction';
      reason: AutopilotMarketplaceDeliveryContradictionReason;
      detail: string;
    }
  | VerifiedAutopilotMarketplaceDelivery;

export interface AutopilotMarketplaceDeliveryObserver {
  observe(
    expected: AutopilotMarketplaceDeliveryExpectation,
  ): Promise<AutopilotMarketplaceDeliveryObservation>;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function contradiction(
  reason: AutopilotMarketplaceDeliveryContradictionReason,
  detail: string,
): AutopilotMarketplaceDeliveryObservation {
  return { status: 'contradiction', reason, detail };
}

function pending(
  reason: AutopilotMarketplaceDeliveryPendingReason,
  detail?: string,
): AutopilotMarketplaceDeliveryObservation {
  return detail === undefined
    ? { status: 'pending', reason }
    : { status: 'pending', reason, detail };
}

function parseEnvelopeBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

const TASK_CREATED_SCAN_CHUNK = 1000n;

async function findExactTaskCreated(
  publicClient: PublicClient,
  routerAddress: Address,
  taskId: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<DecodedTaskCreated[]> {
  const matches: DecodedTaskCreated[] = [];
  for (
    let start = fromBlock;
    start <= toBlock;
    start += TASK_CREATED_SCAN_CHUNK + 1n
  ) {
    const end = start + TASK_CREATED_SCAN_CHUNK > toBlock
      ? toBlock
      : start + TASK_CREATED_SCAN_CHUNK;
    const logs = await publicClient.getLogs({
      address: routerAddress,
      event: ROUTER_TASK_CREATED_EVENT,
      args: { taskId: BigInt(taskId) },
      fromBlock: start,
      toBlock: end,
    });
    matches.push(
      ...decodeTaskCreatedLogs(logs as Log[]).filter((event) => event.taskId === taskId),
    );
  }
  return matches;
}

function validateExpectation(
  expected: AutopilotMarketplaceDeliveryExpectation,
): AutopilotMarketplaceDeliveryObservation | null {
  if (
    !Number.isSafeInteger(expected.chainId)
    || expected.chainId < 0
    || (expected.role !== 'solution' && expected.role !== 'verdict')
    || !/^(0|[1-9][0-9]*)$/.test(expected.taskId)
    || expected.taskCid.length === 0
    || expected.fromBlock < 0n
    || expected.toBlock < expected.fromBlock
  ) {
    return contradiction('invalid-expectation', 'invalid chain, Task, CID, or block bounds');
  }
  if (
    expected.solutionOperator !== undefined
    && !/^0x[0-9a-fA-F]{40}$/.test(expected.solutionOperator)
  ) {
    return contradiction(
      'invalid-expectation',
      'authoritative solution operator is invalid',
    );
  }
  if (expected.role === 'verdict' && expected.solutionOperator === undefined) {
    return contradiction(
      'invalid-expectation',
      'verdict observation requires the authoritative solution operator',
    );
  }
  if ((expected.attemptIndex === undefined) !== (expected.requestId === undefined)) {
    return contradiction(
      'invalid-expectation',
      'persisted attempt index and request ID must appear together',
    );
  }
  if (
    expected.attemptIndex !== undefined
    && (
      !Number.isSafeInteger(expected.attemptIndex)
      || expected.attemptIndex < 0
      || !/^0x[0-9a-fA-F]{64}$/.test(expected.requestId!)
    )
  ) {
    return contradiction('invalid-expectation', 'persisted attempt correlation is invalid');
  }
  if (
    expected.deliveryTransactionHash !== undefined
    && !/^0x[0-9a-fA-F]{64}$/.test(expected.deliveryTransactionHash)
  ) {
    return contradiction('invalid-expectation', 'persisted delivery transaction is invalid');
  }
  if (
    expected.deliveryBlockNumber !== undefined
    && expected.deliveryBlockNumber < 0n
  ) {
    return contradiction('invalid-expectation', 'persisted delivery block is invalid');
  }
  const parsedSession = AutopilotSessionCapsuleSchema.safeParse(expected.session);
  if (!parsedSession.success) {
    return contradiction('invalid-expectation', 'expected session capsule is invalid');
  }
  return null;
}

function expectedCorrelationFor(
  expected: AutopilotMarketplaceDeliveryExpectation,
  ready: Extract<AutopilotDeliveryCandidateLookup, { status: 'ready' }>,
): AutopilotCorrelation | null {
  const extension = expected.expectedCorrelation ?? {};
  const candidate = {
    taskId: expected.taskId,
    attemptIndex: ready.attempt.attemptIndex,
    requestId: ready.attempt.requestId,
    deliveryEnvelopeCid: ready.envelope.manifestCid,
    v2AttemptId: expected.session.v2AttemptId,
    claimOid: expected.session.claimOid,
    prNumber: expected.session.prNumber,
    expectedHead: expected.session.expectedHead,
    ...(extension.resultingHead === undefined
      ? {}
      : { resultingHead: extension.resultingHead }),
    ...(extension.reviewedHead === undefined
      ? {}
      : { reviewedHead: extension.reviewedHead }),
    ...(extension.reviewGeneration === undefined
      ? {}
      : { reviewGeneration: extension.reviewGeneration }),
    ...(extension.reviewRefOid === undefined
      ? {}
      : { reviewRefOid: extension.reviewRefOid }),
  };
  const parsed = AutopilotCorrelationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function createAutopilotMarketplaceDeliveryObserver(
  deps: AutopilotMarketplaceDeliveryObserverDeps,
): AutopilotMarketplaceDeliveryObserver {
  return {
    async observe(
      expected: AutopilotMarketplaceDeliveryExpectation,
    ): Promise<AutopilotMarketplaceDeliveryObservation> {
      const invalidExpectation = validateExpectation(expected);
      if (invalidExpectation) return invalidExpectation;

      let lookup: AutopilotDeliveryCandidateLookup;
      try {
        lookup = await deps.discovery.getAutopilotDeliveryCandidates({
          chainId: expected.chainId,
          taskId: expected.taskId,
          role: expected.role,
        });
      } catch (error) {
        return pending('discovery-unavailable', errorDetail(error));
      }
      if (lookup.status === 'pending') return pending(lookup.reason);
      if (lookup.status === 'contradiction') {
        return contradiction(lookup.reason, 'exact discovery returned contradictory rows');
      }
      if (
        lookup.role !== expected.role
        || lookup.task.taskId !== expected.taskId
        || lookup.attempt.taskId !== expected.taskId
        || !/^0x[0-9a-fA-F]{40}$/.test(lookup.attempt.operator)
        || !/^0x[0-9a-fA-F]{40}$/.test(lookup.solutionOperator)
        || !sameHex(lookup.envelope.requestId, lookup.attempt.requestId)
        || (
          lookup.attempt.createdAtBlock !== null
          && lookup.task.createdAtBlock > lookup.attempt.createdAtBlock
        )
      ) {
        return contradiction(
          'discovery-mismatch',
          'exact discovery rows do not form the expected Task/attempt/envelope join',
        );
      }
      if (
        !sameHex(
          lookup.solutionOperator,
          expected.solutionOperator ?? lookup.attempt.operator,
        )
      ) {
        return contradiction(
          'discovery-mismatch',
          'exact discovery solution operator differs from the authoritative attempt',
        );
      }
      if (
        expected.role === 'verdict'
        && sameHex(lookup.attempt.operator, lookup.solutionOperator)
      ) {
        return contradiction(
          'evaluator-is-solver',
          'verdict evaluator must be distinct from the solution operator',
        );
      }

      let publisherSafe: string;
      try {
        publisherSafe = await deps.resolvePublisherSafe(
          expected.chainId,
          lookup.envelope.publisherAgentId,
          BigInt(lookup.envelope.enrichedAtBlock),
        );
      } catch (error) {
        return pending('publisher-identity-unavailable', errorDetail(error));
      }
      if (!sameHex(publisherSafe, lookup.attempt.operator)) {
        return contradiction(
          'publisher-mismatch',
          'publisher agent historical Safe differs from the delivery operator',
        );
      }

      if (
        expected.attemptIndex !== undefined
        && (
          expected.attemptIndex !== lookup.attempt.attemptIndex
          || !sameHex(expected.requestId!, lookup.attempt.requestId)
        )
      ) {
        return contradiction(
          'stale-attempt',
          'persisted attempt correlation differs from exact discovery',
        );
      }
      if (
        expected.deliveryEnvelopeCid !== undefined
        && expected.deliveryEnvelopeCid !== lookup.envelope.manifestCid
      ) {
        return contradiction(
          'stale-delivery',
          'persisted delivery envelope CID differs from exact discovery',
        );
      }

      let taskCidDigest: Hex;
      let envelopeDigest: Hex;
      try {
        taskCidDigest = cidToDigestHex(expected.taskCid);
      } catch (error) {
        return contradiction('task-mismatch', `invalid expected Task CID: ${errorDetail(error)}`);
      }
      let taskCreatedMatches: DecodedTaskCreated[];
      try {
        taskCreatedMatches = await findExactTaskCreated(
          deps.publicClient,
          deps.routerAddress,
          expected.taskId,
          expected.fromBlock,
          expected.toBlock,
        );
      } catch (error) {
        return pending('rpc-unavailable', errorDetail(error));
      }
      if (taskCreatedMatches.length !== 1) {
        return contradiction(
          'task-mismatch',
          `Router TaskCreated provenance count is ${taskCreatedMatches.length}; expected exactly one`,
        );
      }
      const taskCreated = taskCreatedMatches[0]!;
      if (
        taskCreated.transactionHash === undefined
        || taskCreated.blockNumber === undefined
        || taskCreated.blockNumber < expected.fromBlock
        || taskCreated.blockNumber > expected.toBlock
        || !sameHex(taskCidDigest, taskCreated.taskCidDigest)
        || !sameHex(lookup.task.taskCidDigest, taskCreated.taskCidDigest)
        || lookup.task.createdAtBlock !== taskCreated.blockNumber
        || !sameHex(lookup.task.createdAtTx, taskCreated.transactionHash)
      ) {
        return contradiction(
          'task-mismatch',
          'expected CID or indexed Task provenance differs from Router TaskCreated',
        );
      }
      try {
        envelopeDigest = cidToDigestHex(lookup.envelope.manifestCid);
      } catch (error) {
        return contradiction(
          'invalid-envelope-cid',
          `indexed delivery envelope CID is invalid: ${errorDetail(error)}`,
        );
      }

      let provenance: Awaited<ReturnType<typeof verifyRouterAttemptProvenance>>;
      try {
        provenance = await verifyRouterAttemptProvenance(
          deps.publicClient,
          deps.routerAddress,
          {
            role: expected.role,
            taskId: expected.taskId,
            attemptIndex: lookup.attempt.attemptIndex,
            requestId: lookup.attempt.requestId,
            operator: lookup.attempt.operator,
          },
          expected.fromBlock,
          expected.toBlock,
        );
      } catch (error) {
        return pending('rpc-unavailable', errorDetail(error));
      }
      if (provenance !== 'verified') {
        return contradiction(
          'discovery-mismatch',
          `Router ${expected.role} attempt provenance is ${provenance}`,
        );
      }

      let delivery: Awaited<ReturnType<typeof findLatestDeliveryForRequest>>;
      let deliveryMech: Address;
      try {
        deliveryMech = await getMarketplaceRequestDeliveryMech(
          deps.publicClient,
          deps.mechMarketplaceAddress,
          lookup.attempt.requestId,
        );
        delivery = await findLatestDeliveryForRequest(
          deps.publicClient,
          deliveryMech,
          lookup.attempt.requestId,
          expected.fromBlock,
          expected.toBlock,
        );
      } catch (error) {
        return pending('rpc-unavailable', errorDetail(error));
      }
      if (!delivery) return pending('delivery-not-found');
      if (
        !sameHex(delivery.requestId, lookup.attempt.requestId)
        || !sameHex(delivery.deliveryDataHex, envelopeDigest)
        || !sameHex(delivery.mechAddress, lookup.attempt.operator)
        || delivery.transactionHash === undefined
        || delivery.blockNumber === undefined
        || delivery.blockNumber < expected.fromBlock
        || delivery.blockNumber > expected.toBlock
      ) {
        return contradiction(
          'delivery-mismatch',
          'Deliver request, digest, operator, transaction, or block differs',
        );
      }
      if (
        (expected.deliveryTransactionHash !== undefined
          && !sameHex(expected.deliveryTransactionHash, delivery.transactionHash))
        || (
          expected.deliveryBlockNumber !== undefined
          && expected.deliveryBlockNumber !== delivery.blockNumber
        )
      ) {
        return contradiction(
          'stale-delivery',
          'persisted delivery transaction or block differs from RPC',
        );
      }

      let envelopeBytes: Uint8Array;
      try {
        envelopeBytes = await deps.fetchEnvelopeBytes(lookup.envelope.manifestCid);
      } catch (error) {
        return pending('envelope-unavailable', errorDetail(error));
      }

      let rawEnvelope: unknown;
      try {
        rawEnvelope = parseEnvelopeBytes(envelopeBytes);
      } catch (error) {
        return contradiction(
          'invalid-envelope',
          `invalid IPFS envelope bytes: ${errorDetail(error)}`,
        );
      }

      let envelope: SignedEnvelope;
      try {
        envelope = await authenticateExecutionEnvelope(
          rawEnvelope,
          `Autopilot delivery envelope ${lookup.envelope.manifestCid}`,
        );
      } catch (error) {
        return contradiction('invalid-envelope', errorDetail(error));
      }

      const envelopeTask = envelope.task;
      if (
        envelope.solverType !== 'jinn-repo.v1'
        || envelope.role !== expected.role
        || envelopeTask === undefined
        || envelopeTask.cid !== expected.taskCid
        || !sameHex(envelopeTask.onchainCreationTx, taskCreated.transactionHash)
        || envelopeTask.onchainCreationBlock !== taskCreated.blockNumber
        || !sameHex(envelopeTask.requestId, lookup.attempt.requestId)
        || !sameHex(envelope.participant.safeAddress, lookup.attempt.operator)
        || !sameHex(envelope.signature.hash, lookup.envelope.manifestHash)
      ) {
        return contradiction(
          'envelope-mismatch',
          'authenticated envelope differs from indexed Task, attempt, role, operator, or hash',
        );
      }

      const resultParse = expected.role === 'solution'
        ? AutopilotMutationResultSchema.safeParse(envelope.payload)
        : AutopilotReviewResultSchema.safeParse(envelope.payload);
      if (!resultParse.success) {
        return contradiction(
          'invalid-result',
          resultParse.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; '),
        );
      }

      const expectedCorrelation = expectedCorrelationFor(expected, lookup);
      if (expectedCorrelation === null) {
        return contradiction(
          'invalid-expectation',
          'expected complete result correlation is invalid',
        );
      }
      if (!autopilotCorrelationMatches(expectedCorrelation, resultParse.data.correlation)) {
        return contradiction(
          'correlation-mismatch',
          'result correlation differs from the complete expected marketplace/session tuple',
        );
      }

      return {
        status: 'verified',
        role: expected.role,
        task: {
          taskId: lookup.task.taskId,
          taskCid: expected.taskCid,
          taskCidDigest,
          createdAtBlock: taskCreated.blockNumber,
          createdAtTx: taskCreated.transactionHash,
        },
        attempt: {
          attemptIndex: lookup.attempt.attemptIndex,
          requestId: lookup.attempt.requestId,
          operator: lookup.attempt.operator,
          createdAtBlock: lookup.attempt.createdAtBlock,
        },
        delivery: {
          envelopeCid: lookup.envelope.manifestCid,
          envelopeDigest,
          publisherAgentId: lookup.envelope.publisherAgentId,
          transactionHash: delivery.transactionHash,
          blockNumber: delivery.blockNumber,
        },
        envelope,
        result: resultParse.data,
        correlation: resultParse.data.correlation,
      };
    },
  };
}
