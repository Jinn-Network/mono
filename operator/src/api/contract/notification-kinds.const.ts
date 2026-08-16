/**
 * The operator-notification vocabulary, as a plain zod-free array
 * (spec/2026-08-04-headless-operator-rederivation-design.md §6.5, issue #2408).
 *
 * Canonical per OPERATOR-APP-SPEC §2.10: 16 kinds. Before this module the list was
 * declared only in the SPA (`operator/src/dashboard/spa/src/notifications/taxonomy.ts`), at 14
 * entries — missing the two RPC-health kinds (`rpc_all_failed`, `rpc_primary_degraded`) that
 * were spec-canonical but unimplementable client-side (the browser bundle has no access to
 * the boot-time RPC fallback-chain probe). This module is the single source; the SPA's
 * `taxonomy.ts` imports it directly (zod-free, same reasoning as
 * `lifecycle-kinds.const.ts` next to it — importing anything from a zod-schema sibling
 * drags `zod/v4` into the browser bundle).
 */
export const NOTIFICATION_KINDS = [
  'funding_low',
  'funding_empty',
  'password_rotation_due',
  'harness_not_ready',
  'bootstrap_blocked',
  'restart_required',
  'update_available',
  'rpc_unreachable',
  'rpc_all_failed',
  'rpc_primary_degraded',
  'no_solvernets_joined',
  'safe_binding_pending',
  'claim_failed',
  'config_migrated',
  'unreleased_attempt',
  'evidence_indexing_failed',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ['blocking', 'warning', 'info'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];
