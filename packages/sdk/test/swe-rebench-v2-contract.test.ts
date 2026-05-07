import { describe, it, expect } from 'vitest';
import { SOLVER_NET_CONTRACTS, getSolverNetContract } from '../src/contracts.js';

describe('SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT', () => {
  it('is registered under "swe-rebench-v2.v1"', () => {
    const contract = getSolverNetContract({ id: 'swe-rebench-v2', version: 'v1' });
    expect(contract).toBeDefined();
    expect(contract).toBe(SOLVER_NET_CONTRACTS['swe-rebench-v2.v1']);
    expect(contract?.id).toBe('swe-rebench-v2');
    expect(contract?.version).toBe('v1');
    expect(contract?.name).toBe('SWE-rebench v2');
  });

  it('declares the correct schemas', () => {
    const contract = SOLVER_NET_CONTRACTS['swe-rebench-v2.v1'];
    expect(contract.schemas.task).toBeDefined();
    expect(contract.schemas.solution).toBeDefined();
    expect(contract.schemas.verdict).toBeDefined();
  });

  it('declares deterministic evaluation function pointing at the evaluator impl', () => {
    const contract = SOLVER_NET_CONTRACTS['swe-rebench-v2.v1'];
    expect(contract.evaluationFunction.deterministic).toBe(true);
    expect(contract.evaluationFunction.implementation).toContain('swe-rebench-v2-evaluator');
  });

  it('declares the multi-winrate aggregation function', () => {
    const contract = SOLVER_NET_CONTRACTS['swe-rebench-v2.v1'];
    expect(contract.aggregationFunction.id).toBe('swe-rebench-v2.multi-winrate.v1');
    expect(contract.aggregationFunction.windowDays).toBe(30);
  });

  it('does not declare contract-bound runtime plugin defaults', () => {
    const contract = SOLVER_NET_CONTRACTS['swe-rebench-v2.v1'];
    expect(contract as Record<string, unknown>).not.toHaveProperty('defaultRuntimePlugins');
  });
});
