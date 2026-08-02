import type { MarketplaceChainConfig } from '@jinn-network/marketplace-binding';
import type { Hex } from 'viem';
import type { NativeDiscoveryQueuedCard } from './native-discovery.js';
import type { NativeClaimDecision } from './native-claim-policy.js';
import {
  NativeOperatorStateRepository,
  type NativeClaimObservation,
  type NativeEngagementRow,
  type NativeOperationRow,
} from './native-operator-state.js';
import type { NativeOperationId } from './native-operation-identity.js';

export interface NativeSealedClaimDocuments {
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
}

export interface NativeClaimAdmissionPort {
  evaluate(
    queued: NativeDiscoveryQueuedCard,
    documents: NativeSealedClaimDocuments,
  ): Promise<NativeClaimDecision>;
}

export interface NativeClaimBroadcastPort {
  readonly priorityMech: `0x${string}`;
  broadcast(input: {
    readonly operationId: NativeOperationId;
    readonly taskId: bigint;
    readonly priorityMech: `0x${string}`;
  }): Promise<{
    readonly txHash: Hex;
    readonly blockHash?: Hex;
    readonly blockNumber?: bigint;
    readonly attemptIndex: number;
    readonly requestId?: Hex;
  }>;
}

export type NativeClaimCanonicalFact =
  | { readonly kind: 'absent'; readonly checkedAtBlock: bigint }
  | ({ readonly kind: 'broadcast' } & Pick<NativeClaimObservation, 'txHash'>)
  | ({ readonly kind: 'observed-safe' | 'finalized' } & NativeClaimObservation)
  | { readonly kind: 'replaced'; readonly priorTxHash: Hex; readonly txHash: Hex }
  | { readonly kind: 'orphaned'; readonly txHash: Hex; readonly reason: string }
  | { readonly kind: 'lost'; readonly reason: string };

export interface NativeClaimCanonicalReader {
  read(input: {
    readonly operation: NativeOperationRow;
    readonly engagement: NativeEngagementRow;
  }): Promise<NativeClaimCanonicalFact>;
}

export type NativeClaimCoordinatorResult =
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'deferred'; readonly reason: string }
  | { readonly kind: 'claim-pending'; readonly operationId: NativeOperationId; readonly reason: string }
  | { readonly kind: 'claim-finalized'; readonly operationId: NativeOperationId; readonly engagementId: NativeOperationId }
  | { readonly kind: 'lost'; readonly operationId: NativeOperationId; readonly reason: string };

export class NativeClaimCoordinator {
  private workerStarted = false;

  constructor(private readonly input: {
    readonly state: NativeOperatorStateRepository;
    readonly chain: MarketplaceChainConfig;
    readonly operatorAgent: string;
    readonly admission: NativeClaimAdmissionPort;
    readonly claim: NativeClaimBroadcastPort;
    readonly canonical: NativeClaimCanonicalReader;
    readonly worker: { readonly ownerId: string; readonly ttlMs: number };
  }) {}

  startWorker(): void {
    this.input.state.acquireLease({
      role: 'solver',
      chainId: this.input.chain.chainId,
      coordinator: this.input.chain.taskCoordinator,
      operatorAgent: this.input.operatorAgent,
      ownerId: this.input.worker.ownerId,
      ttlMs: this.input.worker.ttlMs,
    });
    this.workerStarted = true;
  }

  private requireLiveWorker(): void {
    if (!this.workerStarted) throw new Error('native claim coordinator has not acquired its worker lease');
    this.input.state.renewLease({
      role: 'solver',
      chainId: this.input.chain.chainId,
      coordinator: this.input.chain.taskCoordinator,
      operatorAgent: this.input.operatorAgent,
      ownerId: this.input.worker.ownerId,
      ttlMs: this.input.worker.ttlMs,
    });
  }

  async process(
    queued: NativeDiscoveryQueuedCard,
    documents: NativeSealedClaimDocuments,
  ): Promise<NativeClaimCoordinatorResult> {
    this.requireLiveWorker();
    const decision = await this.input.admission.evaluate(queued, documents);
    const source = queued.card.discovery;
    if (source === undefined) {
      throw new Error('native claim admission returned without signed discovery provenance');
    }
    const admission = {
      chainId: this.input.chain.chainId,
      coordinator: this.input.chain.taskCoordinator,
      taskId: queued.card.chain.taskId,
      operatorAgent: this.input.operatorAgent,
      taskDigest: queued.card.facts['taskDigest'] as `sha256:${string}`,
      submissionUri: queued.card.chain.submission,
      submissionDigest: queued.card.record.digest,
      source: {
        cardId: queued.id,
        agent: source.source.agent,
        name: source.source.name,
        sequence: source.sequence,
        entryDigest: source.entryDigest,
        announcementId: queued.announcementId,
      },
    } as const;

    if (!decision.ok && decision.retryable) {
      this.input.state.recordDeferral({
        ...admission,
        reason: decision.reason,
        detail: {
          capability: decision.capability as unknown as Readonly<Record<string, unknown>>,
          policy: decision.policy as unknown as Readonly<Record<string, unknown>>,
        },
      });
      return { kind: 'deferred', reason: decision.reason };
    }

    const recorded = this.input.state.recordDecision({
      ...admission,
      decision: decision.ok
        ? {
            ok: true,
            capability: decision.capability as unknown as Readonly<Record<string, unknown>>,
            policy: decision.policy as unknown as Readonly<Record<string, unknown>>,
          }
        : {
            ok: false,
            reason: decision.reason,
            capability: decision.capability as unknown as Readonly<Record<string, unknown>>,
            policy: decision.policy as unknown as Readonly<Record<string, unknown>>,
          },
    });
    if (recorded.kind === 'refused') return recorded;
    return this.drive(recorded.claimOperationId, true);
  }

