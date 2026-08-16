import { describe, it, expect } from 'vitest';
import { solverView, JinnRepoPoolItemSchema } from '../../src/solver-types/_jinn-repo-pool.js';

const item = {
  schemaVersion: 'jinn-repo.v1', source: 'merged-pr' as const,
  instance_id: 'Jinn-Network__mono-1042', repo: 'Jinn-Network/mono',
  base_commit: 'a'.repeat(40), merged_pr: 1042, language: 'typescript',
  problem_statement: 'Mech safe nonce stale on retry.',
  test_files: ['operator/test/adapters/mech/safe.nonce.test.ts'],
  test_cmd: 'yarn vitest run operator/test/adapters/mech/safe.nonce.test.ts',
  gold_tests: { 'operator/test/adapters/mech/safe.nonce.test.ts': 'import ...' },
  solution_patch: 'diff --git ...',
};

describe('jinn-repo pool item', () => {
  it('parses a full pool item', () => {
    expect(JinnRepoPoolItemSchema.parse(item).gold_tests).toBeDefined();
  });
  it('solverView strips evaluator-side fields (no test contents, no solution)', () => {
    const v = solverView(item);
    expect(v).not.toHaveProperty('gold_tests');
    expect(v).not.toHaveProperty('solution_patch');
    expect(v.problem_statement).toBe(item.problem_statement);
    expect(v.base_commit).toBe(item.base_commit);
  });
});
