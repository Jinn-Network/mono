/**
 * Launcher-mode posted-Tasks query. Returns the canonical
 * `LauncherTasksResponse` for `GET /v1/launcher/tasks` — the SPA's
 * PostedTasksList consumes this directly.
 *
 * Pagination: `before` cursor is an ISO timestamp; results are returned in
 * `postedAt DESC` order. When the page fills (`tasks.length === limit`) the
 * response includes a `cursor.before` set to the oldest entry's `postedAt`
 * so the next call can resume.
 *
 * What is and isn't sourced today (Task 7 of
 * spec/2026-05-05-launcher-role-and-mode.md):
 *   ✓ taskId / taskCid / postedAt — from `task_posts` + `activity_events`
 *   ✓ solverNet — derived by mapping the `task_posted` event's `solver_type`
 *     back to the SolverNet name in config (the only solver-type → net mapping
 *     in v1 is 1:1, so the lookup is straightforward).
 *   ✓ state / claims.current / claims.max — sourced from local task_posts and
 *     matching task_runs when available. This is a pragmatic local projection,
 *     not a full chain index; unresolved fields still use explicit unavailable
 *     fallbacks.
 *   ✗ budget.remainingWei — requires on-chain accounting that the v1 daemon
 *     does not yet maintain.
 *   ✗ summary.title / summary.resolutionTime — would require persisting the
 *     full Task spec at post-time. Out of scope for v1; the SPA falls back
 *     to taskId/postedAt when summary is absent.
 *
 * Spec: spec/2026-05-05-launcher-role-and-mode.md §5.3.
 */
import { getSolverNetContract } from '@jinn-network/sdk/solvernets';
import type { JinnConfig } from '../config.js';
import type { TaskOnchainStatus, TaskStatusSnapshot } from '../archive/types.js';
import { joinedDisplayName, solverTypeFromJoinedContract } from '../solver-nets/registry.js';

export type LauncherTaskState =
  | 'open'
  | 'claims-in-flight'
  | 'fully-claimed'
  | 'settled'
  | 'failed';

export interface LauncherTaskEntry {
  taskId: string;
  taskCid: string;
  solverNet: string;
  solverType?: string;
  postedAt: string;
  state: LauncherTaskState;
  /**
   * On-chain finalization status (#579), sourced from the indexer `task` table
   * (`finalized`/`refunded`/`claimWindowEnd`) — DISTINCT from the local,
   * generator-side `state`. `'unknown'` is the safe degraded default (no
   * snapshot / indexer outage); never guessed as `'open'`.
   */
  onchainStatus: TaskOnchainStatus;
  claims: { current: number; max: number };
  budget: { totalWei: string; remainingWei: string; reclaimableAt?: string };
  summary?: { title?: string; resolutionTime?: string };
}

export interface LauncherTasksResponse {
  schemaVersion: 1;
  generatedAt: string;
  cursor?: { before: string };
  tasks: LauncherTaskEntry[];
}

/** A single posted-Task row as surfaced by the daemon's store accessor. */
export interface PostedTaskRecord {
  taskId: string;
  /**
   * On-chain decimal taskId (#579). DISTINCT from `taskId`, which is the
   * off-chain task-document id (UUID / solver-type slug). The indexer status
   * map is keyed by this on-chain id, so `mapRecordToEntry` looks the chip up
   * by `protocolTaskId` (falling back to `taskId` for older/test rows that
   * don't carry it). Optional: pre-migration rows omit it.
   */
  protocolTaskId?: string;
  taskCid: string;
  /** Optional — if present, used to derive `solverNet` via config lookup. */
  solverType?: string;
  /** Optional override; when set, takes precedence over solverType-based mapping. */
  solverNet?: string;
  /** ISO-8601 timestamp; the response sorts on this DESC. */
  postedAt: string;
  state?: LauncherTaskState;
  claims?: { current?: number; max?: number };
  budget?: { totalWei?: string; remainingWei?: string; reclaimableAt?: string };
  summary?: { title?: string; resolutionTime?: string };
}

export interface FetchPostedTasksOptions {
  creatorAddress: string;
  /** Inclusive upper bound on result count after deps applies its own page logic. */
  limit: number;
  /** ISO-8601 timestamp; filter to rows with `postedAt < before`. */
  before?: string;
}

export interface GatherLauncherTasksDeps {
  config: Pick<JinnConfig, 'joinedSolverNets'>;
  creatorAddress: string;
  fetchPostedTasks: (
    opts: FetchPostedTasksOptions,
  ) => Promise<PostedTaskRecord[]> | PostedTaskRecord[];
  /**
   * Optional on-chain status fetcher (#579), keyed by SolverNet manifest CID.
   * Optional so existing call-sites/tests compile and degrade to 'unknown'.
   * Each call is wrapped in try/catch by the gatherer — a throw yields the
   * graceful all-'unknown' default rather than failing the whole response.
   */
  fetchTaskStatuses?: (manifestCid: string) => Promise<Map<string, TaskStatusSnapshot>>;
  now?: () => number;
}

