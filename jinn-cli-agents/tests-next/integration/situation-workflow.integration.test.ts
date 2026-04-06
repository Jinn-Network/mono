import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { formatRecognitionMarkdown, normalizeLearnings } from 'jinn-node/worker/recognition_helpers.js';

type StoredRow = {
  nodeId: string;
  vector: number[];
  summary: string | null;
  meta: Record<string, unknown> | null;
};

const createdArtifacts: Array<{ name: string; topic: string; content: string }> = [];
const dbRows: StoredRow[] = [];
const embedMock = vi.fn();

let createSituationArtifactForRequest: any;
let searchSimilarSituations: any;

function parseVectorLiteral(literal: string): number[] {
  return literal
    .replace(/[\[\]\s]/g, '')
    .split(',')
    .filter(Boolean)
    .map((value) => Number(value));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((acc, val, idx) => acc + val * b[idx], 0);
  const magA = Math.sqrt(a.reduce((acc, val) => acc + val * val, 0));
  const magB = Math.sqrt(b.reduce((acc, val) => acc + val * val, 0));
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

beforeEach(async () => {
  vi.resetModules();
  createdArtifacts.splice(0, createdArtifacts.length);
  dbRows.splice(0, dbRows.length);
  embedMock.mockReset();
  process.env.NODE_EMBEDDINGS_DB_URL = 'postgres://local-test';

  vi.doMock('pg', () => {
    class FakeClient extends EventEmitter {
      async connect() {}
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ count: dbRows.length }] };
        }
        // Handle both simple and subquery patterns
        if (!sql.includes('node_id')) {
          throw new Error(`Unexpected SQL executed in test: ${sql}`);
        }
        const vectorLiteral = typeof params[0] === 'string' ? params[0] : String(params[0] ?? '[]');
        const queryVector = parseVectorLiteral(vectorLiteral);
        const limit = Number(params[1]) || 5;
        const rows = dbRows
          .map((row) => ({
            node_id: row.nodeId,
            summary: row.summary,
            meta: row.meta,
            score: cosineSimilarity(queryVector, row.vector),
          }))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, limit);
        return { rows };
      }
      async end() {}
    }

    class FakePool {
      async query(sql: string, params: unknown[]) {
        const client = new FakeClient();
        await client.connect();
        const result = await client.query(sql, params);
        await client.end();
        return result;
      }
    }

    return { Client: FakeClient, Pool: FakePool };
  });

  vi.doMock('../../gemini-agent/mcp/tools/embed_text.js', () => ({
    embedText: embedMock.mockImplementation(async () => {
      // Generate a 256-dimensional vector to match search_similar_situations expectations
      const vector = Array(256).fill(0);
      vector[0] = 1; // Set first component to 1 for test
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ data: { model: 'test', dim: 256, vector }, meta: { ok: true } }),
          },
        ],
      };
    }),
  }));

  vi.doMock('../../gemini-agent/mcp/tools/create_artifact.js', () => ({
    createArtifact: vi.fn(async (payload: any) => {
      createdArtifacts.push(payload);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              data: {
                cid: `bafy${createdArtifacts.length}`,
                name: payload.name,
                topic: payload.topic,
                contentPreview: payload.content.slice(0, 80),
              },
              meta: { ok: true },
            }),
          },
        ],
      };
    }),
  }));

  vi.doMock('../../worker/control_api_client.js', () => ({
    createArtifact: vi.fn(async () => 'artifact-row'),
    createJobReport: vi.fn(),
    claimRequest: vi.fn(),
  }));

  ({ createSituationArtifactForRequest } = await import('../../worker/situation_artifact.js'));
  ({ searchSimilarSituations } = await import('../../gemini-agent/mcp/tools/search_similar_situations.js'));
});

