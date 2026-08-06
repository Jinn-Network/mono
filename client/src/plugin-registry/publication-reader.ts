/**
 * Plugin-publication read path — neutral port + result types.
 *
 * One-swap R3 (umbrella #2461, DR-2026-08-05): the plugin-publication read
 * surface (`listPluginPublications` / `getPluginScores` / `listBuilderArtifacts`)
 * is carved out of the legacy `discovery/` tree so the retirement wave (D-wave)
 * can delete `client/src/discovery/` cleanly. The Build SPA page and the three
 * `jinn solver-plugins` read verbs (`discover` / `status` / `list-feedback`)
 * depend on this path and must keep working after `discovery/` is gone.
 *
 * This module is the CANONICAL home for the plugin-publication result shapes
 * and the neutral read port. It has NO dependency on `discovery/`, `daemon/`,
 * or any chain-access machinery — so it survives the D-wave deletion and can be
 * imported from `api/`, `cli/`, and the daemon composition alike. The concrete
 * on-chain implementation (over venue-base's log source) lives in
 * `./publication-host.ts`.
 *
 * `discovery/types.ts` re-exports these types for back-compat so the legacy
 * `DiscoveryAPI` interface and its HTTP / on-chain backings keep compiling
 * unchanged until the D-wave removes them.
 */

// ── Result shapes ──────────────────────────────────────────────────────────────
//
// A common read-shape for builder-published artifacts. Today only plug-ins are
// published (kind `plugin:<cid>` on the IdentityRegistry); a future Path 2
// publishing epic adds `harness:<cid>` as a sibling kind with its own payload
// schema and adds it to the `artifactType` union below.

/**
 * Base shape for a builder-published artifact. Discriminated on `artifactType`
 * so future kinds (`harness`) add without breaking consumers.
 */
export interface PublishedArtifact {
  /** Builder agentId (decimal string of the uint256). */
  builderAgentId: string;
  /** IPFS CID of the published artifact tarball / manifest. */
  cid: string;
  /** Display name from the payload (e.g. npm package name, or harness name). */
  name: string;
  /** Display version (semver or harness version string). */
  version: string;
  /** SolverType ids the artifact supports. */
  supports: readonly string[];
  /** Publish time — unix seconds, from the payload's payload-stamped time. */
  publishedAt: number;
  /** Discriminator. Today only `'plugin'`; future: `| 'harness'`. */
  artifactType: 'plugin';
  /** True when the most-recent record is a revocation. */
  revoked: boolean;
  /** Reason from the revocation record, when revoked. */
  revokedReason?: string;
}

/**
 * The plug-in flavour of `PublishedArtifact`. Adds `pluginSha256` which is the
 * fork-attribution join key against envelope `executor.plugins[].sha256`.
 */
export interface PluginPublication extends PublishedArtifact {
  artifactType: 'plugin';
  /** digestDirectory output for the packed tarball. */
  pluginSha256: `0x${string}`;
}

/**
 * One row of score history for a published plug-in. The join key is the cid
 * — the indexer matches envelope `executor.plugins[].cid` against
 * `pluginPublication.pluginCid`. When the envelope's sha256 mismatches the
 * publication's sha256, `forkSuspected` is true and the row is excluded from
 * builder-credit aggregations per spec §5.3.
 */
export interface PluginScoreHistoryRow {
  pluginCid: string;
  taskId: string;
  /** Operator agentId of the daemon that ran the task. */
  operatorAgentId: string;
  /** 'Pass' | 'Fail' | 'Rejected' | 'Indeterminate' | 'Unknown'. */
  verdict: string;
  /** Numeric score when the verdict is graded (Pass=100, Fail=0); undefined when not. */
  score?: number;
  /** Unix seconds the verdict envelope was published. */
  ts: number;
  /** True when the envelope's plug-in sha256 did not match the publication's sha256. */
  forkSuspected: boolean;
}

/**
 * One read-time row of a builder-attributed task run. Joins `pluginPublication`
 * against `attemptEnvelopeMeta` and `verdict` in the indexer. Fork-suspected
 * rows are flagged but still returned so the SPA can render them with a
 * "modified plug-in" badge per spec §5.3.
 */
export interface BuilderAttributedRun {
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

// ── Read port ──────────────────────────────────────────────────────────────────

/**
 * The plugin-publication read port. A structural subset of the legacy
 * `DiscoveryAPI` (which still satisfies it), so a `DiscoveryAPI` instance can be
 * passed wherever a `PluginPublicationReader` is expected during the cutover.
 *
 * Each method may throw `PluginPublicationUnavailableError` when the backing is
 * temporarily unavailable (indexer outage / RPC failure).
 */
export interface PluginPublicationReader {
  /**
   * Returns published plug-ins, optionally filtered by SolverType (`supports`)
   * or builder agentId. Revoked rows are included by default; pass
   * `includeRevoked: false` to exclude them.
   */
  listPluginPublications(args?: {
    solverType?: string;
    builderAgentId?: string;
    includeRevoked?: boolean;
    limit?: number;
  }): Promise<PluginPublication[]>;

  /**
   * Returns score history for a published plug-in by cid. The on-chain host
   * returns an empty array (score history needs the indexer's enrichment join),
   * matching the legacy on-chain floor's documented contract.
   */
  getPluginScores(args: {
    pluginCid: string;
    limit?: number;
  }): Promise<PluginScoreHistoryRow[]>;

  /**
   * Returns all published artifacts for a builder agentId, typed by
   * `artifactType`. Today only plug-ins.
   */
  listBuilderArtifacts(args: {
    builderAgentId: string;
    limit?: number;
  }): Promise<PublishedArtifact[]>;
}

// ── Error ────────────────────────────────────────────────────────────────────

/**
 * Thrown by a `PluginPublicationReader` when it cannot serve a request — e.g.
 * the RPC / indexer backing the plugin-publication log scan is unreachable.
 *
 * Neutral analogue of the legacy `DiscoveryUnavailableError`, so the carved
 * consumers (Build endpoint plugin routes, `solver-plugins` read verbs) no
 * longer depend on `discovery/` for their failure classification.
 */
export class PluginPublicationUnavailableError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PluginPublicationUnavailableError';
    this.cause = cause;
  }
}
