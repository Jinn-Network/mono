/**
 * Unit Test: Delivery Payload Construction
 * Module: worker/delivery/payload.ts
 * Priority: P0 (CRITICAL)
 *
 * Tests buildDeliveryPayload() function that constructs IPFS metadata
 * uploaded to the marketplace. Bugs here cause failed deliveries and financial loss.
 */
import { describe, it, expect } from 'vitest';
import { buildDeliveryPayload } from 'jinn-node/worker/delivery/payload.js';
import type { AgentExecutionResult, IpfsMetadata } from 'jinn-node/worker/types.js';
import type { RecognitionPhaseResult, ReflectionResult } from 'jinn-node/worker/types.js';

describe('buildDeliveryPayload', () => {
  describe('minimal valid payload', () => {
    it('constructs valid payload with only required fields', () => {
      const result: AgentExecutionResult = {
        output: 'Task completed successfully',
        telemetry: { tools_used: 2 },
      };

      const metadata: IpfsMetadata = {
        blueprint: 'Do the thing',
      };

      const payload = buildDeliveryPayload({
        requestId: '0x1234',
        result,
        metadata,
      });

      expect(payload).toEqual({
        requestId: '0x1234',
        output: 'Task completed successfully',
        structuredSummary: 'Task completed successfully',
        telemetry: { tools_used: 2 },
        artifacts: [],
        blueprint: 'Do the thing',
      });
    });

    it('handles empty output gracefully', () => {
      const result: AgentExecutionResult = {
        output: '',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xabcd',
        result,
        metadata,
      });

      expect(payload.output).toBe('');
      expect(payload.artifacts).toEqual([]);
    });

    it('uses empty string when output is undefined', () => {
      const result = {
        telemetry: {},
      } as AgentExecutionResult;

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xtest',
        result,
        metadata,
      });

      expect(payload.output).toBe('');
    });
  });

  describe('artifacts handling', () => {
    it('includes artifacts array when present', () => {
      const result: AgentExecutionResult = {
        output: 'Created artifacts',
        telemetry: {},
        artifacts: [
          {
            cid: 'QmTest123',
            topic: 'research',
            name: 'findings.md',
            type: 'RESEARCH_REPORT',
            contentPreview: 'Initial findings...',
          },
          {
            cid: 'QmTest456',
            topic: 'code',
            name: 'implementation.ts',
          },
        ],
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0x5678',
        result,
        metadata,
      });

      expect(payload.artifacts).toHaveLength(2);
      expect(payload.artifacts[0]).toEqual({
        cid: 'QmTest123',
        topic: 'research',
        name: 'findings.md',
        type: 'RESEARCH_REPORT',
        contentPreview: 'Initial findings...',
      });
      expect(payload.artifacts[1]).toEqual({
        cid: 'QmTest456',
        topic: 'code',
        name: 'implementation.ts',
      });
    });

    it('uses empty array when artifacts undefined', () => {
      const result: AgentExecutionResult = {
        output: 'No artifacts',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0x9999',
        result,
        metadata,
      });

      expect(payload.artifacts).toEqual([]);
    });
  });

  describe('pull request URL', () => {
    it('includes PR URL when present', () => {
      const result: AgentExecutionResult = {
        output: 'Created PR',
        telemetry: {},
        pullRequestUrl: 'https://github.com/org/repo/pull/123',
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xpr',
        result,
        metadata,
      });

      expect(payload.pullRequestUrl).toBe('https://github.com/org/repo/pull/123');
    });

    it('omits PR URL field when not present', () => {
      const result: AgentExecutionResult = {
        output: 'No PR',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xnopr',
        result,
        metadata,
      });

      expect(payload).not.toHaveProperty('pullRequestUrl');
    });
  });

  describe('execution policy', () => {
    it('includes execution policy when branch metadata present', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {
        codeMetadata: {
          branch: {
            name: 'job/my-feature',
            base: 'main',
          },
          repoRoot: '/tmp/repo',
        },
      };

      const payload = buildDeliveryPayload({
        requestId: '0xbranch',
        result,
        metadata,
      });

      expect(payload.executionPolicy).toEqual({
        branch: 'job/my-feature',
        ensureTestsPass: true,
        description: 'Agent executed work on the provided branch and passed required validations.',
      });
    });

    it('omits execution policy when no branch metadata', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xnobranch',
        result,
        metadata,
      });

      expect(payload).not.toHaveProperty('executionPolicy');
    });

    it('omits execution policy when codeMetadata present but no branch name', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {
        codeMetadata: {
          repoRoot: '/tmp/repo',
        },
      };

      const payload = buildDeliveryPayload({
        requestId: '0xnobranch',
        result,
        metadata,
      });

      expect(payload).not.toHaveProperty('executionPolicy');
    });
  });

  describe('recognition phase results', () => {
    it('includes recognition data when present', () => {
      const result: AgentExecutionResult = {
        output: 'Task done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const recognition: RecognitionPhaseResult = {
        initialSituation: {
          cid: 'QmSituation123',
          name: 'situation',
          topic: 'execution',
        },
        embeddingStatus: 'success',
        similarJobs: [
          {
            requestId: '0xsimilar1',
            similarity: 0.85,
            learnings: 'Use approach X',
          },
        ],
        rawLearnings: [{ pattern: 'Always validate input' }],
        learningsMarkdown: '## Learnings\n- Validate input',
        searchQuery: 'similar task execution',
      };

      const payload = buildDeliveryPayload({
        requestId: '0xrecog',
        result,
        metadata,
        recognition,
      });

      expect(payload.recognition).toEqual({
        initialSituation: {
          cid: 'QmSituation123',
          name: 'situation',
          topic: 'execution',
        },
        embeddingStatus: 'success',
        similarJobs: [
          {
            requestId: '0xsimilar1',
            similarity: 0.85,
            learnings: 'Use approach X',
          },
        ],
        learnings: [{ pattern: 'Always validate input' }],
        learningsMarkdown: '## Learnings\n- Validate input',
        searchQuery: 'similar task execution',
      });
    });

    it('omits recognition when null', () => {
      const result: AgentExecutionResult = {
        output: 'Task done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xnorecog',
        result,
        metadata,
        recognition: null,
      });

      expect(payload).not.toHaveProperty('recognition');
    });

    it('omits recognition when undefined', () => {
      const result: AgentExecutionResult = {
        output: 'Task done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xnorecog',
        result,
        metadata,
      });

      expect(payload).not.toHaveProperty('recognition');
    });
  });

  describe('reflection phase results', () => {
    it('includes reflection data when present', () => {
      const result: AgentExecutionResult = {
        output: 'Task done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const reflection: ReflectionResult = {
        output: 'Reflection complete. Identified 3 improvements.',
        telemetry: { reflection_time_ms: 1500 },
        artifacts: [
          {
            cid: 'QmReflection123',
            topic: 'reflection',
          },
        ],
      };

      const payload = buildDeliveryPayload({
        requestId: '0xreflect',
        result,
        metadata,
        reflection,
      });

      expect(payload.reflection).toEqual({
        output: 'Reflection complete. Identified 3 improvements.',
        telemetry: { reflection_time_ms: 1500 },
      });
    });

    it('omits reflection when null', () => {
      const result: AgentExecutionResult = {
        output: 'Task done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xnoreflect',
        result,
        metadata,
        reflection: null,
      });

      expect(payload).not.toHaveProperty('reflection');
    });

    it('omits reflection when undefined', () => {
      const result: AgentExecutionResult = {
        output: 'Task done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xnoreflect',
        result,
        metadata,
      });

      expect(payload).not.toHaveProperty('reflection');
    });
  });

  describe('worker telemetry', () => {
    it('includes worker telemetry when present', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const workerTelemetry = {
        execution_time_ms: 5000,
        memory_used_mb: 128,
        recognition_enabled: true,
      };

      const payload = buildDeliveryPayload({
        requestId: '0xtelemetry',
        result,
        metadata,
        workerTelemetry,
      });

      expect(payload.workerTelemetry).toEqual({
        execution_time_ms: 5000,
        memory_used_mb: 128,
        recognition_enabled: true,
      });
    });

    it('omits worker telemetry when not provided', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xnotelemetry',
        result,
        metadata,
      });

      expect(payload).not.toHaveProperty('workerTelemetry');
    });
  });

  describe('complex complete payload', () => {
    it('includes all fields when all data present', () => {
      const result: AgentExecutionResult = {
        output: 'Comprehensive task completed',
        telemetry: { tools: 5, actions: 12 },
        artifacts: [
          { cid: 'Qm1', topic: 'code', name: 'main.ts' },
          { cid: 'Qm2', topic: 'docs', name: 'README.md' },
        ],
        pullRequestUrl: 'https://github.com/org/repo/pull/99',
      };

      const metadata: IpfsMetadata = {
        blueprint: 'Build feature X',
        codeMetadata: {
          branch: { name: 'job/feature-x', base: 'main' },
          repoRoot: '/code',
        },
      };

      const recognition: RecognitionPhaseResult = {
        initialSituation: { cid: 'QmSit', name: 'sit', topic: 'exec' },
        embeddingStatus: 'success',
        similarJobs: [],
        rawLearnings: [],
        learningsMarkdown: '',
        searchQuery: 'feature x',
      };

      const reflection: ReflectionResult = {
        output: 'Reflection done',
        telemetry: { time: 1000 },
      };

      const workerTelemetry = {
        total_time: 10000,
      };

      const payload = buildDeliveryPayload({
        requestId: '0xfull',
        result,
        metadata,
        recognition,
        reflection,
        workerTelemetry,
      });

      expect(payload).toMatchObject({
        requestId: '0xfull',
        output: 'Comprehensive task completed',
        telemetry: { tools: 5, actions: 12 },
        artifacts: [
          { cid: 'Qm1', topic: 'code', name: 'main.ts' },
          { cid: 'Qm2', topic: 'docs', name: 'README.md' },
        ],
        pullRequestUrl: 'https://github.com/org/repo/pull/99',
        executionPolicy: {
          branch: 'job/feature-x',
          ensureTestsPass: true,
          description: 'Agent executed work on the provided branch and passed required validations.',
        },
        recognition: expect.any(Object),
        reflection: { output: 'Reflection done', telemetry: { time: 1000 } },
        workerTelemetry: { total_time: 10000 },
      });
    });
  });

  describe('requestId handling', () => {
    it('converts requestId to string', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      // Test with number-like string
      const payload1 = buildDeliveryPayload({
        requestId: '12345',
        result,
        metadata,
      });
      expect(payload1.requestId).toBe('12345');

      // Test with hex string
      const payload2 = buildDeliveryPayload({
        requestId: '0xabcdef',
        result,
        metadata,
      });
      expect(payload2.requestId).toBe('0xabcdef');
    });
  });

  describe('unicode and special characters', () => {
    it('handles unicode in output correctly', () => {
      const result: AgentExecutionResult = {
        output: 'Task completed ✅ 成功 🎉',
        telemetry: {},
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xunicode',
        result,
        metadata,
      });

      expect(payload.output).toBe('Task completed ✅ 成功 🎉');
    });

    it('handles special characters in artifact names', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
        artifacts: [
          {
            cid: 'Qm123',
            topic: 'data',
            name: 'file-with-dashes_and_underscores (v1.2.3).json',
          },
        ],
      };

      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xspecial',
        result,
        metadata,
      });

      expect(payload.artifacts[0].name).toBe('file-with-dashes_and_underscores (v1.2.3).json');
    });
  });

  describe('measurementCoverage', () => {
    it('includes measurementCoverage when provided', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };
      const metadata: IpfsMetadata = {};
      const measurementCoverage = {
        totalMissionInvariants: 3,
        measuredCount: 2,
        unmeasuredIds: ['GOAL-B'],
        measuredIds: ['GOAL-A', 'OUT-C'],
        coveragePercent: 67,
        passingCount: 2,
        failingCount: 0,
        delegated: false,
      };

      const payload = buildDeliveryPayload({
        requestId: '0xcoverage',
        result,
        metadata,
        measurementCoverage,
      });

      expect(payload.measurementCoverage).toEqual(measurementCoverage);
    });

    it('omits measurementCoverage when null', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };
      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xnocoverage',
        result,
        metadata,
        measurementCoverage: null,
      });

      expect(payload.measurementCoverage).toBeUndefined();
    });

    it('omits measurementCoverage when not provided', () => {
      const result: AgentExecutionResult = {
        output: 'Done',
        telemetry: {},
      };
      const metadata: IpfsMetadata = {};

      const payload = buildDeliveryPayload({
        requestId: '0xdefault',
        result,
        metadata,
      });

      expect(payload.measurementCoverage).toBeUndefined();
    });
  });
});
