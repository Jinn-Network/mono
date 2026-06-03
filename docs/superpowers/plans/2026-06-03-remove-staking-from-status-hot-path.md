# Remove OLAS Staking from the `/v1/status` Hot Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete OLAS staking substrate RPC reads from the operator `/v1/status` hot path (and the shared CLI gather it feeds), keeping `jinn rewards` working via an on-demand call to the extracted `sumPendingStakingRewards`.

**Architecture:** `/v1/status` and the introspection CLIs share one inner gatherer, `gatherGatheredStatusRaw`. Two adjacent staking blocks inside it (pending-rewards sum + per-service eviction/inactivity fan-out) run on every poll. This refactor *deletes* the eviction/inactivity machinery outright (zero operator-facing consumers) and *removes* the pending-rewards call from the shared gatherer, re-homing it to the `jinn rewards` command which calls the now-`export`ed `sumPendingStakingRewards` on demand and splices the result onto `raw` before `assembleRewardsV1`. Staking fields leave the `/v1/status`, `jinn fleet`, and `jinn status` response shapes (types + population). The independent eviction-loop control path is untouched.

**Tech Stack:** TypeScript, viem, Vitest (unit + SPA via jsdom), Playwright (dashboard e2e). Client-only — no indexer or contract changes.

---

## Background — why this is a deletion, not a migration

OLAS staking is *substrate*. Operators earn JINN without staking and never see staking. The fix is to stop reading staking on the hot path. The audited facts that shape this plan (all verified in the worktree at `origin/next`):

- The shared inner gatherer is `gatherGatheredStatusRaw` (`client/src/api/gather-status.ts:1029`). It is called by:
  - `gatherStatusForApi` (`client/src/api/gather-status.ts:1374`) → the `/v1/status` HTTP route (`assembleStatusV1`).
  - `gatherIntrospectionRaw` (`client/src/cli/introspection-context.ts:47`) → the three introspection CLIs:
    - `jinn rewards` → `assembleRewardsV1` (`client/src/cli/commands/rewards.ts:92-93`) — **the ops-only surface we must keep working.**
    - `jinn status` → `assembleStatusRollupV1` (`client/src/cli/commands/status.ts:140-141`).
    - `jinn fleet` → `assembleFleetV1` (`client/src/cli/commands/fleet.ts:60`).
- The two staking blocks live under `if (fleet && raw.rpc.ok)` at `client/src/api/gather-status.ts:1255-1343`:
  1. `sumPendingStakingRewards(...)` (defined `:670`) → populates `raw.pendingStakingRewardsWei`, `raw.pendingByService`, `raw.nextCheckpointAt`, or `raw.pendingRewardsError`.
  2. Per-service `getStakingState` + `getServiceInfo` fan-out (`:1266-1342`) → populates `raw.evictedByServiceIndex`, `raw.inactivityByServiceIndex`, `raw.evictedSinceByServiceIndex`, feeding the module-scoped `evictionFirstSeenMs` tracker (`:218`) and its test reset (`:221`).
- The independent eviction *control* loop, `client/src/daemon/eviction-loop.ts`, does its own `getStakingState` reads via an injected `readContract` and `STAKING_ABI` (`:13`, `:79-84`). It never calls gather-status — untouched naturally.

**Consumer audit (verified):**

| Field / symbol | Verdict | Evidence |
|---|---|---|
| `evictedByServiceIndex`, `evictedSinceByServiceIndex`, `inactivityByServiceIndex` | DELETE outright | Only consumers are `fleet-build.ts` (`staking.evicted`/`inactivitySeconds`), `status-build.ts` (`fleet.services[].evicted`/`.evictedSince`), and test/SPA fixtures. No SPA runtime reads them (`rg evicted client/src/dashboard/spa/src -g '!*.test.*'` → empty). `computeAttention` never reads them; its `'evicted'` `AttentionKind` member is dead. |
| `evictionFirstSeenMs`, `__resetEvictionFirstSeenForTests` | DELETE outright | Only referenced inside the eviction/inactivity block and its tests. |
| `pendingStakingRewardsWei`, `pendingByService`, `nextCheckpointAt`, `pendingRewardsError` | SURVIVE on the on-demand CLI path | `assembleRewardsV1` needs `pendingStakingRewardsWei`, `pendingByService`, `nextCheckpointAt`. Stay as OPTIONAL fields on `GatheredStatusRaw`; `jinn rewards` populates them on demand. |
| `/v1/status .rewards.pendingStakingRewardsWei` / `.totalStakingRewardsWei` / `.pendingRewardsError` | REMOVE from response | Per acceptance criterion 2. Keep `claimLoopIntervalMs`, `lastClaimTickAt`, `claimedStakingRewardsWei`. |
| `/v1/status .fleet.services[].evicted` / `.evictedSince` | REMOVE from response | Per acceptance criterion 2. |
| `status-rollup-build.ts .earnings.pendingTotal` (rendered by `jinn status`) | REMOVE | Stage 1 directive. `jinn status` is a general-purpose ops command, not the sanctioned staking surface; staking-collector data belongs to `jinn rewards` only. |
| `fleet-build.ts .staking.evicted` / `.inactivitySeconds` / `.rewards.pending` (rendered by `jinn fleet`) | REMOVE | Stage 1 directive. `jinn fleet`'s human renderer only reads `s.staking.staked` (`fleet.ts:24`), not these. |

**Design decision — where the on-demand splice lives.** The Stage 1 note recommends wiring the splice into `client/src/cli/commands/rewards.ts` only. This plan follows that: only `jinn rewards` re-acquires the pending data. `jinn fleet` and `jinn status` *lose* their staking fields entirely (per the directives above), so they have nothing to re-acquire. This keeps the change minimal and matches the issue's "keep `jinn rewards` as the on-demand ops-only surface" framing.

---

## File Structure

**Production source (modified):**
- `client/src/api/gather-status.ts` — `export` `sumPendingStakingRewards`; delete its call from the gatherer; delete the whole eviction/inactivity block + `evictionFirstSeenMs` + `__resetEvictionFirstSeenForTests`. Drop now-unused imports if any become dead.
- `client/src/api/status-build.ts` — drop `evicted*`/`inactivity*` fields from `GatheredStatusRaw` (keep `pendingStakingRewardsWei`/`pendingRewardsError`/`nextCheckpointAt`/`pendingByService` as optional); drop `fleet.services[].evicted`/`.evictedSince` and `rewards.pendingStakingRewardsWei`/`.totalStakingRewardsWei`/`.pendingRewardsError` from `StatusV1Response`; strip the dead helper params/branches.
- `client/src/api/fleet-build.ts` — drop `FleetV1Service.staking.evicted`/`.inactivitySeconds` and `.rewards.pending`; remove the dead `'evicted'` `AttentionKind` member.
- `client/src/api/status-rollup-build.ts` — drop `earnings.pendingTotal`.
- `client/src/cli/commands/rewards.ts` — add `sumPendingStakingRewards` as a third injected `RewardsDeps` member; after `gatherIntrospectionRaw`, call it and splice `pendingStakingRewardsWei`/`pendingByService`/`nextCheckpointAt`/`pendingRewardsError` onto `raw` before `assembleRewardsV1`.
- `client/src/cli/commands/status.ts` — drop the `staking-collector-pending` human line that reads `v.earnings.pendingTotal`.

