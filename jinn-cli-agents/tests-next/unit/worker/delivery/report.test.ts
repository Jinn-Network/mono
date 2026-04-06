/**
 * Unit Test: Delivery Report Storage
 * Module: worker/delivery/report.ts
 * Priority: P0 (CRITICAL)
 *
 * Tests storeOnchainReport() function that stores execution reports via Control API.
 * Ensures proper payload formatting and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeOnchainReport } from 'jinn-node/worker/delivery/report.js';
import type { UnclaimedRequest, FinalStatus, AgentExecutionResult, IpfsMetadata } from 'jinn-node/worker/types.js';

// Mock dependencies
vi.mock('jinn-node/worker/control_api_client.js', () => ({
  createJobReport: vi.fn(),
}));

vi.mock('jinn-node/logging/index.js', () => ({
  workerLogger: {
    warn: vi.fn(),
  },
}));

vi.mock('jinn-node/worker/logging/errors.js', () => ({
  serializeError: vi.fn((err) => ({ message: err.message, stack: err.stack })),
}));

import { createJobReport } from 'jinn-node/worker/control_api_client.js';
import { workerLogger } from 'jinn-node/logging/index.js';

describe('storeOnchainReport', () => {
  const mockRequest: UnclaimedRequest = {
    id: '0x1234',
    sender: '0xsender',
    data: '0xdata',
    blockTimestamp: '1234567890',
  };

  const workerAddress = '0xworker';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful report storage', () => {
    it('stores report with complete telemetry', async () => {
      const result: AgentExecutionResult = {
        output: 'Task completed successfully',
        telemetry: {
          duration: 5000,
          totalTokens: 1500,
          toolCalls: [
            { tool: 'read_file', success: true },
            { tool: 'write_file', success: true },
          ],
        },
      };

      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
        reason: 'All tasks completed',
      };

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus);

      expect(createJobReport).toHaveBeenCalledWith(
        '0x1234',
        {
          status: 'COMPLETED',
          duration_ms: 5000,
          total_tokens: 1500,
          tools_called: JSON.stringify([
            { tool: 'read_file', success: true },
            { tool: 'write_file', success: true },
          ]),
          final_output: 'Task completed successfully',
          error_message: null,
          error_type: null,
          raw_telemetry: JSON.stringify({
            duration: 5000,
            totalTokens: 1500,
            toolCalls: [
              { tool: 'read_file', success: true },
              { tool: 'write_file', success: true },
            ],
            finalStatus: {
              status: 'COMPLETED',
              reason: 'All tasks completed',
            },
          }),
        },
        '0xworker'
      );
    });

    it('handles minimal telemetry with defaults', async () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };

      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
      };

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus);

      expect(createJobReport).toHaveBeenCalledWith(
        '0x1234',
        expect.objectContaining({
          status: 'COMPLETED',
          duration_ms: 0,
          total_tokens: 0,
          tools_called: '[]',
          final_output: 'Done',
          error_message: null,
          error_type: null,
        }),
        '0xworker'
      );
    });

    it('includes sourceJobDefinitionId in raw telemetry when present', async () => {
      const result: AgentExecutionResult = {
        output: 'Child job complete',
        telemetry: { duration: 1000 },
      };

      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
      };

      const metadata: IpfsMetadata = {
        sourceJobDefinitionId: 'parent-job-uuid',
        sourceRequestId: '0xparent',
      };

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus, undefined, metadata);

      const callArgs = (createJobReport as any).mock.calls[0];
      const payload = callArgs[1];
      const rawTelemetry = JSON.parse(payload.raw_telemetry);

      expect(rawTelemetry.sourceJobDefinitionId).toBe('parent-job-uuid');
      expect(rawTelemetry.finalStatus).toEqual({ status: 'COMPLETED' });
    });
  });

  describe('error handling', () => {
    it('includes error message and type when error present', async () => {
      const result: AgentExecutionResult = {
        output: 'Execution failed',
        telemetry: { duration: 2000 },
      };

      const finalStatus: FinalStatus = {
        status: 'FAILED',
        reason: 'Execution error',
      };

      const error = new Error('Failed to execute task');

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus, error);

      expect(createJobReport).toHaveBeenCalledWith(
        '0x1234',
        expect.objectContaining({
          status: 'FAILED',
          error_message: 'Failed to execute task',
          error_type: 'AGENT_ERROR',
        }),
        '0xworker'
      );
    });

    it('handles error without message property', async () => {
      const result: AgentExecutionResult = {
        output: '',
        telemetry: {},
      };

      const finalStatus: FinalStatus = {
        status: 'FAILED',
      };

      const error = 'String error message';

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus, error);

      expect(createJobReport).toHaveBeenCalledWith(
        '0x1234',
        expect.objectContaining({
          error_message: 'String error message',
          error_type: 'AGENT_ERROR',
        }),
        '0xworker'
      );
    });

    it('continues silently when createJobReport fails', async () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };

      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
      };

      const reportError = new Error('Control API unavailable');
      (createJobReport as any).mockRejectedValueOnce(reportError);

      // Should not throw
      await expect(storeOnchainReport(mockRequest, workerAddress, result, finalStatus)).resolves.toBeUndefined();

      // Should log warning (source includes status in message and object)
      expect(workerLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: '0x1234',
          status: 'COMPLETED',
          error: expect.any(Object),
        }),
        'Failed to store on-chain report (status COMPLETED)'
      );
    });
  });

  describe('missing or null result fields', () => {
    it('handles null output', async () => {
      const result = {
        telemetry: {},
      } as AgentExecutionResult;

      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
      };

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus);

      expect(createJobReport).toHaveBeenCalledWith(
        '0x1234',
        expect.objectContaining({
          final_output: null,
        }),
        '0xworker'
      );
    });

    it('handles missing telemetry object', async () => {
      const result = {
        output: 'Done',
      } as AgentExecutionResult;

      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
      };

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus);

      expect(createJobReport).toHaveBeenCalledWith(
        '0x1234',
        expect.objectContaining({
          duration_ms: 0,
          total_tokens: 0,
          tools_called: '[]',
        }),
        '0xworker'
      );
    });

    it('handles null toolCalls in telemetry', async () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {
          duration: 1000,
          toolCalls: null as any,
        },
      };

      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
      };

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus);

      expect(createJobReport).toHaveBeenCalledWith(
        '0x1234',
        expect.objectContaining({
          tools_called: '[]',
        }),
        '0xworker'
      );
    });
  });

  describe('WAITING status', () => {
    it('stores WAITING status correctly', async () => {
      const result: AgentExecutionResult = {
        output: 'Waiting for child jobs to complete',
        telemetry: { duration: 500 },
      };

      const finalStatus: FinalStatus = {
        status: 'WAITING',
        reason: 'Child jobs pending',
      };

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus);

      expect(createJobReport).toHaveBeenCalledWith(
        '0x1234',
        expect.objectContaining({
          status: 'WAITING',
          error_message: null,
          error_type: null,
        }),
        '0xworker'
      );
    });
  });

  describe('complex telemetry structures', () => {
    it('serializes nested telemetry objects correctly', async () => {
      const result: AgentExecutionResult = {
        output: 'Complex task',
        telemetry: {
          duration: 3000,
          totalTokens: 2000,
          toolCalls: [
            {
              tool: 'web_fetch',
              params: { url: 'https://example.com' },
              success: true,
              result: { status: 200, data: 'content' },
            },
          ],
          nested: {
            deep: {
              value: 42,
            },
          },
        },
      };

      const finalStatus: FinalStatus = {
        status: 'COMPLETED',
      };

      await storeOnchainReport(mockRequest, workerAddress, result, finalStatus);

      const callArgs = (createJobReport as any).mock.calls[0];
      const payload = callArgs[1];
      const rawTelemetry = JSON.parse(payload.raw_telemetry);

      expect(rawTelemetry.nested.deep.value).toBe(42);
      expect(rawTelemetry.toolCalls[0].params.url).toBe('https://example.com');
    });
  });
});
