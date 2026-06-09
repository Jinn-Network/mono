import { describe, it, expect } from 'vitest';
import { SOLVER_TYPES } from '../../src/solver-types/index.js';
import { SOLVER_TYPE_PAYLOADS } from '../../src/types/payloads/index.js';

const validJinnRepoTask = {
  schemaVersion: 'jinn-repo.v1',
  instance_id: 'jinn-network__mono-1109',
  repo: 'Jinn-Network/mono',
  base_commit: '0'.repeat(40),
  merged_pr: 1109,
  language: 'typescript',
  problem_statement: 'Fix the thing.',
  test_files: ['client/test/foo.test.ts'],
  test_cmd: 'yarn vitest run client/test/foo.test.ts',
};

describe('jinn-repo SolverTypeDefinition registration', () => {
  it('is registered in SOLVER_TYPES under "jinn-repo.v1"', () => {
    const def = SOLVER_TYPES['jinn-repo.v1'];
    expect(def).toBeDefined();
    expect(def.solverType).toBe('jinn-repo.v1');
  });

  it('parseSpec resolves a valid task into .spec', async () => {
    const overlay = await SOLVER_TYPES['jinn-repo.v1'].parseSpec(validJinnRepoTask);
    expect(overlay.spec).toMatchObject({ instance_id: 'jinn-network__mono-1109' });
  });

  it('buildGenerator yields a stub generator that produces no tasks', async () => {
    const def = SOLVER_TYPES['jinn-repo.v1'];
    expect(def.buildGenerator).toBeDefined();
    const gen = def.buildGenerator!({});
    await expect(gen()).resolves.toBeNull();
  });

  it('SOLVER_TYPE_PAYLOADS["jinn-repo.v1"].solution parses a valid solution payload', () => {
    const schema = SOLVER_TYPE_PAYLOADS['jinn-repo.v1']?.solution;
    expect(schema).toBeDefined();
    expect(() =>
      schema!.parse({ schemaVersion: 'jinn-repo-solution.v1', patch: 'diff ...' }),
    ).not.toThrow();
  });
});
