# Task Post Broadcast Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one-shot machine Task submission at-most-once across process crashes, classify ownership loss correctly, and enforce request freshness at the final wallet boundary.

**Architecture:** Persist a nullable broadcast intent through one transactional Store operation that also verifies and renews the current owner token. An unfinished intent can only take the existing exact recovery path; CLI cause-chain classification distinguishes uncertainty, owner loss, and policy expiry without weakening Safe retry fencing.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, viem Safe transaction adapter.

## Global Constraints

- Use an additive `task_posts.broadcast_intent_at` migration compatible with existing databases.
- Final freshness runs before intent persistence in the same adapter `beforeBroadcast` callback.
- No unfinished intent may reach `adapter.postTask` on a later invocation.
- `SafeBroadcastFenceError` remains non-recoverable inside transaction retry.
- Do not change unrelated manual or interval posting behavior.

---

### Task 1: Durable owner-bound broadcast intent

**Files:**
- Modify: `client/src/store/store.ts`
- Test: `client/test/store/store.test.ts`

**Interfaces:**
- Consumes: existing `TaskPostRecord`, `task_post_locks`, and additive migration helper.
- Produces:
  `TaskPostRecord.broadcastIntentAt?: string | null` and
  `Store.markTaskPostBroadcastIntent(args): boolean`.

- [ ] **Step 1: Write the failing migration, CAS, and preservation tests**

```ts
expect(columns.map((column) => column.name)).toContain('broadcast_intent_at');

expect(store.markTaskPostBroadcastIntent({
  creatorSafeAddress,
  sourceKey,
  policyType: 'once_per_safe',
  scopeKey: '',
  ownerToken: 'wrong-owner',
  lockedAt: intentAt,
  broadcastIntentAt: intentAt,
})).toBe(false);

expect(store.markTaskPostBroadcastIntent({
  creatorSafeAddress,
  sourceKey,
  policyType: 'once_per_safe',
  scopeKey: '',
  ownerToken: 'current-owner',
  lockedAt: intentAt,
  broadcastIntentAt: intentAt,
})).toBe(true);

store.upsertTaskPostRecord({ ...recordWithoutIntent });
expect(store.getTaskPostRecord(key)?.broadcastIntentAt).toBe(intentAt);
```

- [ ] **Step 2: Run the Store tests and verify RED**

Run:

```bash
cd client
yarn vitest run test/store/store.test.ts
```

Expected: compile/assertion failures because the field, migration, and Store
method do not exist.

- [ ] **Step 3: Implement the additive column and transactional CAS**

```ts
export interface TaskPostRecord {
  // existing fields
  broadcastIntentAt?: string | null;
}

markTaskPostBroadcastIntent(args: {
  creatorSafeAddress: string;
  sourceKey: string;
  policyType: TaskPostingPolicyType;
  scopeKey: string;
  ownerToken: string;
  lockedAt: string;
  broadcastIntentAt: string;
}): boolean {
  return this.db.transaction((params: typeof args) => {
    const renewed = this.db.prepare(
      `UPDATE task_post_locks
          SET locked_at = @lockedAt
        WHERE creator_safe_address = @creatorSafeAddress
          AND source_key = @sourceKey
          AND policy_type = @policyType
          AND scope_key = @scopeKey
          AND owner_token = @ownerToken`,
    ).run(params);
    if (renewed.changes !== 1) return false;
    const marked = this.db.prepare(
      `UPDATE task_posts
          SET broadcast_intent_at = @broadcastIntentAt
        WHERE creator_safe_address = @creatorSafeAddress
          AND source_key = @sourceKey
          AND policy_type = @policyType
          AND scope_key = @scopeKey`,
    ).run(params);
    if (marked.changes !== 1) {
      throw new Error('Task post record disappeared while marking broadcast intent');
    }
    return true;
  })(args);
}
```

Add `broadcast_intent_at TEXT` to fresh schema and the migration; select/map it
in `getTaskPostRecord`; insert it and preserve it with
`COALESCE(excluded.broadcast_intent_at, task_posts.broadcast_intent_at)` in
`upsertTaskPostRecord`.

- [ ] **Step 4: Run the Store tests and verify GREEN**

Run:

```bash
cd client
yarn vitest run test/store/store.test.ts
```

Expected: all Store tests pass.

---

### Task 2: Recovery-only posting state

**Files:**
- Modify: `client/src/tasks/posting-service.ts`
- Test: `client/test/tasks/posting-service.test.ts`

**Interfaces:**
- Consumes: `Store.markTaskPostBroadcastIntent` and existing exact
  `ExecutionAdapter.recoverTaskPost`.
