/**
 * Helpers for querying Ponder GraphQL API
 * Used by integration tests to fetch indexed data
 */

import fetch from 'cross-fetch';

export interface PonderQueryOptions {
  variables?: Record<string, any>;
  timeout?: number;
}

export interface PonderRequest {
  id: string;
  mech?: string;
  sender?: string;
  ipfsHash?: string;
  jobName?: string;
  jobDefinitionId?: string;
  sourceJobDefinitionId?: string | null;
  sourceRequestId?: string | null;
  delivered?: boolean;
  enabledTools?: string[];
  blockNumber?: string;
  blockTimestamp?: string;
  additionalContext?: any;
}

export interface PonderJobDefinition {
  id: string;
  name?: string;
  sourceJobDefinitionId?: string | null;
  sourceRequestId?: string | null;
}

/**
 * Execute a raw GraphQL query against Ponder
 *
 * @param gqlUrl - Ponder GraphQL endpoint URL
 * @param query - GraphQL query string
 * @param options - Query options (variables, timeout)
 * @returns Query result data
 * @throws Error if query fails
 *
 * @example
 * ```typescript
 * const result = await queryPonder(ctx.gqlUrl, `
 *   query { request(id: "0xabc") { id jobName } }
 * `);
 * ```
 */
export async function queryPonder(
  gqlUrl: string,
  query: string,
  options?: PonderQueryOptions
): Promise<any> {
  const timeout = options?.timeout ?? 10000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: options?.variables ?? {}
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Ponder query failed: HTTP ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    return result.data;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get a single request by ID
 *
 * @param gqlUrl - Ponder GraphQL endpoint URL
 * @param requestId - Request ID (0x-prefixed)
 * @returns Request object or null if not found
 *
 * @example
 * ```typescript
 * const request = await getRequest(ctx.gqlUrl, '0xabc123');
 * console.log(request.jobName);
 * ```
 */
export async function getRequest(
  gqlUrl: string,
  requestId: string
): Promise<PonderRequest | null> {
  const data = await queryPonder(gqlUrl, `
    query {
      request(id: "${requestId}") {
        id
        mech
        sender
        ipfsHash
        jobName
        jobDefinitionId
        sourceJobDefinitionId
        sourceRequestId
        delivered
        enabledTools
        blockNumber
        blockTimestamp
        additionalContext
      }
    }
  `);

  return data?.request ?? null;
}

/**
 * Get all requests for a job definition
 *
 * @param gqlUrl - Ponder GraphQL endpoint URL
 * @param jobDefinitionId - Job definition UUID
 * @returns Array of requests
 *
 * @example
 * ```typescript
 * const requests = await getRequestsByJobDefinition(ctx.gqlUrl, jobDefId);
 * console.log(`Found ${requests.length} runs of this job`);
 * ```
 */
export async function getRequestsByJobDefinition(
  gqlUrl: string,
  jobDefinitionId: string
): Promise<PonderRequest[]> {
  const data = await queryPonder(gqlUrl, `
    query {
      requests(where: { jobDefinitionId: "${jobDefinitionId}" }) {
        items {
          id
          jobName
          sourceJobDefinitionId
          sourceRequestId
          delivered
          blockTimestamp
        }
      }
    }
  `);

  return data?.requests?.items ?? [];
}

/**
 * Get all child requests of a parent job
 *
 * @param gqlUrl - Ponder GraphQL endpoint URL
 * @param parentJobDefinitionId - Parent job definition UUID
 * @returns Array of child requests
 *
 * @example
 * ```typescript
 * const children = await getChildRequests(ctx.gqlUrl, parentJobDefId);
 * console.log(`Parent has ${children.length} children`);
 * ```
 */
export async function getChildRequests(
  gqlUrl: string,
  parentJobDefinitionId: string
): Promise<PonderRequest[]> {
  const data = await queryPonder(gqlUrl, `
    query {
      requests(where: { sourceJobDefinitionId: "${parentJobDefinitionId}" }) {
        items {
          id
          jobName
          jobDefinitionId
          sourceRequestId
          delivered
        }
      }
    }
  `);

  return data?.requests?.items ?? [];
}

/**
 * Get delivery information for a request
 *
 * @param gqlUrl - Ponder GraphQL endpoint URL
 * @param requestId - Request ID that was delivered
 * @returns Delivery object or null if not delivered
 *
 * @example
 * ```typescript
 * const delivery = await getDelivery(ctx.gqlUrl, '0xabc123');
 * if (delivery) {
 *   console.log(`Delivered at block ${delivery.block_number}`);
 * }
 * ```
 */
export async function getDelivery(
  gqlUrl: string,
  requestId: string
): Promise<any | null> {
  const data = await queryPonder(gqlUrl, `
    query {
      deliveries(where: { requestId: "${requestId}" }) {
        items {
          id
          requestId
          ipfsHash
          transactionHash
          blockNumber
          blockTimestamp
        }
      }
    }
  `);

  const deliveries = data?.deliveries?.items ?? [];
  return deliveries.length > 0 ? deliveries[0] : null;
}

/**
 * Get artifacts for a request
 *
 * @param gqlUrl - Ponder GraphQL endpoint URL
 * @param requestId - Request ID
 * @returns Array of artifacts
 *
 * @example
 * ```typescript
 * const artifacts = await getArtifacts(ctx.gqlUrl, '0xabc123');
 * console.log(`Request created ${artifacts.length} artifacts`);
 * ```
 */
export async function getArtifacts(
  gqlUrl: string,
  requestId: string
): Promise<any[]> {
  const data = await queryPonder(gqlUrl, `
    query {
      artifacts(where: { requestId: "${requestId}" }) {
        items {
          id
          requestId
          name
          topic
          type
          tags
          cid
          contentPreview
        }
      }
    }
  `);

  return data?.artifacts?.items ?? [];
}

/**
 * Count requests matching a condition
 *
 * @param gqlUrl - Ponder GraphQL endpoint URL
 * @param where - GraphQL where clause (e.g., "job_definition_id: \"uuid\"")
 * @returns Count of matching requests
 *
 * @example
 * ```typescript
 * const count = await countRequests(ctx.gqlUrl, `job_definition_id: "${jobDefId}"`);
 * console.log(`Job has been run ${count} times`);
 * ```
 */
export async function countRequests(
  gqlUrl: string,
  where: string
): Promise<number> {
  const data = await queryPonder(gqlUrl, `
    query {
      requests(where: { ${where} }) {
        items { id }
      }
    }
  `);

  return data?.requests?.items?.length ?? 0;
}
