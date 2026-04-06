import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDetails } from 'jinn-node/agent/mcp/tools/get-details.js';

// Mock dependencies
vi.mock('cross-fetch');
vi.mock('jinn-node/agent/mcp/tools/shared/ipfs.js');
vi.mock('jinn-node/agent/mcp/tools/shared/context-management.js');

import fetch from 'cross-fetch';
import { resolveRequestIpfsContent } from 'jinn-node/agent/mcp/tools/shared/ipfs.js';
import { composeSinglePageResponse, decodeCursor } from 'jinn-node/agent/mcp/tools/shared/context-management.js';

describe('get-details MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock fetch with conditional responses based on query content
    (fetch as any).mockImplementation(async (url: string, options: any) => {
      const body = JSON.parse(options.body);
      const query = body.query;
      const variables = body.variables;

      // Request query (includes both request and delivery)
      if (query.includes('request(id:') && query.includes('delivery(id:')) {
        const requestId = variables.id;
        return {
          ok: true,
          json: async () => ({
            data: {
              request: {
                id: requestId,
                mech: '0xMech123',
                sender: '0xSender456',
                sourceJobDefinitionId: 'job-uuid-123',
                sourceRequestId: '0xParentRequest',
                ipfsHash: 'QmRequestHash',
                deliveryIpfsHash: null,
                requestData: '{}',
                blockTimestamp: '1234567890',
                delivered: false,
              },
              delivery: {
                id: requestId,
                sourceJobDefinitionId: 'delivery-job-uuid',
                sourceRequestId: '0xDeliveryParent',
              },
            },
          }),
        };
      }

      // Artifact query
      if (query.includes('artifact(id:')) {
        const artifactId = variables.id;
        return {
          ok: true,
          json: async () => ({
            data: {
              artifact: {
                id: artifactId,
                requestId: artifactId.split(':')[0],
                sourceRequestId: '0xArtifactSource',
                sourceJobDefinitionId: 'artifact-job-uuid',
                name: 'Test Artifact',
                topic: 'research',
                cid: 'QmArtifactCid',
                contentPreview: 'Preview text...',
              },
            },
          }),
        };
      }

      // Job definition query
      if (query.includes('jobDefinition(id:')) {
        const jobId = variables.id;
        return {
          ok: true,
          json: async () => ({
            data: {
              jobDefinition: {
                id: jobId,
                name: 'Test Job',
                enabledTools: '["tool1","tool2"]',
                blueprint: 'Test prompt',
                sourceJobDefinitionId: 'parent-job-uuid',
                sourceRequestId: '0xJobSource',
              },
            },
          }),
        };
      }

      // Default: empty response
      return {
        ok: true,
        json: async () => ({ data: {} }),
      };
    });

    // Mock IPFS resolution
    (resolveRequestIpfsContent as any).mockResolvedValue({ prompt: 'Test IPFS content' });

    // Mock composition helpers
    (composeSinglePageResponse as any).mockImplementation((data: any, opts: any) => ({
      data,
      meta: { ok: true, ...opts.requestedMeta },
    }));

    (decodeCursor as any).mockReturnValue({ offset: 0 });
  });

  describe('input normalization and validation', () => {
    it('normalizes string ID to array', async () => {
      const params = { ids: '0xabc123' };

      await getDetails(params as any);

      // Should make a fetch call for the request
      expect(fetch).toHaveBeenCalled();
    });

    it('accepts array of IDs', async () => {
      const params = { ids: ['0xabc123', '0xdef456'] };

      await getDetails(params as any);

      // Should make two fetch calls
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('handles empty IDs (null/undefined) → empty result', async () => {
      const params = { ids: null };

      const result = await getDetails(params as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.data).toEqual([]);
      expect(response.meta.ok).toBe(true);
    });

    it('handles empty array → empty result', async () => {
      const params = { ids: [] };

      const result = await getDetails(params as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.data).toEqual([]);
      expect(response.meta.ok).toBe(true);
    });

    it('handles cursor parameter', async () => {
      (decodeCursor as any).mockReturnValue({ offset: 10 });

      const params = { ids: '0xabc123', cursor: 'test-cursor' };

      await getDetails(params as any);

      expect(decodeCursor).toHaveBeenCalledWith('test-cursor');
    });
  });

  describe('ID type detection', () => {
    it('detects request ID (0x-prefixed hex)', async () => {
      const params = { ids: '0xabcdef1234567890' };

      await getDetails(params as any);

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.query).toContain('request(id:');
    });

    it('detects artifact ID (requestId:index format)', async () => {
      const params = { ids: '0xabc123:5' };

      await getDetails(params as any);

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.query).toContain('artifact(id:');
    });

    it('detects job definition ID (UUID format)', async () => {
      // UUID v4 format: version digit must be 1-5, variant must be 8/9/a/b/A/B
      const params = { ids: '12345678-abcd-4ef0-9abc-123456789abc' };

      await getDetails(params as any);

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.query).toContain('jobDefinition(id:');
    });

    it('handles mixed ID types in single call', async () => {
      const params = {
        ids: [
          '0xabc123', // request
          '0xdef456:3', // artifact
          '87654321-4321-4321-9321-abcdef123456', // job def (valid UUID v4)
        ],
      };

      await getDetails(params as any);

      // Should make 3 fetch calls
      expect(fetch).toHaveBeenCalledTimes(3);

      const calls = (fetch as any).mock.calls;
      const queries = calls.map((c: any) => JSON.parse(c[1].body).query);

      expect(queries.some((q: string) => q.includes('request(id:'))).toBe(true);
      expect(queries.some((q: string) => q.includes('artifact(id:'))).toBe(true);
      expect(queries.some((q: string) => q.includes('jobDefinition(id:'))).toBe(true);
    });

    it('ignores invalid ID formats (no match)', async () => {
      const params = {
        ids: [
          '0xabc123', // valid request
          'invalid-id', // invalid
          'not-a-uuid', // invalid
        ],
      };

      await getDetails(params as any);

      // Should only make 1 fetch call for the valid request ID
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('case insensitive hex matching (0xABC vs 0xabc)', async () => {
      const params = { ids: '0xABCDEF' };

      await getDetails(params as any);

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.query).toContain('request(id:');
      expect(body.variables.id).toBe('0xABCDEF');
    });
  });

  describe('request fetching', () => {
    it('fetches request by ID', async () => {
      // Valid hex string (only 0-9a-fA-F characters)
      const params = { ids: '0xabcdef1234567890' };

      const result = await getDetails(params as any);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: '0xabcdef1234567890',
            _source_table: 'ponder_request',
          }),
        ]),
        expect.any(Object)
      );
    });

    it('includes delivery provenance (deliveryJobDefinitionId, deliverySourceRequestId)', async () => {
      const params = { ids: '0xabcdef1234567890' };

      await getDetails(params as any);

      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            deliveryJobDefinitionId: 'delivery-job-uuid',
            deliverySourceRequestId: '0xDeliveryParent',
          }),
        ]),
        expect.any(Object)
      );
    });

    it('resolves IPFS content when resolve_ipfs=true (default)', async () => {
      const params = { ids: '0xfedcba9876543210' };

      await getDetails(params as any);

      expect(resolveRequestIpfsContent).toHaveBeenCalledWith('QmRequestHash', 30000);
      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            ipfsContent: { prompt: 'Test IPFS content' },
          }),
        ]),
        expect.any(Object)
      );
    });

    it('skips IPFS resolution when resolve_ipfs=false', async () => {
      const params = { ids: '0xfedcba9876543210', resolve_ipfs: false };

      await getDetails(params as any);

      expect(resolveRequestIpfsContent).not.toHaveBeenCalled();
    });
  });

  describe('artifact fetching', () => {
    it('fetches artifact by ID', async () => {
      // Valid artifact ID: hex request ID + colon + digit
      const params = { ids: '0xabcdef123456:7' };

      const result = await getDetails(params as any);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: '0xabcdef123456:7',
            _source_table: 'ponder_artifact',
            name: 'Test Artifact',
            topic: 'research',
          }),
        ]),
        expect.any(Object)
      );
    });

    it('resolves artifact IPFS content when resolve_ipfs=true (default)', async () => {
      const params = { ids: '0xfedcba987654:3' };

      await getDetails(params as any);

      expect(resolveRequestIpfsContent).toHaveBeenCalledWith('QmArtifactCid', 30000);
      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            ipfsContent: { prompt: 'Test IPFS content' },
          }),
        ]),
        expect.any(Object)
      );
    });

    it('skips IPFS resolution when resolve_ipfs=false', async () => {
      const params = { ids: '0xfedcba987654:3', resolve_ipfs: false };

      await getDetails(params as any);

      expect(resolveRequestIpfsContent).not.toHaveBeenCalled();
    });
  });

  describe('job definition fetching', () => {
    it('fetches job definition by ID', async () => {
      const params = { ids: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee' };

      const result = await getDetails(params as any);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
            _source_table: 'ponder_jobDefinition',
            name: 'Test Job',
          }),
        ]),
        expect.any(Object)
      );
    });

    it('includes sourceJobDefinitionId and sourceRequestId', async () => {
      const params = { ids: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee' };

      await getDetails(params as any);

      expect(composeSinglePageResponse).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            sourceJobDefinitionId: 'parent-job-uuid',
            sourceRequestId: '0xJobSource',
          }),
        ]),
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('collects HTTP errors in errors array', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const params = { ids: '0xbad1111111111111' };

      const result = await getDetails(params as any);
      const response = JSON.parse(result.content[0].text);

      // Errors are added to meta after composeSinglePageResponse
      expect(response.meta.errors).toBeDefined();
      expect(response.meta.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('HTTP 500')])
      );
    });

    it('collects GraphQL errors in errors array', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          errors: [{ message: 'GraphQL error: field not found' }],
        }),
      });

      const params = { ids: '0xbad2222222222222' };

      const result = await getDetails(params as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.errors).toBeDefined();
      expect(response.meta.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('GraphQL error: field not found'),
        ])
      );
    });

    it('continues fetching other IDs after one fails', async () => {
      let callCount = 0;
      (fetch as any).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call fails
          return { ok: false, status: 500 };
        }
        // Second call succeeds
        return {
          ok: true,
          json: async () => ({
            data: {
              request: {
                id: '0xaaa1111111111111',
                mech: '0xMech',
                sender: '0xSender',
                ipfsHash: null,
                delivered: false,
              },
              delivery: null,
            },
          }),
        };
      });

      const params = { ids: ['0xbad3333333333333', '0xaaa1111111111111'] };

      const result = await getDetails(params as any);
      const response = JSON.parse(result.content[0].text);

      // Both calls should have been made
      expect(fetch).toHaveBeenCalledTimes(2);

      // Should have one successful result
      expect(response.data).toHaveLength(1);
      expect(response.data[0].id).toBe('0xaaa1111111111111');

      // Should have one error
      expect(response.meta.errors).toBeDefined();
      expect(response.meta.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('HTTP 500')])
      );
    });

    it('returns DB_ERROR for unexpected exceptions', async () => {
      // Make composeSinglePageResponse throw to trigger outer catch block
      (composeSinglePageResponse as any).mockImplementation(() => {
        throw new Error('Unexpected composition error');
      });

      const params = { ids: '0xabc1234567890abc' };

      const result = await getDetails(params as any);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('DB_ERROR');
      expect(response.meta.message).toContain('Unexpected composition error');
    });
  });
});
