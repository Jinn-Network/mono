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
  JINN_REPO_LIVE_ISSUE_RELAY_MAX_SPEC_BYTES,
  JinnRepoAutopilotSessionTaskSchema,
  JinnRepoLiveIssueTaskSchema,
  JinnRepoTaskSchema,
  isAutopilotSessionTask,
  isMergedPrTask,
  isLiveIssueTask,
} from '../src/jinn-repo.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const autopilotFixtureDirectory = fileURLToPath(
  new URL('../fixtures/autopilot/', import.meta.url),
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

  it('rejects a merged-pr task carrying a Relay capsule', () => {
    expect(JinnRepoTaskSchema.safeParse({ ...legacyValid, relay: {} }).success)
      .toBe(false);
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
  const relay = {
    schemaVersion: 'jinn-issue-relay-round.v1' as const,
    generation: 'R_kgDOExample:42:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    round: 0,
    snapshotDigest: `sha256:${'a'.repeat(64)}`,
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: validLiveIssue.base_commit,
    purpose: 'initial' as const,
    findings: [],
  };

  function relayTaskAtCanonicalBytes(targetBytes: number) {
    const fixed = {
      ...validLiveIssue,
      problem_statement: '',
      relay,
    };
    const fixedBytes = new TextEncoder().encode(
      `${JSON.stringify(fixed, null, 2)}\n`,
    ).byteLength;
    const task = {
      ...fixed,
      problem_statement: 'x'.repeat(targetBytes - fixedBytes),
    };
    expect(new TextEncoder().encode(
      `${JSON.stringify(task, null, 2)}\n`,
    ).byteLength).toBe(targetBytes);
    return task;
  }

  it('accepts a well-formed live-issue task', () => {
    expect(JinnRepoTaskSchema.parse(validLiveIssue)).toEqual(validLiveIssue);
  });

  it('accepts a Relay capsule only when its duplicated outer bindings agree', () => {
    expect(JinnRepoTaskSchema.parse({ ...validLiveIssue, relay }).relay)
      .toEqual(relay);
    expect(JinnRepoTaskSchema.safeParse({
      ...validLiveIssue,
      base_commit: 'b'.repeat(40),
      relay,
    }).success).toBe(false);
    expect(JinnRepoTaskSchema.safeParse({
      ...validLiveIssue,
      relay: { ...relay, targetRepository: 'other/repo' },
    }).success).toBe(false);
  });

  it('bounds only Relay live-issue specs at 2 MiB of canonical UTF-8 bytes', () => {
    const exact = relayTaskAtCanonicalBytes(
      JINN_REPO_LIVE_ISSUE_RELAY_MAX_SPEC_BYTES,
    );
    const oversized = relayTaskAtCanonicalBytes(
      JINN_REPO_LIVE_ISSUE_RELAY_MAX_SPEC_BYTES + 1,
    );

    expect(JinnRepoTaskSchema.safeParse(exact).success).toBe(true);
    expect(JinnRepoLiveIssueTaskSchema.safeParse(exact).success).toBe(true);
    expect(JinnRepoTaskSchema.safeParse(oversized).success).toBe(false);
    expect(JinnRepoLiveIssueTaskSchema.safeParse(oversized).success).toBe(false);
    expect(JinnRepoTaskSchema.safeParse({
      ...oversized,
      problem_statement:
        'x'.repeat(JINN_REPO_LIVE_ISSUE_RELAY_MAX_SPEC_BYTES + 1),
      relay: undefined,
    }).success).toBe(true);
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
    verificationProfile: 'jinn-mono.v1',
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

  it('rejects a Relay capsule on the isolated Autopilot-session branch', () => {
    expect(JinnRepoTaskSchema.safeParse({ ...valid, relay: {} }).success)
      .toBe(false);
  });

  it('accepts a generic safe GitHub repository and lowercase profile binding', () => {
    const session = valid.session as Record<string, unknown>;
    const generic = {
      ...valid,
      repo: 'example-org/example_repo',
      language: 'rust',
      verificationProfile: 'cargo-nextest.v1',
      session: {
        ...session,
        repository: 'example-org/example_repo',
        language: 'rust',
        verificationProfile: 'cargo-nextest.v1',
      },
    };

    expect(JinnRepoTaskSchema.parse(generic)).toEqual(generic);
  });

  it.each([
    ' leading/repo',
    'owner/repo ',
    'https://github.com/owner/repo',
    'owner//repo',
    'owner/../repo',
    '../owner/repo',
    'owner/repo.git',
    'owner/repo/extra',
  ])('rejects unsafe Autopilot repository slug %s', (repo) => {
    const session = valid.session as Record<string, unknown>;
    expect(JinnRepoTaskSchema.safeParse({
      ...valid,
      repo,
      verificationProfile: 'jinn-mono.v1',
      session: {
        ...session,
        repository: repo,
        language: 'typescript',
        verificationProfile: 'jinn-mono.v1',
      },
    }).success).toBe(false);
  });

  it.each([
    ['language', 'TypeScript'],
    ['language', 'type script'],
    ['language', '../typescript'],
    ['verificationProfile', 'Jinn-Mono.v1'],
    ['verificationProfile', 'jinn mono.v1'],
    ['verificationProfile', '../jinn-mono.v1'],
  ] as const)('rejects unsafe lowercase token %s=%s', (field, value) => {
    const session = valid.session as Record<string, unknown>;
    expect(JinnRepoTaskSchema.safeParse({
      ...valid,
      language: field === 'language' ? value : 'typescript',
      verificationProfile:
        field === 'verificationProfile' ? value : 'jinn-mono.v1',
      session: {
        ...session,
        language: field === 'language' ? value : 'typescript',
        verificationProfile:
          field === 'verificationProfile' ? value : 'jinn-mono.v1',
      },
    }).success).toBe(false);
  });

  it.each([
    ['repo', 'other/repo'],
    ['language', 'rust'],
    ['verificationProfile', 'cargo.v1'],
  ] as const)('rejects outer/inner %s mismatch', (field, inner) => {
    const session = valid.session as Record<string, unknown>;
    expect(JinnRepoTaskSchema.safeParse({
      ...valid,
      verificationProfile: 'jinn-mono.v1',
      session: {
        ...session,
        language: 'typescript',
        verificationProfile: 'jinn-mono.v1',
        [field === 'repo' ? 'repository' : field]: inner,
      },
    }).success).toBe(false);
  });

  it.each([
    ['repo', 'other/repo'],
    ['language', 'rust'],
    ['verificationProfile', 'cargo.v1'],
  ] as const)('rejects direct-branch outer/inner %s mismatch', (
    field,
    inner,
  ) => {
    const session = valid.session as Record<string, unknown>;
    expect(JinnRepoAutopilotSessionTaskSchema.safeParse({
      ...valid,
      session: {
        ...session,
        [field === 'repo' ? 'repository' : field]: inner,
      },
    }).success).toBe(false);
  });
});

describe('JinnRepoTaskSchema (SDK) — legacy profile isolation', () => {
  it('keeps merged-pr and live-issue mono/TypeScript-only and rejects verificationProfile', () => {
    const merged = {
      schemaVersion: 'jinn-repo.v1',
      instance_id: 'Jinn-Network__mono-1042',
      repo: 'Jinn-Network/mono',
      base_commit: 'a'.repeat(40),
      merged_pr: 1042,
      language: 'typescript',
      problem_statement: 'p',
      test_files: ['t.test.ts'],
      test_cmd: 'yarn vitest run t.test.ts',
    };
    const live = {
      schemaVersion: 'jinn-repo.v1',
      source: 'live-issue',
      instance_id: 'Jinn-Network__mono-1889',
      repo: 'Jinn-Network/mono',
      base_commit: 'a'.repeat(40),
      language: 'typescript',
      problem_statement: 'p',
      issue_number: 1889,
    };
    for (const value of [merged, live]) {
      expect(JinnRepoTaskSchema.safeParse({
        ...value,
        verificationProfile: 'jinn-mono.v1',
      }).success).toBe(false);
      expect(JinnRepoTaskSchema.safeParse({
        ...value,
        repo: 'other/repo',
      }).success).toBe(false);
      expect(JinnRepoTaskSchema.safeParse({
        ...value,
        language: 'rust',
      }).success).toBe(false);
    }
  });
});
