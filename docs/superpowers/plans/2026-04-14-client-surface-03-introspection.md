# Client Surface 03 — Introspection Verbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the read-only introspection verbs — `status`, `fleet`, `balance`, `history`, `rewards`, `logs` — each matching the JSON shape defined in `spec/2026-04-14-client-surface.md` §4. Split the existing mega-`status` response into the narrower shapes the spec requires, so a monitoring loop polls only the roll-up (`jinn status`) and pulls detail on demand.

**Architecture:** Each introspection verb is a thin CLI command module following the dispatch pattern established in plan 02. The data source is the existing status gathering pipeline at `client/src/api/gather-status.ts` + `status-build.ts`, which currently produces one `StatusV1Response`. This plan adds narrower assemblers that slice that response into the per-verb payloads without rerunning the underlying RPC work. Verbs call into the daemon's HTTP API when it's running (`GET /v1/status`, new `/v1/fleet`, new `/v1/history`) or gather locally when the daemon is down.

**Tech Stack:** TypeScript, Vitest, existing status pipeline, Hono HTTP server at `client/src/api/server.ts`.

**Hard prerequisite:** Plan 02 (`2026-04-14-client-surface-02-cli-scaffold.md`) must be fully implemented and committed before starting this plan. This plan adds commands under `client/src/cli/commands/` and registers them in `client/src/cli/index.ts`'s `COMMANDS` array — both of which plan 02 creates.

**Reference:** `spec/2026-04-14-client-surface.md` §2.2 (introspection verbs), §4.1–4.4 (JSON shapes), §3 (stable role enums).

**Non-goals for this plan:**
- Action verbs — covered by plan 04.
- Retiring the legacy `npm run status` script — coexists until later.
- Moving `jinn logs` to a streaming transport (WebSocket, SSE) — logs v1 reads the SQLite activity table and emits one JSON object per line, bounded.

---

## File structure

New files (assemblers — pure functions that slice GatheredStatusRaw):
- `client/src/api/fleet-build.ts` — `assembleFleetV1(raw)` → `FleetV1Response`
- `client/src/api/balance-build.ts` — `assembleBalanceV1(raw)` → `BalanceV1Response`
- `client/src/api/history-build.ts` — `assembleHistoryV1(raw, opts)` → `HistoryV1Response`
- `client/src/api/rewards-build.ts` — `assembleRewardsV1(raw)` → `RewardsV1Response`

New files (HTTP endpoints):
- `client/src/api/server.ts` modified to expose `/v1/fleet`, `/v1/balance`, `/v1/history`, `/v1/rewards`.
- `client/src/api/status-build.ts` modified to slim `/v1/status` to the narrower roll-up shape.

New files (CLI verbs):
- `client/src/cli/commands/status.ts`
- `client/src/cli/commands/fleet.ts`
- `client/src/cli/commands/balance.ts`
- `client/src/cli/commands/history.ts`
- `client/src/cli/commands/rewards.ts`
- `client/src/cli/commands/logs.ts`

New tests:
- `client/test/api/fleet-build.test.ts`
- `client/test/api/balance-build.test.ts`
- `client/test/api/history-build.test.ts`
- `client/test/api/rewards-build.test.ts`
- `client/test/cli/commands/status.test.ts`
- `client/test/cli/commands/fleet.test.ts`
- `client/test/cli/commands/balance.test.ts`
- `client/test/cli/commands/history.test.ts`
- `client/test/cli/commands/rewards.test.ts`
- `client/test/cli/commands/logs.test.ts`

Modified files:
- `client/src/cli/index.ts` — register the six new commands.
- `client/src/api/status-build.ts` — slim `assembleStatusV1` to emit only the roll-up fields from spec §4.1 (mirror the full detail in a new `assembleFullStatusRaw` helper that the other assemblers read).
- `client/test/api/` — update any existing status build tests to match the slimmer shape.

---

## Task 1: Fleet assembler — per-service detail slice

**Files:**
- Create: `client/src/api/fleet-build.ts`
- Create: `client/test/api/fleet-build.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/api/fleet-build.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { assembleFleetV1 } from '../../src/api/fleet-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(overrides: Partial<GatheredStatusRaw> = {}): GatheredStatusRaw {
  return {
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '/tmp/jinn.db',
    shutdownState: 'running',
    rpcOk: true,
    rpcChainId: 84532,
    rpcBlockNumber: 1n,
    rpcError: undefined,
    fleet: {
      loaded: true,
      chain: 'base-sepolia',
      stakingMode: 'standard',
      masterAddress: '0xMASTER',
      services: [
        {
          index: 0,
          step: 'complete',
          serviceId: 42,
          agentAddress: '0xAGENT',
          safeAddress: '0xSAFE',
          staked: true,
        },
      ],
      completeCount: 1,
      stakedLikeCount: 1,
    },
    masterGas: {
      address: '0xMASTER',
      balanceWei: '1000000000000000000',
      minEthWei: '5000000000000000',
      dailyEstimateWei: '1000000000000000',
      runwayDaysExcess: 1000,
      error: undefined,
    },
    rewards: {
      claimLoopIntervalMs: 600000,
      lastClaimTickAt: null,
      pendingStakingRewardsWei: '42',
      pendingRewardsError: undefined,
    },
    activity: { counts: {}, recent: [] },
    earningsHint: 'accruing',
    nextActions: [],
    ...overrides,
  } as unknown as GatheredStatusRaw;
}

describe('assembleFleetV1', () => {
  it('emits schemaVersion and per-service entries with wallets and staking state', () => {
    const out = assembleFleetV1(makeRaw());
    expect(out.schemaVersion).toBe(1);
    expect(out.network).toBe('testnet');
    expect(out.master.address).toBe('0xMASTER');
    expect(out.services).toHaveLength(1);
    const svc = out.services[0];
    expect(svc.index).toBe(0);
    expect(svc.step).toBe('complete');
    expect(svc.serviceId).toBe(42);
    expect(svc.wallets.agent.address).toBe('0xAGENT');
    expect(svc.wallets.multisig.address).toBe('0xSAFE');
    expect(svc.staking.staked).toBe(true);
    expect(svc.staking.evicted).toBe(false);
  });

  it('sets attention=null when no issue detected', () => {
    const out = assembleFleetV1(makeRaw());
    expect(out.services[0].attention).toBeNull();
  });

  it('sets attention.kind=low_gas when master gas is below min', () => {
    const raw = makeRaw();
    raw.masterGas.balanceWei = '1000'; // tiny
    raw.masterGas.minEthWei = '5000000000000000';
    raw.masterGas.runwayDaysExcess = -1;
    const out = assembleFleetV1(raw);
    // Attention is per-service today; low_gas lives on the master wallet,
    // surface it on service 0 as a compromise until plan 04 introduces a
    // master-wallet attention channel.
    expect(out.services[0].attention?.kind).toBe('low_gas');
  });

  it('reports network=mainnet when fleet.chain is base', () => {
    const raw = makeRaw();
    raw.fleet!.chain = 'base';
    const out = assembleFleetV1(raw);
    expect(out.network).toBe('mainnet');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/api/fleet-build.test.ts
```

