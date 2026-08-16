export const NOTIFICATION_KINDS = [
  "funding_low",
  "funding_empty",
  "password_rotation_due",
  "harness_not_ready",
  "bootstrap_blocked",
  "restart_required",
  "update_available",
  "rpc_unreachable",
  "rpc_all_failed",
  "rpc_primary_degraded",
  "no_solvernets_joined",
  "safe_binding_pending",
  "claim_failed",
  "config_migrated",
  "unreleased_attempt",
  "evidence_indexing_failed",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ["blocking", "warning", "info"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];