**Production source UNCHANGED (confirm only):**
- `client/src/api/rewards-build.ts` — `RewardsV1Response` + `assembleRewardsV1` read the spliced raw fields; no change.
- `client/src/cli/introspection-context.ts` — `tryMergeStatusFromHttp` merges only `shutdownState`/`daemonStartedAt`/`rpc`; never carried staking; no change.
- `client/src/daemon/eviction-loop.ts` — independent control path; no change.

**Tests (modified / deleted / added):**
- `client/test/api/gather-status.test.ts` — delete the eviction-window suite + `pendingStakingRewardsWei` assertions; rework the autoRestake suite off the deleted helpers; ADD the regression test for criterion 1.
- `client/test/api/status-build.test.ts` — delete evicted/total/pending cases.
- `client/test/api/fleet-build.test.ts` — delete staking.evicted/inactivitySeconds cases.
- `client/test/api/status-rollup-build.test.ts` — delete the `earnings.pendingTotal` assertion.
- `client/test/cli/commands/status.test.ts` — delete the `earnings.pendingTotal` assertion (and `earnings` from the type cast).
- `client/test/cli/commands/rewards.test.ts` — KEEP + ADD the extractor-splice seam test.
- `client/test/api/rewards-build.test.ts` — KEEP (verify it still passes).
- `client/test/dashboard/eviction-banner-window.e2e.test.ts` — see Task 12 (repurpose vs delete decision).
- `client/src/dashboard/spa/src/pages/Overview.test.tsx`, `client/src/dashboard/spa/src/notifications/useNotifications.test.tsx` — drop stale `rewards.pendingStakingRewardsWei` fixture fields.

---

## TDD ordering for a deletion refactor

This is mostly *deletion*, so TDD is inverted from the usual "red → green" loop. The discipline here is:

1. **Front-load the proof of criterion 1** (Task 1): write a NEW failing-then-passing test asserting `/v1/status` triggers zero staking RPC reads. It fails today (the reads happen), passes after Task 3.
2. **Add the on-demand `jinn rewards` proof** (Task 2): a NEW test asserting the extractor is invoked and its output renders. It fails today (no `sumPendingStakingRewards` in `RewardsDeps`), passes after Task 6.
3. **Then delete production code** (Tasks 3-9), running the suite after each to watch the obsolete tests turn red.
4. **Then delete/rework the obsolete tests** (Tasks 10-13), turning the suite green again.
5. **Verify** (Task 14).

Run tests after every task. Commit after every task.

---

### Task 1: Regression test — `/v1/status` triggers no staking RPC reads (criterion 1)

This is the load-bearing proof. Mock viem so the staking read functions *throw if called*, and assert `gatherStatusForApi` still returns a full status. Today this test FAILS (the reads happen and throw). After Task 3 it PASSES.

**Files:**
- Test: `client/test/api/gather-status.test.ts` (add a new top-level `describe` block, e.g. after the existing `describe('gatherStatusForApi', ...)` block which ends at line ~795)

- [ ] **Step 1: Write the failing test**

Add this block. The spy throws on any staking-read function name; the assertion is that none were called and status assembled successfully. (`getBlockNumber`/`getChainId`/`getBalance`/`multicall`/`getLogs` are stubbed benignly so the rest of the gather works.)

```ts
describe('gatherStatusForApi — no staking reads on the hot path (#992)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('viem');
    vi.resetModules();
  });

  it('never calls calculateStakingReward / getStakingState / getServiceInfo / getNextRewardCheckpointTimestamp', async () => {
    const stakingFns = new Set([
      'calculateStakingReward',
      'getStakingState',
      'getServiceInfo',
      'getNextRewardCheckpointTimestamp',
    ]);
    const calledStakingFns: string[] = [];
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return {
        ...actual,
        createPublicClient: ({ chain }: { chain: { id: number } }) => ({
          getBlockNumber: async () => 123n,
          getChainId: async () => chain.id,
          getBalance: async () => 0n,
          multicall: async (req: { contracts: ReadonlyArray<{ functionName: string }> }) =>
            req.contracts.map((c) => {
              if (stakingFns.has(c.functionName)) calledStakingFns.push(c.functionName);
              return { status: 'success' as const, result: 0n };
            }),
          readContract: async (req: { functionName: string }) => {
            if (stakingFns.has(req.functionName)) {
              calledStakingFns.push(req.functionName);
              throw new Error(`staking read ${req.functionName} must not run on the hot path`);
            }
            return 0n;
          },
          getLogs: async () => [],
        }),
        http: () => ({}),
      };
    });

    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const earningDir = mkdtempSync(join(tmpdir(), 'jinn-no-staking-test-'));
      const fleetStore = new FleetStateStore(earningDir);
      const state = await fleetStore.load('base-sepolia');
      await fleetStore.save({
        ...state,
        master_address: '0x1111111111111111111111111111111111111111',
        services: [
          {
            index: 1,
            agent_address: '0x2222222222222222222222222222222222222222',
            safe_address: '0x3333333333333333333333333333333333333333',
            service_id: 41,
            mech_address: null,
            staking_address: '0x5555555555555555555555555555555555555555',
            step: 'complete',
            error: null,
          },
        ],
      });

      const apiStatus = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });

      expect(calledStakingFns).toEqual([]);
      expect(apiStatus.statusMode).toBe('full');
      expect(apiStatus.fleet.services).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts -t "no staking reads"`
Expected: FAIL — the gatherer currently calls `calculateStakingReward` (and the per-service `getStakingState`/`getServiceInfo`), so `calledStakingFns` is non-empty / the `readContract` throw surfaces.

- [ ] **Step 3: Commit (red test only — implementation lands in Task 3)**

```bash
git add client/test/api/gather-status.test.ts
git commit -m "test(api): prove /v1/status hot path must do no staking reads (#992)"
```

---

### Task 2: Failing test — `jinn rewards` invokes the on-demand extractor (criterion 3)

Prove the new seam: `createRewardsCommand` accepts a `sumPendingStakingRewards` dep, calls it, and the rendered output reflects the spliced pending value. The mock `gatherIntrospectionRaw` returns a `raw` WITHOUT `pendingStakingRewardsWei` (mirroring the post-refactor hot path), so the value can only appear if the extractor ran.

**Files:**
- Test: `client/test/cli/commands/rewards.test.ts`

- [ ] **Step 1: Update the existing mock + deps, and add a new seam test**

Edit the top of the file: remove `pendingStakingRewardsWei: '1000'` from `mockRaw` (the hot path no longer sets it) and inject a fake extractor in `fakeDeps`.

Replace the `mockRaw` literal's last field and the `fakeDeps` object:

