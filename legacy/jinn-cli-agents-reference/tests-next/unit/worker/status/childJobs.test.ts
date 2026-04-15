/**
 * Unit Test: Child Job Status Queries
 * Module: worker/status/childJobs.ts
 * Priority: P1 (HIGH)
 *
 * Tests GraphQL queries for child job status with retry logic.
 * Critical for determining WAITING vs COMPLETED status.
 *
 * Impact: Prevents incorrect workflow state transitions
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getChildJobStatus } from 'jinn-node/worker/status/childJobs.js';
import type { ChildJobStatus } from 'jinn-node/worker/types.js';

// Mock dependencies
vi.mock('jinn-node/http/client.js', () => ({
  graphQLRequest: vi.fn(),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getPonderGraphqlUrl: vi.fn().mockReturnValue('http://localhost:42069/graphql'),
}));

vi.mock('jinn-node/logging/index.js', () => ({
  workerLogger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('jinn-node/worker/logging/errors.js', () => ({
  serializeError: vi.fn((error) => error?.message || String(error)),
}));

import { graphQLRequest } from 'jinn-node/http/client.js';
import { workerLogger } from 'jinn-node/logging/index.js';

describe('getChildJobStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful queries', () => {
    it('returns empty array when no children exist', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [],
        },
      });

      const result = await getChildJobStatus('0xparent123');

      expect(result).toEqual({
        childJobs: [],
        queryDuration_ms: expect.any(Number),
        retryAttempts: 0
      });
    });

    it('returns child job statuses', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            { id: '0xchild1', delivered: false },
            { id: '0xchild2', delivered: true },
          ],
        },
      });

      const result = await getChildJobStatus('0xparent123');

      expect(result).toEqual({
        childJobs: [
          { id: '0xchild1', delivered: false },
          { id: '0xchild2', delivered: true },
        ],
        queryDuration_ms: expect.any(Number),
        retryAttempts: 0
      });
    });

    it('queries with correct GraphQL structure', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] },
      });

      await getChildJobStatus('0xparent456');

      expect(graphQLRequest).toHaveBeenCalledWith({
        url: 'http://localhost:42069/graphql',
        query: expect.stringContaining('query GetChildJobs'),
        variables: { sourceRequestId: '0xparent456' },
        context: {
          operation: 'getChildJobStatus',
          requestId: '0xparent456',
        },
      });
    });

    it('extracts correct fields from GraphQL response', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            {
              id: '0xchild1',
              delivered: true,
              // Extra fields should be ignored
              jobName: 'child-job',
              blockTimestamp: 123456,
            },
          ],
        },
      });

      const result = await getChildJobStatus('0xparent');

      expect(result).toEqual({
        childJobs: [
          { id: '0xchild1', delivered: true, jobName: 'child-job', blockTimestamp: 123456 },
        ],
        queryDuration_ms: expect.any(Number),
        retryAttempts: 0
      });
    });

    it('handles multiple children', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            { id: '0xchild1', delivered: false },
            { id: '0xchild2', delivered: false },
            { id: '0xchild3', delivered: true },
            { id: '0xchild4', delivered: true },
          ],
        },
      });

      const result = await getChildJobStatus('0xparent');

      expect(result.childJobs).toHaveLength(4);
    });
  });

  describe('retry logic', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries on first failure', async () => {
      (graphQLRequest as any)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          requests: { items: [{ id: '0xchild1', delivered: true }] },
        });

      const promise = getChildJobStatus('0xparent');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(graphQLRequest).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        childJobs: [{ id: '0xchild1', delivered: true }],
        queryDuration_ms: expect.any(Number),
        retryAttempts: 1
      });
    });

    it('retries on second failure', async () => {
      (graphQLRequest as any)
        .mockRejectedValueOnce(new Error('Network error 1'))
        .mockRejectedValueOnce(new Error('Network error 2'))
        .mockResolvedValueOnce({
          requests: { items: [] },
        });

      const promise = getChildJobStatus('0xparent');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(graphQLRequest).toHaveBeenCalledTimes(3);
      expect(result).toEqual({
        childJobs: [],
        queryDuration_ms: expect.any(Number),
        retryAttempts: 2
      });
    });

    it('waits between retries with exponential backoff', async () => {
      (graphQLRequest as any)
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce({ requests: { items: [] } });

      const promise = getChildJobStatus('0xparent');

      // First retry after 300ms
      await vi.advanceTimersByTimeAsync(300);
      expect(graphQLRequest).toHaveBeenCalledTimes(2);

      // Second retry after 600ms (300 * 2)
      await vi.advanceTimersByTimeAsync(600);
      expect(graphQLRequest).toHaveBeenCalledTimes(3);

      await promise;
    });

    it('logs warning on each retry', async () => {
      (graphQLRequest as any)
        .mockRejectedValueOnce(new Error('Temp error'))
        .mockResolvedValueOnce({ requests: { items: [] } });

      const promise = getChildJobStatus('0xparent123');
      await vi.runAllTimersAsync();
      await promise;

      expect(workerLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: '0xparent123',
          attempt: 1,
          maxAttempts: 3,
        }),
        expect.stringContaining('Retrying child job status lookup')
      );
    });

    it('throws after max retries exceeded', async () => {
      (graphQLRequest as any).mockRejectedValue(new Error('Persistent error'));

      const promise = getChildJobStatus('0xparent');
      // Attach error handler immediately to prevent unhandled rejection
      const errorHandler = promise.catch((e) => e);

      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow('Failed to query child job status');
    });

    it('logs error after max retries', async () => {
      (graphQLRequest as any).mockRejectedValue(new Error('Persistent error'));

      const promise = getChildJobStatus('0xparent123');
      const errorHandler = promise.catch((e) => e);

      await vi.runAllTimersAsync();

      try {
        await promise;
      } catch {
        // Expected
      }

      expect(workerLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: '0xparent123',
        }),
        'Failed to query child job status'
      );
    });

    it('wraps error with context', async () => {
      (graphQLRequest as any).mockRejectedValue(new Error('GraphQL timeout'));

      const promise = getChildJobStatus('0xparent');
      const errorHandler = promise.catch((e) => e);

      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow('Failed to query child job status: GraphQL timeout');
    });

    it('preserves original error as cause', async () => {
      const originalError = new Error('Original error');
      (graphQLRequest as any).mockRejectedValue(originalError);

      const promise = getChildJobStatus('0xparent');
      const errorHandler = promise.catch((e) => e);

      await vi.runAllTimersAsync();

      try {
        await promise;
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.cause).toBeDefined();
        expect(error.cause.message).toBe('Original error');
      }
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('handles null response', async () => {
      (graphQLRequest as any).mockResolvedValue(null);

      const result = await getChildJobStatus('0xparent');

      expect(result).toEqual({
        childJobs: [],
        queryDuration_ms: expect.any(Number),
        retryAttempts: 0
      });
    });

    it('handles missing items array', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {},
      });

      const result = await getChildJobStatus('0xparent');

      expect(result).toEqual({
        childJobs: [],
        queryDuration_ms: expect.any(Number),
        retryAttempts: 0
      });
    });

    it('handles undefined response', async () => {
      (graphQLRequest as any).mockResolvedValue(undefined);

      const result = await getChildJobStatus('0xparent');

      expect(result).toEqual({
        childJobs: [],
        queryDuration_ms: expect.any(Number),
        retryAttempts: 0
      });
    });

    it('handles string error', async () => {
      (graphQLRequest as any).mockRejectedValue('String error');

      const promise = getChildJobStatus('0xparent');
      const errorHandler = promise.catch((e) => e);

      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow('Failed to query child job status');
    });

    it('handles error without message property', async () => {
      (graphQLRequest as any).mockRejectedValue({ code: 500 });

      const promise = getChildJobStatus('0xparent');
      const errorHandler = promise.catch((e) => e);

      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow();
    });
  });
});
