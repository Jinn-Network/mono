/**
 * The daemon lifecycle-event vocabulary (spec/2026-08-04-headless-operator-rederivation-design.md
 * §8 artifact 6).
 *
 * Before this module, the vocabulary was forked in-tree: 16 values in
 * `operator/src/observability/emit-event.ts`, 12 in the SPA's
 * `operator/src/dashboard/spa/src/lib/event-kinds.ts`, under a comment claiming the two lists
 * were kept aligned by a test — `event-kinds.test.ts` in fact asserted `LIFECYCLE_KINDS`
 * against its own hand-copied literal, never against the daemon's real
 * `ALLOWED_LIFECYCLE_KINDS`, so the fork was free to drift silently. `emit-event.ts` imports
 * `LIFECYCLE_KINDS` from here; the SPA's `event-kinds.ts` imports it from the zod-free
 * `lifecycle-kinds.const.ts` sibling instead (see that module's docstring — a value-import
 * of anything from *this* module pulls zod/v4 into the SPA bundle).
 *
 * **The unknown-kind rule (contract clause, not advice).** Every lifecycle/notification
 * payload SHOULD carry server-supplied `severity` and human-readable `title`, and consumers
 * MUST render an event whose `kind` they do not recognize using those two fields when
 * present — never by dropping the event, never by crashing, and never by requiring a
 * client-side kind→copy map to have an entry first. This is what makes adding a new `kind`
 * genuinely additive against a fleet that demonstrably runs stale images for weeks (spec
 * §8): a daemon on an old image sends a kind an old SPA doesn't know, and the old SPA still
 * renders something legible.
 *
 * **Producer-side gap, stated plainly, not softened:** no current writer populates
 * `severity`/`title` — `store.ts`'s `ActivityEventInput`/`ActivityEventRow` have no such
 * columns, and `activity-events-endpoint.ts` computes nothing extra before serializing a row.
 * They are declared on the wire schemas below as forward-looking optional fields the
 * consumer side (`eventKindMeta`/`eventKindBadgeVariant` in the SPA's `event-kinds.ts`, wired
 * at every render call site) is already built to honor, so that landing the producer columns
 * is a one-sided change. Adding those columns is #2408's territory, not this issue's; until
 * then `severity`/`title` are always absent and every kind renders from `EVENT_KIND_META` /
 * the generic `titleCase()` fallback, exactly as it did before this module existed.
 */
import { z } from 'zod/v4';
import { LIFECYCLE_KINDS, type LifecycleKind } from './lifecycle-kinds.const.js';

export { LIFECYCLE_KINDS };
export type { LifecycleKind };

export const lifecycleKindSchema = z.enum(LIFECYCLE_KINDS);

/** Severity carried on a lifecycle/notification payload for the unknown-kind rendering rule. */
export const eventSeveritySchema = z.enum(['info', 'success', 'warning', 'error']);
export type EventSeverity = z.infer<typeof eventSeveritySchema>;

/**
 * `GET /v1/activity-events` row shape — matches `store.ts`'s real `ActivityEventRow`
 * field-for-field (the row this endpoint actually serializes; see
 * `activity-events-endpoint.ts`), plus the two forward-looking `severity`/`title` fields
 * from the unknown-kind rule (module docstring) that no producer populates yet. `kind` is
 * `string`, not `LifecycleKind` — the wire type is intentionally wider than the known
 * vocabulary so an old SPA reading a new daemon's rows doesn't fail schema validation on a
 * kind it doesn't recognize yet (the unknown-kind rule governs rendering, not parsing).
 */
export const activityEventRowSchema = z.looseObject({
  id: z.number(),
  ts: z.string().nullable(),
  kind: z.string(),
  requestId: z.string().nullable(),
  serviceIndex: z.number().nullable(),
  txHash: z.string().nullable(),
  solverType: z.string().nullable(),
  outcome: z.string().nullable(),
  detail: z.string().nullable(),
  credentialId: z.string().nullable(),
  costUsdMicros: z.number().nullable(),
  model: z.string().nullable(),
  /** Projected AI units debited at claim time (issue #815). Estimate; never recomputed. */
  aiUnits: z.number().nullable(),
  /** Lifecycle stamp on the per-request row: 'claimed' | 'claim_failed' | 'delivered'. */
  claimStatus: z.string().nullable(),
  /** USD estimate captured at claim time (micros). */
  estimatedCostUsdMicros: z.number().nullable(),
  /** USD actually billed (micros) — filled by the completion path; null until then. */
  actualCostUsdMicros: z.number().nullable(),
  /** Human-readable title for the unknown-kind rendering rule. No producer yet — see docstring. */
  title: z.string().optional(),
  /** Severity for the unknown-kind rendering rule. No producer yet — see docstring. */
  severity: eventSeveritySchema.optional(),
});
export type ActivityEventRow = z.infer<typeof activityEventRowSchema>;

export const activityEventsResponseSchema = z.looseObject({
  events: z.array(activityEventRowSchema),
  nextCursor: z.number().nullable(),
  counts: z.record(z.string(), z.number()),
});
export type ActivityEventsResponse = z.infer<typeof activityEventsResponseSchema>;

export const structuredEventKindSchema = z.enum(['intent', 'reward', 'fleet', 'system', 'error', 'log']);
export type StructuredEventKind = z.infer<typeof structuredEventKindSchema>;

/** SSE lifecycle-tail envelope (today's shape; §6.4's CloudEvents profile supersedes this). */
export const structuredEventSchema = z.looseObject({
  schemaVersion: z.literal(1),
  id: z.string(),
  ts: z.string(),
  kind: structuredEventKindSchema,
  message: z.string(),
  requestId: z.string().optional(),
  txHash: z.string().optional(),
  errorCode: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  /** Human-readable title for the unknown-kind rendering rule. */
  title: z.string().optional(),
  /** Severity for the unknown-kind rendering rule. */
  severity: eventSeveritySchema.optional(),
});
export type StructuredEvent = z.infer<typeof structuredEventSchema>;
