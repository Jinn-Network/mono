/**
 * Unit tests for gemini-agent/mcp/tools/inspect-job-run.ts
 *
 * Tests the inspect_job_run MCP tool for single job run inspection.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { inspectJobRun } from 'jinn-node/agent/mcp/tools/inspect-job-run.js';

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

describe('inspectJobRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validation', () => {
    it('validates required request_id field', async () => {
      const result = await inspectJobRun({});
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('validates request_id is not empty', async () => {
      const result = await inspectJobRun({ request_id: '' });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('not found handling', () => {
    it('returns NOT_FOUND when request does not exist', async () => {
      (queryPonder as any).mockResolvedValue({ data: { request: null } });

      const result = await inspectJobRun({ request_id: '0x1234567890' });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('NOT_FOUND');
      expect(response.meta.message).toContain('0x1234567890');
    });
  });

  describe('successful inspection', () => {
    it('returns basic request info when found', async () => {
      (queryPonder as any).mockResolvedValue({
        data: {
          request: {
            id: '0xabc123',
            jobName: 'Test Job',
            jobDefinitionId: 'def-123',
            workstreamId: '0xworkstream',
            delivered: true,
            deliveryIpfsHash: 'QmTestCid',
            blockTimestamp: '2025-01-01T00:00:00Z',
          },
        },
      });

      // Mock IPFS content
      (fetchIpfsContentMcp as any).mockResolvedValue({
        status: 'COMPLETED',
        model: 'gemini-2.5-flash',
      });

      const result = await inspectJobRun({
        request_id: '0xabc123',
        include_artifacts: false,
        include_telemetry: false,
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.request.id).toBe('0xabc123');
      expect(response.data.request.jobName).toBe('Test Job');
      expect(response.data.request.status).toBe('COMPLETED');
    });

    it('includes delivery info when resolved', async () => {
      (queryPonder as any).mockResolvedValue({
        data: {
          request: {
            id: '0xabc123',
            delivered: true,
            deliveryIpfsHash: 'QmTestCid',
          },
        },
      });

      (fetchIpfsContentMcp as any).mockResolvedValue({
        status: 'COMPLETED',
        model: 'gemini-2.5-pro',
        error: null,
      });

      const result = await inspectJobRun({
        request_id: '0xabc123',
        resolve_ipfs: true,
        include_telemetry: false,
        include_artifacts: false,
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.delivery).toBeDefined();
      expect(response.data.delivery.status).toBe('COMPLETED');
      expect(response.data.delivery.model).toBe('gemini-2.5-pro');
    });

    it('marks status as FAILED when delivery status is FAILED', async () => {
      (queryPonder as any).mockResolvedValue({
        data: {
          request: {
            id: '0xabc123',
            delivered: true,
            deliveryIpfsHash: 'QmTestCid',
          },
        },
      });

      (fetchIpfsContentMcp as any).mockResolvedValue({
        status: 'FAILED',
        error: 'Timeout exceeded',
      });

      const result = await inspectJobRun({
        request_id: '0xabc123',
        resolve_ipfs: true,
        include_telemetry: false,
        include_artifacts: false,
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.data.request.status).toBe('FAILED');
      expect(response.data.delivery.error).toBe('Timeout exceeded');
    });
  });

  describe('error handling', () => {
    it('handles GraphQL query failure', async () => {
      (queryPonder as any).mockResolvedValue({
        data: null,
        error: 'Connection refused',
      });

      const result = await inspectJobRun({ request_id: '0xabc123' });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('EXECUTION_ERROR');
      expect(response.meta.message).toContain('Connection refused');
    });

    it('adds warning when IPFS fetch fails', async () => {
      (queryPonder as any).mockResolvedValue({
        data: {
          request: {
            id: '0xabc123',
            delivered: true,
            deliveryIpfsHash: 'QmTestCid',
          },
        },
      });

      (fetchIpfsContentMcp as any).mockResolvedValue(null);

      const result = await inspectJobRun({
        request_id: '0xabc123',
        resolve_ipfs: true,
        include_telemetry: false,
        include_artifacts: false,
      });
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.meta.warnings).toBeDefined();
      expect(response.meta.warnings).toContain('Failed to fetch delivery content from IPFS');
    });
  });

  describe('MCP response format', () => {
    it('returns proper MCP content array format', async () => {
      (queryPonder as any).mockResolvedValue({
        data: {
          request: {
            id: '0xabc123',
            delivered: false,
          },
        },
      });

      const result = await inspectJobRun({
        request_id: '0xabc123',
        include_telemetry: false,
        include_artifacts: false,
      });

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
    });

    it('returns valid JSON in response text', async () => {
      (queryPonder as any).mockResolvedValue({
        data: {
          request: {
            id: '0xabc123',
            delivered: false,
          },
        },
      });

      const result = await inspectJobRun({
        request_id: '0xabc123',
        include_telemetry: false,
        include_artifacts: false,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('data');
      expect(parsed).toHaveProperty('meta');
    });
  });
});
