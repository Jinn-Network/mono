import { describe, it, expect } from 'vitest';
import {
  JinnRepoSolutionPayloadSchema,
  JinnRepoVerdictPayloadSchema,
} from '../src/payloads/jinn-repo.js';

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
