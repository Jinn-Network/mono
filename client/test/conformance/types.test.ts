import { describe, it, expect } from 'vitest';
import {
  summarize,
  overallFromChecks,
  type CheckResult,
} from '../../src/conformance/types.js';

describe('summarize', () => {
  it('counts pass/fail/skip correctly', () => {
    const checks: CheckResult[] = [
      { id: 'a.b', layer: 1, passed: true },
      { id: 'a.c', layer: 1, passed: false, detail: 'bad' },
      { id: 'd.e', layer: 2, passed: true, skipped: true },
    ];
    const s = summarize(checks);
    expect(s).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
  });
});

describe('overallFromChecks', () => {
  it('returns PASS when no failures', () => {
    expect(overallFromChecks([{ id: 'x', layer: 1, passed: true }])).toBe('PASS');
  });
  it('returns FAIL when any Layer 1 check fails', () => {
    expect(
      overallFromChecks([
        { id: 'x', layer: 1, passed: true },
        { id: 'y', layer: 1, passed: false },
      ]),
    ).toBe('FAIL');
  });
  it('returns FAIL when any Layer 2 check fails', () => {
    expect(
      overallFromChecks([
        { id: 'x', layer: 1, passed: true },
        { id: 'y', layer: 2, passed: false },
      ]),
    ).toBe('FAIL');
  });
  it('returns PASS when only skipped checks', () => {
    expect(
      overallFromChecks([
        { id: 'x', layer: 1, passed: true },
        { id: 'y', layer: 2, passed: true, skipped: true },
      ]),
    ).toBe('PASS');
  });
});