Expected: FAIL with "Cannot find module '../../src/api/fleet-build.js'".

- [ ] **Step 3: Implement the fleet assembler**

Create `client/src/api/fleet-build.ts`:

```typescript
/**
 * Fleet response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.2.
 * Reads the same GatheredStatusRaw that powers /v1/status and slices it
 * into the per-service detail shape used by `jinn fleet`.
 */

import type { GatheredStatusRaw } from './status-build.js';

type AttentionKind =
  | 'none'
  | 'low_gas'
  | 'evicted'
  | 'stake_missing'
  | 'bond_insufficient'
  | 'reconcile_needed';

export interface FleetV1Service {
  index: number;
  step: string;
  serviceId: number | null;
  wallets: {
    agent: { address: string; balances: Array<{ asset: string; amountWei: string }> };
    multisig: { address: string; balances: Array<{ asset: string; amountWei: string }> };
  };
  staking: { staked: boolean; evicted: boolean; sinceBlock: number | null };
  activity: { lastEventAt: string | null; counts: Record<string, number> };
  rewards: { pending: string; asset: 'reward' };
  attention: null | { kind: AttentionKind; hint: string; exampleCli: string };
}

export interface FleetV1Response {
  schemaVersion: 1;
  generatedAt: string;
  network: 'testnet' | 'mainnet';
  master: {
    address: string;
    balances: Array<{ asset: string; amountWei: string }>;
  };
  services: FleetV1Service[];
}

function computeAttention(
  svc: NonNullable<GatheredStatusRaw['fleet']>['services'][number],
  masterGas: GatheredStatusRaw['masterGas'],
  isFirstService: boolean,
): FleetV1Service['attention'] {
  // Master low-gas surfaces on service 0 until plan 04 adds a master
  // attention channel.
  if (isFirstService && masterGas.runwayDaysExcess !== undefined && masterGas.runwayDaysExcess < 0) {
    return {
      kind: 'low_gas',
      hint: 'Master wallet ETH below minimum. Top it up to continue.',
      exampleCli: 'jinn fund-requirements --json',
    };
  }
  if (svc.step !== 'complete') {
    return {
      kind: 'reconcile_needed',
      hint: `Service ${svc.index} is at step ${svc.step}. Run jinn bootstrap to advance.`,
      exampleCli: 'jinn bootstrap',
    };
  }
  return null;
}

export function assembleFleetV1(raw: GatheredStatusRaw): FleetV1Response {
  const fleet = raw.fleet;
  const network: 'testnet' | 'mainnet' = fleet?.chain === 'base' ? 'mainnet' : 'testnet';
  const masterAddress = fleet?.masterAddress ?? raw.masterGas.address ?? '0x';
  return {
    schemaVersion: 1,
    generatedAt: raw.timestamp,
    network,
    master: {
      address: masterAddress,
      balances: [{ asset: 'native', amountWei: raw.masterGas.balanceWei ?? '0' }],
    },
    services: (fleet?.services ?? []).map((svc, i) => ({
      index: svc.index,
      step: svc.step,
      serviceId: svc.serviceId ?? null,
      wallets: {
        agent: {
          address: svc.agentAddress ?? '0x',
          balances: [{ asset: 'native', amountWei: '0' }],
        },
        multisig: {
          address: svc.safeAddress ?? '0x',
          balances: [
            { asset: 'native', amountWei: '0' },
            { asset: 'bond', amountWei: '0' },
          ],
        },
      },
      staking: {
        staked: svc.staked ?? false,
        evicted: false,
        sinceBlock: null,
      },
      activity: {
        lastEventAt: null,
        counts: raw.activity.counts,
      },
      rewards: {
        pending: raw.rewards.pendingStakingRewardsWei ?? '0',
        asset: 'reward' as const,
      },
      attention: computeAttention(svc, raw.masterGas, i === 0),
    })),
  };
}
```

