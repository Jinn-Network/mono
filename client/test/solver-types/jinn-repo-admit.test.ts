import { describe, it, expect } from 'vitest';
import { validateAdmissible } from '../../src/solver-types/jinn-repo-admit.js';

const item: any = { test_files: ['t.test.ts'], gold_tests: { 't.test.ts': 'x' }, solution_patch: 'diff', base_commit: 'a'.repeat(40), repo: 'Jinn-Network/mono', test_cmd: 'yarn vitest run t.test.ts' };

describe('validateAdmissible', () => {
  it('admits when empty FAILS and solution PASSES', async () => {
    const run = async ({ patch }: any) => (patch.trim() === '' ? { passed: false, unscorable: false, logExcerpt: '' } : { passed: true, unscorable: false, logExcerpt: '' });
    expect((await validateAdmissible(item, { run })).admitted).toBe(true);
  });
  it('rejects when the gold test passes even WITHOUT the fix (test does not exercise the bug)', async () => {
    const run = async () => ({ passed: true, unscorable: false, logExcerpt: '' });
    const r = await validateAdmissible(item, { run });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/empty.*PASS|not FAIL_TO_PASS/i);
  });
  it('rejects when unscorable (infra failure)', async () => {
    const run = async () => ({ passed: null, unscorable: true, logExcerpt: 'install-failed' });
    expect((await validateAdmissible(item, { run })).admitted).toBe(false);
  });
  it('rejects when the solution run is unscorable (infra failure on the with-fix run)', async () => {
    const run = async ({ patch }: any) =>
      patch.trim() === ''
        ? { passed: false, unscorable: false, logExcerpt: '' }            // empty FAILs (good)
        : { passed: null, unscorable: true, logExcerpt: 'install-failed' }; // solution run can't grade
    const r = await validateAdmissible(item, { run });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/unscorable.*with fix/i);
  });
});
