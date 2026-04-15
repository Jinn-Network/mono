/**
 * Unit Test: Auto-Dispatch (formerly Parent Dispatch)
 * Module: worker/status/autoDispatch.ts
 * Priority: P1 (HIGH)
 *
 * Tests auto-dispatch decision logic and execution for Work Protocol.
 * Includes parent dispatch, verification dispatch, and continuation dispatch.
 *
 * Impact: Prevents workflow stalls from missing dispatches
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  shouldDispatchParent,
  dispatchParentIfNeeded,
  shouldRequireVerification,
} from 'jinn-node/worker/status/autoDispatch.js';
import type { FinalStatus, ParentDispatchDecision } from 'jinn-node/worker/types.js';

// Mock dependencies
vi.mock('jinn-node/logging/index.js', () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
  workerLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  configLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('jinn-node/http/client.js', () => ({
  graphQLRequest: vi.fn(async () => ({
    requests: { items: [] },
    request: { workstreamId: undefined }
  })),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getPonderGraphqlUrl: vi.fn(() => 'http://example.com/graphql'),
  getOptionalControlApiUrl: vi.fn(() => undefined),
}));

vi.mock('jinn-node/worker/mcp/tools.js', () => ({
  withJobContext: vi.fn(async (_ctx: any, fn: any) => fn()),
}));

vi.mock('jinn-node/agent/mcp/tools/dispatch_existing_job.js', () => ({
  dispatchExistingJob: vi.fn(),
}));

vi.mock('jinn-node/worker/tool_utils.js', () => ({
  safeParseToolResponse: vi.fn(),
}));

// Mock git integration utilities
vi.mock('jinn-node/worker/git/integration.js', () => ({
  isChildIntegrated: vi.fn(() => true), // Default: all children integrated
  batchFetchBranches: vi.fn(),
}));

// Mock fetchAllChildren for getUnintegratedChildren
vi.mock('jinn-node/worker/prompt/providers/context/fetchChildren.js', () => ({
  fetchAllChildren: vi.fn(async () => []),
}));

import { workerLogger } from 'jinn-node/logging/index.js';
import { dispatchExistingJob } from 'jinn-node/agent/mcp/tools/dispatch_existing_job.js';
import { safeParseToolResponse } from 'jinn-node/worker/tool_utils.js';
import { graphQLRequest } from 'jinn-node/http/client.js';
import { withJobContext } from 'jinn-node/worker/mcp/tools.js';
import { isChildIntegrated } from 'jinn-node/worker/git/integration.js';
import { fetchAllChildren } from 'jinn-node/worker/prompt/providers/context/fetchChildren.js';
import { claimParentDispatch } from 'jinn-node/worker/control_api_client.js';

vi.mock('jinn-node/worker/control_api_client.js', () => ({
  claimParentDispatch: vi.fn(async () => ({ allowed: true })),
}));

describe('parentDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (graphQLRequest as any).mockResolvedValue({
      requests: { items: [] },
      request: { workstreamId: undefined }
    });
    (withJobContext as any).mockImplementation(async (_ctx: any, fn: any) => fn());
    (claimParentDispatch as any).mockResolvedValue({ allowed: true });
  });

  const makeMetadata = (parentId: string) => ({
    sourceJobDefinitionId: parentId,
    lineage: {
      dispatcherBranchName: 'main',
      dispatcherBaseBranch: 'main',
      parentDispatcherRequestId: 'req-parent',
    },
    codeMetadata: {
      baseBranch: 'main',
      branch: { name: 'main' },
      repoRoot: '/tmp/repo',
    },
  });

  describe('shouldDispatchParent', () => {
    describe('should dispatch', () => {
      it('dispatches when all children are COMPLETED', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Job completed',
        };
        const metadata = {
          sourceJobDefinitionId: '0xparent123',
        };

        // Mock Ponder query to return all children as COMPLETED
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: [
              { id: 'child1', name: 'Child 1', lastStatus: 'COMPLETED' },
              { id: 'child2', name: 'Child 2', lastStatus: 'COMPLETED' }
            ]
          }
        });

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result).toEqual({
          shouldDispatch: true,
          parentJobDefId: '0xparent123',
        });
      });

      it('dispatches when all children are in terminal states (COMPLETED or FAILED)', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Job completed',
        };
        const metadata = {
          sourceJobDefinitionId: '0xparent456',
        };

        // Mix of COMPLETED and FAILED (both terminal)
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: [
              { id: 'child1', name: 'Child 1', lastStatus: 'COMPLETED' },
              { id: 'child2', name: 'Child 2', lastStatus: 'FAILED' }
            ]
          }
        });

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result).toEqual({
          shouldDispatch: true,
          parentJobDefId: '0xparent456',
        });
      });

      it('dispatches when no children exist (fallback safety)', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Job completed',
        };
        const metadata = {
          sourceJobDefinitionId: '0xparent789',
        };

        // No children found
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: []
          }
        });

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result).toEqual({
          shouldDispatch: true,
          parentJobDefId: '0xparent789',
        });
      });
    });

    describe('should not dispatch', () => {
      it('does not dispatch when status is WAITING', async () => {
        const finalStatus: FinalStatus = {
          status: 'WAITING',
          message: 'Waiting for children',
        };
        const metadata = {
          sourceJobDefinitionId: '0xparent123',
        };

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result.shouldDispatch).toBe(false);
        expect(result.reason).toContain('not terminal');
      });

      it('does not dispatch when status is DELEGATING', async () => {
        const finalStatus: FinalStatus = {
          status: 'DELEGATING',
          message: 'Dispatched children',
        };
        const metadata = {
          sourceJobDefinitionId: '0xparent123',
        };

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result.shouldDispatch).toBe(false);
        expect(result.reason).toContain('not terminal');
      });

      it('does not dispatch when any child has WAITING status', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Job completed',
        };
        const metadata = {
          sourceJobDefinitionId: '0xparent123',
        };

        // One child COMPLETED, one WAITING
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: [
              { id: 'child1', name: 'Child 1', lastStatus: 'COMPLETED' },
              { id: 'child2', name: 'Child 2', lastStatus: 'WAITING' }
            ]
          }
        });

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result.shouldDispatch).toBe(false);
        expect(result.reason).toContain('Waiting for');
        expect(result.reason).toContain('children to complete');
      });

      it('does not dispatch when any child has DELEGATING status', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Job completed',
        };
        const metadata = {
          sourceJobDefinitionId: '0xparent456',
        };

        // One child COMPLETED, one DELEGATING
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: [
              { id: 'child1', name: 'Child 1', lastStatus: 'COMPLETED' },
              { id: 'child2', name: 'Child 2', lastStatus: 'DELEGATING' }
            ]
          }
        });

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result.shouldDispatch).toBe(false);
        expect(result.reason).toContain('Waiting for');
        expect(result.reason).toContain('children to complete');
      });

      it('does not dispatch when Ponder query fails (fail-safe)', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Job completed',
        };
        const metadata = {
          sourceJobDefinitionId: '0xparent789',
        };

        // Mock query failure
        (graphQLRequest as any).mockRejectedValue(new Error('Network error'));

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result.shouldDispatch).toBe(false);
        expect(result.reason).toContain('Failed to verify');
      });

      it('does not dispatch when finalStatus is null', async () => {
        const metadata = {
          sourceJobDefinitionId: '0xparent123',
        };

        const result = await shouldDispatchParent(null, metadata);

        expect(result.shouldDispatch).toBe(false);
        expect(result.reason).toContain('not terminal');
      });

      it('does not dispatch when parent job ID is missing', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Job completed',
        };
        const metadata = {};

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result.shouldDispatch).toBe(false);
        expect(result.reason).toBe('No parent job in metadata or Ponder');
      });

      it('does not dispatch when metadata is null', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Job completed',
        };

        const result = await shouldDispatchParent(finalStatus, null);

        expect(result.shouldDispatch).toBe(false);
        expect(result.reason).toBe('No parent job in metadata or Ponder');
      });

      it('does not dispatch when sourceJobDefinitionId is undefined', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Job completed',
        };
        const metadata = {
          sourceJobDefinitionId: undefined,
        };

        const result = await shouldDispatchParent(finalStatus, metadata);

        expect(result.shouldDispatch).toBe(false);
        expect(result.reason).toBe('No parent job in metadata or Ponder');
      });
    });
  });

  describe('dispatchParentIfNeeded', () => {
    describe('skips dispatch', () => {
      it('skips when should not dispatch', async () => {
        const finalStatus: FinalStatus = {
          status: 'WAITING',
          message: 'Waiting',
        };
        const metadata = {
          sourceJobDefinitionId: '0xparent123',
        };

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', 'output');

        expect(workerLogger.debug).toHaveBeenCalledWith(
          expect.objectContaining({ requestId: '0xchild' }),
          expect.stringContaining('Not dispatching parent')
        );
        expect(dispatchExistingJob).not.toHaveBeenCalled();
      });

      it('skips when no parent job', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Completed',
        };
        const metadata = {};

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', 'output');

        expect(dispatchExistingJob).not.toHaveBeenCalled();
      });

      it('skips when parent dispatch is claimed by sibling (deduplication)', async () => {
        const finalStatus: FinalStatus = { status: 'COMPLETED', message: 'Done' };
        const metadata = { jobDefinitionId: '0xchild', ...makeMetadata('0xparent123') };

        // Mock children complete for parent, but no children for child (steps verification)
        (graphQLRequest as any).mockImplementation(async (args: any) => {
          if (args.variables?.parentJobDefId === '0xparent123') {
            return {
              jobDefinitions: {
                items: [{ id: 'child1', lastStatus: 'COMPLETED' }]
              },
              request: { workstreamId: undefined }
            };
          }
          return {
            jobDefinitions: { items: [] },
            request: { workstreamId: undefined }
          };
        });

        // Mock claim failed
        (claimParentDispatch as any).mockResolvedValue({
          allowed: false,
          claimed_by: 'sibling-worker'
        });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', 'output');

        expect(claimParentDispatch).toHaveBeenCalledWith('0xparent123', '0xchild');
        expect(dispatchExistingJob).not.toHaveBeenCalled();
        expect(workerLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({ claimingSibling: 'sibling-worker' }),
          expect.stringContaining('Skipping parent dispatch')
        );
      });
    });

    describe('performs dispatch', () => {
      beforeEach(() => {
        (safeParseToolResponse as any).mockReturnValue({ ok: true });
      });

      it('dispatches parent on COMPLETED when all children complete', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'All tasks done',
        };
        const metadata = makeMetadata('0xparent123');

        // Mock all children as complete
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: [
              { id: 'child1', name: 'Child 1', lastStatus: 'COMPLETED' }
            ]
          },
          request: { workstreamId: undefined }
        });

        (dispatchExistingJob as any).mockResolvedValue({ ok: true });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild456', 'Task output');

        expect(workerLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            parentJobDefId: '0xparent123',
            childRequestId: '0xchild456',
          }),
          expect.stringContaining('dispatched successfully')
        );
        expect(dispatchExistingJob).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: '0xparent123',
            message: expect.stringContaining('Child job COMPLETED'),
            workstreamId: undefined,
            // NOTE: completedChildRuns was removed - parent fetches via Ponder directly
          })
        );
      });

      it('dispatches parent on FAILED when all children complete', async () => {
        const finalStatus: FinalStatus = {
          status: 'FAILED',
          message: 'Job failed: timeout',
        };
        const metadata = makeMetadata('0xparent789');

        // Mock all children as complete
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: [
              { id: 'child1', name: 'Child 1', lastStatus: 'COMPLETED' }
            ]
          },
          request: { workstreamId: undefined }
        });

        (dispatchExistingJob as any).mockResolvedValue({ ok: true });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', 'Error output');

        expect(dispatchExistingJob).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: '0xparent789',
            message: expect.stringContaining('Child job FAILED'),
            workstreamId: undefined,
            // NOTE: completedChildRuns was removed - parent fetches via Ponder directly
          })
        );
      });

      it('includes status message in dispatch', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'All 3 children delivered',
        };
        const metadata = makeMetadata('0xparent');

        // Mock all children as complete
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: []
          },
          request: { workstreamId: undefined }
        });

        (dispatchExistingJob as any).mockResolvedValue({ ok: true });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', 'output');

        const call = (dispatchExistingJob as any).mock.calls[0][0];
        const messageContent = JSON.parse(call.message).content;
        expect(messageContent).toContain('All 3 children delivered');
        expect(call.jobId).toBe('0xparent');
        expect(call.workstreamId).toBeUndefined();
      });

      it('includes child output in dispatch', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Done',
        };
        const metadata = makeMetadata('0xparent');
        const output = 'Generated report with 50 records';

        // Mock all children as complete
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: []
          },
          request: { workstreamId: undefined }
        });

        (dispatchExistingJob as any).mockResolvedValue({ ok: true });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', output);

        const call = (dispatchExistingJob as any).mock.calls[0][0];
        const messageContent = JSON.parse(call.message).content;
        expect(messageContent).toContain('Generated report with 50 records');
        expect(call.jobId).toBe('0xparent');
        expect(call.workstreamId).toBeUndefined();
      });

      it('truncates long output to 500 chars', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Done',
        };
        const metadata = makeMetadata('0xparent');
        const longOutput = 'x'.repeat(600);

        // Mock all children as complete
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: []
          },
          request: { workstreamId: undefined }
        });

        (dispatchExistingJob as any).mockResolvedValue({ ok: true });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', longOutput);

        const call = (dispatchExistingJob as any).mock.calls[0][0];
        const messageContent = JSON.parse(call.message).content;

        expect(messageContent).toContain('...');
        expect(messageContent.length).toBeLessThan(600);
      });

      it('creates message with correct structure', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Done',
        };
        const metadata = makeMetadata('0xparent');

        // Mock all children as complete
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: []
          },
          request: { workstreamId: undefined }
        });

        (dispatchExistingJob as any).mockResolvedValue({ ok: true });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild123', 'output');

        const call = (dispatchExistingJob as any).mock.calls[0][0];
        const message = JSON.parse(call.message);

        expect(message).toMatchObject({
          to: '0xparent',
          from: '0xchild123',
        });
        expect(message.content).toBeDefined();
      });

      it('logs success when dispatch succeeds', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Done',
        };
        const metadata = makeMetadata('0xparent');

        // Mock all children as complete
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: []
          },
          request: { workstreamId: undefined }
        });

        (dispatchExistingJob as any).mockResolvedValue({ ok: true });
        (safeParseToolResponse as any).mockReturnValue({ ok: true, data: { request_ids: ['req-new'] } });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', 'output');

        expect(workerLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            parentJobDefId: '0xparent',
            childRequestId: '0xchild',
            newRequestId: 'req-new',
          }),
          expect.stringContaining('dispatched successfully')
        );
      });

      it('logs error when dispatch fails', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Done',
        };
        const metadata = makeMetadata('0xparent');

        // Mock all children as complete
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: {
            items: []
          },
          request: { workstreamId: undefined }
        });

        (dispatchExistingJob as any).mockResolvedValue({ ok: false });
        (safeParseToolResponse as any).mockReturnValue({
          ok: false,
          message: 'Invalid job ID',
        });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', 'output');

        expect(workerLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            parentJobDefId: '0xparent',
            childRequestId: '0xchild',
            error: 'Invalid job ID',
          }),
          expect.stringContaining('Failed to dispatch parent job')
        );
      });

      it('handles dispatch exceptions gracefully', async () => {
        const finalStatus: FinalStatus = {
          status: 'COMPLETED',
          message: 'Done',
        };
        const metadata = makeMetadata('0xparent');

        // Mock all children as complete
        let graphQLCallCount = 0;
        (graphQLRequest as any).mockImplementation(async () => {
          graphQLCallCount++;
          // First call is for shouldDispatchParent check
          if (graphQLCallCount === 1) {
            return {
              jobDefinitions: {
                items: []
              }
            };
          }
          // Second call is for workstream query
          return {
            request: { workstreamId: undefined }
          };
        });

        // Mock withJobContext to throw on all attempts
        // The retry loop will retry 3 times with backoff (2s, 4s) = ~6s minimum
        // Then the error is caught in the outer catch block
        let callCount = 0;
        (withJobContext as any).mockImplementation(async () => {
          callCount++;
          throw new Error('Network error');
        });

        await dispatchParentIfNeeded(finalStatus, metadata, '0xchild', 'output');

        // Verify it was called multiple times (retry loop)
        expect(callCount).toBeGreaterThan(1);

        // The error is caught in the inner catch block, and after retries exhaust,
        // dispatchResult is undefined, so error is logged with undefined message
        expect(workerLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            parentJobDefId: '0xparent',
            childRequestId: '0xchild',
          }),
          expect.stringContaining('Failed to dispatch parent job')
        );
      }, 20000); // Increase timeout to accommodate retry loop with backoff (2s + 4s = 6s minimum)
    });
  });

  describe('verification run parent dispatch', () => {
    it('dispatches parent when verification run completes without delegating', async () => {
      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
        message: 'Verification passed',
      };
      // Verification run metadata - note verificationRequired: true
      const metadata = {
        jobDefinitionId: '0xchild-job',
        sourceJobDefinitionId: '0xparent-job',
        additionalContext: {
          verificationRequired: true,
          verificationAttempt: 1,
        },
        lineage: {
          dispatcherBranchName: 'main',
          dispatcherBaseBranch: 'main',
          parentDispatcherRequestId: 'req-parent',
        },
      };

      // Mock children check - all complete
      (graphQLRequest as any).mockResolvedValue({
        jobDefinitions: { items: [] },
        request: { workstreamId: '0xworkstream' }
      });
      (dispatchExistingJob as any).mockResolvedValue({ ok: true, request_ids: ['0xnew'] });
      (safeParseToolResponse as any).mockReturnValue({
        ok: true,
        data: { request_ids: ['0xnew'] }
      });

      await dispatchParentIfNeeded(finalStatus, metadata, '0xchild-req', 'Verification output');

      // Should log that verification run is proceeding to parent dispatch
      expect(workerLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          jobDefinitionId: '0xchild-job',
          verificationAttempt: 1,
        }),
        expect.stringContaining('Verification run completed - proceeding to parent dispatch check')
      );

      // Should dispatch the parent
      expect(dispatchExistingJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: '0xparent-job',
        })
      );
    });
  });

  describe('Ponder parent query fallback', () => {
    it('queries Ponder when metadata.sourceJobDefinitionId is missing', async () => {
      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
        message: 'Job done',
      };
      const metadata = {
        jobDefinitionId: '0xchild-job',
        // sourceJobDefinitionId is missing!
        lineage: {
          dispatcherBranchName: 'main',
        },
      };

      // First call: getJobDefParent query returns the parent
      // Second call: children query returns empty (all complete)
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          jobDefinition: { sourceJobDefinitionId: '0xparent-from-ponder' }
        })
        .mockResolvedValueOnce({
          jobDefinitions: { items: [] }
        });

      const result = await shouldDispatchParent(finalStatus, metadata);

      expect(result.shouldDispatch).toBe(true);
      expect(result.parentJobDefId).toBe('0xparent-from-ponder');

      // Should log that it used Ponder
      expect(workerLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          jobDefinitionId: '0xchild-job',
          ponderParent: '0xparent-from-ponder',
        }),
        expect.stringContaining('Using authoritative parent from Ponder')
      );
    });

    it('queries Ponder when metadata.sourceJobDefinitionId equals current job (self-referential)', async () => {
      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
        message: 'Job done',
      };
      const metadata = {
        jobDefinitionId: '0xchild-job',
        sourceJobDefinitionId: '0xchild-job', // Self-referential - bug from dispatch_existing_job
        lineage: {
          dispatcherBranchName: 'main',
        },
      };

      // First call: getJobDefParent query returns the real parent
      // Second call: children query returns empty
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          jobDefinition: { sourceJobDefinitionId: '0xreal-parent' }
        })
        .mockResolvedValueOnce({
          jobDefinitions: { items: [] }
        });

      const result = await shouldDispatchParent(finalStatus, metadata);

      expect(result.shouldDispatch).toBe(true);
      expect(result.parentJobDefId).toBe('0xreal-parent');

      // Should log the correction
      expect(workerLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          ponderParent: '0xreal-parent',
          metadataParent: '0xchild-job',
        }),
        expect.stringContaining('Using authoritative parent from Ponder')
      );
    });

    it('clears self-referential parent when Ponder returns null (root job)', async () => {
      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
        message: 'Root job done',
      };
      const metadata = {
        jobDefinitionId: '0xroot-job',
        sourceJobDefinitionId: '0xroot-job', // Self-referential from verification dispatch
        lineage: {
          dispatcherBranchName: 'main',
        },
      };

      // Ponder returns null for root job (no parent)
      (graphQLRequest as any)
        .mockResolvedValueOnce({
          jobDefinition: { sourceJobDefinitionId: null }
        });

      const result = await shouldDispatchParent(finalStatus, metadata);

      // Should NOT dispatch - this is a root job with no parent
      expect(result.shouldDispatch).toBe(false);
      expect(result.reason).toContain('No parent job');

      // Should log that it detected a root job
      expect(workerLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          jobDefinitionId: '0xroot-job',
          metadataParent: '0xroot-job',
        }),
        expect.stringContaining('Ponder confirms no parent (root job)')
      );
    });
  });

  describe('shouldRequireVerification', () => {
    describe('no verification needed', () => {
      it('returns false for non-COMPLETED status', async () => {
        const finalStatus: FinalStatus = { status: 'DELEGATING', message: 'Delegated' };
        const metadata = { jobDefinitionId: '0xjob' };

        const result = await shouldRequireVerification(finalStatus, metadata);

        expect(result.requiresVerification).toBe(false);
        expect(result.reason).toContain('Not a COMPLETED status');
      });

      it('returns false for job with no children', async () => {
        const finalStatus: FinalStatus = { status: 'COMPLETED', message: 'Done' };
        const metadata = { jobDefinitionId: '0xjob-no-children' };

        // Mock: no children found
        (graphQLRequest as any).mockResolvedValue({
          jobDefinitions: { items: [] }
        });

        const result = await shouldRequireVerification(finalStatus, metadata);

        expect(result.requiresVerification).toBe(false);
        expect(result.reason).toContain('no children');
      });

      it('returns false (already verification run)', async () => {
        const finalStatus: FinalStatus = { status: 'COMPLETED', message: 'Verified' };
        const metadata = {
          jobDefinitionId: '0xjob',
          additionalContext: {
            verificationRequired: true,
            verificationAttempt: 1
          }
        };

        const result = await shouldRequireVerification(finalStatus, metadata);

        expect(result.requiresVerification).toBe(false);
        expect(result.isVerificationRun).toBe(true);
        expect(result.reason).toContain('Already a verification run');
      });
    });

    describe('verification required', () => {
      it('returns true when children exist and all are integrated', async () => {
        const finalStatus: FinalStatus = { status: 'COMPLETED', message: 'Done' };
        const metadata = {
          jobDefinitionId: '0xparent-job',
          additionalContext: {
            completedChildRuns: [{ requestId: 'child1' }]
          }
        };

        // Mock: children all integrated
        (fetchAllChildren as any).mockResolvedValue([
          { jobDefinitionId: 'child1', jobName: 'Child 1', branchName: 'job/child1', status: 'COMPLETED' }
        ]);
        (isChildIntegrated as any).mockReturnValue(true);

        const result = await shouldRequireVerification(finalStatus, metadata);

        expect(result.requiresVerification).toBe(true);
        expect(result.reason).toContain('all children integrated');
      });
    });

    describe('needsContinuation', () => {
      it('returns needsContinuation when children exist but NOT integrated', async () => {
        const finalStatus: FinalStatus = { status: 'COMPLETED', message: 'Done' };
        const metadata = {
          jobDefinitionId: '0xparent-job',
          additionalContext: {
            completedChildRuns: [{ requestId: 'child1' }]
          }
        };

        // Mock: children exist but NOT integrated
        (fetchAllChildren as any).mockResolvedValue([
          { jobDefinitionId: 'child1', jobName: 'Child 1', branchName: 'job/child1', status: 'COMPLETED' }
        ]);
        (isChildIntegrated as any).mockReturnValue(false); // Child NOT integrated

        const result = await shouldRequireVerification(finalStatus, metadata);

        expect(result.requiresVerification).toBe(false);
        expect(result.needsContinuation).toBe(true);
        expect(result.reason).toContain('not yet integrated');
      });

      it('returns needsContinuation for multiple unintegrated children', async () => {
        const finalStatus: FinalStatus = { status: 'COMPLETED', message: 'Done' };
        const metadata = {
          jobDefinitionId: '0xparent-job',
          additionalContext: {
            completedChildRuns: [{ requestId: 'child1' }, { requestId: 'child2' }]
          }
        };

        // Mock: multiple children, none integrated
        (fetchAllChildren as any).mockResolvedValue([
          { jobDefinitionId: 'child1', jobName: 'Child 1', branchName: 'job/child1', status: 'COMPLETED' },
          { jobDefinitionId: 'child2', jobName: 'Child 2', branchName: 'job/child2', status: 'COMPLETED' }
        ]);
        (isChildIntegrated as any).mockReturnValue(false);

        const result = await shouldRequireVerification(finalStatus, metadata);

        expect(result.requiresVerification).toBe(false);
        expect(result.needsContinuation).toBe(true);
        expect(result.reason).toContain('2 children not yet integrated');
      });
    });
  });
});
