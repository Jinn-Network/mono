import { describe, it, expect } from 'vitest';
import { parsePilotInstanceRow } from '../../src/pilot/instance.js';

describe('pilot instance parse', () => {
  it('pulls the solve-side fields the grader HfRow omits', () => {
    const row = { instance_id: 'pilosus__pip-license-checker-119', repo: 'pilosus/pip-license-checker',
      base_commit: '22d2f959', problem_statement: 'pin the API version header' };
    expect(parsePilotInstanceRow(row, { hf_dataset: 'ds', hf_split: 'train' })).toEqual({
      instance_id: 'pilosus__pip-license-checker-119', repo: 'pilosus/pip-license-checker',
      base_commit: '22d2f959', problem_statement: 'pin the API version header',
      hf_dataset: 'ds', hf_split: 'train',
    });
  });
  it('throws when base_commit or problem_statement is missing', () => {
    expect(() => parsePilotInstanceRow({ instance_id: 'x', repo: 'a/b', base_commit: 'c' }, { hf_dataset: 'ds', hf_split: 't' })).toThrow(/problem_statement/);
  });
});