```ts
const mockRaw: GatheredStatusRaw = {
  shutdownState: null,
  dbPath: '/tmp/x',
  activityCounts: {},
  recentActivity: [],
  lastRewardClaimTickAt: '2026-04-14T11:00:00.000Z',
  rewardClaimIntervalMs: 1,
  fleet: {
    master_address: null,
    chain: 'base-sepolia',
    staking_mode: 'standard',
    updated_at: '2026-04-14T12:00:00.000Z',
    services: [
      {
        index: 1,
        agent_address: '0xA',
        safe_address: null,
        service_id: 42,
        mech_address: null,
        staking_address: '0x5555555555555555555555555555555555555555',
        step: 'complete',
        error: null,
      },
    ],
  },
  rpc: { ok: true },
  master: { address: null },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '0',
};

const fakeDeps = {
  gatherIntrospectionRaw: async () => ({ ...mockRaw }) as GatheredStatusRaw,
  assembleRewardsV1,
  sumPendingStakingRewards: async () => ({
    sum: '1000',
    pendingByService: { 0: '1000' },
    nextCheckpointAt: '2026-04-15T00:00:00.000Z',
  }),
};
```

Then add a new test asserting the extractor's output is spliced through to the rendered payload:

```ts
it('invokes the on-demand staking extractor and renders its pending value (#992)', async () => {
  let extractorCalls = 0;
  const cmd = createRewardsCommand({
    gatherIntrospectionRaw: async () => ({ ...mockRaw }) as GatheredStatusRaw,
    assembleRewardsV1,
    sumPendingStakingRewards: async () => {
      extractorCalls += 1;
      return { sum: '1000', pendingByService: { 0: '1000' }, nextCheckpointAt: '2026-04-15T00:00:00.000Z' };
    },
  });
  const { envelopes, exits } = await runCommand(cmd);
  expect(exits).toEqual([]);
  expect(extractorCalls).toBe(1);
  const parsed = envelopes[0] as { services: Array<{ pending: string }>; nextCheckpointAt: string };
  expect(parsed.services[0].pending).toBe('1000');
  expect(parsed.nextCheckpointAt).toBe('2026-04-15T00:00:00.000Z');
});

it('renders pending=0 and a null checkpoint when the extractor errors (#992)', async () => {
  const cmd = createRewardsCommand({
    gatherIntrospectionRaw: async () => ({ ...mockRaw }) as GatheredStatusRaw,
    assembleRewardsV1,
    sumPendingStakingRewards: async () => ({ error: 'rpc down' }),
  });
  const { envelopes, exits } = await runCommand(cmd);
  expect(exits).toEqual([]);
  const parsed = envelopes[0] as { services: Array<{ pending: string }>; nextCheckpointAt: string | null };
  expect(parsed.services[0].pending).toBe('0');
  expect(parsed.nextCheckpointAt).toBeNull();
});
```

The existing first test (`emits a rewards response with lastClaimAt and service entries`) still asserts `parsed.services[0].pending === '1000'`; with the updated `fakeDeps` extractor returning `sum: '1000'`, it stays green.

- [ ] **Step 2: Run test to verify it fails to compile / fails**

Run: `cd client && yarn vitest run test/cli/commands/rewards.test.ts`
Expected: FAIL — `createRewardsCommand` does not yet accept a `sumPendingStakingRewards` dep (type error) and does not splice, so `pending`/`nextCheckpointAt` come back `'0'`/`null`.

- [ ] **Step 3: Commit (red test only — implementation lands in Task 6)**

```bash
git add client/test/cli/commands/rewards.test.ts
git commit -m "test(cli): prove jinn rewards uses on-demand staking extractor (#992)"
```

---

### Task 3: Export `sumPendingStakingRewards`; delete its hot-path call + the eviction/inactivity block (criterion 1)

**Files:**
- Modify: `client/src/api/gather-status.ts:670` (add `export`), `:1255-1343` (delete the staking blocks), `:218`/`:221` (delete tracker + reset).

- [ ] **Step 1: Export the extractor**

Change the declaration at `gather-status.ts:670`:

```ts
export async function sumPendingStakingRewards(
  rpcUrl: string,
  network: 'mainnet' | 'testnet',
  fleet: FleetState,
): Promise<{ sum: string; pendingByService: Record<number, string>; nextCheckpointAt?: string } | { error: string }> {
```

(Body unchanged.)

- [ ] **Step 2: Delete the two staking blocks from the gatherer**

Delete the ENTIRE `if (fleet && raw.rpc.ok) { ... }` block at `gather-status.ts:1255-1343` — both the `sumPendingStakingRewards` call (`:1256-1263`) and the eviction/inactivity `try { ... } catch { ... }` (`:1265-1342`). Remove the whole block; do NOT leave an empty `if`.

The surrounding code to preserve: the block immediately before it ends at `:1253` (the `if (fleet?.master_address) { ... }` master-balance read), and the block immediately after is `if (fleet) { ... perServiceActivity ... }` at `:1345`. After deletion, `:1253`'s closing brace is directly followed by the `if (fleet) {` at the old `:1345`.

- [ ] **Step 3: Delete the eviction first-seen tracker + its test reset**

Delete `gather-status.ts:205-223` — the `evictionFirstSeenMs` doc comment + `const evictionFirstSeenMs = new Map<string, number>();` (`:218`) + `export function __resetEvictionFirstSeenForTests(): void { evictionFirstSeenMs.clear(); }` (`:220-223`).

- [ ] **Step 4: Remove now-dead imports if any**

After deletion, check whether `JINN_STAKING_ABI` (imported at `:26`) is still referenced. It IS still used by `sumPendingStakingRewards` (`:693`, `:708`) — KEEP the import. `listStolasClaimTargets` (`:42`) is still used by `sumPendingStakingRewards` (`:675`) — KEEP. `displayFleetServiceIndex` (`:28`) is still used widely — KEEP. **Confirm-while-coding:** run `cd client && yarn typecheck` after this task; if any import is now unused, the `noUnusedLocals`/lint pass will flag it — remove only what is flagged.

- [ ] **Step 5: Run the criterion-1 test to verify it now passes**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts -t "no staking reads"`
Expected: PASS — `calledStakingFns` is empty.

- [ ] **Step 6: Run the full gather-status suite (expect known reds in the obsolete suites)**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts`
Expected: the new test PASSES; the eviction-window suite + the `pendingStakingRewardsWei` assertion (`:186`) + the autoRestake suite FAIL (they reference deleted symbols / removed fields). These are cleaned up in Task 10. Note which fail; do not fix here.

- [ ] **Step 7: Commit**

```bash
git add client/src/api/gather-status.ts
git commit -m "refactor(api): remove staking reads from the status hot path (#992)"
```

---

### Task 4: Remove staking fields from `StatusV1Response` + strip the dead `status-build.ts` helpers (criterion 2)

**Files:**
- Modify: `client/src/api/status-build.ts` — `StatusV1Response` (`:246-252`, `:269-276`); `fleetSummary` (`:337-384`); `buildEarningsHint` (`:466-481`); `assembleStatusV1` (`:573-622`); `GatheredStatusRaw` (`:182-210`).

- [ ] **Step 1: Drop `evicted`/`evictedSince` from `StatusV1Response.fleet.services[]`**

