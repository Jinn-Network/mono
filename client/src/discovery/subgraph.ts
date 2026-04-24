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

// ── Typed queries — added in Plan E ─────────────────────────────────────────

export async function queryIntents(
  config: SubgraphConfig,
  filters?: {
    kind?: string;
    creator?: string;
    startTs?: number;
    endTs?: number;
    limit?: number;
  },
): Promise<SubgraphResult[]> {
  const query = `query GetIntents($first: Int, $skip: Int, $kind: String, $creator: String) {
    agents(
      first: $first, skip: $skip,
      where: { metadata_: { metadataKey: "documentType", metadataValue_contains: "adw:Intent" } }
    ) {
      id agentURI owner
      metadata { key: metadataKey value: metadataValue }
    }
  }`;
  const data = await graphqlRequest<{ agents: SubgraphResult[] }>(config.url, query, {
    first: filters?.limit ?? 100,
    skip: 0,
    ...(filters?.kind ? { kind: filters.kind } : {}),
    ...(filters?.creator ? { creator: filters.creator.toLowerCase() } : {}),
  });
  let results = data.agents;
  if (filters?.startTs || filters?.endTs) {
    results = results.filter((r) => {
      const v = getMetadataValue(r, 'createdAt');
      if (!v) return true;
      const n = Number(v);
      if (filters.startTs && n < filters.startTs) return false;
      if (filters.endTs && n > filters.endTs) return false;
      return true;
    });
  }
  // Client-side filter for kind/creator until Plan G subgraph schema is deployed.
  if (filters?.kind) {
    results = results.filter((r) => getMetadataValue(r, 'kind') === filters.kind);
  }
  if (filters?.creator) {
    results = results.filter((r) =>
      getMetadataValue(r, 'creator')?.toLowerCase() === filters.creator!.toLowerCase(),
    );
  }
  return results;
}

export async function queryEnvelopes(
  config: SubgraphConfig,
  filters?: {
    kind?: string;
    role?: 'restoration' | 'verdict';
    evidenceTier?: string;
    intentCid?: string;
    participant?: string;
    limit?: number;
  },
): Promise<SubgraphResult[]> {
  const query = `query GetEnvelopes(
    $first: Int, $skip: Int,
    $kind: String, $role: String, $evidenceTier: String,
    $intentCid: String, $participant: String
  ) {
    agents(
      first: $first, skip: $skip,
      where: { metadata_: { metadataKey: "documentType", metadataValue_contains: "adw:ExecutionEnvelope" } }
    ) {
      id agentURI owner
      metadata { key: metadataKey value: metadataValue }
    }
  }`;
  const data = await graphqlRequest<{ agents: SubgraphResult[] }>(config.url, query, {
    first: filters?.limit ?? 500,
    skip: 0,
    kind: filters?.kind,
    role: filters?.role,
    evidenceTier: filters?.evidenceTier,
    intentCid: filters?.intentCid,
    participant: filters?.participant,
  });
  // Client-side post-filter until subgraph schema (Plan G) exposes structured
  // fields directly. Plan G collapses this into on-subgraph filters.
  return data.agents.filter((r) => {
    const checks: Array<[string | undefined, string]> = [
      [filters?.kind, 'kind'],
      [filters?.role, 'role'],
      [filters?.evidenceTier, 'evidenceTier'],
      [filters?.intentCid, 'intentCid'],
    ];
    for (const [expected, key] of checks) {
      if (expected && getMetadataValue(r, key) !== expected) return false;
    }
    if (filters?.participant) {
      const got = getMetadataValue(r, 'participant');
      if (got?.toLowerCase() !== filters.participant.toLowerCase()) return false;
    }
    return true;
  });
}

