/**
 * ERC-8004 Subgraph client for artifact and node discovery.
 *
 * Queries The Graph subgraph to discover artifacts and nodes registered
 * on the 8004 Identity Registry. Ported from protocol/src/discovery/subgraph.ts.
 *
 * NOTE: The GraphQL schema depends on the deployed 8004 subgraph.
 * Field names may need adjustment against the live subgraph.
 */

export interface SubgraphConfig {
  url: string;
}

export interface SubgraphResult {
  id: string;
  agentURI: string;
  owner: string;
  metadata: Array<{ key: string; value: string }>;
}

/**
 * Parse a metadata value from a subgraph result by key.
 */
export function getMetadataValue(result: SubgraphResult, key: string): string | undefined {
  return result.metadata.find(m => m.key === key)?.value;
}

/**
 * Query the 8004 subgraph for registered artifact entities.
 */
export async function queryArtifacts(
  config: SubgraphConfig,
  filters?: {
    outcome?: string;
    owner?: string;
    limit?: number;
  },
): Promise<SubgraphResult[]> {
  const query = filters?.owner
    ? `query GetArtifacts($first: Int, $skip: Int, $owner: String) {
        agents(
          first: $first, skip: $skip,
          where: { metadata_: { metadataKey: "documentType", metadataValue_contains: "Artifact" }, owner: $owner }
        ) {
          id agentURI owner
          metadata { key: metadataKey value: metadataValue }
        }
      }`
    : `query GetArtifacts($first: Int, $skip: Int) {
        agents(
          first: $first, skip: $skip,
          where: { metadata_: { metadataKey: "documentType", metadataValue_contains: "Artifact" } }
        ) {
          id agentURI owner
          metadata { key: metadataKey value: metadataValue }
        }
      }`;

  const variables: Record<string, unknown> = {
    first: filters?.limit ?? 100,
    skip: 0,
  };
  if (filters?.owner) variables['owner'] = filters.owner;

  const data = await graphqlRequest<{ agents: SubgraphResult[] }>(config.url, query, variables);
  let results = data.agents;

  if (filters?.outcome) {
    results = results.filter(r =>
      r.metadata.some(m => m.key === 'outcome' && m.value === filters.outcome),
    );
  }

  return results;
}

/**
 * Query the 8004 subgraph for registered node (AgentCard) entities.
 */
export async function queryNodes(
  config: SubgraphConfig,
  limit?: number,
): Promise<SubgraphResult[]> {
  const query = `query GetNodes($first: Int, $skip: Int) {
    agents(
      first: $first, skip: $skip,
      where: { metadata_: { metadataKey: "documentType", metadataValue_contains: "AgentCard" } }
    ) {
      id agentURI owner
      metadata { key: metadataKey value: metadataValue }
    }
  }`;

  const data = await graphqlRequest<{ agents: SubgraphResult[] }>(config.url, query, { first: limit ?? 100, skip: 0 });
  return data.agents;
}

// ── Minimal GraphQL client (no dependency) ───────────────────────────────────

async function graphqlRequest<T>(url: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Subgraph query failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Subgraph errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  if (!json.data) {
    throw new Error('Subgraph returned no data');
  }
  return json.data;
}
