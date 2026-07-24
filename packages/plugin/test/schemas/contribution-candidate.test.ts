import { describe, expect, it } from 'vitest';
import * as plugin from '../../src/index.js';

const valid = {
  schemaVersion: 'jinn.contribution-candidate.v1',
  sourceId: 'episode-1',
  repositorySlug: 'Jinn-Network/mono',
  baseCommit: '0123456789abcdef',
  acceptedDiff: 'diff --git a/a.ts b/a.ts\n+fixed\n',
  testRuns: [
    { command: 'yarn test', exitCode: 0, at: '2026-07-15T12:00:00.000Z' },
  ],
  intermediateFailureDiffs: ['diff --git a/a.ts b/a.ts\n+still broken\n'],
  skillEvents: [{ skillRef: 'skills/tdd@1', action: 'invoked' }],
  publishMinedTasksConsent: false,
  createdAt: '2026-07-15T12:01:00.000Z',
} as const;

describe('ContributionCandidateV1Schema', () => {
  it('is exported and parses the complete strict local-recording contract', () => {
    const schema = (plugin as typeof plugin & {
      ContributionCandidateV1Schema?: { parse(value: unknown): unknown };
    }).ContributionCandidateV1Schema;

    expect(schema).toBeDefined();
    if (!schema) return;
    expect(schema.parse(valid)).toEqual(valid);
  });

  it('allows structured test runs to be unavailable as an empty array', () => {
    const schema = (plugin as typeof plugin & {
      ContributionCandidateV1Schema?: { parse(value: unknown): unknown };
    }).ContributionCandidateV1Schema;
    if (!schema) return;

    expect(schema.parse({ ...valid, testRuns: [] })).toEqual({ ...valid, testRuns: [] });
  });

  it('rejects unknown candidate and nested event fields', () => {
    const schema = (plugin as typeof plugin & {
      ContributionCandidateV1Schema?: { parse(value: unknown): unknown };
    }).ContributionCandidateV1Schema;
    if (!schema) return;

    expect(() => schema.parse({ ...valid, rawTrajectory: 'private' })).toThrow();
    expect(() => schema.parse({
      ...valid,
      skillEvents: [{ ...valid.skillEvents[0], unknown: true }],
    })).toThrow();
  });

  it('does not synthesize createdAt or optional arrays', () => {
    const schema = (plugin as typeof plugin & {
      ContributionCandidateV1Schema?: { parse(value: unknown): unknown };
    }).ContributionCandidateV1Schema;
    if (!schema) return;

    const { createdAt: _createdAt, ...withoutCreatedAt } = valid;
    expect(() => schema.parse(withoutCreatedAt)).toThrow();
    const { testRuns: _testRuns, ...withoutTestRuns } = valid;
    expect(() => schema.parse(withoutTestRuns)).toThrow();
  });
});
