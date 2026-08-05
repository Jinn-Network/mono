/**
 * `GET /v1/notifications` response schema (spec/2026-08-04-headless-operator-rederivation-design.md
 * §6.5, issue #2408).
 *
 * Notification derivation moves server-side: a pure function over receipts + the live-health
 * class (see `client/src/api/notifications-build.ts`), exposed here. Per §8's unknown-kind
 * rule, `severity` and a human-readable `title` are REQUIRED on the wire — this endpoint is
 * the first producer that actually populates them (the sibling `lifecycle-kind.ts` schemas
 * declare the same two fields but leave them optional/unpopulated pending a producer; see
 * that module's docstring). `kind` is `z.string()`, not the narrower `NOTIFICATION_KINDS`
 * enum, so an old SPA reading a new daemon's payload doesn't fail schema validation on a kind
 * it doesn't recognize yet — the unknown-kind rule governs rendering (render from `severity` +
 * `title`), not parsing.
 */
import { z } from 'zod/v4';
import { NOTIFICATION_KINDS } from './notification-kinds.const.js';

export { NOTIFICATION_KINDS };
export type { NotificationKind, NotificationSeverity } from './notification-kinds.const.js';

export const notificationSeveritySchema = z.enum(['blocking', 'warning', 'info']);

export const notificationSchema = z.looseObject({
  /** Wider than `NOTIFICATION_KINDS` on the wire — see the unknown-kind rule above. */
  kind: z.string(),
  severity: notificationSeveritySchema,
  /** Short human-readable label — required (§8 unknown-kind rule). */
  title: z.string(),
  /** Full descriptive text rendered by `NotificationItem` today. */
  message: z.string(),
  /** Route path the operator can click to resolve the notice. */
  jumpTo: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type NotificationV1 = z.infer<typeof notificationSchema>;

export const notificationsV1ResponseSchema = z.looseObject({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  notifications: z.array(notificationSchema),
});
export type NotificationsV1Response = z.infer<typeof notificationsV1ResponseSchema>;
