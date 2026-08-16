import { describe, expect, it } from 'vitest';
import {
  composite,
  llmJudgeSignal,
  structuralSimilaritySignal,
  testSuiteRerunSignal,
} from '../../../../src/harnesses/impls/session-derived-evaluator/index.js';

describe('session-derived evaluator signals', () => {
  it('renormalizes composite score across present signals', () => {
    const result = composite([
      { present: false, score: 0, weight: 0.5 },
      { present: false, score: 0, weight: 0.3 },
      { present: true, score: 0.7, weight: 0.2 },
    ]);
    expect(result.compositeScore).toBeCloseTo(0.7);
    expect(result.presentWeight).toBe(0.2);
    expect(result.signalsPresent).toBe(1);
  });

  it('scores structural similarity from changed patch lines', () => {
    const referencePatch = 'diff --git a/a b/a\n-foo\n+bar\n';
    expect(structuralSimilaritySignal({ candidatePatch: referencePatch, referencePatch }).score).toBe(1);
    expect(structuralSimilaritySignal({ candidatePatch: '-foo\n+baz\n', referencePatch }).score).toBeGreaterThan(0);
  });

  it('maps test-suite results to pass/fail signal scores', async () => {
    await expect(testSuiteRerunSignal({
      testSuiteRef: 'bafytests',
      candidatePatch: 'diff --git a/a b/a\n',
      runTests: async () => ({ passed: true }),
    })).resolves.toMatchObject({ present: true, score: 1, weight: 0.5 });
  });

  it('uses an injected LLM judge and clamps scores', async () => {
    await expect(llmJudgeSignal({
      problemStatement: 'Fix parser',
      candidatePatch: 'diff',
      judge: async () => ({ score: 1.3, reasoning: 'good' }),
    })).resolves.toMatchObject({ present: true, score: 1, reasoning: 'good' });
  });
});
