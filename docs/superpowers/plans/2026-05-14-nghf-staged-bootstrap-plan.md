# nghf — Staged-bootstrap refactor (Stage 1 + Stage 2 entry points) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `FleetBootstrapper` (`client/src/earning/bootstrap.ts`) so its state machine has two independently re-entrant entry points — `ensureStage1(password)` (identity only — wallet → predicted Safe → ETH funding → Safe deploy → IdentityRegistry mint + setAgentWallet) and `ensureStage1And2(password)` (identity + per-service operator state) — backed by four new fleet-level fields on `FleetStateSchema` and a non-destructive state-file migration that promotes existing `services[0].agent_id` to the fleet level.

**Architecture:** Keep the existing `ServiceState` shape and per-service Stage 2 walk untouched. Add fleet-level `fleet_agent_id`, `fleet_safe_address`, `fleet_identity_registry`, `fleet_stage` fields to `FleetStateSchema`. `ensureStage1` walks the self-bond Safe topology unconditionally (deterministic predict from HD-index-1 EOA → deploy → mint → bind). For greenfield it deploys a Safe; for an existing operator (`services[0].agent_id` already set) the migration promotes the per-service identity to the fleet level non-destructively and ensureStage1 becomes a no-op. `ensureStage1And2` calls `ensureStage1` first, then walks Stage 2 per service (existing standard / self-bond paths). `main.ts`'s `bootstrap()` callsite switches to `ensureStage1And2`. The original `bootstrap(password)` method is preserved as a thin alias to `ensureStage1And2` so `client/src/cli/commands/bootstrap.ts` and `client/src/cli/commands/fleet-scale.ts` don't break.

**Tech Stack:** TypeScript, Zod, Vitest, viem. No new contracts. No new runtime dependencies. Reuses `initPredictedSafe`, `bindAgentWalletToSafe`, `IDENTITY_REGISTRY_ABI`, `IDENTITY_REGISTRY_ADDRESSES`, `deriveAgentAddress`, `deriveAgentSigner`, `walletPrivateKeyAtIndex`.

---

## File structure

**Modify:**
- `client/src/earning/types.ts` — add `FleetStageSchema`, four fleet-level fields on `FleetStateSchema`, update `createDefaultFleetState`.
- `client/src/earning/store.ts` — non-destructive migration in `parseFleetStateJson` / `parseFleetStateOrNull` that promotes `services[0].agent_id` etc. to the fleet level when the loaded file has the legacy shape; ensure `patchFleet` accepts the new fields.
- `client/src/earning/bootstrap.ts` — add `ensureStage1(password)` method; refactor `bootstrap(password)` body into a new private `runFullBootstrap` and re-export under two names: `bootstrap` (kept as alias for back-compat) and `ensureStage1And2`. Insert `ensureStage1` invocation at the top of `ensureStage1And2`. Add Stage-1-specific helpers `stepFleetSafePredict`, `stepFleetSafeDeploy`, `stepFleetIdentityRegister`.
- `client/src/main.ts` — change `bootstrapper.bootstrap(PASSWORD)` call at line 522 to `bootstrapper.ensureStage1And2(PASSWORD)`.

**Create:**
- `client/test/earning/staged-bootstrap-migration.test.ts` — migration coverage (existing operator).
- `client/test/earning/staged-bootstrap-stage1.test.ts` — Stage 1 walk (clean state, idempotency, ETH gate).
- `client/test/earning/staged-bootstrap-stage1and2.test.ts` — full walk (clean state, two-Safe topology in standard mode, resume).

Existing tests preserved: `client/test/earning/bootstrap.test.ts` keeps calling `bootstrapper.bootstrap()`, which now aliases `ensureStage1And2` (back-compat).

---

## Task 1: Add the failing schema test for the four fleet-level fields

**Files:**
- Modify: `client/test/earning/types.test.ts`

- [ ] **Step 1: Add a describe block for the new fleet-level identity fields**

Append to `client/test/earning/types.test.ts`:

```typescript
import { FleetStateSchema, createDefaultFleetState } from '../../src/earning/types.js';

describe('FleetStateSchema — staged-bootstrap fields (nghf)', () => {
  it('defaults to fleet_stage="none" and null fleet identity fields', () => {
    const state = createDefaultFleetState('base');
    expect(state.fleet_agent_id).toBeNull();
    expect(state.fleet_safe_address).toBeNull();
    expect(state.fleet_identity_registry).toBeNull();
    expect(state.fleet_stage).toBe('none');
  });

  it('parses persisted state with the new fleet fields populated', () => {
    const parsed = FleetStateSchema.parse({
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base',
      staking_mode: 'standard',
      services: [],
      updated_at: new Date().toISOString(),
      fleet_agent_id: '42',
      fleet_safe_address: '0x2222222222222222222222222222222222222222',
      fleet_identity_registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      fleet_stage: 'stage1',
    });
    expect(parsed.fleet_agent_id).toBe('42');
    expect(parsed.fleet_safe_address).toBe('0x2222222222222222222222222222222222222222');
    expect(parsed.fleet_identity_registry).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(parsed.fleet_stage).toBe('stage1');
  });

  it('accepts legacy state without the new fleet fields and supplies defaults', () => {
    const parsed = FleetStateSchema.parse({
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base',
      staking_mode: 'standard',
      services: [],
      updated_at: new Date().toISOString(),
    });
    expect(parsed.fleet_agent_id).toBeNull();
    expect(parsed.fleet_safe_address).toBeNull();
    expect(parsed.fleet_identity_registry).toBeNull();
    expect(parsed.fleet_stage).toBe('none');
  });

  it('rejects an unknown fleet_stage enumerant', () => {
    expect(() =>
      FleetStateSchema.parse({
        master_address: null,
        chain: 'base',
        staking_mode: 'standard',
        services: [],
        updated_at: new Date().toISOString(),
        fleet_stage: 'stage2-only',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
cd client && yarn vitest run test/earning/types.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL with errors about `fleet_agent_id`, `fleet_safe_address`, `fleet_identity_registry`, `fleet_stage` being undefined on the parsed shape.

- [ ] **Step 3: Commit failing test**

```bash
git add client/test/earning/types.test.ts
git commit -m "test(nghf): failing schema test for fleet-level Stage 1 fields"
```

---

## Task 2: Add the fleet-level identity fields to `FleetStateSchema`

**Files:**
- Modify: `client/src/earning/types.ts`

- [ ] **Step 1: Add the `FleetStageSchema` enum**

Insert after `StakingModeSchema` (around `client/src/earning/types.ts:7`):

```typescript
// ── Fleet bootstrap stage marker (nghf) ─────────────────────────────────────
//
// `none`         — fresh fleet; no identity provisioned yet.
// `stage1`       — fleet-level identity is provisioned (Safe deployed, agentId
//                  minted, setAgentWallet bound). Builder-only completion.
// `stage1_and_2` — at least one service row has reached `complete` /
//                  `safe_binding_pending`. Full operator completion.
//
// See docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md §5.1
// and docs/superpowers/specs/2026-05-14-nghf-staged-bootstrap-fit-findings.md.
export const FleetStageSchema = z.enum(['none', 'stage1', 'stage1_and_2']);
export type FleetStage = z.infer<typeof FleetStageSchema>;
```

- [ ] **Step 2: Extend `FleetStateSchema` with the four fleet-level fields**

Replace the existing `FleetStateSchema` definition (`client/src/earning/types.ts:97-103`) with:

```typescript
export const FleetStateSchema = z.object({
  master_address: z.string().nullable(),
  chain: z.enum(['base', 'base-sepolia']),
  staking_mode: StakingModeSchema.default('standard'),
  services: z.array(ServiceStateSchema),
  updated_at: z.string(),

  // ── Fleet-level Stage 1 identity (nghf) ─────────────────────────────────
  //
  // These four fields are added so a fleet can carry ERC-8004 identity
  // independently of any service row, enabling builder-only (services: [])
  // operation. Stage 1 always uses the self-bond Safe topology
  // (deterministic prediction from the HD-index-1 agent EOA) regardless of
  // the eventual staking mode — in standard mode, Stage 2 later creates a
  // separate staking Safe via `distributor.stake()`, so dual-role operators
  // end up with two Safes. See findings §8 (Option A).
  fleet_agent_id: z.string().nullable().optional().default(null),
  fleet_safe_address: z.string().nullable().optional().default(null),
  fleet_identity_registry: z.string().nullable().optional().default(null),
  fleet_stage: FleetStageSchema.optional().default('none'),
});
```

- [ ] **Step 3: Update `createDefaultFleetState`**

Replace the existing factory (`client/src/earning/types.ts:109-117`) with:

```typescript
export function createDefaultFleetState(chain: 'base' | 'base-sepolia' = 'base'): FleetState {
  return {
    master_address: null,
    chain,
    staking_mode: 'standard',
    services: [],
    updated_at: new Date().toISOString(),
    fleet_agent_id: null,
    fleet_safe_address: null,
    fleet_identity_registry: null,
    fleet_stage: 'none',
  };
}
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
cd client && yarn vitest run test/earning/types.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd client && yarn typecheck 2>&1 | tail -10
```

Expected: clean (the new fields are optional with defaults, so existing call sites continue to compile).

- [ ] **Step 6: Commit**

```bash
git add client/src/earning/types.ts
git commit -m "feat(nghf): add four fleet-level Stage 1 fields to FleetStateSchema"
```

---

## Task 3: Add the failing migration test — promote existing services[0].agent_id

**Files:**
- Create: `client/test/earning/staged-bootstrap-migration.test.ts`

This is the load-bearing migration test. Existing testnet operators have `services[0].agent_id` populated and no `fleet_*` fields. The store load must promote those fields to the fleet level non-destructively (does not delete `services[0].agent_id`, does not deploy a new Safe).

- [ ] **Step 1: Create the test file**

Create `client/test/earning/staged-bootstrap-migration.test.ts`:

```typescript
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetStateStore } from '../../src/earning/store.js';

