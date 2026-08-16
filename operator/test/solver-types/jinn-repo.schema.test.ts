import { describe, it, expect } from 'vitest';
import {
  JinnRepoTaskSchema,
  isMergedPrTask,
  isLiveIssueTask,
} from '../../src/solver-types/jinn-repo.js';

describe('JinnRepoTaskSchema — merged-pr branch (retrospective)', () => {
  // A legacy document — no `source` field, exactly as every jinn-repo task
  // looked before the discriminated union. Must keep parsing unchanged.
  const legacyValid = {
    schemaVersion: 'jinn-repo.v1',
    instance_id: 'Jinn-Network__mono-1042',
    repo: 'Jinn-Network/mono',
    base_commit: '627e1eb72f0000000000000000000000000000aa',
    merged_pr: 1042,
    language: 'typescript',
    problem_statement: 'Mech safe nonce is stale on retry; refresh it.',
    test_files: ['operator/test/adapters/mech/safe.nonce.test.ts'],
    test_cmd: 'yarn vitest run operator/test/adapters/mech/safe.nonce.test.ts',
  };

  it('accepts a well-formed legacy task (no `source`), defaulting source to merged-pr', () => {
    expect(JinnRepoTaskSchema.parse(legacyValid)).toEqual({ ...legacyValid, source: 'merged-pr' });
  });

  it('accepts a well-formed task with `source: merged-pr` explicit', () => {
    const withSource = { ...legacyValid, source: 'merged-pr' as const };
    expect(JinnRepoTaskSchema.parse(withSource)).toEqual(withSource);
  });

  it('rejects a task with no test_files (ungradeable)', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...legacyValid, test_files: [] })).toThrow();
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...legacyValid, schemaVersion: 'jinn-repo.v2' })).toThrow();
  });

  it('rejects a merged-pr task carrying live-issue-only fields', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...legacyValid, issue_number: 5 })).toThrow();
  });
});

describe('JinnRepoTaskSchema — live-issue branch (prospective)', () => {
  const validLiveIssue = {
    schemaVersion: 'jinn-repo.v1',
    source: 'live-issue' as const,
    instance_id: 'Jinn-Network__mono-1889',
    repo: 'Jinn-Network/mono',
    base_commit: '627e1eb72f0000000000000000000000000000aa',
    language: 'typescript',
    problem_statement: 'Live issue #1889: jinn-repo live-variant schema.',
    issue_number: 1889,
  };

  it('accepts a well-formed live-issue task', () => {
    expect(JinnRepoTaskSchema.parse(validLiveIssue)).toEqual(validLiveIssue);
  });

  it('accepts a live-issue task with an optional effort tier', () => {
    const withEffort = { ...validLiveIssue, effort: 'low' as const };
    expect(JinnRepoTaskSchema.parse(withEffort)).toEqual(withEffort);
  });

  it('rejects a live-issue task missing issue_number', () => {
    const { issue_number: _issue_number, ...missing } = validLiveIssue;
    expect(() => JinnRepoTaskSchema.parse(missing)).toThrow();
  });

  it('rejects a live-issue task with a non-positive issue_number', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...validLiveIssue, issue_number: 0 })).toThrow();
  });

  it('rejects a live-issue task with an invalid effort tier', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...validLiveIssue, effort: 'extreme' })).toThrow();
  });

  it('rejects a live-issue task carrying gold (merged-pr-only) fields', () => {
    expect(() =>
      JinnRepoTaskSchema.parse({ ...validLiveIssue, merged_pr: 1042 }),
    ).toThrow();
    expect(() =>
      JinnRepoTaskSchema.parse({ ...validLiveIssue, test_files: ['t.test.ts'] }),
    ).toThrow();
    expect(() =>
      JinnRepoTaskSchema.parse({ ...validLiveIssue, test_cmd: 'yarn vitest run t.test.ts' }),
    ).toThrow();
  });

  it('rejects an unknown `source` value', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...validLiveIssue, source: 'open-pr' })).toThrow();
  });
});

describe('isMergedPrTask / isLiveIssueTask', () => {
  it('narrows a parsed merged-pr task', () => {
    const task = JinnRepoTaskSchema.parse({
      schemaVersion: 'jinn-repo.v1',
      instance_id: 'Jinn-Network__mono-1042',
      repo: 'Jinn-Network/mono',
      base_commit: 'a'.repeat(40),
      merged_pr: 1042,
      language: 'typescript',
      problem_statement: 'p',
      test_files: ['t.test.ts'],
      test_cmd: 'yarn vitest run t.test.ts',
    });
    expect(isMergedPrTask(task)).toBe(true);
    expect(isLiveIssueTask(task)).toBe(false);
    if (isMergedPrTask(task)) {
      // Compile-time narrowing check: merged_pr only exists on this branch.
      expect(task.merged_pr).toBe(1042);
    }
  });

  it('narrows a parsed live-issue task', () => {
    const task = JinnRepoTaskSchema.parse({
      schemaVersion: 'jinn-repo.v1',
      source: 'live-issue',
      instance_id: 'Jinn-Network__mono-1889',
      repo: 'Jinn-Network/mono',
      base_commit: 'a'.repeat(40),
      language: 'typescript',
      problem_statement: 'p',
      issue_number: 1889,
    });
    expect(isMergedPrTask(task)).toBe(false);
    expect(isLiveIssueTask(task)).toBe(true);
    if (isLiveIssueTask(task)) {
      // Compile-time narrowing check: issue_number only exists on this branch.
      expect(task.issue_number).toBe(1889);
    }
  });
});
