/**
 * Tests for the pure `computeTaskCoverage` helper consumed by the
 * /health/task-coverage Hono route.
 *
 * Issue #567: the indexer's TaskCreated handler can silently stop writing
 * `task` rows after a views swap. computeTaskCoverage compares the router's
 * authoritative `nextTaskId()` against the indexer's max(task.id) and
 * max(attempt.taskId) and decides whether the deployment is healthy.
 *
 * Table-driven cases cover:
 *   - ok (gaps within threshold)
 *   - threshold-edge (gap == threshold → ok)
 *   - taskGap exceeds threshold (the #567 symptom)
 *   - attemptGap exceeds threshold
 *   - unknown-rpc (onchainNextTaskId null → 503/unknown)
 *   - zero-indexed (indexer empty)
 *   - zero-onchain (router empty, no tasks created yet)
 *   - JSON shape (bigints serialised to decimal strings)
 */
import { describe, it, expect } from 'vitest';
// Importing from the helper sub-module (not task-coverage.js) because the
// route file pulls in the `ponder:api` virtual module which Vitest cannot
// resolve outside a running Ponder process. The helper is the unit under
// test; the route is exercised in task-coverage.route.test.ts via a mock.
import { computeTaskCoverage } from '../src/api/task-coverage-helper.js';

describe('computeTaskCoverage', () => {
  it('ok: both gaps zero → status=ok, httpStatus=200', () => {
    const r = computeTaskCoverage({
      chainId: 84532,
      onchainNextTaskId: 11n,
      maxIndexedTaskId: 10n,
      maxAttemptTaskId: 10n,
      gapThreshold: 5,
    });
    expect(r.status).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.taskGap).toBe(0);
    expect(r.attemptGap).toBe(0);
  });

  it('ok at threshold edge: taskGap === gapThreshold is still ok', () => {
    const r = computeTaskCoverage({
      chainId: 84532,
      onchainNextTaskId: 11n, // -> last allocated = 10
      maxIndexedTaskId: 5n, // gap = 5
      maxAttemptTaskId: 5n,
      gapThreshold: 5,
    });
    expect(r.status).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.taskGap).toBe(5);
    expect(r.attemptGap).toBe(5);
  });

  it('degraded: taskGap exceeds threshold (the #567 symptom)', () => {
    const r = computeTaskCoverage({
      chainId: 84532,
      onchainNextTaskId: 100n, // last allocated = 99
      maxIndexedTaskId: 10n, // gap = 89
      maxAttemptTaskId: 9n,
      gapThreshold: 5,
    });
    expect(r.status).toBe('degraded');
    expect(r.httpStatus).toBe(503);
    expect(r.taskGap).toBe(89);
    expect(r.attemptGap).toBe(90);
  });

  it('degraded: attemptGap exceeds threshold even when taskGap is fine', () => {
    const r = computeTaskCoverage({
      chainId: 84532,
      onchainNextTaskId: 11n, // last allocated = 10
      maxIndexedTaskId: 10n, // task gap = 0
      maxAttemptTaskId: 0n, // attempt gap = 10
      gapThreshold: 5,
    });
    expect(r.status).toBe('degraded');
    expect(r.httpStatus).toBe(503);
    expect(r.taskGap).toBe(0);
    expect(r.attemptGap).toBe(10);
  });

  it('unknown: onchainNextTaskId null → status=unknown, httpStatus=503', () => {
    const r = computeTaskCoverage({
      chainId: 84532,
      onchainNextTaskId: null,
      maxIndexedTaskId: 100n,
      maxAttemptTaskId: 100n,
      gapThreshold: 5,
    });
    expect(r.status).toBe('unknown');
    expect(r.httpStatus).toBe(503);
    expect(r.taskGap).toBeNull();
    expect(r.attemptGap).toBeNull();
    expect(r.onchainNextTaskId).toBeNull();
  });

  it('zero-indexed: indexer has no rows yet, onchain has tasks → degraded', () => {
    const r = computeTaskCoverage({
      chainId: 84532,
      onchainNextTaskId: 50n, // last allocated = 49
      maxIndexedTaskId: null, // no rows
      maxAttemptTaskId: null,
      gapThreshold: 5,
    });
    expect(r.status).toBe('degraded');
    expect(r.httpStatus).toBe(503);
    // gap when indexer empty: treat null indexer max as -1 (so gap = lastAlloc - (-1) = lastAlloc + 1)
    expect(r.taskGap).toBe(50);
    expect(r.attemptGap).toBe(50);
  });

  it('zero-onchain: no tasks created yet (nextTaskId == 0n) and indexer also empty → ok', () => {
    // Edge case: clean start. nextTaskId returns 0 (genesis); indexer has no rows.
    // lastAllocated = -1, indexer max = null → -1. Gap = 0.
    const r = computeTaskCoverage({
      chainId: 84532,
      onchainNextTaskId: 0n,
      maxIndexedTaskId: null,
      maxAttemptTaskId: null,
      gapThreshold: 5,
    });
    expect(r.status).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.taskGap).toBe(0);
    expect(r.attemptGap).toBe(0);
  });

  it('JSON shape: bigints serialise to decimal strings', () => {
    const r = computeTaskCoverage({
      chainId: 84532,
      onchainNextTaskId: 12_345_678_901_234_567_890n,
      maxIndexedTaskId: 12_345_678_901_234_567_889n,
      maxAttemptTaskId: 12_345_678_901_234_567_888n,
      gapThreshold: 5,
    });
    // Pre-serialisable shape
    expect(r.chainId).toBe(84532);
    expect(typeof r.onchainNextTaskId).toBe('string');
    expect(r.onchainNextTaskId).toBe('12345678901234567890');
    expect(typeof r.maxIndexedTaskId).toBe('string');
    expect(r.maxIndexedTaskId).toBe('12345678901234567889');
    expect(typeof r.maxAttemptTaskId).toBe('string');
    expect(r.maxAttemptTaskId).toBe('12345678901234567888');
    expect(typeof r.taskGap).toBe('number');
    // JSON.stringify must round-trip
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it('JSON shape: null indexer values pass through as null in the output', () => {
    const r = computeTaskCoverage({
      chainId: 84532,
      onchainNextTaskId: 5n,
      maxIndexedTaskId: null,
      maxAttemptTaskId: null,
      gapThreshold: 5,
    });
    expect(r.maxIndexedTaskId).toBeNull();
    expect(r.maxAttemptTaskId).toBeNull();
  });

  it('passes chainId through unmodified', () => {
    const r = computeTaskCoverage({
      chainId: 8453,
      onchainNextTaskId: 1n,
      maxIndexedTaskId: 0n,
      maxAttemptTaskId: 0n,
      gapThreshold: 5,
    });
    expect(r.chainId).toBe(8453);
  });
});
