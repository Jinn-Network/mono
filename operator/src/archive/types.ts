/**
 * Display/advisory row types for archive-backed operator-API reads.
 *
 * Wave-4 D4 moved these off `operator/src/discovery/types.ts` unchanged so the
 * SPA contract (task-post counts, launcher status chips, verdict tallies)
 * survives the discovery-tree deletion. Shapes are load-bearing — do not
 * change them here.
 */

/**
 * On-chain finalization status for a posted Task, as rendered in the Launcher
 * "Recent posted Tasks" table. This is a DISPLAY/advisory signal.
 * `'unknown'` is the safe degraded default whenever the status cannot be
 * resolved; callers MUST map absence to `'unknown'` and never guess `'open'`.
 */
export type TaskOnchainStatus = 'open' | 'finalized' | 'expired' | 'unknown';

/**
 * Per-task on-chain finalization snapshot, returned by `getTaskStatuses` keyed
 * by on-chain taskId (decimal string). Projector observations do not carry
 * indexer `finalized` / `refunded` / `claimWindowEnd` keyed by manifestCid,
 * so Wave-4 D4 degrades this read to an empty Map (launcher chips render
 * `'unknown'`).
 */
export interface TaskStatusSnapshot {
  taskId: string;
  finalized: boolean;
  refunded: boolean;
  claimWindowEnd?: number;
}

/**
 * Resolved verdict tally for one task. DISPLAY/advisory signal backing the
 * operator Activity table's task-relative Outcome column, NOT a correctness
 * gate. Callers map an absent taskId to `'awaiting'` — never a wrong `'fail'`.
 */
export interface VerdictTallyResult {
  pass: number;
  fail: number;
}

/**
 * Windowed on-chain task-post counts for one scope (chain-wide or a single
 * SolverNet). Each window is a count of `TaskCreated` events whose block falls
 * within the last 1h / 6h / 24h, computed as a block-window approximation
 * (Base ~2s blocktime: 1h≈1800, 6h≈10800, 24h≈43200 blocks back from head).
 * The windows nest: `h1 ⊆ h6 ⊆ h24`.
 */
export interface TaskPostCounts {
  /** TaskCreated events in the last ~1h. */
  h1: number;
  /** TaskCreated events in the last ~6h (includes h1). */
  h6: number;
  /** TaskCreated events in the last ~24h (includes h6). */
  h24: number;
  /** Block at the head of the window. */
  windowEndBlock: number;
  /** Unix seconds the window was computed. */
  windowEndTs: number;
}

/**
 * Block-window thresholds for `getTaskPostCounts`, from Base's ~2s blocktime:
 * 1h≈1800, 6h≈10800, 24h≈43200 blocks back from the window head. The windows
 * nest (h1 ⊆ h6 ⊆ h24); the 24h figure also bounds the scan range.
 */
export const TASK_POST_WINDOW_BLOCKS = { h1: 1_800, h6: 10_800, h24: 43_200 } as const;

/**
 * Bucket a stream of TaskCreated events into chain-wide + per-cid
 * `TaskPostCounts`. `events` carry a `block` (number) and lowercased manifest
 * `digest`; `cidByDigest` maps each requested digest to its cid. Counts nest
 * (h1 ⊆ h6 ⊆ h24); events older than the 24h cut are ignored.
 */
export function bucketTaskPostCounts(
  windowEndBlock: number,
  windowEndTs: number,
  events: Array<{ block: number; digest: string }>,
  cidByDigest: Map<string, string>,
): { chain: TaskPostCounts; byCid: Record<string, TaskPostCounts> } {
  const h1Cut = windowEndBlock - TASK_POST_WINDOW_BLOCKS.h1;
  const h6Cut = windowEndBlock - TASK_POST_WINDOW_BLOCKS.h6;
  const h24Cut = windowEndBlock - TASK_POST_WINDOW_BLOCKS.h24;

  const blank = (): TaskPostCounts => ({ h1: 0, h6: 0, h24: 0, windowEndBlock, windowEndTs });
  const chain = blank();
  const byCid: Record<string, TaskPostCounts> = {};
  for (const cid of cidByDigest.values()) byCid[cid] = blank();

  const bucket = (target: TaskPostCounts, block: number): void => {
    if (block < h24Cut) return;
    target.h24 += 1;
    if (block >= h6Cut) target.h6 += 1;
    if (block >= h1Cut) target.h1 += 1;
  };

  for (const e of events) {
    bucket(chain, e.block);
    const cid = cidByDigest.get(e.digest);
    if (cid) bucket(byCid[cid]!, e.block);
  }

  return { chain, byCid };
}
