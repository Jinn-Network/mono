/**
 * Ponder event handlers for the Jinn protocol indexer.
 *
 * Seven event sources, each mapped to one or more entities in ponder.schema.ts:
 *
 *   JinnRouter:TaskCreated             → task
 *   JinnRouter:TaskAttemptCreated      → attempt
 *   JinnRouter:SolutionDeliveryClaimed → task.finalized = true
 *   JinnRouter:VerdictDeliveryClaimed  → verdict
 *   JinnRouter:TaskBudgetRefunded      → task.refunded = true
 *   IdentityRegistry:MetadataSet       → solverNetManifest OR harnessCheckpoint OR envelope (routed by key)
 *                                        the `envelope:` handler also does an IPFS enrichment fetch
 *                                        → attemptEnvelopeMeta (config-gated by JINN_INDEXER_ENRICH_ENVELOPES,
 *                                        IPFS gateway from JINN_IPFS_GATEWAY_URL)
 *   JinnDistributor:Claimed            → rewardDistribution
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
import { task, attempt, solverNetManifest, envelope, pluginPublication, verdict, rewardDistribution, harnessCheckpoint, attemptEnvelopeMeta, verdictEnvelopeMeta } from 'ponder:schema';

// ── Enrichment config (read once at module scope) ─────────────────────────────
// JINN_INDEXER_ENRICH_ENVELOPES: set false/0 to skip per-envelope IPFS fetch
// and sync faster — the explorer's harness/mode/plugin/model facets, checkpoint
// timeline, and freeze integrity won't populate. Default: enabled.
const enrichEnvelopes =
  process.env['JINN_INDEXER_ENRICH_ENVELOPES'] !== 'false' &&
  process.env['JINN_INDEXER_ENRICH_ENVELOPES'] !== '0';
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
  handleClaimed,
  type HandlerContext,
  type TaskCreatedEvent,
  type TaskAttemptCreatedEvent,
  type SolutionDeliveryClaimedEvent,
  type MetadataSetEvent,
  type VerdictDeliveryClaimedEvent,
  type TaskBudgetRefundedEvent,
  type ClaimedEvent,
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
  await handleVerdictDeliveryClaimed({
    event: event as unknown as VerdictDeliveryClaimedEvent,
    context: context as unknown as HandlerContext,
    verdict,
  });
});

ponder.on('JinnRouter:TaskBudgetRefunded', async ({ event, context }) => {
  await handleTaskBudgetRefunded({
    event: event as unknown as TaskBudgetRefundedEvent,
    context: context as unknown as HandlerContext,
    task,
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
    ipfsGateway,
  });
});

ponder.on('JinnDistributor:Claimed', async ({ event, context }) => {
  await handleClaimed({
    event: event as unknown as ClaimedEvent,
    context: context as unknown as HandlerContext,
    rewardDistribution,
  });
});