describe('FleetStateStore — legacy state-file migration (nghf)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('promotes services[0].agent_id to fleet_agent_id when fleet_* is missing', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const legacy = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [
        {
          index: 1,
          agent_address: '0xAAAA000000000000000000000000000000000001',
          safe_address: '0xBBBB000000000000000000000000000000000001',
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
          agent_id: '777',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
      updated_at: new Date().toISOString(),
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(legacy, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    expect(loaded.fleet_agent_id).toBe('777');
    expect(loaded.fleet_safe_address).toBe('0xBBBB000000000000000000000000000000000001');
    expect(loaded.fleet_identity_registry).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(loaded.fleet_stage).toBe('stage1_and_2');

    // Non-destructive: original per-service identity is preserved.
    expect(loaded.services[0].agent_id).toBe('777');
    expect(loaded.services[0].safe_address).toBe('0xBBBB000000000000000000000000000000000001');
    expect(loaded.services[0].identity_registry_address).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(loaded.services[0].safe_bound_to_agent).toBe(true);
  });

  it('promotes to fleet_stage="stage1" when services[0] has agent_id but no service_id (mid-walk)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const legacy = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [
        {
          index: 1,
          agent_address: '0xAAAA000000000000000000000000000000000001',
          safe_address: '0xBBBB000000000000000000000000000000000001',
          service_id: null,
          mech_address: null,
          staking_address: null,
          step: 'awaiting_stake',
          error: null,
          agent_id: '99',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'bb'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
      updated_at: new Date().toISOString(),
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(legacy, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    expect(loaded.fleet_agent_id).toBe('99');
    expect(loaded.fleet_safe_address).toBe('0xBBBB000000000000000000000000000000000001');
    expect(loaded.fleet_stage).toBe('stage1');
  });

  it('leaves fleet_stage="none" when no services and no fleet identity', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const legacy = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [],
      updated_at: new Date().toISOString(),
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(legacy, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    expect(loaded.fleet_agent_id).toBeNull();
    expect(loaded.fleet_safe_address).toBeNull();
    expect(loaded.fleet_stage).toBe('none');
  });

  it('leaves fleet_stage="stage1_and_2" when services[0] is complete but legacy lacks agent_id (pre-j07)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const legacy = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [
        {
          index: 1,
          agent_address: '0xAAAA000000000000000000000000000000000001',
          safe_address: '0xBBBB000000000000000000000000000000000001',
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
        },
      ],
      updated_at: new Date().toISOString(),
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(legacy, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    // No agent_id to promote — fleet identity stays null but stage reflects
    // operator completion so ensureStage1And2 does not re-deploy a Safe.
    expect(loaded.fleet_agent_id).toBeNull();
    expect(loaded.fleet_stage).toBe('stage1_and_2');
  });

  it('preserves existing fleet_* fields when both fleet and service identity coexist', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-mig-'));
    dirs.push(earningDir);
    await mkdir(earningDir, { recursive: true });

    const recent = {
      master_address: '0x1111111111111111111111111111111111111111',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services: [
        {
          index: 1,
          agent_address: '0xAAAA000000000000000000000000000000000001',
          safe_address: '0xBBBB000000000000000000000000000000000001',
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
          agent_id: '777',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
      updated_at: new Date().toISOString(),
      fleet_agent_id: '999',
      fleet_safe_address: '0xFFFF000000000000000000000000000000000001',
      fleet_identity_registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      fleet_stage: 'stage1_and_2',
    };

    await writeFile(path.join(earningDir, 'earning_state.json'), JSON.stringify(recent, null, 2));

    const store = new FleetStateStore(earningDir);
    const loaded = await store.load('base-sepolia');

    expect(loaded.fleet_agent_id).toBe('999');
    expect(loaded.fleet_safe_address).toBe('0xFFFF000000000000000000000000000000000001');
    expect(loaded.fleet_stage).toBe('stage1_and_2');
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
cd client && yarn vitest run test/earning/staged-bootstrap-migration.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: FAIL — `fleet_agent_id` is `null` (Zod default) on legacy state, not promoted.

- [ ] **Step 3: Commit failing test**

```bash
git add client/test/earning/staged-bootstrap-migration.test.ts
git commit -m "test(nghf): failing migration test — promote services[0].agent_id to fleet"
```

---

## Task 4: Implement the non-destructive state-file migration in `store.ts`

**Files:**
- Modify: `client/src/earning/store.ts`

The migration runs every time `parseFleetStateJson` parses a file. It is idempotent: a state file that already has `fleet_*` set is left alone; a legacy file gets `fleet_*` filled in from `services[0]`.

- [ ] **Step 1: Add the migration helper**

In `client/src/earning/store.ts`, insert this helper immediately above `parseFleetStateJson` (around line 81):

```typescript
/**
 * Non-destructive migration: when a state file is loaded with the legacy
 * shape (no `fleet_*` fields), promote `services[0]`'s identity to the
 * fleet level. Existing operators upgrading to nghf get a coherent
 * fleet-level identity without re-minting or re-deploying their Safe.
 *
 * Rules:
 *   - If the parsed file already has `fleet_agent_id` set (nullable), do
 *     nothing — recent state already has fleet identity.
 *   - Else if `services[0].agent_id` is set, copy `agent_id`,
 *     `safe_address`, `identity_registry_address` to the fleet level.
 *     Set `fleet_stage = 'stage1_and_2'` if any service has reached
 *     `complete`/`safe_binding_pending`, else `stage1`.
 *   - Else if any service is operational (`complete`/`safe_binding_pending`)
 *     but no agent_id exists yet (pre-j07), set `fleet_stage = 'stage1_and_2'`
 *     without populating fleet_* identity — these operators run through the
 *     legacy agent-id backfill path in main.ts and ensureStage1 becomes a
 *     no-op (`stage1_and_2 >= stage1`).
 *   - Else leave `fleet_stage = 'none'` (fresh fleet).
 *
 * Per-service identity fields on `services[]` are NOT cleared. The promotion
 * is non-destructive and idempotent.
 *
 * See docs/superpowers/specs/2026-05-14-nghf-staged-bootstrap-fit-findings.md §5.
 */
import type { FleetState as FleetStateT } from './types.js';

function applyNghfMigration(state: FleetStateT): FleetStateT {
  if (state.fleet_agent_id) return state;

  const firstService = state.services[0];
  const anyOperational = state.services.some(
    (s) => s.step === 'complete' || s.step === 'safe_binding_pending',
  );

  if (firstService?.agent_id) {
    return {
      ...state,
      fleet_agent_id: firstService.agent_id,
      fleet_safe_address: firstService.safe_address ?? state.fleet_safe_address ?? null,
      fleet_identity_registry:
        firstService.identity_registry_address ?? state.fleet_identity_registry ?? null,
      fleet_stage: anyOperational ? 'stage1_and_2' : 'stage1',
    };
  }

  if (anyOperational) {
    return {
      ...state,
      fleet_stage: 'stage1_and_2',
    };
  }

  return state;
}
```

- [ ] **Step 2: Apply the migration in `parseFleetStateJson`**

Replace the existing `parseFleetStateJson` (around `client/src/earning/store.ts:82-93`) with:

```typescript
/** Parse fleet JSON without side effects (for status / read-only tools). */
export function parseFleetStateJson(raw: string): FleetState | null {
  try {
    const parsed = JSON.parse(raw);
    const result = FleetStateSchema.safeParse(parsed);
    if (result.success) {
      return applyNghfMigration(result.data);
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Run the migration tests — expect PASS**

```bash
cd client && yarn vitest run test/earning/staged-bootstrap-migration.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: PASS (all five cases).

- [ ] **Step 4: Run the whole earning test directory to confirm no regressions**

```bash
cd client && yarn vitest run test/earning --reporter=verbose 2>&1 | tail -30
```

Expected: PASS for all existing earning tests.

- [ ] **Step 5: Typecheck**

```bash
cd client && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/earning/store.ts
git commit -m "feat(nghf): non-destructive migration — promote services[0].agent_id to fleet"
```

---

## Task 5: Failing Stage 1 walk test (greenfield)

**Files:**
- Create: `client/test/earning/staged-bootstrap-stage1.test.ts`

This test covers `ensureStage1` for a fresh fleet on standard mode. It mocks all chain-touching helpers (predict Safe, deploy Safe, mint, bind) and asserts the resulting state-file shape: `fleet_stage='stage1'`, `fleet_agent_id` set, `fleet_safe_address` set, `services: []`.

- [ ] **Step 1: Create the test**

Create `client/test/earning/staged-bootstrap-stage1.test.ts`:

```typescript
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  deriveAgentAddress,
} from '../../src/earning/wallet.js';

const PREDICTED_SAFE = '0xBBBB000000000000000000000000000000000001';
const FLEET_AGENT_ID = '1234';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

function buildBootstrapper(earningDir: string): FleetBootstrapper {
  return new FleetBootstrapper({
    earningDir,
    chain: 'base',
    rpcUrl: 'http://127.0.0.1:8545',
    stakingMode: 'standard',
  });
}

describe('FleetBootstrapper.ensureStage1 — greenfield walk (nghf)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('pauses at ETH funding when agent EOA balance is 0 (no OLAS required)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const bootstrapper = buildBootstrapper(earningDir);

    // 0 balance on every getBalance call (master + agent EOA).
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    // Stage 1 funding gate is ETH-only.
    expect(result.message.toLowerCase()).toContain('eth');
    expect(result.fleet_state.fleet_stage).toBe('none');
    expect(result.fleet_state.services).toEqual([]);
  });

  it('walks wallet → predict Safe → deploy Safe → mint → bind, ending at fleet_stage="stage1"', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = buildBootstrapper(earningDir);

    // Sufficient ETH balance for Stage 1.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n, // 0.05 ETH
    );
    // Safe code lookup returns "0x" (not yet deployed) on the first call,
    // and bytecode after stepFleetSafeDeploy ran.
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );

    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(result.fleet_state.fleet_agent_id).toBe(FLEET_AGENT_ID);
    expect(result.fleet_state.fleet_safe_address).toBe(PREDICTED_SAFE);
    expect(result.fleet_state.fleet_identity_registry).toBe(IDENTITY_REGISTRY);
    // No service rows created by Stage 1.
    expect(result.fleet_state.services).toEqual([]);

    // Predict + deploy + register each called exactly once.
    expect((bootstrapper as any).stepFleetSafePredict).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepFleetSafeDeploy).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepFleetIdentityRegister).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — re-running ensureStage1 after stage1 is complete is a no-op', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);
    await store.patchFleet({
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: PREDICTED_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1',
    });

    const bootstrapper = buildBootstrapper(earningDir);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    const deploySpy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy');
    const registerSpy = vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister');

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(predictSpy).not.toHaveBeenCalled();
    expect(deploySpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('resumes from mid-Stage-1 (Safe predicted but not deployed)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);
    await store.patchFleet({
      fleet_safe_address: PREDICTED_SAFE,
      fleet_stage: 'none',
    });

    const bootstrapper = buildBootstrapper(earningDir);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0x'); // not deployed

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => store.load('base'));
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    // Predict was skipped (already had fleet_safe_address).
    expect(predictSpy).not.toHaveBeenCalled();
    expect((bootstrapper as any).stepFleetSafeDeploy).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepFleetIdentityRegister).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
cd client && yarn vitest run test/earning/staged-bootstrap-stage1.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: FAIL — `ensureStage1` does not exist on `FleetBootstrapper`.

- [ ] **Step 3: Commit failing test**

```bash
git add client/test/earning/staged-bootstrap-stage1.test.ts
git commit -m "test(nghf): failing Stage 1 walk tests (greenfield + idempotency + resume)"
```

---

## Task 6: Implement `ensureStage1` in `FleetBootstrapper`

**Files:**
- Modify: `client/src/earning/bootstrap.ts`

`ensureStage1` walks the fleet-level identity path. It uses HD-index-1 as the agent EOA (same slot the first service uses, so for self-bond Stage 2 the two Safes converge to one). On standard mode, Stage 2 later derives its own Safe via `distributor.stake()` — that's the two-Safe topology the spec acknowledges.

- [ ] **Step 1: Add imports / constants if missing**

At `client/src/earning/bootstrap.ts:50` add `walletPrivateKeyAtIndex` is already imported. Confirm `bindAgentWalletToSafe`, `initPredictedSafe`, `IDENTITY_REGISTRY_ABI`, `IDENTITY_REGISTRY_ADDRESSES`, `deriveAgentSigner`, `deriveAgentAddress` are already imported — they are (see lines 22-23, 40-42, 49-52). No new imports needed.

- [ ] **Step 2: Add the public `ensureStage1` method**

Insert the new method immediately above the existing `bootstrap` method (around `client/src/earning/bootstrap.ts:239`):

```typescript
  /**
   * Stage 1 — Identity (universal). Walks: wallet → predict Safe (from
   * HD-index-1 agent EOA) → ETH funding gate → deploy Safe → mint agentId
   * + setAgentWallet via ERC-1271. Idempotent and re-entrant. Does NOT
   * touch service rows or staking — those belong to Stage 2.
   *
   * Fleet-level fields written:
   *   - fleet_safe_address (after predict)
   *   - fleet_agent_id, fleet_identity_registry, fleet_stage='stage1'
   *     (after mint + bind)
   *
   * Funding gate: requires ETH on the master EOA only (no OLAS). On testnet,
   * the existing CDP faucet loop drains as usual when `autoTestnetFaucet`
   * is enabled.
   *
   * See docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md §5.1.
   */
  async ensureStage1(password: string): Promise<FleetBootstrapResult> {
    // Legacy keystore migration (same as bootstrap()).
    if (!this.store.hasMnemonicKeystore() && this.store.hasLegacyKeystore()) {
      await this.store.migrateLegacyFiles();
    }

    let state = await this.store.load(this.chain);

    // Short-circuit if Stage 1 is already complete (or beyond).
    if (state.fleet_stage === 'stage1' || state.fleet_stage === 'stage1_and_2') {
      // Even when stage marker says complete, fleet identity may be empty for
      // pre-j07 operators (`stage1_and_2` is set by the migration for
      // services-complete-but-no-agent_id operators). In that case we leave
      // Stage 1 alone — the legacy backfill in main.ts handles those rows
      // and a future ensureStage1 call after backfill will promote.
      return {
        ok: true,
        fleet_state: state,
        message:
          state.fleet_agent_id !== null
            ? `Stage 1 already complete (fleet_agent_id=${state.fleet_agent_id}, fleet_safe=${state.fleet_safe_address}).`
            : 'Stage 1 marker present but fleet identity is empty (legacy operator). Skipping.',
      };
    }

    try {
      state = await this.ensureMasterWallet(state, password);

      // Stage 1 funding gate — ETH only (no OLAS). Self-bond Stage 1 needs:
      // master ETH for the agent-funding transfer + agent ETH for Safe deploy
      // + Safe deploy gas + ERC-8004 register + setAgentWallet (two agent EOA
      // txs through the IdentityRegistry contract). 0.005 ETH is the
      // configured `minEoaGasEth` floor; bump by 2x for safety.
      const requiredMasterEth =
        this.config.minEoaGasEth * STANDARD_MASTER_BOOTSTRAP_MULTIPLIER;
      const masterAddress = state.master_address!;
      const masterBalance = await this.publicClient.getBalance({
        address: masterAddress as Address,
      });

      if (masterBalance < requiredMasterEth) {
        const shortfall = requiredMasterEth - masterBalance;
        return {
          ok: false,
          fleet_state: state,
          message: `Your master wallet needs more ETH (currently ${formatEther(masterBalance)} ETH, need ${formatEther(shortfall)} ETH more) to complete Stage 1. Please send ETH to: ${masterAddress}`,
          funding: {
            master_address: masterAddress,
            eth_required: shortfall.toString(),
            eth_balance: masterBalance.toString(),
          },
        };
      }

      const mnemonic = await this.loadExistingMnemonic(state, password);

      // Step 1: predict fleet Safe from HD-index-1 agent EOA.
      if (!state.fleet_safe_address) {
        state = await this.stepFleetSafePredict(state, mnemonic);
      }

      // Step 2: deploy fleet Safe if bytecode absent.
      const safeCode = await this.publicClient.getCode({
        address: getAddress(state.fleet_safe_address!) as Address,
      });
      if (safeCode === undefined || safeCode === '0x') {
        state = await this.stepFleetSafeDeploy(state, mnemonic);
      }

      // Step 3: mint agentId + bind Safe via setAgentWallet.
      if (!state.fleet_agent_id) {
        state = await this.stepFleetIdentityRegister(state, mnemonic);
      } else if (state.fleet_stage !== 'stage1' && state.fleet_stage !== 'stage1_and_2') {
        // Identity was minted but stage marker is stale; advance it.
        state = await this.store.patchFleet({ fleet_stage: 'stage1' });
      }

      return {
        ok: true,
        fleet_state: state,
        message: `Stage 1 complete. fleet_agent_id=${state.fleet_agent_id}, fleet_safe=${state.fleet_safe_address}.`,
      };
    } catch (error) {
      const { summary, hint, rawMessage } = formatBootstrapOperatorMessage(error);
      const userMessage = hint !== undefined ? `${summary}\nHint: ${hint}` : summary;
      if (this.debug) {
        console.error(`[fleet-bootstrap] ensureStage1 failed:`, error);
      } else {
        console.error(`[fleet-bootstrap] ${summary}`);
        if (hint !== undefined) console.error(`Hint: ${hint}`);
        if (rawMessage && rawMessage !== summary) {
          console.error(`[fleet-bootstrap] raw: ${rawMessage.split('\n')[0]}`);
        }
      }
      return {
        ok: false,
        fleet_state: state,
        message: userMessage,
        rawErrorMessage: rawMessage,
      };
    }
  }
```

- [ ] **Step 3: Add the three Stage-1 step helpers**

Insert these private methods immediately after `ensureMasterWallet` (around `client/src/earning/bootstrap.ts:533`):

```typescript
  // ── Stage 1: fleet-level identity steps (nghf) ────────────────────────

  /** Deterministic Safe predict from the HD-index-1 agent EOA. */
  private async stepFleetSafePredict(
    state: FleetState,
    mnemonic: string,
  ): Promise<FleetState> {
    const agentAddress = deriveAgentAddress(mnemonic, 1);
    const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);

    console.error(
      `[fleet-bootstrap] Stage 1: predicting fleet Safe (owner=${agentAddress})`,
    );
    const { address } = await initPredictedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      owners: [agentAddress],
      threshold: 1,
    });

    void state;
    return this.store.patchFleet({ fleet_safe_address: getAddress(address) });
  }

  /** Deploy the predicted fleet Safe. Funds the agent EOA from master if needed. */
  private async stepFleetSafeDeploy(
    state: FleetState,
    mnemonic: string,
  ): Promise<FleetState> {
    const agentAddress = deriveAgentAddress(mnemonic, 1);
    const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);
    const agentSigner = deriveAgentSigner(mnemonic, 1);
    const fleetSafe = state.fleet_safe_address!;

    // Fund agent EOA so it can pay for Safe deploy + setAgentWallet gas.
    // 0.01 ETH covers Safe deploy (~250k gas) + register (~80k) + setAgentWallet
    // (~200k) at testnet gas prices comfortably.
    const STAGE1_AGENT_ETH = 10_000_000_000_000_000n; // 0.01 ETH
    const masterAccount = deriveMasterSigner(mnemonic);
    const masterWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, masterAccount);
    const agentBalance = await this.publicClient.getBalance({
      address: getAddress(agentAddress) as Address,
    });
    if (agentBalance < STAGE1_AGENT_ETH) {
      const fundAmount = STAGE1_AGENT_ETH - agentBalance;
      console.error(
        `[fleet-bootstrap] Stage 1: funding fleet agent EOA with ${fundAmount} wei from master`,
      );
      const fundHash = await viemSendTransactionWithRetry(
        masterWallet,
        this.publicClient,
        {
          account: masterAccount as Account,
          to: addr(agentAddress),
          value: fundAmount,
        },
      );
      await waitForTransactionReceiptWithRetry(this.publicClient, fundHash);
    }

    console.error(`[fleet-bootstrap] Stage 1: deploying fleet Safe at ${fleetSafe}`);
    const { safe } = await initPredictedSafe({
      rpcUrl: this.config.rpcUrl,
      signerKey: agentKey,
      owners: [agentAddress],
      threshold: 1,
    });
    const deployTx = await safe.createSafeDeploymentTransaction();
    const agentWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, agentSigner);
    const deployHash = await viemSendTransactionWithRetry(
      agentWallet,
      this.publicClient,
      {
        account: agentSigner as Account,
        to: deployTx.to as Address,
        value: BigInt(deployTx.value),
        data: deployTx.data as Hex,
      },
    );
    const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, deployHash);
    if (receipt.status !== 'success') {
      throw new Error(`Fleet Safe deployment tx failed: ${deployHash}`);
    }
    const deployedCode = await this.publicClient.getCode({
      address: getAddress(fleetSafe) as Address,
    });
    if (deployedCode === undefined || deployedCode === '0x') {
      throw new Error(`Fleet Safe deployment succeeded but no code at ${fleetSafe}`);
    }
    console.error(`[fleet-bootstrap] Stage 1: fleet Safe deployed (tx=${deployHash})`);

    return this.store.load(this.chain);
  }

  /** Mint the fleet agentId + bind Safe via setAgentWallet (ERC-1271). */
  private async stepFleetIdentityRegister(
    state: FleetState,
    mnemonic: string,
  ): Promise<FleetState> {
    const identityRegistry =
      this.config.identityRegistry ?? IDENTITY_REGISTRY_ADDRESSES[this.config.chainId];
    if (!identityRegistry) {
      throw new Error(
        `IdentityRegistry address not configured for chainId=${this.config.chainId}.`,
      );
    }

    const fleetSafe = state.fleet_safe_address!;
    const agentSigner = deriveAgentSigner(mnemonic, 1);
    const agentWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, agentSigner);

    // Mint agentId — empty agent URI for v0 (matches stepRegisterAgent §6.1 in spec).
    const registerData = encodeFunctionData({
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'register',
      args: [''],
    }) as Hex;

    console.error(
      `[fleet-bootstrap] Stage 1: minting fleet agentId ` +
        `(IdentityRegistry=${identityRegistry}, agentEOA=${agentSigner.address})`,
    );
    const mintTxHash = await viemSendTransactionWithRetry(
      agentWallet,
      this.publicClient,
      {
        account: agentSigner as Account,
        to: addr(identityRegistry),
        data: registerData,
      },
    );
    const mintReceipt = await waitForTransactionReceiptWithRetry(this.publicClient, mintTxHash);
    if (mintReceipt.status !== 'success') {
      throw new Error(`Fleet IdentityRegistry.register() failed: ${mintTxHash}`);
    }
    const fleetAgentId = this.parseAgentIdFromReceipt(mintReceipt, identityRegistry);
    if (fleetAgentId === null) {
      throw new Error(
        `Fleet IdentityRegistry.register() succeeded but Registered event missing (tx=${mintTxHash})`,
      );
    }

    // Persist agentId IMMEDIATELY so a crash between mint and bind doesn't lose it.
    await this.store.patchFleet({
      fleet_agent_id: fleetAgentId,
      fleet_identity_registry: getAddress(identityRegistry),
    });

    // Bind the Safe via setAgentWallet (ERC-1271).
    console.error(
      `[fleet-bootstrap] Stage 1: binding fleet Safe ${fleetSafe} to agentId=${fleetAgentId}`,
    );
    const bindResult = await bindAgentWalletToSafe({
      identityRegistryAddress: addr(identityRegistry),
      agentId: BigInt(fleetAgentId),
      safeAddress: addr(fleetSafe),
      agentEoaAccount: agentSigner,
      agentEoaWalletClient: agentWallet,
      publicClient: this.publicClient,
      chainId: this.config.chainId,
    });
    console.error(
      `[fleet-bootstrap] Stage 1: setAgentWallet succeeded (tx=${bindResult.txHash})`,
    );

    return this.store.patchFleet({ fleet_stage: 'stage1' });
  }
