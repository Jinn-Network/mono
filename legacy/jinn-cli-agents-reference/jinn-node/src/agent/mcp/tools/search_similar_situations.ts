import { z } from 'zod';
import { Client } from 'pg';
import { embedText } from './embed_text.js';
import { mcpLogger } from '../../../logging/index.js';

export const searchSimilarSituationsParams = z.object({
  query_text: z.string().min(5, 'query_text must contain at least 5 characters'),
  k: z.number().int().positive().max(25).optional(),
});

export const searchSimilarSituationsSchema = {
  description: 'Perform semantic similarity search over stored situation embeddings and return top matches with scores.',
  inputSchema: searchSimilarSituationsParams.shape,
};

type DbMatchRow = {
  node_id: string;
  summary: string | null;
  meta: Record<string, unknown> | null;
  score?: number | string;
};

interface EmbeddingResult {
  model: string;
  dim: number;
  vector: number[];
}

function serializeVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function getDatabaseUrl(): string | null {
  const candidates = [
    process.env.NODE_EMBEDDINGS_DB_URL,
    process.env.SITUATION_DB_URL,
    process.env.PONDER_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.SUPABASE_DB_URL,
    process.env.SUPABASE_POSTGRES_URL,
  ];
  return candidates.find((url) => typeof url === 'string' && url.length > 0) || null;
}

async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  // CRITICAL: Must match database VECTOR(256) dimension
  const response = await embedText({ text, dim: 256 });
  const parsed = (() => {
    try {
      const payload = JSON.parse(response?.content?.[0]?.text || '{}');
      if (payload?.meta && payload.meta.ok === false) {
        throw new Error(payload.meta.message || 'Embedding tool returned error');
      }
      const data = payload?.data;
      if (!data || !Array.isArray(data.vector)) {
        throw new Error('Embedding tool response missing vector');
      }
      return data;
    } catch (error: any) {
      throw new Error(error?.message || 'Failed to parse embed_text response');
    }
  })();
  return parsed;
}

export async function searchSimilarSituations(args: unknown) {
  try {
    const parsed = searchSimilarSituationsParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              data: [],
              meta: {
                ok: false,
                code: 'VALIDATION_ERROR',
                message: parsed.error.message,
              },
            }),
          },
        ],
      };
    }

    const { query_text, k = 5 } = parsed.data;

    const dbUrl = getDatabaseUrl();
    if (!dbUrl) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              data: [],
              meta: {
                ok: false,
                code: 'CONFIG_ERROR',
                message: 'NODE_EMBEDDINGS_DB_URL (or compatible) not configured',
              },
            }),
          },
        ],
      };
    }

    const embedding = await generateEmbedding(query_text);
    mcpLogger.info({ model: embedding.model, dim: embedding.dim, vectorLength: embedding.vector.length }, 'Generated embedding for search');

    const client = new Client({ connectionString: dbUrl });
    // Suppress unhandled error events from the client (e.g. unexpected server-side termination)
    client.on('error', (err) => {
      mcpLogger.warn({ err: err.message }, 'PG Client encountered error (suppressed)');
    });

    let rows: DbMatchRow[] = [];
    try {
      await client.connect();
      mcpLogger.debug('Connected to database for vector search');

      // Use test table when running under Vitest to isolate test data
      const tableName = process.env.VITEST === 'true' ? 'node_embeddings_test' : 'node_embeddings';

      // Check table has data
      const countRes = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
      mcpLogger.info({ rowCount: countRes.rows[0].count, tableName }, 'Embeddings table row count');

      const vectorLiteral = serializeVector(embedding.vector);

      // NOTE: pgvector ORDER BY with distance operator fails in some configurations
      // Workaround: Use subquery to calculate scores, then ORDER BY score column
      const sql = `
        SELECT node_id, summary, meta, score
        FROM (
          SELECT
            node_id,
            summary,
            meta,
            1 - (vec <=> $1::vector) AS score
          FROM ${tableName}
        ) AS scored
        ORDER BY score DESC
        LIMIT $2;
      `;
      const res = await client.query(sql, [vectorLiteral, k]);
      rows = res.rows as DbMatchRow[];
      mcpLogger.info({ resultCount: rows.length, k, firstRow: rows[0] }, 'Vector search completed');
    } catch (dbError: any) {
      mcpLogger.error({ error: dbError.message, stack: dbError.stack }, 'Database query error in vector search');
      throw dbError;
    } finally {
      await client.end().catch(() => {});
    }

    const results = rows.map((row) => ({
      nodeId: row.node_id,
      score: typeof row.score === 'string' ? Number(row.score) : Number(row.score ?? 0),
      summary: row.summary,
      meta: row.meta,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            data: results,
            meta: {
              ok: true,
              model: embedding.model,
              dim: embedding.dim,
              count: results.length,
            },
          }),
        },
      ],
    };
  } catch (error: any) {
    mcpLogger.warn({ message: error?.message || String(error) }, 'search_similar_situations error');
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            data: [],
            meta: {
              ok: false,
              code: 'EXECUTION_ERROR',
              message: error?.message || String(error),
            },
          }),
        },
      ],
    };
  }
}