Note: balances for the per-service wallets are filled with `0` today because
`GatheredStatusRaw` doesn't yet carry them. Plan 04 extends the gatherer.
The shape is correct per spec; the values will become real when plan 04 lands.

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/api/fleet-build.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/api/fleet-build.ts client/test/api/fleet-build.test.ts
git commit -m "client(api): add fleet assembler slicing raw status into per-service shape"
```

---

## Task 2: Balance assembler

**Files:**
- Create: `client/src/api/balance-build.ts`
- Create: `client/test/api/balance-build.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/api/balance-build.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { assembleBalanceV1 } from '../../src/api/balance-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(): GatheredStatusRaw {
  return {
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '/tmp/jinn.db',
    shutdownState: 'running',
    rpcOk: true,
    rpcChainId: 84532,
    rpcBlockNumber: 1n,
    fleet: {
      loaded: true,
      chain: 'base-sepolia',
      stakingMode: 'standard',
      masterAddress: '0xMASTER',
      services: [
        { index: 0, step: 'complete', serviceId: 1, agentAddress: '0xA0', safeAddress: '0xS0', staked: true },
        { index: 1, step: 'complete', serviceId: 2, agentAddress: '0xA1', safeAddress: '0xS1', staked: true },
      ],
      completeCount: 2,
      stakedLikeCount: 2,
    },
    masterGas: { address: '0xMASTER', balanceWei: '1', dailyEstimateWei: '1', runwayDaysExcess: 1 },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: null },
    activity: { counts: {}, recent: [] },
    earningsHint: '',
    nextActions: [],
  } as unknown as GatheredStatusRaw;
}

