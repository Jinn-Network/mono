import type { Address, Hex } from 'viem';
import {
  computeRawCodecCid,
  keccakEvidenceHash,
  type MarketplaceChainConfig,
  type SettlementPorts,
} from '@jinn-network/marketplace-binding';
import type { MarketplaceProtocolObservation } from '@jinn-network/marketplace-projector';
import {
  deliverToMarketplace,
  type BaseVenueSafeBroadcaster,
  type MechDeliverInput,
} from '@jinn-network/marketplace-venue-base';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import type {
  NativeSolutionSettlementCanonicalFact,
  NativeSolutionSettlementPort,
} from './native-solution-coordinator.js';
import type { NativeEngagementRow, NativeOperationRow } from './native-operator-state.js';
import { solutionSettlementId } from './native-operation-identity.js';

type DeliverPort = (
  input: MechDeliverInput,
  broadcaster: BaseVenueSafeBroadcaster,
) => Promise<{ readonly delivered: 'sent' | 'already'; readonly txHash?: Hex }>;

export interface NativeSolutionSettlementDependencies {
  readonly chain: MarketplaceChainConfig;
  readonly mechAddress: Address;
  readonly deliveryBroadcaster: BaseVenueSafeBroadcaster;
  readonly settlement: SettlementPorts;
  readonly readObservations: () => readonly MarketplaceProtocolObservation[];
  readonly readFinalizedBlockNumber: () => bigint;
  readonly readCanonicalBlockHash: (blockNumber: bigint) => Promise<Hex | undefined>;
  /** Canonical chain-only reader supplied by bounded infrastructure in native product mode. */
  readonly canonicalReader?: NativeSolutionSettlementPort['readCanonical'];
  /** Test seam around the real venue deliver port; production composition omits it. */
  readonly deliver?: DeliverPort;
}

