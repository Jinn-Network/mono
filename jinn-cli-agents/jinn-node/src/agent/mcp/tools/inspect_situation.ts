import { z } from 'zod';
// @ts-ignore - pg package exists but @types/pg not installed
import { Client } from 'pg';
import fetch from 'cross-fetch';
import type { Situation, SituationNodeEmbeddingRecord } from '../../../types/situation.js';
import { mcpLogger } from '../../../logging/index.js';
import { config } from '../../../config/index.js';

export const inspectSituationParams = z.object({
  request_id: z.string().min(1, 'request_id is required'),
  include_similar: z.boolean().optional().default(true),
  similar_k: z.number().int().positive().max(10).optional().default(5),
});

export const inspectSituationSchema = {
  description: 'Inspect the memory system for a given request/job. Returns the SITUATION artifact, database record, and optionally similar situations.',
  inputSchema: inspectSituationParams.shape,
};

const PONDER_GRAPHQL_URL = config.services.ponderUrl;
const IPFS_GATEWAY_BASE = config.services.ipfsGatewayUrl.replace(/\/+$/, '/');

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

function serializeVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

interface ArtifactRecord {
  id: string;
  requestId: string;
  name: string;
  cid: string;
  topic: string;
  type?: string;
  contentPreview?: string;
}

async function fetchGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      mcpLogger.warn({ status: res.status }, 'GraphQL request failed');
      return null;
    }
    const json = await res.json();
    if (json.errors) {
      mcpLogger.warn({ errors: json.errors }, 'GraphQL returned errors');
      return null;
    }
    return json.data as T;
  } catch (error: any) {
    mcpLogger.warn({ message: error?.message || String(error) }, 'GraphQL error');
    return null;
  }
}

async function fetchSituationArtifact(requestId: string): Promise<{ artifact: ArtifactRecord | null; situation: Situation | null }> {
  const query = `
    query GetSituationArtifact($requestId: String!) {
      artifacts(where: { AND: [{ requestId: $requestId }, { topic: "SITUATION" }] }, limit: 1) {
        items {
          id
          requestId
          name
          cid
          topic
          type
          contentPreview
        }
      }
    }
  `;

  const data = await fetchGraphQL<{ artifacts: { items: ArtifactRecord[] } }>(query, { requestId });
  const artifact = data?.artifacts?.items?.[0] || null;

  if (!artifact) {
    return { artifact: null, situation: null };
  }

  try {
    const url = `${IPFS_GATEWAY_BASE}${artifact.cid}`;
    const res = await fetch(url, { timeout: 8000 } as any);
    if (!res.ok) {
      mcpLogger.warn({ status: res.status, cid: artifact.cid }, 'Failed to fetch IPFS content');
      return { artifact, situation: null };
    }

    let situationData = await res.json();

    if (situationData.content && typeof situationData.content === 'string') {
      try {
        situationData = JSON.parse(situationData.content);
      } catch (e) {
        mcpLogger.warn({ cid: artifact.cid }, 'Failed to parse wrapped artifact content');
      }
    }

    return { artifact, situation: situationData as Situation };
  } catch (error: any) {
    mcpLogger.warn({ cid: artifact.cid, error: error?.message }, 'Error fetching situation from IPFS');
    return { artifact, situation: null };
  }
}