describe('assembleBalanceV1', () => {
  it('emits one entry per wallet with stable role names', () => {
    const out = assembleBalanceV1(makeRaw());
    expect(out.schemaVersion).toBe(1);
    const roles = out.wallets.map((w) => w.role);
    expect(roles).toEqual([
      'master',
      'service.0.agent',
      'service.0.multisig',
      'service.1.agent',
      'service.1.multisig',
    ]);
  });

  it('master has a native balance', () => {
    const out = assembleBalanceV1(makeRaw());
    const master = out.wallets.find((w) => w.role === 'master')!;
    expect(master.address).toBe('0xMASTER');
    expect(master.balances[0].asset).toBe('native');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/api/balance-build.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the balance assembler**

Create `client/src/api/balance-build.ts`:

```typescript
/**
 * Balance response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.3.
 */

import type { GatheredStatusRaw } from './status-build.js';

interface BalanceEntry {
  asset: 'native' | 'bond' | 'reward';
  amountWei: string;
}

export interface WalletEntry {
  role: string;
  address: string;
  balances: BalanceEntry[];
}

export interface BalanceV1Response {
  schemaVersion: 1;
  generatedAt: string;
  wallets: WalletEntry[];
}

export function assembleBalanceV1(raw: GatheredStatusRaw): BalanceV1Response {
  const wallets: WalletEntry[] = [];

  wallets.push({
    role: 'master',
    address: raw.fleet?.masterAddress ?? raw.masterGas.address ?? '0x',
    balances: [{ asset: 'native', amountWei: raw.masterGas.balanceWei ?? '0' }],
  });

  for (const svc of raw.fleet?.services ?? []) {
    wallets.push({
      role: `service.${svc.index}.agent`,
      address: svc.agentAddress ?? '0x',
      balances: [{ asset: 'native', amountWei: '0' }],
    });
    wallets.push({
      role: `service.${svc.index}.multisig`,
      address: svc.safeAddress ?? '0x',
      balances: [
        { asset: 'native', amountWei: '0' },
        { asset: 'bond', amountWei: '0' },
      ],
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: raw.timestamp,
    wallets,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/api/balance-build.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/api/balance-build.ts client/test/api/balance-build.test.ts
git commit -m "client(api): add balance assembler with stable wallet role names"
```

---

## Task 3: History assembler

**Files:**
- Create: `client/src/api/history-build.ts`
- Create: `client/test/api/history-build.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/api/history-build.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { assembleHistoryV1 } from '../../src/api/history-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(): GatheredStatusRaw {
  return {
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '/tmp/jinn.db',
    shutdownState: 'running',
    rpcOk: true,
    rpcChainId: 84532,
    rpcBlockNumber: 1n,
    fleet: { loaded: true, chain: 'base-sepolia', stakingMode: 'standard', services: [], completeCount: 0, stakedLikeCount: 0 },
    masterGas: { address: '0xM', balanceWei: '0', dailyEstimateWei: '0' },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: null },
    activity: {
      counts: { create: 2, deliver: 1 },
      recent: [
        { role: 'create', requestId: 'req_0xAAA', at: '2026-04-14T11:00:00Z', txHash: '0xTX1' },
        { role: 'deliver', requestId: 'req_0xBBB', at: '2026-04-14T11:30:00Z', txHash: '0xTX2' },
      ],
    },
    earningsHint: '',
    nextActions: [],
  } as unknown as GatheredStatusRaw;
}

describe('assembleHistoryV1', () => {
  it('maps activity.recent entries into event kinds', () => {
    const out = assembleHistoryV1(makeRaw(), { limit: 50 });
    expect(out.events).toHaveLength(2);
    const kinds = out.events.map((e) => e.kind);
    expect(kinds).toContain('intent_posted');
    expect(kinds).toContain('delivery_submitted');
  });

  it('honors --limit', () => {
    const out = assembleHistoryV1(makeRaw(), { limit: 1 });
    expect(out.events).toHaveLength(1);
  });

  it('honors --since by filtering older events', () => {
    const out = assembleHistoryV1(makeRaw(), { limit: 50, since: '2026-04-14T11:15:00Z' });
    expect(out.events).toHaveLength(1);
    expect(out.events[0].kind).toBe('delivery_submitted');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/api/history-build.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the history assembler**

Create `client/src/api/history-build.ts`:

```typescript
/**
 * History response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.4.
 */

import type { GatheredStatusRaw } from './status-build.js';

type EventKind =
  | 'intent_posted'
  | 'request_claimed'
  | 'delivery_submitted'
  | 'evaluation_submitted'
  | 'reward_claimed'
  | 'other';

export interface HistoryEvent {
  id: string;
  at: string;
  serviceIndex: number;
  kind: EventKind;
  subkind?: string;
  intentId: string | null;
  txHash: string | null;
  outcome: 'ok' | 'failed' | 'pending';
}

export interface HistoryV1Response {
  schemaVersion: 1;
  generatedAt: string;
  cursor: { next: string | null };
  events: HistoryEvent[];
}

export interface HistoryOptions {
  limit: number;
  since?: string;
  cursor?: string;
}

const ROLE_TO_KIND: Record<string, EventKind> = {
  create: 'intent_posted',
  claim: 'request_claimed',
  deliver: 'delivery_submitted',
  evaluate: 'evaluation_submitted',
  reward: 'reward_claimed',
};

export function assembleHistoryV1(raw: GatheredStatusRaw, opts: HistoryOptions): HistoryV1Response {
  const limit = Math.min(Math.max(opts.limit, 1), 500);
  let source = raw.activity.recent as Array<{
    role?: string;
    requestId?: string;
    at?: string;
    txHash?: string;
  }>;
  if (opts.since) {
    const sinceTs = new Date(opts.since).getTime();
    source = source.filter((e) => (e.at ? new Date(e.at).getTime() >= sinceTs : false));
  }
  const events: HistoryEvent[] = source.slice(0, limit).map((e, i) => ({
    id: `evt_${String(i).padStart(5, '0')}`,
    at: e.at ?? raw.timestamp,
    serviceIndex: 0,
    kind: ROLE_TO_KIND[e.role ?? ''] ?? 'other',
    ...(ROLE_TO_KIND[e.role ?? ''] ? {} : { subkind: e.role }),
    intentId: e.requestId ?? null,
    txHash: e.txHash ?? null,
    outcome: 'ok' as const,
  }));
  return {
    schemaVersion: 1,
    generatedAt: raw.timestamp,
    cursor: { next: events.length === limit ? events[events.length - 1].at : null },
    events,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/api/history-build.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/api/history-build.ts client/test/api/history-build.test.ts
git commit -m "client(api): add history assembler with event kind enum"
```

---

## Task 4: Rewards assembler

**Files:**
- Create: `client/src/api/rewards-build.ts`
- Create: `client/test/api/rewards-build.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/api/rewards-build.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { assembleRewardsV1 } from '../../src/api/rewards-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(): GatheredStatusRaw {
  return {
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '/tmp/jinn.db',
    shutdownState: 'running',
    rpcOk: true,
    rpcChainId: 84532,
    rpcBlockNumber: 1n,
    fleet: {
      loaded: true,
      chain: 'base-sepolia',
      stakingMode: 'standard',
      services: [{ index: 0, step: 'complete', serviceId: 42, staked: true }],
      completeCount: 1,
      stakedLikeCount: 1,
    },
    masterGas: { address: '0xM', balanceWei: '0', dailyEstimateWei: '0' },
    rewards: {
      claimLoopIntervalMs: 600000,
      lastClaimTickAt: '2026-04-14T11:00:00Z',
      pendingStakingRewardsWei: '1500000000000000000',
    },
    activity: { counts: {}, recent: [] },
    earningsHint: '',
    nextActions: [],
  } as unknown as GatheredStatusRaw;
}

describe('assembleRewardsV1', () => {
  it('emits a per-service rewards entry with pending / asset=reward', () => {
    const out = assembleRewardsV1(makeRaw());
    expect(out.schemaVersion).toBe(1);
    expect(out.services).toHaveLength(1);
    const svc = out.services[0];
    expect(svc.index).toBe(0);
    expect(svc.pending).toBe('1500000000000000000');
    expect(svc.asset).toBe('reward');
  });

  it('reports lastClaimTickAt on the top-level', () => {
    const out = assembleRewardsV1(makeRaw());
    expect(out.lastClaimAt).toBe('2026-04-14T11:00:00Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/api/rewards-build.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the rewards assembler**

Create `client/src/api/rewards-build.ts`:

```typescript
/**
 * Rewards response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §2.2 (rewards verb).
 */

import type { GatheredStatusRaw } from './status-build.js';

export interface RewardsV1ServiceEntry {
  index: number;
  pending: string;
  claimed: string;
  asset: 'reward';
}

export interface RewardsV1Response {
  schemaVersion: 1;
  generatedAt: string;
  lastClaimAt: string | null;
  nextCheckpointAt: string | null;
  services: RewardsV1ServiceEntry[];
}

export function assembleRewardsV1(raw: GatheredStatusRaw): RewardsV1Response {
  // Today GatheredStatusRaw reports one aggregate pending sum. Attribute it
  // to service 0 until plan 04 extends the gatherer with per-service reads.
  const total = raw.rewards.pendingStakingRewardsWei ?? '0';
  const services: RewardsV1ServiceEntry[] = (raw.fleet?.services ?? []).map((svc, i) => ({
    index: svc.index,
    pending: i === 0 ? total : '0',
    claimed: '0',
    asset: 'reward' as const,
  }));
  return {
    schemaVersion: 1,
    generatedAt: raw.timestamp,
    lastClaimAt: raw.rewards.lastClaimTickAt ?? null,
    nextCheckpointAt: null,
    services,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/api/rewards-build.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/api/rewards-build.ts client/test/api/rewards-build.test.ts
git commit -m "client(api): add rewards assembler with per-service entries"
```

---

## Task 5: `fleet` verb

**Files:**
- Create: `client/src/cli/commands/fleet.ts`
- Create: `client/test/cli/commands/fleet.test.ts`
- Modify: `client/src/cli/index.ts`

Every introspection verb follows the same shape: gather status → assemble → emit. A shared helper avoids duplicating the gather step.

- [ ] **Step 1: Create a shared gather helper**

Create `client/src/cli/introspection-context.ts`:

```typescript
/**
 * Shared "gather raw status for introspection verbs" helper.
 *
 * Strategy: try the running daemon's HTTP API first (fast, consistent with
 * what the daemon sees). If it's down, fall back to gathering locally via
 * gatherStatusForApi. Both paths return the same GatheredStatusRaw shape.
 */

import type { GatheredStatusRaw } from '../api/status-build.js';
import { gatherStatusForApi, type StatusGatherConfig } from '../api/gather-status.js';
import { loadConfig } from '../config.js';

export async function gatherIntrospectionRaw(opts?: { timeoutMs?: number }): Promise<GatheredStatusRaw> {
  const config = loadConfig();
  const gatherConfig: StatusGatherConfig = {
    earningDir: config.earningDir,
    rpcUrl: config.rpcUrl,
    network: config.network,
    pollIntervalMs: config.pollIntervalMs,
    masterEthDailyEstimateWei: config.masterEthDailyEstimateWei,
    rewardClaimIntervalMs: config.rewardClaimIntervalMs,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
  };
  return gatherStatusForApi(gatherConfig);
}
```

- [ ] **Step 2: Write the failing test for the fleet verb**

Create `client/test/cli/commands/fleet.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => ({
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '/tmp/jinn.db',
    shutdownState: 'running',
    rpcOk: true,
    rpcChainId: 84532,
    rpcBlockNumber: 1n,
    fleet: {
      loaded: true,
      chain: 'base-sepolia',
      stakingMode: 'standard',
      masterAddress: '0xM',
      services: [{ index: 0, step: 'complete', serviceId: 42, agentAddress: '0xA', safeAddress: '0xS', staked: true }],
      completeCount: 1,
      stakedLikeCount: 1,
    },
    masterGas: { address: '0xM', balanceWei: '1', dailyEstimateWei: '1', runwayDaysExcess: 1 },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: null },
    activity: { counts: {}, recent: [] },
    earningsHint: '',
    nextActions: [],
  })),
}));

function makeCtx(): { ctx: CommandContext; writes: string[] } {
  const writes: string[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: () => { /* unused */ },
    env: {},
  };
  return { ctx, writes };
}

describe('fleet command', () => {
  it('emits a fleet v1 response with services array', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet.js');
    const { ctx, writes } = makeCtx();
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services[0].wallets.agent.address).toBe('0xA');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/fleet.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/cli/commands/fleet.js'".

- [ ] **Step 4: Implement the fleet verb**

Create `client/src/cli/commands/fleet.ts`:

```typescript
import type { CommandContext, CommandModule } from '../command.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleFleetV1 } from '../../api/fleet-build.js';

async function run(ctx: CommandContext): Promise<void> {
  const raw = await gatherIntrospectionRaw();
  const payload = assembleFleetV1(raw);
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'fleet',
  summary: 'Per-service detail: wallets, balances, staking, activity, rewards',
  helpText: `Usage: jinn fleet [--json]

Emits a JSON object with one entry per service in the fleet. Use
\`jinn status\` first for liveness; pull \`jinn fleet\` when you
need per-service detail.

Examples:
  jinn fleet --json
  jinn fleet --json | jq '.services[] | select(.attention != null)'
`,
  run,
};

export default command;
```

- [ ] **Step 5: Register fleet in the dispatcher**

In `client/src/cli/index.ts`, add:

```typescript
import fleetCommand from './commands/fleet.js';
```

Include in COMMANDS:

```typescript
  fleetCommand,
```

- [ ] **Step 6: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/fleet.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add client/src/cli/introspection-context.ts client/src/cli/commands/fleet.ts client/test/cli/commands/fleet.test.ts client/src/cli/index.ts
git commit -m "client(cli): add fleet verb with shared introspection gather helper"
```

---

## Task 6: `balance`, `history`, `rewards` verbs (shared pattern)

**Files:**
- Create: `client/src/cli/commands/balance.ts`
- Create: `client/src/cli/commands/history.ts`
- Create: `client/src/cli/commands/rewards.ts`
- Create: `client/test/cli/commands/balance.test.ts`
- Create: `client/test/cli/commands/history.test.ts`
- Create: `client/test/cli/commands/rewards.test.ts`
- Modify: `client/src/cli/index.ts`

These three follow the exact same pattern as `fleet`: gather → assemble → emit. Each gets its own command module and test file.

- [ ] **Step 1: Write the failing test for balance**

Create `client/test/cli/commands/balance.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => ({
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '', shutdownState: '', rpcOk: true, rpcChainId: 1, rpcBlockNumber: 1n,
    fleet: {
      loaded: true, chain: 'base-sepolia', stakingMode: 'standard',
      masterAddress: '0xM',
      services: [{ index: 0, step: 'complete', serviceId: 1, agentAddress: '0xA', safeAddress: '0xS', staked: true }],
      completeCount: 1, stakedLikeCount: 1,
    },
    masterGas: { address: '0xM', balanceWei: '42', dailyEstimateWei: '0' },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: null },
    activity: { counts: {}, recent: [] },
    earningsHint: '', nextActions: [],
  })),
}));

describe('balance command', () => {
  it('emits wallet roles', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/balance.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: [], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {}, env: {},
    };
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.wallets.map((w: { role: string }) => w.role)).toEqual([
      'master', 'service.0.agent', 'service.0.multisig',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/balance.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the balance verb**

Create `client/src/cli/commands/balance.ts`:

```typescript
import type { CommandContext, CommandModule } from '../command.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleBalanceV1 } from '../../api/balance-build.js';

async function run(ctx: CommandContext): Promise<void> {
  const raw = await gatherIntrospectionRaw();
  const payload = assembleBalanceV1(raw);
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'balance',
  summary: 'Flat per-wallet balance map across master and service wallets',
  helpText: `Usage: jinn balance [--json]

Cheaper than \`jinn fleet\` when the only thing you need is current
balances. Each wallet is identified by its stable role name
(master, service.<i>.agent, service.<i>.multisig).

Examples:
  jinn balance --json
  jinn balance --json | jq '.wallets[] | select(.role == "master")'
`,
  run,
};

export default command;
```

- [ ] **Step 4: Write the failing test for history**

Create `client/test/cli/commands/history.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => ({
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '', shutdownState: '', rpcOk: true, rpcChainId: 1, rpcBlockNumber: 1n,
    fleet: { loaded: true, chain: 'base-sepolia', stakingMode: 'standard', services: [], completeCount: 0, stakedLikeCount: 0 },
    masterGas: { address: '0xM', balanceWei: '0', dailyEstimateWei: '0' },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: null },
    activity: {
      counts: {},
      recent: [
        { role: 'create', requestId: 'req_1', at: '2026-04-14T10:00:00Z', txHash: '0xt1' },
        { role: 'deliver', requestId: 'req_2', at: '2026-04-14T11:00:00Z', txHash: '0xt2' },
      ],
    },
    earningsHint: '', nextActions: [],
  })),
}));

describe('history command', () => {
  it('emits events from activity.recent', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/history.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: [], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {}, env: {},
    };
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.events).toHaveLength(2);
  });

  it('respects --limit', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/history.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ['--limit', '1'], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {}, env: {},
    };
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.events).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/history.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 6: Implement the history verb**

Create `client/src/cli/commands/history.ts`:

```typescript
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleHistoryV1 } from '../../api/history-build.js';
import { emitEnvelope } from '../../errors/envelope.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        limit: { type: 'string', default: '50' },
        since: { type: 'string' },
        cursor: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn history --limit 50',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const limit = parseInt(parsed.values.limit as string, 10);
  const raw = await gatherIntrospectionRaw();
  const payload = assembleHistoryV1(raw, {
    limit: Number.isFinite(limit) ? limit : 50,
    since: parsed.values.since as string | undefined,
    cursor: parsed.values.cursor as string | undefined,
  });
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'history',
  summary: 'Recent protocol activity (intents, claims, deliveries, evaluations, rewards)',
  helpText: `Usage: jinn history [--since <ISO-8601>] [--limit <N>] [--json]

Returns recent protocol events from the local activity log. Each
event has a stable \`kind\` enum (intent_posted, request_claimed,
delivery_submitted, evaluation_submitted, reward_claimed, other).

Examples:
  jinn history --limit 20
  jinn history --since 2026-04-14T00:00:00Z --json
  jinn history --json | jq '.events[] | select(.outcome == "failed")'
`,
  run,
};

export default command;
```

- [ ] **Step 7: Write the failing test for rewards**

Create `client/test/cli/commands/rewards.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => ({
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '', shutdownState: '', rpcOk: true, rpcChainId: 1, rpcBlockNumber: 1n,
    fleet: {
      loaded: true, chain: 'base-sepolia', stakingMode: 'standard',
      services: [{ index: 0, step: 'complete', serviceId: 42, staked: true }],
      completeCount: 1, stakedLikeCount: 1,
    },
    masterGas: { address: '0xM', balanceWei: '0', dailyEstimateWei: '0' },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: '2026-04-14T11:00:00Z', pendingStakingRewardsWei: '1000' },
    activity: { counts: {}, recent: [] },
    earningsHint: '', nextActions: [],
  })),
}));

