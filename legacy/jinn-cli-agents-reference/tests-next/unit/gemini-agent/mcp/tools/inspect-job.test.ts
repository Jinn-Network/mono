/**
 * Unit tests for gemini-agent/mcp/tools/inspect-job.ts
 *
 * Tests the inspect_job MCP tool for job definition history inspection.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { inspectJob } from 'jinn-node/agent/mcp/tools/inspect-job.js';

// Mock the shared utilities
vi.mock('jinn-node/agent/mcp/tools/shared/inspection-utils.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('jinn-node/agent/mcp/tools/shared/inspection-utils.js')>();
  return {
    ...original,
    queryPonder: vi.fn(),
    fetchIpfsContentMcp: vi.fn(),
  };
});

import { queryPonder, fetchIpfsContentMcp } from 'jinn-node/agent/mcp/tools/shared/inspection-utils.js';

describe('inspectJob', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('validation', () => {
    it('validates required job_definition_id field', async () => {
      const result = await inspectJob({});
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('validates job_definition_id is a valid UUID', async () => {
      const result = await inspectJob({ job_definition_id: 'not-a-uuid' });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('validates max_runs is within bounds', async () => {
      const result = await inspectJob({
        job_definition_id: '12345678-1234-1234-1234-123456789abc',
        max_runs: 100, // exceeds max of 50
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('not found handling', () => {
    it('returns NOT_FOUND when job definition does not exist', async () => {
      (queryPonder as any).mockResolvedValue({ data: { jobDefinition: null } });

      const result = await inspectJob({
        job_definition_id: '12345678-1234-1234-1234-123456789abc',
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('NOT_FOUND');
      expect(response.meta.message).toContain('12345678-1234-1234-1234-123456789abc');
    });
  });

  describe('successful inspection', () => {
    it('returns job definition info when found', async () => {
      (queryPonder as any)
        .mockResolvedValueOnce({
          data: {
            jobDefinition: {
              id: '12345678-1234-1234-1234-123456789abc',
              name: 'Test Job Definition',
              lastStatus: 'COMPLETED',
              model: 'gemini-2.5-flash',
              enabledTools: '["get_details", "create_artifact"]',
              createdAt: '2025-01-01T00:00:00Z',
            },
          },
        })
        .mockResolvedValueOnce({ data: { requests: { items: [] } } }) // runs
        .mockResolvedValueOnce({ data: { requests: { items: [] } } }); // children

      const result = await inspectJob({
        job_definition_id: '12345678-1234-1234-1234-123456789abc',
        include_runs: false,
        include_children: false,
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.jobDefinition.id).toBe('12345678-1234-1234-1234-123456789abc');
      expect(response.data.jobDefinition.name).toBe('Test Job Definition');
      expect(response.data.jobDefinition.enabledTools).toEqual(['get_details', 'create_artifact']);
    });

    it('includes runs when requested', async () => {
      // Use mockImplementation to handle multiple queries dynamically
      (queryPonder as any).mockImplementation((query: string, variables: any) => {
        if (query.includes('GetJobDefinition')) {
          return Promise.resolve({
            data: {
              jobDefinition: {
                id: '12345678-1234-1234-1234-123456789abc',
                name: 'Test Job',
              },
            },
          });
        }
        if (query.includes('GetJobRuns')) {
          return Promise.resolve({
            data: {
              requests: {
                items: [
                  { id: '0xrun1', delivered: true, blockTimestamp: '2025-01-01T00:00:00Z' },
                  { id: '0xrun2', delivered: false, blockTimestamp: '2025-01-02T00:00:00Z' },
                ],
              },
            },
          });
        }
        if (query.includes('GetChildJobs')) {
          return Promise.resolve({ data: { requests: { items: [] } } });
        }
        if (query.includes('GetTelemetryArtifact')) {
          return Promise.resolve({ data: { artifacts: { items: [] } } });
        }
        return Promise.resolve({ data: null });
      });

      const result = await inspectJob({
        job_definition_id: '12345678-1234-1234-1234-123456789abc',
        include_runs: true,
        include_children: false,
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.summary.totalRuns).toBe(2);
      expect(response.data.summary.completedRuns).toBe(1);
      expect(response.data.summary.pendingRuns).toBe(1);
      expect(response.data.runs).toHaveLength(2);
    });

    it('includes children when requested', async () => {
      (queryPonder as any).mockImplementation((query: string) => {
        if (query.includes('GetJobDefinition')) {
          return Promise.resolve({
            data: {
              jobDefinition: {
                id: '12345678-1234-1234-1234-123456789abc',
                name: 'Parent Job',
              },
            },
          });
        }
        if (query.includes('GetJobRuns')) {
          return Promise.resolve({ data: { requests: { items: [] } } });
        }
        if (query.includes('GetChildJobs')) {
          return Promise.resolve({
            data: {
              requests: {
                items: [
                  { id: '0xchild1', jobName: 'Child Job 1', delivered: true },
                  { id: '0xchild2', jobName: 'Child Job 2', delivered: false },
                ],
              },
            },
          });
        }
        return Promise.resolve({ data: null });
      });

      const result = await inspectJob({
        job_definition_id: '12345678-1234-1234-1234-123456789abc',
        include_runs: false,
        include_children: true,
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.summary.totalChildren).toBe(2);
      expect(response.data.children).toHaveLength(2);
      expect(response.data.children[0].jobName).toBe('Child Job 1');
    });
  });

  describe('error handling', () => {
    it('handles GraphQL query failure', async () => {
      (queryPonder as any).mockImplementation((query: string) => {
        if (query.includes('GetJobDefinition')) {
          return Promise.resolve({ data: null, error: 'Connection refused' });
        }
        return Promise.resolve({ data: null });
      });

      const result = await inspectJob({
        job_definition_id: '12345678-1234-1234-1234-123456789abc',
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('EXECUTION_ERROR');
      expect(response.meta.message).toContain('Connection refused');
    });
  });

  describe('pagination', () => {
    it('returns has_more when more runs exist', async () => {
      const manyRuns = Array.from({ length: 15 }, (_, i) => ({
        id: `0xrun${i}`,
        delivered: true,
        blockTimestamp: `2025-01-0${(i % 9) + 1}T00:00:00Z`,
      }));

      (queryPonder as any).mockImplementation((query: string) => {
        if (query.includes('GetJobDefinition')) {
          return Promise.resolve({
            data: {
              jobDefinition: {
                id: '12345678-1234-1234-1234-123456789abc',
                name: 'Test Job',
              },
            },
          });
        }
        if (query.includes('GetJobRuns')) {
          return Promise.resolve({ data: { requests: { items: manyRuns } } });
        }
        if (query.includes('GetChildJobs')) {
          return Promise.resolve({ data: { requests: { items: [] } } });
        }
        if (query.includes('GetTelemetryArtifact')) {
          return Promise.resolve({ data: { artifacts: { items: [] } } });
        }
        return Promise.resolve({ data: null });
      });

      const result = await inspectJob({
        job_definition_id: '12345678-1234-1234-1234-123456789abc',
        max_runs: 10,
        include_children: false,
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
            jobDefinition: {
              id: '12345678-1234-1234-1234-123456789abc',
            },
          },
        })
        .mockResolvedValue({ data: { requests: { items: [] } } });

      const result = await inspectJob({
        job_definition_id: '12345678-1234-1234-1234-123456789abc',
        include_runs: false,
        include_children: false,
      });

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });
  });
});
