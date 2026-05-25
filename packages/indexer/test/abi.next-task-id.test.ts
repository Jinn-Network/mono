/**
 * Tests for the JinnRouter ABI slice — asserts that the `nextTaskId()` view
 * function is present so the indexer can call it via viem to discover the
 * authoritative on-chain next-task-id (used by the /health/task-coverage
 * monitoring route).
 *
 * Issue #567: the Ponder indexer's TaskCreated handler can silently stop
 * writing rows after a deploy if the views swap leaves the public-facing
 * `task` view pointing at an old schema. The monitoring route compares the
 * router's `nextTaskId` against the indexer's max indexed task id to surface
 * that condition before it becomes operator-visible.
 */
import { describe, it, expect } from 'vitest';
import { getAbiItem } from 'viem';
import { JINN_ROUTER_ABI } from '../abis/JinnRouter.js';

describe('JinnRouter ABI — nextTaskId()', () => {
  it('exposes a `nextTaskId` view function with no inputs and a uint256 output', () => {
    const item = getAbiItem({ abi: JINN_ROUTER_ABI, name: 'nextTaskId' });
    expect(item).toBeDefined();
    expect(item?.type).toBe('function');
    // viem narrows by name → these properties are typed when name is a literal
    expect(item?.stateMutability).toBe('view');
    expect(item?.inputs).toEqual([]);
    expect(item?.outputs).toHaveLength(1);
    expect(item?.outputs[0]?.type).toBe('uint256');
  });
});
