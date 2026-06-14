/**
 * Tests for the net-liveness probe — the operator-independent #1038 silent-stall
 * detector. Two layers under test:
 *
 *   - `classifyNetLiveness` — the pure decision function (injected bigints, zero I/O)
 *   - `runNetLivenessProbe`  — the orchestrator (all four reads + webhook injected)
 *
 * Both are tested with no network and no clock dependency: every seam is a mock.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  BASE_BLOCKS_PER_MINUTE,
  minutesToThresholdBlocks,
  classifyNetLiveness,
  runNetLivenessProbe,
  type NetLivenessAlertPayload,
} from '../../src/monitoring/net-liveness.js';

describe('minutesToThresholdBlocks', () => {
  it('converts minutes to Base block-space at 30 blocks/min', () => {
    expect(BASE_BLOCKS_PER_MINUTE).toBe(30);
    expect(minutesToThresholdBlocks(30)).toBe(900);
    expect(minutesToThresholdBlocks(1)).toBe(30);
  });
});

describe('classifyNetLiveness', () => {
  const thresholdBlocks = minutesToThresholdBlocks(30); // 900

  it('healthy: recent activity, chain advancing, indexer caught up', () => {
    const r = classifyNetLiveness({
      chainHeadBlock: 10_000n,
      prevChainHeadBlock: 9_999n,
      latestActivityBlock: 9_900n, // 100 blocks behind head, under 900
      indexerHeadBlock: 9_999n,
      thresholdBlocks,
    });
    expect(r.state).toBe('healthy');
  });

  it('stale: chain advancing, indexer caught up, but no recent activity → ALERT', () => {
    const r = classifyNetLiveness({
      chainHeadBlock: 10_000n,
      prevChainHeadBlock: 9_999n,
      latestActivityBlock: 8_000n, // 2000 blocks behind head, over 900
      indexerHeadBlock: 9_999n,
      thresholdBlocks,
    });
    expect(r.state).toBe('stale');
    expect(r.staleForBlocks).toBe(2_000n);
  });

  it('stale: no activity rows at all → staleForBlocks counts from 0', () => {
    const r = classifyNetLiveness({
      chainHeadBlock: 10_000n,
      prevChainHeadBlock: 9_999n,
      latestActivityBlock: null,
      indexerHeadBlock: 9_999n,
      thresholdBlocks,
    });
    expect(r.state).toBe('stale');
    expect(r.staleForBlocks).toBe(10_000n);
  });

  it('chain-halted: head did not advance between the two reads → no alert', () => {
    const r = classifyNetLiveness({
      chainHeadBlock: 10_000n,
      prevChainHeadBlock: 10_000n, // unchanged
      latestActivityBlock: 8_000n, // would otherwise be stale
      indexerHeadBlock: 9_999n,
      thresholdBlocks,
    });
    expect(r.state).toBe('chain-halted');
  });

  it('indexer-lagging: indexer far behind chain head → no alert', () => {
    const r = classifyNetLiveness({
      chainHeadBlock: 10_000n,
      prevChainHeadBlock: 9_999n,
      latestActivityBlock: 9_900n,
      indexerHeadBlock: 8_000n, // 2000 blocks behind head, over 900
      thresholdBlocks,
    });
    expect(r.state).toBe('indexer-lagging');
  });

  it('indexer-down: indexer head unreadable → no alert', () => {
    const r = classifyNetLiveness({
      chainHeadBlock: 10_000n,
      prevChainHeadBlock: 9_999n,
      latestActivityBlock: null,
      indexerHeadBlock: null,
      thresholdBlocks,
    });
    expect(r.state).toBe('indexer-down');
  });

  it('boundary: activity exactly thresholdBlocks behind → healthy (no alert)', () => {
    const r = classifyNetLiveness({
      chainHeadBlock: 10_000n,
      prevChainHeadBlock: 9_999n,
      latestActivityBlock: 10_000n - BigInt(thresholdBlocks), // exactly 900 behind
      indexerHeadBlock: 9_999n,
      thresholdBlocks,
    });
    expect(r.state).toBe('healthy');
  });

  it('boundary: activity thresholdBlocks+1 behind → stale (alert)', () => {
    const r = classifyNetLiveness({
      chainHeadBlock: 10_000n,
      prevChainHeadBlock: 9_999n,
      latestActivityBlock: 10_000n - BigInt(thresholdBlocks) - 1n, // 901 behind
      indexerHeadBlock: 9_999n,
      thresholdBlocks,
    });
    expect(r.state).toBe('stale');
  });

  it('boundary: indexer exactly thresholdBlocks behind → not lagging', () => {
    const r = classifyNetLiveness({
      chainHeadBlock: 10_000n,
      prevChainHeadBlock: 9_999n,
      latestActivityBlock: 9_900n,
      indexerHeadBlock: 10_000n - BigInt(thresholdBlocks), // exactly 900 behind
      thresholdBlocks,
    });
    expect(r.state).toBe('healthy');
  });
});

describe('runNetLivenessProbe', () => {
  const now = () => new Date('2026-06-14T00:00:00.000Z');

  function baseDeps(overrides: Partial<Parameters<typeof runNetLivenessProbe>[0]> = {}) {
    return {
      // two reads return advancing heads by default
      fetchChainHead: vi
        .fn<[], Promise<bigint>>()
        .mockResolvedValueOnce(9_999n)
        .mockResolvedValueOnce(10_000n),
      fetchLatestActivityBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(9_900n),
      fetchIndexerHeadBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(9_999n),
      postWebhook: null as ((p: NetLivenessAlertPayload) => Promise<void>) | null,
      thresholdMinutes: 30,
      // no-op sleep keeps orchestrator tests fast (real delay is injected only by the script)
      sleep: vi.fn<[number], Promise<void>>().mockResolvedValue(),
      headSampleDelayMs: 4_000,
      now,
      ...overrides,
    };
  }

  it('calls fetchChainHead twice to detect advancement within one run', async () => {
    const deps = baseDeps();
    await runNetLivenessProbe(deps);
    expect(deps.fetchChainHead).toHaveBeenCalledTimes(2);
  });

  it('sleeps headSampleDelayMs BETWEEN the two chain-head reads', async () => {
    // Drive advancement off the passage of time, NOT off two pre-baked distinct
    // values: the head only advances when `sleep` is awaited. A future refactor
    // that drops the delay leaves both reads on the same block → chain-halted.
    let head = 1_000n;
    const order: string[] = [];
    const fetchChainHead = vi.fn<[], Promise<bigint>>().mockImplementation(async () => {
      order.push(`head:${head}`);
      return head;
    });
    const sleep = vi.fn<[number], Promise<void>>().mockImplementation(async (ms) => {
      order.push(`sleep:${ms}`);
      head += 1n; // a healthy chain produces a new block while we wait
    });
    const deps = baseDeps({
      fetchChainHead,
      sleep,
      headSampleDelayMs: 4_000,
      fetchLatestActivityBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(999n),
      fetchIndexerHeadBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(1_000n),
    });
    const r = await runNetLivenessProbe(deps);
    // sleep must land strictly between the two reads
    expect(order).toEqual(['head:1000', 'sleep:4000', 'head:1001']);
    expect(sleep).toHaveBeenCalledWith(4_000);
    // advancement was observed (1000 → 1001) so this is NOT chain-halted
    expect(r.state).not.toBe('chain-halted');
  });

  it('regression: identical head both reads → chain-halted, no alert (no fabricated advancement)', async () => {
    // The real-world hazard: a single block (or a cached read) yields the SAME
    // value twice. Without genuine advancement between samples the probe must
    // report chain-halted and never page. This is the exact failure mode the
    // back-to-back uncached reads produced before the delay seam existed.
    const postWebhook = vi.fn<[NetLivenessAlertPayload], Promise<void>>().mockResolvedValue();
    const deps = baseDeps({
      fetchChainHead: vi.fn<[], Promise<bigint>>().mockResolvedValue(10_000n), // SAME both calls
      fetchLatestActivityBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(1_000n), // would-be stale
      fetchIndexerHeadBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(9_999n),
      postWebhook,
    });
    const r = await runNetLivenessProbe(deps);
    expect(r.state).toBe('chain-halted');
    expect(postWebhook).not.toHaveBeenCalled();
  });

  it('stale + no webhook (null): classifies stale, does NOT throw, no POST', async () => {
    const postWebhook = vi.fn<[NetLivenessAlertPayload], Promise<void>>().mockResolvedValue();
    const deps = baseDeps({
      fetchLatestActivityBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(1_000n),
      postWebhook: null,
    });
    const r = await runNetLivenessProbe(deps);
    expect(r.state).toBe('stale');
    expect(postWebhook).not.toHaveBeenCalled();
  });

  it('stale + webhook: posts exactly one alert with staleForMinutes + runAt', async () => {
    const postWebhook = vi.fn<[NetLivenessAlertPayload], Promise<void>>().mockResolvedValue();
    const deps = baseDeps({
      fetchLatestActivityBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(1_000n),
      postWebhook,
    });
    const r = await runNetLivenessProbe(deps);
    expect(r.state).toBe('stale');
    expect(postWebhook).toHaveBeenCalledTimes(1);
    const payload = postWebhook.mock.calls[0]![0];
    expect(payload.state).toBe('stale');
    // chainHead 10_000, activity 1_000 → 9_000 blocks → 300 minutes
    expect(payload.staleForBlocks).toBe('9000');
    expect(payload.staleForMinutes).toBe(300);
    expect(payload.chainHeadBlock).toBe('10000');
    expect(payload.latestActivityBlock).toBe('1000');
    expect(payload.runAt).toBe('2026-06-14T00:00:00.000Z');
    expect(typeof payload.text).toBe('string');
    expect(payload.text.length).toBeGreaterThan(0);
  });

  it('chain-halted: no POST even with webhook configured', async () => {
    const postWebhook = vi.fn<[NetLivenessAlertPayload], Promise<void>>().mockResolvedValue();
    const deps = baseDeps({
      fetchChainHead: vi
        .fn<[], Promise<bigint>>()
        .mockResolvedValueOnce(10_000n)
        .mockResolvedValueOnce(10_000n),
      fetchLatestActivityBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(1_000n),
      postWebhook,
    });
    const r = await runNetLivenessProbe(deps);
    expect(r.state).toBe('chain-halted');
    expect(postWebhook).not.toHaveBeenCalled();
  });

  it('indexer-lagging: no POST even with webhook configured', async () => {
    const postWebhook = vi.fn<[NetLivenessAlertPayload], Promise<void>>().mockResolvedValue();
    const deps = baseDeps({
      fetchIndexerHeadBlock: vi.fn<[], Promise<bigint | null>>().mockResolvedValue(1_000n),
      postWebhook,
    });
    const r = await runNetLivenessProbe(deps);
    expect(r.state).toBe('indexer-lagging');
    expect(postWebhook).not.toHaveBeenCalled();
  });

  it('fetchIndexerHeadBlock throws: classified indexer-down, no POST, no crash', async () => {
    const postWebhook = vi.fn<[NetLivenessAlertPayload], Promise<void>>().mockResolvedValue();
    const deps = baseDeps({
      fetchIndexerHeadBlock: vi
        .fn<[], Promise<bigint | null>>()
        .mockRejectedValue(new Error('indexer unreachable')),
      postWebhook,
    });
    const r = await runNetLivenessProbe(deps);
    expect(r.state).toBe('indexer-down');
    expect(postWebhook).not.toHaveBeenCalled();
  });

  it('fetchLatestActivityBlock throws: indexer-down, no crash', async () => {
    const deps = baseDeps({
      fetchLatestActivityBlock: vi
        .fn<[], Promise<bigint | null>>()
        .mockRejectedValue(new Error('graphql down')),
    });
    const r = await runNetLivenessProbe(deps);
    expect(r.state).toBe('indexer-down');
  });
});