describe('rewards command', () => {
  it('emits a rewards response with lastClaimAt and service entries', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/rewards.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: [], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {}, env: {},
    };
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.lastClaimAt).toBe('2026-04-14T11:00:00Z');
    expect(parsed.services[0].pending).toBe('1000');
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/rewards.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 9: Implement the rewards verb**

Create `client/src/cli/commands/rewards.ts`:

```typescript
import type { CommandContext, CommandModule } from '../command.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { assembleRewardsV1 } from '../../api/rewards-build.js';

async function run(ctx: CommandContext): Promise<void> {
  const raw = await gatherIntrospectionRaw();
  const payload = assembleRewardsV1(raw);
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'rewards',
  summary: 'Earned vs claimed per service, per asset; next checkpoint time',
  helpText: `Usage: jinn rewards [--json]

Returns the current pending reward balance per service, per asset
role. Uses \`reward\` as the asset name; look up the concrete token
in \`jinn version\`.

Examples:
  jinn rewards --json
  jinn rewards --json | jq '.services[] | .pending'
`,
  run,
};

export default command;
```

- [ ] **Step 10: Register balance, history, rewards in the dispatcher**

In `client/src/cli/index.ts`, add imports:

```typescript
import balanceCommand from './commands/balance.js';
import historyCommand from './commands/history.js';
import rewardsCommand from './commands/rewards.js';
```

Include in COMMANDS (after the lifecycle verbs):

```typescript
const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
  initCommand,
  bootstrapCommand,
  fundRequirementsCommand,
  runCommand,
  stopCommand,
  fleetCommand,
  balanceCommand,
  historyCommand,
  rewardsCommand,
];
```

- [ ] **Step 11: Run all three new verb tests**

Run:
```bash
cd client && npx vitest run test/cli/commands/balance.test.ts test/cli/commands/history.test.ts test/cli/commands/rewards.test.ts
```

Expected: PASS (1 + 2 + 1 = 4 tests).

- [ ] **Step 12: Commit**

```bash
git add client/src/cli/commands/balance.ts client/src/cli/commands/history.ts client/src/cli/commands/rewards.ts client/test/cli/commands/balance.test.ts client/test/cli/commands/history.test.ts client/test/cli/commands/rewards.test.ts client/src/cli/index.ts
git commit -m "client(cli): add balance, history, rewards introspection verbs"
```

---

## Task 7: `status` verb — slimmer roll-up shape

**Files:**
- Create: `client/src/cli/commands/status.ts`
- Create: `client/test/cli/commands/status.test.ts`
- Modify: `client/src/cli/index.ts` (register)

The existing `/v1/status` endpoint returns the full mega-response. Plan 03 introduces a slimmer `status` verb that computes the spec §4.1 roll-up from the same raw data. The existing endpoint stays; a follow-up plan can retire it.

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/status.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => ({
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '', shutdownState: 'running', rpcOk: true, rpcChainId: 84532, rpcBlockNumber: 999n,
    fleet: {
      loaded: true, chain: 'base-sepolia', stakingMode: 'standard',
      masterAddress: '0xM',
      services: [
        { index: 0, step: 'complete', serviceId: 42, staked: true },
        { index: 1, step: 'service_staked', serviceId: 43, staked: true },
      ],
      completeCount: 1, stakedLikeCount: 2,
    },
    masterGas: { address: '0xM', balanceWei: '1', dailyEstimateWei: '1', runwayDaysExcess: 100 },
    rewards: { claimLoopIntervalMs: 600000, lastClaimTickAt: null, pendingStakingRewardsWei: '42' },
    activity: { counts: {}, recent: [] },
    earningsHint: '', nextActions: [],
  })),
}));

describe('status command', () => {
  it('emits the §4.1 roll-up shape with daemon/rpc/fleet/earnings/exit', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/status.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: [], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {}, env: {},
    };
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.daemon.state).toBe('running');
    expect(parsed.daemon.network).toBe('testnet');
    expect(parsed.rpc.ok).toBe(true);
    expect(parsed.rpc.chainId).toBe(84532);
    expect(parsed.fleet.size).toBe(2);
    expect(parsed.fleet.complete).toBe(1);
    expect(parsed.fleet.needsAttention).toBe(1); // one service not at complete
    expect(parsed.earnings.pendingTotal).toBe('42');
    expect(parsed.earnings.asset).toBe('reward');
    expect(parsed.exit.blocking).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/status.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the status verb**

Create `client/src/cli/commands/status.ts`:

```typescript
import type { CommandContext, CommandModule } from '../command.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';