```

- [ ] **Step 4: Confirm `parseAgentIdFromReceipt` is reachable**

This helper already exists on `FleetBootstrapper` (`client/src/earning/bootstrap.ts:1197` references `this.parseAgentIdFromReceipt`). No new helper needed.

- [ ] **Step 5: Typecheck**

```bash
cd client && yarn typecheck 2>&1 | tail -20
```

Expected: clean.

- [ ] **Step 6: Run the Stage 1 walk test — expect PASS**

```bash
cd client && yarn vitest run test/earning/staged-bootstrap-stage1.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: PASS for all four cases (ETH gate, full walk, idempotency, mid-Stage-1 resume).

- [ ] **Step 7: Commit**

```bash
git add client/src/earning/bootstrap.ts
git commit -m "feat(nghf): ensureStage1(password) — fleet-level identity walk"
```

---

## Task 7: Failing test for `ensureStage1And2` (clean state + two-Safe topology)

**Files:**
- Create: `client/test/earning/staged-bootstrap-stage1and2.test.ts`

This is the load-bearing combined-walk test. It asserts:
- Clean fleet `ensureStage1And2` walks Stage 1 then Stage 2.
- `fleet_safe_address !== services[0].safe_address` in standard mode (two-Safe topology).
- `fleet_agent_id === services[0].agent_id` (one agentId, reused — until per-service mint runs; see below).
- Existing operator (migrated state) does not re-deploy a Safe.
- Re-running `ensureStage1And2` on a complete fleet is a no-op.

