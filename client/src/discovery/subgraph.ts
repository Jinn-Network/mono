/**
 * ERC-8004 Subgraph client — V1 schema (Plan G).
 *
 * Queries The Graph subgraph that indexes Plan E's ERC-8004 Identity Registry
 * and Validation Registry writes. The schema exposes first-class entities:
 * Intent, ExecutionEnvelope, Artifact, SourceBundle, KnowledgeTree,
 * ValidationRequest, ValidationResponse.
 *
 * Legacy helpers (queryArtifacts, queryNodes) return the original
 * SubgraphResult shape so existing call sites in daemon.ts remain unchanged.
 * All new helpers use V1-typed return values.
 */

export interface SubgraphConfig {
  url: string;
}

// ── Legacy compatibility types (preserved for daemon.ts / reputation call sites) ──

export interface SubgraphResult {
  id: string;
  agentURI: string;
  owner: string;
  metadata: Array<{ key: string; value: string }>;
}

/**
 * Parse a metadata value from a SubgraphResult by key.
 * Retained for backward compatibility with daemon.ts.
 */
export function getMetadataValue(result: SubgraphResult, key: string): string | undefined {
  return result.metadata.find(m => m.key === key)?.value;
}

// ── V1 typed entities ────────────────────────────────────────────────────────

export interface Intent {
  id: string;             // intent CID
  kind: string;
  creator: string;        // hex address
  createdAt: string;      // BigInt as string
  requestId: string;      // bytes32 hex
}

export interface Envelope {
  id: string;             // envelope CID
  kind: string;
  role: 'restoration' | 'verdict';
  evidenceTier: string;
  participant: string;    // Safe address
  generatedAt: string;    // BigInt as string
  createdAtBlock: string;
  intent: { id: string; kind: string };
  parentEnvelope?: { id: string } | null;
  sourceBundle?: { id: string } | null;
}

export interface ArtifactEntity {
  id: string;             // artifact CID
  artifactType: string;
  parentEnvelope: { id: string };
  tags: string[] | null;
  createdAtBlock: string;
}

export interface SourceBundleEntity {
  id: string;             // bundle CID
  measurement: string;
  buildRecipeKind: string;
  humanUrl: string | null;
  publishedBy: string;
  createdAtBlock: string;
}

export interface KnowledgeTreeResult {
  intent: Intent;
  restorations: Envelope[];
  verdicts: Record<string, Envelope[]>;  // keyed by restorationCid
  totals: {
    totalRestorations: number;
    totalVerdicts: number;
    attestedFraction: number;
  };
}

export interface ValidationRecord {
  id: string;
  envelopeCid: string;
  verdict: 'valid' | 'invalid';
  blockNumber: number;
  validator: string;
  scope: string;
  respondedAt: string;
}

// ── Legacy SubgraphResult shape ──────────────────────────────────────────────
//
// The V1 Artifact and Agent entities have well-known fields. We project them
// back to SubgraphResult so daemon.ts can call getMetadataValue() unchanged.

function artifactToSubgraphResult(a: {
  id: string;
  artifactType: string;
  parentEnvelope: { id: string };
  tags: string[] | null;
  agent: { id: string; agentURI: string; owner: string } | null;
}): SubgraphResult {
  const owner = a.agent?.owner ?? '';
  return {
    id: a.id,
    agentURI: a.agent?.agentURI ?? `artifact:${a.id}`,
    owner,
    metadata: [
      { key: 'documentType', value: 'adw:Artifact' },
      { key: 'artifactId', value: a.id },
      { key: 'artifactType', value: a.artifactType },
      { key: 'parentEnvelopeCid', value: a.parentEnvelope.id },
      ...(a.tags ? [{ key: 'tags', value: JSON.stringify(a.tags) }] : []),
    ],
  };
}

function agentToSubgraphResult(a: {
  id: string;
  agentURI: string;
  owner: string;
  metadata: Array<{ metadataKey: string; metadataValueString: string }>;
}): SubgraphResult {
  return {
    id: a.id,
    agentURI: a.agentURI,
    owner: a.owner,
    metadata: a.metadata.map(m => ({ key: m.metadataKey, value: m.metadataValueString })),
  };
}

// ── Legacy queryArtifacts (used by daemon.ts backfill) ───────────────────────

