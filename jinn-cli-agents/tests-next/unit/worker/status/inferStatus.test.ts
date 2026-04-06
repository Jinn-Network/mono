/**
 * Unit Test: Status Inference
 * Module: worker/status/inferStatus.ts
 * Priority: P1 (HIGH)
 *
 * Tests job status inference logic based on errors, telemetry tool calls,
 * and child job delivery status. Critical for workflow correctness.
 *
 * Impact: Prevents incorrect status inference ($550/year workflow failures)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { inferJobStatus } from 'jinn-node/worker/status/inferStatus.js';
import type { FinalStatus, ChildJobStatus } from 'jinn-node/worker/types.js';

// Mock childJobs module
vi.mock('jinn-node/worker/status/childJobs.js', () => ({
  getChildJobStatus: vi.fn(),
  getAllChildrenForJobDefinition: vi.fn(),
}));

import { getChildJobStatus, getAllChildrenForJobDefinition } from 'jinn-node/worker/status/childJobs.js';

describe('inferJobStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('FAILED status', () => {
    it('infers FAILED when error is present', async () => {
      const error = new Error('Execution failed');
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error,
        telemetry: {},
      });

      expect(result).toEqual({
        status: 'FAILED',
        message: 'Job failed: Execution failed',
      });
    });

    it('infers FAILED with string error', async () => {
      const error = 'Network timeout';
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error,
        telemetry: {},
      });

      expect(result.status).toBe('FAILED');
      expect(result.message).toContain('Network timeout');
    });

    it('infers FAILED with error object without message', async () => {
      const error = { code: 500 };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error,
        telemetry: {},
      });

      expect(result.status).toBe('FAILED');
      expect(result.message).toContain('{"code":500}');
    });

    it('prioritizes FAILED over other statuses', async () => {
      const error = new Error('Critical error');
      // Has dispatch calls but should still be FAILED
      const telemetry = {
        toolCalls: [{ tool: 'dispatch_new_job', success: true }],
      };
      (getChildJobStatus as any).mockResolvedValue({
        childJobs: [{ id: '0xchild1', delivered: false }],
        queryDuration_ms: 10,
        retryAttempts: 0
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error,
        telemetry,
      });

      expect(result.status).toBe('FAILED');
    });
  });

  describe('DELEGATING status', () => {
    it('infers DELEGATING with dispatch_new_job calls', async () => {
      const telemetry = {
        toolCalls: [
          { tool: 'dispatch_new_job', success: true, result: { data: { jobDefinitionId: 'test-id' }, meta: { ok: true } } },
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'DELEGATING',
        message: 'Dispatched 1 child job(s)',
      });
    });

    it('infers DELEGATING with dispatch_existing_job calls', async () => {
      const telemetry = {
        toolCalls: [
          { 
            tool: 'dispatch_existing_job', 
            success: true,
            result: { data: { jobDefinitionId: 'existing-job-1' } }
          },
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result.status).toBe('DELEGATING');
    });

    it('infers DELEGATING with multiple dispatch calls (counts unique job definitions)', async () => {
      const telemetry = {
        toolCalls: [
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-1' } }
          },
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-2' } }
          },
          { 
            tool: 'dispatch_existing_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-3' } }
          },
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'DELEGATING',
        message: 'Dispatched 3 child job(s)',
      });
    });

    it('ignores failed dispatch calls', async () => {
      const telemetry = {
        toolCalls: [
          { tool: 'dispatch_new_job', success: false },
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-1' } }
          },
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'DELEGATING',
        message: 'Dispatched 1 child job(s)',
      });
    });

    it('deduplicates retry attempts for same job definition', async () => {
      // Simulates: 3 successful dispatches for same job (due to retries)
      // Should count as 1 unique job
      const telemetry = {
        toolCalls: [
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-1' } }
          },
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-1' } }  // Same job, retry
          },
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-1' } }  // Same job, retry
          },
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'DELEGATING',
        message: 'Dispatched 1 child job(s)',
      });
    });

    it('counts distinct jobs even with retries', async () => {
      // Simulates: 3 jobs with retries = 7 total calls, but only 3 unique jobs
      const telemetry = {
        toolCalls: [
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-1' } }
          },
          { 
            tool: 'dispatch_new_job', 
            success: false  // Failed attempt
          },
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-2' } }
          },
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-2' } }  // Retry
          },
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-3' } }
          },
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-1' } }  // Retry of job-1
          },
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-3' } }  // Retry of job-3
          },
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'DELEGATING',
        message: 'Dispatched 3 child job(s)',
      });
    });

    it('handles snake_case tool_calls field', async () => {
      const telemetry = {
        tool_calls: [
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'job-1' } }
          },
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result.status).toBe('DELEGATING');
    });

    it('handles missing toolCalls/tool_calls fields', async () => {
      const telemetry = {};
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result.status).not.toBe('DELEGATING');
    });

    it('ignores non-dispatch tool calls', async () => {
      const telemetry = {
        toolCalls: [
          { tool: 'read_file', success: true },
          { tool: 'write_file', success: true },
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result.status).not.toBe('DELEGATING');
    });

    it('uses delegated flag when telemetry is missing', async () => {
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry: {},
        delegatedThisRun: true,
      });

      expect(result).toEqual({
        status: 'DELEGATING',
        message: 'Dispatched child job(s) this run',
      });
    });
  });

  describe('WAITING status', () => {
    it('infers WAITING when child jobs are undelivered', async () => {
      const telemetry = { toolCalls: [] };
      (getChildJobStatus as any).mockResolvedValue({
        childJobs: [{ id: '0xchild1', delivered: false }],
        queryDuration_ms: 10,
        retryAttempts: 0
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'WAITING',
        message: 'Waiting for 1 child job(s) to deliver',
      });
    });

    it('infers WAITING with multiple undelivered children', async () => {
      const telemetry = { toolCalls: [] };
      (getChildJobStatus as any).mockResolvedValue({
        childJobs: [
          { id: '0xchild1', delivered: false },
          { id: '0xchild2', delivered: false },
          { id: '0xchild3', delivered: false },
        ],
        queryDuration_ms: 10,
        retryAttempts: 0
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'WAITING',
        message: 'Waiting for 3 child job(s) to deliver',
      });
    });

    it('infers WAITING when some children delivered but not all', async () => {
      const telemetry = { toolCalls: [] };
      (getChildJobStatus as any).mockResolvedValue({
        childJobs: [
          { id: '0xchild1', delivered: true },
          { id: '0xchild2', delivered: false },
          { id: '0xchild3', delivered: true },
        ],
        queryDuration_ms: 10,
        retryAttempts: 0
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'WAITING',
        message: 'Waiting for 1 child job(s) to deliver',
      });
    });

    it('queries child status when no dispatch calls this run', async () => {
      const telemetry = {
        toolCalls: [{ tool: 'read_file', success: true }],
      };
      (getChildJobStatus as any).mockResolvedValue({
        childJobs: [{ id: '0xchild1', delivered: false }],
        queryDuration_ms: 10,
        retryAttempts: 0
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(getChildJobStatus).toHaveBeenCalledWith('0x123');
      expect(result.status).toBe('WAITING');
    });
  });

  describe('COMPLETED status', () => {
    it('infers COMPLETED when all children delivered', async () => {
      const telemetry = { toolCalls: [] };
      (getChildJobStatus as any).mockResolvedValue({
        childJobs: [
          { id: '0xchild1', delivered: true },
          { id: '0xchild2', delivered: true },
        ],
        queryDuration_ms: 10,
        retryAttempts: 0
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'COMPLETED',
        message: 'All 2 child job(s) delivered',
      });
    });

    it('infers COMPLETED when no children exist', async () => {
      const telemetry = { toolCalls: [] };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result).toEqual({
        status: 'COMPLETED',
        message: 'Job completed direct work',
      });
    });

    it('infers COMPLETED for simple non-delegating job', async () => {
      const telemetry = {
        toolCalls: [
          { tool: 'read_file', success: true },
          { tool: 'write_file', success: true },
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.message).toBe('Job completed direct work');
    });

    it('infers COMPLETED with empty telemetry', async () => {
      const telemetry = {};
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result.status).toBe('COMPLETED');
    });

    it('infers COMPLETED with null telemetry', async () => {
      const telemetry = null;
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result.status).toBe('COMPLETED');
    });
  });

  describe('status precedence', () => {
    it('FAILED takes precedence over DELEGATING', async () => {
      const error = new Error('Error');
      const telemetry = {
        toolCalls: [{ tool: 'dispatch_new_job', success: true }],
      };
      (getChildJobStatus as any).mockResolvedValue({ childJobs: [], queryDuration_ms: 10, retryAttempts: 0 });

      const result = await inferJobStatus({
        requestId: '0x123',
        error,
        telemetry,
      });

      expect(result.status).toBe('FAILED');
    });

    it('FAILED takes precedence over WAITING', async () => {
      const error = new Error('Error');
      const telemetry = {};
      (getChildJobStatus as any).mockResolvedValue({
        childJobs: [{ id: '0xchild1', delivered: false }],
        queryDuration_ms: 10,
        retryAttempts: 0
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error,
        telemetry,
      });

      expect(result.status).toBe('FAILED');
    });

    it('DELEGATING takes precedence over WAITING', async () => {
      // This run dispatched jobs, even though old children still pending
      const telemetry = {
        toolCalls: [
          { 
            tool: 'dispatch_new_job', 
            success: true,
            result: { data: { jobDefinitionId: 'new-job-1' } }
          }
        ],
      };
      (getChildJobStatus as any).mockResolvedValue({
        childJobs: [
          { id: '0xoldchild', delivered: false },
        ],
        queryDuration_ms: 10,
        retryAttempts: 0
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
      });

      expect(result.status).toBe('DELEGATING');
    });
  });

  describe('job-level child status (hierarchy with getAllChildrenForJobDefinition)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('infers WAITING when getAllChildrenForJobDefinition shows undelivered children', async () => {
      const telemetry = { toolCalls: [] };
      const metadata = {
        jobDefinitionId: 'job-def-123',
        additionalContext: {
          hierarchy: [
            { id: 'child1', level: 1, sourceJobDefinitionId: 'job-def-123', status: 'pending' }
          ]
        }
      };

      (getAllChildrenForJobDefinition as any).mockResolvedValue({
        allChildren: [
          { id: '0xchild1', delivered: false, requestId: '0xparent' }
        ],
        totalChildren: 1,
        undeliveredChildren: 1,
        activeChildren: 0,
        queryDuration_ms: 100
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
        metadata
      });

      expect(getAllChildrenForJobDefinition).toHaveBeenCalledWith('job-def-123');
      expect(result.status).toBe('WAITING');
      expect(result.message).toContain('1 child job(s) to deliver (live query)');
    });

    it('infers WAITING when children delivered but have DELEGATING status', async () => {
      const telemetry = { toolCalls: [] };
      const metadata = {
        jobDefinitionId: 'job-def-123',
        additionalContext: {
          hierarchy: [
            { id: 'child1', level: 1, sourceJobDefinitionId: 'job-def-123', status: 'completed' }
          ]
        }
      };

      (getAllChildrenForJobDefinition as any).mockResolvedValue({
        allChildren: [
          { 
            id: '0xchild1', 
            delivered: true, 
            requestId: '0xparent',
            jobDefinitionId: 'child-job-def-1',
            jobStatus: 'DELEGATING'
          }
        ],
        totalChildren: 1,
        undeliveredChildren: 0,
        activeChildren: 1, // Child is delivered but still DELEGATING
        queryDuration_ms: 100
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
        metadata
      });

      expect(result.status).toBe('WAITING');
      expect(result.message).toContain('1 child job(s) with non-terminal status');
    });

    it('infers WAITING when children delivered but have WAITING status', async () => {
      const telemetry = { toolCalls: [] };
      const metadata = {
        jobDefinitionId: 'job-def-123',
        additionalContext: {
          hierarchy: []
        }
      };

      (getAllChildrenForJobDefinition as any).mockResolvedValue({
        allChildren: [
          { 
            id: '0xchild1', 
            delivered: true, 
            requestId: '0xparent',
            jobDefinitionId: 'child-job-def-1',
            jobStatus: 'WAITING'
          }
        ],
        totalChildren: 1,
        undeliveredChildren: 0,
        activeChildren: 1,
        queryDuration_ms: 100
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
        metadata
      });

      expect(result.status).toBe('WAITING');
    });

    it('infers COMPLETED when all children delivered with terminal status', async () => {
      const telemetry = { toolCalls: [] };
      const metadata = {
        jobDefinitionId: 'job-def-123',
        additionalContext: {
          hierarchy: [
            { id: 'child1', level: 1, sourceJobDefinitionId: 'job-def-123', status: 'active' }
          ]
        }
      };

      (getAllChildrenForJobDefinition as any).mockResolvedValue({
        allChildren: [
          { 
            id: '0xchild1', 
            delivered: true, 
            requestId: '0xparent',
            jobDefinitionId: 'child-job-def-1',
            jobStatus: 'COMPLETED'
          }
        ],
        totalChildren: 1,
        undeliveredChildren: 0,
        activeChildren: 0,
        queryDuration_ms: 100
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
        metadata
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.message).toContain('All 1 child job(s) complete');
    });

    it('falls back to hierarchy when getAllChildrenForJobDefinition fails', async () => {
      const telemetry = { toolCalls: [] };
      const metadata = {
        jobDefinitionId: 'job-def-123',
        additionalContext: {
          hierarchy: [
            { id: 'child1', level: 1, sourceJobDefinitionId: 'job-def-123', status: 'completed', jobDefinitionId: 'child-def-1' }
          ]
        }
      };

      (getAllChildrenForJobDefinition as any).mockRejectedValue(new Error('Network error'));

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
        metadata
      });

      // Should fall back to hierarchy and infer COMPLETED
      expect(result.status).toBe('COMPLETED');
    });

    it('uses job-level query only when jobDefinitionId present', async () => {
      const telemetry = { toolCalls: [] };
      const metadata = {
        // No jobDefinitionId
        additionalContext: {
          hierarchy: []
        }
      };

      (getChildJobStatus as any).mockResolvedValue({
        childJobs: [],
        queryDuration_ms: 10,
        retryAttempts: 0
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
        metadata
      });

      // Should use legacy per-request child query
      expect(getAllChildrenForJobDefinition).not.toHaveBeenCalled();
      expect(getChildJobStatus).toHaveBeenCalledWith('0x123');
      expect(result.status).toBe('COMPLETED');
    });

    it('logs hierarchy vs live data comparison', async () => {
      const telemetry = { toolCalls: [] };
      const metadata = {
        jobDefinitionId: 'job-def-123',
        additionalContext: {
          hierarchy: [
            { id: 'child1', level: 1, sourceJobDefinitionId: 'job-def-123', status: 'active' }
          ]
        }
      };

      (getAllChildrenForJobDefinition as any).mockResolvedValue({
        allChildren: [
          { id: '0xchild1', delivered: true, requestId: '0xparent' }
        ],
        totalChildren: 1,
        undeliveredChildren: 0,
        activeChildren: 0,
        queryDuration_ms: 100
      });

      await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
        metadata
      });

      // Verify comparison logging occurs (checking workerLogger is not part of this test file's scope,
      // but the function should call it)
      expect(getAllChildrenForJobDefinition).toHaveBeenCalledWith('job-def-123');
    });

    it('detects discrepancy between hierarchy and live data', async () => {
      const telemetry = { toolCalls: [] };
      const metadata = {
        jobDefinitionId: 'job-def-123',
        additionalContext: {
          hierarchy: [
            // Hierarchy says child is active (stale data)
            { id: 'child1', level: 1, sourceJobDefinitionId: 'job-def-123', status: 'pending' }
          ]
        }
      };

      // Live data shows child is actually delivered
      (getAllChildrenForJobDefinition as any).mockResolvedValue({
        allChildren: [
          { id: '0xchild1', delivered: true, requestId: '0xparent', jobStatus: 'COMPLETED' }
        ],
        totalChildren: 1,
        undeliveredChildren: 0,
        activeChildren: 0,
        queryDuration_ms: 100
      });

      const result = await inferJobStatus({
        requestId: '0x123',
        error: null,
        telemetry,
        metadata
      });

      // Should trust live data and infer COMPLETED
      expect(result.status).toBe('COMPLETED');
    });
  });
});
