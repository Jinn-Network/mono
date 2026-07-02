/**
 * Ponder event handlers for the Jinn protocol indexer.
 *
 * Six event sources, each mapped to one or more entities in ponder.schema.ts:
 *
 *   JinnRouter:TaskCreated             → task
 *   JinnRouter:TaskAttemptCreated      → attempt
 *   JinnRouter:SolutionDeliveryClaimed → (no-op; start of evaluation, not finalization — issues #530/#1304)
 *   JinnRouter:VerdictDeliveryClaimed  → verdict (+ recompute task.finalized when delivered verdicts reach normalized requiredVerdicts)
 *   JinnRouter:TaskBudgetRefunded      → task.refunded = true
 *   IdentityRegistry:MetadataSet       → solverNetManifest OR harnessCheckpoint OR envelope (routed by key)
 *                                        the `envelope:` (execution) handler does an IPFS enrichment fetch
 *                                        → attemptEnvelopeMeta (config-gated by JINN_INDEXER_ENRICH_ENVELOPES,
 *                                        IPFS gateway from JINN_IPFS_GATEWAY_URL). The `evaluation:`
 *                                        (verdict) path → verdictEnvelopeMeta is, since #779, OFF by
 *                                        default in-handler and owned by the standalone enrichment worker
 *                                        (packages/indexer-enrichment); set JINN_INDEXER_ENRICH_ENVELOPES=true
 *                                        to restore in-handler verdict enrichment (rollback).
 *
 * Handlers are pure event-to-row mappings with no business logic. The
 * correctness gate (canClaimTask simulation) lives in the daemon adapter,
 * not here.
 *
 * The handler logic lives in `src/handlers.ts` as exported pure functions so it
 * can be unit-tested without booting the Ponder runtime (see
 * `test/handlers.test.ts` and `yarn test`). This file is the thin Ponder
 * registration layer: it imports the virtual `ponder:registry` / `ponder:schema`
 * modules — which only the Ponder build can resolve — and forwards the
 * `{ event, context }` argument plus the schema table objects to the pure
 * functions. The `as` casts at the seam adapt Ponder's heavily-generic
 * `event` / `context` types to the narrow structural shapes the pure handlers
 * declare; they are structurally compatible at runtime.
 *
 * Ponder docs: https://ponder.sh/docs/indexing/event-handlers
 * Schema: ponder.schema.ts
 */
import { ponder } from 'ponder:registry';
import { and, count, eq } from 'ponder';
import { task, attempt, solverNetManifest, envelope, pluginPublication, verdict, harnessCheckpoint, attemptEnvelopeMeta, verdictEnvelopeMeta, rewardDistribution, stakingService, stakingRewardCheckpoint } from 'ponder:schema';

// ── Enrichment config (read once at module scope) ─────────────────────────────
// JINN_INDEXER_ENRICH_ENVELOPES governs in-handler IPFS enrichment. Since #779
// it has a dual meaning split by enrichment path:
//
//   - EXECUTION envelopes (attemptEnvelopeMeta), solverNetManifest, and
//     harnessCheckpoint: gated by `enrichEnvelopes` below — DEFAULT ENABLED
//     (set false/0 to skip and sync faster; the explorer's harness/mode/plugin/
//     model facets, checkpoint timeline, and freeze integrity won't populate).
//     #779 did NOT change this path.
//
//   - EVALUATION (verdict) envelopes → verdictEnvelopeMeta: gated by
//     `enrichVerdicts` below — DEFAULT DISABLED. Unset/false → the handler
//     writes the evaluation `envelope` anchor only and the standalone enrichment
//     worker (packages/indexer-enrichment) owns the IPFS-bound verdict
//     enrichment, so an enrichment backlog can't starve `/graphql` (#779).
//     Set JINN_INDEXER_ENRICH_ENVELOPES=true/1 to restore in-handler verdict
//     enrichment (the AC5 rollback lever).
const enrichEnvelopes =
  process.env['JINN_INDEXER_ENRICH_ENVELOPES'] !== 'false' &&
  process.env['JINN_INDEXER_ENRICH_ENVELOPES'] !== '0';
// Verdict path defaults OFF (worker-owned). Only the explicit opt-in restores
// in-handler verdict enrichment.
const enrichVerdicts =
  process.env['JINN_INDEXER_ENRICH_ENVELOPES'] === 'true' ||
  process.env['JINN_INDEXER_ENRICH_ENVELOPES'] === '1';
