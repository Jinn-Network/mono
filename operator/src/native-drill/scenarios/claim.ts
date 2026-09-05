// operator/src/native-drill/scenarios/claim.ts
/**
 * Checkpoint `claim` (#2434).
 *
 * Boundary: the claim transaction is broadcast to the node and the process is killed before the
 * hash is attached to the claim operation — the runbook's "claim operation intent or
 * uncertain/broadcast transaction is durable".
 *
 * Proof: one logical `claimOperationId` survives the restart, the recovered hash attaches to that
 * same operation, and the engagement leaves `claim-broadcast` only once the node's own `finalized`
 * tag covers the claim's block.
 */
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { Store } from '../../store/store.js';
import type { NativeDiscoveryQueuedCard } from '../../daemon/native-discovery.js';
import type { NativeClaimDecision } from '../../daemon/native-claim-policy.js';
import {
  NativeClaimCoordinator,
  type NativeClaimCanonicalFact,
} from '../../daemon/native-claim-coordinator.js';
import { NativeOperatorStateRepository } from '../../daemon/native-operator-state.js';
import type { RunObservation } from '../observation.js';
import {
  DRILL_CLOCK,
  digestOf,
  observedMode,
  storePath,
  type ScenarioContext,
} from './support.js';

export const DRILL_OPERATOR = 'urn:jinn:operator:drill-solver';
export const DRILL_TASK_DIGEST = `sha256:${'1'.repeat(64)}` as const;
export const DRILL_SUBMISSION_DIGEST = `sha256:${'2'.repeat(64)}` as const;
export const DRILL_SOURCE_ENTRY = `sha256:${'6'.repeat(64)}` as const;
export const DRILL_REQUEST_ID = `0x${'5'.repeat(64)}` as const;

export function queuedCard(): NativeDiscoveryQueuedCard {
  return {
    id: 1,
    announcementId: 'announcement-drill',
    card: {
      record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: DRILL_SUBMISSION_DIGEST },
      facts: {
        taskDigest: DRILL_TASK_DIGEST,
        taskProfileUri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0',
      },
      chain: {
        taskId: 7n,
        submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
        nonce: 'drill',
        intendedSpendWei: 2n,
      },
      discovery: {
        source: { agent: 'urn:jinn:requester:drill', name: 'requester' },
        sequence: '0000000000000001',
        entryDigest: DRILL_SOURCE_ENTRY,
        signedHighWater: {
          sequence: '0000000000000001',
          entry: DRILL_SOURCE_ENTRY,
          issuedAt: '2026-08-02T00:00:00.000Z',
          refreshBy: '2026-08-03T00:00:00.000Z',
          signature: {},
        },
      },
    },
  };
}

export function acceptedDecision(): NativeClaimDecision {
  return {
    ok: true,
    facts: {
      taskId: 7n,
      taskDigest: DRILL_TASK_DIGEST,
      submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      nonce: 'drill',
      profileUri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0',
      requirements: {},
      runnable: true,
      intendedSpendWei: 2n,
      intendedAiUnits: 0,
      workKind: 'prediction',
    },
    capability: { ok: true, backend: {} as never, launcher: {} as never, preflight: { ready: true } },
    policy: {
      ok: true,
      chainId: 84532,
      coordinator: BASE_SEPOLIA_TODAY.taskCoordinator.toLowerCase(),
      intendedSpendWei: '2',
      activeEngagements: 0,
      canonicalFinalized: true,
    },
  };
}

export function enqueueCard(store: Store): void {
  const item = queuedCard();
  store.db.prepare(
    `INSERT OR IGNORE INTO native_discovery_cards
      (id, source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', '2026-08-02T00:00:00.000Z')`,
  ).run(
    item.id,
    item.card.discovery!.source.agent,
    item.card.discovery!.source.name,
    item.card.discovery!.sequence,
    item.card.discovery!.entryDigest,
    item.announcementId,
  );
}

export async function runClaimScenario(context: ScenarioContext): Promise<RunObservation | undefined> {
  const path = storePath(context);
  const claimKey = `${context.runId}:claim`;
  let broadcasts = 0;
  let canonicalReads = 0;

  const store = new Store(path);
  try {
    enqueueCard(store);
    const state = new NativeOperatorStateRepository(store, { now: () => DRILL_CLOCK });
    const coordinator = new NativeClaimCoordinator({
      state,
      chain: BASE_SEPOLIA_TODAY,
      operatorAgent: DRILL_OPERATOR,
      admission: { evaluate: async () => acceptedDecision() },
      claim: {
        priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace,
        broadcast: async () => {
          broadcasts += 1;
          const txHash = await context.chain.broadcast(claimKey);
          // The transaction is on the node. Attaching it to the operation is what the boundary
          // interrupts, so the restarted process must find it by reconciling canonical history.
          await context.boundary();
          return { txHash, attemptIndex: 0, requestId: DRILL_REQUEST_ID };
        },
      },
      canonical: {
        read: async (): Promise<NativeClaimCanonicalFact> => {
          canonicalReads += 1;
          const history = await context.chain.findByDigest(claimKey);
          const first = history[0];
          if (first === undefined) {
            return { kind: 'absent', checkedAtBlock: BigInt(await context.chain.senderNonce()) };
          }
          const finalized = await context.chain.awaitFinalized(first.hash);
          return {
            kind: 'finalized',
            txHash: finalized.hash,
            blockHash: finalized.blockHash,
            blockNumber: finalized.blockNumber,
            attemptIndex: 0,
            requestId: DRILL_REQUEST_ID,
          };
        },
      },
      worker: { ownerId: `${context.seed}-worker`, ttlMs: 60_000 },
    });
    coordinator.startWorker();

    if (context.mode === 'resume') {
      await coordinator.reconcileStartup();
    } else {
      await coordinator.process(queuedCard(), {
        taskBytes: new Uint8Array([1]),
        submissionBytes: new Uint8Array([2]),
      });
      // The uninterrupted run reconciles too: the claim is not complete until the node reports the
      // transaction finalized, which is the same gate the recovered run passes through.
      await coordinator.reconcileStartup();
    }

    const engagements = state.listEngagements().map((value) => ({
      id: value.engagementId, state: value.state, attempt: value.attemptUri,
    }));
    const operations = state.listOperations().map((value) => ({
      id: value.operationId, kind: value.kind, status: value.status, tx: value.txHash,
    }));
    const history = await context.chain.findByDigest(claimKey);
    return {
      checkpoint: 'claim',
      seed: context.seed,
      mode: observedMode(context.mode),
      finalState: engagements[0]?.state ?? 'missing',
      graphDigest: digestOf({ engagements, operations }),
      operationIds: operations.map(({ id }) => id),
      transactionHashes: history.map(({ hash }) => hash),
      sourceHeads: [DRILL_SOURCE_ENTRY],
      effects: {
        claims: history.length === 0 ? 0 : 1,
        claimOperations: operations.filter(({ kind }) => kind === 'claim').length,
        duplicateClaims: Math.max(history.length - 1, 0),
      },
      invocations: { broadcast: broadcasts, canonicalRead: canonicalReads },
      stateBefore: 'one admitted engagement with a durable claim operation intent',
      stateAfter: `${operations.length} operation(s); ${history.length} canonical claim transaction(s)`,
    };
  } finally {
    store.close();
  }
}
