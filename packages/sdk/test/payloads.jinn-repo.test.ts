import { describe, it, expect } from 'vitest';
import {
  JinnRepoApplicationSolutionPayloadSchema,
  JinnRepoApplicationVerdictPayloadSchema,
  JinnRepoAutopilotSolutionPayloadSchema,
  JinnRepoAutopilotVerdictPayloadSchema,
  JinnRepoIssueRelayAdoptionPayloadSchema,
  JinnRepoIssueRelayVerdictPayloadSchema,
  JinnRepoSolutionPayloadSchema,
  JinnRepoVerdictPayloadSchema,
  JinnRepoVerdictV2PayloadSchema,
} from '../src/payloads/jinn-repo.js';
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

describe('JinnRepoSolutionPayloadSchema', () => {
  it('accepts a valid Solution', () => {
    const sol = {
      schemaVersion: 'jinn-repo-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-hello\n+world\n',
    };
    expect(() => JinnRepoSolutionPayloadSchema.parse(sol)).not.toThrow();
  });

  it('rejects an empty patch', () => {
    const sol = { schemaVersion: 'jinn-repo-solution.v1', patch: '' };
    expect(() => JinnRepoSolutionPayloadSchema.parse(sol)).toThrow();
  });
});

describe('jinn-repo opaque application payloads', () => {
  const application = { id: 'autopilot.issue-relay', version: 'v2' };

  it('transports creator-owned Solution data without interpreting it', () => {
    const value = {
      schemaVersion: 'jinn-repo-application-payload.v1',
      application,
      role: 'solution',
      payload: { schemaVersion: 'creator-solution.v7', patch: 'opaque' },
    };
    expect(JinnRepoApplicationSolutionPayloadSchema.parse(value)).toEqual(value);
    expect(JinnRepoSolutionPayloadSchema.parse(value)).toEqual(value);
  });

  it('requires only a generic settlement projection on application verdicts', () => {
    const value = {
      schemaVersion: 'jinn-repo-application-payload.v1',
      application,
      role: 'verdict',
      projection: 'unresolved',
      payload: { schemaVersion: 'creator-evidence.v99', lanes: ['anything'] },
    };
    expect(JinnRepoApplicationVerdictPayloadSchema.parse(value)).toEqual(value);
    expect(JinnRepoVerdictPayloadSchema.parse(value)).toEqual(value);
    expect(JinnRepoApplicationVerdictPayloadSchema.safeParse({
      ...value,
      projection: undefined,
    }).success).toBe(false);
  });
});

describe('JinnRepoVerdictPayloadSchema', () => {
  it('accepts a valid Verdict', () => {
    const v = {
      schemaVersion: 'jinn-repo-verdict.v1',
      passed: true,
      test_log_excerpt: 'PASS src/foo.test.ts',
    };
    expect(() => JinnRepoVerdictPayloadSchema.parse(v)).not.toThrow();
  });

  it('accepts a Verdict without the optional test_log_excerpt', () => {
    const v = { schemaVersion: 'jinn-repo-verdict.v1', passed: false };
    expect(() => JinnRepoVerdictPayloadSchema.parse(v)).not.toThrow();
  });
});

describe('jinn-repo-verdict.v2 (mechanical, live-issue — issue #1891)', () => {
  const v2 = {
    schemaVersion: 'jinn-repo-verdict.v2' as const,
    passed: false,
    test_log_excerpt: 'typecheck-failed[client]: ...',
    gates: { applies: true, typecheck: false, tests: false },
  };

  it('parses a v2 verdict with gates', () => {
    const parsed = JinnRepoVerdictV2PayloadSchema.parse(v2);
    expect(parsed.gates).toEqual({ applies: true, typecheck: false, tests: false });
  });

  it('accepts a v2 verdict without the optional test_log_excerpt', () => {
    const { test_log_excerpt: _omit, ...rest } = v2;
    expect(() => JinnRepoVerdictV2PayloadSchema.parse(rest)).not.toThrow();
  });

  it('rejects a v2 verdict missing gates', () => {
    const { gates: _omit, ...rest } = v2;
    expect(() => JinnRepoVerdictV2PayloadSchema.parse(rest)).toThrow();
  });

  it('union accepts both v1 and v2', () => {
    const v1 = { schemaVersion: 'jinn-repo-verdict.v1' as const, passed: true };
    expect(JinnRepoVerdictPayloadSchema.parse(v1).schemaVersion).toBe('jinn-repo-verdict.v1');
    expect(JinnRepoVerdictPayloadSchema.parse(v2).schemaVersion).toBe('jinn-repo-verdict.v2');
  });
});

describe('jinn-repo Autopilot session payloads', () => {
  it('accepts mutation results through the additive Solution payload branch', () => {
    for (const name of ['mutation-complete', 'mutation-human']) {
      const value = autopilotFixture(name);
      expect(JinnRepoAutopilotSolutionPayloadSchema.parse(value)).toEqual(value);
      expect(JinnRepoSolutionPayloadSchema.parse(value)).toEqual(value);
    }
  });

  it('accepts review results through the additive Verdict payload branch', () => {
    for (const name of ['review-approve', 'review-request-changes', 'review-human']) {
      const value = autopilotFixture(name);
      expect(JinnRepoAutopilotVerdictPayloadSchema.parse(value)).toEqual(value);
      expect(JinnRepoVerdictPayloadSchema.parse(value)).toEqual(value);
    }
  });

  it('does not make the legacy payload branches strict', () => {
    expect(JinnRepoSolutionPayloadSchema.parse({
      schemaVersion: 'jinn-repo-solution.v1',
      patch: 'diff',
      wrapperMetadata: true,
    })).toEqual({
      schemaVersion: 'jinn-repo-solution.v1',
      patch: 'diff',
    });
  });
});

describe('jinn-repo Issue Relay payloads', () => {
  const correlation = {
    generation: 'R_kgDOExample:42:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    round: 1,
    snapshotDigest: `sha256:${'a'.repeat(64)}`,
    taskId: 'task-42',
    attemptIndex: 0,
    requestId: 'request-42',
    deliveryEnvelopeCid: 'bafyrelay42',
  };

  it('accepts Relay adoption evidence and verdicts through additive payload branches', () => {
    const adoption = {
      schemaVersion: 'jinn-issue-relay-adoption.v1',
      disposition: 'accepted',
      correlation,
      targetRepository: 'Jinn-Network/mono',
      workspaceRepository: 'Jinn-Network/mono',
      issueNumber: 1889,
      prNumber: 42,
      headRef: 'relay/1889',
      inputHead: '1'.repeat(40),
      resultingHead: '2'.repeat(40),
      patchDigest: `sha256:${'b'.repeat(64)}`,
      solutionSafe: `0x${'a'.repeat(40)}`,
      adoptedAt: '2026-07-28T12:00:00.000Z',
    };
    const verdict = {
      schemaVersion: 'jinn-issue-relay-verdict.v1',
      outcome: 'pass',
      correlation,
      evaluatedHead: '2'.repeat(40),
      summary: 'All checks passed.',
      findings: [],
    };
    expect(JinnRepoIssueRelayAdoptionPayloadSchema.parse(adoption)).toEqual(adoption);
    expect(JinnRepoSolutionPayloadSchema.parse(adoption)).toEqual(adoption);
    expect(JinnRepoIssueRelayVerdictPayloadSchema.parse(verdict)).toEqual(verdict);
    expect(JinnRepoVerdictPayloadSchema.parse(verdict)).toEqual(verdict);
  });
});
