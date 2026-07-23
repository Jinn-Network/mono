/**
 * jinn-repo Task schema — SDK-side coverage.
 *
 * This is the schema instance that is actually load-bearing at claim time:
 * `packages/sdk/src/contracts.ts` wires `JinnRepoTaskSchema` (this module)
 * into `JINN_REPO_V1_SOLVER_NET_CONTRACT.schemas.task.zod`, which
 * `client/src/harnesses/engine/engine.ts` `manifestBackedValidation`
 * safeParses every claimed task spec against via `getSolverNetContract`.
 * The client's `client/src/solver-types/jinn-repo.ts` is now a thin
 * re-export of this module (see PR #1898 review, issue #1889) — this test
 * mirrors the essential cases from
 * `client/test/solver-types/jinn-repo.schema.test.ts` directly against the
 * SDK export, so claim-time validation behavior is verified where it's
 * defined, not only where it's re-exported.
 */

import { describe, it, expect } from 'vitest';
import {
  JinnRepoTaskSchema,
  isAutopilotSessionTask,
  isMergedPrTask,
  isLiveIssueTask,
} from '../src/jinn-repo.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const autopilotFixtureDirectory = fileURLToPath(
  new URL('./fixtures/autopilot-session/', import.meta.url),
);

function autopilotFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(`${autopilotFixtureDirectory}${name}.json`, 'utf8'),
  ) as unknown;
}

describe('JinnRepoTaskSchema (SDK) — merged-pr branch (retrospective)', () => {
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
    test_files: ['client/test/adapters/mech/safe.nonce.test.ts'],
    test_cmd: 'yarn vitest run client/test/adapters/mech/safe.nonce.test.ts',
  };

  it('accepts a well-formed legacy task (no `source`), defaulting source to merged-pr', () => {
    expect(JinnRepoTaskSchema.parse(legacyValid)).toEqual({ ...legacyValid, source: 'merged-pr' });
  });

  it('rejects a merged-pr task carrying live-issue-only fields', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...legacyValid, issue_number: 5 })).toThrow();
  });

  it('rejects a merged-pr task carrying an Autopilot session capsule', () => {
    expect(() => JinnRepoTaskSchema.parse({
      ...legacyValid,
      session: autopilotFixture('session-implement'),
    })).toThrow();
  });
});

describe('JinnRepoTaskSchema (SDK) — live-issue branch (prospective)', () => {
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

  it('rejects a live-issue task missing issue_number', () => {
    const { issue_number: _issue_number, ...missing } = validLiveIssue;
    expect(() => JinnRepoTaskSchema.parse(missing)).toThrow();
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

  it('rejects a live-issue task carrying an Autopilot session capsule', () => {
    expect(() => JinnRepoTaskSchema.parse({
      ...validLiveIssue,
      session: autopilotFixture('session-implement'),
    })).toThrow();
  });

  it('rejects an unknown `source` value', () => {
    expect(() => JinnRepoTaskSchema.parse({ ...validLiveIssue, source: 'open-pr' })).toThrow();
  });
});

describe('isMergedPrTask / isLiveIssueTask (SDK)', () => {
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
  });
});

describe('JinnRepoTaskSchema (SDK) — autopilot-session branch', () => {
  const valid = {
    schemaVersion: 'jinn-repo.v1',
    source: 'autopilot-session' as const,
    instance_id: 'autopilot:123e4567-e89b-42d3-a456-426614174001',
    repo: 'Jinn-Network/mono',
    base_commit: 'a'.repeat(40),
    language: 'typescript',
    problem_statement: 'Implement exact marketplace contracts.',
    session: autopilotFixture('session-implement'),
  };

  it('accepts a well-formed Autopilot session task and narrows it', () => {
    const parsed = JinnRepoTaskSchema.parse(valid);
    expect(parsed).toEqual(valid);
    expect(isAutopilotSessionTask(parsed)).toBe(true);
    expect(isMergedPrTask(parsed)).toBe(false);
    expect(isLiveIssueTask(parsed)).toBe(false);
  });

  it('rejects missing or malformed strict session capsules', () => {
    const { session: _session, ...missing } = valid;
    expect(() => JinnRepoTaskSchema.parse(missing)).toThrow();

    expect(() => JinnRepoTaskSchema.parse({
      ...valid,
      session: { ...(valid.session as object), surprise: true },
    })).toThrow();
  });

  it('keeps legacy task wrappers permissive while the new nested codec is strict', () => {
    expect(JinnRepoTaskSchema.parse({ ...valid, wrapperMetadata: 'kept-compatible' }))
      .toEqual(valid);
  });
});
