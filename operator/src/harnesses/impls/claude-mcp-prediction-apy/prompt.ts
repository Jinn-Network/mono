/**
 * Prompt template for claude-mcp-prediction-apy sessions.
 *
 * Kept intentionally static (no branching) so tests can snapshot deterministically.
 */

import type { PredictionApyV0Task } from '../../../types/prediction-apy.js';

export function buildSessionPrompt(task: PredictionApyV0Task, sessionId: string): string {
  const { oracle, metric, question } = task.spec;
  const { window } = task;

  return [
    `Session: ${sessionId}`,
    '',
    'You are evaluating a Jinn prediction.apy.v0 task. Predict the time-weighted-average (TWA) supply APY for the reserve, expressed as an integer in basis points (bps), and submit it via submit_apy_prediction.',
    '',
    'Ground truth (for scoring) is computed at resolution as follows:',
    '  - Take sampleCount evenly spaced timestamps in [resolveTs - twaWindowSeconds, resolveTs].',
    '  - At each timestamp, read Aave Pool.getReserveData(reserve).currentLiquidityRate (ray).',
    '  - Convert each sample to supply APY and take the arithmetic mean; round to integer bps.',
    '',
    `Reserve:        ${oracle.reserveSymbol} (${oracle.reserve})`,
    `Pool:           ${oracle.pool}`,
    `Venue:          ${oracle.venue}`,
    `TWA window:     ${metric.twaWindowSeconds}s with ${metric.sampleCount} samples`,
    `Tolerance:      ±${metric.toleranceBps} bps (for scoring)`,
    '',
    `Task window:  [${new Date(window.startTs).toISOString()}, ${new Date(window.endTs).toISOString()}]`,
    `Resolve at:     ${new Date(question.resolveTs).toISOString()}`,
    '',
    'You have exactly two tools:',
    '',
    '  1. read_aave_reserve — returns the current on-chain supply APY in bps from the reserve (spot, not the full TWA). Call this once.',
    '  2. submit_apy_prediction — submit your final predicted bps (non-negative integer) with a brief rationale.',
    '                            Calling this ends the session. Do not call any other tool afterward.',
    '',
    'Approach:',
    '  1. Call read_aave_reserve to see the current supply APY in bps.',
    '  2. Reason briefly about what TWA APY at resolveTs might be given the spot reading and time to resolution.',
    '  3. Call submit_apy_prediction with your integer predictedBps and a concise rationale.',
    '',
    'Guidelines:',
    '  - predictedBps must be a whole number (basis points). Example: 350 means 3.50% APY.',
    '  - Do not call submit_apy_prediction before calling read_aave_reserve.',
    '  - The rationale should reference the apyBps you read.',
    '  - Keep the rationale under 2000 characters.',
  ].join('\n');
}