/**
 * Query the V1 subgraph for Artifact entities.
 * Returns SubgraphResult shape for backward compatibility with daemon.ts.
 */
export async function queryArtifacts(
  config: SubgraphConfig,
  filters?: {
    outcome?: string;
    owner?: string;
    limit?: number;
  },
): Promise<SubgraphResult[]> {
  const query = `query GetArtifacts($first: Int, $skip: Int, $owner: Bytes) {
    artifacts(
      first: $first
      skip: $skip
      ${filters?.owner ? 'where: { agent_: { owner: $owner } }' : ''}
      orderBy: createdAtBlock
      orderDirection: desc
    ) {
      id
      artifactType
      parentEnvelope { id }
      tags
      agent { id agentURI owner }
    }
  }`;

  const variables: Record<string, unknown> = {
    first: filters?.limit ?? 100,
    skip: 0,
  };
  if (filters?.owner) variables['owner'] = filters.owner.toLowerCase();

  const data = await graphqlRequest<{
    artifacts: Array<{
      id: string;
      artifactType: string;
      parentEnvelope: { id: string };
      tags: string[] | null;
      agent: { id: string; agentURI: string; owner: string } | null;
    }>;
  }>(config.url, query, variables);

  let results = data.artifacts.map(artifactToSubgraphResult);

  if (filters?.outcome) {
    results = results.filter(r =>
      r.metadata.some(m => m.key === 'outcome' && m.value === filters.outcome),
    );
  }

  return results;
}

// ── Legacy queryNodes (used by daemon.ts peer discovery) ─────────────────────

/**
 * Query the V1 subgraph for AgentCard entities (documentType='adw:AgentCard').
 * Returns SubgraphResult shape for backward compatibility with daemon.ts.
 */
export async function queryNodes(
  config: SubgraphConfig,
  limit?: number,
): Promise<SubgraphResult[]> {
  const query = `query GetAgentCards($first: Int, $skip: Int) {
    agents(
      first: $first
      skip: $skip
      where: { documentType: "adw:AgentCard" }
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      agentURI
      owner
      metadata { metadataKey metadataValueString }
    }
  }`;

  const data = await graphqlRequest<{
    agents: Array<{
      id: string;
      agentURI: string;
      owner: string;
      metadata: Array<{ metadataKey: string; metadataValueString: string }>;
    }>;
  }>(config.url, query, { first: limit ?? 100, skip: 0 });

  return data.agents.map(agentToSubgraphResult);
}

// ── V1 queryIntents ──────────────────────────────────────────────────────────

export async function queryIntents(
  config: SubgraphConfig,
  filters?: {
    kind?: string;
    creator?: string;
    startTs?: number;
    endTs?: number;
    limit?: number;
  },
): Promise<Intent[]> {
  const whereParts: string[] = [];
  if (filters?.kind) whereParts.push('kind: $kind');
  if (filters?.creator) whereParts.push('creator: $creator');
  if (filters?.startTs) whereParts.push('createdAt_gte: $startTs');
  if (filters?.endTs) whereParts.push('createdAt_lte: $endTs');
  const whereClause = whereParts.length > 0 ? `where: { ${whereParts.join(', ')} }` : '';

  const query = `query GetIntents(
    $first: Int, $skip: Int,
    $kind: String, $creator: Bytes,
    $startTs: BigInt, $endTs: BigInt
  ) {
    intents(
      first: $first
      skip: $skip
      ${whereClause}
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      kind
      creator
      createdAt
      requestId
    }
  }`;

  const variables: Record<string, unknown> = {
    first: filters?.limit ?? 100,
    skip: 0,
    ...(filters?.kind ? { kind: filters.kind } : {}),
    ...(filters?.creator ? { creator: filters.creator.toLowerCase() } : {}),
    ...(filters?.startTs ? { startTs: String(filters.startTs) } : {}),
    ...(filters?.endTs ? { endTs: String(filters.endTs) } : {}),
  };

  const data = await graphqlRequest<{ intents: Intent[] }>(config.url, query, variables);
  return data.intents;
}

// ── V1 getIntent ─────────────────────────────────────────────────────────────

