import { z } from 'zod';
import fetch from 'cross-fetch';
import { config } from '../../../config/index.js';

export const searchContentStreamsParams = z.object({
  query: z.string().optional().describe('Optional keyword to filter stream names (case-insensitive).'),
  limit: z.number().int().positive().max(100).optional().default(20).describe('Max streams to return.'),
});

export type SearchContentStreamsParams = z.infer<typeof searchContentStreamsParams>;

export const searchContentStreamsSchema = {
  description: 'Discover available content streams (FEED:* topics). Returns distinct stream names with item counts. Use this to find what content other templates are producing.',
  inputSchema: searchContentStreamsParams.shape,
};

export async function searchContentStreams(params: SearchContentStreamsParams) {
  try {
    const parsed = searchContentStreamsParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: [],
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const { query, limit } = parsed.data;

    const PONDER_GRAPHQL_URL = config.services.ponderUrl;
    /**
     * Ponder GraphQL doesn't support GROUP BY or DISTINCT, so we fetch up to
     * AGGREGATION_LIMIT artifacts and aggregate by topic client-side. If the
     * result count hits this ceiling, itemCounts may be inaccurate and some
     * streams could be missing — indicated by meta.truncated.
     */
    const AGGREGATION_LIMIT = 1000;
    const gql = `query SearchContentStreams($topicPrefix: String!) {
      artifacts(where: { topic_starts_with: $topicPrefix }, limit: ${AGGREGATION_LIMIT}, orderBy: "id", orderDirection: "desc") {
        items {
          id name topic
        }
      }
    }`;

    const variables = { topicPrefix: 'FEED:' };
    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ponder returned ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const artifacts = json?.data?.artifacts?.items || [];
    const truncated = artifacts.length >= AGGREGATION_LIMIT;

    // Aggregate by topic: count items and track latest item name per stream
    const streamMap = new Map<string, { itemCount: number; latestItemName: string }>();
    for (const artifact of artifacts) {
      const topic = artifact.topic as string;
      const existing = streamMap.get(topic);
      if (existing) {
        existing.itemCount += 1;
      } else {
        streamMap.set(topic, { itemCount: 1, latestItemName: artifact.name });
      }
    }

    // Convert to array and apply keyword filter
    let streams = Array.from(streamMap.entries()).map(([stream, info]) => ({
      stream,
      itemCount: info.itemCount,
      latestItemName: info.latestItemName,
    }));

    if (query) {
      const lowerQuery = query.toLowerCase();
      streams = streams.filter((s) => s.stream.toLowerCase().includes(lowerQuery));
    }

    // Apply limit
    streams = streams.slice(0, limit);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: streams,
          meta: { ok: true, source: 'ponder', type: 'content_streams', truncated },
        }),
      }],
    };
  } catch (e: any) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: [],
          meta: { ok: false, code: 'EXECUTION_ERROR', message: e?.message || String(e) },
        }),
      }],
    };
  }
}
