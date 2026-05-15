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
 * ebu7 dependency: this module references `AttemptEnvelopeMetaRow` and
 * `VerdictRow` types that are populated by the ebu7 enrichment bead. Until
 * ebu7 merges and the `attemptEnvelopeMeta` / `verdict` entities exist in the
 * deployed indexer schema, the `/builders/:agentId/runs` Hono route in
 * `src/api/index.ts` passes empty arrays for both, making `attributeRuns`
 * return `[]`. The pure-function join is exercised independently in tests via
 * pre-seeded fixture rows.
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

interface EnvelopePluginEntry {
  name: string;
  version: string;
  cid?: string;
  sha256: string;
}

/**
 * Normalises the publication's sha256 (`0x` + 64 hex) and the envelope plugin
 * entry's sha256 (64 hex, no `0x`) to lower-case 64-hex and compares.
 */
function sha256Matches(pubSha: string, envSha: string): boolean {
  const a = pubSha.replace(/^0x/i, '').toLowerCase();
  const b = envSha.replace(/^0x/i, '').toLowerCase();
  return a.length === 64 && b.length === 64 && a === b;
}

export function attributeRuns(args: {
  publications: PluginPublicationRow[];
  attemptEnvelopeMetas: AttemptEnvelopeMetaRow[];
  verdicts: VerdictRow[];
}): BuilderAttributedRunRow[] {
  const pubByCid = new Map<string, PluginPublicationRow>();
  for (const p of args.publications) pubByCid.set(p.pluginCid, p);

  const verdictByReq = new Map<string, VerdictRow>();
  for (const v of args.verdicts) verdictByReq.set(v.requestId.toLowerCase(), v);

  const out: BuilderAttributedRunRow[] = [];
  for (const meta of args.attemptEnvelopeMetas) {
    let plugins: EnvelopePluginEntry[] = [];
    try {
      plugins = JSON.parse(meta.pluginsJson) as EnvelopePluginEntry[];
    } catch {
      continue;
    }
    const verdict = verdictByReq.get(meta.requestId.toLowerCase());
    if (!verdict) continue;

    for (const entry of plugins) {
      if (!entry.cid) continue;
      const pub = pubByCid.get(entry.cid);
      if (!pub) continue;
      const forkSuspected = !sha256Matches(pub.pluginSha256, entry.sha256);
      const row: BuilderAttributedRunRow = {
        builderAgentId: pub.builderAgentId,
        pluginCid: pub.pluginCid,
        pluginName: pub.pluginName,
        pluginVersion: pub.pluginVersion,
        taskId: verdict.taskId,
        attemptRequestId: meta.requestId,
        operatorAgentId: verdict.operatorAgentId,
        verdict: verdict.verdict,
        ts: verdict.ts,
        forkSuspected,
      };
      if (typeof verdict.score === 'number') row.score = verdict.score;
      out.push(row);
    }
  }
  return out;
}