export async function getIntent(
  config: SubgraphConfig,
  intentCid: string,
): Promise<Intent | null> {
  const query = `query GetIntent($id: ID!) {
    intent(id: $id) {
      id
      kind
      creator
      createdAt
      requestId
    }
  }`;
  const data = await graphqlRequest<{ intent: Intent | null }>(config.url, query, { id: intentCid });
  return data.intent;
}

// ── V1 queryEnvelopes ─────────────────────────────────────────────────────────

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
  const whereParts: string[] = [];
  if (filters?.kind) whereParts.push('kind: $kind');
  if (filters?.role) whereParts.push('role: $role');
  if (filters?.evidenceTier) whereParts.push('evidenceTier: $evidenceTier');
  if (filters?.intentCid) whereParts.push('intent: $intentCid');
  if (filters?.participant) whereParts.push('participant: $participant');
  const whereClause = whereParts.length > 0 ? `where: { ${whereParts.join(', ')} }` : '';

  const query = `query GetEnvelopes(
    $first: Int, $skip: Int,
    $kind: String, $role: String, $evidenceTier: String,
    $intentCid: ID, $participant: Bytes
  ) {
    executionEnvelopes(
      first: $first
      skip: $skip
      ${whereClause}
      orderBy: generatedAt
      orderDirection: desc
    ) {
      id
      kind
      role
      evidenceTier
      participant
      generatedAt
      createdAtBlock
      intent { id kind }
      parentEnvelope { id }
      agent { id agentURI owner }
    }
  }`;

  const variables: Record<string, unknown> = {
    first: filters?.limit ?? 500,
    skip: 0,
    ...(filters?.kind ? { kind: filters.kind } : {}),
    ...(filters?.role ? { role: filters.role } : {}),
    ...(filters?.evidenceTier ? { evidenceTier: filters.evidenceTier } : {}),
    ...(filters?.intentCid ? { intentCid: filters.intentCid } : {}),
    ...(filters?.participant ? { participant: filters.participant.toLowerCase() } : {}),
  };

  const data = await graphqlRequest<{
    executionEnvelopes: Array<{
      id: string;
      kind: string;
      role: string;
      evidenceTier: string;
      participant: string;
      generatedAt: string;
      createdAtBlock: string;
      intent: { id: string; kind: string };
      parentEnvelope: { id: string } | null;
      agent: { id: string; agentURI: string; owner: string } | null;
    }>;
  }>(config.url, query, variables);

  // Project to SubgraphResult for backward compat with reputation/index.ts
  return data.executionEnvelopes.map(e => ({
    id: e.id,
    agentURI: e.agent?.agentURI ?? `envelope:${e.id}`,
    owner: e.agent?.owner ?? e.participant,
    metadata: [
      { key: 'documentType', value: 'adw:ExecutionEnvelope' },
      { key: 'kind', value: e.kind },
      { key: 'role', value: e.role },
      { key: 'evidenceTier', value: e.evidenceTier },
      { key: 'participant', value: e.participant },
      { key: 'generatedAt', value: e.generatedAt },
      { key: 'intentCid', value: e.intent.id },
      ...(e.parentEnvelope ? [{ key: 'parentEnvelopeCid', value: e.parentEnvelope.id }] : []),
    ],
  }));
}

// ── V1 getEnvelopesForIntent ─────────────────────────────────────────────────

export async function getEnvelopesForIntent(
  config: SubgraphConfig,
  intentCid: string,
  limit = 500,
): Promise<Envelope[]> {
  const query = `query GetEnvelopesForIntent($intentCid: ID!, $first: Int) {
    executionEnvelopes(
      where: { intent: $intentCid }
      first: $first
      orderBy: generatedAt
      orderDirection: asc
    ) {
      id
      kind
      role
      evidenceTier
      participant
      generatedAt
      createdAtBlock
      intent { id kind }
      parentEnvelope { id }
      sourceBundle { id }
    }
  }`;
  const data = await graphqlRequest<{ executionEnvelopes: Envelope[] }>(
    config.url,
    query,
    { intentCid, first: limit },
  );
  return data.executionEnvelopes;
}

// ── V1 querySourceBundles ────────────────────────────────────────────────────

