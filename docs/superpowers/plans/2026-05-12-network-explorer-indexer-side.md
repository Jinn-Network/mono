# Network Explorer — Indexer-Side Implementation Plan (ebu7.2 + ebu7.3 + ebu7.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the on-chain-derivable explorer entities (`verdict`, `rewardDistribution`, `task.requiredVerdicts`, `task.refunded`, `solverNetManifest.cidKeccak`) to the `@jinn-network/indexer` Ponder schema; add `/explorer/*` aggregation routes over them; serve a static SPA shell at `/`. Produces a working public read substrate: network KPIs, per-SolverNet resolved-rate + leaderboards (ranked quality-first), JINN-distributed totals — all from on-chain data, no IPFS.

**Architecture:** `packages/indexer/` is a standalone Ponder 0.16.6 app. New event sources (`JinnRouter.VerdictDeliveryClaimed`, `JinnRouter.TaskBudgetRefunded`, a new Sepolia-L1 `JinnDistributor.Claimed`) map to new schema entities via pure handler functions in `src/handlers.ts` (registered by thin `ponder.on(...)` shims in `src/index.ts`, unit-tested without booting Ponder via the in-memory-`db` stub in `test/`). The aggregation routes live in a Hono sub-app (`src/api/explorer.ts`) mounted in `src/api/index.ts` alongside the auto GraphQL; response-shaping is extracted into pure functions (`src/api/shapers.ts`) and unit-tested. Static serving is a `serveStatic` mount at `/` with an `index.html` SPA fallback.

**Tech stack:** Ponder 0.16.6, Drizzle (Ponder's `onchainTable` + the `db` Drizzle handle in `ponder:api`), Hono 4, viem, Vitest 2. Chains: Base Sepolia (84532, existing) + Sepolia L1 (11155111, new — for `JinnDistributor`).

**Spec:** `docs/superpowers/specs/2026-05-12-network-explorer-design.md` v0.3, §3 / §4.1 / §5 (on-chain data backing) / §6 / §10. This plan covers `jinn-mono-ebu7.2`, `jinn-mono-ebu7.3`, `jinn-mono-ebu7.5`. `jinn-mono-ebu7.6` (IPFS enrichment — the mode/harness/checkpoint dims) is a separate follow-up plan, also indexer-side. `jinn-mono-ebu7.4` (the SPA itself) is a separate plan.

**Conventions:** Run-mode `feat` (the `ebu7.2`/`ebu7.3`/`ebu7.5` beads' shape). All work happens in this worktree (`.claude/worktrees/ebu7-network-explorer-design`). bd: claim `jinn-mono-ebu7.2` before Phase A, `jinn-mono-ebu7.3` before Phase B, `jinn-mono-ebu7.5` before Phase C; mark each `in_progress` on start, `close` on completion. Each task ends with a commit; conventional-commit prefix `feat(ebu7.2|ebu7.3|ebu7.5): ...`.

---

## Pre-flight (do once, before Task A1)

- [ ] **P1: Claim the bead.**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.claude/worktrees/ebu7-network-explorer-design
bd update jinn-mono-ebu7.2 --claim && bd update jinn-mono-ebu7.2 --status in_progress
```

- [ ] **P2: Baseline-green the indexer.**

```bash
cd packages/indexer
yarn install
yarn typecheck   # expect: 0 errors
yarn test        # expect: all pass
yarn build       # = ponder codegen; expect: success
```
Expected: clean. If anything fails, **stop and report** — this plan assumes a green baseline.

- [ ] **P3: Look up the values this plan references by name.** Record them in your notes; you'll paste them into specific tasks below.
  - **JinnDistributor address + deploy block + chain:** open `client/deployments/deployment-jinn-mvi-l1-sepolia.json` (or `contracts/deployment-jinn-mvi-l1-sepolia-fast.json`). Confirm: address `0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6`, chain `11155111` (Sepolia L1). Find the deployment block number if recorded (look for `blockNumber` / `receipt.blockNumber`); if absent, you'll use a conservative recent Sepolia block in Task A6.
  - **JinnDistributor `Claimed` event signature:** open `contracts/src/jinn/distribution/JinnDistributor.sol`, find the `event Claimed(...)` declaration (~line 145). Record the exact param list. Expected: `Claimed(uint256 indexed serviceId, address indexed multisig, uint256 operatorMinted, uint256 daoMinted, uint256 totalEntitledOperator, uint256 totalEntitledDao)`. Cross-check against `JINN_DISTRIBUTOR_ABI` in `client/src/earning/contracts.ts` (~line 944).
  - **`VerdictDeliveryClaimed` ABI fragment:** open `client/src/adapters/mech/types.ts` (~line 348). Record verbatim. Expected: `inputs: [{evaluator address indexed}, {requestId bytes32 indexed}, {taskId uint256 indexed}, {attemptIndex uint32}, {verdictIndex uint32}, {verdictCode uint8}]`. Cross-check `contracts/src/staking/JinnRouterV3.sol:138`.
  - **`TaskBudgetRefunded` ABI fragment:** from `contracts/src/staking/JinnRouterV3.sol:139` — `event TaskBudgetRefunded(uint256 indexed taskId, address indexed creator, uint256 solutionAmount, uint256 verdictAmount)`.
  - **Does the daemon's `HttpDiscoveryAPI` hit `/graphql` or `/`?** open `client/src/discovery/http.ts`, find the GraphQL endpoint path it appends to `discovery.url`. Record it (`/graphql` vs `/`). This decides Task C1 (whether moving GraphQL off `/` is safe).
  - **`operator` ↔ `multisig` mapping:** is the `multisig` in `JinnDistributor.Claimed` the same address as `attempt.operator` (the operator Safe on JinnRouter)? Check `client/src/earning/` (the Safe address used for staking/claims) and `JinnDistributor.claim`'s proof recovery. If they're the same address, the leaderboard's `jinnEarned` join is `rewardDistribution.multisig == attempt.operator`. If not, record what the mapping is. If you can't determine it confidently, the plan's Task B4 has a fallback (omit `jinnEarned` from the leaderboard for v1, surface JINN only at network scope).

---

# PHASE A — `ebu7.2`: on-chain schema additions

## Task A1: Add new event ABI fragments

**Files:**
- Modify: `packages/indexer/abis/JinnRouter.ts`
- Create: `packages/indexer/abis/JinnDistributor.ts`

- [ ] **Step 1: Add `VerdictDeliveryClaimed` + `TaskBudgetRefunded` to `JinnRouter.ts`.** Inside the `JINN_ROUTER_ABI` array, after the `SolutionDeliveryClaimed` event entry, add:

```ts
  // ── Verdict delivery (verdict outcome — VerdictCode {None,Pass,Fail,Invalid,Unresolved}) ──
  {
    name: 'VerdictDeliveryClaimed',
    type: 'event',
    inputs: [
      { name: 'evaluator', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: false },
      { name: 'verdictIndex', type: 'uint32', indexed: false },
      { name: 'verdictCode', type: 'uint8', indexed: false },
    ],
  },
  // ── Task budget refund (creator's unspent solution/verdict budget returned) ──
  {
    name: 'TaskBudgetRefunded',
    type: 'event',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'solutionAmount', type: 'uint256', indexed: false },
      { name: 'verdictAmount', type: 'uint256', indexed: false },
    ],
  },
