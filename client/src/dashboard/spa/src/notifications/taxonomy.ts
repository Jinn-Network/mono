import type { Severity } from './severity.js';

export const CANONICAL_KINDS = [
  'funding_low',
  'funding_empty',
  'password_rotation_due',
  'harness_not_ready',
  'bootstrap_blocked',
  'restart_required',
  'update_available',
  'rpc_unreachable',
  'no_solvernets_joined',
  'safe_binding_pending',
  'claim_failed',
  'config_migrated',
  'unreleased_attempt',
  'evidence_indexing_failed',
] as const;

export type CanonicalKind = (typeof CANONICAL_KINDS)[number];

export function isCanonicalKind(s: string): s is CanonicalKind {
  return (CANONICAL_KINDS as readonly string[]).includes(s);
}

export interface OperatorNotification {
  kind: CanonicalKind;
  severity: Severity;
  message: string;
  jumpTo?: string; // route path the operator can click to resolve
  details?: Record<string, unknown>;
}
