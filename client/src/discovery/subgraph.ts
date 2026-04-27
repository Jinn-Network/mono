/**
 * Subgraph client — stub.
 *
 * The real Jinn-specific subgraph (operator-rooted ERC-8004, synthesized
 * `Operator`/`Execution` entities) is rebuilt under bead `jinn-mono-fud` per
 * docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md. The
 * previous V1 schema (`Intent`, `ExecutionEnvelope`, `SourceBundle`,
 * `Artifact`, `KnowledgeTree`, etc.) was a category error against the deployed
 * `0x8004…` registries — see the design record §2.
 *
 * This stub keeps the surface that `daemon.ts` calls during peer-discovery /
 * remote-artifact backfill so the daemon compiles and runs without ERC-8004
 * registration. All queries return empty results until the new subgraph
 * lands. No new ABIs are introduced here.
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
 * Parse a metadata value from a SubgraphResult by key. Retained for
 * backward compatibility with daemon.ts.
 */
export function getMetadataValue(result: SubgraphResult, key: string): string | undefined {
  return result.metadata.find((m) => m.key === key)?.value;
}

/**
 * Stubbed artifact discovery query. Returns no rows until the rebuilt
 * Jinn subgraph (jinn-mono-fud) ships.
 */
export async function queryArtifacts(
  _config: SubgraphConfig,
  _filters?: { outcome?: string; owner?: string; limit?: number },
): Promise<SubgraphResult[]> {
  return [];
}

/**
 * Stubbed peer-node discovery query. Returns no rows until the rebuilt
 * Jinn subgraph (jinn-mono-fud) ships.
 */
export async function queryNodes(
  _config: SubgraphConfig,
  _limit?: number,
): Promise<SubgraphResult[]> {
  return [];
}
