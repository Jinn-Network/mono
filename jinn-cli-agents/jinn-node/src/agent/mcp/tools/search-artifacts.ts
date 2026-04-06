import { z } from 'zod';
import fetch from 'cross-fetch';
import { composeSinglePageResponse, decodeCursor } from './shared/context-management.js';
import { config } from '../../../config/index.js';

export const searchArtifactsParams = z.object({
  query: z.string().min(1).describe('Case-insensitive text to match against artifact name, topic, and content preview.'),
  cursor: z.string().optional().describe('Opaque cursor for pagination.'),
  include_request_context: z.boolean().optional().default(false).describe('If true, include basic request information for each artifact.'),
});
export type SearchArtifactsParams = z.infer<typeof searchArtifactsParams>;

export const searchArtifactsSchema = {
  description: 'Search artifacts by name, topic, and content preview. Returns artifact metadata with optional request context.',
  inputSchema: searchArtifactsParams.shape,
};

async function fetchRequestForArtifact(requestId: string): Promise<any | null> {
  const PONDER_GRAPHQL_URL = config.services.ponderUrl;
  const gql = `query GetRequest($requestId: String!) {
    requests(where: { id: $requestId }, limit: 1) {
      items { 
        id mech sender blockTimestamp delivered jobName
      }
    }
  }`;

  const variables = { requestId };
  const res = await fetch(PONDER_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables })
  });

  const json = await res.json();
  const requests = json?.data?.requests?.items || [];
  return requests.length > 0 ? requests[0] : null;
}

export async function searchArtifacts(params: SearchArtifactsParams) {
  try {
    const parsed = searchArtifactsParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const, text: JSON.stringify({
            data: [],
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message }
          })
        }]
      };
    }

    const { query, cursor, include_request_context } = parsed.data;
    const keyset = decodeCursor<{ offset: number }>(cursor) ?? { offset: 0 };

    // Query artifacts table directly
    const PONDER_GRAPHQL_URL = config.services.ponderUrl;
    const artifactsGql = `query SearchArtifacts($q: String!, $limit: Int!) {
      artifacts(where: { OR: [
        { name_contains: $q }, 
        { topic_contains: $q }, 
        { contentPreview_contains: $q }
      ] }, limit: $limit) {
        items { 
          id requestId sourceRequestId sourceJobDefinitionId
          name cid topic contentPreview
        }
      }
    }`;

    const variables = { q: query, limit: 100 };
    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: artifactsGql, variables })
    });

    const json = await res.json();
    const artifacts = json?.data?.artifacts?.items || [];

    // Optionally enrich with request context
    let enrichedArtifacts = artifacts;
    if (include_request_context && artifacts.length > 0) {
      const requestPromises = artifacts.map(async (artifact: any) => {
        try {
          if (artifact.requestId) {
            const requestContext = await fetchRequestForArtifact(artifact.requestId);
            return { ...artifact, requestContext };
          }
          return artifact;
        } catch (error) {
          return artifact; // Return artifact without request context on error
        }
      });

      enrichedArtifacts = await Promise.all(requestPromises);
    }

    // Apply pagination using context management utilities
    const composed = composeSinglePageResponse(enrichedArtifacts, {
      startOffset: keyset.offset,
      truncateChars: 800, // Moderate truncation for artifact content
      perFieldMaxChars: 3000,
      pageTokenBudget: 10000, // 10k token budget per page
      upstreamLimit: 100, // Database limit - prevents false has_more when offset >= database page
      requestedMeta: { cursor, query, include_request_context }
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: composed.data,
          meta: { ok: true, ...composed.meta, source: 'ponder', type: 'artifacts' }
        })
      }]
    };
  } catch (e: any) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ data: [], meta: { ok: false, code: 'UNEXPECTED_ERROR', message: e?.message || String(e) } }) }]
    };
  }
}


