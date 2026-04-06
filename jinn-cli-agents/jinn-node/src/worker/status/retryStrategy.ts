/**
 * Retry strategy: logic for requeueing / reclaim timing
 */

import type { FinalStatus } from '../types.js';

// This module is a placeholder for future retry/reclaim logic
// Currently retry logic is handled in Control API

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs?: number;
  reason?: string;
}

/**
 * Determine if a job should be retried based on status and timing
 */
export function shouldRetryJob(
  finalStatus: FinalStatus | null,
  attemptCount: number,
  maxAttempts: number = 3
): RetryDecision {
  if (!finalStatus) {
    return { shouldRetry: false, reason: 'No final status available' };
  }

  if (finalStatus.status === 'COMPLETED') {
    return { shouldRetry: false, reason: 'Job completed successfully' };
  }

  if (finalStatus.status === 'WAITING' || finalStatus.status === 'DELEGATING') {
    return { shouldRetry: false, reason: 'Job is waiting for children or delegating' };
  }

  if (attemptCount >= maxAttempts) {
    return { shouldRetry: false, reason: `Max attempts (${maxAttempts}) reached` };
  }

  // Exponential backoff: 1s, 2s, 4s
  const delayMs = Math.pow(2, attemptCount) * 1000;

  return {
    shouldRetry: true,
    delayMs,
  };
}