In the `services: Array<{ ... }>` shape (`:235-253`), delete the `evicted: boolean;` and `evictedSince: string | null;` members (`:246-252`) including their doc comments. The members above (`identityBindingStatus`) and below (`stakedLikeCount`) stay.

- [ ] **Step 2: Drop staking reward fields from `StatusV1Response.rewards`**

In the `rewards: { ... }` block (`:269-276`), delete `pendingStakingRewardsWei?: string;` (`:272`), `totalStakingRewardsWei?: string;` (`:274`), and `pendingRewardsError?: string;` (`:275`). KEEP `claimLoopIntervalMs`, `lastClaimTickAt`, `claimedStakingRewardsWei`. Result:

```ts
  rewards: {
    claimLoopIntervalMs: number;
    lastClaimTickAt: string | null;
    claimedStakingRewardsWei: string;
  };
```

- [ ] **Step 3: Strip the `fleetSummary` evicted params + per-service fields**

Change the signature (`:337-341`) to drop the two evicted params:

```ts
function fleetSummary(
  fleet: FleetState | null,
): StatusV1Response['fleet'] {
```

In the `services` map (`:350-372`), delete the `evicted:` and `evictedSince:` lines (`:369-370`). Update the one call site in `assembleStatusV1` (`:574`) from `fleetSummary(raw.fleet, raw.evictedByServiceIndex, raw.evictedSinceByServiceIndex)` to `fleetSummary(raw.fleet)`.

- [ ] **Step 4: Strip the staking branches from `buildEarningsHint`**

Delete the `pendingRewardsError` branch (`:470-472`) and the `pendingStakingRewardsWei` branch (`:473-476`). The function then falls through to the fleet-loaded / not-loaded hint. Result:

```ts
function buildEarningsHint(raw: GatheredStatusRaw, fleetSum: StatusV1Response['fleet']): string {
  if (raw.hintsScope === 'sqlite_only') {
    return 'Fleet and on-chain earnings hints omitted in API-only mode.';
  }
  if (!fleetSum.loaded || fleetSum.services.length === 0) {
    return 'No fleet services in local state — earnings accrue after staking completes.';
  }
  return 'On-chain staking reward queue is reported by `jinn rewards`, not /v1/status.';
}
```

(The final return string changes from the now-misleading "no RPC / no staking proxies" copy to point operators at `jinn rewards`. This keeps the earnings hint truthful after staking leaves the hot path.)

- [ ] **Step 5: Strip the pending/total reward computation from `assembleStatusV1`**

Delete the `pendingRewardsWei` computation (`:577-584`). In the returned `rewards` object (`:612-622`), delete `pendingStakingRewardsWei`, `totalStakingRewardsWei`, and `pendingRewardsError`. Result:

```ts
    rewards: {
      claimLoopIntervalMs: raw.rewardClaimIntervalMs,
      lastClaimTickAt: raw.lastRewardClaimTickAt,
      claimedStakingRewardsWei: claimedRewardsWei.toString(),
    },
```

(`sumClaimedRewardsWei` and `claimedRewardsWei` stay — `claimedStakingRewardsWei` is retained.)

- [ ] **Step 6: Remove the unconditional eviction/inactivity fields from `GatheredStatusRaw`; keep the pending fields**

In `GatheredStatusRaw` (`status-build.ts:105-219`):
- DELETE `evictedByServiceIndex?: ...` (`:182-187` incl. comment), `inactivityByServiceIndex?: ...` (`:188-193` incl. comment), `evictedSinceByServiceIndex?: ...` (`:203-210` incl. comment).
- KEEP `pendingStakingRewardsWei?: string;` (`:138`), `pendingRewardsError?: string;` (`:139`), `nextCheckpointAt?: string;` (`:160-161`), `pendingByService?: Record<number, string>;` (`:179`) — these are the optional fields `jinn rewards` splices on. Update their doc comments to note they are populated on-demand by `jinn rewards`, not the hot path (e.g. above `pendingStakingRewardsWei`, write: `/** On-demand staking reward queue total; populated only by \`jinn rewards\`, never on the /v1/status hot path (#992). */`).
- KEEP `autoRestakeEnabled?` (`:211-216`) and `evictionCheckIntervalMs?` (`:217-218`) — observability for the eviction loop, set in the gatherer outside the deleted block (`gather-status.ts:1209-1213`).

- [ ] **Step 7: Run typecheck + the status-build suite (expect known reds)**

Run: `cd client && yarn typecheck`
Expected: PASS for `status-build.ts` itself; the test files still reference removed fields — that surfaces as test-file type errors, which are resolved in Tasks 10-13. If `yarn typecheck` includes test files and blocks, proceed to the test-cleanup tasks before re-running; otherwise run `yarn vitest run test/api/status-build.test.ts` and note the expected reds (the evicted-fields suite + the total/pending cases).

- [ ] **Step 8: Commit**

```bash
git add client/src/api/status-build.ts
git commit -m "refactor(api): drop staking fields from /v1/status shape (#992)"
```

---

### Task 5: Remove staking fields from `fleet-build.ts` and `status-rollup-build.ts` (criterion 2)

**Files:**
- Modify: `client/src/api/fleet-build.ts:12-19` (AttentionKind), `:29` (staking), `:31` + `:140-143` (rewards.pending).
- Modify: `client/src/api/status-rollup-build.ts:28` (type), `:329-332` (population).

- [ ] **Step 1: Drop `staking.evicted` + `staking.inactivitySeconds` from `FleetV1Service`**

Change `fleet-build.ts:29` from:

```ts
  staking: { staked: boolean; evicted: boolean; sinceBlock: number | null; inactivitySeconds: number | null };
```

to:

```ts
  staking: { staked: boolean; sinceBlock: number | null };
```

- [ ] **Step 2: Drop the `rewards.pending` field from `FleetV1Service`**

