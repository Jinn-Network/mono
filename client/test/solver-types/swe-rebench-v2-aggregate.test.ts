import { describe, it, expect } from 'vitest';
import { computeNetworkResult } from '../../src/solver-types/_swe-rebench-v2-aggregate.js';

interface VerdictRow { score: 0 | 1; language: string; complexity: number; }

describe('computeNetworkResult', () => {
  it('mean = arithmetic mean of Verdict.score', () => {
    const verdicts: VerdictRow[] = [
      { score: 1, language: 'python', complexity: 1 },
      { score: 0, language: 'python', complexity: 1 },
      { score: 1, language: 'go', complexity: 1 },
    ];
    const result = computeNetworkResult({ verdicts, windowStart: '2026-04', windowEnd: '2026-05' });
    expect(result.meanResolved).toBeCloseTo(2 / 3, 5);
  });

  it('complexityWeighted weights by complexity proxy', () => {
    const verdicts: VerdictRow[] = [
      { score: 1, language: 'python', complexity: 100 },
      { score: 0, language: 'python', complexity: 1 },
    ];
    const result = computeNetworkResult({ verdicts, windowStart: '2026-04', windowEnd: '2026-05' });
    expect(result.complexityWeighted).toBeCloseTo(100 / 101, 5);
  });

  it('byLanguage stratifies correctly', () => {
    const verdicts: VerdictRow[] = [
      { score: 1, language: 'python', complexity: 1 },
      { score: 0, language: 'python', complexity: 1 },
      { score: 1, language: 'go', complexity: 1 },
    ];
    const result = computeNetworkResult({ verdicts, windowStart: '2026-04', windowEnd: '2026-05' });
    expect(result.byLanguage.python).toEqual({ resolved: 0.5, n: 2 });
    expect(result.byLanguage.go).toEqual({ resolved: 1, n: 1 });
  });

  it('returns zero rates on empty verdict list', () => {
    const result = computeNetworkResult({ verdicts: [], windowStart: '2026-04', windowEnd: '2026-05' });
    expect(result.meanResolved).toBe(0);
    expect(result.verdictCount).toBe(0);
  });
});
