/**
 * Unit Test: Get All Children For Job Definition
 * Module: worker/status/childJobs.ts
 * Priority: P0 (CRITICAL)
 *
 * Tests job-level child status aggregation across multiple runs.
 * Critical for fixing WAITING cycle bugs where hierarchy snapshots are stale.
 *
 * Impact: Prevents incorrect status inference causing jobs to cycle through WAITING
 * instead of transitioning to COMPLETED when children finish.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { 
  getAllChildrenForJobDefinition,
  queryRequestsByJobDefinition,
  type JobLevelChildStatusResult 
} from 'jinn-node/worker/status/childJobs.js';

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

describe('getAllChildrenForJobDefinition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('basic functionality', () => {
    it('returns empty result when job has no runs', async () => {
      // Mock queryRequestsByJobDefinition to return empty array
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result).toEqual({
        allChildren: [],
        totalChildren: 0,
        undeliveredChildren: 0,
        activeChildren: 0,
        queryDuration_ms: expect.any(Number),
      });
    });

    it('returns empty result when job runs have no children', async () => {
      // Mock: 2 runs of the job, but no children
      (graphQLRequest as any)
        // First call: queryRequestsByJobDefinition
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xreq1', blockTimestamp: '1000' },
              { id: '0xreq2', blockTimestamp: '2000' },
            ]
          }
        })
        // Second call: getChildJobStatus for req1
        .mockResolvedValueOnce({
          requests: { items: [] }
        })
        // Third call: getChildJobStatus for req2
        .mockResolvedValueOnce({
          requests: { items: [] }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result).toEqual({
        allChildren: [],
        totalChildren: 0,
        undeliveredChildren: 0,
        activeChildren: 0,
        queryDuration_ms: expect.any(Number),
      });
    });

    it('aggregates children from single run', async () => {
      (graphQLRequest as any)
        // queryRequestsByJobDefinition
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xparent1', blockTimestamp: '1000' }]
          }
        })
        // getChildJobStatus
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xchild1', delivered: false },
              { id: '0xchild2', delivered: true },
            ]
          }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result.totalChildren).toBe(2);
      expect(result.undeliveredChildren).toBe(1);
      expect(result.allChildren).toEqual([
        { id: '0xchild1', delivered: false, requestId: '0xparent1' },
        { id: '0xchild2', delivered: true, requestId: '0xparent1' },
      ]);
    });

    it('aggregates children from multiple runs', async () => {
      (graphQLRequest as any)
        // queryRequestsByJobDefinition
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xparent1', blockTimestamp: '1000' },
              { id: '0xparent2', blockTimestamp: '2000' },
            ]
          }
        })
        // getChildJobStatus for parent1
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xchild1', delivered: false },
              { id: '0xchild2', delivered: true },
            ]
          }
        })
        // getChildJobStatus for parent2
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xchild3', delivered: true },
              { id: '0xchild4', delivered: false },
            ]
          }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result.totalChildren).toBe(4);
      expect(result.undeliveredChildren).toBe(2);
      expect(result.allChildren).toHaveLength(4);
    });
  });

  describe('deduplication', () => {
    it('deduplicates same child appearing in multiple runs', async () => {
      (graphQLRequest as any)
        // queryRequestsByJobDefinition
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xparent1', blockTimestamp: '1000' },
              { id: '0xparent2', blockTimestamp: '2000' },
            ]
          }
        })
        // getChildJobStatus for parent1
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xchild1', delivered: false },
              { id: '0xchild2', delivered: false },
            ]
          }
        })
        // getChildJobStatus for parent2 (same children!)
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xchild1', delivered: true },  // Now delivered
              { id: '0xchild2', delivered: false }, // Still not delivered
            ]
          }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      // Should only count each child once (first occurrence)
      expect(result.totalChildren).toBe(2);
      expect(result.allChildren).toHaveLength(2);
      
      // First occurrence wins (from parent1)
      expect(result.allChildren).toEqual([
        { id: '0xchild1', delivered: false, requestId: '0xparent1' },
        { id: '0xchild2', delivered: false, requestId: '0xparent1' },
      ]);
    });

    it('tracks which parent request spawned each child', async () => {
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xparent1', blockTimestamp: '1000' },
              { id: '0xparent2', blockTimestamp: '2000' },
            ]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1', delivered: false }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild2', delivered: false }]
          }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result.allChildren).toEqual([
        { id: '0xchild1', delivered: false, requestId: '0xparent1' },
        { id: '0xchild2', delivered: false, requestId: '0xparent2' },
      ]);
    });
  });

  describe('active children detection', () => {
    it('detects delivered children with non-terminal status', async () => {
      (graphQLRequest as any)
        // queryRequestsByJobDefinition
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xparent1', blockTimestamp: '1000' }]
          }
        })
        // getChildJobStatus
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xchild1', delivered: true },
              { id: '0xchild2', delivered: true },
            ]
          }
        })
        // Get child job definition IDs
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xchild1', jobDefinitionId: 'child-job-def-1' },
              { id: '0xchild2', jobDefinitionId: 'child-job-def-2' },
            ]
          }
        })
        // Get job definition statuses
        .mockResolvedValueOnce({
          jobDefinitions: {
            items: [
              { id: 'child-job-def-1', lastStatus: 'DELEGATING' },
              { id: 'child-job-def-2', lastStatus: 'COMPLETED' },
            ]
          }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result.totalChildren).toBe(2);
      expect(result.undeliveredChildren).toBe(0);
      expect(result.activeChildren).toBe(1); // child1 is DELEGATING
    });

    it('counts WAITING status as active', async () => {
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xparent1', blockTimestamp: '1000' }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1', delivered: true }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1', jobDefinitionId: 'child-job-def-1' }]
          }
        })
        .mockResolvedValueOnce({
          jobDefinitions: {
            items: [{ id: 'child-job-def-1', lastStatus: 'WAITING' }]
          }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result.activeChildren).toBe(1);
    });

    it('does not count COMPLETED status as active', async () => {
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xparent1', blockTimestamp: '1000' }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1', delivered: true }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1', jobDefinitionId: 'child-job-def-1' }]
          }
        })
        .mockResolvedValueOnce({
          jobDefinitions: {
            items: [{ id: 'child-job-def-1', lastStatus: 'COMPLETED' }]
          }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result.activeChildren).toBe(0);
    });

    it('handles query failure gracefully for job status', async () => {
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xparent1', blockTimestamp: '1000' }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1', delivered: true }]
          }
        })
        // Query for job definitions fails
        .mockRejectedValueOnce(new Error('GraphQL timeout'));

      const result = await getAllChildrenForJobDefinition('job-def-123');

      // Should still return result, treating all delivered children as complete (safe default)
      expect(result.totalChildren).toBe(1);
      expect(result.undeliveredChildren).toBe(0);
      expect(result.activeChildren).toBe(0); // Defaults to 0 on error
      expect(workerLogger.warn).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('handles empty items arrays gracefully', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result.totalChildren).toBe(0);
      expect(result.allChildren).toEqual([]);
    });

    it('handles missing job definition ID in child request', async () => {
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xparent1', blockTimestamp: '1000' }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1', delivered: true }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1' }] // Missing jobDefinitionId
          }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      // Should not crash, just skip status lookup
      expect(result.totalChildren).toBe(1);
      expect(result.activeChildren).toBe(0);
    });

    it('handles missing lastStatus in job definition', async () => {
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xparent1', blockTimestamp: '1000' }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1', delivered: true }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xchild1', jobDefinitionId: 'child-job-def-1' }]
          }
        })
        .mockResolvedValueOnce({
          jobDefinitions: {
            items: [{ id: 'child-job-def-1' }] // Missing lastStatus
          }
        });

      const result = await getAllChildrenForJobDefinition('job-def-123');

      expect(result.activeChildren).toBe(0); // No status = not active
    });
  });

  describe('logging', () => {
    it('logs query details on start', async () => {
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xparent1', blockTimestamp: '1000' }]
          }
        })
        .mockResolvedValueOnce({
          requests: { items: [] }
        });

      await getAllChildrenForJobDefinition('job-def-123');

      expect(workerLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          jobDefinitionId: 'job-def-123',
          requestCount: 1
        }),
        expect.stringContaining('Querying children for all requests')
      );
    });

    it('logs aggregation results on completion', async () => {
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          requests: {
            items: [{ id: '0xparent1', blockTimestamp: '1000' }]
          }
        })
        .mockResolvedValueOnce({
          requests: {
            items: [
              { id: '0xchild1', delivered: false },
              { id: '0xchild2', delivered: true },
            ]
          }
        });

      await getAllChildrenForJobDefinition('job-def-123');

      expect(workerLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          jobDefinitionId: 'job-def-123',
          totalChildren: 2,
          undeliveredChildren: 1,
          activeChildren: 0,
          queryDuration_ms: expect.any(Number)
        }),
        expect.stringContaining('Aggregated all children')
      );
    });
  });

  describe('queryRequestsByJobDefinition', () => {
    it('queries all requests for a job definition', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: {
          items: [
            { id: '0xreq1', blockTimestamp: '1000' },
            { id: '0xreq2', blockTimestamp: '2000' },
          ]
        }
      });

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual([
        { id: '0xreq1', blockTimestamp: '1000' },
        { id: '0xreq2', blockTimestamp: '2000' },
      ]);
    });

    it('returns empty array on query failure', async () => {
      (graphQLRequest as any).mockRejectedValue(new Error('Network error'));

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual([]);
      expect(workerLogger.error).toHaveBeenCalled();
    });

    it('handles empty results', async () => {
      (graphQLRequest as any).mockResolvedValue({
        requests: { items: [] }
      });

      const result = await queryRequestsByJobDefinition('job-def-123');

      expect(result).toEqual([]);
    });
  });
});