Delete `rewards: { pending: string; asset: 'reward' };` (`:31`) entirely. (`jinn fleet`'s human renderer does not read it — `fleet.ts:24` reads only `s.staking.staked`.)

- [ ] **Step 3: Remove the dead `'evicted'` AttentionKind member**

Change `fleet-build.ts:12-19` to drop `| 'evicted'`:

```ts
type AttentionKind =
  | 'none'
  | 'low_gas'
  | 'identity_binding_pending'
  | 'stake_missing'
  | 'bond_insufficient'
  | 'reconcile_needed';
```

- [ ] **Step 4: Update `assembleFleetV1` population**

In the per-service map (`:130-143`):
- Change the `staking` object to drop `evicted`/`inactivitySeconds`:

```ts
    staking: {
      staked: isStakedLikeServiceStep(svc.step),
      sinceBlock: null,
    },
```

- Delete the `rewards: { pending: pendingByService[di] ?? '0', asset: 'reward' as const },` object (`:140-143`).
- Delete the now-unused `const pendingByService = raw.pendingByService ?? {};` (`:108`). **Confirm-while-coding:** verify `pendingByService` has no other reference in this file after the delete (it does not).

- [ ] **Step 5: Drop `earnings.pendingTotal` from `StatusRollupV1Response`**

Change `status-rollup-build.ts:28` from:

```ts
  earnings: { pendingTotal: string; asset: 'reward' };
```

The whole `earnings` block becomes staking-only data with nothing left, so remove the `earnings` property entirely from `StatusRollupV1Response` (`:28`). Then delete the `earnings: { pendingTotal: ..., asset: 'reward' }` literal from the `base` object (`:329-332`).

- [ ] **Step 6: Run typecheck (expect reds in dependent tests + the status CLI command)**

Run: `cd client && yarn typecheck`
Expected: `status-rollup-build.ts` and `fleet-build.ts` compile; `status.ts` (CLI) still reads `v.earnings.pendingTotal` (`status.ts:69`) → type error, fixed in Task 7; test files error → fixed in Tasks 11-12.

- [ ] **Step 7: Commit**

```bash
git add client/src/api/fleet-build.ts client/src/api/status-rollup-build.ts
git commit -m "refactor(api): drop staking fields from fleet + status-rollup shapes (#992)"
```

---

### Task 6: Wire the on-demand extractor into `jinn rewards` (criterion 3)

**Files:**
- Modify: `client/src/cli/commands/rewards.ts`.

- [ ] **Step 1: Import the extractor + config loader and extend `RewardsDeps`**

At the top of `rewards.ts`, add imports and extend the deps interface:

```ts
import { sumPendingStakingRewards as defaultSumPendingStakingRewards } from '../../api/gather-status.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
```

```ts
export interface RewardsDeps {
  gatherIntrospectionRaw: typeof defaultGatherIntrospectionRaw;
  assembleRewardsV1: typeof defaultAssembleRewardsV1;
  sumPendingStakingRewards: typeof defaultSumPendingStakingRewards;
}

const PRODUCTION_DEPS: RewardsDeps = {
  gatherIntrospectionRaw: defaultGatherIntrospectionRaw,
  assembleRewardsV1: defaultAssembleRewardsV1,
  sumPendingStakingRewards: defaultSumPendingStakingRewards,
};
```

- [ ] **Step 2: Call the extractor on demand and splice onto `raw` before assembly**

Replace the `run` body's gather+assemble (`:92-93`) with:

```ts
      const raw = await deps.gatherIntrospectionRaw({ argv: ctx.argv });
      // On-demand staking reward read — kept off the /v1/status hot path (#992).
      // jinn rewards is the sanctioned ops-only surface for the OLAS staking
      // collector queue. Resolve rpcUrl/network from config and read against
      // the fleet that gather-status already loaded into `raw`.
      if (raw.fleet && raw.rpc.ok) {
        const configPath =
          getConfigPathFromArgs(ctx.argv ?? []) ?? getConfigPathFromArgs(process.argv.slice(2));
        try {
          const config = loadConfig(configPath);
          const pr = await deps.sumPendingStakingRewards(config.rpcUrl, config.network, raw.fleet);
          if ('sum' in pr) {
            raw.pendingStakingRewardsWei = pr.sum;
            raw.pendingByService = pr.pendingByService;
            if (pr.nextCheckpointAt) raw.nextCheckpointAt = pr.nextCheckpointAt;
          } else {
            raw.pendingRewardsError = pr.error;
          }
        } catch {
          // Config unreadable or RPC error — assembleRewardsV1 degrades to
          // pending=0 / nextCheckpointAt=null, which the human renderer handles.
        }
      }
      const payload = deps.assembleRewardsV1(raw);
```

**Confirm-while-coding:**
- `JinnConfig` exposes `rpcUrl: string | string[]` and `network: 'mainnet' | 'testnet'`. `sumPendingStakingRewards(rpcUrl: string, ...)` takes a single string. If `config.rpcUrl` can be an array (per the RPC fallback chain, issue #592), pass the head: `const rpcUrl = Array.isArray(config.rpcUrl) ? config.rpcUrl[0]! : config.rpcUrl;` and call `deps.sumPendingStakingRewards(rpcUrl, config.network, raw.fleet)`. Verify the actual type of `config.rpcUrl` in `client/src/config.ts` and adjust. (The hot path previously called it with `status.rpcUrl`, a single string already resolved — replicate that resolution here.)
- `FleetState` is the type of `raw.fleet` and matches `sumPendingStakingRewards`'s third arg. Confirm `raw.fleet` is `FleetState | null` and the `if (raw.fleet ...)` guard narrows it.

- [ ] **Step 3: Run the rewards seam tests**

Run: `cd client && yarn vitest run test/cli/commands/rewards.test.ts`
Expected: PASS — all three behavioral tests (existing + the two from Task 2) are green.

- [ ] **Step 4: Run typecheck**

Run: `cd client && yarn typecheck`
Expected: `rewards.ts` compiles. (Other test files may still error — addressed in Tasks 10-13.)

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/rewards.ts
git commit -m "refactor(cli): jinn rewards reads staking queue on demand, not via status (#992)"
```

---

### Task 7: Drop the staking-collector line from `jinn status` human output (criterion 2)

**Files:**
- Modify: `client/src/cli/commands/status.ts:63-79` (`humanStatus`).

- [ ] **Step 1: Remove the `staking-collector-pending` line**

In `humanStatus` (`:64-78`), delete the array element that reads `v.earnings.pendingTotal`:

```ts
    `staking-collector-pending: ${v.earnings.pendingTotal} reward-wei`,
```

The remaining lines (daemon/health/fleet/task-native/hint) are unaffected.

- [ ] **Step 2: Run typecheck**

Run: `cd client && yarn typecheck`
Expected: `status.ts` compiles (it no longer references the removed `earnings` field). The `StatusPayload` type spreads `StatusRollupV1Response`, which no longer has `earnings` — no other reference remains.

- [ ] **Step 3: Commit**

```bash
git add client/src/cli/commands/status.ts
git commit -m "refactor(cli): drop staking-collector line from jinn status (#992)"
```

---

### Task 8: Confirm `introspection-context.ts` and `rewards-build.ts` are untouched (criteria 3, 4)

No code change — verification only, to satisfy "confirm" items in the Stage 1 note.

- [ ] **Step 1: Confirm `tryMergeStatusFromHttp` carries no staking**

Read `client/src/cli/introspection-context.ts:14-45`. Verify the merged `next` object only copies `shutdownState`, `daemonStartedAt`, and `rpc`. It does — no change needed.

- [ ] **Step 2: Confirm `assembleRewardsV1` still reads the spliced raw fields**

Read `client/src/api/rewards-build.ts:26-69`. Verify it reads `raw.pendingStakingRewardsWei`, `raw.pendingByService`, `raw.nextCheckpointAt`, `raw.lastRewardClaimTickAt`, `raw.claimedByService` — all still present on `GatheredStatusRaw` and populated by Task 6's splice. No change.

- [ ] **Step 3: Confirm `eviction-loop.ts` independence (criterion 4)**

Read `client/src/daemon/eviction-loop.ts:1-40`. Verify it imports `STAKING_ABI` from `../earning/contracts.js` and takes an injected `readContract`; it never imports gather-status. No change.

- [ ] **Step 4: (No commit — verification task.)**

---

### Task 9: Run the full unit suite to enumerate remaining red tests

**Files:** none.

- [ ] **Step 1: Run the suite**

Run: `cd client && yarn vitest run test/api test/cli`
Expected: the criterion-1 test + rewards seam tests PASS; the following FAIL and are cleaned up next:
- `test/api/gather-status.test.ts` — eviction-window suite (references `__resetEvictionFirstSeenForTests`, `evicted`/`evictedSince`) + the `:186` pending assertion + the autoRestake suite (uses deleted helpers).
- `test/api/status-build.test.ts` — `:220` (`totalStakingRewardsWei`), `:259` (`pendingStakingRewardsWei`), the eviction-suppression-fields cases (`:518-558`).
- `test/api/fleet-build.test.ts` — `:57` (`staking.evicted`), `:88-112` (evicted/inactivity cases).
- `test/api/status-rollup-build.test.ts` — `:60-61` (`earnings.pendingTotal`/`asset`).
- `test/cli/commands/status.test.ts` — `:156`/`:176-177` (`earnings` in type + assertions).

- [ ] **Step 2: (No commit — diagnostic task.)**

---

### Task 10: Clean up `gather-status.test.ts` — delete eviction suite, fix the main assertion, rework autoRestake (criterion 5)

The eviction first-seen `describe` block (`:797-1138`) mixes deleted behavior (eviction window) with surviving behavior (the autoRestake predicate). The autoRestake suite currently depends on `mockEvictionViem` + `__resetEvictionFirstSeenForTests`, both deleted — so it must be reworked to a plain viem mock and the reset call removed.

**Files:**
- Modify: `client/test/api/gather-status.test.ts:186`, `:198`, `:99-104`, `:797-1138`.

- [ ] **Step 1: Remove the `pendingStakingRewardsWei` assertions from the main tJINN test**

Delete line `:186` (`expect(apiStatus.rewards.pendingStakingRewardsWei).toBe('2997000000000000000000');`). On line `:198`, the assertion `expect(apiStatus.tJinn.safeBalanceWei).not.toBe(apiStatus.rewards.pendingStakingRewardsWei);` references a removed field — replace it with a direct value check that preserves the original intent (tJINN balance is a real value distinct from any staking figure):

```ts
      expect(apiStatus.tJinn.safeBalanceWei).toBe('3500000000000000000');
```

(`safeBalanceWei` is already asserted in the `toMatchObject` above; this line becomes redundant — simplest is to DELETE line `:198` entirely. Prefer deletion.)

- [ ] **Step 2: Remove the now-unreferenced staking branches from the main mock**

In the main test's `readContract` mock (`:94-106`), delete the four staking branches that no production code now calls:

```ts
            if (chain.id === 84532 && req.functionName === 'calculateStakingReward') {
              return 999000000000000000000n;
            }
            if (req.functionName === 'getNextRewardCheckpointTimestamp') return 0n;
            if (req.functionName === 'getStakingState') return 0;
            if (req.functionName === 'getServiceInfo') return { inactivity: 0n };
```

Leave the trailing `return 0n;` so `readContract` still has a body. (Removing these proves, structurally, that the hot path no longer needs them.)

- [ ] **Step 3: Delete the eviction-window suites; rework the autoRestake suite**

Within the `describe('gather-status eviction first-seen tracker (#651)', ...)` block (`:797`):
- DELETE the three eviction-window `it(...)` blocks: `'sets evictedSince on first observation...'` (`:860`), `'clears the tracker entry...'` (`:896`), and `'preserves evictedSince across a transient RPC failure'` (`:1058`).
- KEEP the two autoRestake `it(...)` blocks: `'emits autoRestake.enabled=true only when all three predicate clauses are met'` (`:943`) and the Finding-A follow-up (`:998+`, ends `:1137`).
- In each surviving autoRestake test, REMOVE the `, __resetEvictionFirstSeenForTests` from the destructured import and DELETE the `__resetEvictionFirstSeenForTests();` call line.
- Replace `mockEvictionViem(() => false);` at the top of each surviving test with a call to a renamed plain mock helper. Rename the helper `mockEvictionViem` → `mockGatherViem` and simplify its `readContract` to drop the staking branches (since they're never hit now):

```ts
  function mockGatherViem(): void {
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return {
        ...actual,
        createPublicClient: ({ chain }: { chain: { id: number } }) => ({
          getBlockNumber: async () => 123n,
          getChainId: async () => chain.id,
          getBalance: async () => 0n,
          multicall: async (req: { contracts: ReadonlyArray<{ functionName: string }> }) =>
            req.contracts.map(() => ({ status: 'success' as const, result: 0n })),
          readContract: async () => 0n,
          getLogs: async () => [],
        }),
        http: () => ({}),
      };
    });
  }