interface StatusV1Rollup {
  schemaVersion: 1;
  generatedAt: string;
  daemon: {
    state: 'running' | 'stopped' | 'starting';
    startedAt: string | null;
    phase: string;
    network: 'testnet' | 'mainnet';
  };
  rpc: { ok: boolean; chainId: number; blockNumber: number; error?: string };
  fleet: { size: number; complete: number; needsAttention: number };
  earnings: { pendingTotal: string; asset: 'reward' };
  exit: { blocking: boolean; hint: string | null };
}

async function run(ctx: CommandContext): Promise<void> {
  const raw = await gatherIntrospectionRaw();
  const services = raw.fleet?.services ?? [];
  const complete = services.filter((s) => s.step === 'complete').length;
  const needsAttention = services.length - complete;
  const network: 'testnet' | 'mainnet' = raw.fleet?.chain === 'base' ? 'mainnet' : 'testnet';

  const payload: StatusV1Rollup = {
    schemaVersion: 1,
    generatedAt: raw.timestamp,
    daemon: {
      state: (raw.shutdownState as 'running' | 'stopped' | 'starting') ?? 'stopped',
      startedAt: null,
      phase: network === 'testnet' ? 'phase-1b' : 'phase-0',
      network,
    },
    rpc: {
      ok: raw.rpcOk,
      chainId: raw.rpcChainId ?? 0,
      blockNumber: Number(raw.rpcBlockNumber ?? 0n),
      ...(raw.rpcError ? { error: raw.rpcError } : {}),
    },
    fleet: {
      size: services.length,
      complete,
      needsAttention,
    },
    earnings: {
      pendingTotal: raw.rewards.pendingStakingRewardsWei ?? '0',
      asset: 'reward',
    },
    exit: {
      blocking: needsAttention > 0,
      hint: needsAttention > 0 ? 'Run `jinn fleet` for per-service detail.' : null,
    },
  };
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'status',
  summary: 'Daemon liveness + roll-up (poll this for monitoring; pull detail separately)',
  helpText: `Usage: jinn status [--json]

Emits the §4.1 roll-up: daemon state, RPC reachability, fleet size /
complete / needsAttention counts, pending earnings total, and a
top-level exit.blocking flag.

A monitoring loop needs only these fields:
  - rpc.ok
  - fleet.needsAttention
  - exit.blocking

All of (rpc.ok === true && fleet.needsAttention === 0 && exit.blocking === false)
means healthy. Pull \`jinn fleet\` or \`jinn history\` for detail.

Examples:
  jinn status --json
  jinn status --json | jq '.rpc.ok and (.fleet.needsAttention == 0)'
`,
  run,
};

