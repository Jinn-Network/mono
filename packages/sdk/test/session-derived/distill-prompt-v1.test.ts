import { describe, expect, it } from 'vitest';
import {
  SESSION_DERIVED_DISTILL_PROMPT_V1,
  SESSION_DERIVED_DISTILL_PROMPT_V1_SHA256,
} from '../../src/session-derived/distill-prompt-v1.js';

describe('SESSION_DERIVED_DISTILL_PROMPT_V1', () => {
  it('is non-empty and exposes a sha256 digest', () => {
    expect(SESSION_DERIVED_DISTILL_PROMPT_V1.length).toBeGreaterThan(100);
    expect(SESSION_DERIVED_DISTILL_PROMPT_V1_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('documents that the reference prompt is intentionally non-canonical', () => {
    expect(SESSION_DERIVED_DISTILL_PROMPT_V1).toContain('not protocol canon');
    expect(SESSION_DERIVED_DISTILL_PROMPT_V1).toContain('Launchers may substitute');
  });
});