export interface GatherLauncherTasksOptions {
  /** Page size; clamped to [1, 100]. Default 25 (matches spec). */
  limit?: number;
  /** ISO-8601 timestamp; filter to rows with `postedAt < before`. */
  before?: string;
  /**
   * Optional launched-record manifest CID. When present, on-chain statuses are
   * fetched only for this SolverNet, even if the launcher has not joined it.
   */
  manifestCid?: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const CLAIMS_CURRENT_UNAVAILABLE_FALLBACK = 0;
const CLAIMS_MAX_UNAVAILABLE_FALLBACK = 25;

function claimMaxFallbackForSolverType(solverType: string | undefined): number {
  if (!solverType) return CLAIMS_MAX_UNAVAILABLE_FALLBACK;
  const splitAt = solverType.lastIndexOf('.');
  if (splitAt <= 0 || splitAt === solverType.length - 1) {
    return CLAIMS_MAX_UNAVAILABLE_FALLBACK;
  }
  const contract = getSolverNetContract({
    id: solverType.slice(0, splitAt),
    version: solverType.slice(splitAt + 1),
  });
  return contract?.claimPolicyDefaults?.maxClaims ?? CLAIMS_MAX_UNAVAILABLE_FALLBACK;
}

/**
 * Build a solverType → solverNet-name lookup from the live config. The v1
 * mapping is 1:1 (one SolverNet per solver-type), but we index defensively so
 * a future fork-of-prediction config doesn't silently mislabel posted Tasks.
 *
 * Post-issue-#421 the lookup reads `joinedSolverNets` (manifest-CID-keyed)
 * exclusively; solverType is synthesised from `joined.contract`.
 */
function buildSolverTypeToNetIndex(
  joinedSolverNets: JinnConfig['joinedSolverNets'] | undefined,
): Map<string, string> {
  const index = new Map<string, string>();
  if (!joinedSolverNets) return index;
  for (const [cid, joined] of Object.entries(joinedSolverNets)) {
    const solverType = solverTypeFromJoinedContract(joined);
    if (!solverType || index.has(solverType)) continue;
    index.set(solverType, joinedDisplayName(cid, joined));
  }
  return index;
}

function normalizeManifestCid(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function statusLookupManifestCids(
  joinedSolverNets: JinnConfig['joinedSolverNets'] | undefined,
  launchedManifestCid: string | undefined,
  records: readonly PostedTaskRecord[],
): string[] {
  const scopedCid = normalizeManifestCid(launchedManifestCid);
  if (scopedCid) return [scopedCid];

  const solverTypes = new Set(records.map((record) => record.solverType).filter(Boolean));
  if (solverTypes.size > 0) {
    const cids = new Set<string>();
    for (const [cid, joined] of Object.entries(joinedSolverNets ?? {})) {
      const solverType = solverTypeFromJoinedContract(joined);
      if (!solverType || !solverTypes.has(solverType)) continue;
      const normalized = normalizeManifestCid(joined.manifestCid) ?? normalizeManifestCid(cid);
      if (normalized) cids.add(normalized);
    }
    return [...cids];
  }

  const cids = new Set<string>();
  for (const [cid, joined] of Object.entries(joinedSolverNets ?? {})) {
    const normalized = normalizeManifestCid(joined.manifestCid) ?? normalizeManifestCid(cid);
    if (normalized) cids.add(normalized);
  }
  return [...cids];
}

/**
 * Derive the on-chain status chip (#579) from a task's finalization snapshot.
 *
 * - `undefined` snapshot → 'unknown' (no on-chain data; the safe default — we
 *   never guess 'open').
 * - `finalized === true` → 'finalized'.
 * - `refunded === true` → 'finalized': a refunded task is on-chain-closed (the
 *   creator reclaimed budget), so it is terminal just like a finalized one. We
 *   collapse both into the 'finalized' chip rather than adding a 'refunded'
 *   tone — the launcher table only distinguishes open / closed / expired.
 * - missing/invalid `claimWindowEnd` → 'unknown' (the indexer cannot prove
 *   that claims are still open).
 * - not finalized, `now > claimWindowEnd` → 'expired'. Exact equality remains
 *   open, matching `TaskCoordinator.claimTask`.
 * - otherwise → 'open'.
 *
 * `nowSeconds` is unix seconds, matching the indexer's `claimWindowEnd`.
 */
export function deriveOnchainStatus(
  snapshot: TaskStatusSnapshot | undefined,
  nowSeconds: number,
): TaskOnchainStatus {
  if (!snapshot) return 'unknown';
  if (snapshot.finalized || snapshot.refunded) return 'finalized';
  if (typeof snapshot.claimWindowEnd !== 'number' || !Number.isFinite(snapshot.claimWindowEnd)) {
    return 'unknown';
  }
  if (nowSeconds > snapshot.claimWindowEnd) return 'expired';
  return 'open';
}

function mapRecordToEntry(
  record: PostedTaskRecord,
  solverTypeIndex: Map<string, string>,
  statusMap: Map<string, TaskStatusSnapshot>,
  nowSeconds: number,
): LauncherTaskEntry {
  const solverNet =
    record.solverNet
    ?? (record.solverType ? solverTypeIndex.get(record.solverType) : undefined)
    ?? 'unknown';
  const claimsCurrent = record.claims?.current ?? CLAIMS_CURRENT_UNAVAILABLE_FALLBACK;
  const claimsMax = record.claims?.max ?? claimMaxFallbackForSolverType(record.solverType);
  const totalWei = record.budget?.totalWei ?? '0';
  const remainingWei = record.budget?.remainingWei ?? totalWei;
  const entry: LauncherTaskEntry = {
    taskId: record.taskId,
    taskCid: record.taskCid,
    solverNet,
    ...(record.solverType ? { solverType: record.solverType } : {}),
    postedAt: record.postedAt,
    state: record.state ?? 'open',
    onchainStatus: deriveOnchainStatus(
      // The status map is keyed by the on-chain decimal taskId; prefer it. Fall
      // back to the off-chain display id for older/test rows lacking it (#579).
      statusMap.get(record.protocolTaskId ?? record.taskId),
      nowSeconds,
    ),
    claims: { current: claimsCurrent, max: claimsMax },
    budget: { totalWei, remainingWei },
  };
  if (record.budget?.reclaimableAt) {
    entry.budget.reclaimableAt = record.budget.reclaimableAt;
  }
  if (record.summary) {
    entry.summary = { ...record.summary };
  }
  return entry;
}

export async function gatherLauncherTasks(
  deps: GatherLauncherTasksDeps,
  opts: GatherLauncherTasksOptions = {},
): Promise<LauncherTasksResponse> {
  const requested = opts.limit ?? DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));

