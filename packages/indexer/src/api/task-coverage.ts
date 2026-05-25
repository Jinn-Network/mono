/**
 * /health/task-coverage — operator-facing health probe that detects the
 * issue-#567 condition where the Ponder TaskCreated handler has silently
 * stopped writing rows after a views swap or schema regression.
 *
 * Strategy:
 *   - Query the JinnRouter's `nextTaskId()` (the authoritative on-chain
 *     next-allocated task id) via the cached helper.
 *   - Query the indexer's `max(task.id::bigint)` and
 *     `max(attempt.taskId::bigint)`.
 *   - Compare; if either gap exceeds the threshold the route returns 503.
 *
 * This file exports the Hono sub-app mounted as `/health/task-coverage` from
 * src/api/index.ts. The pure `computeTaskCoverage` helper lives in
 * `./task-coverage-helper.ts` so Vitest can exercise it without the
 * `ponder:api` virtual module; we re-export it here so callers that want a
 * single import path still get one.
 *
 * Env var:
 *   JINN_TASK_COVERAGE_GAP_THRESHOLD — integer, default 5. Both gaps must be
 *                                     ≤ this value for the route to return 200.
 *
 * Response shape (JSON):
 *   {
 *     chainId, onchainNextTaskId, maxIndexedTaskId, maxAttemptTaskId,
 *     taskGap, attemptGap, status, httpStatus
 *   }
 * Bigints serialise to decimal strings because JSON cannot represent them.
 */
import { Hono } from 'hono';
import { db } from 'ponder:api';
import schema from 'ponder:schema';
import { eq } from 'ponder';
import { getNextTaskId } from './next-task-id.js';
import {
  computeTaskCoverage,
  type TaskCoverageInputs,
  type TaskCoverageResult,
} from './task-coverage-helper.js';

// Re-export so callers can import everything from this file.
export { computeTaskCoverage };
export type { TaskCoverageInputs, TaskCoverageResult };

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * The chain the indexer scopes its task-coverage check to. Matches
 * EXPLORER_CHAIN_ID in explorer.ts — Base Sepolia today; revisit when mainnet
 * indexing lands.
 */
const TASK_COVERAGE_CHAIN_ID = 84532;

const DEFAULT_GAP_THRESHOLD = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse JINN_TASK_COVERAGE_GAP_THRESHOLD. Returns the default on missing /
 * non-integer / non-positive input so the route is never broken by a bad env.
 */
function readGapThreshold(): number {
  const raw = process.env['JINN_TASK_COVERAGE_GAP_THRESHOLD'];
  if (raw === undefined) return DEFAULT_GAP_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GAP_THRESHOLD;
  return n;
}

/**
 * Query the indexer's max `task.id` (a decimal string column) and convert to
 * bigint. Returns null when no rows exist.
 *
 * `task.id` is `t.text()` so a SQL `max()` would be lexicographic — '9'
 * would rank above '10'. To get the true numeric max we read the column and
 * reduce client-side. The row count is bounded by the on-chain task count
 * (one row per TaskCreated event), so this is acceptable for a monitoring
 * endpoint. If/when the table grows past a few hundred thousand rows we can
 * switch to a server-side cast (e.g. `MAX(id::numeric)`).
 */
async function getMaxIndexedTaskId(): Promise<bigint | null> {
  const rows = await db
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(eq(schema.task.chainId, TASK_COVERAGE_CHAIN_ID));
  if (rows.length === 0) return null;
  let best: bigint | null = null;
  for (const row of rows) {
    const v = row.id;
    if (typeof v !== 'string' || v.length === 0) continue;
    let asBig: bigint;
    try { asBig = BigInt(v); } catch { continue; }
    if (best === null || asBig > best) best = asBig;
  }
  return best;
}

/**
 * Query the indexer's max `attempt.taskId` (also a decimal string).
 * Same lexicographic concern as task.id; reduce client-side.
 */
async function getMaxAttemptTaskId(): Promise<bigint | null> {
  const rows = await db
    .select({ taskId: schema.attempt.taskId })
    .from(schema.attempt)
    .where(eq(schema.attempt.chainId, TASK_COVERAGE_CHAIN_ID));
  if (rows.length === 0) return null;
  let best: bigint | null = null;
  for (const row of rows) {
    const v = row.taskId;
    if (typeof v !== 'string' || v.length === 0) continue;
    let asBig: bigint;
    try { asBig = BigInt(v); } catch { continue; }
    if (best === null || asBig > best) best = asBig;
  }
  return best;
}

// ── Hono sub-app ──────────────────────────────────────────────────────────────

const app = new Hono();

/**
 * GET /task-coverage — see file header for response shape. Mounted as
 * `/health/task-coverage` from src/api/index.ts.
 */
app.get('/task-coverage', async (c) => {
  const gapThreshold = readGapThreshold();
  try {
    const [onchainNextTaskId, maxIndexedTaskId, maxAttemptTaskId] = await Promise.all([
      getNextTaskId(),
      getMaxIndexedTaskId(),
      getMaxAttemptTaskId(),
    ]);
    const result = computeTaskCoverage({
      chainId: TASK_COVERAGE_CHAIN_ID,
      onchainNextTaskId,
      maxIndexedTaskId,
      maxAttemptTaskId,
      gapThreshold,
    });
    return c.json(result, result.httpStatus);
  } catch (err) {
    return c.json(
      {
        chainId: TASK_COVERAGE_CHAIN_ID,
        onchainNextTaskId: null,
        maxIndexedTaskId: null,
        maxAttemptTaskId: null,
        taskGap: null,
        attemptGap: null,
        status: 'unknown' as const,
        httpStatus: 503 as const,
        error: String(err),
      },
      503,
    );
  }
});

export default app;
