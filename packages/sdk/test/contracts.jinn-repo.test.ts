import { describe, it, expect } from 'vitest';
import { SOLVER_NET_CONTRACTS, getSolverNetContract } from '../src/contracts.js';

describe('JINN_REPO_V1_SOLVER_NET_CONTRACT', () => {
  it('is registered under "jinn-repo.v1"', () => {
    const contract = getSolverNetContract({ id: 'jinn-repo', version: 'v1' });
    expect(contract).toBeDefined();
    expect(contract).toBe(SOLVER_NET_CONTRACTS['jinn-repo.v1']);
    expect(contract?.id).toBe('jinn-repo');
    expect(contract?.version).toBe('v1');
    expect(contract?.name).toBe('Jinn repo');
  });

  it('declares task, solution and verdict schemas', () => {
    const contract = SOLVER_NET_CONTRACTS['jinn-repo.v1'];
    expect(contract.schemas.task).toBeDefined();
    expect(contract.schemas.solution).toBeDefined();
    expect(contract.schemas.verdict).toBeDefined();
  });

  it('declares a deterministic repo-native evaluation function pointing at the evaluator impl', () => {
    const contract = SOLVER_NET_CONTRACTS['jinn-repo.v1'];
    expect(contract.evaluationFunction.deterministic).toBe(true);
    expect(contract.evaluationFunction.implementation).toBe(
      'operator/src/harnesses/impls/jinn-repo-evaluator',
    );
  });

  it('declares no evaluator Docker credential (repo-native runner)', () => {
    const contract = SOLVER_NET_CONTRACTS['jinn-repo.v1'];
    expect(contract.credentialRequirements.evaluator).toEqual([]);
  });

  it('declares the multi-winrate aggregation function', () => {
    const contract = SOLVER_NET_CONTRACTS['jinn-repo.v1'];
    expect(contract.aggregationFunction.id).toBe('jinn-repo.multi-winrate.v1');
    expect(contract.aggregationFunction.windowDays).toBe(30);
  });
});