Note: the spec §5.1 (amended) says the fleet agentId is the single identity. After Stage 1 mints the fleet agentId, the existing per-service `stepRegisterAgent` still mints a SECOND agentId on the staking Safe (Stage 2) — that's the legacy mint already shipped. To align with the spec's "one agentId" wording, **Task 8 will short-circuit the per-service mint when `fleet_agent_id` is set**, copying the fleet identity to the service row. The test below pins that behavior.

- [ ] **Step 1: Create the test**

Create `client/test/earning/staged-bootstrap-stage1and2.test.ts`:

```typescript
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  deriveMasterAddress,
  deriveAgentAddress,
} from '../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../src/earning/types.js';

const FLEET_SAFE = '0xFFFF000000000000000000000000000000000001';
const FLEET_AGENT_ID = '7777';
const STAKING_SAFE = '0xAAAA000000000000000000000000000000000002';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

describe('FleetBootstrapper.ensureStage1And2 — combined walk (nghf)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('clean state — walks Stage 1, then Stage 2; standard mode produces two distinct Safes', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      100_000_000_000_000_000n, // 0.1 ETH
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    // Stage 1 mocks.
    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: FLEET_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () =>
      store.load('base'),
    );
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    // Stage 2 mocks — standard mode produces a separate staking Safe.
    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          safe_address: STAKING_SAFE,
          service_id: 99,
          staking_address: '0x0000000000000000000000000000000000000003',
          step: 'staked',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          mech_address: '0x0000000000000000000000000000000000000004',
          step: 'mech_deployed',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepRegisterAgent').mockImplementation(
      async (_s: any, _m: any, index: number) => {
        // Reuse fleet identity on the service row (Task 8 enforces this).
        const fleet = await store.load('base');
        await store.updateService(index, {
          agent_id: fleet.fleet_agent_id,
          identity_registry_address: fleet.fleet_identity_registry,
          step: 'complete',
          safe_bound_to_agent: true,
        });
        return store.load('base');
      },
    );

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1_and_2');
    expect(result.fleet_state.fleet_agent_id).toBe(FLEET_AGENT_ID);
    expect(result.fleet_state.fleet_safe_address).toBe(FLEET_SAFE);
    expect(result.fleet_state.services).toHaveLength(1);

    const svc = result.fleet_state.services[0]!;
    // Two-Safe topology in standard mode.
    expect(svc.safe_address).toBe(STAKING_SAFE);
    expect(result.fleet_state.fleet_safe_address).not.toBe(svc.safe_address);
    // Same agentId reused across fleet and service.
    expect(svc.agent_id).toBe(result.fleet_state.fleet_agent_id);
  });

  it('migrated operator — existing services[0].agent_id is promoted; no new Safe deploy', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: STAKING_SAFE,
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
          agent_id: '321',
          agent_uri: '',
          identity_registry_address: IDENTITY_REGISTRY,
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      10_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    const deploySpy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy');
    const registerSpy = vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister');
    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 1,
      stakingMultisig: STAKING_SAFE,
      registryState: 4,
      registryMultisig: STAKING_SAFE,
      safeDeployed: true,
    });
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    // Migration ran on load — fleet identity reflects services[0].
    expect(result.fleet_state.fleet_agent_id).toBe('321');
    expect(result.fleet_state.fleet_safe_address).toBe(STAKING_SAFE);
    expect(result.fleet_state.fleet_stage).toBe('stage1_and_2');
    // Stage 1 steps did NOT fire — no re-deploy, no re-mint.
    expect(predictSpy).not.toHaveBeenCalled();
    expect(deploySpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('idempotent — re-running ensureStage1And2 on a complete fleet is a no-op', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: FLEET_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1_and_2',
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: STAKING_SAFE,
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
          agent_id: FLEET_AGENT_ID,
          agent_uri: '',
          identity_registry_address: IDENTITY_REGISTRY,
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      10_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    const stakeSpy = vi.spyOn(bootstrapper as any, 'stepStolasStake');
    const mechSpy = vi.spyOn(bootstrapper as any, 'stepDeployMech');
    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 1,
      stakingMultisig: STAKING_SAFE,
      registryState: 4,
      registryMultisig: STAKING_SAFE,
      safeDeployed: true,
    });
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    expect(predictSpy).not.toHaveBeenCalled();
    expect(stakeSpy).not.toHaveBeenCalled();
    expect(mechSpy).not.toHaveBeenCalled();
  });

  it('resumes from mid-Stage-2 (existing services advance)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: FLEET_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1',
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: STAKING_SAFE,
          service_id: 50,
          mech_address: null,
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'staked',
          error: null,
          agent_id: null,
          agent_uri: null,
          identity_registry_address: null,
          agent_registered_tx: null,
          safe_bound_to_agent: false,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      10_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 1,
      stakingMultisig: STAKING_SAFE,
      registryState: 4,
      registryMultisig: STAKING_SAFE,
      safeDeployed: true,
    });
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);
    vi.spyOn(bootstrapper as any, 'stepStolasStake');
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          mech_address: '0xCAFE000000000000000000000000000000000001',
          step: 'mech_deployed',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepRegisterAgent').mockImplementation(
      async (_s: any, _m: any, index: number) => {
        const fleet = await store.load('base');
        await store.updateService(index, {
          agent_id: fleet.fleet_agent_id,
          identity_registry_address: fleet.fleet_identity_registry,
          step: 'complete',
          safe_bound_to_agent: true,
        });
        return store.load('base');
      },
    );

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    expect((bootstrapper as any).stepStolasStake).not.toHaveBeenCalled();
    expect((bootstrapper as any).stepDeployMech).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepRegisterAgent).toHaveBeenCalledTimes(1);
    expect(result.fleet_state.services[0]!.step).toBe('complete');
    // Stage marker advances after Stage 2 completes a service.
    expect(result.fleet_state.fleet_stage).toBe('stage1_and_2');
  });

  it('creates the first service row when fleet_stage="stage1" and services is empty', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: FLEET_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1',
      services: [],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      10_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          safe_address: STAKING_SAFE,
          service_id: 80,
          staking_address: '0x0000000000000000000000000000000000000003',
          step: 'staked',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          mech_address: '0x000000000000000000000000000000000000aabb',
          step: 'mech_deployed',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepRegisterAgent').mockImplementation(
      async (_s: any, _m: any, index: number) => {
        const fleet = await store.load('base');
        await store.updateService(index, {
          agent_id: fleet.fleet_agent_id,
          identity_registry_address: fleet.fleet_identity_registry,
          step: 'complete',
          safe_bound_to_agent: true,
        });
        return store.load('base');
      },
    );

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.services).toHaveLength(1);
    expect(result.fleet_state.services[0]!.step).toBe('complete');
    expect(result.fleet_state.services[0]!.agent_id).toBe(FLEET_AGENT_ID);
    expect(result.fleet_state.fleet_stage).toBe('stage1_and_2');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd client && yarn vitest run test/earning/staged-bootstrap-stage1and2.test.ts --reporter=verbose 2>&1 | tail -40
```

