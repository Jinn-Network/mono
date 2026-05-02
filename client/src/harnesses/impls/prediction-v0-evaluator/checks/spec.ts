import type { Check } from '../types.js';
import type { PredictionV0Task } from '../../../../types/prediction.js';

export function checkQuestionKindSupported(
  question: PredictionV0Task['spec']['question'] | { kind: string },
): Check {
  if (question.kind === 'threshold') {
    const op = (question as any).operator;
    const supported = ['GT', 'GTE', 'LT', 'LTE'].includes(op);
    return {
      name: 'spec.question_kind_supported',
      status: supported ? 'PASS' : 'FAIL',
      detail: supported ? undefined : { operator: op },
    };
  }
  if (question.kind === 'range') {
    return { name: 'spec.question_kind_supported', status: 'PASS' };
  }
  return {
    name: 'spec.question_kind_supported',
    status: 'FAIL',
    detail: { kind: question.kind },
  };
}
