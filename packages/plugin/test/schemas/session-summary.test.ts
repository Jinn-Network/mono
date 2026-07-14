import { describe, expect, it } from 'vitest';
import { SessionSummarySchema } from '../../src/schemas/session-summary.js';

describe('SessionSummarySchema', () => {
  it('parses a nothing-found summary', () => {
    const parsed = SessionSummarySchema.parse({
      episodeRef: 'ep-1',
      surfacedHits: [],
      fetchedHits: [],
      installedSkillRefs: [],
      eligibility: { eligible: false, reason: 'stage-1-stub', checkedAt: '2026-07-14T00:00:00.000Z' },
      nothingFound: true,
    });
    expect(parsed.nothingFound).toBe(true);
  });

  it('parses a summary with surfaced hits', () => {
    const parsed = SessionSummarySchema.parse({
      episodeRef: 'ep-1',
      surfacedHits: [{ ref: 'x', kind: 'seed' }],
      fetchedHits: [],
      installedSkillRefs: ['org/skill@1.0.0'],
      eligibility: { eligible: false, reason: 'stage-1-stub', checkedAt: '2026-07-14T00:00:00.000Z' },
      nothingFound: false,
    });
    expect(parsed.surfacedHits).toHaveLength(1);
  });
});