Expected: FAIL — `ensureStage1And2` does not exist.

- [ ] **Step 3: Commit failing test**

```bash
git add client/test/earning/staged-bootstrap-stage1and2.test.ts
git commit -m "test(nghf): failing combined Stage 1+2 walk tests"
```

---

## Task 8: Implement `ensureStage1And2` (Stage 1 + Stage 2 wrapper)

**Files:**
- Modify: `client/src/earning/bootstrap.ts`

`ensureStage1And2` is the existing `bootstrap` body, prefixed with an `ensureStage1` call, and with two small additions:
1. Promote `fleet_stage` to `'stage1_and_2'` once any service reaches `complete`/`safe_binding_pending`.
2. Have `stepRegisterAgent` reuse `fleet_agent_id` when set (instead of minting a second agentId on the staking Safe). This keeps the "one agentId per user" invariant from the spec.

- [ ] **Step 1: Rename `bootstrap` to `ensureStage1And2` and add the Stage 1 prefix**

In `client/src/earning/bootstrap.ts`, replace the public `bootstrap(password)` method (lines 239-475) with the following:

```typescript
  /**
   * Stage 1 + Stage 2 — full operator bootstrap. Calls `ensureStage1`
   * first; on success, walks Stage 2 per service. Builder-only users who
   * have completed Stage 1 and call this method later begin Stage 2 from
   * `awaiting_stake` for the first service row (created lazily here).
   *
   * Two-Safe topology in standard mode: `fleet_safe_address !==
   * services[0].safe_address` because Stage 2's `distributor.stake()`
   * creates its own Safe. In self-bond mode the two converge (both
   * derived from HD-index-1).
   *
   * See docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md §5.1.
   */
  async ensureStage1And2(password: string): Promise<FleetBootstrapResult> {
    // Stage 1 first — establishes fleet identity. Short-circuits if already done.
    const stage1Result = await this.ensureStage1(password);
    if (!stage1Result.ok) {
      return stage1Result;
    }

    // Original bootstrap body — copied verbatim from the previous bootstrap()
    // method, with two changes:
    //   (a) the legacy-keystore migration and master-wallet-ensure are no-ops
    //       because ensureStage1 already ran them.
    //   (b) at the end, if any service reached `complete`/`safe_binding_pending`
    //       we advance `fleet_stage` to `'stage1_and_2'`.
    let state = await this.store.load(this.chain);

    try {
      // Phase 1b: Check master funding for the full operator path.
      const masterAddress = state.master_address!;
      let masterBalance = await this.publicClient.getBalance({ address: masterAddress as Address });
      const SELF_BOND_ETH_PER_SERVICE = 30_000_000_000_000_000n;
      let systemEth = masterBalance;
      if (this.stakingMode === 'self-bond') {
        for (const svc of state.services) {
          if (svc.agent_address) {
            systemEth += await this.publicClient.getBalance({
              address: getAddress(svc.agent_address) as Address,
            });
          }
          if (svc.safe_address) {
            systemEth += await this.publicClient.getBalance({
              address: getAddress(svc.safe_address) as Address,
            });
          }
        }
      }
      const pendingSetupMigration = detectDeprecatedTestnetSetup({
        state,
        chain: this.chain,
        stakingMode: this.stakingMode,
        currentStakingContract: this.config.stakingContract,
      }).services.length > 0;
      const completedCountBeforeFunding = state.services.filter(s =>
        isOperationalServiceStep(s.step),
      ).length;
      const standardFleetAlreadyComplete =
        this.stakingMode === 'standard' &&
        !pendingSetupMigration &&
        completedCountBeforeFunding >= this.targetServices;
      const standardFleetHasInProgressServices =
        this.stakingMode === 'standard' && state.services.length > 0;
      const requiredMasterEth = this.stakingMode === 'standard'
        ? (
            standardFleetAlreadyComplete
              ? 0n
              : this.config.minEoaGasEth * (standardFleetHasInProgressServices ? 1n : STANDARD_MASTER_BOOTSTRAP_MULTIPLIER)
          )
        : SELF_BOND_ETH_PER_SERVICE * BigInt(this.targetServices);
      const autoFaucetEnabled = this.autoTestnetFaucet;

      const refreshSystemEth = async (): Promise<{ system: bigint; master: bigint }> => {
        const m = await this.publicClient.getBalance({ address: masterAddress as Address });
        let total = m;
        if (this.stakingMode === 'self-bond') {
          for (const svc of state.services) {
            if (svc.agent_address) {
              total += await this.publicClient.getBalance({
                address: getAddress(svc.agent_address) as Address,
              });
            }
            if (svc.safe_address) {
              total += await this.publicClient.getBalance({
                address: getAddress(svc.safe_address) as Address,
              });
            }
          }
        }
        return { system: total, master: m };
      };

      if (systemEth < requiredMasterEth && this.chain === 'base-sepolia' && autoFaucetEnabled) {
        const maxFaucetIters = computeFaucetDripCap({
          targetWei: requiredMasterEth,
          balanceWei: systemEth,
        });
        const INTER_DRIP_PAUSE_MS = 1_000;
        const deadline = this.now() + this.faucetLoopTimeoutMs;
        console.error(
          `[fleet-bootstrap] Master has ${formatEther(systemEth)} ETH; need ${formatEther(requiredMasterEth)} ETH. ` +
          `Draining CDP faucet on ${this.chain} via ${rpcHostForDisplay(this.config.rpcUrl)} ` +
          `(each drip ≈ 0.0001 ETH, up to ${maxFaucetIters} drips or ${Math.round(this.faucetLoopTimeoutMs / 1000)}s, whichever comes first).`,
        );
        for (let i = 0; i < maxFaucetIters; i++) {
          if (this.now() >= deadline) {
            console.error(
              `[fleet-bootstrap] Faucet drip loop hit ${Math.round(this.faucetLoopTimeoutMs / 1000)}s timeout after ${i} drips ` +
              `(master=${formatEther(masterBalance)} ETH; target=${formatEther(requiredMasterEth)} ETH). ` +
              'Retry later or fund manually.',
            );
            break;
          }
          const faucetResult = await this.requestFunding(masterAddress, 'base-sepolia');
          if (!faucetResult.ok) {
            if (faucetResult.rateLimited) {
              console.error(`[fleet-bootstrap] CDP faucet rate-limited after ${i} drips: ${faucetResult.reason}`);
            } else {
              console.error(`[fleet-bootstrap] CDP faucet error after ${i} drips: ${faucetResult.reason}`);
            }
            break;
          }
          await new Promise(r => setTimeout(r, INTER_DRIP_PAUSE_MS));
          const refreshed = await refreshSystemEth();
          systemEth = refreshed.system;
          masterBalance = refreshed.master;
          if ((i + 1) % 5 === 0) {
            console.error(
              `[fleet-bootstrap] drip ${i + 1}/${maxFaucetIters} · chain=${this.chain} · rpc=${rpcHostForDisplay(this.config.rpcUrl)} · ` +
              `master=${formatEther(masterBalance)} ETH · target=${formatEther(requiredMasterEth)} ETH`,
            );
          }
          if (systemEth >= requiredMasterEth) {
            console.error(
              `[fleet-bootstrap] Faucet funding sufficient after ${i + 1} drip${i === 0 ? '' : 's'} ` +
              `(master=${formatEther(masterBalance)} ETH). Continuing bootstrap...`,
            );
            break;
          }
        }
      }

      if (systemEth < requiredMasterEth && this.chain === 'base-sepolia' && autoFaucetEnabled) {
        console.error(
          '[fleet-bootstrap] Automatic faucet funding did not reach the target. ' +
          'Switching to manual funding only; no more faucet requests will be sent in this run.',
        );
      }

      if (systemEth < requiredMasterEth) {
        const shortfall = requiredMasterEth - systemEth;
        const friendly = `Your master wallet needs more ETH (currently ${formatEther(masterBalance)} ETH, need ${formatEther(shortfall)} ETH more). Please send ETH to: ${masterAddress}`;
        return {
          ok: false,
          fleet_state: state,
          message: friendly,
          funding: {
            master_address: masterAddress,
            eth_required: shortfall.toString(),
            eth_balance: masterBalance.toString(),
          },
        };
      }

      this.warnMasterEthRunway(masterAddress, masterBalance, requiredMasterEth);

      const mnemonic = await this.loadExistingMnemonic(state, password);

      if (pendingSetupMigration) {
        const masterAccount = deriveMasterSigner(mnemonic);
        const masterWallet = createJinnWalletClient(this.config.rpcUrl, this.chain, masterAccount);
        const migration = await migrateDeprecatedTestnetSetup({
          stateStore: this.store,
          state,
          chain: this.chain,
          stakingMode: this.stakingMode,
          currentStakingContract: this.config.stakingContract,
          distributorAddress: this.config.distributorAddress,
          publicClient: this.publicClient,
          masterWallet,
        });
        state = migration.state;
      }

      state = await this.reconcileFleetWithChain(state, mnemonic);

      for (const svc of state.services) {
        if (!isOperationalServiceStep(svc.step)) {
          console.error(`[fleet-bootstrap] Resuming service ${svc.index} at step '${svc.step}'`);
        } else if (svc.step === 'safe_binding_pending') {
          console.error(`[fleet-bootstrap] Resuming service ${svc.index} at step 'safe_binding_pending'`);
        }
        state = await this.resumeService(state, mnemonic, svc.index);
      }

      const completedCount = state.services.filter(s => isOperationalServiceStep(s.step)).length;
      const needed = this.targetServices - completedCount;

      if (needed > 0) {
        console.error(`[fleet-bootstrap] ${completedCount}/${this.targetServices} services complete, bootstrapping ${needed} more`);
      }

      for (let i = 0; i < needed; i++) {
        const nextIndex = nextFleetServiceIndex(state.services);
        state = await this.bootstrapService(state, mnemonic, nextIndex);
      }

      // Advance fleet_stage to 'stage1_and_2' if any service is operational.
      const anyOperationalAfter = state.services.some(s => isOperationalServiceStep(s.step));
      if (anyOperationalAfter && state.fleet_stage !== 'stage1_and_2') {
        state = await this.store.patchFleet({ fleet_stage: 'stage1_and_2' });
      }

      return {
        ok: true,
        fleet_state: state,
        message: `Fleet bootstrap complete. ${state.services.filter(s => isOperationalServiceStep(s.step)).length}/${this.targetServices} services running.`,
      };
    } catch (error) {
      const { summary, hint, rawMessage } = formatBootstrapOperatorMessage(error);
      const userMessage = hint !== undefined ? `${summary}\nHint: ${hint}` : summary;
      if (this.debug) {
        console.error(`[fleet-bootstrap] Bootstrap failed:`, error);
      } else {
        console.error(`[fleet-bootstrap] ${summary}`);
        if (hint !== undefined) console.error(`Hint: ${hint}`);
        if (rawMessage && rawMessage !== summary) {
          console.error(`[fleet-bootstrap] raw: ${rawMessage.split('\n')[0]}`);
        }
      }
      return {
        ok: false,
        fleet_state: state,
        message: userMessage,
        rawErrorMessage: rawMessage,
      };
    }
  }

  /**
   * Back-compat alias. Existing call sites in `client/src/cli/commands/bootstrap.ts`
   * and `client/src/cli/commands/fleet-scale.ts` continue to call `bootstrap()`;
   * forwarding to `ensureStage1And2` preserves their semantics without churn.
   */
  async bootstrap(password: string): Promise<FleetBootstrapResult> {
    return this.ensureStage1And2(password);
  }
```

