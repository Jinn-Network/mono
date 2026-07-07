/**
 * Tests for the TaskCoordinator ABI slice — asserts that the `nextTaskId()`
 * view function is present so the indexer can call it via viem to discover the
 * authoritative on-chain next-task-id (used by the /health/task-coverage
 * monitoring route).
 *
 * Issue #567: the Ponder indexer's TaskCreated handler can silently stop
 * writing rows after a deploy if the views swap leaves the public-facing
 * `task` view pointing at an old schema. The monitoring route compares the
 * coordinator's `nextTaskId` against the indexer's max indexed task id to
 * surface that condition before it becomes operator-visible.
 *
 * Regression guard: the second assertion locks in that `nextTaskId` is NOT
 * on the JinnRouter ABI. The view lives on TaskCoordinator; JinnRouterV3
 * holds a reference to the coordinator but does not re-expose this view.
 * A previous revision pointed the probe at JinnRouter, which reverted at
 * runtime and made the health probe return `status: 'unknown'` forever.
 */
import { describe, it, expect } from 'vitest';
import { getAbiItem } from 'viem';
import { TASK_COORDINATOR_ABI } from '../abis/TaskCoordinator.js';
import { JINN_ROUTER_ABI } from '../abis/JinnRouter.js';

describe('TaskCoordinator ABI — nextTaskId()', () => {
  it('exposes a `nextTaskId` view function with no inputs and a uint256 output', () => {
    const item = getAbiItem({ abi: TASK_COORDINATOR_ABI, name: 'nextTaskId' });
    expect(item).toBeDefined();
    expect(item?.type).toBe('function');
    // viem narrows by name → these properties are typed when name is a literal
    expect(item?.stateMutability).toBe('view');
    expect(item?.inputs).toEqual([]);
    expect(item?.outputs).toHaveLength(1);
    expect(item?.outputs[0]?.type).toBe('uint256');
  });

  it('is NOT present on the JinnRouter ABI (regression guard for #567)', () => {
    // The TaskCoordinator owns the `nextTaskId` storage slot. If a future
    // contributor re-adds `nextTaskId` to JINN_ROUTER_ABI the probe could
    // silently regress to the broken state where it reads from the router
    // address and reverts at runtime. Lock this out at the ABI layer.
    const item = getAbiItem({
      abi: JINN_ROUTER_ABI,
      // @ts-expect-error — `nextTaskId` is intentionally absent from the
      // JinnRouter ABI; this assertion guards against it being re-added.
      name: 'nextTaskId',
    });
    expect(item).toBeUndefined();
  });
});
