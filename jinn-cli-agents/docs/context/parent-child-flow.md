---
title: Parent-Child Job Flow
purpose: context
scope: [worker]
last_verified: 2026-01-30
related_code:
  - worker/orchestration/jobRunner.ts
  - worker/status/autoDispatch.ts
  - gemini-agent/mcp/tools/dispatch_new_job.ts
  - worker/git/integration.ts
  - worker/git/branch.ts
  - worker/prompt/providers/invariants/CycleInvariantProvider.ts
keywords: [parent job, child job, dispatch, delegation, branch merging, verification]
when_to_read: "Use when understanding job delegation, debugging parent-child relationships, or implementing dispatch logic"
---

# Parent-Child Job Flow

How parent jobs dispatch children, wait for completion, receive results, and merge branches.

## Dispatch Flow

```
Parent Job (RUNNING)
    |
    | dispatch_new_job()
    v
+-------------------+
| Create JobDef     | <-- New UUID via ensureUuid()
| Build IPFS payload|
| Post to Mech      |
+-------------------+
    |
    | marketplaceInteract()
    v
Child Job Created (requestId returned)
    |
    | Worker picks up child
    v
Child Executes on own branch
```

### Key Functions

**`dispatch_new_job`** (`gemini-agent/mcp/tools/dispatch_new_job.ts`):
- Validates blueprint structure via `blueprintStructureSchema`
- Validates invariant semantics via `validateInvariantsStrict()`
- Validates dependencies are UUIDs, not job names
- Prevents circular dependencies (child cannot depend on parent)
- Calls `buildIpfsPayload()` then `marketplaceInteract()`

## Collection Flow (Child Completion)

When a child job reaches terminal state (COMPLETED/FAILED), the worker determines what happens next.

```
Child Job Completes
    |
    v
+---------------------------+
| dispatchParentIfNeeded()  |
+---------------------------+
    |
    v
shouldRequireVerification()
    |
    +-- needsContinuation? --> dispatchForContinuation()
    |                              (re-dispatch self)
    |
    +-- requiresVerification? --> dispatchForVerification()
    |                              (re-dispatch self with verificationRequired=true)
    |
    v
shouldDispatchParent()
    |
    +-- Check all siblings complete via Ponder query
    |
    +-- Claim dispatch via claimParentDispatch() (atomic)
    |
    v
dispatchExistingJob(parentJobDefId)
```

### Status Transitions

| Child Status | Next Action |
|-------------|-------------|
| COMPLETED, children unintegrated | `dispatchForContinuation()` |
| COMPLETED, children integrated, not verified | `dispatchForVerification()` |
| COMPLETED/FAILED, all siblings done | `dispatchParentIfNeeded()` |

### Sibling Coordination

Before dispatching parent, the worker queries Ponder to check all siblings:

```typescript
// From autoDispatch.ts shouldDispatchParent()
const childrenQuery = `query GetParentChildren($parentJobDefId: String!) {
  jobDefinitions(where: { sourceJobDefinitionId: $parentJobDefId }) {
    items { id, name, lastStatus }
  }
}`;
```

The check excludes the current job from the incomplete list (it knows it just completed).

Polling handles indexing lag: `PONDER_INDEX_POLL_COUNT` (default 3) attempts with `PONDER_INDEX_POLL_DELAY_MS` (default 500ms) between.

## Branch Merge Flow

When a parent job runs after children complete, it merges child branches.

```
Parent Job Starts
    |
    v
checkoutJobBranch()
    |
    | For each dependency in target.dependencies:
    v
+-----------------------------------+
| getDependencyBranchInfo(depJobDefId)|
| syncWithBranch(repoRoot, branchName)|
+-----------------------------------+
    |
    +-- No conflicts --> Merge committed
    |
    +-- Conflicts --> Agent must resolve
         (conflict markers in files)
```

### `syncWithBranch()` Logic (`worker/git/branch.ts`)

1. Check if target branch exists (local or remote)
2. Stash uncommitted changes if present
3. Run `git merge mergeRef --no-edit`
4. On conflict: leave markers in working tree for agent

### Integration Check (`worker/git/integration.ts`)

```typescript
function isChildIntegrated(childBranchName: string, parentBranch: string): boolean
```

Returns `true` if:
- Branch doesn't exist on remote (deleted = merged)
- Branch HEAD is ancestor of parent (`git merge-base --is-ancestor`)

## Verification Flow

Jobs that dispatched children require verification before notifying their parent.

```
Job completes after reviewing children
    |
    v
shouldRequireVerification()
    |
    +-- hadChildren? (from completedChildRuns or Ponder query)
    |
    +-- All children integrated? (isChildIntegrated check)
    |
    v
dispatchForVerification()
    |
    | Sets verificationRequired=true, verificationAttempt=N
    v
Same job re-runs in verification mode
    |
    v
On next completion: isVerificationRun=true
    --> Proceed to parent dispatch
```

Max verification attempts: `MAX_VERIFICATION_ATTEMPTS = 3`

## Recovery Dispatches

### Loop Recovery

When Gemini CLI detects unproductive loop:

```typescript
// From jobRunner.ts
await dispatchForLoopRecovery(metadata, target.id, fullLoopMessage, telemetry);
```

Max attempts: `MAX_LOOP_RECOVERY_ATTEMPTS = 3`

### Timeout Recovery

When process times out (15 min):

```typescript
await dispatchForTimeoutRecovery(metadata, target.id, timeoutMessage, telemetry);
```

Max attempts: `MAX_TIMEOUT_RECOVERY_ATTEMPTS = 2`

## Cyclic Jobs

Root jobs marked `cyclic: true` auto-dispatch after completion, enabling continuous operation.

### Enabling Cyclic Mode

Cyclic mode is set at **workstream launch time**, not by agents. The `cyclic` flag is NOT exposed through `dispatch_new_job` - agents cannot make jobs cyclic.

Set in IPFS metadata when launching via script:
```typescript
const ipfsJsonContents = [{
  blueprint: JSON.stringify({ invariants: [...] }),
  jobName: 'continuous-monitoring',
  cyclic: true,  // Enable continuous operation
}];
```

### Cycle Dispatch Flow

```
Job completes with COMPLETED status
    |
    v
dispatchParentIfNeeded()
    |
    +-- Has parent? --> Notify parent (normal flow)
    |
    +-- No parent (root) + cyclic: true?
        |
        v
    dispatchForCycle()
        |
        +-- Increment cycle number
        +-- Clear verification/recovery flags
        +-- Preserve workstream ID
        v
    New request for same job definition
```

### Cycle Context

Each cycle receives context in `additionalContext.cycle`:

```typescript
{
  isCycleRun: boolean;              // true for cycles after initial run
  cycleNumber: number;              // 1-indexed
  previousCycleCompletedAt?: string; // ISO timestamp
  previousCycleRequestId?: string;   // Previous cycle's request ID
}
```

The `CycleInvariantProvider` injects invariants directing the agent to evaluate current state and take action.

### Behavior Notes

- **Root jobs only**: Child jobs complete normally, never cycle
- **COMPLETED required**: FAILED jobs do not cycle
- **No cycle limit**: Jobs continue until stopped externally

## Environment Inheritance

Child jobs inherit environment via `JINN_INHERITED_ENV`:

```typescript
// From autoDispatch.ts
export function getInheritedEnv(): Record<string, string> {
  const envJson = process.env.JINN_INHERITED_ENV;
  return envJson ? JSON.parse(envJson) : {};
}
```

All dispatch functions include `env: { ...getInheritedEnv(), ... }` in additionalContext.
