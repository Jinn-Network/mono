import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_TODAY, computeRawCodecCid, keccakEvidenceHash } from '@jinn-network/marketplace-binding';
import type { MarketplaceProtocolObservation } from '@jinn-network/marketplace-projector';
import { documentDigest, sealDelivery } from '@jinn-network/task-execution-protocol';
import {
  buildNativeSolutionSettlementPort,
} from '../../src/daemon/native-solution-settlement.js';
import type { NativeEngagementRow, NativeOperationRow } from '../../src/daemon/native-operator-state.js';
import { solutionSettlementId } from '../../src/daemon/native-operation-identity.js';

const ATTEMPT = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const DELIVERY_DIGEST = `sha256:${'d'.repeat(64)}` as const;
const OPERATION_ID = `sha256:${'a'.repeat(64)}` as const;
const TX_HASH = `0x${'b'.repeat(64)}` as const;
const BLOCK_HASH = `0x${'c'.repeat(64)}` as const;
const REQUEST_ID = `0x${'e'.repeat(64)}` as const;

const engagement = {
  engagementId: `sha256:${'1'.repeat(64)}`,
  chainId: 84532,
  coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
  taskId: 7n,
  role: 'solver',
  operatorAgent: 'urn:jinn:operator:solver-a',
  taskDigest: `sha256:${'2'.repeat(64)}`,
  submissionUri: 'urn:uuid:22222222-2222-4222-8222-222222222222',
  submissionDigest: `sha256:${'3'.repeat(64)}`,
  state: 'solution-settlement-pending',
  attemptIndex: 0,
  attemptUri: ATTEMPT,
  requestId: REQUEST_ID,
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:05:00.000Z',
} satisfies NativeEngagementRow;

function operation(input: Partial<NativeOperationRow> = {}): NativeOperationRow {
  return {
    operationId: OPERATION_ID,
    engagementId: engagement.engagementId,
    kind: 'solution-settlement',
    status: 'broadcast',
    txHash: TX_HASH,
    priorTxHash: null,
    blockHash: null,
    blockNumber: null,
    detail: { attempt: ATTEMPT, deliveryDigest: DELIVERY_DIGEST },
    createdAt: '2026-08-02T00:05:00.000Z',
    updatedAt: '2026-08-02T00:05:00.000Z',
    ...input,
  };
}

function deliveryObservation(finalityTier: 'safe' | 'finalized' = 'safe'): MarketplaceProtocolObservation {
  return {
    specversion: '1.0',
    id: `${TX_HASH}:4:network.jinn.task-execution.delivery-recorded.v1`,
    source: 'urn:jinn:marketplace:base-sepolia',
    subject: ATTEMPT,
    time: '2026-08-02T00:06:00.000Z',
    datacontenttype: 'application/json',
    sequence: '0000000000000004',
    taskdigest: engagement.taskDigest,
    derivation: {
      chainId: 84532,
      contract: BASE_SEPOLIA_TODAY.jinnRouter,
      event: 'SolutionDeliveryClaimed',
      blockNumber: 120,
      blockHash: BLOCK_HASH,
      txHash: TX_HASH,
      logIndex: 4,
      finalityTier,
      contractGeneration: 'today',
    },
    type: 'network.jinn.task-execution.delivery-recorded.v1',
    data: { digest: DELIVERY_DIGEST },
  };
}

