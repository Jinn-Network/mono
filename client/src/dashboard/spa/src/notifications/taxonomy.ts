import type { NotificationV1 } from '../../../../api/contract/index.js';
import { NOTIFICATION_KINDS, type NotificationKind } from '../../../../api/contract/notification-kinds.const.js';

/**
 * Canonical notification vocabulary (OPERATOR-APP-SPEC §2.10, 16 kinds) — sourced from the
 * zod-free `client/src/api/contract/notification-kinds.const.ts` (issue #2408) rather than a
 * second hand-copied list here (the pre-#2408 list here had 14 entries, missing the two
 * RPC-health kinds the browser bundle could never derive on its own). Importing the const
 * module's zod-schema sibling (`contract/notifications.ts`) as a *value* would drag `zod/v4`
 * into this bundle — same reasoning as `lib/event-kinds.ts`'s `LIFECYCLE_KINDS` import; the
 * `NotificationV1` import above is `import type`-only, which `tsc`/`vite` erase.
 */
export const CANONICAL_KINDS = NOTIFICATION_KINDS;
export type CanonicalKind = NotificationKind;

export function isCanonicalKind(s: string): s is CanonicalKind {
  return (CANONICAL_KINDS as readonly string[]).includes(s);
}

/**
 * The wire notification shape served by `GET /v1/notifications` (issue #2408) — see
 * `client/src/api/contract/notifications.ts`. Notification derivation itself now lives
 * server-side; the SPA only renders what it's given, plus the one client-local overlay
 * (`OfflineNotice` / the disconnected branch of `useNotifications.ts`) that a server can never
 * report about itself.
 */
export type OperatorNotification = NotificationV1;
