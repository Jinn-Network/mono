/**
 * The daemon lifecycle-event vocabulary (spec/2026-08-04-headless-operator-rederivation-design.md
 * §8 artifact 6).
 *
 * Before this module, the vocabulary was forked in-tree: 16 values in
 * `client/src/observability/emit-event.ts`, 12 in the SPA's
 * `client/src/dashboard/spa/src/lib/event-kinds.ts`, under a comment claiming the two lists
 * were kept aligned by a test — `event-kinds.test.ts` in fact asserted `LIFECYCLE_KINDS`
 * against its own hand-copied literal, never against the daemon's real
 * `ALLOWED_LIFECYCLE_KINDS`, so the fork was free to drift silently. This module is the one
 * exported vocabulary; both `emit-event.ts` and `event-kinds.ts` import `LIFECYCLE_KINDS`
 * from here instead of declaring their own copy.
 *
 * **The unknown-kind rule (contract clause, not advice).** Every lifecycle/notification
 * payload carries server-supplied `severity` and human-readable `title`. Consumers MUST
 * render an event whose `kind` they do not recognize using those two fields — never by
 * dropping the event, never by crashing, and never by requiring a client-side kind→copy
 * map to have an entry first. This is what makes adding a new `kind` genuinely additive
 * against a fleet that demonstrably runs stale images for weeks (spec §8): a daemon on an
 * old image sends a kind an old SPA doesn't know, and the old SPA still renders something
 * legible. `severity`/`title` are optional on the wire today (existing writers predate this
 * clause) — a `kind` absent from `LIFECYCLE_KINDS` with no `severity`/`title` still degrades
 * to a generic label (see the SPA's `event-kinds.ts` `eventKindMeta` fallback), it just loses
 * the server's intended framing.
 */
import { z } from 'zod/v4';

export const LIFECYCLE_KINDS = [
  'task_posted',
  'intent_registry_failed',
  'request_claimed',
  'delivery_submitted',
  'evaluation_submitted',
  'reward_claimed',
  'balance_topup',
  'engine_transition',
  'corpus_knowledge',
  'tick_error',
  'race_lost',
  'spend_cap_reached',
  'ai_units_cap_reached',
  'startup',
  'shutdown',
  'harvest_admitted',
] as const;

export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export const lifecycleKindSchema = z.enum(LIFECYCLE_KINDS);

/** Severity carried on a lifecycle/notification payload for the unknown-kind rendering rule. */
export const eventSeveritySchema = z.enum(['info', 'success', 'warning', 'error']);
export type EventSeverity = z.infer<typeof eventSeveritySchema>;

/**
 * `GET /v1/activity` row shape. `kind` is `string`, not `LifecycleKind` — the wire type is
 * intentionally wider than the known vocabulary so an old SPA reading a new daemon's rows
 * doesn't fail schema validation on a kind it doesn't recognize yet (the unknown-kind rule
 * above governs rendering, not parsing). `severity`/`title` are optional per the docstring:
 * present from writers that have adopted the clause, absent from ones that haven't yet.
 */
export const activityEventRowSchema = z.object({
  id: z.number(),
  ts: z.string().nullable(),
  kind: z.string(),
  requestId: z.string().nullable(),
  serviceIndex: z.number().nullable(),
  txHash: z.string().nullable(),
  solverType: z.string().nullable(),
  outcome: z.string().nullable(),
  detail: z.string().nullable(),
  /** Human-readable title for the unknown-kind rendering rule. */
  title: z.string().optional(),
  /** Severity for the unknown-kind rendering rule. */
  severity: eventSeveritySchema.optional(),
});
export type ActivityEventRow = z.infer<typeof activityEventRowSchema>;

export const activityEventsResponseSchema = z.object({
  events: z.array(activityEventRowSchema),
  nextCursor: z.number().nullable(),
  counts: z.record(z.string(), z.number()),
});
export type ActivityEventsResponse = z.infer<typeof activityEventsResponseSchema>;

export const structuredEventKindSchema = z.enum(['intent', 'reward', 'fleet', 'system', 'error', 'log']);
export type StructuredEventKind = z.infer<typeof structuredEventKindSchema>;

/** SSE lifecycle-tail envelope (today's shape; §6.4's CloudEvents profile supersedes this). */
export const structuredEventSchema = z.object({
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