```

Update the two surviving tests to call `mockGatherViem();` instead of `mockEvictionViem(() => false);`. Keep the `setupFleet` helper (`:837`) — still used. Optionally rename the `describe` title from `'gather-status eviction first-seen tracker (#651)'` to `'gather-status autoRestake gating (#651)'` since the eviction-tracker tests are gone.

- [ ] **Step 4: Run the gather-status suite**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts`
Expected: PASS — criterion-1 test, main tJINN test, and the two autoRestake tests all green; no references to deleted symbols remain.

- [ ] **Step 5: Commit**

```bash
git add client/test/api/gather-status.test.ts
git commit -m "test(api): drop eviction-window coverage; rework autoRestake off deleted helpers (#992)"
```

---

### Task 11: Clean up `status-build.test.ts`, `fleet-build.test.ts`, `status-rollup-build.test.ts` (criterion 5)

**Files:**
- Modify: `client/test/api/status-build.test.ts`, `client/test/api/fleet-build.test.ts`, `client/test/api/status-rollup-build.test.ts`.

- [ ] **Step 1: `status-build.test.ts` — delete the total-rewards test**

Delete the entire `it('reports total rewards as claimed plus claimable', ...)` block (`:198-221`) — it asserts `totalStakingRewardsWei` (removed). (Its sibling `claimedStakingRewardsWei` coverage: if no other test asserts `claimedStakingRewardsWei`, add a one-liner to a surviving rewards test, e.g. inside the kept tJINN test, assert `j.rewards.claimedStakingRewardsWei` is present. **Confirm-while-coding:** grep `claimedStakingRewardsWei` in this file; if uncovered after the delete, add `expect(j.rewards.claimedStakingRewardsWei).toBe('0')` to the kept tJINN test's assertions.)

- [ ] **Step 2: `status-build.test.ts` — fix the tJINN-separation test**

In `it('keeps real tJINN balance separate from pending staking rewards', ...)` (`:223-262`): delete `pendingStakingRewardsWei: '999000000000000000000',` from the `raw` literal (`:235`), and delete the two assertions referencing it (`:259` and `:261`). Keep `expect(j.tJinn.safeBalanceWei).toBe('1500000000000000000');` (`:260`). The test now just proves the tJINN balance surfaces correctly.

- [ ] **Step 3: `status-build.test.ts` — delete the evicted-fields cases from the suppression suite**

In `describe('assembleStatusV1 — eviction suppression fields (#651)', ...)` (`:517`): DELETE `it('emits evictedSince=null when service not evicted', ...)` (`:518-536`) and `it('emits evictedSince ISO when service is evicted and tracker set', ...)` (`:538-558`). KEEP the two autoRestake cases (`:560-598`). Rename the `describe` title to `'assembleStatusV1 — autoRestake observability (#651)'`.

- [ ] **Step 4: `fleet-build.test.ts` — drop staking-evicted/inactivity cases**

- In `it('emits schemaVersion and per-service entries...', ...)`, delete `expect(svc.staking.evicted).toBe(false);` (`:57`). Keep `expect(svc.staking.staked).toBe(true);` (`:56`).
- DELETE the four cases at `:88-112`: `'populates staking.evicted...'`, `'defaults staking.evicted to false...'`, `'populates staking.inactivitySeconds...'`, `'defaults staking.inactivitySeconds to null...'`.

- [ ] **Step 5: `status-rollup-build.test.ts` — drop the earnings assertions**

In `it('emits the §4.1 roll-up shape with daemon/rpc/fleet/earnings/exit', ...)` (`:50`): delete `expect(parsed.earnings.pendingTotal).toBe('42');` (`:60`) and `expect(parsed.earnings.asset).toBe('reward');` (`:61`). Update the `it` title to drop `/earnings`. Also delete `pendingStakingRewardsWei: '42',` from the `makeRaw` helper (`:45`) since nothing reads it now.

- [ ] **Step 6: Run the three suites**

Run: `cd client && yarn vitest run test/api/status-build.test.ts test/api/fleet-build.test.ts test/api/status-rollup-build.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/test/api/status-build.test.ts client/test/api/fleet-build.test.ts client/test/api/status-rollup-build.test.ts
git commit -m "test(api): drop staking-field coverage from status/fleet/rollup builders (#992)"
```

---

### Task 12: Repurpose the eviction-banner e2e as a field-absence structural guard (criterion 5)

**Decision (recommended): REPURPOSE, do not delete.** The e2e at `client/test/dashboard/eviction-banner-window.e2e.test.ts` is the #773 regression proving the SPA never surfaces eviction banners. After this refactor, `/v1/status` no longer carries `evicted`/`evictedSince`, so injecting them via the mock (`buildEvictedStatus`) no longer reflects a real daemon response. Two options:

- **Option A (recommended) — repurpose as an absence guard.** Replace the eviction-injection scenarios with a single assertion against a *real* daemon `/v1/status` (the daemon is already spawned in `beforeAll`): fetch `/v1/status` and assert the staking fields are ABSENT (`rewards.pendingStakingRewardsWei === undefined`, `rewards.totalStakingRewardsWei === undefined`, no `fleet.services[].evicted`). This converts a fragile fixture-driven SPA test into a structural contract test that fails loudly if any staking field reappears on the wire. It also drops the Playwright `page` dependency, making it a fast fetch-only test.
- **Option B — delete.** Remove the file. The SPA already has no runtime consumers of `evicted`; the #773 concern (don't render eviction surfaces) is moot once the field can't arrive. Simpler, but loses the structural guard.

This plan implements Option A. (If the reviewer prefers B during execution, delete the file and skip to Task 13; note the choice in the PR.)

**Files:**
- Modify: `client/test/dashboard/eviction-banner-window.e2e.test.ts`.

- [ ] **Step 1: Rewrite the file as a field-absence guard**

Replace the whole file body (keep the `beforeAll`/`afterAll` daemon spawn at `:22-70`, drop `buildEvictedStatus`, `installStatusMock`, `scenarios`, and the per-scenario tests) with a single fetch-based assertion. Keep imports trimmed to what's used:

```ts
/**
 * Regression for #992 (supersedes the #773 eviction-banner window check):
 * /v1/status must NOT carry OLAS staking fields. OLAS staking is substrate;
 * operators never see it. This is a structural contract guard — if any staking
 * field reappears on the wire it fails loudly. The on-demand staking queue
 * lives behind `jinn rewards`, not /v1/status.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 17335;

let daemon: ChildProcess | null = null;
let homeDir = '';

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-status-shape-e2e-'));
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error('dist/bin/jinn.js missing — run `yarn build` first');
  }
  daemon = spawn('node', [distBin, 'run', '--no-ui'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      JINN_PASSWORD: 'test-password',
      JINN_API_PORT: String(PORT),
      BASE_RPC_URL: 'http://127.0.0.1:65000',
      JINN_NETWORK: 'testnet',
      JINN_DISABLE_TESTNET_FAUCET: '1',
    },
    stdio: 'pipe',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
        headers: { 'x-jinn-ui-token': 'unused' },
      });
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('daemon never came up on test port');
});

test.afterAll(async () => {
  if (daemon && !daemon.killed) {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!daemon.killed) daemon.kill('SIGKILL');
  }
});

test('/v1/status carries no OLAS staking fields (#992)', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/status`);
  expect(res.ok).toBe(true);
  const body = (await res.json()) as {
    rewards: Record<string, unknown>;
    fleet: { services: Array<Record<string, unknown>> };
  };
  expect(body.rewards).not.toHaveProperty('pendingStakingRewardsWei');
  expect(body.rewards).not.toHaveProperty('totalStakingRewardsWei');
  expect(body.rewards).not.toHaveProperty('pendingRewardsError');
  for (const svc of body.fleet.services) {
    expect(svc).not.toHaveProperty('evicted');
    expect(svc).not.toHaveProperty('evictedSince');
  }
});
```

**Confirm-while-coding:** rename the file to reflect its new purpose, e.g. `client/test/dashboard/status-no-staking-fields.e2e.test.ts` (use `git mv`), so the filename stops claiming to be an eviction-banner test. Confirm the Playwright config globs `*.e2e.test.ts` so the rename keeps it in the suite (`rg -n "e2e" client/playwright.config*` or the package.json e2e script).

- [ ] **Step 2: Run the e2e (requires a built dist)**

Run: `cd client && yarn build && yarn test:e2e` (or the project's Playwright invocation — check `package.json` scripts; it may be `yarn playwright test`). Run just this spec if the runner supports `-g "no OLAS staking fields"`.
Expected: PASS. **Confirm-while-coding:** if the e2e suite is gated behind a separate CI lane and not part of `yarn test`, note that in the PR; the unit suite (Task 14) is the primary gate.

- [ ] **Step 3: Commit**

```bash
git add -A client/test/dashboard/
git commit -m "test(e2e): repurpose #773 eviction e2e as /v1/status staking-field absence guard (#992)"
```

---

### Task 13: Drop stale staking fixtures from the SPA tests (criterion 5)

These are jsdom unit tests run inside `yarn test`. The fixtures carry `rewards.pendingStakingRewardsWei`, which the SPA never reads (`useNotifications.ts:90` is a comment explaining it is deliberately NOT mapped). Removing the field from fixtures keeps them honest with the new response shape; assertions are unaffected.

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.test.tsx:262`, `:286`; `client/src/dashboard/spa/src/notifications/useNotifications.test.tsx:59`, `:115`.

