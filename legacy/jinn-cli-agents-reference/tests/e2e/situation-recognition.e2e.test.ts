import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  process.env.NODE_EMBEDDINGS_DB_URL = 'postgres://recognition-e2e';

  vi.doMock('pg', () => {
    class FakeClient {
      async connect() {}
      async query(sql: string, params: unknown[]) {
        if (!sql.includes('SELECT')) {
          throw new Error(`Unexpected SQL executed in e2e test: ${sql}`);
        }
        const queryVector = parseVectorLiteral(String(params[0]));
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
    embedText: embedMock.mockImplementation(async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ data: { model: 'test', dim: 3, vector: [1, 0, 0] }, meta: { ok: true } }),
        },
      ],
    })),
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

describe('situation recognition e2e', () => {
  it('runs two job cycles and surfaces learnings for subsequent recognition', async () => {
    const firstRun = {
      output: 'Compiled address book of high-value validators.',
      telemetry: {
        toolCalls: [
          {
            tool: 'search_artifacts',
            args: JSON.stringify({ query: 'validator list' }),
            success: true,
            result: { data: [{ id: 'artifact-first' }] },
          },
        ],
      },
      artifacts: [],
    };

    await createSituationArtifactForRequest({
      target: { id: '0xcreator', mech: '0xmech', requester: '0xreq' },
      metadata: {
        jobName: 'Catalog validator addresses',
        jobDefinitionId: 'job-creator',
      },
      result: firstRun,
      finalStatus: { status: 'COMPLETED', message: 'ok' },
      recognition: null,
    });

    const creatorSituation = JSON.parse(createdArtifacts[0].content);
    dbRows.push({
      nodeId: creatorSituation.job.requestId,
      vector: creatorSituation.embedding.vector,
      summary: creatorSituation.meta?.summaryText || null,
      meta: creatorSituation.meta || {},
    });

    const recognitionLearnings = normalizeLearnings({
      learnings: [
        {
          sourceRequestId: '0xcreator',
          title: 'Reference validator catalog',
          insight: 'Use existing address catalog for staking diagnostics',
          actions: ['Fetch validator metadata from catalog'],
          warnings: ['Ensure catalog freshness'],
          confidence: 'medium',
        },
      ],
    });

    const recognitionMarkdown = formatRecognitionMarkdown(recognitionLearnings);

    const secondRun = {
      output: 'Diagnosed validator with missing heartbeat.',
      telemetry: { toolCalls: [] },
      artifacts: [],
    };

    await createSituationArtifactForRequest({
      target: { id: '0xlearner', mech: '0xmech', requester: '0xreq' },
      metadata: {
        jobName: 'Investigate validator heartbeat failure',
        jobDefinitionId: 'job-learner',
      },
      result: secondRun,
      finalStatus: { status: 'COMPLETED', message: 'ok' },
      recognition: {
        promptPrefix: recognitionMarkdown,
        learningsMarkdown: recognitionMarkdown,
        rawLearnings: recognitionLearnings,
      },
    });

    const learnerSituation = JSON.parse(createdArtifacts.at(-1)!.content);
    expect(learnerSituation.meta.recognition.markdown).toContain('Recognition Learnings');
    dbRows.push({
      nodeId: learnerSituation.job.requestId,
      vector: learnerSituation.embedding.vector,
      summary: learnerSituation.meta?.summaryText || null,
      meta: learnerSituation.meta || {},
    });

    const response = await searchSimilarSituations({ query_text: 'validator diagnostics using catalog', k: 2 });
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.data[0].nodeId).toBe('0xcreator');
    expect(parsed.data[0].meta.summaryText).toContain('Job 0xcreator');
    expect(parsed.data[1].nodeId).toBe('0xlearner');
    expect(parsed.data[1].meta.recognition.markdown).toContain('Recognition Learnings');
  });
});