export default command;
```

- [ ] **Step 4: Register status in the dispatcher**

In `client/src/cli/index.ts`, add:

```typescript
import statusCommand from './commands/status.js';
```

Include in COMMANDS (place `status` immediately after `stop` and before `fleet` so the introspection group reads top-down from summary to detail):

```typescript
const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
  initCommand,
  bootstrapCommand,
  fundRequirementsCommand,
  runCommand,
  stopCommand,
  statusCommand,
  fleetCommand,
  balanceCommand,
  historyCommand,
  rewardsCommand,
];
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/status.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/status.ts client/test/cli/commands/status.test.ts client/src/cli/index.ts
git commit -m "client(cli): add slimmer status verb emitting §4.1 roll-up shape"
```

---

## Task 8: `logs` verb — bounded JSON-per-line stream

**Files:**
- Create: `client/src/cli/commands/logs.ts`
- Create: `client/test/cli/commands/logs.test.ts`
- Modify: `client/src/cli/index.ts` (register)

`logs` v1 is deliberately simple: it reads the SQLite activity table via the existing `Store`, formats each row as a single-line JSON object per the spec §8 log line shape, and writes one line per event to stdout. Bounded by `--limit` (default 100, max 1000). No streaming for v1.

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/logs.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

// Mock Store to avoid touching a real SQLite file.
vi.mock('../../../src/store/store.js', () => ({
  Store: class {
    constructor(_path: string) { /* ignore */ }
    recentActivity(limit: number) {
      return [
        { id: 1, role: 'create', request_id: 'req_1', at: '2026-04-14T10:00:00Z', tx_hash: '0xt1' },
        { id: 2, role: 'deliver', request_id: 'req_2', at: '2026-04-14T11:00:00Z', tx_hash: '0xt2' },
      ].slice(0, limit);
    }
  },
}));

describe('logs command', () => {
  it('writes one JSON object per line', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/logs.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: [], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {}, env: {},
    };
    await cmd.run(ctx);
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(w);
      expect(parsed.ts).toBeDefined();
      expect(parsed.level).toBeDefined();
      expect(parsed.component).toBeDefined();
      expect(parsed.msg).toBeDefined();
    }
  });

  it('respects --limit', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/logs.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ['--limit', '1'], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {}, env: {},
    };
    await cmd.run(ctx);
    expect(writes).toHaveLength(1);
  });
});
```

