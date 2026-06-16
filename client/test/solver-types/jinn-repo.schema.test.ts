import { describe, it, expect } from 'vitest';
import { JinnRepoTaskSchema } from '../../src/solver-types/jinn-repo.js';

describe('JinnRepoTaskSchema', () => {
  const valid = {
    schemaVersion: 'jinn-repo.v1',
    instance_id: 'Jinn-Network__mono-1042',
    repo: 'Jinn-Network/mono',
    base_commit: '627e1eb72f0000000000000000000000000000aa',
    merged_pr: 1042,
    language: 'typescript',
    problem_statement: 'Mech safe nonce is stale on retry; refresh it.',
    test_files: ['client/test/adapters/mech/safe.nonce.test.ts'],
    test_cmd: 'yarn vitest run client/test/adapters/mech/safe.nonce.test.ts',
  };

  it('accepts a well-formed task', () => {
    expect(JinnRepoTaskSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a task with no test_files (ungradeable)', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...valid, test_files: [] })).toThrow();
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...valid, schemaVersion: 'jinn-repo.v2' })).toThrow();
  });
});
