/**
 * Smoke test for the /health/task-coverage route shape — issue #567.
 *
 * The full route handler in `src/api/task-coverage.ts` imports `ponder:api`
 * (the Ponder DB virtual module), which Vitest cannot resolve outside a
 * running Ponder process. To exercise the route wiring we mount a parallel
 * Hono app here that delegates to the same `computeTaskCoverage` helper and
 * stubs the on-chain + DB I/O. This catches contract regressions in the
 * response shape, content-type, and HTTP status mapping without booting
 * Ponder; the helper test (`test/task-coverage.test.ts`) covers all the
 * threshold-edge / gap-exceeds cases.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { computeTaskCoverage } from '../src/api/task-coverage-helper.js';

const TASK_COVERAGE_CHAIN_ID = 84532;

/** Build a Hono app that mirrors the production route, using stubs for I/O. */
function makeRoute(stubs: {
  onchainNextTaskId: bigint | null;
  maxIndexedTaskId: bigint | null;
  maxAttemptTaskId: bigint | null;
  gapThreshold: number;
}) {
  const app = new Hono();
  app.get('/health/task-coverage', (c) => {
    const result = computeTaskCoverage({
      chainId: TASK_COVERAGE_CHAIN_ID,
      onchainNextTaskId: stubs.onchainNextTaskId,
      maxIndexedTaskId: stubs.maxIndexedTaskId,
      maxAttemptTaskId: stubs.maxAttemptTaskId,
      gapThreshold: stubs.gapThreshold,
    });
    return c.json(result, result.httpStatus);
  });
  return app;
}

describe('/health/task-coverage route shape', () => {
  it('responds 200 with status=ok when both gaps are within threshold', async () => {
    const app = makeRoute({
      onchainNextTaskId: 11n,
      maxIndexedTaskId: 10n,
      maxAttemptTaskId: 10n,
      gapThreshold: 5,
    });
    const res = await app.request('/health/task-coverage');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.httpStatus).toBe(200);
    expect(body.chainId).toBe(TASK_COVERAGE_CHAIN_ID);
    expect(body.onchainNextTaskId).toBe('11');
    expect(body.maxIndexedTaskId).toBe('10');
    expect(body.maxAttemptTaskId).toBe('10');
    expect(body.taskGap).toBe(0);
    expect(body.attemptGap).toBe(0);
  });

  it('responds 503 with status=degraded when taskGap exceeds threshold (the #567 symptom)', async () => {
    const app = makeRoute({
      onchainNextTaskId: 100n,
      maxIndexedTaskId: 10n,
      maxAttemptTaskId: 9n,
      gapThreshold: 5,
    });
    const res = await app.request('/health/task-coverage');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.httpStatus).toBe(503);
    expect(body.taskGap).toBe(89);
    expect(body.attemptGap).toBe(90);
  });

  it('responds 503 with status=unknown when the RPC is unavailable', async () => {
    const app = makeRoute({
      onchainNextTaskId: null,
      maxIndexedTaskId: 100n,
      maxAttemptTaskId: 100n,
      gapThreshold: 5,
    });
    const res = await app.request('/health/task-coverage');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unknown');
    expect(body.onchainNextTaskId).toBeNull();
    expect(body.taskGap).toBeNull();
    expect(body.attemptGap).toBeNull();
  });

  it('JSON body fields match the documented spec', async () => {
    const app = makeRoute({
      onchainNextTaskId: 11n,
      maxIndexedTaskId: 10n,
      maxAttemptTaskId: 10n,
      gapThreshold: 5,
    });
    const res = await app.request('/health/task-coverage');
    const body = await res.json();
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(
      [
        'attemptGap',
        'chainId',
        'httpStatus',
        'maxAttemptTaskId',
        'maxIndexedTaskId',
        'onchainNextTaskId',
        'status',
        'taskGap',
      ].sort(),
    );
  });
});
