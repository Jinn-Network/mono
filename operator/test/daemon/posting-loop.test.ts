import { describe, expect, it, vi } from 'vitest';
import type { Store } from '../../src/store/store.js';
import {
  PostingLoop,
  buildPostingLoop,
  type PostingLoopPorts,
  type PostingLoopTarget,
} from '../../src/daemon/posting-loop.js';
import { RequesterError } from '../../src/native-requester/work-client/errors.js';

// The loop only touches the store through `recordLoopTick` inside `runLoop`, which we never reach
// in `tick()`-only tests. A minimal stub satisfies the type without a real SQLite store.
const stubStore = {} as unknown as Store;

function target(overrides: Partial<PostingLoopTarget> = {}): PostingLoopTarget {
  return {
    postingKey: 'repo',
    workKind: 'repository-work',
    profileUri: 'urn:p:1',
    live: true,
    generatorEnabled: true,
    ...overrides,
  };
}

function ports(overrides: Partial<PostingLoopPorts> = {}): { ports: PostingLoopPorts; posted: PostingLoopTarget[] } {
  const posted: PostingLoopTarget[] = [];
  const base: PostingLoopPorts = {
    reconcile: async () => {},
    listTargets: async () => [target()],
    probeFunds: async () => ({
      safeBalanceWei: 10_000n,
      agentBalanceWei: 20_000n,
      solutionMaxDeliveryRateWei: 500n,
      verdictMaxDeliveryRateWei: 500n,
      maxClaims: 1,
      agentGasReserveWei: 1_000n,
    }),
    probeFreshness: async () => ({
      claimWindowEndMs: 2_000_000,
      submissionDeadlineMs: 3_000_000,
      sessionDeadlineMs: 4_000_000,
    }),
    post: async (t) => {
      posted.push(t);
      return { taskId: `task-${t.postingKey}` };
    },
    now: () => 1_000_000,
    ...overrides,
  };
  return { ports: base, posted };
}

describe('PostingLoop.tick', () => {
  it('reconciles, preflights, and posts every live generator-enabled target', async () => {
    const reconcile = vi.fn(async () => {});
    const harness = ports({
      reconcile,
      listTargets: async () => [target({ postingKey: 'a' }), target({ postingKey: 'b' })],
    });
    const loop = new PostingLoop({ store: stubStore, ports: harness.ports });
    const posted = await loop.tick();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(posted).toEqual(['task-a', 'task-b']);
    expect(harness.posted.map((t) => t.postingKey)).toEqual(['a', 'b']);
  });

  it('skips targets that are not live or not generator-enabled', async () => {
    const harness = ports({
      listTargets: async () => [
        target({ postingKey: 'live-on', live: true, generatorEnabled: true }),
        target({ postingKey: 'live-off', live: true, generatorEnabled: false }),
        target({ postingKey: 'dark-on', live: false, generatorEnabled: true }),
      ],
    });
    const loop = new PostingLoop({ store: stubStore, ports: harness.ports });
    expect(await loop.tick()).toEqual(['task-live-on']);
  });

  it('does not post a target whose funds preflight fails, and does not strand the others', async () => {
    const harness = ports({
      listTargets: async () => [target({ postingKey: 'broke' }), target({ postingKey: 'ok' })],
      probeFunds: async (t) =>
        t.postingKey === 'broke'
          ? {
              safeBalanceWei: 1n,
              agentBalanceWei: 1n,
              solutionMaxDeliveryRateWei: 500n,
              verdictMaxDeliveryRateWei: 500n,
              maxClaims: 1,
              agentGasReserveWei: 1_000n,
            }
          : {
              safeBalanceWei: 10_000n,
              agentBalanceWei: 20_000n,
              solutionMaxDeliveryRateWei: 500n,
              verdictMaxDeliveryRateWei: 500n,
              maxClaims: 1,
              agentGasReserveWei: 1_000n,
            },
    });
    const loop = new PostingLoop({ store: stubStore, ports: harness.ports });
    expect(await loop.tick()).toEqual(['task-ok']);
    expect(harness.posted.map((t) => t.postingKey)).toEqual(['ok']);
  });

  it('does not post a target whose freshness preflight fails', async () => {
    const harness = ports({
      probeFreshness: async () => ({
        claimWindowEndMs: 1_000_000, // inside the reserve at now=1_000_000
        submissionDeadlineMs: 3_000_000,
        sessionDeadlineMs: 4_000_000,
      }),
    });
    const loop = new PostingLoop({ store: stubStore, ports: harness.ports });
    expect(await loop.tick()).toEqual([]);
    expect(harness.posted).toEqual([]);
  });

  it('surfaces a posting-side RequesterError as a skip, not a throw', async () => {
    const harness = ports({
      post: async () => {
        throw new RequesterError('broadcast', 'nonce-conflict', 'nonce already used');
      },
    });
    const loop = new PostingLoop({ store: stubStore, ports: harness.ports });
    await expect(loop.tick()).resolves.toEqual([]);
  });
});

describe('buildPostingLoop boot-inertness', () => {
  const options = { store: stubStore, ports: ports().ports };

  it('constructs the loop for a native composition with posting entries', () => {
    expect(
      buildPostingLoop({ compositionMode: 'native', postingEntryCount: 1, options }),
    ).toBeInstanceOf(PostingLoop);
  });

  it('is inert for a legacy composition (default boot)', () => {
    expect(
      buildPostingLoop({ compositionMode: 'legacy', postingEntryCount: 3, options }),
    ).toBeUndefined();
  });

  it('is inert for a native composition with no posting entries', () => {
    expect(
      buildPostingLoop({ compositionMode: 'native', postingEntryCount: 0, options }),
    ).toBeUndefined();
  });
});