- Produces: `TaskPostOwnershipLostError`,
  `TaskPostBroadcastUncertainError`, and
  `PostTaskCandidateOptions.beforeBroadcast`.

- [ ] **Step 1: Write failing two-process recovery tests**

```ts
const firstStore = new Store(dbPath);
const first = new TaskPostingService(firstAdapter, firstStore);
await expect(first.postCandidate(candidate, options)).rejects.toThrow();
expect(firstStore.getTaskPostRecord(key)?.broadcastIntentAt).toBeTruthy();
firstStore.close();

const secondStore = new Store(dbPath);
const second = new TaskPostingService(secondAdapter, secondStore);
await expect(second.postCandidate(candidate, options)).rejects.toMatchObject({
  name: 'TaskPostBroadcastUncertainError',
});
expect(secondAdapter.postTask).not.toHaveBeenCalled();

recoverTaskPost.mockResolvedValueOnce(recovered);
await expect(second.postCandidate(candidate, options)).resolves.toMatchObject({
  source: 'recovered',
  idempotent: true,
});
```

The first adapter must call `beforeBroadcast`, count the wallet write, and then
call `onTransactionHash` while the Store hash upsert is forced to throw. Add a
separate first-process adapter that calls `beforeBroadcast` and throws before
the wallet count; its second process must also be uncertain and never post.

- [ ] **Step 2: Run posting-service tests and verify RED**

Run:

```bash
cd client
yarn vitest run test/tasks/posting-service.test.ts
```

Expected: second invocations call `postTask` again and no named uncertainty
error exists.

- [ ] **Step 3: Implement recovery-only intent behavior**

```ts
export class TaskPostOwnershipLostError extends TransientError {
  readonly name = 'TaskPostOwnershipLostError';
}

export class TaskPostBroadcastUncertainError extends TransientError {
  readonly name = 'TaskPostBroadcastUncertainError';
  constructor(
    readonly broadcastIntentAt: string,
    sourceKey: string,
  ) {
    super(`Task post ${sourceKey} has durable broadcast intent but no visible TaskCreated event`);
  }
}

export interface PostTaskCandidateOptions {
  creatorSafeAddress?: string;
  beforeBroadcast?: () => void | Promise<void>;
}
```

After exact recovery returns no match:

```ts
if (lockedExisting?.broadcastIntentAt && !lockedExisting.protocolTaskId) {
  throw new TaskPostBroadcastUncertainError(
    lockedExisting.broadcastIntentAt,
    candidate.sourceKey,
  );
}
```

At the wallet boundary:

```ts
beforeBroadcast: async () => {
  await opts.beforeBroadcast?.();
  const intentAt = this.scheduler.now().toISOString();
  const ownsIntent = this.store.markTaskPostBroadcastIntent({
    creatorSafeAddress,
    sourceKey: candidate.sourceKey,
    policyType,
    scopeKey,
    ownerToken,
    lockedAt: intentAt,
    broadcastIntentAt: intentAt,
  });
  if (!ownsIntent) {
    lockLost = true;
    throw new TaskPostOwnershipLostError(
      `Task post ownership was lost at the wallet boundary for ${candidate.sourceKey}`,
    );
  }
}
```

- [ ] **Step 4: Run posting and Store tests and verify GREEN**

Run:

```bash
cd client
yarn vitest run test/tasks/posting-service.test.ts test/store/store.test.ts
```

Expected: all tests pass, including second-process no-rebroadcast and later
adoption.

---

### Task 3: CLI cause classification and final freshness

**Files:**
- Modify: `client/src/tasks/submit-preflight.ts`
- Modify: `client/src/cli/commands/tasks.ts`
- Test: `client/test/tasks/submit-preflight.test.ts`
- Test: `client/test/cli/commands/tasks.test.ts`

**Interfaces:**
- Consumes: `PostTaskCandidateOptions.beforeBroadcast`,
  `SafeBroadcastFenceError`, `TaskPostOwnershipLostError`, and
  `TaskPostBroadcastUncertainError`.
- Produces: `MarketplaceTaskRequestExpiredError` and stable CLI reason fields
  `ownership_lost`, `broadcast_uncertain`, and `policy_expired`.

- [ ] **Step 1: Write failing named-expiration and CLI integration tests**

```ts
expect(() => assertMarketplaceTaskRequestFreshness(expired, { nowMs }))
  .toThrowError(expect.objectContaining({
    name: 'MarketplaceTaskRequestExpiredError',
  }));
```