export async function querySourceBundles(
  config: SubgraphConfig,
  filters?: {
    measurement?: string;
    publishedBy?: string;
    limit?: number;
  },
): Promise<SubgraphResult[]> {
  const query = `query GetSourceBundles($first: Int, $skip: Int) {
    agents(
      first: $first, skip: $skip,
      where: { metadata_: { metadataKey: "documentType", metadataValue_contains: "adw:SourceBundle" } }
    ) {
      id agentURI owner
      metadata { key: metadataKey value: metadataValue }
    }
  }`;
  const data = await graphqlRequest<{ agents: SubgraphResult[] }>(config.url, query, {
    first: filters?.limit ?? 100,
    skip: 0,
    ...(filters?.measurement ? { measurement: filters.measurement } : {}),
  });
  return data.agents.filter((r) => {
    if (filters?.measurement && getMetadataValue(r, 'measurement') !== filters.measurement) return false;
    if (filters?.publishedBy) {
      const got = getMetadataValue(r, 'publishedBy');
      if (got?.toLowerCase() !== filters.publishedBy.toLowerCase()) return false;
    }
    return true;
  });
}

// ── Knowledge-tree synthetic query ──────────────────────────────────────────

export interface KnowledgeTreeVerdict {
  envelopeCid: string;
  participant?: string;
  evidenceTier?: string;
  generatedAt?: number;
}

export interface KnowledgeTreeRestoration {
  envelopeCid: string;
  participant?: string;
  evidenceTier?: string;
  generatedAt?: number;
  verdicts: KnowledgeTreeVerdict[];
}

export interface KnowledgeTree {
  intentCid: string;
  restorations: KnowledgeTreeRestoration[];
}

/**
 * Fetch the knowledge tree rooted at an intent CID.
 *
 * Scope §3.3: "synthetic KnowledgeTree rooted at an intent, joining all
 * envelopes by intent.cid (restorations) or payload.restorationEnvelope.cid
 * (verdicts)."
 *
 * V1 implementation: fetches all envelopes for the intent via `queryEnvelopes`
 * and joins in-memory. Plan G materializes this into a first-class subgraph
 * entity so the join happens server-side.
 */
export async function queryKnowledgeTree(
  config: SubgraphConfig,
  intentCid: string,
): Promise<KnowledgeTree> {
  const all = await queryEnvelopes(config, { intentCid });
  const restorations = new Map<string, KnowledgeTreeRestoration>();
  const pendingVerdicts: Array<{ verdict: KnowledgeTreeVerdict; parent?: string }> = [];

  for (const entry of all) {
    const cid = entry.agentURI.replace(/^envelope:/, '');
    const role = getMetadataValue(entry, 'role');
    const participant = getMetadataValue(entry, 'participant');
    const evidenceTier = getMetadataValue(entry, 'evidenceTier');
    const generatedAtStr = getMetadataValue(entry, 'generatedAt');
    const generatedAt = generatedAtStr ? Number(generatedAtStr) : undefined;
    const parent = getMetadataValue(entry, 'parentEnvelopeCid');

    if (role === 'restoration') {
      restorations.set(cid, {
        envelopeCid: cid,
        participant,
        evidenceTier,
        generatedAt,
        verdicts: [],
      });
    } else if (role === 'verdict') {
      pendingVerdicts.push({
        verdict: { envelopeCid: cid, participant, evidenceTier, generatedAt },
        parent,
      });
    }
  }

  for (const { verdict, parent } of pendingVerdicts) {
    if (parent && restorations.has(parent)) {
      restorations.get(parent)!.verdicts.push(verdict);
    }
  }

  return { intentCid, restorations: Array.from(restorations.values()) };
}

// ── Operator validation query (Plan G materializes) ─────────────────────────

export interface OperatorValidationRow {
  envelopeCid: string;
  verdict: 'valid' | 'invalid';
  blockNumber: number;
}

/**
 * Query Validation Registry responses filed against envelopes produced by
 * the given operator Safe address. V1 implementation relies on the Plan G
 * subgraph exposing a joined view; until then this returns an empty list.
 * The function shape is the stable contract.
 */
export async function queryOperatorValidations(
  _config: SubgraphConfig,
  _safeAddress: string,
): Promise<OperatorValidationRow[]> {
  // TODO(Plan G): Deploy subgraph join and implement real query here.
  return [];
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
