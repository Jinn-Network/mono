import { describe, expect, it } from 'vitest';
import { SessionSummarySchema } from '../../src/schemas/session-summary.js';

describe('SessionSummarySchema', () => {
  it('parses a nothing-found summary', () => {
    const parsed = SessionSummarySchema.parse({
      episodeRef: 'ep-1',
      eligibility: { eligible: false, reason: 'stage-1-stub', checkedAt: '2026-07-14T00:00:00.000Z' },
      nothingFound: true,
    });
    expect(parsed.nothingFound).toBe(true);
    // Evidence-first fields default when the caller omits them.
    expect(parsed.searchedTerms).toEqual([]);
    expect(parsed.providedPackets).toEqual([]);
  });

  it('parses a summary carrying searchedTerms and providedPackets (rescope §3.6)', () => {
    const parsed = SessionSummarySchema.parse({
      episodeRef: 'ep-1',
      searchedTerms: ['dashboard', 'vitest'],
      providedPackets: [{ ref: 'bafyRef1', title: 'Fix the dashboard flake' }],
      eligibility: { eligible: false, reason: 'stage-1-stub', checkedAt: '2026-07-14T00:00:00.000Z' },
      nothingFound: false,
    });
    expect(parsed.searchedTerms).toEqual(['dashboard', 'vitest']);
    expect(parsed.providedPackets).toEqual([{ ref: 'bafyRef1', title: 'Fix the dashboard flake' }]);
  });

  it('rejects an unknown top-level field (strict)', () => {
    expect(() => SessionSummarySchema.parse({
      episodeRef: 'ep-1',
      eligibility: { eligible: false, reason: 'x', checkedAt: '2026-07-14T00:00:00.000Z' },
      nothingFound: true,
      knowledgeSurfaced: 0,
    })).toThrow();
  });

  it('rejects the pre-rescope legacy fields (dropped by R3+R5)', () => {
    expect(() => SessionSummarySchema.parse({
      episodeRef: 'ep-1',
      eligibility: { eligible: false, reason: 'x', checkedAt: '2026-07-14T00:00:00.000Z' },
      nothingFound: true,
      surfacedRefs: [],
      fetchedRefs: [],
      surfacedHits: [],
      fetchedHits: [],
      installedSkillRefs: [],
    })).toThrow();
  });
});
