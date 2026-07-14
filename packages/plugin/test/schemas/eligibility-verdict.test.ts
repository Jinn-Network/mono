import { describe, expect, it } from 'vitest';
import { EligibilityVerdictSchema } from '../../src/schemas/eligibility-verdict.js';

describe('EligibilityVerdictSchema', () => {
  it('parses a valid verdict', () => {
    const parsed = EligibilityVerdictSchema.parse({
      eligible: false,
      reason: 'stage-1-stub',
      checkedAt: '2026-07-14T00:00:00.000Z',
    });
    expect(parsed.eligible).toBe(false);
  });

  it('rejects a missing reason', () => {
    expect(() =>
      EligibilityVerdictSchema.parse({ eligible: true, checkedAt: '2026-07-14T00:00:00.000Z' }),
    ).toThrow();
  });
});