- [ ] **Step 2: Update `stepRegisterAgent` to reuse `fleet_agent_id` when set**

In `client/src/earning/bootstrap.ts:1134-1290`, modify `stepRegisterAgent` to short-circuit the mint branch when `fleet_agent_id` is already populated. Replace the "Sub-step A (mint)" block (lines 1155-1221) with:

```typescript
    // ── Sub-step A: mint NFT (skip if agent_id is already set OR fleet identity exists). ─
    let agentId: string;
    if (svc.agent_id) {
      console.error(
        `[fleet-bootstrap] Service ${index}: ERC-8004 agent already registered ` +
        `(agentId=${svc.agent_id}); skipping mint.`,
      );
      agentId = svc.agent_id;
      svc = await this.firstServiceUpdate(index, {
        identity_registry_address: svc.identity_registry_address ?? getAddress(identityRegistry),
        step: svc.step === 'safe_binding_pending' ? 'safe_binding_pending' : 'agent_registered',
      });
    } else if (fleetSnapshot.fleet_agent_id) {
      // nghf: reuse the fleet-level agentId minted by ensureStage1 instead of
      // minting a second one. This collapses the "one agentId per user"
      // invariant in spec §5.1 for the standard-mode two-Safe topology.
      console.error(
        `[fleet-bootstrap] Service ${index}: reusing fleet agentId=${fleetSnapshot.fleet_agent_id} ` +
        `(no second mint needed).`,
      );
      agentId = fleetSnapshot.fleet_agent_id;
      svc = await this.firstServiceUpdate(index, {
        agent_id: fleetSnapshot.fleet_agent_id,
        agent_uri: '',
        identity_registry_address:
          fleetSnapshot.fleet_identity_registry ?? getAddress(identityRegistry),
        agent_registered_tx: null,
        step: 'agent_registered',
        error: null,
      });
    } else {
      const agentURI = '';
      const registerData = encodeFunctionData({
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'register',
        args: [agentURI],
      }) as Hex;

      console.error(
        `[fleet-bootstrap] Service ${index}: minting ERC-8004 agent NFT ` +
        `(IdentityRegistry=${identityRegistry}, agentEOA=${agentSigner.address})`,
      );

      const mintTxHash = await viemSendTransactionWithRetry(
        agentWallet,
        this.publicClient,
        {
          account: agentSigner as Account,
          to: addr(identityRegistry),
          data: registerData,
        },
      );

      const receipt = await waitForTransactionReceiptWithRetry(this.publicClient, mintTxHash);
      if (receipt.status !== 'success') {
        throw new Error(`IdentityRegistry.register() tx failed for service ${index}: ${mintTxHash}`);
      }

      const parsed = this.parseAgentIdFromReceipt(receipt, identityRegistry);
      if (parsed === null) {
        throw new Error(
          `IdentityRegistry.register() succeeded but Registered event was not found ` +
          `(service ${index}, tx: ${mintTxHash})`,
        );
      }
      agentId = parsed;

      console.error(
        `[fleet-bootstrap] Service ${index}: ERC-8004 agent registered ` +
        `(agentId=${agentId}, tx=${mintTxHash})`,
      );

      svc = await this.firstServiceUpdate(index, {
        agent_id: agentId,
        agent_uri: agentURI,
        identity_registry_address: getAddress(identityRegistry),
        agent_registered_tx: mintTxHash,
        step: 'agent_registered',
        error: null,
      });
    }
```

