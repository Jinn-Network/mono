/**
 * Unit tests for gemini-agent/mcp/tools/search-artifacts.ts
 *
 * Tests artifact search MCP tool - searches artifacts by name/topic/content.
 *
 * Priority: P1 (High Priority)
 * Business Impact: Agent Functionality - Discovery
 * Coverage Target: 100% of search logic
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { searchArtifacts } from 'jinn-node/agent/mcp/tools/search-artifacts.js';

// Mock dependencies (same structure as search-jobs)
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
}));

import fetch from 'cross-fetch';
import { composeSinglePageResponse, decodeCursor } from 'jinn-node/agent/mcp/tools/shared/context-management.js';

describe('searchArtifacts', () => {
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

      const result = await searchArtifacts(params as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
      expect(response.meta.message).toContain('query');
    });

    it('validates minimum length for query (min 1 char)', async () => {
      const params = { query: '' };

      const result = await searchArtifacts(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('accepts query with only required field', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [] } } }),
      });

      const params = { query: 'test' };

      const result = await searchArtifacts(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
    });

    it('defaults include_request_context to false', async () => {
      const mockArtifact = { id: 'artifact-1', name: 'Test', requestId: '0x123' };

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [mockArtifact] } } }),
      });

      const params = { query: 'test' };

      await searchArtifacts(params);

      // Should only call once (for artifacts, not requests)
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('GraphQL query construction', () => {
    it('searches by name, topic, and contentPreview', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [] } } }),
      });

      const params = { query: 'my-search-term' };

      await searchArtifacts(params);

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.query).toContain('name_contains');
      expect(body.query).toContain('topic_contains');
      expect(body.query).toContain('contentPreview_contains');
      expect(body.variables.q).toBe('my-search-term');
    });

    it('uses correct GraphQL endpoint from env', async () => {
      vi.stubEnv('PONDER_GRAPHQL_URL', 'http://custom:9999/graphql');

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [] } } }),
      });

      const params = { query: 'test' };

      await searchArtifacts(params);

      expect(fetch).toHaveBeenCalledWith(
        'http://custom:9999/graphql',
        expect.any(Object)
      );
    });

    it('falls back to default endpoint when env not set', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [] } } }),
      });

      const params = { query: 'test' };

      await searchArtifacts(params);

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:42069/graphql',
        expect.any(Object)
      );
    });
  });

  describe('request context enrichment', () => {
    it('includes request context when include_request_context=true', async () => {
      const mockArtifact = { id: 'artifact-1', name: 'Test', requestId: '0xReq123' };
      const mockRequest = { id: '0xReq123', jobName: 'Test Job' };

      (fetch as any).mockImplementation(async (url: string, options: any) => {
        const body = JSON.parse(options.body);
        if (body.query.includes('SearchArtifacts')) {
          return { json: async () => ({ data: { artifacts: { items: [mockArtifact] } } }) };
        }
        // Request context query
        return { json: async () => ({ data: { requests: { items: [mockRequest] } } }) };
      });

      const params = { query: 'test', include_request_context: true };

      const result = await searchArtifacts(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.data[0].requestContext).toEqual(mockRequest);
    });

    it('excludes request context when include_request_context=false', async () => {
      const mockArtifact = { id: 'artifact-1', name: 'Test' };

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [mockArtifact] } } }),
      });

      const params = { query: 'test', include_request_context: false };

      await searchArtifacts(params);

      // Should only call once (for artifacts, not requests)
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('handles missing requestId gracefully', async () => {
      const mockArtifact = { id: 'artifact-1', name: 'Test', requestId: null };

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [mockArtifact] } } }),
      });

      const params = { query: 'test', include_request_context: true };

      const result = await searchArtifacts(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.data[0].requestContext).toBeUndefined();
    });

    it('handles request fetch failure gracefully', async () => {
      const mockArtifact = { id: 'artifact-1', name: 'Test', requestId: '0xReq123' };

      (fetch as any).mockImplementation(async (url: string, options: any) => {
        const body = JSON.parse(options.body);
        if (body.query.includes('SearchArtifacts')) {
          return { json: async () => ({ data: { artifacts: { items: [mockArtifact] } } }) };
        }
        throw new Error('Request fetch failed');
      });

      const params = { query: 'test', include_request_context: true };

      const result = await searchArtifacts(params);
      const response = JSON.parse(result.content[0].text);

      // Should still include artifact without request context
      expect(response.meta.ok).toBe(true);
      expect(response.data[0].id).toBe('artifact-1');
    });
  });

  describe('pagination', () => {
    it('calls composeSinglePageResponse with correct parameters', async () => {
      const mockArtifacts = [{ id: 'artifact-1', name: 'Artifact 1' }];

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: mockArtifacts } } }),
      });

      const params = { query: 'test' };

      await searchArtifacts(params);

      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        mockArtifacts,
        expect.objectContaining({
          startOffset: 0,
          truncateChars: 800,
        })
      );
    });

    it('uses cursor offset when provided', async () => {
      (decodeCursor as any).mockReturnValue({ offset: 15 });

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [] } } }),
      });

      const params = { query: 'test', cursor: 'cursor-abc' };

      await searchArtifacts(params);

      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          startOffset: 15,
        })
      );
    });
  });

  describe('response format', () => {
    it('returns empty array when no artifacts found', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [] } } }),
      });

      const params = { query: 'nonexistent' };

      const result = await searchArtifacts(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data).toEqual([]);
    });

    it('returns artifacts with correct structure', async () => {
      const mockArtifacts = [
        {
          id: 'artifact-1',
          name: 'Research Report',
          cid: 'QmTest123',
          topic: 'research',
          contentPreview: 'Analysis of...',
        },
      ];

      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: mockArtifacts } } }),
      });

      const params = { query: 'test' };

      const result = await searchArtifacts(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.data).toEqual(mockArtifacts);
      expect(response.meta.type).toBe('artifacts');
      expect(response.meta.source).toBe('ponder');
    });

    it('returns MCP content array format', async () => {
      (fetch as any).mockResolvedValue({
        json: async () => ({ data: { artifacts: { items: [] } } }),
      });

      const params = { query: 'test' };

      const result = await searchArtifacts(params);

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

      const result = await searchArtifacts(params);
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

      const result = await searchArtifacts(params);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data).toEqual([]);
    });
  });
});
