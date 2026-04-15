/**
 * Unit Test: IPFS Metadata Fetching
 * Module: worker/metadata/fetchIpfsMetadata.ts
 * Priority: P1 (HIGH)
 *
 * Tests IPFS metadata fetching from gateways with timeout and retry logic.
 * Critical for job context construction quality.
 *
 * Impact: Prevents incomplete context, improves agent decisions
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fetchIpfsMetadata } from 'jinn-node/worker/metadata/fetchIpfsMetadata.js';

// Mock dependencies
vi.mock('jinn-node/logging/index.js', () => ({
  workerLogger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getOptionalIpfsGatewayUrl: vi.fn(),
  getIpfsFetchTimeoutMs: vi.fn(),
}));

import { workerLogger } from 'jinn-node/logging/index.js';
import {
  getOptionalIpfsGatewayUrl,
  getIpfsFetchTimeoutMs,
} from 'jinn-node/agent/mcp/tools/shared/env.js';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('fetchIpfsMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getOptionalIpfsGatewayUrl as any).mockReturnValue(null);
    (getIpfsFetchTimeoutMs as any).mockReturnValue(7000);
  });

  describe('successful fetches', () => {
    it('fetches and parses metadata', async () => {
      const metadata = {
        blueprint: 'Do the task',
        enabledTools: ['read_file', 'write_file'],
        jobName: 'test-job',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => metadata,
      });

      const result = await fetchIpfsMetadata('Qmabcdef123');

      expect(result).toEqual({
        blueprint: 'Do the task',
        enabledTools: ['read_file', 'write_file'],
        jobName: 'test-job',
        sourceRequestId: undefined,
        sourceJobDefinitionId: undefined,
        additionalContext: undefined,
        workstreamId: undefined,
        templateId: undefined,
        outputSpec: undefined,
        lineage: undefined,
        jobDefinitionId: undefined,
        codeMetadata: undefined,
        model: undefined,
        dependencies: undefined,
        tools: undefined,
        cyclic: false,
      });
    });

    it('extracts all supported fields', async () => {
      const metadata = {
        blueprint: 'Task blueprint',
        enabledTools: ['tool1', 'tool2'],
        sourceRequestId: '0xsource123',
        sourceJobDefinitionId: 'job-def-456',
        additionalContext: { foo: 'bar' },
        jobName: 'my-job',
        jobDefinitionId: 'job-789',
        codeMetadata: { branch: { name: 'feature' } },
        model: 'gemini-2.5-pro',
        dependencies: ['dep1', 'dep2'],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => metadata,
      });

      const result = await fetchIpfsMetadata('Qmhash');

      expect(result).toEqual({
        ...metadata,
        workstreamId: undefined,
        templateId: undefined,
        outputSpec: undefined,
        lineage: undefined,
        tools: undefined,
        cyclic: false,
      });
    });

    it('uses Autonolas gateway by default', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ blueprint: 'test' }),
      });

      await fetchIpfsMetadata('Qmabc123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gateway.autonolas.tech/ipfs/Qmabc123',
        expect.anything()
      );
    });

    it('uses custom gateway when configured', async () => {
      (getOptionalIpfsGatewayUrl as any).mockReturnValue('https://custom.ipfs.io/ipfs/');

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ blueprint: 'test' }),
      });

      await fetchIpfsMetadata('Qmhash');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.ipfs.io/ipfs/Qmhash',
        expect.anything()
      );
    });

    it('handles gateway URL without trailing slash', async () => {
      (getOptionalIpfsGatewayUrl as any).mockReturnValue('https://ipfs.gateway.com');

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ blueprint: 'test' }),
      });

      await fetchIpfsMetadata('Qmhash');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ipfs.gateway.com/Qmhash',
        expect.anything()
      );
    });

    it('strips 0x prefix from hash', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ blueprint: 'test' }),
      });

      await fetchIpfsMetadata('0xQmhash');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/Qmhash'),
        expect.anything()
      );
    });

    it('falls back to input field if blueprint missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ input: 'Input as blueprint' }),
      });

      const result = await fetchIpfsMetadata('Qmhash');

      expect(result?.blueprint).toBe('Input as blueprint');
    });

    it('converts non-string sourceRequestId to string', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          blueprint: 'test',
          sourceRequestId: 12345,
        }),
      });

      const result = await fetchIpfsMetadata('Qmhash');

      expect(result?.sourceRequestId).toBe('12345');
      expect(typeof result?.sourceRequestId).toBe('string');
    });

    it('ignores non-array enabledTools', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          blueprint: 'test',
          enabledTools: 'not an array',
        }),
      });

      const result = await fetchIpfsMetadata('Qmhash');

      expect(result?.enabledTools).toBeUndefined();
    });

    it('ignores non-object codeMetadata', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          blueprint: 'test',
          codeMetadata: 'not an object',
        }),
      });

      const result = await fetchIpfsMetadata('Qmhash');

      expect(result?.codeMetadata).toBeUndefined();
    });
  });

  describe('timeout handling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('uses configured timeout', async () => {
      (getIpfsFetchTimeoutMs as any).mockReturnValue(5000);

      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');

      // Mock AbortController constructor
      global.AbortController = vi.fn(() => abortController) as any;

      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({ blueprint: 'test' }),
              });
            }, 10000); // Longer than timeout
          })
      );

      const promise = fetchIpfsMetadata('Qmhash');

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(5001);

      expect(abortSpy).toHaveBeenCalled();
    });

    it('uses default timeout when not configured', async () => {
      (getIpfsFetchTimeoutMs as any).mockReturnValue(null);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ blueprint: 'test' }),
      });

      await fetchIpfsMetadata('Qmhash');

      expect(workerLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 7000 }),
        expect.anything()
      );
    });
  });

  describe('error handling', () => {
    it('returns null for empty hash', async () => {
      const result = await fetchIpfsMetadata('');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null for undefined hash', async () => {
      const result = await fetchIpfsMetadata(undefined);

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null for non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({}),
      });

      const result = await fetchIpfsMetadata('Qmhash');

      expect(result).toBeNull();
      expect(workerLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 404 }),
        expect.stringContaining('non-OK status')
      );
    });

    it('returns null on fetch error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await fetchIpfsMetadata('Qmhash');

      expect(result).toBeNull();
      expect(workerLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Network error' }),
        expect.stringContaining('Failed to fetch IPFS metadata')
      );
    });

    it('returns null on JSON parse error', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const result = await fetchIpfsMetadata('Qmhash');

      expect(result).toBeNull();
    });

    it('returns null on timeout abort', async () => {
      mockFetch.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

      const result = await fetchIpfsMetadata('Qmhash');

      expect(result).toBeNull();
    });

    it('logs warnings for errors', async () => {
      mockFetch.mockRejectedValue(new Error('Timeout'));

      await fetchIpfsMetadata('Qmhash');

      expect(workerLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Timeout' }),
        expect.any(String)
      );
    });
  });
});
