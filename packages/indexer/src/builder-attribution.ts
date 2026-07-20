/**
 * Pure join logic for builder-attributed runs (attd).
 *
 * Joins three streams the indexer maintains:
 *   - `pluginPublication` rows from `IdentityRegistry.MetadataSet` with
 *     `plugin:<cid>` keys (this bead).
 *   - `attemptEnvelopeMeta` rows (ebu7) which carry the IPFS-fetched
 *     `executor.plugins[]` JSON.
 *   - `verdict` rows (ebu7) keyed by the same `requestId`.
 *
 * Output is the read-time `BuilderAttributedRun` shape consumed by the
 * `/builders/:agentId/runs` Hono route and the SPA `/build` panel.
 *
 * The pure-function shape keeps the join testable independent of Ponder; the
 * Hono route loads rows via the GraphQL surface and calls into this module.
 *
 * Fork detection: an envelope's `executor.plugins[].sha256` is compared
 * against the publication's `pluginSha256`. Mismatch flags `forkSuspected:
 * true` per spec §5.3 — the row is still emitted (for visibility) but is
 * filtered out of builder-credit aggregations downstream.
 *
 * Trust boundary: `attemptEnvelopeMeta` is a permissionless, shape-parsed
 * projection. This module therefore returns `[]` until a canonical projection
 * binds the historical publisher Safe, envelope signature/hash, authoritative
 * attempt, and original task. A matching requestId or singleton candidate is
 * not sufficient builder attribution.
 */

export interface PluginPublicationRow {
  id: string;
  builderAgentId: string;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: string;
  supports: readonly string[];
  publishedAt: bigint;
  revoked: boolean;
  revokedReason: string | null;
  blockNumber: bigint;
  txIndex: number;
  logIndex: number;
  txHash: `0x${string}`;
  chainId: number;
}

export interface AttemptEnvelopeMetaRow {
  requestId: `0x${string}`;
  manifestCid: string;
  /** JSON.stringify(executor.plugins) — array of {name,version,cid?,sha256}. */
  pluginsJson: string;
  enrichedAtBlock: bigint;
  chainId: number;
}

export interface VerdictRow {
  requestId: `0x${string}`;
  taskId: string;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  ts: number;
}

export interface BuilderAttributedRunRow {
  builderAgentId: string;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  taskId: string;
  attemptRequestId: `0x${string}`;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  forkSuspected: boolean;
  ts: number;
}

export function attributeRuns(args: {
  publications: PluginPublicationRow[];
  attemptEnvelopeMetas: AttemptEnvelopeMetaRow[];
  verdicts: VerdictRow[];
}): BuilderAttributedRunRow[] {
  void args;
  // Stored attempt metadata is a permissionless shape projection. Do not
  // attribute runs or credit builders until a canonical projection proves the
  // historical publisher Safe, envelope signature/hash, authoritative attempt,
  // and original task.
  return [];
}
