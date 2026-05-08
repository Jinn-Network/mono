// Scaffold test for `SESSION_DERIVED_V1_SOLVER_NET_CONTRACT`.
//
// Phase 0 / Task 0.4 of `spec/2026-05-07-telemetry-collector-and-task-generator.md`.
// The scaffold registers the contract identity + claim-policy + credential
// requirements + evaluator/aggregation refs so downstream tasks can reference
// `session-derived` without circular blocking. Payload schemas (Task /
// Solution / Verdict) are placeholders here and are filled in Phase 10 of the
// plan.
import { describe, expect, it } from 'vitest';
import {
  SESSION_DERIVED_V1_SOLVER_NET_CONTRACT,
  SOLVER_NET_CONTRACTS,
  getSolverNetContract,
} from '../src/contracts.js';

describe('SESSION_DERIVED_V1_SOLVER_NET_CONTRACT (scaffold)', () => {
  it('has the expected identity per spec §5.2', () => {
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.id).toBe('session-derived');
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.version).toBe('1.0.0');
  });

  it('is registered under "session-derived.1.0.0" in SOLVER_NET_CONTRACTS', () => {
    expect(SOLVER_NET_CONTRACTS['session-derived.1.0.0']).toBe(
      SESSION_DERIVED_V1_SOLVER_NET_CONTRACT,
    );
    expect(getSolverNetContract({ id: 'session-derived', version: '1.0.0' })).toBe(
      SESSION_DERIVED_V1_SOLVER_NET_CONTRACT,
    );
  });

  it('claim-policy defaults match spec §5.2 (4-hour lease, ≤5 per operator)', () => {
    const c = SESSION_DERIVED_V1_SOLVER_NET_CONTRACT;
    expect(c.claimPolicyDefaults.maxClaimsPerOperator).toBe(5);
    expect(c.claimPolicyDefaults.claimLeaseTtlSeconds).toBe(4 * 60 * 60);
  });

  it('declares evaluator credential requirement with bond per spec §5.2', () => {
    const c = SESSION_DERIVED_V1_SOLVER_NET_CONTRACT;
    expect(c.credentialRequirements.evaluator.length).toBeGreaterThan(0);
    const bondCred = c.credentialRequirements.evaluator.find(
      (r) => r.id === 'session-derived.evaluator.bond',
    );
    expect(bondCred).toBeDefined();
    expect(bondCred?.required).toBe(true);
  });

  it('declares non-deterministic evaluation function with composite-evaluator id', () => {
    const c = SESSION_DERIVED_V1_SOLVER_NET_CONTRACT;
    expect(c.evaluationFunction.id).toBe('@jinn-network/session-derived-evaluator');
    expect(c.evaluationFunction.deterministic).toBe(false);
  });

  it('declares 30-day rolling-mean aggregation function', () => {
    const c = SESSION_DERIVED_V1_SOLVER_NET_CONTRACT;
    expect(c.aggregationFunction.id).toBe('session-derived-rolling-mean');
    expect(c.aggregationFunction.windowDays).toBe(30);
  });

  it('schemas block exposes Zod + JSON Schema for task / solution / verdict (placeholder shape)', () => {
    const { task, solution, verdict } = SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.schemas;
    for (const block of [task, solution, verdict]) {
      expect(block).toHaveProperty('zod');
      expect(block).toHaveProperty('json');
      expect(typeof block.zod.safeParse).toBe('function');
      expect(typeof block.json).toBe('object');
      expect(block.json).not.toBeNull();
    }
  });
});
