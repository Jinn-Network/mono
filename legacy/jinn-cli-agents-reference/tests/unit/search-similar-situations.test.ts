import { beforeEach, describe, expect, it, vi } from 'vitest';

type StoredVector = {
  nodeId: string;
  vector: number[];
  summary: string | null;
  meta: Record<string, unknown> | null;
};

const storedVectors: StoredVector[] = [];

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

// Create mock implementations before importing modules
const embedTextMock = vi.fn();
const mcpLoggerMock = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

class FakeClient {
  async connect() {}
  async query(sql: string, params: unknown[]) {
    if (!sql.includes('SELECT')) {
      throw new Error('Unexpected SQL executed in test');
    }
    const vectorLiteral = String(params[0]);
    const limit = Number(params[1]) || 5;
    const queryVector = parseVectorLiteral(vectorLiteral);

    const rows = storedVectors
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

// Hoist mocks before any module imports
vi.mock('../../logging/index.js', () => ({
  mcpLogger: mcpLoggerMock,
}));

vi.mock('../../gemini-agent/mcp/tools/embed_text.js', () => ({
  embedText: embedTextMock,
}));

vi.mock('pg', () => ({
  Client: FakeClient,
}));

beforeEach(() => {
  storedVectors.splice(0, storedVectors.length);
  vi.clearAllMocks();
});

describe('search_similar_situations tool', () => {
  it('returns configuration error when vector database URL is missing', async () => {
    embedTextMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ data: { model: 'test', dim: 3, vector: [1, 0, 0] }, meta: { ok: true } }),
        },
      ],
    });

    process.env.NODE_EMBEDDINGS_DB_URL = '';
    const { searchSimilarSituations } = await import('../../gemini-agent/mcp/tools/search_similar_situations.js');
    const response = await searchSimilarSituations({ query_text: 'analyze staking contract' });
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.meta.ok).toBe(false);
    expect(parsed.meta.code).toBe('CONFIG_ERROR');
  });

  it.skip('orders results by similarity using mocked pg client', async () => {
    embedTextMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ data: { model: 'test', dim: 3, vector: [1, 0, 0] }, meta: { ok: true } }),
        },
      ],
    });

    process.env.NODE_EMBEDDINGS_DB_URL = 'postgres://local';
    
    storedVectors.push(
      {
        nodeId: '0xaaa',
        vector: [1, 0, 0],
        summary: 'Investigated staking rewards distribution',
        meta: { job: { jobName: 'Staking analysis' } },
      },
      {
        nodeId: '0xbb',
        vector: [0, 1, 0],
        summary: 'Performed unrelated treasury task',
        meta: { job: { jobName: 'Treasury review' } },
      },
    );

    const { searchSimilarSituations } = await import('../../gemini-agent/mcp/tools/search_similar_situations.js');
    const response = await searchSimilarSituations({ query_text: 'staking rewards', k: 2 });
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.meta.ok).toBe(true);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].nodeId).toBe('0xaaa');
    expect(parsed.data[0].score).toBeGreaterThan(parsed.data[1].score);
  });
});