export async function querySourceBundles(
  config: SubgraphConfig,
  filters?: {
    measurement?: string;
    publishedBy?: string;
    limit?: number;
  },
): Promise<SubgraphResult[]> {
  const whereParts: string[] = [];
  if (filters?.measurement) whereParts.push('measurement: $measurement');
  if (filters?.publishedBy) whereParts.push('publishedBy: $publishedBy');
  const whereClause = whereParts.length > 0 ? `where: { ${whereParts.join(', ')} }` : '';

  const query = `query GetSourceBundles(
    $first: Int, $skip: Int,
    $measurement: Bytes, $publishedBy: Bytes
  ) {
    sourceBundles(
      first: $first
      skip: $skip
      ${whereClause}
      orderBy: createdAtBlock
      orderDirection: desc
    ) {
      id
      measurement
      buildRecipeKind
      humanUrl
      publishedBy
      agent { id agentURI owner }
    }
  }`;

  const variables: Record<string, unknown> = {
    first: filters?.limit ?? 100,
    skip: 0,
    ...(filters?.measurement ? { measurement: filters.measurement } : {}),
    ...(filters?.publishedBy ? { publishedBy: filters.publishedBy.toLowerCase() } : {}),
  };

  const data = await graphqlRequest<{
    sourceBundles: Array<{
      id: string;
      measurement: string;
      buildRecipeKind: string;
      humanUrl: string | null;
      publishedBy: string;
      agent: { id: string; agentURI: string; owner: string } | null;
    }>;
  }>(config.url, query, variables);

  // Project to SubgraphResult (backward compat shape — metadata keyed access)
  return data.sourceBundles.map(b => ({
    id: b.id,
    agentURI: b.agent?.agentURI ?? `sourcebundle:${b.id}`,
    owner: b.agent?.owner ?? b.publishedBy,
    metadata: [
      { key: 'documentType', value: 'adw:SourceBundle' },
      { key: 'measurement', value: b.measurement },
      { key: 'buildRecipeKind', value: b.buildRecipeKind },
      { key: 'publishedBy', value: b.publishedBy },
      ...(b.humanUrl ? [{ key: 'humanUrl', value: b.humanUrl }] : []),
    ],
  }));
}

// ── V1 getEnvelopesBySource ──────────────────────────────────────────────────

/**
 * Return all execution envelopes whose executor.source.bundleCid matches
 * the given bundle CID. Useful for lineage queries ("which runs used this
 * exact binary?").
 */
export async function getEnvelopesBySource(
  config: SubgraphConfig,
  bundleCid: string,
): Promise<Envelope[]> {
  const query = `query GetEnvelopesBySource($bundleCid: ID!, $first: Int) {
    executionEnvelopes(
      where: { sourceBundle: $bundleCid }
      first: $first
      orderBy: generatedAt
      orderDirection: desc
    ) {
      id
      kind
      role
      evidenceTier
      participant
      generatedAt
      createdAtBlock
      intent { id kind }
      parentEnvelope { id }
      sourceBundle { id }
    }
  }`;
  const data = await graphqlRequest<{ executionEnvelopes: Envelope[] }>(
    config.url,
    query,
    { bundleCid, first: 500 },
  );
  return data.executionEnvelopes;
}

// ── V1 KnowledgeTree types ───────────────────────────────────────────────────

/** @deprecated Use KnowledgeTreeResult from getKnowledgeTree(). */
export interface KnowledgeTreeVerdict {
  envelopeCid: string;
  participant?: string;
  evidenceTier?: string;
  generatedAt?: number;
}

/** @deprecated Use KnowledgeTreeResult from getKnowledgeTree(). */
export interface KnowledgeTreeRestoration {
  envelopeCid: string;
  participant?: string;
  evidenceTier?: string;
  generatedAt?: number;
  verdicts: KnowledgeTreeVerdict[];
}

/** @deprecated Use KnowledgeTreeResult from getKnowledgeTree(). */
export interface KnowledgeTree {
  intentCid: string;
  restorations: KnowledgeTreeRestoration[];
}

/**
 * Fetch the V1 knowledge tree for an intent CID.
 *
 * Queries the KnowledgeTree + Intent entities from the subgraph (materialised
 * by the mapping handler) and the full envelope list, then assembles the
 * structured result. The KnowledgeTree aggregate holds pre-computed counts;
 * the restoration/verdict lists are fetched in a second query for the full
 * linked view.
 */