Note: this test assumes `Store` has a `recentActivity(limit)` method. If the
existing Store interface differs, adapt `logs.ts` to use whatever accessor is
available (the test's mock covers the contract either way).

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/logs.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the logs verb**

Create `client/src/cli/commands/logs.ts`:

```typescript
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { Store } from '../../store/store.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        limit: { type: 'string', default: '100' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn logs --limit 100',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const limit = Math.min(Math.max(parseInt(parsed.values.limit as string, 10) || 100, 1), 1000);
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const rows = (store as unknown as { recentActivity: (n: number) => Array<{ id: number; role: string; request_id: string; at: string; tx_hash?: string }> }).recentActivity(limit);

  for (const row of rows) {
    ctx.writer.write(JSON.stringify({
      ts: row.at,
      level: 'info',
      component: 'activity',
      msg: row.role,
      requestId: row.request_id,
      txHash: row.tx_hash ?? null,
    }) + '\n');
  }
}

const command: CommandModule = {
  name: 'logs',
  summary: 'Structured event log (one JSON object per line)',
  helpText: `Usage: jinn logs [--limit <N>] [--json]

v1: reads the most recent N rows from the local activity store and
emits one JSON object per line matching the spec §8 log line shape
(\`ts\`, \`level\`, \`component\`, \`msg\`).

A later plan will replace this with a streaming transport. For now,
pipe through \`tail\`, \`jq\`, or \`grep\` as normal.

Examples:
  jinn logs --limit 50
  jinn logs --limit 50 | jq 'select(.msg == "deliver")'
`,
  run,
};

export default command;
```

- [ ] **Step 4: Register logs in the dispatcher**

In `client/src/cli/index.ts`:

```typescript
import logsCommand from './commands/logs.js';
```

Include in COMMANDS, after `rewards`:

```typescript
  logsCommand,
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/logs.test.ts
```

Expected: PASS (2 tests). If the test fails because `Store.recentActivity` is not the real method name, see step 6.

- [ ] **Step 6: If Store lacks recentActivity, add a thin wrapper**

Read `client/src/store/store.ts` and find the method that returns recent
activity rows. Add a `recentActivity(limit)` alias if needed, or update
`logs.ts` to call the existing method name. Keep the JSON output shape
the same.

- [ ] **Step 7: Commit**

```bash
git add client/src/cli/commands/logs.ts client/test/cli/commands/logs.test.ts client/src/cli/index.ts client/src/store/store.ts
git commit -m "client(cli): add logs verb reading activity store as JSON per line"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full typecheck**

Run:
```bash
cd client && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run:
```bash
cd client && npx vitest run
```

Expected: all tests pass. Count should be plan 02's total + ~16 new introspection tests (4 assemblers × ~3 tests + 6 verbs × ~1-2 tests).

- [ ] **Step 3: Manual smoke — status verb**

Run:
```bash
cd client && ./bin/jinn status --json | jq '.fleet.needsAttention, .rpc.ok'
```

Expected: a number followed by a boolean, no parse errors.

- [ ] **Step 4: Manual smoke — fleet verb**

Run:
```bash
cd client && ./bin/jinn fleet --json | jq '.services[0] // "no services"'
```

Expected: either a service object or the string "no services".

- [ ] **Step 5: Manual smoke — history verb**

Run:
```bash
cd client && ./bin/jinn history --limit 5 --json | jq '.events | length'
```

Expected: a number ≤ 5.

---

## Spec coverage

| Spec section | Covered by |
|---|---|
| §2.2 status, fleet, balance, history, rewards, logs verbs | Tasks 5–8 |
| §3.1 Wallet role enum | Task 2 (balance assembler), Task 1 (fleet assembler) |
| §3.2 Asset role enum | All assemblers use `native` / `bond` / `reward` only |
| §3.3 Event kind enum | Task 3 (history assembler ROLE_TO_KIND map) |
| §3.4 Attention kind enum | Task 1 (fleet assembler computeAttention) |
| §4.1 status roll-up shape | Task 7 |
| §4.2 fleet shape | Tasks 1, 5 |
| §4.3 balance shape | Tasks 2, 6 |
| §4.4 history shape | Tasks 3, 6 |
| §7.5 Token resolution boundary | Every assembler uses role names, not symbols |
| §8 Log line shape | Task 8 |

Not covered (deferred):
- Real per-service wallet balances — the gatherer returns `0` today; plan 04 extends it.
- Rich `nextCheckpointAt` in rewards — returns `null`; deferred to a later plan.
- HTTP endpoints (`GET /v1/fleet`, `GET /v1/balance`, etc.) — the CLI currently gathers locally. A later plan wires the new assemblers into `client/src/api/server.ts` for remote access.