  async reconcileStartup(): Promise<{ readonly reconciled: number; readonly finalized: number }> {
    this.requireLiveWorker();
    const operations = this.input.state.listNonterminalClaimOperations();
    let finalized = 0;
    for (const operation of operations) {
      const result = await this.drive(operation.operationId, true);
      if (result.kind === 'claim-finalized') finalized += 1;
    }
    return { reconciled: operations.length, finalized };
  }

  private current(id: NativeOperationId): { readonly operation: NativeOperationRow; readonly engagement: NativeEngagementRow } {
    const operation = this.input.state.getOperation(id);
    if (operation === undefined) throw new Error(`native claim operation ${id} disappeared`);
    const engagement = this.input.state.getEngagement(operation.engagementId);
    if (engagement === undefined) throw new Error(`native claim engagement ${operation.engagementId} disappeared`);
    return { operation, engagement };
  }

  private async applyCanonical(
    id: NativeOperationId,
    fact: NativeClaimCanonicalFact,
  ): Promise<NativeClaimCoordinatorResult | undefined> {
    switch (fact.kind) {
      case 'absent':
        this.input.state.recordClaimAbsent(id, fact);
        return undefined;
      case 'broadcast':
        this.input.state.recordClaimBroadcast(id, fact.txHash);
        return { kind: 'claim-pending', operationId: id, reason: 'broadcast' };
      case 'replaced':
        this.input.state.recordClaimReplacement(id, fact.priorTxHash, fact.txHash);
        return { kind: 'claim-pending', operationId: id, reason: 'replaced' };
      case 'observed-safe':
        this.input.state.recordClaimObservedSafe(id, fact);
        return { kind: 'claim-pending', operationId: id, reason: 'observed-safe' };
      case 'finalized': {
        this.input.state.recordClaimFinalized(id, fact);
        const operation = this.input.state.getOperation(id)!;
        return { kind: 'claim-finalized', operationId: id, engagementId: operation.engagementId };
      }
      case 'orphaned':
        this.input.state.recordClaimOrphaned(id, fact);
        return { kind: 'claim-pending', operationId: id, reason: 'orphaned' };
      case 'lost':
        this.input.state.recordClaimLost(id, fact);
        return { kind: 'lost', operationId: id, reason: fact.reason };
    }
  }

  private async drive(id: NativeOperationId, allowBroadcast: boolean): Promise<NativeClaimCoordinatorResult> {
    let current = this.current(id);
    if (current.operation.status === 'finalized') {
      return { kind: 'claim-finalized', operationId: id, engagementId: current.operation.engagementId };
    }
    if (current.operation.status === 'failed-terminal') {
      return { kind: 'lost', operationId: id, reason: 'failed-terminal' };
    }
    if (current.operation.status === 'orphaned') {
      this.input.state.prepareClaimRetry(id);
      current = this.current(id);
    }

    const fact = await this.input.canonical.read(current);
    const reconciled = await this.applyCanonical(id, fact);
    if (reconciled !== undefined || !allowBroadcast) return reconciled ?? {
      kind: 'claim-pending', operationId: id, reason: 'absence-confirmed',
    };

    current = this.current(id);
    if (current.operation.status !== 'intent') {
      return { kind: 'claim-pending', operationId: id, reason: current.operation.status };
    }
    let receipt;
    try {
      receipt = await this.input.claim.broadcast({
        operationId: id,
        taskId: current.engagement.taskId,
        priorityMech: this.input.claim.priorityMech,
      });
    } catch (error) {
      this.input.state.recordClaimBroadcast(id, undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'claim-pending', operationId: id, reason: 'broadcast-uncertain' };
    }

    // A wallet/broadcaster receipt is transaction identity, not canonical safe-chain truth.
    // Only `canonical.read` below may advance Attempt facts to observed-safe/finalized.
    this.input.state.recordClaimBroadcast(id, receipt.txHash, {
      attemptIndex: receipt.attemptIndex,
      ...(receipt.requestId === undefined ? {} : { requestId: receipt.requestId }),
      ...(receipt.blockHash === undefined ? {} : { receiptBlockHash: receipt.blockHash }),
      ...(receipt.blockNumber === undefined ? {} : { receiptBlockNumber: receipt.blockNumber }),
    });

    const afterBroadcast = this.current(id);
    const afterFact = await this.input.canonical.read(afterBroadcast);
    return (await this.applyCanonical(id, afterFact)) ?? {
      kind: 'claim-pending', operationId: id, reason: 'absence-after-broadcast',
    };
  }
}
