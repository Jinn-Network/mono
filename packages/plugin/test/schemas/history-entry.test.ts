import { describe, expect, it } from 'vitest';
import { HistoryEntrySchema } from '../../src/schemas/history-entry.js';

describe('HistoryEntrySchema', () => {
  it('parses a valid history row', () => {
    const parsed = HistoryEntrySchema.parse({
      sessionId: 'sess-1',
      capturedAt: '2026-07-14T00:00:00.000Z',
      taskSummary: 'Fix a failing test',
      knowledgeSurfaced: 3,
      knowledgeUsed: 1,
      captureStatus: 'captured',
      eligibility: { eligible: false, reason: 'stage-1-stub', checkedAt: '2026-07-14T00:00:00.000Z' },
      contributionState: { status: 'queued' },
      distilledSkills: [{ ref: 'local-skill:retry', state: 'installed' }],
    });
    expect(parsed.captureStatus).toBe('captured');
  });

  it('rejects an unknown contributionState.status', () => {
    expect(() =>
      HistoryEntrySchema.parse({
        sessionId: 'sess-1',
        capturedAt: '2026-07-14T00:00:00.000Z',
        taskSummary: 'x',
        knowledgeSurfaced: 0,
        knowledgeUsed: 0,
        captureStatus: 'not-captured',
        eligibility: { eligible: false, reason: 'r', checkedAt: '2026-07-14T00:00:00.000Z' },
        contributionState: { status: 'bogus' },
        distilledSkills: [],
      }),
    ).toThrow();
  });

  it('represents unavailable facts explicitly instead of manufacturing empty values', () => {
    const parsed = HistoryEntrySchema.parse({
      sessionId: 'legacy-session',
      capturedAt: '2026-07-13T00:00:00.000Z',
      taskSummary: 'Legacy session',
      knowledgeSurfaced: null,
      knowledgeUsed: null,
      captureStatus: 'captured',
      eligibility: null,
      contributionState: { status: 'unavailable' },
      distilledSkills: null,
    });
    expect(parsed.knowledgeSurfaced).toBeNull();
    expect(parsed.eligibility).toBeNull();
    expect(parsed.distilledSkills).toBeNull();
  });
});
