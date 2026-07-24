import { describe, it, expect } from 'vitest';
import { JinnRepoEvaluator } from '../../../src/harnesses/impls/jinn-repo-evaluator/evaluator.js';

describe('JinnRepoEvaluator', () => {
  const task = { schemaVersion: 'jinn-repo.v1', source: 'merged-pr', instance_id: 'x-1', repo: 'Jinn-Network/mono',
    base_commit: 'a'.repeat(40), merged_pr: 1, language: 'typescript',
    problem_statement: 'p', test_files: ['t.test.ts'], test_cmd: 'yarn vitest run t.test.ts',
    gold_tests: { 't.test.ts': 'x' }, solution_patch: 'diff' } as const;

  it('maps a PASS run to a passed verdict', async () => {
    const evaluator = new JinnRepoEvaluator({ run: async () => ({ passed: true, unscorable: false, logExcerpt: '' }) });
    const v = await evaluator.grade({ task, solution: { patch: 'diff' } });
    expect(v).toEqual({ passed: true, unscorable: false, logExcerpt: '' });
  });

  it('propagates unscorable (infra failure) without coercing to FAIL', async () => {
    const evaluator = new JinnRepoEvaluator({ run: async () => ({ passed: null, unscorable: true, logExcerpt: 'install-failed' }) });
    const v = await evaluator.grade({ task, solution: { patch: 'diff' } });
    expect(v.unscorable).toBe(true);
    expect(v.passed).toBeNull();
  });
});
