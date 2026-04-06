/**
 * Unit tests for gemini-agent/mcp/tools/search-jobs.ts
 *
 * Tests job search MCP tool - searches job definitions by name/description.
 *
 * Priority: P1 (High Priority)
 * Business Impact: Agent Functionality - Discovery
 * Coverage Target: 100% of search logic
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { searchJobs } from 'jinn-node/agent/mcp/tools/search-jobs.js';

// Mock dependencies
vi.mock('cross-fetch', () => ({
  default: vi.fn(),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/context-management.js', () => ({
  composeSinglePageResponse: vi.fn((data: any, options: any) => ({
    data,
    meta: {
      hasMore: false,
      nextCursor: null,
      ...options.requestedMeta,
    },
  })),
  decodeCursor: vi.fn((cursor: any) => cursor ? { offset: 10 } : { offset: 0 }),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/context.js', () => ({
  getCurrentJobContext: vi.fn(() => ({
    workstreamId: null, // Default to null (global search) for existing tests
    jobId: null,
    jobDefinitionId: null,
    jobName: null,
    threadId: null,
    requestId: null,
    mechAddress: null,
    baseBranch: null,
    parentRequestId: null,
    branchName: null,
    requiredTools: null,
    availableTools: null,
  })),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getPonderGraphqlUrl: vi.fn(() => {
    if (process.env.PONDER_GRAPHQL_URL) {
      return process.env.PONDER_GRAPHQL_URL;
    }
    if (process.env.PONDER_PORT) {
      return `http://localhost:${process.env.PONDER_PORT}/graphql`;
    }
    return 'http://localhost:42069/graphql';
  }),
  getPonderPort: vi.fn(() => process.env.PONDER_PORT ? parseInt(process.env.PONDER_PORT) : 42069),
}));

import fetch from 'cross-fetch';
import { composeSinglePageResponse, decodeCursor } from 'jinn-node/agent/mcp/tools/shared/context-management.js';
import { getCurrentJobContext } from 'jinn-node/agent/mcp/tools/shared/context.js';

describe('searchJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PONDER_GRAPHQL_URL;
    delete process.env.PONDER_PORT;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('validation', () => {
    it('validates required query field', async () => {
      const params = {};

      const result = await searchJobs(params as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
      expect(response.meta.message).toContain('query');
    });

    it('validates minimum length for query (min 1 char)', async () => {
      const params = { query: '' };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('accepts query with only required field', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'test' };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
    });

    it('accepts query with all optional fields', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = {
        query: 'test',
        cursor: 'cursor-123',
        include_requests: false,
        max_requests_per_job: 5,
      };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
    });

    it('defaults include_requests to true when not provided', async () => {
      const mockJob = { id: 'job-1', name: 'Test Job' };

      (fetch as any).mockImplementation(async (url: string, options: any) => {
        const body = JSON.parse(options.body);
        if (body.query.includes('SearchJobs')) {
          return { json: async () => ({ data: { jobDefinitions: { items: [mockJob] } } }) };
        }
        // Requests query
        return { json: async () => ({ data: { requests: { items: [] } } }) };
      });

      const params = { query: 'test' };

      await searchJobs(params);

      // Should make 2 calls: 1 for jobs, 1 for requests
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('defaults max_requests_per_job to 10 when not provided', async () => {
      const mockJob = { id: 'job-1', name: 'Test Job' };

      (fetch as any).mockImplementation(async (url: string, options: any) => {
        const body = JSON.parse(options.body);
        if (body.query.includes('SearchJobs')) {
          return { json: async () => ({ data: { jobDefinitions: { items: [mockJob] } } }) };
        }
        // Check requests query limit
        expect(body.variables.limit).toBe(10);
        return { json: async () => ({ data: { requests: { items: [] } } }) };
      });

      const params = { query: 'test' };

      await searchJobs(params);
    });
  });

  describe('GraphQL query construction', () => {
    it('searches by name and blueprint', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'my-search-term' };

      await searchJobs(params);

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.query).toContain('name_contains');
      expect(body.query).toContain('blueprint_contains');
      expect(body.variables.q).toBe('my-search-term');
    });

    it('uses correct GraphQL endpoint from env', async () => {
      vi.stubEnv('PONDER_GRAPHQL_URL', 'http://custom:9999/graphql');

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'test' };

      await searchJobs(params);

      expect(fetch).toHaveBeenCalledWith(
        'http://custom:9999/graphql',
        expect.any(Object)
      );
    });

    it('falls back to default endpoint when env not set', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'test' };

      await searchJobs(params);

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:42069/graphql',
        expect.any(Object)
      );
    });

    it('uses PONDER_PORT env variable', async () => {
      vi.stubEnv('PONDER_PORT', '8080');

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'test' };

      await searchJobs(params);

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:8080/graphql',
        expect.any(Object)
      );
    });
  });

  describe('request enrichment', () => {
    it('includes requests when include_requests=true', async () => {
      const mockJob = { id: 'job-1', name: 'Test Job' };
      const mockRequest = { id: '0xRequest1', jobName: 'Test Job' };

      (fetch as any).mockImplementation(async (url: string, options: any) => {
        const body = JSON.parse(options.body);
        if (body.query.includes('SearchJobs')) {
          return { json: async () => ({ data: { jobDefinitions: { items: [mockJob] } } }) };
        }
        return { json: async () => ({ data: { requests: { items: [mockRequest] } } }) };
      });

      const params = { query: 'test', include_requests: true };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.data[0].requests).toEqual([mockRequest]);
    });

    it('excludes requests when include_requests=false', async () => {
      const mockJob = { id: 'job-1', name: 'Test Job' };

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [mockJob] } } }),
      });

      const params = { query: 'test', include_requests: false };

      await searchJobs(params);

      // Should only call once (for jobs, not requests)
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('respects max_requests_per_job limit', async () => {
      const mockJob = { id: 'job-1', name: 'Test Job' };

      (fetch as any).mockImplementation(async (url: string, options: any) => {
        const body = JSON.parse(options.body);
        if (body.query.includes('SearchJobs')) {
          return { json: async () => ({ data: { jobDefinitions: { items: [mockJob] } } }) };
        }
        expect(body.variables.limit).toBe(5);
        return { json: async () => ({ data: { requests: { items: [] } } }) };
      });

      const params = { query: 'test', max_requests_per_job: 5 };

      await searchJobs(params);
    });

    it('handles request fetch failure gracefully', async () => {
      const mockJob = { id: 'job-1', name: 'Test Job' };

      (fetch as any).mockImplementation(async (url: string, options: any) => {
        const body = JSON.parse(options.body);
        if (body.query.includes('SearchJobs')) {
          return { json: async () => ({ data: { jobDefinitions: { items: [mockJob] } } }) };
        }
        throw new Error('Request fetch failed');
      });

      const params = { query: 'test', include_requests: true };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data[0].requests).toEqual([]);
      expect(response.data[0].requestsError).toBe('Failed to fetch requests');
    });
  });

  describe('pagination', () => {
    it('calls composeSinglePageResponse with correct parameters', async () => {
      const mockJobs = [{ id: 'job-1', name: 'Job 1' }];

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: mockJobs } } }),
      });

      const params = { query: 'test', include_requests: false };

      await searchJobs(params);

      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        mockJobs,
        expect.objectContaining({
          startOffset: 0,
          truncateChars: 1000,
          perFieldMaxChars: 5000,
          pageTokenBudget: 10000,
        })
      );
    });

    it('uses cursor offset when provided', async () => {
      (decodeCursor as any).mockReturnValue({ offset: 20 });

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'test', cursor: 'cursor-abc' };

      await searchJobs(params);

      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          startOffset: 20,
        })
      );
    });

    it('includes requested meta in pagination', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = {
        query: 'test',
        cursor: 'cursor-123',
        include_requests: true,
        max_requests_per_job: 15,
      };

      await searchJobs(params);

      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          requestedMeta: {
            cursor: 'cursor-123',
            query: 'test',
            include_requests: true,
            max_requests_per_job: 15,
            workstreamId: null, // From mocked context
          },
        })
      );
    });
  });

  describe('response format', () => {
    it('returns empty array when no jobs found', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'nonexistent' };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data).toEqual([]);
    });

    it('returns jobs with correct structure', async () => {
      const mockJobs = [
        {
          id: 'job-1',
          name: 'Job 1',
          blueprint: 'Do task 1',
          enabledTools: '["tool1"]',
        },
      ];

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: mockJobs } } }),
      });

      const params = { query: 'test', include_requests: false };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.data).toEqual(mockJobs);
      expect(response.meta.type).toBe('job_definitions');
      expect(response.meta.source).toBe('ponder');
    });

    it('returns MCP content array format', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'test' };

      const result = await searchJobs(params);

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
    });
  });

  describe('error handling', () => {
    it('handles fetch exception', async () => {
      (fetch as any).mockRejectedValue(new Error('Network error'));

      const params = { query: 'test' };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('UNEXPECTED_ERROR');
      expect(response.meta.message).toContain('Network error');
      expect(response.data).toEqual([]);
    });

    it('handles malformed GraphQL response', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ errors: [{ message: 'Invalid query' }] }),
      });

      const params = { query: 'test' };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data).toEqual([]);
    });

    it('handles non-Error exceptions', async () => {
      (fetch as any).mockRejectedValue('String error');

      const params = { query: 'test' };

      const result = await searchJobs(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('UNEXPECTED_ERROR');
      expect(response.meta.message).toBe('String error');
    });
  });

  describe('workstream filtering', () => {
    it('filters by workstreamId when context provides one', async () => {
      const testWorkstreamId = '0xworkstream123';
      (getCurrentJobContext as any).mockReturnValue({
        workstreamId: testWorkstreamId,
        jobId: null,
        jobDefinitionId: null,
      });

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'test', include_requests: false };

      await searchJobs(params);

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.query).toContain('workstreamId: $workstreamId');
      expect(body.variables.workstreamId).toBe(testWorkstreamId);
    });

    it('does not filter by workstreamId when context has none', async () => {
      (getCurrentJobContext as any).mockReturnValue({
        workstreamId: null,
        jobId: null,
        jobDefinitionId: null,
      });

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'test', include_requests: false };

      await searchJobs(params);

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.query).not.toContain('workstreamId: $workstreamId');
      expect(body.variables.workstreamId).toBeUndefined();
    });

    it('includes workstreamId in response meta', async () => {
      const testWorkstreamId = '0xworkstream456';
      (getCurrentJobContext as any).mockReturnValue({
        workstreamId: testWorkstreamId,
        jobId: null,
        jobDefinitionId: null,
      });

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { jobDefinitions: { items: [] } } }),
      });

      const params = { query: 'test', include_requests: false };

      await searchJobs(params);

      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          requestedMeta: expect.objectContaining({
            workstreamId: testWorkstreamId,
          }),
        })
      );
    });
  });
});
