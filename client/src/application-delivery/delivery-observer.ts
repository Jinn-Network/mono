import { isDeepStrictEqual } from 'node:util';
import type { Address, Hex, Log, PublicClient } from 'viem';
import {
  JinnRepoApplicationRefSchema,
  JinnRepoApplicationSolutionPayloadSchema,
  JinnRepoApplicationVerdictPayloadSchema,
  JinnRepoTaskSchema,
  type JinnRepoApplicationSolutionPayload,
  type JinnRepoApplicationVerdictPayload,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import {
  cidToDigestHex,
  rawSha256CidToDigestHex,
} from '../adapters/mech/ipfs.js';
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
import { parseSignedTaskV1 } from '../types/task-document.js';
import type { SignedEnvelope } from '../types/envelope.js';

export interface ApplicationDeliveryExpectation {
  readonly schemaVersion: 'jinn-application-delivery-expectation.v1';
  readonly role: 'solution' | 'verdict';
  readonly taskId: string;
  readonly taskCid: string;
  readonly creationBlockNumber: number;
  readonly application: { readonly id: string; readonly version: string };
  readonly taskSpec: Record<string, unknown>;
  readonly attemptIndex?: number;
  readonly requestId?: string;
  readonly deliveryEnvelopeCid?: string;
  readonly solutionOperatorSafe?: string;
}

export interface ApplicationMarketplaceDeliveryExpectation
  extends ApplicationDeliveryExpectation {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export type ApplicationDeliveryObservation =
  | { readonly status: 'pending'; readonly reason: string; readonly detail?: string }
  | { readonly status: 'contradiction'; readonly reason: string; readonly detail: string }
  | {
      readonly status: 'verified';
      readonly role: 'solution' | 'verdict';
      readonly task: { readonly taskId: string; readonly taskCid: string };
      readonly attempt: {
        readonly attemptIndex: number;
        readonly requestId: string;
        readonly operator: string;
      };
      readonly delivery: {
        readonly envelopeCid: string;
        readonly transactionHash: string;
        readonly blockNumber: number;
      };
      readonly payload:
        | JinnRepoApplicationSolutionPayload
        | JinnRepoApplicationVerdictPayload;
    };

export interface ApplicationDeliveryObserverDeps {
  readonly discovery: Pick<DiscoveryAPI, 'getAutopilotDeliveryCandidates'>;
  readonly publicClient: PublicClient;
  readonly mechMarketplaceAddress: Address;
  readonly routerAddress: Address;
  readonly fetchEnvelopeBytes: (cid: string) => Promise<Uint8Array>;
  readonly fetchTaskBytes: (cid: string) => Promise<Uint8Array>;
  readonly resolvePublisherSafe: (
    chainId: number,
    publisherAgentId: string,
    publishedAtBlock: bigint,
  ) => Promise<string>;
}

export interface ApplicationDeliveryObserver {
  observe(
    expected: ApplicationMarketplaceDeliveryExpectation,
  ): Promise<ApplicationDeliveryObservation>;
}

const TASK_CREATED_SCAN_CHUNK = 1000n;
const same = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();
const detail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const pending = (reason: string, extra?: string): ApplicationDeliveryObservation =>
  extra === undefined
    ? { status: 'pending', reason }
    : { status: 'pending', reason, detail: extra };
const contradiction = (reason: string, message: string): ApplicationDeliveryObservation =>
  ({ status: 'contradiction', reason, detail: message });

export function parseApplicationTaskCid(cid: string): Hex {
  return rawSha256CidToDigestHex(cid);
}

function validExpectation(
  expected: ApplicationMarketplaceDeliveryExpectation,
): ApplicationDeliveryObservation | undefined {
  if (
    expected.schemaVersion !== 'jinn-application-delivery-expectation.v1'
    || !Number.isSafeInteger(expected.chainId)
    || expected.chainId <= 0
    || !Number.isSafeInteger(expected.creationBlockNumber)
    || expected.creationBlockNumber < 0
    || expected.fromBlock !== BigInt(expected.creationBlockNumber)
    || expected.toBlock < expected.fromBlock
    || !/^(0|[1-9][0-9]*)$/.test(expected.taskId)
    || (expected.role !== 'solution' && expected.role !== 'verdict')
    || !JinnRepoApplicationRefSchema.safeParse(expected.application).success
  ) return contradiction('invalid-expectation', 'invalid application delivery identity');
  try { parseApplicationTaskCid(expected.taskCid); } catch (error) {
    return contradiction('invalid-expectation', `invalid Task CID: ${detail(error)}`);
  }
  if ((expected.attemptIndex === undefined) !== (expected.requestId === undefined)) {
    return contradiction('invalid-expectation', 'attempt index and request ID must appear together');
  }
  if (
    expected.attemptIndex !== undefined
    && (
      !Number.isSafeInteger(expected.attemptIndex)
      || expected.attemptIndex < 0
      || !/^0x[0-9a-fA-F]{64}$/.test(expected.requestId!)
    )
  ) return contradiction('invalid-expectation', 'persisted attempt correlation is invalid');
  if (
    expected.role === 'verdict'
    && (
      expected.attemptIndex === undefined
      || expected.deliveryEnvelopeCid === undefined
      || expected.solutionOperatorSafe === undefined
      || !/^0x[0-9a-fA-F]{40}$/.test(expected.solutionOperatorSafe)
    )
  ) return contradiction('invalid-expectation', 'verdict observation requires solution correlation');
  return undefined;
}

async function exactTask(
  publicClient: PublicClient,
  routerAddress: Address,
  taskId: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<DecodedTaskCreated[]> {
  const results: DecodedTaskCreated[] = [];
  for (let start = fromBlock; start <= toBlock; start += TASK_CREATED_SCAN_CHUNK + 1n) {
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
    results.push(...decodeTaskCreatedLogs(logs as Log[])
      .filter((event) => event.taskId === taskId));
  }
  return results;
}

export function createApplicationDeliveryObserver(
  deps: ApplicationDeliveryObserverDeps,
): ApplicationDeliveryObserver {
  return {
    async observe(expected) {
      const invalid = validExpectation(expected);
      if (invalid !== undefined) return invalid;
      let lookup: Awaited<ReturnType<typeof deps.discovery.getAutopilotDeliveryCandidates>>;
      try {
        lookup = await deps.discovery.getAutopilotDeliveryCandidates({
          chainId: expected.chainId,
          taskId: expected.taskId,
          role: expected.role,
        });
      } catch (error) {
        return pending('discovery-unavailable', detail(error));
      }
      if (lookup.status !== 'ready') {
        return lookup.status === 'pending'
          ? pending(lookup.reason)
          : contradiction(lookup.reason, 'exact discovery returned contradictory rows');
      }
      if (
        lookup.role !== expected.role
        || lookup.task.taskId !== expected.taskId
        || lookup.attempt.taskId !== expected.taskId
        || !same(lookup.envelope.requestId, lookup.attempt.requestId)
      ) return contradiction('discovery-mismatch', 'delivery rows do not form the expected join');
      if (
        expected.role === 'verdict'
        && (
          same(lookup.attempt.operator, lookup.solutionOperator)
          || !same(expected.solutionOperatorSafe!, lookup.solutionOperator)
        )
      ) return contradiction('evaluator-is-solver', 'evaluator must differ from solution operator');
      if (
        expected.role === 'solution'
        && expected.attemptIndex !== undefined
        && (
          expected.attemptIndex !== lookup.attempt.attemptIndex
          || !same(expected.requestId!, lookup.attempt.requestId)
        )
      ) return contradiction('stale-attempt', 'persisted attempt differs from discovery');
      if (
        expected.role === 'solution'
        && expected.deliveryEnvelopeCid !== undefined
        && expected.deliveryEnvelopeCid !== lookup.envelope.manifestCid
      ) return contradiction('stale-delivery', 'persisted delivery differs from discovery');

      let publisher: string;
      try {
        publisher = await deps.resolvePublisherSafe(
          expected.chainId,
          lookup.envelope.publisherAgentId,
          BigInt(lookup.envelope.enrichedAtBlock),
        );
      } catch (error) {
        return pending('publisher-identity-unavailable', detail(error));
      }
      if (!same(publisher, lookup.attempt.operator)) {
        return contradiction('publisher-mismatch', 'publisher Safe differs from delivery operator');
      }

      const taskDigest = parseApplicationTaskCid(expected.taskCid);
      let created: DecodedTaskCreated[];
      try {
        created = await exactTask(
          deps.publicClient,
          deps.routerAddress,
          expected.taskId,
          expected.fromBlock,
          expected.toBlock,
        );
      } catch (error) {
        return pending('rpc-unavailable', detail(error));
      }
      if (
        created.length !== 1
        || !same(taskDigest, created[0]!.taskCidDigest)
        || !same(lookup.task.taskCidDigest, created[0]!.taskCidDigest)
        || lookup.task.createdAtBlock !== created[0]!.blockNumber
        || !created[0]!.transactionHash
        || !same(lookup.task.createdAtTx, created[0]!.transactionHash!)
      ) return contradiction('task-mismatch', 'Task provenance differs from Router TaskCreated');

      let taskDocument: unknown;
      try {
        const bytes = await deps.fetchTaskBytes(expected.taskCid);
        taskDocument = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (error) {
        return pending('task-unavailable', detail(error));
      }
      let signedTask;
      try { signedTask = parseSignedTaskV1(taskDocument); } catch (error) {
        return contradiction('invalid-task', detail(error));
      }
      const parsedTask = JinnRepoTaskSchema.safeParse(signedTask.spec);
      if (
        signedTask.solverType !== 'jinn-repo.v1'
        || signedTask.contractId !== 'jinn-repo'
        || signedTask.contractVersion !== 'v1'
        || !parsedTask.success
        || parsedTask.data.source !== 'live-issue'
        || parsedTask.data.application?.id !== expected.application.id
        || parsedTask.data.application?.version !== expected.application.version
        || !isDeepStrictEqual(signedTask.spec, expected.taskSpec)
      ) return contradiction('invalid-task', 'exact Task does not match the application expectation');

      const envelopeDigest = cidToDigestHex(lookup.envelope.manifestCid);
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
        return pending('rpc-unavailable', detail(error));
      }
      if (provenance !== 'verified') {
        return contradiction('discovery-mismatch', `attempt provenance is ${provenance}`);
      }
      let delivery: Awaited<ReturnType<typeof findLatestDeliveryForRequest>>;
      try {
        const mech = await getMarketplaceRequestDeliveryMech(
          deps.publicClient,
          deps.mechMarketplaceAddress,
          lookup.attempt.requestId,
        );
        delivery = await findLatestDeliveryForRequest(
          deps.publicClient,
          mech,
          lookup.attempt.requestId,
          expected.fromBlock,
          expected.toBlock,
        );
      } catch (error) {
        return pending('rpc-unavailable', detail(error));
      }
      if (!delivery) return pending('delivery-not-found');
      if (
        !same(delivery.requestId, lookup.attempt.requestId)
        || !same(delivery.deliveryDataHex, envelopeDigest)
        || !same(delivery.mechAddress, lookup.attempt.operator)
        || !delivery.transactionHash
        || delivery.blockNumber === undefined
        || delivery.blockNumber < expected.fromBlock
        || delivery.blockNumber > expected.toBlock
      ) return contradiction('delivery-mismatch', 'delivery does not match the exact attempt');

      let raw: unknown;
      try {
        const bytes = await deps.fetchEnvelopeBytes(lookup.envelope.manifestCid);
        raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (error) {
        return pending('envelope-unavailable', detail(error));
      }
      let signed: SignedEnvelope;
      try {
        signed = await authenticateExecutionEnvelope(
          raw,
          `application delivery envelope ${lookup.envelope.manifestCid}`,
        );
      } catch (error) {
        return contradiction('invalid-envelope', detail(error));
      }
      if (
        signed.solverType !== 'jinn-repo.v1'
        || signed.role !== expected.role
        || signed.task?.cid !== expected.taskCid
        || !same(signed.task.onchainCreationTx, created[0]!.transactionHash!)
        || signed.task.onchainCreationBlock !== created[0]!.blockNumber
        || !same(signed.task.requestId, lookup.attempt.requestId)
        || !same(signed.participant.safeAddress, lookup.attempt.operator)
        || !same(signed.signature.hash, lookup.envelope.manifestHash)
      ) return contradiction('envelope-mismatch', 'authenticated envelope differs from delivery');
      const parsedPayload = expected.role === 'solution'
        ? JinnRepoApplicationSolutionPayloadSchema.safeParse(signed.payload)
        : JinnRepoApplicationVerdictPayloadSchema.safeParse(signed.payload);
      if (!parsedPayload.success) {
        return contradiction('invalid-result', parsedPayload.error.message);
      }
      if (
        parsedPayload.data.application.id !== expected.application.id
        || parsedPayload.data.application.version !== expected.application.version
      ) return contradiction('application-mismatch', 'result application differs from expectation');
      return {
        status: 'verified',
        role: expected.role,
        task: { taskId: expected.taskId, taskCid: expected.taskCid },
        attempt: {
          attemptIndex: lookup.attempt.attemptIndex,
          requestId: lookup.attempt.requestId,
          operator: lookup.attempt.operator,
        },
        delivery: {
          envelopeCid: lookup.envelope.manifestCid,
          transactionHash: delivery.transactionHash,
          blockNumber: Number(delivery.blockNumber),
        },
        payload: parsedPayload.data,
      } as ApplicationDeliveryObservation;
    },
  };
}
