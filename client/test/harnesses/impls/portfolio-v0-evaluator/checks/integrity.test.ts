import { describe, it, expect } from 'vitest';
import { checkWindowBounds } from '../../../../../src/harnesses/impls/portfolio-v0-evaluator/checks/integrity.js';

// ── checkWindowBounds ─────────────────────────────────────────────────────────

describe('checkWindowBounds', () => {
  const startTs = 1000;
  const endTs = 2000;

  it('returns PASS when both bounds satisfied', () => {
    const check = checkWindowBounds(1000, 2000, startTs, endTs);
    expect(check.name).toBe('integrity.window_bounds');
    expect(check.status).toBe('PASS');
  });

  it('returns PASS when pre > startTs and post > endTs', () => {
    const check = checkWindowBounds(1100, 2100, startTs, endTs);
    expect(check.status).toBe('PASS');
  });

  it('returns FAIL when preCapturedAt < startTs', () => {
    const check = checkWindowBounds(900, 2000, startTs, endTs);
    expect(check.name).toBe('integrity.window_bounds');
    expect(check.status).toBe('FAIL');
    expect(String(check.detail)).toContain('pre.capturedAt');
  });

  it('returns FAIL when postCapturedAt < endTs', () => {
    const check = checkWindowBounds(1000, 1999, startTs, endTs);
    expect(check.status).toBe('FAIL');
    expect(String(check.detail)).toContain('post.capturedAt');
  });

  it('returns FAIL when both bounds violated', () => {
    const check = checkWindowBounds(500, 1500, startTs, endTs);
    expect(check.status).toBe('FAIL');
    const detail = String(check.detail);
    expect(detail).toContain('pre.capturedAt');
    expect(detail).toContain('post.capturedAt');
  });

  it('returns PASS for exact boundary values', () => {
    const check = checkWindowBounds(startTs, endTs, startTs, endTs);
    expect(check.status).toBe('PASS');
  });
});
