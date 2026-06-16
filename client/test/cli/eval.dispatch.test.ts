import { describe, it, expect } from 'vitest';
import { selectEvalBackend } from '../../src/cli/commands/eval.js';
describe('selectEvalBackend', () => {
  it('returns the jinn-repo backend for solverType jinn-repo', () => {
    expect(selectEvalBackend('jinn-repo').kind).toBe('jinn-repo');
  });
  it('returns the swe-rebench-v2 backend otherwise', () => {
    expect(selectEvalBackend('swe-rebench-v2').kind).toBe('swe-rebench-v2');
  });
});
