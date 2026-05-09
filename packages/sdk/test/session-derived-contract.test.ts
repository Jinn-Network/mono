import { describe, expect, it } from 'vitest';
import {
  SESSION_DERIVED_V1_SOLVER_NET_CONTRACT,
  SOLVER_NET_CONTRACTS,
  getSolverNetContract,
} from '../src/contracts.js';

describe('SESSION_DERIVED_V1_SOLVER_NET_CONTRACT (scaffold)', () => {
  it('has the expected identity (aligned to existing v1 convention; spec §5.2 uses 1.0.0 and will be updated separately)', () => {
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.id).toBe('session-derived');
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.version).toBe('v1');
  });

  it('is registered under "session-derived.v1" in SOLVER_NET_CONTRACTS', () => {
    expect(SOLVER_NET_CONTRACTS['session-derived.v1']).toBe(
      SESSION_DERIVED_V1_SOLVER_NET_CONTRACT,
    );
    expect(getSolverNetContract({ id: 'session-derived', version: 'v1' })).toBe(
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

  it('schemas block exposes concrete Zod + JSON Schema for task / solution / verdict', () => {
    const { task, solution, verdict } = SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.schemas;
    for (const block of [task, solution, verdict]) {
      expect(block).toHaveProperty('zod');
      expect(block).toHaveProperty('json');
      expect(typeof block.zod.safeParse).toBe('function');
      expect(typeof block.json).toBe('object');
      expect(block.json).not.toBeNull();
    }
    expect(task.zod.safeParse({}).success).toBe(false);
    expect(solution.zod.safeParse({ schemaVersion: 'session-derived-solution.v1' }).success).toBe(false);
    expect(verdict.zod.safeParse({}).success).toBe(false);
  });
});