function setup(input: {
  readonly observations?: readonly MarketplaceProtocolObservation[];
  readonly finalizedBlock?: bigint;
  readonly canonicalHash?: `0x${string}`;
} = {}) {
  const deliver = vi.fn(async () => ({ delivered: 'sent' as const, txHash: `0x${'4'.repeat(64)}` as const }));
  const pin = vi.fn(async () => undefined);
  const readMechDeliveryFacts = vi.fn();
  const readRouterDeliveryFacts = vi.fn();
  const claimSolutionDelivery = vi.fn(async () => ({ status: 'settled' as const, txHash: TX_HASH }));
  const port = buildNativeSolutionSettlementPort({
    chain: BASE_SEPOLIA_TODAY,
    mechAddress: BASE_SEPOLIA_TODAY.mechMarketplace,
    deliveryBroadcaster: {} as never,
    settlement: {
      pin,
      verifySettlementGrade: vi.fn() as never,
      readMechDeliveryFacts,
      readRouterDeliveryFacts,
      claimSolutionDelivery,
    },
    deliver,
    readObservations: () => input.observations ?? [],
    readFinalizedBlockNumber: () => input.finalizedBlock ?? 0n,
    readCanonicalBlockHash: async () => input.canonicalHash ?? BLOCK_HASH,
  });
  return { port, deliver, pin, readMechDeliveryFacts, readRouterDeliveryFacts, claimSolutionDelivery };
}

describe('native solution settlement port', () => {
  it('uses the durable operation ID and returns only the settlement transaction identity', async () => {
    const subject = setup();
    const deliveryBytes = sealDelivery({
      protocol: 'https://jinn.network/profiles/task-execution/1.0',
      attempt: ATTEMPT,
      task: engagement.taskDigest,
      outputs: [],
      executionIds: ['urn:uuid:33333333-3333-4333-8333-333333333333'],
      evidenceRecords: [{ family: 'execution-evidence', digest: `sha256:${'5'.repeat(64)}` }],
      outcome: 'fulfilled',
      createdAt: '2026-08-02T00:05:00.000Z',
    });
    const raw = computeRawCodecCid(deliveryBytes);
    const operationId = solutionSettlementId({
      attempt: ATTEMPT,
      deliveryDigest: documentDigest(deliveryBytes),
    });
    subject.readMechDeliveryFacts.mockResolvedValue({ requestId: REQUEST_ID, sha256CidDigest: raw.sha256Digest });
    subject.readRouterDeliveryFacts.mockResolvedValue({
      generation: 'today', requestId: REQUEST_ID, keccakEvidenceHash: keccakEvidenceHash(deliveryBytes),
    });

    await expect(subject.port.broadcast({ operationId, engagement, deliveryBytes }))
      .resolves.toEqual({ txHash: TX_HASH });

    expect(subject.deliver).toHaveBeenCalledOnce();
    expect(subject.pin).toHaveBeenCalledWith(deliveryBytes);
    expect(subject.claimSolutionDelivery).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      solutionDigest: keccakEvidenceHash(deliveryBytes),
      operationId,
    });
  });

  it('does not let a mined receipt or safe observation advance finality', async () => {
    const subject = setup({ observations: [deliveryObservation('safe')], finalizedBlock: 119n });

    await expect(subject.port.readCanonical({ operation: operation(), engagement }))
      .resolves.toEqual({ kind: 'broadcast', txHash: TX_HASH });
  });

  it('finalizes only after the projector observation is inside the canonical finalized boundary', async () => {
    const subject = setup({ observations: [deliveryObservation('safe')], finalizedBlock: 120n });

    await expect(subject.port.readCanonical({ operation: operation(), engagement }))
      .resolves.toEqual({
        kind: 'finalized', txHash: TX_HASH, blockHash: BLOCK_HASH, blockNumber: 120n,
      });
  });

  it('reports an append-only correction as orphaned instead of trusting the old receipt', async () => {
    const prior = deliveryObservation();
    const correction: MarketplaceProtocolObservation = {
      ...prior,
      id: `reorg:${prior.id}:${BLOCK_HASH}`,
      sequence: '0000000000000005',
      correction: { retractsObservationId: prior.id, orphanedBlockHash: BLOCK_HASH },
      type: 'network.jinn.task-execution.attempt-terminal.v1',
      data: { state: 'lost' },
    };
    const subject = setup({ observations: [prior, correction], finalizedBlock: 120n });

    await expect(subject.port.readCanonical({ operation: operation(), engagement }))
      .resolves.toEqual({ kind: 'orphaned', txHash: TX_HASH, reason: 'projector-reorg-correction' });
  });
});
