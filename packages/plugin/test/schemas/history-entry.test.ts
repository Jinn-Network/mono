import { describe, expect, it } from 'vitest';
import { HistoryEntrySchema } from '../../src/schemas/history-entry.js';

describe('HistoryEntrySchema', () => {
  it('parses a valid history row', () => {
    const parsed = HistoryEntrySchema.parse({
      sessionId: 'sess-1',
      taskSummary: 'Fix a failing test',
      knowledgeSurfaced: 3,
      knowledgeUsed: 1,
      captureStatus: 'captured',
      eligibility: { eligible: false, reason: 'stage-1-stub', checkedAt: '2026-07-14T00:00:00.000Z' },
      contributionState: { status: 'queued' },
      distilledSkillRefs: [],
    });
    expect(parsed.captureStatus).toBe('captured');
  });

  it('rejects an unknown contributionState.status', () => {
    expect(() =>
      HistoryEntrySchema.parse({
        sessionId: 'sess-1',
        taskSummary: 'x',
        knowledgeSurfaced: 0,
        knowledgeUsed: 0,
        captureStatus: 'not-captured',
        eligibility: { eligible: false, reason: 'r', checkedAt: '2026-07-14T00:00:00.000Z' },
        contributionState: { status: 'bogus' },
        distilledSkillRefs: [],
      }),
    ).toThrow();
  });
});
