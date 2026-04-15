/**
 * Unit tests for worker/status/retryStrategy.ts
 *
 * Tests retry decision logic with exponential backoff strategy.
 *
 * Priority: P1 (High Priority)
 * Business Impact: Workflow Reliability
 * Coverage Target: 100% of retry decision logic
 */

import { describe, expect, it } from 'vitest';
import { shouldRetryJob } from 'jinn-node/worker/status/retryStrategy.js';
import type { FinalStatus } from 'jinn-node/worker/types.js';

describe('shouldRetryJob', () => {
  describe('non-retryable statuses', () => {
    it('returns false with reason when finalStatus is null', () => {
      const result = shouldRetryJob(null, 0);

      expect(result).toEqual({
        shouldRetry: false,
        reason: 'No final status available',
      });
    });

    it('returns false for COMPLETED status', () => {
      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
        message: 'Job completed successfully',
      };

      const result = shouldRetryJob(finalStatus, 0);

      expect(result).toEqual({
        shouldRetry: false,
        reason: 'Job completed successfully',
      });
    });

    it('returns false for WAITING status', () => {
      const finalStatus: FinalStatus = {
        status: 'WAITING',
        message: 'Waiting for child jobs',
      };

      const result = shouldRetryJob(finalStatus, 0);

      expect(result).toEqual({
        shouldRetry: false,
        reason: 'Job is waiting for children or delegating',
      });
    });

    it('returns false for DELEGATING status', () => {
      const finalStatus: FinalStatus = {
        status: 'DELEGATING',
        message: 'Delegated to child jobs',
      };

      const result = shouldRetryJob(finalStatus, 0);

      expect(result).toEqual({
        shouldRetry: false,
        reason: 'Job is waiting for children or delegating',
      });
    });
  });

  describe('max attempts enforcement', () => {
    it('returns false when attemptCount equals maxAttempts (default 3)', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 3);

      expect(result).toEqual({
        shouldRetry: false,
        reason: 'Max attempts (3) reached',
      });
    });

    it('returns false when attemptCount exceeds maxAttempts', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 5, 3);

      expect(result).toEqual({
        shouldRetry: false,
        reason: 'Max attempts (3) reached',
      });
    });

    it('returns false when attemptCount equals custom maxAttempts', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 5, 5);

      expect(result).toEqual({
        shouldRetry: false,
        reason: 'Max attempts (5) reached',
      });
    });

    it('allows retry when attemptCount is one less than maxAttempts', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 2, 3);

      expect(result.shouldRetry).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('exponential backoff calculation', () => {
    it('calculates 1000ms delay for attempt 0', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 0);

      expect(result).toEqual({
        shouldRetry: true,
        delayMs: 1000, // 2^0 * 1000
      });
    });

    it('calculates 2000ms delay for attempt 1', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 1);

      expect(result).toEqual({
        shouldRetry: true,
        delayMs: 2000, // 2^1 * 1000
      });
    });

    it('calculates 4000ms delay for attempt 2', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 2);

      expect(result).toEqual({
        shouldRetry: true,
        delayMs: 4000, // 2^2 * 1000
      });
    });

    it('calculates 8000ms delay for attempt 3 (if maxAttempts increased)', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 3, 5);

      expect(result).toEqual({
        shouldRetry: true,
        delayMs: 8000, // 2^3 * 1000
      });
    });

    it('calculates 16000ms delay for attempt 4', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 4, 10);

      expect(result).toEqual({
        shouldRetry: true,
        delayMs: 16000, // 2^4 * 1000
      });
    });
  });

  describe('edge cases', () => {
    it('handles zero attempts with default maxAttempts', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 0, 3);

      expect(result.shouldRetry).toBe(true);
      expect(result.delayMs).toBe(1000);
    });

    it('handles maxAttempts of 1', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 1, 1);

      expect(result).toEqual({
        shouldRetry: false,
        reason: 'Max attempts (1) reached',
      });
    });

    it('allows retry for first attempt when maxAttempts is 1', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 0, 1);

      expect(result.shouldRetry).toBe(true);
      expect(result.delayMs).toBe(1000);
    });

    it('respects custom maxAttempts larger than default', () => {
      const finalStatus: FinalStatus = {
        status: 'FAILED',
        message: 'Job failed',
      };

      const result = shouldRetryJob(finalStatus, 8, 10);

      expect(result.shouldRetry).toBe(true);
      expect(result.delayMs).toBe(256000); // 2^8 * 1000
    });
  });
});
