import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distilFeedbackPathFromEnv, readDistilFeedback, recordDistilFeedback } from '../src/distil-feedback.js';

describe('local distil feedback ledger', () => {
  it('appends feedback as JSONL records', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jinn-distil-feedback-')), 'feedback.jsonl');

    const record = recordDistilFeedback({
      skillName: 'pytest-setup',
      verdict: 'helped',
      sessionId: 'sess-1',
      notes: 'Kept the command sequence short.',
      acceptedChanges: ['Preserve the pytest install check.'],
      recordedAt: '2026-07-09T00:00:00.000Z',
    }, { path });

    expect(record).toMatchObject({
      schema: 'jinn.distil.feedback.v1',
      skillName: 'pytest-setup',
      verdict: 'helped',
    });
    expect(readDistilFeedback(path)).toEqual([record]);
  });

  it('supports an env override path', () => {
    expect(distilFeedbackPathFromEnv({ JINN_LAYER_DISTIL_FEEDBACK_PATH: '/tmp/feedback.jsonl' })).toBe('/tmp/feedback.jsonl');
  });
});