describe('situation workflow integration', () => {
  it('creates situation artifact and retrieves it via semantic search', async () => {
    const jobBlueprint = JSON.stringify({
      assertions: [{
        id: 'SIT-001',
        assertion: 'Explain staking reward drop and produce mitigation memo.',
        examples: {
          do: [
            'Analyze validator behavior and reward distribution history.',
            'Propose concrete remediation steps with timelines.',
          ],
          dont: [
            'Provide speculative explanations without data support.',
            'Skip documenting mitigation steps.',
          ],
        },
        commentary: 'Blueprint-driven situation test ensuring blueprint metadata propagates through situation artifacts.',
      }],
    });

    // Model is specified in job metadata, not from environment
    const jobMetadata = {
      jobName: 'Investigate staking rewards variance',
      jobDefinitionId: 'job-def',
      blueprint: jobBlueprint,
      model: 'gemini-2.5-pro', // Explicit model in job metadata
    };

    const result = {
      output: 'Identified validator misconfiguration causing reward drop.',
      telemetry: {
        toolCalls: [
          {
            tool: 'search_artifacts',
            args: JSON.stringify({ query: 'staking rewards' }),
            success: true,
            result: { data: [{ id: 'artifact-1' }] },
          },
        ],
      },
      artifacts: [],
    };

    await createSituationArtifactForRequest({
      target: { id: '0xaaa', mech: '0xmech', requester: '0xreq' },
      metadata: jobMetadata,
      result,
      finalStatus: { status: 'COMPLETED', message: 'ok' },
      recognition: null,
    });

    expect(createdArtifacts).toHaveLength(1);
    const stored = JSON.parse(createdArtifacts[0].content);
      expect(stored.job.model).toBe('gemini-2.5-pro');
    dbRows.push({
      nodeId: stored.job.requestId,
      vector: stored.embedding.vector,
      summary: stored.meta?.summaryText || null,
      meta: stored.meta || {},
    });

    const response = await searchSimilarSituations({ query_text: 'staking reward investigation', k: 1 });
    const parsed = JSON.parse(response.content[0].text);
    
    // Debug output if test fails
    if (!parsed.meta.ok) {
      console.error('[Test Debug] Search failed:', parsed.meta);
    }
    
    expect(parsed.meta.ok).toBe(true);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].nodeId).toBe('0xaaa');
    expect(parsed.data[0].summary).toContain('Job 0xaaa');
  });

  it('stores recognition metadata and surfaces it in search results', async () => {
    const recognitionLearnings = normalizeLearnings({
      learnings: [
        {
          sourceRequestId: '0xaaa',
          title: 'Retry RPC requests',
          insight: 'Use exponential backoff with jitter',
          actions: ['Implement retry helper'],
          warnings: ['Monitor for cascading failures'],
          confidence: 'high',
        },
      ],
    });
    const recognitionMarkdown = formatRecognitionMarkdown(recognitionLearnings);

    const recognition = {
      promptPrefix: recognitionMarkdown,
      learningsMarkdown: recognitionMarkdown,
      rawLearnings: recognitionLearnings,
    };

    const result = {
      output: 'Added backoff retries for RPC queries.',
      telemetry: { toolCalls: [] },
      artifacts: [],
    };

    const recognitionBlueprint = JSON.stringify({
      assertions: [{
        id: 'SIT-002',
        assertion: 'Harden RPC client with retry logic.',
        examples: {
          do: ['Implement exponential backoff with jitter', 'Document retry configuration'],
          dont: ['Retry indefinitely without fallbacks'],
        },
        commentary: 'Recognition scenario blueprint for RPC client hardening.',
      }],
    });

    await createSituationArtifactForRequest({
      target: { id: '0xbbb', mech: '0xmech', requester: '0xreq' },
      metadata: { jobName: 'Harden RPC client', jobDefinitionId: 'job-def', blueprint: recognitionBlueprint },
      result,
      finalStatus: { status: 'COMPLETED', message: 'ok' },
      recognition,
    });

    const stored = JSON.parse(createdArtifacts.at(-1)!.content);
    expect(stored.meta.recognition.markdown).toContain('Recognition Learnings');
    dbRows.push({
      nodeId: stored.job.requestId,
      vector: stored.embedding.vector,
      summary: stored.meta?.summaryText || null,
      meta: stored.meta || {},
    });

    const response = await searchSimilarSituations({ query_text: 'rpc retry strategy', k: 1 });
    const parsed = JSON.parse(response.content[0].text);
    
    // Debug output if test fails
    if (!parsed.meta.ok || !parsed.data || parsed.data.length === 0) {
      console.error('[Test Debug] Search failed or no data:', parsed);
    }
    
    expect(parsed.data).toBeDefined();
    expect(parsed.data.length).toBeGreaterThan(0);
    expect(parsed.data[0].nodeId).toBe('0xbbb');
    expect(parsed.data[0].meta.recognition.markdown).toContain('Recognition Learnings');
  });
});
