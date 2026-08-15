import { describe, expect, it } from 'vitest';
import { CANONICAL_KINDS, isCanonicalKind } from './taxonomy.js';

describe('taxonomy', () => {
  it('lists exactly the 16 canonical kinds from OPERATOR-APP-SPEC §2.10 (issue #2408)', () => {
    expect(CANONICAL_KINDS).toEqual([
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
    ]);
  });

  it('isCanonicalKind accepts known kinds and rejects unknown', () => {
    expect(isCanonicalKind('harness_not_ready')).toBe(true);
    expect(isCanonicalKind('rpc_all_failed')).toBe(true);
    expect(isCanonicalKind('made_up_kind')).toBe(false);
  });
});
