/**
 * Ponder event handlers for the Jinn protocol indexer.
 *
 * Four event sources, each mapped to one entity in ponder.schema.ts:
 *
 *   JinnRouter:TaskCreated          → task
 *   JinnRouter:TaskAttemptCreated   → attempt
 *   JinnRouter:SolutionDeliveryClaimed → task.finalized = true
 *   IdentityRegistry:MetadataSet    → solverNetManifest OR envelope (routed by key)
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
import { task, attempt, solverNetManifest, envelope } from 'ponder:schema';
import {
  handleTaskCreated,
  handleTaskAttemptCreated,
  handleSolutionDeliveryClaimed,
  handleMetadataSet,
  type HandlerContext,
  type TaskCreatedEvent,
  type TaskAttemptCreatedEvent,
  type SolutionDeliveryClaimedEvent,
  type MetadataSetEvent,
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

ponder.on('IdentityRegistry:MetadataSet', async ({ event, context }) => {
  await handleMetadataSet({
    event: event as unknown as MetadataSetEvent,
    context: context as unknown as HandlerContext,
    solverNetManifest,
    envelope,
  });
});
