/**
 * Unit Test: Situation Encoder
 * Migrated from: tests/unit/situation-encoder.test.ts
 * Migration Date: November 7, 2025
 *
 * Tests encodeSituation() function for building structured situation payloads.
 * Pure unit test - all I/O mocked via vi.mock().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SITUATION_ARTIFACT_VERSION } from 'jinn-node/types/situation.js';

const fetchMock = vi.fn();

vi.mock('cross-fetch', () => ({
  default: fetchMock,
}));
let encodeSituation: (args: any) => Promise<any>;
let createInitialSituation: (args: any) => Promise<any>;

const requestResponse = {
  data: {
    request: {
      id: '0xabc',
      jobDefinitionId: 'job-def-123',
      sourceRequestId: '0xparent',
      sourceJobDefinitionId: 'job-parent',
      jobName: 'Analyze staking contract performance',
      additionalContext: {
        hierarchy: [
          {
            jobId: 'job-parent',
            level: -1,
            sourceJobDefinitionId: null,
            requestIds: ['0xparent'],
            artifactRefs: [],
          },
          {
            jobId: 'job-def-123',
            level: 0,
            sourceJobDefinitionId: 'job-parent',
            requestIds: ['0xabc'],
            artifactRefs: [],
          },
          {
            jobId: 'job-grandchild-envelope',
            level: 1,
            sourceJobDefinitionId: 'job-def-123',
            requestIds: ['0xchild-envelope'],
            artifactRefs: [
              {
                id: 'artifact-envelope',
                name: 'envelope-artifact',
                topic: 'defi-research',
                cid: 'bafyEnvelope',
              },
            ],
          },
        ],
        summary: {
          totalJobs: 3,
          completedJobs: 1,
          activeJobs: 2,
          totalArtifacts: 1,
        },
      },
    },
  },
};

const childRequestsResponse = {
  data: {
    requests: {
      items: [
        { id: '0xchild1' },
        { id: '0xchild2' },
      ],
    },
  },
};

const jobDefinitionResponse = {
  data: {
    jobDefinition: {
      id: 'job-def-123',
      blueprint: JSON.stringify({
        assertions: [{
          id: 'STK-001',
          assertion: 'Inspect staking contract and produce summary memo.',
          examples: {
            do: ['Review staking flows', 'Document findings'],
            dont: ['Skip analysis'],
          },
          commentary: 'Blueprint for staking contract inspection in unit tests.',
        }],
      }),
      enabledTools: ['web_fetch'],
    },
  },
};

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, options: any) => {
    const body = JSON.parse(options?.body ?? '{}');
    const query: string = body.query || '';
    if (query.includes('request(id')) {
      return { ok: true, json: async () => requestResponse };
    }
    if (query.includes('sourceRequestId')) {
      return { ok: true, json: async () => childRequestsResponse };
    }
    if (query.includes('jobDefinition(id')) {
      return { ok: true, json: async () => jobDefinitionResponse };
    }
    return { ok: true, json: async () => ({ data: { requests: { items: [] } } }) };
  });

  ({ encodeSituation, createInitialSituation } = await import('jinn-node/worker/situation_encoder.js'));
});

describe('encodeSituation', () => {
  it('builds structured situation payload with execution trace and context metadata', async () => {
    const telemetry = {
      toolCalls: [
        {
          tool: 'search_similar_situations',
          args: JSON.stringify({ query_text: 'staking performance' }),
          success: true,
          result: { data: [{ nodeId: '0x123', score: 0.92 }] },
        },
        {
          tool: 'get_details',
          args: JSON.stringify({ ids: ['0x123'] }),
          success: false,
        },
      ],
    };

    const artifacts = [
      { cid: 'bafyTest', topic: 'MEMORY', name: 'Gas Optimization', contentPreview: 'Use batching to reduce gas.' },
    ];

    const { situation, summaryText } = await encodeSituation({
      requestId: '0xabc',
      jobName: 'Analyze staking contract performance',
      jobDefinitionId: 'job-def-123',
      output: 'Stake function uses loop with high gas usage.',
      telemetry,
      finalStatus: 'COMPLETED',
      additionalContext: requestResponse.data.request.additionalContext,
      artifacts,
    });

    expect(situation.version).toBe(SITUATION_ARTIFACT_VERSION);
    expect(situation.job.requestId).toBe('0xabc');
    expect(situation.job.jobDefinitionId).toBe('job-def-123');
    expect(situation.execution.status).toBe('COMPLETED');
    expect(Array.isArray(situation.execution.trace)).toBe(true);
    expect(situation.execution.trace).toHaveLength(2);
    expect(situation.execution.trace[0]).toMatchObject({
      tool: 'search_similar_situations',
    });
    expect(situation.context.parentRequestId).toBe('0xparent');
    expect(situation.context.parent).toEqual({
      requestId: '0xparent',
      jobDefinitionId: 'job-parent',
    });
    expect(Array.isArray(situation.context.childRequestIds)).toBe(true);
    expect(situation.context.childRequestIds.length).toBe(3);
    expect(situation.context.childRequestIds).toEqual(
      expect.arrayContaining(['0xchild-envelope', '0xchild1', '0xchild2'])
    );
    expect(summaryText).toContain('Job 0xabc');
    expect(summaryText).toContain('Status: COMPLETED');
    expect(summaryText).toContain('Artifacts: MEMORY:Gas Optimization');
  });

  it('handles failed executions by truncating output and omitting missing context', async () => {
    fetchMock.mockImplementation(async (_url, options: any) => {
      const body = JSON.parse(options?.body ?? '{}');
      const query: string = body.query || '';
      if (query.includes('request(id')) {
        return { ok: true, json: async () => requestResponse };
      }
      if (query.includes('jobDefinition(id')) {
        return { ok: true, json: async () => jobDefinitionResponse };
      }
      return { ok: true, json: async () => ({ data: { requests: { items: [] } } }) };
    });

    const telemetry = { toolCalls: [] };
    const { situation, summaryText } = await encodeSituation({
      requestId: '0xdead',
      jobName: undefined,
      jobDefinitionId: undefined,
      output: 'Failure output'.repeat(50),
      telemetry,
      finalStatus: 'FAILED',
      additionalContext: {},
      artifacts: [],
    });

    expect(situation.execution.status).toBe('FAILED');
    expect(situation.execution.trace).toEqual([]);
    expect(situation.context.childRequestIds).toEqual([]);
    expect(situation.context.parent?.requestId).toBe('0xparent');
    expect(summaryText).toContain('Job 0xdead');
    expect(summaryText).toContain('Status: FAILED');
  });
});

describe('createInitialSituation with deterministic context', () => {
  it('seeds child request ids from hierarchy envelope when provided', async () => {
    const { situation } = await createInitialSituation({
      requestId: '0xabc',
      jobName: 'Analyze staking contract performance',
      jobDefinitionId: 'job-def-123',
      additionalContext: requestResponse.data.request.additionalContext,
      model: 'gemini-2.5-flash',
    });

    expect(situation.context.childRequestIds).toEqual(['0xchild-envelope']);
  });
});