```
Also add `requiredVerdicts` is already in the `TaskCreated` inputs — leave that as is. Update the file's top comment: strike the line claiming `TaskRefunded` doesn't exist; replace with "`TaskBudgetRefunded` exists and is now indexed → `Task.refunded`; `VerdictDeliveryClaimed` carries the verdict outcome."

- [ ] **Step 2: Create `packages/indexer/abis/JinnDistributor.ts`** (use the `Claimed` signature you recorded in P3):

```ts
/**
 * JinnDistributor ABI slice — only the `Claimed` event the indexer needs.
 * Sourced from contracts/src/jinn/distribution/JinnDistributor.sol and
 * cross-checked against client/src/earning/contracts.ts (JINN_DISTRIBUTOR_ABI).
 *
 * JinnDistributor lives on Sepolia L1 (chain 11155111) — the JINN DAO chain —
 * NOT on Base. It distributes JINN across three weighted channels
 * (wTaskCreation / wSolutionDelivery / wVerdictDelivery); the per-channel split
 * is computed inside claim() and is NOT in the event — the indexer reconstructs
 * it from per-operator JinnRouter activity counts. The Claimed event carries the
 * cumulative entitlement and this-claim's minted delta.
 */
export const JINN_DISTRIBUTOR_ABI = [
  {
    name: 'Claimed',
    type: 'event',
    inputs: [
      { name: 'serviceId', type: 'uint256', indexed: true },
      { name: 'multisig', type: 'address', indexed: true },
      { name: 'operatorMinted', type: 'uint256', indexed: false },
      { name: 'daoMinted', type: 'uint256', indexed: false },
      { name: 'totalEntitledOperator', type: 'uint256', indexed: false },
      { name: 'totalEntitledDao', type: 'uint256', indexed: false },
    ],
  },
] as const;
```
If the signature you recorded in P3 differs, use the recorded one and note the difference in the file comment.

- [ ] **Step 3: typecheck.**

```bash
cd packages/indexer && yarn typecheck
```
Expected: 0 errors (ABI consts are `as const`, no runtime use yet).

- [ ] **Step 4: Commit.**

```bash
git add packages/indexer/abis/JinnRouter.ts packages/indexer/abis/JinnDistributor.ts
git commit -m "feat(ebu7.2): add VerdictDeliveryClaimed, TaskBudgetRefunded, JinnDistributor.Claimed ABI fragments"
```

## Task A2: Add `requiredVerdicts` to the `task` entity

**Files:**
- Modify: `packages/indexer/ponder.schema.ts` (the `task` table)
- Modify: `packages/indexer/src/handlers.ts` (`TaskCreatedEvent` type + `handleTaskCreated`)
- Modify: `packages/indexer/test/helpers/events.ts` (the `taskCreatedEvent` builder)
- Test: `packages/indexer/test/handlers.test.ts`

- [ ] **Step 1: Write the failing test.** In `test/handlers.test.ts`, in the existing `describe('TaskCreated → task', ...)` block, add to the first test's `toMatchObject` assertion the field `requiredVerdicts: 2` and pass `requiredVerdicts: 2` in the `taskCreatedEvent({...})` args. (Pick 2 as the test value.)

- [ ] **Step 2: Run it — verify it fails.**

```bash
cd packages/indexer && yarn test test/handlers.test.ts -t "creates a task row"
```
Expected: FAIL — `requiredVerdicts` is `undefined` on the row (column doesn't exist / handler doesn't set it).

- [ ] **Step 3: Add the column.** In `ponder.schema.ts`, in the `task` table definition, after `maxClaims`:

```ts
    /** requiredVerdicts from the TaskCreated event — verdicts needed before an attempt finalizes. */
    requiredVerdicts: t.integer().notNull().default(0),
```

- [ ] **Step 4: Plumb it through the handler + types + builder.**
  - In `src/handlers.ts`: add `requiredVerdicts: bigint | number;` to `TaskCreatedEvent['args']`; in `handleTaskCreated`'s `.values({...})` add `requiredVerdicts: Number(event.args.requiredVerdicts ?? 0),`.
  - In `src/index.ts`: the `event as unknown as TaskCreatedEvent` cast already covers it (Ponder's decoded `event.args` has `requiredVerdicts` from the ABI). No change needed beyond confirming the ABI has it (it does — Task A1 left it).
  - In `test/helpers/events.ts`: add `requiredVerdicts` to the `taskCreatedEvent` builder's defaults (default `1`) and to its overridable args type.

- [ ] **Step 5: codegen + run the test — verify it passes.**

```bash
cd packages/indexer && yarn build && yarn test test/handlers.test.ts
```
Expected: PASS (all handler tests, incl. the updated one and the idempotency test).

- [ ] **Step 6: Commit.**

```bash
git add packages/indexer/ponder.schema.ts packages/indexer/src/handlers.ts packages/indexer/test/helpers/events.ts packages/indexer/test/handlers.test.ts
git commit -m "feat(ebu7.2): index TaskCreated.requiredVerdicts on the task entity"
```

## Task A3: Add the `verdict` entity to the schema

**Files:**
- Modify: `packages/indexer/ponder.schema.ts`

- [ ] **Step 1: Add the `verdict` table.** After the `attempt` table definition (and before `solverNetManifest`), add:

```ts
// ── Verdict ──────────────────────────────────────────────────────────────────

/**
 * One verdict delivered for a task attempt. From JinnRouter.VerdictDeliveryClaimed.
 * verdictCode: 0=None, 1=Pass, 2=Fail, 3=Invalid, 4=Unresolved (VerdictCode enum
 * in contracts/src/tasks/TaskCoordinator.sol). "Resolved" / "verdict-success" =
 * verdictCode == 1 (Pass). Per-attempt finalization (passed/failed) is derived in
 * the aggregation routes by counting Pass verdicts against requiredVerdicts; the
 * contract uses an on-chain passThreshold which is a createTask call-arg, not
 * emitted — see ponder.config.ts §claimWindow note for the call-trace-decoding
 * follow-up. v1 treats an attempt as resolved-pass when it has >= requiredVerdicts
 * verdicts of which a majority are Pass (documented assumption: passThreshold ~ majority).
 *
 * Primary key: (taskId, attemptIndex, verdictIndex, chainId).
 */