function isHash(value: string | null): value is `0x${string}` {
  return value !== null && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function operationDeliveryDigest(operation: NativeOperationRow): `sha256:${string}` {
  const detail = operation.detail;
  if (
    typeof detail !== 'object'
    || detail === null
    || typeof (detail as Record<string, unknown>)['deliveryDigest'] !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test((detail as Record<string, string>)['deliveryDigest']!)
  ) throw new Error(`solution settlement ${operation.operationId} has no exact Delivery digest`);
  return (detail as { readonly deliveryDigest: `sha256:${string}` }).deliveryDigest;
}

function matchingDeliveryObservation(
  observation: MarketplaceProtocolObservation,
  input: {
    readonly chain: MarketplaceChainConfig;
    readonly engagement: NativeEngagementRow;
    readonly deliveryDigest: `sha256:${string}`;
  },
): boolean {
  return observation.correction === undefined
    && observation.type === 'network.jinn.task-execution.delivery-recorded.v1'
    && observation.subject === input.engagement.attemptUri
    && observation.taskdigest === input.engagement.taskDigest
    && observation.data['digest'] === input.deliveryDigest
    && observation.derivation.chainId === input.engagement.chainId
    && observation.derivation.contract.toLowerCase() === input.chain.jinnRouter.toLowerCase()
    && observation.derivation.event === 'SolutionDeliveryClaimed'
    && observation.derivation.contractGeneration === input.chain.generation;
}

async function readCanonicalSettlement(
  dependencies: NativeSolutionSettlementDependencies,
  operation: NativeOperationRow,
  engagement: NativeEngagementRow,
): Promise<NativeSolutionSettlementCanonicalFact> {
  const deliveryDigest = operationDeliveryDigest(operation);
  const observations = dependencies.readObservations();
  const matching = observations.filter((observation) => matchingDeliveryObservation(observation, {
    chain: dependencies.chain,
    engagement,
    deliveryDigest,
  }));
  const retractedIds = new Set(observations.flatMap((observation) =>
    observation.correction === undefined ? [] : [observation.correction.retractsObservationId]));
  const canonicalCandidates = matching.filter(({ id }) => !retractedIds.has(id));
  const canonical = canonicalCandidates.at(-1);

  if (canonical === undefined) {
    const orphaned = matching.find(({ id }) => retractedIds.has(id));
    if (orphaned !== undefined && isHash(orphaned.derivation.txHash)) {
      return {
        kind: 'orphaned',
        txHash: orphaned.derivation.txHash,
        reason: 'projector-reorg-correction',
      };
    }
    if (isHash(operation.txHash)) return { kind: 'broadcast', txHash: operation.txHash };
    return { kind: 'absent', checkedAtBlock: dependencies.readFinalizedBlockNumber() };
  }

  const observedTxHash = canonical.derivation.txHash;
  const blockNumber = BigInt(canonical.derivation.blockNumber);
  const canonicalHash = await dependencies.readCanonicalBlockHash(blockNumber);
  if (canonicalHash === undefined || canonicalHash.toLowerCase() !== canonical.derivation.blockHash.toLowerCase()) {
    return {
      kind: 'orphaned',
      txHash: observedTxHash,
      reason: 'canonical-block-hash-mismatch',
    };
  }
  if (isHash(operation.txHash) && operation.txHash.toLowerCase() !== observedTxHash.toLowerCase()) {
    return { kind: 'replaced', priorTxHash: operation.txHash, txHash: observedTxHash };
  }
  if (blockNumber <= dependencies.readFinalizedBlockNumber()) {
    return {
      kind: 'finalized',
      txHash: observedTxHash,
      blockHash: canonical.derivation.blockHash,
      blockNumber,
    };
  }
  return { kind: 'broadcast', txHash: observedTxHash };
}

/**
 * Today-generation settlement adapter for native-v1. The venue remains the sole transaction
 * owner. A mined Safe receipt records only broadcast identity; finality is derived exclusively
 * from the projector's canonical observation stream and finalized checkpoint.
 */
export function buildNativeSolutionSettlementPort(
  dependencies: NativeSolutionSettlementDependencies,
): NativeSolutionSettlementPort {
  if (dependencies.chain.generation !== 'today') {
    throw new Error('Phase B native solution settlement is available only for today generation');
  }
  const deliver = dependencies.deliver ?? deliverToMarketplace;
  return {
    async broadcast({ operationId, engagement, deliveryBytes }) {
      if (
        engagement.chainId !== dependencies.chain.chainId
        || engagement.coordinator.toLowerCase() !== dependencies.chain.taskCoordinator.toLowerCase()
        || engagement.attemptUri === null
        || !isHash(engagement.requestId)
      ) throw new Error('native solution settlement engagement does not match the composed today venue');
      const deliveryDigest = documentDigest(deliveryBytes);
      if (solutionSettlementId({ attempt: engagement.attemptUri, deliveryDigest }) !== operationId) {
        throw new Error('native solution settlement operation does not bind the exact Delivery');
      }

      await deliver({
        mechAddress: dependencies.mechAddress,
        requestId: engagement.requestId,
        deliveryBytes,
      }, dependencies.deliveryBroadcaster);

      const rawCid = computeRawCodecCid(deliveryBytes);
      const mechFacts = await dependencies.settlement.readMechDeliveryFacts({
        requestId: engagement.requestId,
        config: dependencies.chain,
      });
      if (
        mechFacts.requestId.toLowerCase() !== engagement.requestId.toLowerCase()
        || mechFacts.sha256CidDigest !== rawCid.sha256Digest
      ) throw new Error('native solution Mech delivery facts do not bind the exact Delivery');

      await dependencies.settlement.pin(deliveryBytes);
      const solutionDigest = keccakEvidenceHash(deliveryBytes);
      const result = await dependencies.settlement.claimSolutionDelivery({
        requestId: engagement.requestId,
        solutionDigest,
        operationId,
      });
      if (result.status !== 'settled' && result.status !== 'already-settled') {
        throw new Error(`native solution settlement was not accepted (${result.status})`);
      }
      const settlementTxHash = result.txHash ?? null;
      if (!isHash(settlementTxHash)) {
        throw new Error('native solution settlement has no durable transaction identity');
      }

      const routerFacts = await dependencies.settlement.readRouterDeliveryFacts({
        requestId: engagement.requestId,
        config: dependencies.chain,
      });
      if (
        routerFacts.generation !== 'today'
        || routerFacts.requestId.toLowerCase() !== engagement.requestId.toLowerCase()
        || routerFacts.keccakEvidenceHash.toLowerCase() !== solutionDigest.toLowerCase()
      ) throw new Error('native solution router facts do not bind the exact Delivery');
      return { txHash: settlementTxHash };
    },
    readCanonical: dependencies.canonicalReader ?? (({ operation, engagement }) =>
      readCanonicalSettlement(dependencies, operation, engagement)),
  };
}