async function fetchNodeEmbedding(requestId: string, client: Client): Promise<SituationNodeEmbeddingRecord | null> {
  try {
    const res = await client.query(
      'SELECT node_id, model, dim, summary, meta, updated_at FROM node_embeddings WHERE node_id = $1',
      [requestId]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return {
      nodeId: row.node_id,
      model: row.model,
      dim: row.dim,
      vector: [],
      summary: row.summary,
      meta: row.meta,
      updatedAt: row.updated_at,
    };
  } catch (error: any) {
    mcpLogger.warn({ requestId, error: error?.message }, 'Error fetching node embedding');
    return null;
  }
}

async function searchSimilarSituations(
  vector: number[],
  k: number,
  client: Client,
  excludeNodeId: string
): Promise<Array<{ nodeId: string; score: number; summary: string | null; meta: any }>> {
  try {
    const vectorLiteral = serializeVector(vector);
    const sql = `
      SELECT node_id, summary, meta, score
      FROM (
        SELECT 
          node_id,
          summary,
          meta,
          1 - (vec <=> $1::vector) AS score
        FROM node_embeddings
        WHERE node_id != $3
      ) AS scored
      ORDER BY score DESC
      LIMIT $2;
    `;

    const res = await client.query(sql, [vectorLiteral, k, excludeNodeId]);

    return res.rows.map((row: any) => ({
      nodeId: row.node_id,
      score: typeof row.score === 'string' ? Number(row.score) : Number(row.score ?? 0),
      summary: row.summary,
      meta: row.meta,
    }));
  } catch (error: any) {
    mcpLogger.warn({ error: error?.message }, 'Error searching similar situations');
    return [];
  }
}

function truncate(text: string | null | undefined, maxLength: number): string {
  if (!text) return '';
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

export async function inspectSituation(args: unknown) {
  try {
    const parsed = inspectSituationParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
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

    const { request_id, include_similar, similar_k } = parsed.data;

    mcpLogger.info({ requestId: request_id }, 'Inspecting situation');

    // Fetch situation artifact
    const { artifact, situation } = await fetchSituationArtifact(request_id);

    if (!artifact) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: {
                ok: false,
                code: 'NOT_FOUND',
                message: `No SITUATION artifact found for request ${request_id}`,
              },
            }),
          },
        ],
      };
    }

    if (!situation) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              data: {
                artifact: {
                  cid: artifact.cid,
                  name: artifact.name,
                  topic: artifact.topic,
                },
                situation: null,
              },
              meta: {
                ok: false,
                code: 'IPFS_ERROR',
                message: 'Found artifact but could not fetch content from IPFS',
              },
            }),
          },
        ],
      };
    }

    // Build response data
    const responseData: any = {
      artifact: {
        cid: artifact.cid,
        name: artifact.name,
        topic: artifact.topic,
        type: artifact.type,
      },
      situation: {
        version: situation.version,
        job: situation.job,
        execution: situation.execution ? {
          status: situation.execution.status,
          traceLength: situation.execution.trace.length,
          trace: situation.execution.trace.slice(0, 10).map(step => ({
            tool: step.tool,
            args: truncate(step.args, 150),
            result_summary: truncate(step.result_summary, 150),
          })),
          finalOutputSummary: truncate(situation.execution.finalOutputSummary, 500),
        } : null,
        context: situation.context,
        artifacts: situation.artifacts,
        embedding: {
          model: situation.embedding?.model,
          dim: situation.embedding?.dim,
          vectorLength: situation.embedding?.vector?.length,
        },
        recognition: situation.meta?.recognition || null,
      },
    };

    // Database lookups
    const dbUrl = getDatabaseUrl();
    if (dbUrl) {
      const client = new Client({ connectionString: dbUrl });
      // Suppress unhandled error events from the client (e.g. unexpected server-side termination)
      client.on('error', (err) => {
        mcpLogger.warn({ err: err.message }, 'PG Client encountered error (suppressed)');
      });

      try {
        await client.connect();

        const embedding = await fetchNodeEmbedding(request_id, client);
        if (embedding) {
          responseData.database_record = {
            nodeId: embedding.nodeId,
            model: embedding.model,
            dim: embedding.dim,
            summary: truncate(embedding.summary, 500),
            updatedAt: embedding.updatedAt,
            metaFields: embedding.meta ? Object.keys(embedding.meta) : [],
          };
        }

        if (include_similar && situation.embedding && situation.embedding.vector.length > 0) {
          const similar = await searchSimilarSituations(
            situation.embedding.vector,
            similar_k,
            client,
            request_id
          );
          responseData.similar_situations = similar.map(match => ({
            nodeId: match.nodeId,
            score: match.score,
            summary: truncate(match.summary, 300),
            jobName: match.meta?.job?.jobName,
            jobObjective: truncate(match.meta?.job?.objective, 200),
          }));
        }
      } catch (dbError: any) {
        mcpLogger.warn({ error: dbError?.message }, 'Database error during inspection');
        responseData.database_error = dbError?.message || 'Database error';
      } finally {
        await client.end();
      }
    } else {
      responseData.database_note = 'Database URL not configured';
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            data: responseData,
            meta: {
              ok: true,
              requestId: request_id,
            },
          }),
        },
      ],
    };
  } catch (error: any) {
    mcpLogger.error({ error: error?.message }, 'inspect_situation error');
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
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