And insert the fleet snapshot near the top of `stepRegisterAgent`, right after the existing svc-load line (after `if (!svc) throw new Error...` at `client/src/earning/bootstrap.ts:1141`):

```typescript
    const fleetSnapshot = await this.store.load(this.chain);
```

- [ ] **Step 3: Typecheck**

```bash
cd client && yarn typecheck 2>&1 | tail -20
```

Expected: clean. If `formatBootstrapOperatorMessage` or `nextFleetServiceIndex` produce unused-import warnings because the new body still references them, the imports are unchanged — confirm no lints fire.

- [ ] **Step 4: Run the combined-walk test — expect PASS**

```bash
cd client && yarn vitest run test/earning/staged-bootstrap-stage1and2.test.ts --reporter=verbose 2>&1 | tail -40
```

Expected: PASS for all five cases.

- [ ] **Step 5: Run the existing bootstrap test suite — confirm no regressions**

```bash
cd client && yarn vitest run test/earning/bootstrap.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: PASS for all existing tests. They call `bootstrapper.bootstrap()`, which now forwards to `ensureStage1And2`. Migration runs on load — already-complete state stays already-complete.

- [ ] **Step 6: Run the full earning test directory**

```bash
cd client && yarn vitest run test/earning --reporter=verbose 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/earning/bootstrap.ts
git commit -m "feat(nghf): ensureStage1And2(password) + bootstrap() alias + stepRegisterAgent reuses fleet_agent_id"
```

---

## Task 9: Wire `main.ts` to call `ensureStage1And2`

**Files:**
- Modify: `client/src/main.ts`

The daemon's `bootstrap()` function at `client/src/main.ts:404-661` loops over `bootstrapper.bootstrap(PASSWORD)`. Switch to the explicit new name so the call site documents what the daemon needs (Stage 1 + Stage 2).

- [ ] **Step 1: Replace the call site**

In `client/src/main.ts:522`, change:

```typescript
    result = await bootstrapper.bootstrap(PASSWORD);
```

to:

```typescript
    result = await bootstrapper.ensureStage1And2(PASSWORD);
```

- [ ] **Step 2: Update the variable type annotation at line 501**

The previous declaration `let result: Awaited<ReturnType<typeof bootstrapper.bootstrap>>;` works because both methods return the same `FleetBootstrapResult`, but for clarity update to the explicit name. Replace `client/src/main.ts:501`:

```typescript
  let result: Awaited<ReturnType<typeof bootstrapper.ensureStage1And2>>;
