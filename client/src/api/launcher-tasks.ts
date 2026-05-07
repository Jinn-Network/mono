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
 *   ✗ state / claims.current / budget.remainingWei — require on-chain state
 *     tracking that the v1 daemon does not yet maintain. The router-watcher
 *     hardening lane (bd jinn-mono-l2zl.12) will add per-Task lifecycle
 *     events; until then we report `state: 'open'`, `claims.current: 0`, and
 *     `budget: { totalWei: '0', remainingWei: '0' }`. These defaults are
 *     accurate for the freshly-posted Task case, which is the one operators
 *     see most often in the day-1 launcher UI.
 *   ✗ summary.title / summary.resolutionTime — would require persisting the
 *     full Task spec at post-time. Out of scope for v1; the SPA falls back
 *     to taskId/postedAt when summary is absent.
 *
 * Spec: spec/2026-05-05-launcher-role-and-mode.md §5.3.
 */
import type { JinnConfig } from '../config.js';

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
  postedAt: string;
  state: LauncherTaskState;
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
  config: Pick<JinnConfig, 'solverNets'>;
  creatorAddress: string;
  fetchPostedTasks: (
    opts: FetchPostedTasksOptions,
  ) => Promise<PostedTaskRecord[]> | PostedTaskRecord[];
  now?: () => number;
}

export interface GatherLauncherTasksOptions {
  /** Page size; clamped to [1, 100]. Default 25 (matches spec). */
  limit?: number;
  /** ISO-8601 timestamp; filter to rows with `postedAt < before`. */
  before?: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_CLAIMS_MAX = 25;

/**
 * Build a solverType → solverNet-name lookup from the live config. The v1
 * mapping is 1:1 (one SolverNet per solver-type), but we index defensively so
 * a future fork-of-prediction config doesn't silently mislabel posted Tasks.
 */
function buildSolverTypeToNetIndex(
  solverNets: JinnConfig['solverNets'] | undefined,
): Map<string, string> {
  const index = new Map<string, string>();
  if (!solverNets) return index;
  for (const [name, net] of Object.entries(solverNets)) {
    const solverType = (net as { solverType?: string } | undefined)?.solverType;
    if (typeof solverType === 'string' && solverType.length > 0 && !index.has(solverType)) {
      index.set(solverType, name);
    }
  }
  return index;
}

function mapRecordToEntry(
  record: PostedTaskRecord,
  solverTypeIndex: Map<string, string>,
): LauncherTaskEntry {
  const solverNet =
    record.solverNet
    ?? (record.solverType ? solverTypeIndex.get(record.solverType) : undefined)
    ?? 'unknown';
  const claimsCurrent = record.claims?.current ?? 0;
  const claimsMax = record.claims?.max ?? DEFAULT_CLAIMS_MAX;
  const totalWei = record.budget?.totalWei ?? '0';
  const remainingWei = record.budget?.remainingWei ?? totalWei;
  const entry: LauncherTaskEntry = {
    taskId: record.taskId,
    taskCid: record.taskCid,
    solverNet,
    postedAt: record.postedAt,
    state: record.state ?? 'open',
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

  const solverTypeIndex = buildSolverTypeToNetIndex(deps.config.solverNets);
  const tasks = sorted.slice(0, limit).map((record) => mapRecordToEntry(record, solverTypeIndex));

  const cursor =
    tasks.length === limit && tasks.length > 0
      ? { before: tasks[tasks.length - 1]!.postedAt }
      : undefined;

  const generatedAtMs = deps.now?.() ?? Date.now();
  const response: LauncherTasksResponse = {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    tasks,
  };
  if (cursor) response.cursor = cursor;
  return response;
}
