import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SITUATION_ARTIFACT_VERSION } from 'jinn-node/types/situation.js';

const fetchMock = vi.fn();

vi.mock('cross-fetch', () => ({
  default: fetchMock,
}));

let encodeSituation: (args: any) => Promise<any>;

const requestResponse = {
  data: {
    request: {
      id: '0xabc',
      jobDefinitionId: 'job-def-123',
      sourceRequestId: '0xparent',
      sourceJobDefinitionId: 'job-parent',
      jobName: 'Analyze staking contract performance',
      additionalContext: {
        objective: 'Inspect staking contract',
        acceptanceCriteria: 'Produce summary memo',
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
      blueprint: `# Objective
Inspect staking contract

# Context
Review staking flows

# Acceptance Criteria
Produce summary memo`,
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

  ({ encodeSituation } = await import('../../worker/situation_encoder.js'));
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
    expect(situation.job.objective).toBe('Inspect staking contract');
    expect(situation.job.acceptanceCriteria).toBe('Produce summary memo');
    expect(situation.job.prompt).toContain('# Objective');
    expect(situation.context.parentRequestId).toBe('0xparent');
    expect(situation.context.parent).toEqual({
      requestId: '0xparent',
      jobDefinitionId: 'job-parent',
    });
    expect(situation.context.childRequestIds).toEqual(['0xchild1', '0xchild2']);
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
    expect(situation.job.objective).toBe('Inspect staking contract');
    expect(summaryText).toContain('Job 0xdead');
    expect(summaryText).toContain('Status: FAILED');
  });
});