export async function getKnowledgeTree(
  config: SubgraphConfig,
  intentCid: string,
): Promise<KnowledgeTreeResult> {
  const treeFrag = `query GetKnowledgeTree($id: ID!) {
    knowledgeTree(id: $id) {
      id
      totalRestorations
      totalVerdicts
      attestedRestorations
      attestedVerdicts
      attestedFraction
      intent {
        id
        kind
        creator
        createdAt
        requestId
      }
    }
  }`;

  const treeData = await graphqlRequest<{
    knowledgeTree: {
      id: string;
      totalRestorations: number;
      totalVerdicts: number;
      attestedRestorations: number;
      attestedVerdicts: number;
      attestedFraction: string; // BigDecimal comes as string
      intent: Intent;
    } | null;
  }>(config.url, treeFrag, { id: intentCid });

  // Fetch all envelopes for this intent (restorations + verdicts)
  const envelopes = await getEnvelopesForIntent(config, intentCid);

  const restorations = envelopes.filter(e => e.role === 'restoration');
  const verdictsByParent: Record<string, Envelope[]> = {};
  for (const v of envelopes.filter(e => e.role === 'verdict')) {
    const parentId = v.parentEnvelope?.id;
    if (parentId) {
      (verdictsByParent[parentId] ??= []).push(v);
    }
  }

  const tree = treeData.knowledgeTree;
  const intent: Intent = tree?.intent ?? {
    id: intentCid,
    kind: '',
    creator: '',
    createdAt: '0',
    requestId: '0x0000000000000000000000000000000000000000000000000000000000000000',
  };

  return {
    intent,
    restorations,
    verdicts: verdictsByParent,
    totals: {
      totalRestorations: tree?.totalRestorations ?? restorations.length,
      totalVerdicts: tree?.totalVerdicts ?? envelopes.filter(e => e.role === 'verdict').length,
      attestedFraction: tree ? parseFloat(tree.attestedFraction) : 0,
    },
  };
}

// ── Legacy queryKnowledgeTree (preserved for existing tests + backward compat) ─

/**
 * Fetch the knowledge tree rooted at an intent CID.
 *
 * @deprecated Use getKnowledgeTree() which returns the V1 typed result.
 *   This function is retained for backward compatibility.
 */
export async function queryKnowledgeTree(
  config: SubgraphConfig,
  intentCid: string,
): Promise<KnowledgeTree> {
  const envelopes = await queryEnvelopes(config, { intentCid });
  const restorations = new Map<string, KnowledgeTreeRestoration>();
  const pendingVerdicts: Array<{ verdict: KnowledgeTreeVerdict; parent?: string }> = [];

  for (const entry of envelopes) {
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

// ── Operator validation query ─────────────────────────────────────────────────

export interface OperatorValidationRow {
  envelopeCid: string;
  verdict: 'valid' | 'invalid';
  blockNumber: number;
}

/**
 * Query Validation Registry responses filed against envelopes produced by
 * the given operator Safe address. Uses the V1 subgraph ValidationResponse
 * entity joined through executionEnvelope.participant.
 */
export async function queryOperatorValidations(
  config: SubgraphConfig,
  safeAddress: string,
): Promise<OperatorValidationRow[]> {
  const query = `query GetOperatorValidations($participant: Bytes!, $first: Int) {
    validationResponses(
      where: { envelope_: { participant: $participant } }
      first: $first
      orderBy: respondedAt
      orderDirection: desc
    ) {
      id
      overall
      createdAtBlock
      envelope { id }
    }
  }`;

  const data = await graphqlRequest<{
    validationResponses: Array<{
      id: string;
      overall: string;
      createdAtBlock: string;
      envelope: { id: string };
    }>;
  }>(config.url, query, {
    participant: safeAddress.toLowerCase(),
    first: 500,
  });

  return data.validationResponses.map(v => ({
    envelopeCid: v.envelope.id,
    verdict: v.overall as 'valid' | 'invalid',
    blockNumber: parseInt(v.createdAtBlock, 10),
  }));
}

// ── Minimal GraphQL client (no dependency) ───────────────────────────────────

async function graphqlRequest<T>(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
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