// JINN_IPFS_GATEWAY_URL: IPFS gateway for envelope enrichment.
// Empty → fetchIpfsJson falls back to https://gateway.autonolas.tech.
const ipfsGateway = process.env['JINN_IPFS_GATEWAY_URL'] ?? '';
import {
  handleTaskCreated,
  handleTaskAttemptCreated,
  handleSolutionDeliveryClaimed,
  handleMetadataSet,
  handleVerdictDeliveryClaimed,
  handleTaskBudgetRefunded,
  handleRewardsDistributed,
  handleServiceStaked,
  handleStakingCheckpoint,
  type HandlerContext,
  type TaskCreatedEvent,
  type TaskAttemptCreatedEvent,
  type SolutionDeliveryClaimedEvent,
  type MetadataSetEvent,
  type VerdictDeliveryClaimedEvent,
  type TaskBudgetRefundedEvent,
  type RewardsDistributedEvent,
  type ServiceStakedEvent,
  type StakingCheckpointEvent,
} from './handlers.js';

ponder.on('JinnRouter:TaskCreated', async ({ event, context }) => {
  await handleTaskCreated({
    event: event as unknown as TaskCreatedEvent,
    context: context as unknown as HandlerContext,
    task,
  });
});

ponder.on('JinnRouter:TaskAttemptCreated', async ({ event, context }) => {
  await handleTaskAttemptCreated({
    event: event as unknown as TaskAttemptCreatedEvent,
    context: context as unknown as HandlerContext,
    attempt,
  });
});

ponder.on('JinnRouter:SolutionDeliveryClaimed', async ({ event, context }) => {
  await handleSolutionDeliveryClaimed({
    event: event as unknown as SolutionDeliveryClaimedEvent,
    context: context as unknown as HandlerContext,
    task,
  });
});

ponder.on('JinnRouter:VerdictDeliveryClaimed', async ({ event, context }) => {
  const baseDb = context.db as unknown as HandlerContext['db'];
  const handlerContext: HandlerContext = {
    chain: context.chain as unknown as HandlerContext['chain'],
    db: {
      ...baseDb,
      // Back countVerdicts with Ponder's raw drizzle (context.db.sql) — the
      // documented read/aggregate escape hatch inside indexing functions
      // (https://ponder.sh/docs/indexing/write#raw-sql).
      countVerdicts: async (table, scope) => {
        const rows = await (context.db as any).sql
          .select({ c: count() })
          .from(table)
          .where(
            and(
              eq((table as any).taskId, scope.taskId),
              eq((table as any).attemptIndex, scope.attemptIndex),
              eq((table as any).chainId, scope.chainId),
            ),
          );
        return Number(rows[0]?.c ?? 0);
      },
    },
  };
  await handleVerdictDeliveryClaimed({
    event: event as unknown as VerdictDeliveryClaimedEvent,
    context: handlerContext,
    verdict,
    task,
  });
});

ponder.on('JinnRouter:TaskBudgetRefunded', async ({ event, context }) => {
  await handleTaskBudgetRefunded({
    event: event as unknown as TaskBudgetRefundedEvent,
    context: context as unknown as HandlerContext,
    task,
  });
});

ponder.on('ExternalStakingDistributor:RewardsDistributed', async ({ event, context }) => {
  await handleRewardsDistributed({
    event: event as unknown as RewardsDistributedEvent,
    context: context as unknown as HandlerContext,
    rewardDistribution,
  });
});

ponder.on('StolasStakingProxy:ServiceStaked', async ({ event, context }) => {
  await handleServiceStaked({
    event: event as unknown as ServiceStakedEvent,
    context: context as unknown as HandlerContext,
    stakingService,
  });
});

ponder.on('StolasStakingProxy:Checkpoint', async ({ event, context }) => {
  await handleStakingCheckpoint({
    event: event as unknown as StakingCheckpointEvent,
    context: context as unknown as HandlerContext,
    stakingService,
    stakingRewardCheckpoint,
  });
});

ponder.on('IdentityRegistry:MetadataSet', async ({ event, context }) => {
  await handleMetadataSet({
    event: event as unknown as MetadataSetEvent,
    context: context as unknown as HandlerContext,
    solverNetManifest,
    envelope,
    pluginPublication,
    harnessCheckpoint,
    attemptEnvelopeMeta,
    verdictEnvelopeMeta,
    enrichEnvelopes,
    enrichVerdicts,
    ipfsGateway,
  });
});
