/**
 * Prompt template for claude-mcp-prediction sessions.
 *
 * Kept intentionally static (no branching) so the isolation test has
 * deterministic behavior to assert against.
 */

import type { PredictionV0Task } from '../../../types/prediction.js';

function fmtOperator(op: 'GT' | 'GTE' | 'LT' | 'LTE'): string {
  switch (op) {
    case 'GT':  return '>';
    case 'GTE': return '≥';
    case 'LT':  return '<';
    case 'LTE': return '≤';
  }
}

export function buildSessionPrompt(task: PredictionV0Task, sessionId: string): string {
  const { oracle, question } = task.spec;
  const { window } = task;

  let questionLine: string;
  if (question.kind === 'threshold') {
    questionLine = `Will ${oracle.feedDescription} be ${fmtOperator(question.operator)} ${question.threshold} at resolveTs (${new Date(question.resolveTs).toISOString()})?`;
  } else {
    questionLine = `Will ${oracle.feedDescription} be in [${question.lowerBound}, ${question.upperBound}) at resolveTs (${new Date(question.resolveTs).toISOString()})?`;
  }

  return [
    `Session: ${sessionId}`,
    '',
    'You are evaluating a Jinn prediction Task. Decide the probability that the outcome will be YES and submit it via the submit_prediction tool.',
    '',
    `Question: ${questionLine}`,
    '',
    `Task window:  [${new Date(window.startTs).toISOString()}, ${new Date(window.endTs).toISOString()}]`,
    `Resolution at:  ${new Date(question.resolveTs).toISOString()}`,
    `Oracle:         Chainlink ${oracle.feedDescription} on ${oracle.venue}`,
    '',
    'You have exactly two tools:',
    '',
    '  1. read_chainlink_price — returns the current oracle price and round metadata. Call this once.',
    '  2. submit_prediction    — submit your final probability in [0, 1] with a brief rationale.',
    '                            Calling this ends the session. Do not call any other tool afterward.',
    '',
    'Approach:',
    '  1. Call read_chainlink_price to see the current price.',
    '  2. Reason briefly about whether the outcome (YES/NO) is likely given the current price and time remaining.',
    '  3. Call submit_prediction with your probability (a decimal between 0 and 1) and a concise rationale.',
    '',
    'Guidelines:',
    '  - Be honest. A probability of 0.5 means genuine uncertainty.',
    '  - Do not call submit_prediction before calling read_chainlink_price.',
    '  - The rationale should reference the price you read.',
    '  - Keep the rationale under 2000 characters.',
  ].join('\n');
}
