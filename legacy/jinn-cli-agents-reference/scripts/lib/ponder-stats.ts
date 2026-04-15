/**
 * Query Ponder GraphQL for run statistics
 */

import { scriptLogger } from 'jinn-node/logging/index.js';

export interface PonderStats {
  marketplaceRequests: number;
  deliveries: number;
  artifacts: number;
}

export async function queryPonderStats(graphqlUrl: string): Promise<PonderStats> {
  try {
    const query = `{
      requests { items { id } }
      deliverys { items { id } }
      artifacts { items { id } }
    }`;

    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return {
      marketplaceRequests: data.data?.requests?.items?.length || 0,
      deliveries: data.data?.deliverys?.items?.length || 0,
      artifacts: data.data?.artifacts?.items?.length || 0,
    };
  } catch (error: any) {
    scriptLogger.warn({ graphqlUrl, error: error.message }, 'Failed to query Ponder stats');
    // Return zeros if query fails (e.g., Ponder not responding)
    return {
      marketplaceRequests: 0,
      deliveries: 0,
      artifacts: 0,
    };
  }
}
