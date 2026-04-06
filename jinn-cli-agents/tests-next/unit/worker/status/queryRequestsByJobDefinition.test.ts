/**
 * Unit Test: Query Requests by Job Definition
 * Module: worker/status/childJobs.ts
 * Priority: P2 (EXTENDED)
 *
 * Tests querying all requests for a specific job definition.
 * Important for finding all runs of a job across its lifetime.
 *
 * Impact: Ensures correct aggregation of job runs for status inference.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { queryRequestsByJobDefinition } from 'jinn-node/worker/status/childJobs.js';

// Mock dependencies
vi.mock('jinn-node/http/client.js', () => ({
  graphQLRequest: vi.fn(),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getPonderGraphqlUrl: vi.fn().mockReturnValue('http://localhost:42069/graphql'),
}));

vi.mock('jinn-node/logging/index.js', () => ({
  workerLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('jinn-node/worker/logging/errors.js', () => ({
  serializeError: vi.fn((error) => error?.message || String(error)),
}));

import { graphQLRequest } from 'jinn-node/http/client.js';
import { workerLogger } from 'jinn-node/logging/index.js';

describe('queryRequestsByJobDefinition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful queries', () => {
    it('returns all requests for a job definition', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            { id: '0xreq1', blockTimestamp: '1000' },
            { id: '0xreq2', blockTimestamp: '2000' },
            { id: '0xreq3', blockTimestamp: '3000' }
          ]
        }
      });

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual([
        { id: '0xreq1', blockTimestamp: '1000' },
        { id: '0xreq2', blockTimestamp: '2000' },
        { id: '0xreq3', blockTimestamp: '3000' }
      ]);
    });

    it('returns empty array when no requests found', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: []
        }
      });

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual([]);
    });

    it('queries with correct job definition ID', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      await queryRequestsByJobDefinition('specific-job-id');

      expect(graphQLRequest).toHaveBeenCalledWith({
        url: 'http://localhost:42069/graphql',
        query: expect.stringContaining('query GetRequestsForJobDef'),
        variables: { jobDefId: 'specific-job-id' },
        context: {
          operation: 'queryRequestsByJobDefinition',
          jobDefinitionId: 'specific-job-id'
        }
      });
    });

    it('orders results by blockTimestamp ascending', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            { id: '0xreq1', blockTimestamp: '1000' },
            { id: '0xreq2', blockTimestamp: '2000' },
            { id: '0xreq3', blockTimestamp: '3000' }
          ]
        }
      });

      await queryRequestsByJobDefinition('job-def-123');

      const call = (graphQLRequest as any).mock.calls[0][0];
      expect(call.query).toContain('orderBy: "blockTimestamp"');
      expect(call.query).toContain('orderDirection: "asc"');
    });

    it('limits results to 100 requests', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      await queryRequestsByJobDefinition('job-def-123');

      const call = (graphQLRequest as any).mock.calls[0][0];
      expect(call.query).toContain('limit: 100');
    });

    it('extracts id and blockTimestamp fields', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            {
              id: '0xreq1',
              blockTimestamp: '1000',
              // Extra fields that should be included
              delivered: true,
              mech: '0xMECH'
            }
          ]
        }
      });

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('blockTimestamp');
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
          requests: {
            items: [{ id: '0xreq1', blockTimestamp: '1000' }]
          }
        });

      const promise = queryRequestsByJobDefinition('job-def-123');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(graphQLRequest).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(1);
    });

    it('retries on second failure', async () => {
      (graphQLRequest as any)
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce({
          requests: { items: [] }
        });

      const promise = queryRequestsByJobDefinition('job-def-123');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(graphQLRequest).toHaveBeenCalledTimes(3);
      expect(result).toEqual([]);
    });

    it('waits between retries with exponential backoff', async () => {
      (graphQLRequest as any)
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce({ requests: { items: [] } });

      const promise = queryRequestsByJobDefinition('job-def-123');

      // First retry after 300ms
      await vi.advanceTimersByTimeAsync(300);
      expect(graphQLRequest).toHaveBeenCalledTimes(2);

      // Second retry after 600ms (300 * 2)
      await vi.advanceTimersByTimeAsync(600);
      expect(graphQLRequest).toHaveBeenCalledTimes(3);

      await promise;
    });

    it('returns empty array after max retries', async () => {
      (graphQLRequest as any).mockRejectedValue(new Error('Persistent error'));

      const promise = queryRequestsByJobDefinition('job-def-123');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(graphQLRequest).toHaveBeenCalledTimes(3); // Max attempts
      expect(result).toEqual([]);
    });

    it('logs error after max retries', async () => {
      (graphQLRequest as any).mockRejectedValue(new Error('Persistent error'));

      const promise = queryRequestsByJobDefinition('job-def-123');
      await vi.runAllTimersAsync();
      await promise;

      expect(workerLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          jobDefinitionId: 'job-def-123'
        }),
        expect.stringContaining('Failed to query requests for job definition')
      );
    });

    it('does not log error on successful retry', async () => {
      (graphQLRequest as any)
        .mockRejectedValueOnce(new Error('Temp error'))
        .mockResolvedValueOnce({ requests: { items: [] } });

      const promise = queryRequestsByJobDefinition('job-def-123');
      await vi.runAllTimersAsync();
      await promise;

      expect(workerLogger.error).not.toHaveBeenCalled();
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

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual([]);
    });

    it('handles undefined response', async () => {
      (graphQLRequest as any).mockResolvedValue(undefined);

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual([]);
    });

    it('handles missing items array', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {}
      });

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual([]);
    });

    it('handles missing requests field', async () => {
      (graphQLRequest as any).mockResolvedValue({});

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual([]);
    });

    it('handles string error', async () => {
      (graphQLRequest as any).mockRejectedValue('String error');

      const promise = queryRequestsByJobDefinition('job-def-123');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual([]);
    });

    it('handles error without message property', async () => {
      (graphQLRequest as any).mockRejectedValue({ code: 500 });

      const promise = queryRequestsByJobDefinition('job-def-123');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual([]);
    });

    it('handles malformed job definition ID', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      const result = await queryRequestsByJobDefinition('invalid-id-!!!');

      expect(result).toEqual([]);
    });

    it('handles very long job definition ID', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      const longId = 'a'.repeat(1000);
      const result = await queryRequestsByJobDefinition(longId);

      expect(result).toEqual([]);
      expect(graphQLRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { jobDefId: longId }
        })
      );
    });
  });

  describe('result ordering', () => {
    it('maintains chronological order', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            { id: '0xold', blockTimestamp: '1000' },
            { id: '0xmid', blockTimestamp: '2000' },
            { id: '0xnew', blockTimestamp: '3000' }
          ]
        }
      });

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result[0].id).toBe('0xold');
      expect(result[1].id).toBe('0xmid');
      expect(result[2].id).toBe('0xnew');
    });

    it('preserves order from Ponder response', async () => {
      const expectedOrder = [
        { id: '0xa', blockTimestamp: '100' },
        { id: '0xb', blockTimestamp: '200' },
        { id: '0xc', blockTimestamp: '300' }
      ];

      (graphQLRequest as any).mockResolvedValue({
        requests: { items: expectedOrder }
      });

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual(expectedOrder);
    });
  });

  describe('pagination limits', () => {
    it('respects 100 request limit', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      await queryRequestsByJobDefinition('job-def-123');

      const call = (graphQLRequest as any).mock.calls[0][0];
      expect(call.query).toMatch(/limit:\s*100/);
    });

    it('returns up to 100 requests', async () => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: `0xreq${i}`,
        blockTimestamp: `${i * 1000}`
      }));

      (graphQLRequest as any).mockResolvedValue({
        requests: { items }
      });

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toHaveLength(100);
    });

    it('does not implement pagination (single query)', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      await queryRequestsByJobDefinition('job-def-123');

      // Should only make one query (no pagination loop)
      expect(graphQLRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('GraphQL query structure', () => {
    it('includes required fields in query', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      await queryRequestsByJobDefinition('job-def-123');

      const call = (graphQLRequest as any).mock.calls[0][0];
      const query = call.query;

      expect(query).toContain('id');
      expect(query).toContain('blockTimestamp');
    });

    it('filters by jobDefinitionId', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      await queryRequestsByJobDefinition('job-def-123');

      const call = (graphQLRequest as any).mock.calls[0][0];
      expect(call.query).toContain('where: { jobDefinitionId: $jobDefId }');
    });

    it('uses correct variable binding', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      await queryRequestsByJobDefinition('test-id');

      const call = (graphQLRequest as any).mock.calls[0][0];
      expect(call.variables).toEqual({ jobDefId: 'test-id' });
    });
  });

  describe('context tracking', () => {
    it('includes operation context', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      await queryRequestsByJobDefinition('job-def-123');

      expect(graphQLRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {
            operation: 'queryRequestsByJobDefinition',
            jobDefinitionId: 'job-def-123'
          }
        })
      );
    });

    it('preserves job definition ID in context', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      await queryRequestsByJobDefinition('unique-job-id');

      const call = (graphQLRequest as any).mock.calls[0][0];
      expect(call.context.jobDefinitionId).toBe('unique-job-id');
    });
  });
});

