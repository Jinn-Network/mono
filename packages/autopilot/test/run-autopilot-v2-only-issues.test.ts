import { describe, expect, it } from 'vitest';
import { parseOnlyIssuesAllowlist } from '../scripts/run-autopilot-v2.js';

// jinn-mono#1883: `JINN_AUTOPILOT_ONLY_ISSUES` is a canary safety knob that
// restricts active-mode NEW-WORK claim scheduling to a fixed set of issue
// numbers, so a single disposable canary issue can be exercised safely
// alongside another agent's live work on the same board (runbook §8).
describe('parseOnlyIssuesAllowlist (#1883)', () => {
  it('parses a single valid issue number', () => {
    expect(parseOnlyIssuesAllowlist('1896')).toEqual(new Set([1896]));
  });

  it('parses multiple comma-separated issue numbers', () => {
    expect(parseOnlyIssuesAllowlist('1896,1902')).toEqual(new Set([1896, 1902]));
  });

  it('tolerates whitespace around each segment', () => {
    expect(parseOnlyIssuesAllowlist(' 1896 , 1902 ')).toEqual(new Set([1896, 1902]));
  });

  it('ignores empty segments from stray commas', () => {
    expect(parseOnlyIssuesAllowlist('1896,,1902,')).toEqual(new Set([1896, 1902]));
  });

  it('returns undefined (unrestricted) when unset', () => {
    expect(parseOnlyIssuesAllowlist(undefined)).toBeUndefined();
  });

  it('returns undefined (unrestricted) for an explicitly-set empty string', () => {
    expect(parseOnlyIssuesAllowlist('')).toBeUndefined();
  });

  it('returns undefined (unrestricted) for a whitespace/comma-only string', () => {
    expect(parseOnlyIssuesAllowlist(' , , ')).toBeUndefined();
  });

  it.each([
    ['abc', 'non-numeric'],
    ['12.3', 'decimal'],
    ['-5', 'negative'],
    ['0', 'zero'],
    ['01', 'leading zero'],
    ['1896, abc', 'malformed alongside a valid entry'],
  ])('throws for malformed input %s (%s)', (raw) => {
    expect(() => parseOnlyIssuesAllowlist(raw)).toThrow(
      'JINN_AUTOPILOT_ONLY_ISSUES must be a comma-separated list of positive issue numbers',
    );
  });
});