- [ ] **Step 1: `Overview.test.tsx`**

- Line `:262`: delete `rewards: { pendingStakingRewardsWei: '1000000000000000000' },` from the fixture. **Confirm-while-coding:** if `rewards` is the only key needed elsewhere in that fixture object, check whether removing the whole `rewards` key breaks a `rewards.claimLoopIntervalMs`-style read; the SPA reads `harness`/`funds`/`tJinn`, not `rewards.pending*`, so deletion is safe. If other tests in the file rely on a `rewards` object existing, replace with a minimal `rewards: { claimLoopIntervalMs: 0, lastClaimTickAt: null, claimedStakingRewardsWei: '0' },` instead of deleting.
- Line `:286`: delete `rewards: { pendingStakingRewardsWei: '999000000000000000000' },` similarly. The comment at `:303` references "rewards.pendingStakingRewardsWei (999 collector-token)" — update or delete that comment so it no longer references a non-existent field.

- [ ] **Step 2: `useNotifications.test.tsx`**

- Line `:59`: delete `rewards: { pendingStakingRewardsWei: '0' },`.
- Line `:115`: delete `rewards: { pendingStakingRewardsWei: '1000000000000000000' },`.

(Same confirm-while-coding caveat: substitute a minimal valid `rewards` object if the test's status fixture type requires the key. The `useNotifications` adapter reads `s.harness`, `s.funds`, not `s.rewards`, so deletion is the likely-correct move.)

- [ ] **Step 3: Run the SPA tests**

Run: `cd client && yarn vitest run src/dashboard/spa/src/pages/Overview.test.tsx src/dashboard/spa/src/notifications/useNotifications.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/pages/Overview.test.tsx client/src/dashboard/spa/src/notifications/useNotifications.test.tsx
git commit -m "test(spa): drop stale rewards.pendingStakingRewardsWei fixtures (#992)"
```

---

### Task 14: Full verification (all criteria)

**Files:** none.

- [ ] **Step 1: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 2: Full unit + SPA suite**

Run: `cd client && yarn test`
Expected: all pass. (SPA jsdom tests run inside `yarn test` per the project test config; no separate command needed for them.)

- [ ] **Step 3: Targeted grep — no residual hot-path staking references**

Run:
```bash
cd client && rg -n "evictedByServiceIndex|inactivityByServiceIndex|evictedSinceByServiceIndex|evictionFirstSeenMs|__resetEvictionFirstSeenForTests|totalStakingRewardsWei" src
```
Expected: ZERO matches in `src`. (`pendingStakingRewardsWei`, `pendingByService`, `nextCheckpointAt`, `pendingRewardsError` SHOULD still match — they live on `GatheredStatusRaw`, in `rewards-build.ts`, and in the `jinn rewards` splice. That is correct.)

Run:
```bash
cd client && rg -n "sumPendingStakingRewards" src
```
Expected: matches in `gather-status.ts` (definition, now `export`) and `cli/commands/rewards.ts` (import + call). NOT in the body of `gatherGatheredStatusRaw`.

- [ ] **Step 4: Confirm the indexer is untouched (scope check)**

Run: `git status --porcelain | grep -i "packages/indexer" || echo "indexer untouched"`
Expected: `indexer untouched`. This is a client-only change; `packages/indexer` (Ponder) has no part in it.

- [ ] **Step 5: Confirm eviction-loop untouched (criterion 4)**

Run: `git diff --name-only origin/next -- client/src/daemon/eviction-loop.ts | grep . && echo "CHANGED — investigate" || echo "eviction-loop untouched"`
Expected: `eviction-loop untouched`.

- [ ] **Step 6: (No commit — verification task. The branch is ready for review.)**

---

## Acceptance-criteria → task map

| Criterion | Tasks |
|---|---|
| 1 — shared gather does no staking RPC reads; per-poll L2 fan-out gone | Task 1 (proof), Task 3 (deletion), Task 14 §3 (grep) |
| 2 — staking fields removed from `/v1/status` shape (types + population) | Task 4 (status-build + GatheredStatusRaw), Task 5 (fleet-build + status-rollup) |
| 3 — `jinn rewards` retained; `sumPendingStakingRewards` exported + invoked on demand; `RewardsV1Response` intact | Task 2 (proof), Task 6 (wiring), Task 8 §2 (rewards-build unchanged) |
| 4 — eviction-loop control path untouched | Task 8 §3 (confirm), Task 14 §5 (verify) |
| 5 — tests updated; no operator-facing surface loses anything | Tasks 10, 11, 12, 13 (test cleanup); Task 7 (status CLI); Task 14 (full suite) |

---

## Self-review notes

- **Spec coverage.** Every Stage 1 directive maps to a task: export-not-relocate (Task 3 §1), delete hot-path call + eviction block + tracker (Task 3), keep pending fields optional on `GatheredStatusRaw` (Task 4 §6), `StatusV1Response`/`fleet-build`/`status-rollup` field removals (Tasks 4-5), `RewardsDeps` 3rd member + splice (Tasks 2, 6), `tryMergeStatusFromHttp` unchanged (Task 8 §1), e2e repurpose-vs-delete with recommendation (Task 12), SPA fixtures (Task 13).
- **Divergence from Stage 1 worth flagging to the reviewer.** Stage 1 named only `jinn rewards` and `/v1/status` as the gather consumers, but `jinn status` (`assembleStatusRollupV1`, renders `earnings.pendingTotal`) and `jinn fleet` (`assembleFleetV1`, exposes `staking.evicted`/`inactivitySeconds`/`rewards.pending`) also flow through `gatherIntrospectionRaw`. Per the field-removal directives those staking fields leave both shapes (Tasks 5, 7); only `jinn rewards` re-acquires staking data via the on-demand splice. This is consistent with the issue ("keep `jinn rewards` as the on-demand ops-only surface") and the Stage 1 field list, but is more than the note's two named callsites — call it out explicitly in the PR description.
- **`config.rpcUrl` type.** The plan's Task 6 confirm-while-coding item covers the single-string-vs-array shape (issue #592). The hot path called `sumPendingStakingRewards(status.rpcUrl, ...)` with an already-resolved single string; the CLI splice must resolve `config.rpcUrl` the same way.
- **autoRestake tests survive the helper deletion.** Task 10 reworks them off `mockEvictionViem`/`__resetEvictionFirstSeenForTests` — the one non-obvious test fallout, since the autoRestake gating (criterion-adjacent observability) must keep its coverage while the eviction-tracker scaffolding it borrowed is deleted.
- **Placeholder scan.** Every code step shows the literal change. No "add error handling" / "TBD".
- **Type consistency.** `RewardsDeps.sumPendingStakingRewards: typeof defaultSumPendingStakingRewards` (Task 6) matches the exported signature from Task 3. The splice writes exactly the four optional `GatheredStatusRaw` fields kept in Task 4 §6, which `assembleRewardsV1` reads (Task 8 §2).