export const verdict = onchainTable(
  'verdict',
  (t) => ({
    taskId: t.text().notNull(),
    attemptIndex: t.integer().notNull(),
    verdictIndex: t.integer().notNull(),
    /** Evaluator Safe address that delivered the verdict. */
    evaluator: t.hex().notNull(),
    /** MechMarketplace requestId of the verdict request. */
    requestId: t.hex().notNull(),
    /** Raw verdict code: 0..4 per the VerdictCode enum. */
    verdictCode: t.integer().notNull(),
    createdAtBlock: t.bigint().notNull(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.attemptIndex, table.verdictIndex, table.chainId] }),
    taskIdx: index().on(table.taskId),
    taskAttemptIdx: index().on(table.taskId, table.attemptIndex),
    evaluatorIdx: index().on(table.evaluator),
    codeIdx: index().on(table.verdictCode),
    blockIdx: index().on(table.createdAtBlock),
  }),
);
```
Also add a relation: in the relations block at the bottom, extend `attemptRelations` (or add `verdictRelations`) so `verdict.task` and `attempt.verdicts` are navigable — mirror the existing `taskRelations`/`attemptRelations` pattern:

```ts
export const verdictRelations = relations(verdict, ({ one }) => ({
  task: one(task, { fields: [verdict.taskId], references: [task.id] }),
}));
```
(Optional — only if you need GraphQL nav; safe to add.)

- [ ] **Step 2: codegen — verify it builds.**

```bash
cd packages/indexer && yarn build && yarn typecheck
```
Expected: success, 0 errors.

- [ ] **Step 3: Commit.**

```bash
git add packages/indexer/ponder.schema.ts
git commit -m "feat(ebu7.2): add the verdict entity to the schema"
```

## Task A4: `handleVerdictDeliveryClaimed`

**Files:**
- Modify: `packages/indexer/src/handlers.ts` (new event type + handler)
- Modify: `packages/indexer/src/index.ts` (registration)
- Modify: `packages/indexer/test/helpers/events.ts` (new builder `verdictDeliveryClaimedEvent`)
- Test: `packages/indexer/test/handlers.test.ts`

- [ ] **Step 1: Write the failing test.** In `test/handlers.test.ts`, add a `describe('VerdictDeliveryClaimed → verdict', ...)` block with a test: import `verdict` from `../ponder.schema.js`; call `handleVerdictDeliveryClaimed({ event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0, evaluator: '0x'+'aa'.repeat(20), requestId: '0x'+'bb'.repeat(32), verdictCode: 1 }, { block: 41_153_400n }), context, verdict })`; assert `db.get(verdict, { taskId: '7', attemptIndex: 0, verdictIndex: 0, chainId: CHAIN_ID })` toMatchObject the expected row. Add a second test: replayed event is idempotent (`db.count(verdict)` stays 1).

- [ ] **Step 2: Run it — verify it fails.**

```bash
cd packages/indexer && yarn test test/handlers.test.ts -t "VerdictDeliveryClaimed"
```
Expected: FAIL — `handleVerdictDeliveryClaimed` / `verdictDeliveryClaimedEvent` not defined.

- [ ] **Step 3: Add the event type + handler to `src/handlers.ts`.** Near the other `*Event` interfaces:

```ts
export interface VerdictDeliveryClaimedEvent {
  args: {
    evaluator: `0x${string}`;
    requestId: `0x${string}`;
    taskId: bigint;
    attemptIndex: bigint | number;
    verdictIndex: bigint | number;
    verdictCode: bigint | number;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}
```
Near the other handlers:

```ts
// ── JinnRouter: VerdictDeliveryClaimed → verdict ─────────────────────────────
// One row per delivered verdict. verdictCode 0..4 per VerdictCode enum.
// Idempotent: a replayed event with the same (taskId, attemptIndex, verdictIndex,
// chainId) does not clobber the original.
export async function handleVerdictDeliveryClaimed({
  event,
  context,
  verdict,
}: {
  event: VerdictDeliveryClaimedEvent;
  context: HandlerContext;
  verdict: unknown;
}): Promise<void> {
  await context.db
    .insert(verdict)
    .values({
      taskId: event.args.taskId.toString(),
      attemptIndex: Number(event.args.attemptIndex),
      verdictIndex: Number(event.args.verdictIndex),
      evaluator: event.args.evaluator,
      requestId: event.args.requestId,
      verdictCode: Number(event.args.verdictCode),
      createdAtBlock: event.block.number,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}
```

- [ ] **Step 4: Register in `src/index.ts`.** Add `verdict` to the `import { ... } from 'ponder:schema'` line and `handleVerdictDeliveryClaimed, type VerdictDeliveryClaimedEvent` to the `from './handlers.js'` import; then add (after the `SolutionDeliveryClaimed` registration):

```ts
ponder.on('JinnRouter:VerdictDeliveryClaimed', async ({ event, context }) => {
  await handleVerdictDeliveryClaimed({
    event: event as unknown as VerdictDeliveryClaimedEvent,
    context: context as unknown as HandlerContext,
    verdict,
  });
});
```

- [ ] **Step 5: Add the `verdictDeliveryClaimedEvent` builder to `test/helpers/events.ts`** — mirror `solutionDeliveryClaimedEvent`'s shape (defaults for all fields; overridable args + `{block, txHash, logIndex, transactionIndex}`).

- [ ] **Step 6: codegen + run the tests — verify they pass.**

```bash
cd packages/indexer && yarn build && yarn test
```
Expected: PASS (all, incl. the two new verdict tests).

- [ ] **Step 7: Commit.**

```bash
git add packages/indexer/src/handlers.ts packages/indexer/src/index.ts packages/indexer/test/helpers/events.ts packages/indexer/test/handlers.test.ts
git commit -m "feat(ebu7.2): index JinnRouter.VerdictDeliveryClaimed into the verdict entity"
```

## Task A5: `handleTaskBudgetRefunded` → `task.refunded`

**Files:**
- Modify: `packages/indexer/src/handlers.ts`, `packages/indexer/src/index.ts`, `packages/indexer/test/helpers/events.ts`, `packages/indexer/test/handlers.test.ts`

- [ ] **Step 1: Write the failing test.** In `test/handlers.test.ts`: create a task (`handleTaskCreated(... taskId 7n ...)`), then `handleTaskBudgetRefunded({ event: taskBudgetRefundedEvent({ taskId: 7n }), context, task })`, assert `db.get(task, { id: '7' })?.refunded === true`. Add a second test: refund for an unknown taskId is a no-op (doesn't throw, `db.count(task)` unchanged) — mirror the `handleSolutionDeliveryClaimed` existence-guard test.

- [ ] **Step 2: Run — verify it fails.**

```bash
cd packages/indexer && yarn test test/handlers.test.ts -t "TaskBudgetRefunded"
```
Expected: FAIL — handler/builder not defined.

- [ ] **Step 3: Add type + handler to `src/handlers.ts`:**

```ts
export interface TaskBudgetRefundedEvent {
  args: {
    taskId: bigint;
    creator: `0x${string}`;
    solutionAmount: bigint;
    verdictAmount: bigint;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

// ── JinnRouter: TaskBudgetRefunded → task.refunded = true ────────────────────
// Existence guard mirrors handleSolutionDeliveryClaimed: the matching TaskCreated
// may predate startBlock; db.update on a missing row throws and crashes the
// indexer, so look up first and skip if absent.
export async function handleTaskBudgetRefunded({
  event,
  context,
  task,
}: {
  event: TaskBudgetRefundedEvent;
  context: HandlerContext;
  task: unknown;
}): Promise<void> {
  const id = event.args.taskId.toString();
  const existing = await context.db.find(task, { id });
  if (!existing) return;
  await context.db.update(task, { id }).set({ refunded: true });
}
```

- [ ] **Step 4: Register in `src/index.ts`** (after the `VerdictDeliveryClaimed` registration):

```ts
ponder.on('JinnRouter:TaskBudgetRefunded', async ({ event, context }) => {
  await handleTaskBudgetRefunded({
    event: event as unknown as TaskBudgetRefundedEvent,
    context: context as unknown as HandlerContext,
    task,
  });
});
```
Add `handleTaskBudgetRefunded, type TaskBudgetRefundedEvent` to the `./handlers.js` import.

- [ ] **Step 5: Add `taskBudgetRefundedEvent` builder to `test/helpers/events.ts`** (mirror `solutionDeliveryClaimedEvent`).

- [ ] **Step 6: codegen + test — verify pass.**

```bash
cd packages/indexer && yarn build && yarn test
```
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/indexer/src/handlers.ts packages/indexer/src/index.ts packages/indexer/test/helpers/events.ts packages/indexer/test/handlers.test.ts
git commit -m "feat(ebu7.2): wire task.refunded from JinnRouter.TaskBudgetRefunded"
```

## Task A6: Add the Sepolia-L1 chain + `JinnDistributor` contract to `ponder.config.ts`

**Files:**
- Modify: `packages/indexer/ponder.config.ts`
- Modify: `packages/indexer/deploy/.env.example`

- [ ] **Step 1: Add the chain + contract.** In `ponder.config.ts`:
  - import: `import { JINN_DISTRIBUTOR_ABI } from './abis/JinnDistributor.js';`
  - in `chains`, add:
    ```ts
    sepolia: {
      id: 11155111,
      rpc: process.env['PONDER_RPC_URL_11155111'] ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    },
    ```
  - in `contracts`, add:
    ```ts
    JinnDistributor: {
      abi: JINN_DISTRIBUTOR_ABI,
      chain: {
        sepolia: {
          address: '0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6', // Sepolia L1 — client/deployments/deployment-jinn-mvi-l1-sepolia.json
          startBlock: <DEPLOY_BLOCK or a conservative recent Sepolia block from P3>,
        },
      },
    },
    ```
  - Update the file's top comment block: add the JinnDistributor / Sepolia-L1 line (address, chain 11155111, env var `PONDER_RPC_URL_11155111`, the "JinnDistributor is on L1, not Base" note), and a one-line note that the per-channel split is reconstructed from JinnRouter activity counts, not from the `Claimed` event.
- [ ] **Step 2: Add `PONDER_RPC_URL_11155111` to `deploy/.env.example`** with a comment ("Sepolia L1 RPC — for JinnDistributor; defaults to a public endpoint, set a real RPC in production").
- [ ] **Step 3: codegen — verify it builds with the new chain/contract.**

```bash
cd packages/indexer && yarn build && yarn typecheck
```
Expected: success. (No handler for `JinnDistributor:Claimed` yet — that's Task A7; Ponder builds fine with an unhandled event source.)
- [ ] **Step 4: Commit.**

```bash
git add packages/indexer/ponder.config.ts packages/indexer/deploy/.env.example
git commit -m "feat(ebu7.2): index JinnDistributor on Sepolia L1 (new sepolia chain entry)"
```

## Task A7: `rewardDistribution` entity + `handleClaimed`

**Files:**
- Modify: `packages/indexer/ponder.schema.ts`, `packages/indexer/src/handlers.ts`, `packages/indexer/src/index.ts`, `packages/indexer/test/helpers/events.ts`, `packages/indexer/test/handlers.test.ts`

- [ ] **Step 1: Add the `rewardDistribution` table to `ponder.schema.ts`** (after `verdict`):

```ts
// ── RewardDistribution ───────────────────────────────────────────────────────

/**
 * One JINN distribution claim. From JinnDistributor.Claimed on Sepolia L1.
 * Claimed carries cumulative entitlement (totalEntitled*) and this-claim's
 * minted delta (operatorMinted / daoMinted). One row per claim event; the
 * per-channel split (wTaskCreation/wSolutionDelivery/wVerdictDelivery) is NOT
 * in the event — the explorer reconstructs it from per-operator JinnRouter
 * activity counts (TaskCreated by creator, SolutionDeliveryClaimed by operator,
 * VerdictDeliveryClaimed by evaluator).
 *
 * Primary key: (chainId, serviceId, claimedAtBlock, logIndex) — a service can
 * claim repeatedly; block+logIndex disambiguate.
 */
export const rewardDistribution = onchainTable(
  'reward_distribution',
  (t) => ({
    serviceId: t.text().notNull(),
    /** The operator multisig (Safe) that claimed — joins to attempt.operator (confirm in P3). */
    multisig: t.hex().notNull(),
    /** JINN minted to the operator on this claim (wei). */
    operatorMinted: t.bigint().notNull(),
    /** JINN minted to the DAO on this claim (wei). */
    daoMinted: t.bigint().notNull(),
    /** Cumulative operator entitlement after this claim (wei). */
    totalEntitledOperator: t.bigint().notNull(),
    /** Cumulative DAO entitlement after this claim (wei). */
    totalEntitledDao: t.bigint().notNull(),
    claimedAtBlock: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    claimedAtTx: t.hex().notNull(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.serviceId, table.claimedAtBlock, table.logIndex] }),
    serviceIdx: index().on(table.serviceId),
    multisigIdx: index().on(table.multisig),
    blockIdx: index().on(table.claimedAtBlock),
  }),
);
```

- [ ] **Step 2: Write the failing test** in `test/handlers.test.ts` (`describe('Claimed → rewardDistribution', ...)`): call `handleClaimed({ event: claimedEvent({ serviceId: 1n, multisig: '0x'+'cc'.repeat(20), operatorMinted: 1000n, daoMinted: 200n, totalEntitledOperator: 1000n, totalEntitledDao: 200n }, { block: 7_000_000n, logIndex: 3, txHash: '0x'+'dd'.repeat(32) }), context, rewardDistribution })`; assert the row exists with those values and `chainId: CHAIN_ID`. Second test: idempotent on replay.

- [ ] **Step 3: Run — verify it fails.**

```bash
cd packages/indexer && yarn test test/handlers.test.ts -t "Claimed"
```
Expected: FAIL.

- [ ] **Step 4: Add type + handler to `src/handlers.ts`:**

```ts
export interface ClaimedEvent {
  args: {
    serviceId: bigint;
    multisig: `0x${string}`;
    operatorMinted: bigint;
    daoMinted: bigint;
    totalEntitledOperator: bigint;
    totalEntitledDao: bigint;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

// ── JinnDistributor: Claimed → rewardDistribution ────────────────────────────
export async function handleClaimed({
  event,
  context,
  rewardDistribution,
}: {
  event: ClaimedEvent;
  context: HandlerContext;
  rewardDistribution: unknown;
}): Promise<void> {
  const logIndex = typeof event.log.logIndex === 'number' ? event.log.logIndex : 0;
  await context.db
    .insert(rewardDistribution)
    .values({
      serviceId: event.args.serviceId.toString(),
      multisig: event.args.multisig,
      operatorMinted: event.args.operatorMinted,
      daoMinted: event.args.daoMinted,
      totalEntitledOperator: event.args.totalEntitledOperator,
      totalEntitledDao: event.args.totalEntitledDao,
      claimedAtBlock: event.block.number,
      logIndex,
      claimedAtTx: event.transaction.hash,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}
```

- [ ] **Step 5: Register in `src/index.ts`** (add `rewardDistribution` to the `ponder:schema` import, `handleClaimed, type ClaimedEvent` to the handlers import):

```ts
ponder.on('JinnDistributor:Claimed', async ({ event, context }) => {
  await handleClaimed({
    event: event as unknown as ClaimedEvent,
    context: context as unknown as HandlerContext,
    rewardDistribution,
  });
});
```

- [ ] **Step 6: Add the `claimedEvent` builder to `test/helpers/events.ts`** (mirror the others; note `context.chain.id` in tests is `CHAIN_ID` = the Base Sepolia test constant — that's fine, the handler is chain-agnostic; the real Sepolia chainId is set by Ponder at runtime).

- [ ] **Step 7: codegen + test — verify pass.**

```bash
cd packages/indexer && yarn build && yarn test
```
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add packages/indexer/ponder.schema.ts packages/indexer/src/handlers.ts packages/indexer/src/index.ts packages/indexer/test/helpers/events.ts packages/indexer/test/handlers.test.ts
git commit -m "feat(ebu7.2): index JinnDistributor.Claimed into the rewardDistribution entity"
```

## Task A8: `manifestDigest → manifestCid` join key

**Files:**
- Modify: `packages/indexer/ponder.schema.ts` (add `cidKeccak` to `solverNetManifest`), `packages/indexer/src/handlers.ts` (compute it in `handleMetadataSet`), `packages/indexer/test/handlers.test.ts`

- [ ] **Step 1: Write the failing test.** In the existing `describe` for `MetadataSet → solverNetManifest`, add to the asserted row: `cidKeccak: keccak256(toBytes('<the test manifest cid>'))` (import `keccak256, toBytes` from `viem` in the test). The test manifest cid is whatever the existing test uses (e.g. `'bafy...'`); compute the expected keccak from it.

- [ ] **Step 2: Run — verify it fails.**

```bash
cd packages/indexer && yarn test test/handlers.test.ts -t "solverNetManifest"
```
Expected: FAIL — `cidKeccak` missing.

- [ ] **Step 3: Add the column** to `solverNetManifest` in `ponder.schema.ts` (after `id`):

```ts
    /**
     * keccak256(utf8 bytes of the manifest CID string). Equals Task.manifestDigest,
     * so per-SolverNet rollups join task.manifestDigest == solverNetManifest.cidKeccak.
     */
    cidKeccak: t.hex().notNull(),
```
and add an index on it in the table's index block: `cidKeccakIdx: index().on(table.cidKeccak),`.

- [ ] **Step 4: Populate it in `handleMetadataSet`.** At the top of `src/handlers.ts` add `import { decodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';` (extend the existing viem import). In the `manifestCid !== null` branch of `handleMetadataSet`, in both the `.values({...})` and the "incoming is newer" return object of `.onConflictDoUpdate`, add `cidKeccak: keccak256(toBytes(manifestCid)),`; in the no-op return object add `cidKeccak: row.cidKeccak,`.

- [ ] **Step 5: codegen + test — verify pass.**

```bash
cd packages/indexer && yarn build && yarn test
```
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add packages/indexer/ponder.schema.ts packages/indexer/src/handlers.ts packages/indexer/test/handlers.test.ts
git commit -m "feat(ebu7.2): add solverNetManifest.cidKeccak join key for per-SolverNet rollups"
```

## Task A9: Phase-A green gate + bd close

- [ ] **Step 1: Full check.**

```bash
cd packages/indexer && yarn typecheck && yarn test && yarn build
```
Expected: 0 type errors, all tests pass, codegen succeeds. If `ponder dev` is convenient and an RPC is reachable, optionally run it briefly to confirm the new event sources register without error (`yarn dev`, watch the startup log, Ctrl-C). Not required for the gate.

- [ ] **Step 2: Close the bead.**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.claude/worktrees/ebu7-network-explorer-design
bd close jinn-mono-ebu7.2 --reason "On-chain schema additions landed: verdict + rewardDistribution entities, task.requiredVerdicts + task.refunded, solverNetManifest.cidKeccak join key; handlers + tests; sepolia chain + JinnDistributor in ponder.config. yarn typecheck/test/build green."
git add -A && git commit -m "chore(ebu7.2): close bead" --allow-empty
```

---

# PHASE B — `ebu7.3`: `/explorer/*` aggregation routes

> Test strategy: Ponder's `db` in `ponder:api` is a Drizzle handle resolved only at runtime — not unit-testable in isolation. So: **all response-shaping and all derived metrics (resolved-rate, the rolling-rate buckets, the leaderboard ranking + min-attempts split, the freshness fields) live in pure functions in `src/api/shapers.ts` and `src/api/aggregations.ts`, unit-tested with synthetic inputs.** The route handlers in `src/api/explorer.ts` are thin: run Drizzle queries, hand the rows to the pure functions, `c.json(...)`. The route-to-DB wiring is verified by a manual `ponder dev` + curl step at the end of the phase (Task B7). If you can stand up a PGlite-backed integration test cheaply, add one; if Ponder's surface fights you, the manual check is the gate.

- [ ] **Pre: Claim the bead.**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.claude/worktrees/ebu7-network-explorer-design
bd update jinn-mono-ebu7.3 --claim && bd update jinn-mono-ebu7.3 --status in_progress
```

## Task B1: Pure metric/shaper functions

**Files:**
- Create: `packages/indexer/src/api/metrics.ts` — pure functions, no Ponder/Drizzle imports
- Create: `packages/indexer/test/metrics.test.ts`

- [ ] **Step 1: Write the failing tests first** in `test/metrics.test.ts` for each function below — synthetic inputs, asserted outputs. Then implement `src/api/metrics.ts`:

```ts
/**
 * Pure aggregation/shaping helpers for the /explorer/* routes. No Ponder,
 * Drizzle, or I/O — given already-fetched rows, compute the response shapes.
 * Unit-tested in test/metrics.test.ts. The route handlers in src/api/explorer.ts
 * do the Drizzle queries and pass results here.
 */

/** A verdict row as the routes select it. */
export interface VerdictRow { taskId: string; attemptIndex: number; verdictIndex: number; verdictCode: number; createdAtBlock: bigint; }

/** "Resolved-rate" at the verdict level: Pass verdicts / all verdicts. The primary
 *  quality metric — needs no passThreshold. Returns null when there are no verdicts. */
export function verdictResolvedRate(verdicts: Pick<VerdictRow, 'verdictCode'>[]): number | null {
  if (verdicts.length === 0) return null;
  const pass = verdicts.filter((v) => v.verdictCode === 1).length;
  return pass / verdicts.length;
}

/** Per-attempt resolved/finalized derivation. An attempt is finalized when it has
 *  >= requiredVerdicts verdicts; resolved-pass when a (strict) majority of its
 *  verdicts are Pass (documented v1 proxy for the on-chain passThreshold, which
 *  isn't emitted — see ponder.config note). requiredVerdicts === 0 ⇒ never finalized. */
export function attemptFinalization(
  verdicts: Pick<VerdictRow, 'verdictCode'>[],
  requiredVerdicts: number,
): { finalized: boolean; passed: boolean } {
  if (requiredVerdicts <= 0 || verdicts.length < requiredVerdicts) return { finalized: false, passed: false };
  const pass = verdicts.filter((v) => v.verdictCode === 1).length;
  return { finalized: true, passed: pass * 2 > verdicts.length };
}

/** Server-side time-bucketing for the learning curve. Given (blockNumber → pass?)
 *  samples and a bucket size in blocks, return an ordered series of
 *  { bucketStartBlock, total, pass, rate } — rate = pass/total, null if total 0. */
export function bucketResolvedRate(
  samples: { block: bigint; pass: boolean }[],
  bucketBlocks: bigint,
): { bucketStartBlock: string; total: number; pass: number; rate: number | null }[] {
  // implement: group by floor(block / bucketBlocks) * bucketBlocks, sort ascending,
  // compute totals; return bucketStartBlock as decimal string. Empty samples ⇒ [].
  // (Full body in the test-driven step — write the test, then this.)
  throw new Error('implement in step 3');
}

/** Rolling-window resolved-rate: for a chronologically-sorted boolean[] (pass?),
 *  return point i = mean over the last K (or fewer at the start). For the curve's
 *  "last K tasks" mode. */
export function rollingResolvedRate(passes: boolean[], k: number): number[] {
  throw new Error('implement in step 3');
}

/** Leaderboard row shape. */
export interface LeaderboardRow {
  operator: `0x${string}`;
  attempts: number;
  settledContribution: number;     // attempts on tasks that finalized
  verdictsTotal: number;
  verdictsPass: number;
  resolvedRate: number | null;     // verdictsPass / verdictsTotal
  jinnEarned: bigint;              // sum of operatorMinted for this multisig (0n if mapping unknown — see P3)
}

/** Rank quality-first (resolvedRate desc, then attempts desc, then operator asc),
 *  splitting operators with fewer than `minResolvedAttempts` resolved verdicts into
 *  a separate `lowVolume` array (kept in the same sort order, not ranked). */
export function rankLeaderboard(
  rows: LeaderboardRow[],
  minResolvedAttempts: number,
): { ranked: (LeaderboardRow & { rank: number })[]; lowVolume: LeaderboardRow[] } {
  throw new Error('implement in step 3');
}

/** Freshness block. lastIndexedBlock from Ponder /status (or MAX(block) over the
 *  indexed entities); headBlock optional; behindHead = head - lastIndexed when known. */
export function freshness(lastIndexedBlock: bigint, lastIndexedAtIso: string, headBlock?: bigint) {
  return {
    lastIndexedBlock: lastIndexedBlock.toString(),
    lastIndexedAt: lastIndexedAtIso,
    behindHead: headBlock !== undefined ? Number(headBlock - lastIndexedBlock) : null,
  };
}
```

- [ ] **Step 2: Run the tests — verify they fail** (the `throw new Error('implement...')` bodies).

```bash
cd packages/indexer && yarn test test/metrics.test.ts
```
Expected: FAIL on `bucketResolvedRate`, `rollingResolvedRate`, `rankLeaderboard`.

- [ ] **Step 3: Implement the three bodies.** (Write the actual logic — grouping for `bucketResolvedRate`; a simple sliding mean for `rollingResolvedRate`; sort + partition for `rankLeaderboard`. The tests from Step 1 pin the exact expected outputs.)

- [ ] **Step 4: Run — verify pass.**

```bash
cd packages/indexer && yarn test test/metrics.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/indexer/src/api/metrics.ts packages/indexer/test/metrics.test.ts
git commit -m "feat(ebu7.3): pure aggregation/shaper helpers for the explorer routes"
```

## Task B2: Cache + freshness Hono middleware

**Files:**
- Create: `packages/indexer/src/api/freshness.ts` — a Hono middleware factory that, given a function returning `{ lastIndexedBlock, lastIndexedAt }`, sets `ETag: W/"<block>"`, `Cache-Control: public, max-age=30, stale-while-revalidate=60`, and short-circuits 304 on `If-None-Match` match. Plus a helper `getIndexedHead(db)` that returns `MAX(createdAtBlock/publishedAtBlock/...)` across the indexed entities (or reads Ponder's `/status` — pick whichever is simplest; `MAX` over `task.createdAtBlock` and `verdict.createdAtBlock` is fine).
- Create: `packages/indexer/test/freshness.test.ts` — test the ETag/304/headers logic with a Hono test request (no DB; pass a stub `() => ({lastIndexedBlock: 123n, lastIndexedAt: '...'})`).

- [ ] **Step 1: Write the failing test** (`app.request('/x', { headers: { 'If-None-Match': 'W/"123"' } })` → 304; without it → 200 + the headers).
- [ ] **Step 2: Run — fail.** `cd packages/indexer && yarn test test/freshness.test.ts` → FAIL.
- [ ] **Step 3: Implement `src/api/freshness.ts`.**
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ebu7.3): freshness + HTTP-cache middleware for explorer routes"`

## Task B3: The `/explorer/*` route handlers

**Files:**
- Create: `packages/indexer/src/api/explorer.ts` — a Hono sub-app with the five routes, using `db` from `ponder:api` (Drizzle) + `metrics.ts` + `freshness.ts`.
- Modify: `packages/indexer/src/api/index.ts` — mount it.

- [ ] **Step 1: Write `src/api/explorer.ts`.** Structure (Drizzle query specifics: use `db.select().from(...)`, `count()`, `countDistinct()`, `sum()`, `eq()`, `inArray()`, `gte()` from `ponder` / `drizzle-orm` as Ponder re-exports them — match how the daemon's GraphQL adapter or Ponder's docs do it; the `ponder:api` `db` is a Drizzle instance over the schema tables):

```ts
import { Hono } from 'hono';
import { db } from 'ponder:api';
import { task, attempt, verdict, solverNetManifest, rewardDistribution } from 'ponder:schema';
import {
  verdictResolvedRate, attemptFinalization, bucketResolvedRate, rollingResolvedRate,
  rankLeaderboard, freshness, type LeaderboardRow,
} from './metrics.js';
import { withFreshness, getIndexedHead } from './freshness.js';

const explorer = new Hono();

// GET /explorer/network — fleet totals (one SolverNet at v1, so == per-net for SWE-rebench v2).
explorer.get('/network', withFreshness, async (c) => {
  // tasksPosted = count(task); tasksSettled = count(task where finalized); tasksRefunded = count(task where refunded);
  // attempts = count(attempt); distinctOperators = countDistinct(attempt.operator);
  // solverNetsRunning = count(solverNetManifest where status='launched');
  // verdicts = count(verdict); verdictsPass = count(verdict where verdictCode=1);
  // jinnDistributed = sum(rewardDistribution.operatorMinted) + sum(daoMinted) -- or report operator/dao separately;
  // resolvedRate = verdictsPass / verdicts.
  // ... run the queries, assemble, return c.json({ ...stats, ...freshness(head) }).
});

// GET /explorer/solvernets — one row per SolverNet: status, tasks, attempts, verdicts, resolvedRate.
//   join task.manifestDigest == solverNetManifest.cidKeccak.
explorer.get('/solvernets', withFreshness, async (c) => { /* ... */ });

// GET /explorer/solvernet/:cid — that net's KPIs + learning-curve payload.
//   ?bucket=<blocks> (default e.g. 7200 ≈ 1 day on Base) — server-bucketed resolved-rate series;
//   also a rolling-K series (?k=20|50|100) over the net's verdict stream ordered by block.
explorer.get('/solvernet/:cid', withFreshness, async (c) => { /* ... use bucketResolvedRate / rollingResolvedRate ... */ });

// GET /explorer/operators — quality-first leaderboard. ?minAttempts=<n> (default from a const, e.g. 5).
//   Per operator: attempts, settledContribution (attempts on finalized tasks), verdictsTotal/Pass,
//   resolvedRate, jinnEarned (sum operatorMinted where rewardDistribution.multisig == operator -- 0n if
//   the mapping is unconfirmed per P3; in that case omit the column and note it in the response meta).
//   Apply rankLeaderboard(rows, minAttempts) → { ranked, lowVolume }.
explorer.get('/operators', withFreshness, async (c) => { /* ... */ });

// GET /explorer/operator/:addr — one operator across SolverNets.
explorer.get('/operator/:addr', withFreshness, async (c) => { /* ... */ });

export default explorer;
```
Keep each handler thin: queries → pure-function calls → `c.json`. Put the constants (`DEFAULT_MIN_RESOLVED_ATTEMPTS = 5`, `DEFAULT_BUCKET_BLOCKS`, the active-operator window if you implement one) at the top of the file with a comment referencing spec §9 OQ-1.

- [ ] **Step 2: Mount it in `src/api/index.ts`.** Change the file to:

```ts
import { db } from 'ponder:api';
import schema from 'ponder:schema';
import { graphql } from 'ponder';
import { Hono } from 'hono';
import explorer from './explorer.js';

const app = new Hono();

app.use('/graphql', graphql({ db, schema }));
app.use('/', graphql({ db, schema }));   // ← Task C1 revisits this if the SPA needs '/'
app.route('/explorer', explorer);

export default app;
```
(Leaving GraphQL at `/` for now; Task C1 decides whether to move it.)

- [ ] **Step 3: typecheck + build.**

```bash
cd packages/indexer && yarn typecheck && yarn build
```
Expected: 0 errors. (If Drizzle query helpers aren't where you expected, check `node_modules/ponder` exports and the daemon's `client/src/discovery/http.ts` / any existing Drizzle usage for the import paths.)

- [ ] **Step 4: Commit.**

```bash
git add packages/indexer/src/api/explorer.ts packages/indexer/src/api/index.ts
git commit -m "feat(ebu7.3): /explorer/* aggregation routes on the indexer"
```

## Task B4: Manual integration check + Phase-B gate + bd close

- [ ] **Step 1: Run the indexer locally and curl the routes.**

```bash
cd packages/indexer
# Needs reachable RPCs for 84532 and 11155111; public defaults are in ponder.config.ts.
yarn dev &
# wait for "indexing complete" / the server to come up on :42069
sleep 30
curl -s localhost:42069/explorer/network | head -c 2000 ; echo
curl -s localhost:42069/explorer/solvernets | head -c 2000 ; echo
# pick a cid from /explorer/solvernets:
curl -s "localhost:42069/explorer/solvernet/<cid>?bucket=7200&k=20" | head -c 3000 ; echo
curl -s localhost:42069/explorer/operators | head -c 3000 ; echo
curl -s -I localhost:42069/explorer/network   # check Cache-Control + ETag
kill %1
```
Expected: each returns valid JSON with the documented shape + the freshness fields; `-I` shows `Cache-Control: public, max-age=30, stale-while-revalidate=60` and an `ETag`. On a fresh testnet there may be little/no data — empty/zero responses are fine, the *shapes* are what you're checking. If a route errors, fix it; if the SWE-rebench v2 SolverNet hasn't produced verdicts on testnet yet, `resolvedRate` may be `null` — that's correct behaviour.

- [ ] **Step 2: Full check.** `cd packages/indexer && yarn typecheck && yarn test && yarn build` → all green.

- [ ] **Step 3: Close the bead.**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.claude/worktrees/ebu7-network-explorer-design
bd close jinn-mono-ebu7.3 --reason "Explorer read surfaces: pure metrics/shapers (unit-tested) + /explorer/{network,solvernets,solvernet/:cid,operators,operator/:addr} Hono routes mounted alongside GraphQL, with freshness fields + Cache-Control/ETag. Auto GraphQL confirmed to cover entity queries. Manual ponder-dev curl check done. Mode-aware dims (train/frozen, harness, checkpoints) follow in ebu7.6."
git add -A && git commit -m "chore(ebu7.3): close bead" --allow-empty
```

---

# PHASE C — `ebu7.5`: serve the SPA shell

## Task C1: Static serving at `/`

**Files:**
- Create: `packages/indexer/public/index.html` — a placeholder SPA shell (the real explorer SPA is `ebu7.4`); a single page that says "Jinn network explorer — coming soon" styled minimally per `DESIGN.md` tokens (night-blue bg, mono type), and fetches `/explorer/network` and dumps the JSON in a `<pre>` so the deploy is verifiably wired. Keep it tiny — it's a stand-in.
- Modify: `packages/indexer/src/api/index.ts` — add static serving.
- Modify: `packages/indexer/package.json` — add the static-serving dep if needed.

- [ ] **Step 1: Decide where GraphQL lives.** Using the P3 finding (does `client/src/discovery/http.ts` hit `<url>/graphql` or `<url>/`?):
  - **If `/graphql`:** safe to take `/` for the SPA. In `src/api/index.ts`, remove `app.use('/', graphql(...))`, keep `app.use('/graphql', graphql(...))`, keep `app.route('/explorer', explorer)`, and add static serving + SPA fallback at the end (so `/`, `/operators`, `/solvernet/...` all serve `index.html` for client-side routing; `/graphql`, `/explorer/*`, `/health`, `/ready`, `/status` are matched first).
  - **If `/`:** keep GraphQL at `/` AND `/graphql`; serve the SPA at `/explorer-ui/*` (a subpath) instead, and note in the deploy README that the canonical explorer URL is `<indexer>/explorer-ui/`. (Less clean; only if the daemon contract forces it. File a follow-up bd to move the daemon to `/graphql` and then relocate the SPA to `/`.)

- [ ] **Step 2: Add static serving.** For Ponder-on-Node, use `@hono/node-server`'s `serveStatic` (add `"@hono/node-server": "^1.0.0"` to `package.json` deps if not already present — check first). In `src/api/index.ts`:

```ts
import { serveStatic } from '@hono/node-server/serve-static';
// ...after the graphql + explorer mounts:
app.use('/*', serveStatic({ root: './public' }));
app.get('*', serveStatic({ path: './public/index.html' }));   // SPA fallback for client-side routes
```
(Adjust to whichever `serveStatic` import the installed Hono/node-server version exposes; the daemon SPA serving in `client/src/dashboard/` is a reference for how this team serves a built SPA.)

- [ ] **Step 3: typecheck + build.** `cd packages/indexer && yarn typecheck && yarn build` → green.

- [ ] **Step 4: Manual check.** `yarn dev`, then `curl -s localhost:42069/ | head -c 500` → the placeholder HTML; open it in a browser → the `<pre>` shows the `/explorer/network` JSON. `curl -s localhost:42069/graphql ...` (a trivial query, or just `-I`) → still works. Ctrl-C.

- [ ] **Step 5: Commit.**

```bash
git add packages/indexer/public/index.html packages/indexer/src/api/index.ts packages/indexer/package.json packages/indexer/yarn.lock
git commit -m "feat(ebu7.5): indexer serves the explorer SPA shell at / + the /explorer routes"
```

## Task C2: Deploy-doc update

**Files:**
- Modify: `packages/indexer/deploy/README.md`
- Modify: `packages/indexer/README.md` (the top-level package readme — add a short "Explorer" section)

- [ ] **Step 1: Update `deploy/README.md`** — add an "Explorer" section: the indexer now also serves the public network explorer (static SPA at `/`, JSON aggregation routes at `/explorer/*`) alongside the GraphQL API; the SPA bundle lives in `packages/indexer/public/` (built by `ebu7.4` — for now a placeholder); the canonical explorer URL is `<indexer-host>/`; anyone running `@jinn-network/indexer` serves an explorer for free (link `docs/superpowers/specs/2026-05-12-network-explorer-design.md` §3); the new `PONDER_RPC_URL_11155111` env var is required for the JinnDistributor/Sepolia-L1 source (mention it can use a public default but set a real RPC in production); CDN-fronting is recommended (the routes set `Cache-Control` + `ETag`); the bundle is immutable-hashed and long-cacheable.

- [ ] **Step 2: Update `packages/indexer/README.md`** — one short paragraph: "This package also serves the Jinn network explorer (`/` = SPA, `/explorer/*` = aggregation JSON) — see `docs/superpowers/specs/2026-05-12-network-explorer-design.md` and `deploy/README.md`."

- [ ] **Step 3: Commit.**

```bash
git add packages/indexer/deploy/README.md packages/indexer/README.md
git commit -m "docs(ebu7.5): document the explorer in the indexer deploy/readme"
```

## Task C3: Phase-C gate + bd close + push

- [ ] **Step 1: Full check.** `cd packages/indexer && yarn typecheck && yarn test && yarn build` → all green. `yarn dev` smoke: `/`, `/explorer/network`, `/graphql` all respond; Ctrl-C.

- [ ] **Step 2: Close the bead.**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.claude/worktrees/ebu7-network-explorer-design
bd close jinn-mono-ebu7.5 --reason "Indexer serves the explorer SPA shell at / (placeholder until ebu7.4) + the /explorer routes; deploy/README + package README updated; GraphQL endpoint preserved at /graphql (and / if the daemon contract requires it). yarn typecheck/test/build green."
```

- [ ] **Step 3: Push + open/update the PR.**

```bash
git push
# PR #181 already exists for this branch — append a comment summarising the indexer-side implementation,
# or if you prefer a separate PR, open one off this branch's new commits. Per the handbook: no agent self-merge;
# the PR gets agent-review parity. End the PR/comment body with the Claude Code footer.
```

- [ ] **Step 4: Hand off.** Note for the next session: `ebu7.6` (IPFS envelope-enrichment — `AttemptEnvelopeMeta` + `HarnessRollup`/`FreezeViolation`/`LanguageRollup` + `HarnessCheckpoint` anchors; extends the `/explorer/*` routes with mode/harness/plugin/model/language facets + checkpoint timeline + freeze integrity) is the next plan, also indexer-side, and is on the rdod critical path. Then `ebu7.4` (the actual explorer SPA) replaces the `public/index.html` placeholder. `ebu7.7` (multi-net pages) follows `ebu7.4`.

---

## Self-review notes (filled in by the plan author)

- **Spec coverage:** §3 (read path = GraphQL + `/explorer/*`; freshness contract; cursor pagination — *note:* this plan's leaderboard routes return bounded result sets; explicit Relay cursor pagination on long lists is deferred to when a list actually overflows, flagged here as a known follow-up; HTTP caching = Task B2; static serving = Phase C) — covered. §4.1 (all five on-chain additions: `verdict`, `rewardDistribution`, `task.requiredVerdicts`, `task.refunded`, `solverNetManifest.cidKeccak`) — covered (Tasks A2–A8). §5 (resolved-rate from `Verdict`; learning curve = `bucketResolvedRate`/`rollingResolvedRate`; mode-aware bits explicitly out of scope → `ebu7.6`) — covered. §6 (quality-first leaderboard + min-attempts floor + low-volume split = `rankLeaderboard`; on-chain facets = time-window + SolverType) — covered; envelope-sourced facets correctly deferred. §10 (`ebu7.2`+`ebu7.3`+`ebu7.5` scope) — matches. **Gap acknowledged:** explicit cursor pagination (deferred — see above); the `operator↔multisig` mapping for `jinnEarned` (P3 lookup with a documented fallback).
- **Placeholder scan:** the `throw new Error('implement in step 3')` bodies in Task B1 are intentional TDD scaffolding (the test in the prior step pins the behaviour); Drizzle query bodies in `src/api/explorer.ts` are described by exact column math + the pure-function calls rather than full query syntax, because the precise Drizzle import paths/helpers must be confirmed against the installed Ponder version (Task B3 Step 3 says so) — these are concrete instructions, not vague TODOs.
- **Type consistency:** `verdict` columns `(taskId, attemptIndex, verdictIndex, verdictCode, evaluator, requestId, createdAtBlock, chainId)` are used consistently across the schema (A3), the handler (A4), and `metrics.ts`'s `VerdictRow` (B1). `rewardDistribution` columns consistent across A7 and `LeaderboardRow.jinnEarned`. `cidKeccak` (A8) is the join key referenced by the `/explorer/solvernets` and `/explorer/solvernet/:cid` routes (B3).