Build a CLI adapter whose `postTask` invokes real `executeSafeTransaction`.
For owner loss, change the durable lock owner before Safe reaches
`beforeBroadcast`; assert:

```ts
expect(output).toMatchObject({
  code: 'transient_error',
  details: { reason: 'ownership_lost' },
});
expect(writeContract).not.toHaveBeenCalled();
```

For final freshness, set fake time so the request passes command entry, advance
past the reserve inside slow adapter preparation, then invoke the same real Safe
wrapper and assert:

```ts
expect(output).toMatchObject({
  code: 'invalid_invocation',
  details: { reason: 'policy_expired', field: 'freshness' },
});
expect(writeContract).not.toHaveBeenCalled();
```

Extend the crash-frozen two-process CLI test so the failed hash Store write is
followed first by:

```ts
expect(output).toMatchObject({
  code: 'transient_error',
  details: { reason: 'broadcast_uncertain' },
});
expect(secondPostTask).not.toHaveBeenCalled();
```

and then by successful exact recovery.

- [ ] **Step 2: Run focused CLI/preflight tests and verify RED**

Run:

```bash
cd client
yarn vitest run test/tasks/submit-preflight.test.ts test/cli/commands/tasks.test.ts
```

Expected: freshness throws a generic error, final freshness is not called, and
Safe ownership/uncertainty errors are emitted as fatal.

- [ ] **Step 3: Implement named causes and CLI cause-chain mapping**

```ts
export class MarketplaceTaskRequestExpiredError extends Error {
  readonly name = 'MarketplaceTaskRequestExpiredError';
}
```

Pass the final assertion into the posting service:

```ts
{
  creatorSafeAddress: safe,
  ...(machineRequest
    ? {
        beforeBroadcast: () =>
          assertMarketplaceTaskRequestFreshness(machineRequest),
      }
    : {}),
}
```

Use a bounded `cause` walker in the CLI catch. Emit:

```ts
details: { reason: 'ownership_lost' }
details: { reason: 'broadcast_uncertain', broadcastIntentAt }
details: { field: 'freshness', reason: 'policy_expired' }
```

Keep `SafeBroadcastFenceError` non-recoverable in `isRecoverableTransactionError`.

- [ ] **Step 4: Run focused CLI, posting, Safe, and Store tests and verify GREEN**

Run:

```bash
cd client
yarn vitest run \
  test/cli/commands/tasks.test.ts \
  test/tasks/submit-preflight.test.ts \
  test/tasks/posting-service.test.ts \
  test/adapters/mech/safe.test.ts \
  test/store/store.test.ts
```

Expected: all focused tests pass with zero wallet calls in owner-loss and
final-expiry cases.

---

### Task 4: Verification and delivery

**Files:**
- Modify: `.superpowers/sdd/task-2-report.md` (ignored local report)
- Commit all scoped source/test changes.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: verified implementation commit and final evidence.

- [ ] **Step 1: Run focused and adjacent regression tests**

```bash
cd client
yarn vitest run \
  test/store/store.test.ts \
  test/tasks/posting-service.test.ts \
  test/tasks/submit-preflight.test.ts \
  test/cli/commands/tasks.test.ts \
  test/cli/commands/tasks-machine-dry-run-fs.test.ts \
  test/adapters/mech/safe.test.ts \
  test/adapters/mech/contracts-submit-task.test.ts \
  test/adapters/mech/adapter.test.ts \
  test/adapters/mech/contracts.test.ts \
  test/adapters/mech/eviction-recovery.test.ts \
  test/tx-retry.test.ts \
  test/tasks/signing.test.ts \
  test/tasks/submit-selection.test.ts \
  test/cli/execution-context.test.ts \
  test/_support/store.test.ts
```

Expected: every listed suite passes.

- [ ] **Step 2: Run compiler and diff checks**

```bash
cd client
yarn tsc --noEmit
cd ..
git diff --check
```

Expected: no new Task submission errors; the only accepted compiler output is
the two pre-existing evaluator narrowing errors at
`src/harnesses/impls/jinn-repo-evaluator/harness.ts:248,262`.

- [ ] **Step 3: Update the implementation report**

Append exact RED/GREEN evidence, schema/API impact, final test counts, and the
known typecheck baseline to `.superpowers/sdd/task-2-report.md`.

- [ ] **Step 4: Commit scoped implementation**

```bash
git add client/src client/test
git commit -m "fix(client): persist Task broadcast uncertainty"
```

- [ ] **Step 5: Re-run Task 4 Steps 1 and 2 after commit**

Expected: identical test/typecheck evidence and a clean worktree.
