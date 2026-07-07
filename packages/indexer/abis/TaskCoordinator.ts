/**
 * TaskCoordinator ABI slice — only the view functions the indexer needs.
 *
 * The TaskCoordinator (`contracts/src/tasks/TaskCoordinator.sol`) owns the
 * `nextTaskId` storage slot (the counter that increments with each `createTask`
 * call). JinnRouterV3 holds a reference to the coordinator
 * (`TaskCoordinator public taskCoordinator;`) but does NOT re-expose
 * `nextTaskId()` — so the /health/task-coverage monitoring probe must read
 * directly from the coordinator. See issue #567.
 *
 * Kept self-contained (no import from JinnRouter.ts) so the two ABI slices
 * stay independently editable.
 */
export const TASK_COORDINATOR_ABI = [
  // ── Next-task-id view (for the /health/task-coverage monitoring route) ───
  // The coordinator exposes the next unallocated taskId as a public view.
  // Used by packages/indexer/src/api/next-task-id.ts to detect when the
  // indexer's TaskCreated handler has fallen behind (issue #567).
  {
    name: 'nextTaskId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
