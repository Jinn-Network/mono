/**
 * /health/task-coverage — operator-facing health probe for issue #567 (Ponder
 * `TaskCreated` handler silently stops writing rows after a views swap).
 *
 * Compares the TaskCoordinator's authoritative on-chain `nextTaskId()` against
 * the indexer's `max(task.id)` and `max(attempt.taskId)`; returns 503 when
 * either gap exceeds the threshold (env-configurable, default 5).
 *
 * The pure `computeTaskCoverage` helper lives in `./task-coverage-helper.ts`
 * so Vitest can exercise it without the `ponder:api` virtual module (which is
 * only resolvable inside a running Ponder process).
 *
 * Env:
 *   JINN_TASK_COVERAGE_GAP_THRESHOLD — integer ≥ 0, default 5.
 */
import { Hono } from 'hono';
import { db } from 'ponder:api';
import schema from 'ponder:schema';
import { eq } from 'ponder';
import { getNextTaskId } from './next-task-id.js';
import { computeTaskCoverage } from './task-coverage-helper.js';

/** Matches EXPLORER_CHAIN_ID in explorer.ts — Base Sepolia today. */
const TASK_COVERAGE_CHAIN_ID = 84532;

const DEFAULT_GAP_THRESHOLD = 5;

/** Parse the env threshold; falls back to the default on missing/invalid input. */
function readGapThreshold(): number {
  const raw = process.env['JINN_TASK_COVERAGE_GAP_THRESHOLD'];
  if (raw === undefined) return DEFAULT_GAP_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GAP_THRESHOLD;
  return n;
}

/**
 * Reduce a list of decimal-string ids to the numeric max as a bigint. Used
 * because `task.id` and `attempt.taskId` are `t.text()` columns — a SQL
 * `max()` on them would be lexicographic ('9' > '10'). The row count is
 * bounded by the on-chain task count, so client-side reduction is acceptable
 * for a monitoring endpoint. Server-side cast (`MAX(id::numeric)`) is the
 * upgrade path if/when the table grows past a few hundred thousand rows.
 */
function maxDecimalString(ids: ReadonlyArray<string | null | undefined>): bigint | null {
  let best: bigint | null = null;
  for (const v of ids) {
    if (typeof v !== 'string' || v.length === 0) continue;
    let asBig: bigint;
    try { asBig = BigInt(v); } catch { continue; }
    if (best === null || asBig > best) best = asBig;
  }
  return best;
}

async function getMaxIndexedTaskId(): Promise<bigint | null> {
  const rows = await db
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(eq(schema.task.chainId, TASK_COVERAGE_CHAIN_ID));
  return maxDecimalString(rows.map((r) => r.id));
}

async function getMaxAttemptTaskId(): Promise<bigint | null> {
  const rows = await db
    .select({ taskId: schema.attempt.taskId })
    .from(schema.attempt)
    .where(eq(schema.attempt.chainId, TASK_COVERAGE_CHAIN_ID));
  return maxDecimalString(rows.map((r) => r.taskId));
}

const app = new Hono();

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
    // Diagnostic detail stays in server logs; the response body must not echo
    // it back because Postgres errors can carry fragments of DATABASE_URL.
    console.warn(`[indexer] task-coverage probe failed: ${String(err)}`);
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
      },
      503,
    );
  }
});

export default app;
