/**
 * Workstream Completion — detect when a dispatched workstream has finished.
 *
 * Queries Ponder to check if a request (and all its children) are delivered.
 * Used by the watcher for monitoring dispatch results.
 */

import { graphQLRequest } from '../../http/client.js';
import { config } from '../../config/index.js';

const PONDER_GRAPHQL_URL = config.services.ponderUrl;

/**
 * Check if a dispatched request (and all descendants) are delivered.
 *
 * Returns true only when the root request AND all child requests are delivered.
 */
export async function checkWorkstreamCompletion(
  requestId: string,
): Promise<boolean> {
  try {
    // Query root request delivery status + count of undelivered descendants
    const data = await graphQLRequest<{
      request: { id: string; delivered: boolean } | null;
      requests: { items: Array<{ id: string }> };
    }>({
      url: PONDER_GRAPHQL_URL,
      query: `query CheckCompletion($requestId: String!) {
        request(id: $requestId) {
          id
          delivered
        }
        requests(
          where: {
            workstreamId: { equals: $requestId }
            delivered: { equals: false }
          }
          limit: 1
        ) {
          items { id }
        }
      }`,
      variables: { requestId },
      context: { operation: 'checkWorkstreamCompletion' },
    });

    if (!data?.request) return false;
    if (!data.request.delivered) return false;
    if ((data.requests?.items?.length ?? 0) > 0) return false;

    return true;
  } catch {
    return false;
  }
}