  const fetched = await Promise.resolve(
    deps.fetchPostedTasks({
      creatorAddress: deps.creatorAddress,
      limit,
      before: opts.before,
    }),
  );

  // Defensive sort: the store accessor returns rows in DESC `postedAt`
  // order, but the gather function is also reachable from tests that pass
  // unsorted fixtures. Sort here so the response invariant is unconditional.
  const sorted = [...fetched].sort((a, b) => {
    const ta = Date.parse(a.postedAt);
    const tb = Date.parse(b.postedAt);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    if (Number.isFinite(ta)) return -1;
    if (Number.isFinite(tb)) return 1;
    return 0;
  });
  const pageRecords = sorted.slice(0, limit);

  const solverTypeIndex = buildSolverTypeToNetIndex(deps.config.joinedSolverNets);

  // Build a merged on-chain status map keyed by taskId. The launched-SolverNet
  // page scopes this to its manifest CID; the generic fallback only checks
  // joined SolverNets matching the current page's solver types to avoid
  // unbounded dashboard-poll fanout. Each call is guarded so the store-only /
  // offline / indexer-outage path degrades to all-'unknown' (#579).
  const generatedAtMs = deps.now?.() ?? Date.now();
  const nowSeconds = Math.floor(generatedAtMs / 1000);
  const statusMap = new Map<string, TaskStatusSnapshot>();
  const fetchTaskStatuses = deps.fetchTaskStatuses;
  if (fetchTaskStatuses) {
    for (const cid of statusLookupManifestCids(
      deps.config.joinedSolverNets,
      opts.manifestCid,
      pageRecords,
    )) {
      try {
        const snapshots = await fetchTaskStatuses(cid);
        for (const [taskId, snapshot] of snapshots) statusMap.set(taskId, snapshot);
      } catch {
        // Tolerant: skip this SolverNet's statuses; its tasks render 'unknown'.
      }
    }
  }

  const tasks = pageRecords
    .map((record) => mapRecordToEntry(record, solverTypeIndex, statusMap, nowSeconds));

  const cursor =
    tasks.length === limit && tasks.length > 0
      ? { before: tasks[tasks.length - 1]!.postedAt }
      : undefined;

  const response: LauncherTasksResponse = {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    tasks,
  };
  if (cursor) response.cursor = cursor;
  return response;
}
