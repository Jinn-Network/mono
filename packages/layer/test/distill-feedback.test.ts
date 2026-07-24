import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distillFeedbackPathFromEnv, readDistillFeedback, recordDistillFeedback } from '../src/distill-feedback.js';

describe('local distill feedback ledger', () => {
  it('appends feedback as JSONL records', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jinn-distill-feedback-')), 'feedback.jsonl');

    const record = recordDistillFeedback({
      skillName: 'pytest-setup',
      verdict: 'helped',
      sessionId: 'sess-1',
      notes: 'Kept the command sequence short.',
      acceptedChanges: ['Preserve the pytest install check.'],
      recordedAt: '2026-07-09T00:00:00.000Z',
    }, { path });

    expect(record).toMatchObject({
      schema: 'jinn.distill.feedback.v1',
      skillName: 'pytest-setup',
      verdict: 'helped',
    });
    expect(readDistillFeedback(path)).toEqual([record]);
  });

  it('supports an env override path', () => {
    expect(distillFeedbackPathFromEnv({ JINN_LAYER_DISTILL_FEEDBACK_PATH: '/tmp/feedback.jsonl' })).toBe('/tmp/feedback.jsonl');
  });
});
