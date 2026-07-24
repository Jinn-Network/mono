import { describe, it, expect } from 'vitest';
import {
  JinnRepoAutopilotSolutionPayloadSchema,
  JinnRepoAutopilotVerdictPayloadSchema,
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