```

And the `persistFundingGate` type at lines 504-505:

```typescript
  const persistFundingGate = (funding: NonNullable<Awaited<ReturnType<typeof bootstrapper.ensureStage1And2>>['funding']>): void => {
```

- [ ] **Step 3: Typecheck**

```bash
cd client && yarn typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Run the full client test suite to confirm wiring**

```bash
cd client && yarn test 2>&1 | tail -20
```

Expected: green across the board.

- [ ] **Step 5: Commit**

```bash
git add client/src/main.ts
git commit -m "feat(nghf): main.ts uses ensureStage1And2 for daemon bootstrap"
```

---

## Task 10: ETH-only gate explicit test + final regression sweep

**Files:**
- Modify: `client/test/earning/staged-bootstrap-stage1.test.ts`

Pin the spec's "Stage 1 funding gate is ETH-only — no OLAS" rule explicitly: even when OLAS balance is zero across all addresses, Stage 1 should still complete (`ensureStage1` never reads OLAS).

- [ ] **Step 1: Add the explicit ETH-only assertion**

Append to `client/test/earning/staged-bootstrap-stage1.test.ts`, inside the existing `describe`:

```typescript
  it('Stage 1 ignores OLAS balances entirely', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = buildBootstrapper(earningDir);
    // Plenty of ETH everywhere.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    // Safe code: "0x" first call (predict), bytecode after deploy.
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );

    // The contract surface that would read OLAS balance: getBondTokenBalance.
    // Spy on it; assert it is NEVER called from ensureStage1.
    const olasSpy = vi
      .spyOn(bootstrapper as any, 'getBondTokenBalance')
      .mockResolvedValue(0n);

    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(olasSpy).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the Stage 1 tests**

```bash
cd client && yarn vitest run test/earning/staged-bootstrap-stage1.test.ts --reporter=verbose 2>&1 | tail -25
```

Expected: PASS.

- [ ] **Step 3: Run the entire test suite plus typecheck plus build**

```bash
cd client && yarn typecheck 2>&1 | tail -5
cd client && yarn test 2>&1 | tail -15
cd client && yarn build 2>&1 | tail -5
```

Expected: typecheck clean; all tests green; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/test/earning/staged-bootstrap-stage1.test.ts
git commit -m "test(nghf): explicit ETH-only Stage 1 funding gate assertion"
```

---

## Task 11: Push branch + open PR

**Files:** branch + PR.

- [ ] **Step 1: Push**

```bash
git push -u origin feat/nghf-staged-bootstrap 2>&1 | tail -3
```

- [ ] **Step 2: Open PR (stacked on the 52x3 docs branch)**

```bash
gh pr create \
  --base feat/52x3-plug-in-builder-entry-point \
  --head feat/nghf-staged-bootstrap \
  --title "feat(nghf): staged-bootstrap refactor (Stage 1 + Stage 2 entry points)" \
  --body "$(cat <<'EOF'
Implements `jinn-mono-nghf` — the staged-bootstrap refactor child of the [Plug-in builder entry point epic](jinn-mono-52x3).

## Summary

Adds fleet-level Stage 1 (identity) + Stage 2 (operator) entry points to `FleetBootstrapper`. Builders can complete Stage 1 (Safe deploy + agentId mint + setAgentWallet) without OLAS. Operators continue to call `ensureStage1And2` (via the back-compat `bootstrap()` alias) and walk both stages.

## What ships

- `client/src/earning/types.ts` — four fleet-level fields: `fleet_agent_id`, `fleet_safe_address`, `fleet_identity_registry`, `fleet_stage` (`'none' | 'stage1' | 'stage1_and_2'`).
- `client/src/earning/store.ts` — non-destructive migration: on load, promote `services[0].agent_id` → `fleet_agent_id` etc. when fleet-level fields are absent. Preserves per-service identity.
- `client/src/earning/bootstrap.ts` — new `ensureStage1(password)` + `ensureStage1And2(password)`. `bootstrap(password)` is now a back-compat alias for `ensureStage1And2`. `stepRegisterAgent` reuses `fleet_agent_id` when set instead of minting a second agentId on the staking Safe.
- `client/src/main.ts` — daemon calls `ensureStage1And2` explicitly.

## Topology note (standard mode — two Safes)

Per spec §5.1 implementation reality check: dual-role operators on standard mode end up with two Safes — a Stage 1 identity Safe (where `setMetadata` and reputation accrue) and a Stage 2 staking Safe (where OLAS activity runs). Both share the agent EOA at HD-index-1; both share `fleet_agent_id`. Self-bond operators reuse one Safe.

## Migration

Existing testnet operators with `services[0].agent_id` populated and no `fleet_*` fields are walked forward on the next `jinn run`:
- `fleet_agent_id`, `fleet_safe_address`, `fleet_identity_registry` are populated from `services[0]` (non-destructively).
- `fleet_stage` is set to `stage1_and_2`.
- `ensureStage1` short-circuits (no new Safe deploy, no re-mint).

Pure operators staying with `jinn run` get **no new Safe** deployed; the migration is purely a field-level promotion.

## Test plan

- [x] `yarn typecheck` clean.
- [x] `yarn vitest run test/earning/types.test.ts` — schema tests pass.
- [x] `yarn vitest run test/earning/staged-bootstrap-migration.test.ts` — 5 cases; non-destructive promotion + fresh fleet + recent-fleet-passthrough verified.
- [x] `yarn vitest run test/earning/staged-bootstrap-stage1.test.ts` — Stage 1 walk + idempotency + mid-Stage-1 resume + ETH-only gate.
- [x] `yarn vitest run test/earning/staged-bootstrap-stage1and2.test.ts` — combined walk: clean state, migrated operator, idempotency, mid-Stage-2 resume, builder-to-operator transition (services: [] → first service row), two-Safe topology assertion (standard mode).
- [x] `yarn vitest run test/earning/bootstrap.test.ts` — all existing tests pass (back-compat).
- [x] `yarn test` — full suite green.
- [x] `yarn build` clean.

## Stacked on

`feat/52x3-plug-in-builder-entry-point` (the epic docs branch).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 3: Mark bd in-progress → close on PR merge**

bd status set to `in_progress` at planning time. Close on merge.

```bash
# After PR merges:
# bd close jinn-mono-nghf
```

---

## Self-review

**Spec coverage:**
- Parent spec §5.1 (amended): Stage 1 = wallet → predict → ETH gate → deploy → register+bind → `fleet_stage='stage1'`. Implemented in Task 6 via `ensureStage1` + three helpers.
- Parent spec §5.1 two-Safe topology in standard mode: pinned by Task 7 Step 1 (`fleet_safe_address !== services[0].safe_address`).
- Parent spec §5.1 dual-role coherence — one agentId reused: enforced by Task 8 Step 2 (`stepRegisterAgent` reuses `fleet_agent_id`).
- Findings §8 Option A (chosen bridge): four fleet-level fields on `FleetStateSchema` — Task 2.
- Findings §5 migration safety: non-destructive promotion of `services[0]` identity — Tasks 3+4.
- Acceptance criterion 1 (clean-state Stage 1 walk): Task 5 Step 1 case `walks wallet → predict Safe → deploy Safe → mint → bind`.
- Acceptance criterion 2 (clean-state Stage 1+2 standard mode): Task 7 Step 1 case `clean state — walks Stage 1, then Stage 2`.
- Acceptance criterion 3 (resume from mid-Stage-1): Task 5 case `resumes from mid-Stage-1`.
- Acceptance criterion 4 (resume from mid-Stage-2): Task 7 case `resumes from mid-Stage-2`.
- Acceptance criterion 5 (migration of pre-existing state files): Task 3 — five cases including the load-bearing `promotes services[0].agent_id` case.
- Acceptance criterion 6 (ETH-only gate at Stage 1): Task 5 case `pauses at ETH funding` + Task 10 explicit OLAS-untouched assertion.
- Acceptance criterion 7 (idempotency on re-run): Task 5 case `is idempotent` + Task 7 case `idempotent — re-running … is a no-op`.

**Pre-existing-operator safety:**
- Migration runs on every load; `ensureStage1` short-circuits when `fleet_stage` is `stage1` or `stage1_and_2`.
- The migration's `stage1_and_2` branch fires for operators with completed services, so `ensureStage1` never enters its predict/deploy/mint helpers for them.
- Pure operators staying on `jinn run` who never call `ensureStage1` directly walk forward as before. The `stepRegisterAgent` change (Task 8 Step 2) only short-circuits when `fleet_agent_id` is non-null — for legacy operators without it, the existing per-service mint path runs unchanged.
- `bootstrap()` is preserved as an alias of `ensureStage1And2`, so `cli/commands/bootstrap.ts` and `cli/commands/fleet-scale.ts` keep working with no edits.

**Placeholder scan:** none — no TBD / TODO / "implement appropriately". Each step has exact code or exact commands.

**Type consistency:** `FleetStage`, `FleetStageSchema`, `fleet_agent_id`, `fleet_safe_address`, `fleet_identity_registry`, `fleet_stage`, `ensureStage1`, `ensureStage1And2`, `stepFleetSafePredict`, `stepFleetSafeDeploy`, `stepFleetIdentityRegister` — used consistently across Tasks 2, 4, 6, 7, 8, 9, 10.

**Commit count:** 11 (one per task).

---

*End of plan.*

---

```