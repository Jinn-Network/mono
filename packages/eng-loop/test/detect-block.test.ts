import { describe, it, expect } from 'vitest';
import { classifyRun } from '../src/pressure-test/detect-block.js';

describe('classifyRun', () => {
  it('returns completed when the deliverable was produced', () => {
    expect(classifyRun('any text', { producedDeliverable: true })).toBe('completed');
  });

  it('returns interactive-block when no deliverable and the text ends asking the user', () => {
    const text = 'I have drafted the design.\n\nWhich option would you like — A or B?';
    expect(classifyRun(text, { producedDeliverable: false })).toBe('interactive-block');
  });

  it('returns interactive-block on a "waiting for your approval" tail', () => {
    const text = 'Design presented above.\n\nWaiting for your approval before continuing.';
    expect(classifyRun(text, { producedDeliverable: false })).toBe('interactive-block');
  });

  it('returns error when no deliverable and no interactive tail', () => {
    const text = 'Traceback: something exploded and the run ended.';
    expect(classifyRun(text, { producedDeliverable: false })).toBe('error');
  });
});
