import { describe, expect, it } from 'vitest';
import { CapturedTaskSchema } from '../src/captured-task.js';

function capturedTaskWithVerifier(verifier: unknown) {
  return {
    session: {
      sessionId: 'session-1',
      capturedAt: '2026-07-20T00:00:00.000Z',
    },
    task: {
      summary: 'Fix the failing test',
      distributionTags: ['coding'],
    },
    environment: {
      harness: { name: 'test-harness', version: '1.0.0' },
      model: 'test-model',
      tools: [],
      verifier,
    },
    steps: [{
      spanId: 'span-1',
      parentSpanId: null,
      name: 'turn',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {},
    }],
    outcome: {
      status: 'completed',
      verifiabilityTier: 'evaluator-verified',
    },
    cost: { durationMs: 1 },
  };
}

describe('CapturedTaskSchema verifier evidence', () => {
  it('preserves derived historical provenance', () => {
    const parsed = CapturedTaskSchema.parse({
      ...capturedTaskWithVerifier({ type: 'none' }),
      provenance: 'derived-from-history',
    });

    expect(parsed.provenance).toBe('derived-from-history');
  });

  it.each([
    { type: 'f2p-p2p' },
    {
      type: 'f2p-p2p',
      failToPass: [],
      evalSemanticsVersion: 'swe-rebench-v2.1',
    },
    {
      type: 'f2p-p2p',
      passToPass: [],
      evalSemanticsVersion: 'swe-rebench-v2.1',
    },
    {
      type: 'f2p-p2p',
      failToPass: [],
      passToPass: [],
      evalSemanticsVersion: '',
    },
  ])('rejects incomplete f2p-p2p facts: %j', (verifier) => {
    expect(() => CapturedTaskSchema.parse(
      capturedTaskWithVerifier(verifier),
    )).toThrow();
  });

  it('accepts explicit empty test arrays with a nonempty semantics version', () => {
    expect(CapturedTaskSchema.parse(capturedTaskWithVerifier({
      type: 'f2p-p2p',
      failToPass: [],
      passToPass: [],
      evalSemanticsVersion: 'swe-rebench-v2.1',
    })).environment.verifier).toEqual({
      type: 'f2p-p2p',
      failToPass: [],
      passToPass: [],
      evalSemanticsVersion: 'swe-rebench-v2.1',
    });
  });

  it('retains defaulted compatibility fields for non-f2p verifier types', () => {
    expect(CapturedTaskSchema.parse(capturedTaskWithVerifier({
      type: 'none',
    })).environment.verifier).toEqual({
      type: 'none',
      failToPass: [],
      passToPass: [],
    });
  });

  it('preserves optional typed observations, span status, and source lineage', () => {
    const parsed = CapturedTaskSchema.parse({
      ...capturedTaskWithVerifier({ type: 'none' }),
      steps: [{
        spanId: 'span-1',
        parentSpanId: null,
        kind: 'jinn.tool_call',
        name: 'tool_call.command_execution',
        startTimeUnixNano: '1',
        endTimeUnixNano: '2',
        attributes: { 'tool.args': { command: 'false' } },
        events: [{
          timeUnixNano: '2',
          name: 'tool_result',
          attributes: {
            'tool.result': 'command failed',
            'tool.result.is_error': true,
          },
        }],
        status: { code: 'ERROR', message: 'exit 1' },
      }],
      lineage: { episodeId: 'bafySolutionEnvelope' },
    });

    expect(parsed.steps[0]).toMatchObject({
      events: [{
        name: 'tool_result',
        attributes: {
          'tool.result': 'command failed',
          'tool.result.is_error': true,
        },
      }],
      status: { code: 'ERROR', message: 'exit 1' },
    });
    expect(parsed.lineage).toEqual({ episodeId: 'bafySolutionEnvelope' });
  });
});
