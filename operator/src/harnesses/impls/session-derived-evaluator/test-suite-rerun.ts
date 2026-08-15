import type { EvaluationSignal } from './signals.js';

export interface TestSuiteRunResult {
  passed: boolean;
  log?: string;
}

export interface TestSuiteRerunInput {
  testSuiteRef?: string | null;
  candidatePatch?: string | null;
  runTests: (input: { testSuiteRef: string; candidatePatch: string }) => Promise<TestSuiteRunResult>;
  weight?: number;
}

export async function testSuiteRerunSignal(input: TestSuiteRerunInput): Promise<EvaluationSignal> {
  const weight = input.weight ?? 0.5;
  if (!input.testSuiteRef || !input.candidatePatch) {
    return { present: false, score: 0, weight, reasoning: 'test suite or candidate patch missing' };
  }
  const result = await input.runTests({
    testSuiteRef: input.testSuiteRef,
    candidatePatch: input.candidatePatch,
  });
  return {
    present: true,
    score: result.passed ? 1 : 0,
    weight,
    ...(result.log ? { reasoning: result.log } : {}),
  };
}
