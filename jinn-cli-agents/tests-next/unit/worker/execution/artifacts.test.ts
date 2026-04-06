/**
 * Unit tests for worker/execution/artifacts.ts
 *
 * Tests artifact extraction and consolidation from execution output and telemetry.
 *
 * Priority: P1 (High Priority)
 * Business Impact: Core Functionality - Artifact Management
 * Coverage Target: 100% of artifact consolidation logic
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { consolidateArtifacts, extractArtifactsFromError } from 'jinn-node/worker/execution/artifacts.js';
import type { AgentExecutionResult } from 'jinn-node/worker/types.js';
import type { ExtractedArtifact } from 'jinn-node/worker/artifacts.js';

// Mock dependencies
vi.mock('jinn-node/worker/artifacts.js', () => ({
  extractArtifactsFromOutput: vi.fn(),
  extractArtifactsFromTelemetry: vi.fn(),
}));

vi.mock('jinn-node/worker/control_api_client.js', () => ({
  createArtifact: vi.fn(),
}));

import { extractArtifactsFromOutput, extractArtifactsFromTelemetry } from 'jinn-node/worker/artifacts.js';
import { createArtifact } from 'jinn-node/worker/control_api_client.js';

describe('consolidateArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('artifact extraction from output', () => {
    it('extracts artifacts from output only', async () => {
      const mockArtifacts: ExtractedArtifact[] = [
        { cid: 'QmTest1', topic: 'research', name: 'Report' },
      ];

      (extractArtifactsFromOutput as any).mockReturnValue(mockArtifacts);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const result: AgentExecutionResult = {
        output: 'Task completed. Artifact: {"cid":"QmTest1","topic":"research"}',
        telemetry: {},
      };

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(extractArtifactsFromOutput).toHaveBeenCalledWith(result.output);
      expect(extractArtifactsFromTelemetry).toHaveBeenCalledWith({});
      expect(consolidated.artifacts).toEqual(mockArtifacts);
      expect(consolidated.output).toBe(result.output);
      expect(consolidated.telemetry).toBe(result.telemetry);
    });

    it('handles empty output gracefully', async () => {
      (extractArtifactsFromOutput as any).mockReturnValue([]);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const result: AgentExecutionResult = {
        output: '',
        telemetry: {},
      };

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(extractArtifactsFromOutput).toHaveBeenCalledWith('');
      expect(consolidated).toEqual(result);
      expect(consolidated.artifacts).toBeUndefined();
    });

    it('handles undefined output', async () => {
      (extractArtifactsFromOutput as any).mockReturnValue([]);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const result: AgentExecutionResult = {
        telemetry: {},
      } as any;

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(extractArtifactsFromOutput).toHaveBeenCalledWith('');
      expect(consolidated).toEqual(result);
    });
  });

  describe('artifact extraction from telemetry', () => {
    it('extracts artifacts from telemetry only', async () => {
      const mockArtifacts: ExtractedArtifact[] = [
        { cid: 'QmTest2', topic: 'code', name: 'Implementation' },
      ];

      (extractArtifactsFromOutput as any).mockReturnValue([]);
      (extractArtifactsFromTelemetry as any).mockReturnValue(mockArtifacts);

      const result: AgentExecutionResult = {
        output: 'Task completed.',
        telemetry: {
          toolCalls: [{ tool: 'create_artifact', result: '...' }],
        },
      };

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(extractArtifactsFromTelemetry).toHaveBeenCalledWith(result.telemetry);
      expect(consolidated.artifacts).toEqual(mockArtifacts);
    });

    it('handles empty telemetry', async () => {
      (extractArtifactsFromOutput as any).mockReturnValue([]);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(extractArtifactsFromTelemetry).toHaveBeenCalledWith({});
      expect(consolidated.artifacts).toBeUndefined();
    });

    it('handles undefined telemetry', async () => {
      (extractArtifactsFromOutput as any).mockReturnValue([]);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const result: AgentExecutionResult = {
        output: 'Done',
      } as any;

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(extractArtifactsFromTelemetry).toHaveBeenCalledWith({});
    });
  });

  describe('artifact combining', () => {
    it('combines artifacts from both output and telemetry', async () => {
      const outputArtifacts: ExtractedArtifact[] = [
        { cid: 'QmOutput1', topic: 'research' },
      ];
      const telemetryArtifacts: ExtractedArtifact[] = [
        { cid: 'QmTelemetry1', topic: 'code' },
      ];

      (extractArtifactsFromOutput as any).mockReturnValue(outputArtifacts);
      (extractArtifactsFromTelemetry as any).mockReturnValue(telemetryArtifacts);

      const result: AgentExecutionResult = {
        output: 'Artifact in output',
        telemetry: { toolCalls: [] },
      };

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(consolidated.artifacts).toEqual([...outputArtifacts, ...telemetryArtifacts]);
      expect(consolidated.artifacts).toHaveLength(2);
    });

    it('handles multiple artifacts from single source', async () => {
      const outputArtifacts: ExtractedArtifact[] = [
        { cid: 'QmOutput1', topic: 'research' },
        { cid: 'QmOutput2', topic: 'analysis' },
        { cid: 'QmOutput3', topic: 'conclusion' },
      ];

      (extractArtifactsFromOutput as any).mockReturnValue(outputArtifacts);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const result: AgentExecutionResult = {
        output: 'Multiple artifacts',
        telemetry: {},
      };

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(consolidated.artifacts).toEqual(outputArtifacts);
      expect(consolidated.artifacts).toHaveLength(3);
    });
  });

  describe('Control API artifact storage', () => {
    it('calls createArtifact for each extracted artifact', async () => {
      const mockArtifacts: ExtractedArtifact[] = [
        { cid: 'QmTest1', topic: 'research', name: 'Report' },
        { cid: 'QmTest2', topic: 'code', name: 'Implementation' },
      ];

      (extractArtifactsFromOutput as any).mockReturnValue(mockArtifacts);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);
      (createArtifact as any).mockResolvedValue({});

      const result: AgentExecutionResult = {
        output: 'Artifacts created',
        telemetry: {},
      };

      await consolidateArtifacts(result, '0xRequest123');

      expect(createArtifact).toHaveBeenCalledTimes(2);
      expect(createArtifact).toHaveBeenCalledWith('0xRequest123', {
        cid: 'QmTest1',
        topic: 'research',
        content: null,
      });
      expect(createArtifact).toHaveBeenCalledWith('0xRequest123', {
        cid: 'QmTest2',
        topic: 'code',
        content: null,
      });
    });

    it('continues on createArtifact error (non-critical failure)', async () => {
      const mockArtifacts: ExtractedArtifact[] = [
        { cid: 'QmTest1', topic: 'research' },
        { cid: 'QmTest2', topic: 'code' },
      ];

      (extractArtifactsFromOutput as any).mockReturnValue(mockArtifacts);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);
      (createArtifact as any).mockRejectedValueOnce(new Error('Artifact already exists'));
      (createArtifact as any).mockResolvedValueOnce({});

      const result: AgentExecutionResult = {
        output: 'Artifacts',
        telemetry: {},
      };

      // Should not throw
      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(createArtifact).toHaveBeenCalledTimes(2);
      expect(consolidated.artifacts).toEqual(mockArtifacts);
    });

    it('does not call createArtifact when no artifacts found', async () => {
      (extractArtifactsFromOutput as any).mockReturnValue([]);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const result: AgentExecutionResult = {
        output: 'No artifacts',
        telemetry: {},
      };

      await consolidateArtifacts(result, '0xRequest123');

      expect(createArtifact).not.toHaveBeenCalled();
    });
  });

  describe('result preservation', () => {
    it('preserves original result properties when no artifacts', async () => {
      (extractArtifactsFromOutput as any).mockReturnValue([]);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const result: AgentExecutionResult = {
        output: 'Task completed',
        telemetry: { duration: 5000, tools_used: 3 },
      };

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(consolidated).toBe(result);
      expect(consolidated.output).toBe('Task completed');
      expect(consolidated.telemetry).toEqual({ duration: 5000, tools_used: 3 });
    });

    it('adds artifacts array to result when artifacts found', async () => {
      const mockArtifacts: ExtractedArtifact[] = [
        { cid: 'QmTest1', topic: 'research' },
      ];

      (extractArtifactsFromOutput as any).mockReturnValue(mockArtifacts);
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);
      (createArtifact as any).mockResolvedValue({});

      const result: AgentExecutionResult = {
        output: 'Task completed',
        telemetry: { duration: 5000 },
      };

      const consolidated = await consolidateArtifacts(result, '0xRequest123');

      expect(consolidated).not.toBe(result); // New object due to spread
      expect(consolidated.output).toBe('Task completed');
      expect(consolidated.telemetry).toEqual({ duration: 5000 });
      expect(consolidated.artifacts).toEqual(mockArtifacts);
    });
  });
});

describe('extractArtifactsFromError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('artifact extraction from error telemetry', () => {
    it('extracts artifacts from error telemetry', async () => {
      const mockArtifacts: ExtractedArtifact[] = [
        { cid: 'QmError1', topic: 'debug', name: 'Error Log' },
      ];

      (extractArtifactsFromTelemetry as any).mockReturnValue(mockArtifacts);
      (createArtifact as any).mockResolvedValue({});

      const errorTelemetry = {
        error: 'Something went wrong',
        toolCalls: [{ tool: 'create_artifact', result: '...' }],
      };

      const artifacts = await extractArtifactsFromError(errorTelemetry, '0xRequest456');

      expect(extractArtifactsFromTelemetry).toHaveBeenCalledWith(errorTelemetry);
      expect(artifacts).toEqual(mockArtifacts);
    });

    it('handles null error telemetry (defaults to empty object)', async () => {
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const artifacts = await extractArtifactsFromError(null, '0xRequest456');

      // null || {} = {}
      expect(extractArtifactsFromTelemetry).toHaveBeenCalledWith({});
      expect(artifacts).toEqual([]);
    });

    it('handles undefined error telemetry (defaults to empty object)', async () => {
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const artifacts = await extractArtifactsFromError(undefined, '0xRequest456');

      // undefined || {} = {}
      expect(extractArtifactsFromTelemetry).toHaveBeenCalledWith({});
      expect(artifacts).toEqual([]);
    });

    it('returns empty array when no artifacts in error telemetry', async () => {
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const errorTelemetry = { error: 'Failed' };

      const artifacts = await extractArtifactsFromError(errorTelemetry, '0xRequest456');

      expect(artifacts).toEqual([]);
    });
  });

  describe('Control API artifact storage from errors', () => {
    it('stores artifacts via createArtifact', async () => {
      const mockArtifacts: ExtractedArtifact[] = [
        { cid: 'QmError1', topic: 'debug' },
      ];

      (extractArtifactsFromTelemetry as any).mockReturnValue(mockArtifacts);
      (createArtifact as any).mockResolvedValue({});

      const errorTelemetry = { error: 'Failed' };

      await extractArtifactsFromError(errorTelemetry, '0xRequest456');

      expect(createArtifact).toHaveBeenCalledWith('0xRequest456', {
        cid: 'QmError1',
        topic: 'debug',
        content: null,
      });
    });

    it('continues on createArtifact error (non-critical)', async () => {
      const mockArtifacts: ExtractedArtifact[] = [
        { cid: 'QmError1', topic: 'debug' },
        { cid: 'QmError2', topic: 'trace' },
      ];

      (extractArtifactsFromTelemetry as any).mockReturnValue(mockArtifacts);
      (createArtifact as any).mockRejectedValueOnce(new Error('API Error'));
      (createArtifact as any).mockResolvedValueOnce({});

      const errorTelemetry = { error: 'Failed' };

      // Should not throw
      const artifacts = await extractArtifactsFromError(errorTelemetry, '0xRequest456');

      expect(createArtifact).toHaveBeenCalledTimes(2);
      expect(artifacts).toEqual(mockArtifacts);
    });

    it('does not call createArtifact when no artifacts', async () => {
      (extractArtifactsFromTelemetry as any).mockReturnValue([]);

      const errorTelemetry = { error: 'Failed' };

      await extractArtifactsFromError(errorTelemetry, '0xRequest456');

      expect(createArtifact).not.toHaveBeenCalled();
    });
  });
});
