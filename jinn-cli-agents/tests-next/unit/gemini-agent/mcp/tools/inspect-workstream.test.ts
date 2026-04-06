/**
 * Unit tests for gemini-agent/mcp/tools/inspect-workstream.ts
 *
 * Tests the inspect_workstream MCP tool for workstream graph inspection.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { inspectWorkstream } from 'jinn-node/agent/mcp/tools/inspect-workstream.js';

// Mock the shared utilities
vi.mock('jinn-node/agent/mcp/tools/shared/inspection-utils.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('jinn-node/agent/mcp/tools/shared/inspection-utils.js')>();
  return {
    ...original,
    queryPonder: vi.fn(),
    fetchIpfsContentMcp: vi.fn(),
  };
});

vi.mock('jinn-node/agent/mcp/tools/shared/context.js', () => ({
  getCurrentJobContext: vi.fn(() => ({
    workstreamId: null,
  })),
}));

import { queryPonder, fetchIpfsContentMcp } from 'jinn-node/agent/mcp/tools/shared/inspection-utils.js';
import { getCurrentJobContext } from 'jinn-node/agent/mcp/tools/shared/context.js';

describe('inspectWorkstream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validation', () => {
    it('validates required workstream_id field', async () => {
      const result = await inspectWorkstream({});
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('validates workstream_id is not empty', async () => {
      const result = await inspectWorkstream({ workstream_id: '' });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('validates limit is within bounds', async () => {
      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        limit: 500, // exceeds max of 200
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('validates sections enum values', async () => {
      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        sections: ['invalid_section'],
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('current workstream resolution', () => {
    it('resolves "current" to actual workstream ID from context', async () => {
      (getCurrentJobContext as any).mockReturnValue({
        workstreamId: '0xresolved-workstream',
      });

      (queryPonder as any)
        .mockResolvedValueOnce({
          data: {
            requests: {
              items: [
                {
                  id: '0xrequest1',
                  jobName: 'Test Job',
                  delivered: true,
                },
              ],
            },
          },
        })
        .mockResolvedValueOnce({ data: { artifacts: { items: [] } } });

      const result = await inspectWorkstream({
        workstream_id: 'current',
        sections: [],
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.workstreamId).toBe('0xresolved-workstream');
    });

    it('returns validation error when "current" used but no context', async () => {
      (getCurrentJobContext as any).mockReturnValue({
        workstreamId: null,
      });

      const result = await inspectWorkstream({ workstream_id: 'current' });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
      expect(response.meta.message).toContain('No current workstream context');
    });
  });

  describe('not found handling', () => {
    it('returns NOT_FOUND when workstream has no requests', async () => {
      (queryPonder as any).mockResolvedValue({
        data: { requests: { items: [] } },
      });

      const result = await inspectWorkstream({ workstream_id: '0xnonexistent' });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('NOT_FOUND');
      expect(response.meta.message).toContain('0xnonexistent');
    });
  });

  describe('successful inspection', () => {
    it('returns basic stats when found', async () => {
      (queryPonder as any)
        .mockResolvedValueOnce({
          data: {
            requests: {
              items: [
                {
                  id: '0xrequest1',
                  jobName: 'Root Job',
                  jobDefinitionId: 'def-1',
                  delivered: true,
                },
                {
                  id: '0xrequest2',
                  jobName: 'Child Job',
                  jobDefinitionId: 'def-2',
                  sourceRequestId: '0xrequest1',
                  delivered: false,
                },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            artifacts: {
              items: [
                { id: 'art1', requestId: '0xrequest1', name: 'Artifact 1', topic: 'DATA', cid: 'Qm1' },
              ],
            },
          },
        });

      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        sections: [], // No additional sections
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.workstreamId).toBe('0xworkstream');
      expect(response.data.stats.uniqueJobs).toBe(2);
      expect(response.data.stats.totalJobRuns).toBe(2);
      expect(response.data.stats.completedRuns).toBe(1);
      expect(response.data.stats.pendingRuns).toBe(1);
      expect(response.data.stats.totalArtifacts).toBe(1);
      expect(response.data.jobs).toHaveLength(2);
    });

    it('calculates correct depth for nested jobs', async () => {
      (queryPonder as any)
        .mockResolvedValueOnce({
          data: {
            requests: {
              items: [
                { id: '0xroot', jobName: 'Root', delivered: true },
                { id: '0xchild', jobName: 'Child', sourceRequestId: '0xroot', delivered: true },
                { id: '0xgrandchild', jobName: 'Grandchild', sourceRequestId: '0xchild', delivered: true },
              ],
            },
          },
        })
        .mockResolvedValueOnce({ data: { artifacts: { items: [] } } });

      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        sections: [],
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.jobs).toHaveLength(3);

      const root = response.data.jobs.find((j: any) => j.requestId === '0xroot');
      const child = response.data.jobs.find((j: any) => j.requestId === '0xchild');
      const grandchild = response.data.jobs.find((j: any) => j.requestId === '0xgrandchild');

      expect(root.depth).toBe(0);
      expect(child.depth).toBe(1);
      expect(grandchild.depth).toBe(2);
    });
  });

  describe('filtering', () => {
    it('filters by status', async () => {
      (queryPonder as any)
        .mockResolvedValueOnce({
          data: {
            requests: {
              items: [
                { id: '0xcompleted', delivered: true },
                { id: '0xpending', delivered: false },
              ],
            },
          },
        })
        .mockResolvedValueOnce({ data: { artifacts: { items: [] } } });

      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        status: 'completed',
        sections: [],
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.jobs).toHaveLength(1);
      expect(response.data.jobs[0].requestId).toBe('0xcompleted');
    });

    it('filters by job name pattern', async () => {
      (queryPonder as any)
        .mockResolvedValueOnce({
          data: {
            requests: {
              items: [
                { id: '0x1', jobName: 'Research Task', delivered: true },
                { id: '0x2', jobName: 'Analysis Task', delivered: true },
                { id: '0x3', jobName: 'Data Collection', delivered: true },
              ],
            },
          },
        })
        .mockResolvedValueOnce({ data: { artifacts: { items: [] } } });

      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        job_name: 'task',
        sections: [],
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.jobs).toHaveLength(2);
    });

    it('filters by depth', async () => {
      (queryPonder as any)
        .mockResolvedValueOnce({
          data: {
            requests: {
              items: [
                { id: '0xroot', delivered: true },
                { id: '0xchild', sourceRequestId: '0xroot', delivered: true },
                { id: '0xgrandchild', sourceRequestId: '0xchild', delivered: true },
              ],
            },
          },
        })
        .mockResolvedValueOnce({ data: { artifacts: { items: [] } } });

      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        depth: 1, // Only root and children
        sections: [],
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.jobs).toHaveLength(2);
    });
  });

  describe('sections', () => {
    it('includes errors section when requested', async () => {
      (queryPonder as any)
        .mockResolvedValueOnce({
          data: {
            requests: {
              items: [{ id: '0xrequest', delivered: true }],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            artifacts: {
              items: [
                { id: 'art1', requestId: '0xrequest', topic: 'WORKER_TELEMETRY', cid: 'QmTelemetry' },
              ],
            },
          },
        });

      (fetchIpfsContentMcp as any).mockResolvedValue({
        version: 'worker-telemetry-v1',
        requestId: '0xrequest',
        events: [
          { event: 'error', phase: 'execution', error: 'Test error', timestamp: '2025-01-01T00:00:00Z' },
        ],
      });

      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        sections: ['errors'],
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.errors).toBeDefined();
      expect(response.data.errors.total).toBe(1);
    });
  });

  describe('error handling', () => {
    it('handles GraphQL query failure', async () => {
      (queryPonder as any).mockResolvedValue({
        data: null,
        error: 'Connection refused',
      });

      const result = await inspectWorkstream({ workstream_id: '0xworkstream' });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('EXECUTION_ERROR');
      expect(response.meta.message).toContain('Connection refused');
    });
  });

  describe('pagination', () => {
    it('returns has_more when more jobs exist', async () => {
      const manyJobs = Array.from({ length: 60 }, (_, i) => ({
        id: `0xjob${i}`,
        delivered: true,
      }));

      (queryPonder as any)
        .mockResolvedValueOnce({
          data: { requests: { items: manyJobs } },
        })
        .mockResolvedValueOnce({ data: { artifacts: { items: [] } } });

      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        limit: 50,
        sections: [],
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.meta.has_more).toBe(true);
      expect(response.meta.next_cursor).toBeDefined();
    });
  });

  describe('MCP response format', () => {
    it('returns proper MCP content array format', async () => {
      (queryPonder as any)
        .mockResolvedValueOnce({
          data: {
            requests: {
              items: [{ id: '0xrequest', delivered: true }],
            },
          },
        })
        .mockResolvedValueOnce({ data: { artifacts: { items: [] } } });

      const result = await inspectWorkstream({
        workstream_id: '0xworkstream',
        sections: [],
      });

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });
  });
});
