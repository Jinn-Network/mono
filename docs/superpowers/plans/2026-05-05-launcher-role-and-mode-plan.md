# Launcher Role & Launcher Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the Polymarket generator's `predictionV1LauncherEnabled` boolean to a first-class `'launching'` role in the multi-role daemon shipped in `jinn-mono-l2zl.15.4.8`, and add a Launcher mode to the operator app (Airbnb-style two-state mode switch in the header) so the Jinn team can run the Prediction launcher day-1 from the same operator app, with strict information separation between Operator and Launcher modes.

**Architecture:** Daemon side — extend per-SolverNet `roles` enum to include `'launching'`, hot-spawn the generator loop based on a tick-time role check (no daemon restart on toggle), filter `'launching'` out of the operator-status payload at the boundary, and add three launcher endpoints (`/v1/launcher/status`, `/v1/launcher/tasks`, `/v1/launcher/solvernets/:name`). SPA side — header mode switch persisted to localStorage, two new routes (`/launcher` and `/launcher/configuration`), an empty-state with setup flow, a four-tier configured-state overview (knowledge production / cost / generator status / Phase B+ emissions placeholder), and a generator config page. One identity / one Safe / one bootstrap reused unchanged.

**Tech Stack:** TypeScript, Vitest, React 18, Wouter (SPA routing), Hono (daemon HTTP), Zod (config), JetBrains Mono + existing CSS variable design system.

**Spec:** `spec/2026-05-05-launcher-role-and-mode.md`

---

## File Structure

### Daemon — modified
- `client/src/config.ts` — extend `roles` zod union to include `'launching'`; remove `predictionV1LauncherEnabled` boolean (and its env-var binding); generator config keys (`predictionV1*`) stay
- `client/src/api/setup-endpoints.ts` — operator-mode setup endpoint (`POST /v1/setup/solvernets/:name`) preserves any existing `'launching'` role across operator-only patches
- `client/src/api/gather-status.ts` — narrow the operator-status payload's `operator.solverNet.roles` to exclude `'launching'` (filter at the boundary)
- `client/src/main.ts` — replace startup-time `predictionV1LauncherEnabled` check with runtime `roles.includes('launching')` gate inside the generator loop
- `client/src/solver-types/prediction-v1-auto.ts` — expose `getGeneratorState()` returning last-poll summary, errors, cadence so the launcher status endpoint can read it
- `client/src/api/server.ts` — register launcher routes module

### Daemon — created
- `client/src/api/launcher-endpoints.ts` — all `/v1/launcher/*` Hono routes
- `client/src/api/launcher-status.ts` — gather per-SolverNet generator + budget state into `LauncherStatusResponse`
- `client/src/api/launcher-tasks.ts` — query Tasks posted by this daemon's creator address into `LauncherTasksResponse`

### Daemon — tests
- `client/test/config.test.ts` — extend with `'launching'` role cases
- `client/test/api/setup-endpoints.test.ts` — extend with role-preservation tests
- `client/test/api/gather-status.test.ts` — extend with operator-payload narrowing tests (or add file if absent)
- `client/test/api/launcher-endpoints.test.ts` — new
- `client/test/solver-types/prediction-v1-auto-state.test.ts` — new (or extend existing if present)

### SPA — modified
- `client/src/dashboard/spa/src/api/types.ts` — narrow `operator.solverNet.roles`; add `LauncherStatusResponse`, `LauncherTasksResponse`, `LauncherSolverNetPatch`
- `client/src/dashboard/spa/src/api/client.ts` — add `fetchLauncherStatus`, `fetchLauncherTasks`, `patchLauncherSolverNet`
- `client/src/dashboard/spa/src/App.tsx` — register `/launcher` and `/launcher/configuration` routes
- `client/src/dashboard/spa/src/shell/Header.tsx` — render the new `ModeSwitch` component
- `client/src/dashboard/spa/src/App.routing.test.tsx` — extend to cover the launcher routes

### SPA — created
- `client/src/dashboard/spa/src/shell/ModeSwitch.tsx` — two-state header toggle
- `client/src/dashboard/spa/src/shell/useAppMode.ts` — `localStorage`-backed hook
- `client/src/dashboard/spa/src/pages/Launcher.tsx` — overview page (empty state + configured state composition)
- `client/src/dashboard/spa/src/pages/LauncherConfiguration.tsx` — generator-config page
- `client/src/dashboard/spa/src/pages/launcher/EmptyState.tsx`
- `client/src/dashboard/spa/src/pages/launcher/SetupFlow.tsx`
- `client/src/dashboard/spa/src/pages/launcher/KnowledgeProductionCard.tsx` (tier 1)
- `client/src/dashboard/spa/src/pages/launcher/CostCard.tsx` (tier 2)
- `client/src/dashboard/spa/src/pages/launcher/GeneratorStatusCard.tsx` (tier 3, includes stale banner)
- `client/src/dashboard/spa/src/pages/launcher/PostedTasksList.tsx` (tier 3)
- `client/src/dashboard/spa/src/pages/launcher/EmissionsPlaceholder.tsx` (tier 4 — Phase B+ stub)
- `client/src/dashboard/spa/src/pages/launcher/GeneratorConfigSection.tsx`

### SPA — tests
- One co-located `*.test.tsx` per new component, plus `useAppMode.test.ts`. Existing test conventions apply (Vitest + Testing Library).

---

## Conventions

- TDD per task: write the failing test first, run it to confirm failure, write minimal implementation, run to confirm pass, commit.
- Each task ends with `git add <files> && git commit -m "<conventional-commit-message>"`.
- Use existing CSS variables (`var(--bg)`, `var(--border)`, `var(--fg)`, `var(--fg-muted)`, `var(--fg-dim)`, `var(--accent-sky)`, `var(--vow-green)`, `var(--break-red)`) and JetBrains Mono. Follow patterns in `client/src/dashboard/spa/src/pages/configuration/NetCard.tsx` and `client/src/dashboard/spa/src/pages/overview/OperatorCard.tsx`.
- Reusable building blocks: `client/src/dashboard/spa/src/components/{SectionCard,ConfigField,RestartPill}.tsx`.
- TypeScript strict; never `any`. Zod is the authority for runtime validation in `client/src/config.ts`.
- Test runner is Vitest. Run via `cd client && yarn vitest run <path>` or directly `npx tsc --noEmit` for typecheck.

---

## Task 1: Extend `roles` schema to include `'launching'`

**Files:**
- Modify: `client/src/config.ts` (the zod schema and preprocess block currently accepting `'solving' | 'evaluating'`)
- Test: `client/test/config.test.ts`

- [ ] **Step 1: Write failing test in `client/test/config.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfigFromObject } from '../src/config.js'; // adjust to actual export name

describe('config: launching role', () => {
  it('accepts roles: ["launching"] for a SolverNet', () => {
    const cfg = loadConfigFromObject({
      solverNets: { prediction: { enabled: true, roles: ['launching'], harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] } },
    });
    expect(cfg.solverNets!.prediction!.roles).toEqual(['launching']);
  });

  it('accepts roles: ["solving", "launching"] (multi-role)', () => {
    const cfg = loadConfigFromObject({
      solverNets: { prediction: { enabled: true, roles: ['solving', 'launching'], harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] } },
    });
    expect(cfg.solverNets!.prediction!.roles).toEqual(['solving', 'launching']);
  });

  it('rejects empty roles array', () => {
    expect(() => loadConfigFromObject({
      solverNets: { prediction: { enabled: true, roles: [], harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] } },
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd client && npx vitest run test/config.test.ts -t "launching role"`
Expected: FAIL — `'launching'` not in role union.

- [ ] **Step 3: Update `client/src/config.ts` zod schema**

Find the per-SolverNet roles schema (introduced in `.15.4.8`). Today it accepts `'solving' | 'evaluating'`. Extend the union and (a) keep the deduplication + non-empty validation, (b) keep the legacy-`role`-to-`roles` preprocess step. Pseudo-diff:

```ts
const roleEnum = z.enum(['solving', 'evaluating', 'launching']);
// ... rest of preprocess + array-of-roleEnum + non-empty + dedupe stays unchanged.
```

Also remove `predictionV1LauncherEnabled` from the schema and from the env-var binding block (around `client/src/config.ts:318` and `client/src/config.ts:705`). The boolean is replaced by the role gate in Task 4.

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd client && npx vitest run test/config.test.ts`
Expected: PASS for all `launching role` cases plus existing `.15.4.8` cases.

- [ ] **Step 5: Commit**

```bash
git add client/src/config.ts client/test/config.test.ts
git commit -m "config: extend per-SolverNet roles to include 'launching'

Replaces predictionV1LauncherEnabled boolean with a role-array entry.
Existing role validation (non-empty, deduplicated, legacy-role-auto-
migrated) covers the new value transparently."
```

---

## Task 2: Operator-mode setup endpoint preserves `'launching'` across patches

**Files:**
- Modify: `client/src/api/setup-endpoints.ts` (the `POST /v1/setup/solvernets/:name` handler at ~line 313)
- Test: `client/test/api/setup-endpoints.test.ts`

**Why:** Operator-mode UI only knows `'solving' | 'evaluating'`. If it patches `roles: ['solving']` after Launcher mode set `roles: ['solving', 'launching']`, the launching role must survive. The handler reads existing roles and merges.

- [ ] **Step 1: Write failing test**

```ts
it('preserves launching role when operator-mode patch only includes solving/evaluating', async () => {
  // Setup: solverNet config currently has roles: ['solving', 'launching']
  await seedConfig({ solverNets: { prediction: { enabled: true, roles: ['solving', 'launching'], ...rest } } });

  const res = await app.request('/v1/setup/solvernets/prediction', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ enabled: true, roles: ['evaluating'] }), // operator switching solver→evaluator
  });
  expect(res.status).toBe(200);

  const after = await readPersistedConfig();
  expect(after.solverNets.prediction.roles.sort()).toEqual(['evaluating', 'launching']);
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd client && npx vitest run test/api/setup-endpoints.test.ts -t "preserves launching"`
Expected: FAIL — current handler overwrites `roles` wholesale.

- [ ] **Step 3: Implement merge in the handler**

Inside `POST /v1/setup/solvernets/:name`, before persisting:

```ts
// Operator-mode patch only addresses solving/evaluating. Preserve any non-operator
// roles (today: 'launching') so launcher-mode state is never clobbered by an
// operator-mode role edit. Strict mode separation per spec/2026-05-05-launcher-role-and-mode.md §3.
const incomingOperatorRoles = (body.roles ?? []).filter((r): r is 'solving' | 'evaluating' => r === 'solving' || r === 'evaluating');
const preservedRoles = (existing.roles ?? []).filter(r => r !== 'solving' && r !== 'evaluating');
const mergedRoles = Array.from(new Set([...incomingOperatorRoles, ...preservedRoles]));
// then write mergedRoles into the persisted config
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd client && npx vitest run test/api/setup-endpoints.test.ts`
Expected: PASS (new test + all existing setup-endpoints tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/api/setup-endpoints.ts client/test/api/setup-endpoints.test.ts
git commit -m "api(setup): preserve non-operator roles across operator-mode patches

Operator-mode UI doesn't know about 'launching' (strict mode separation
per spec). Setup endpoint merges operator-relevant roles (solving,
evaluating) from the request with preserved non-operator roles from
storage so launcher state survives operator edits."
```

---

## Task 3: Filter `'launching'` out of operator-status payload

**Files:**
- Modify: `client/src/api/gather-status.ts` (the function that builds `operator.solverNet.roles` for the operator-status response)
- Test: `client/test/api/gather-status.test.ts` (extend if present, create if absent)

- [ ] **Step 1: Write failing test**

```ts
it('omits launching from operator.solverNet.roles', async () => {
  const cfg = makeConfigFixture({ solverNets: { prediction: { roles: ['solving', 'launching'], ...rest } } });
  const status = await gatherPredictionOperatorStatus(cfg, /* ...other deps... */);
  expect(status.operator?.solverNet?.roles).toEqual(['solving']); // launching filtered out
});

it('returns empty operator.solverNet.roles when only launching is enabled', async () => {
  const cfg = makeConfigFixture({ solverNets: { prediction: { roles: ['launching'], ...rest } } });
  const status = await gatherPredictionOperatorStatus(cfg, ...);
  // The operator-status payload still surfaces solverNet metadata, but the operator
  // is "not opted in" from the operator-mode perspective. Existing operatorEnabled
  // computation (.15.4.12) should treat this as opted-out for operator-mode UI.
  expect(status.operator?.solverNet?.roles).toEqual([]);
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd client && npx vitest run test/api/gather-status.test.ts -t "operator.solverNet.roles"`
Expected: FAIL — current gather-status returns full `roles` array including launching.

- [ ] **Step 3: Implement the filter**

In `client/src/api/gather-status.ts`, where `operator.solverNet.roles` is populated, filter the array:

```ts
const operatorRoles = (rawRoles ?? []).filter((r): r is 'solving' | 'evaluating' => r === 'solving' || r === 'evaluating');
// then assign operatorRoles to operator.solverNet.roles
```

Update the TypeScript return type to narrow `roles` to `Array<'solving' | 'evaluating'>` (this matches the SPA-side narrowing in Task 7).

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd client && npx vitest run test/api/gather-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/gather-status.ts client/test/api/gather-status.test.ts
git commit -m "api(status): narrow operator-status roles to solving/evaluating only

Strict mode separation per spec: Operator mode never sees launcher state.
Filter happens at the gather-status boundary so the type can narrow on
both daemon and SPA sides."
```

---

## Task 4: Hot-spawn generator — runtime role check, no daemon restart

**Files:**
- Modify: `client/src/main.ts` — find the block that conditionally creates the prediction generator from `predictionV1LauncherEnabled` (likely near `collectTestnetAutoTaskGenerators` wiring around `client/src/main.ts:1332-1368` per Explore findings)
- Modify: `client/src/solver-types/prediction-v1-auto.ts` — wrap the poll in a role-active guard
- Test: `client/test/solver-types/prediction-v1-auto-role-gate.test.ts` (new)

**Pattern choice:** Always-spawn loop, tick-time gate. Rationale: simplest. The loop wakes, checks `roles.includes('launching')` from a config-getter closure, no-ops if false, polls if true. Cost is one cheap predicate per cadence tick.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { makePredictionV1Generator } from '../../src/solver-types/prediction-v1-auto.js';

describe('prediction-v1-auto: role gate', () => {
  it('does not poll Polymarket when roles does not include launching', async () => {
    const polymarketSpy = vi.fn();
    const gen = makePredictionV1Generator({
      polymarket: { fetchEligibleMarkets: polymarketSpy },
      getRoles: () => ['solving'], // operator-only, no launching
      cadenceMs: 1, // not used; we drive ticks manually
    });
    await gen.tick();
    expect(polymarketSpy).not.toHaveBeenCalled();
  });

  it('polls Polymarket when roles includes launching', async () => {
    const polymarketSpy = vi.fn().mockResolvedValue([]); // empty eligible set is fine for the gate test
    const gen = makePredictionV1Generator({
      polymarket: { fetchEligibleMarkets: polymarketSpy },
      getRoles: () => ['launching'],
      cadenceMs: 1,
    });
    await gen.tick();
    expect(polymarketSpy).toHaveBeenCalledTimes(1);
  });

  it('hot-flips: same instance gates poll behaviour as roles change', async () => {
    let roles: Array<'solving' | 'evaluating' | 'launching'> = ['solving'];
    const polymarketSpy = vi.fn().mockResolvedValue([]);
    const gen = makePredictionV1Generator({
      polymarket: { fetchEligibleMarkets: polymarketSpy },
      getRoles: () => roles,
      cadenceMs: 1,
    });
    await gen.tick();
    expect(polymarketSpy).toHaveBeenCalledTimes(0);
    roles = ['launching'];
    await gen.tick();
    expect(polymarketSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd client && npx vitest run test/solver-types/prediction-v1-auto-role-gate.test.ts`
Expected: FAIL — generator doesn't accept `getRoles` injection.

- [ ] **Step 3: Update generator to accept role-getter, gate the poll**

In `client/src/solver-types/prediction-v1-auto.ts`:

```ts
export interface PredictionV1AutoConfig extends PolymarketClientConfig {
  // ... existing fields ...
  getRoles?: () => Array<'solving' | 'evaluating' | 'launching'>;
}

export function makePredictionV1Generator(config: PredictionV1AutoConfig = {}) {
  // ... existing state ...
  return {
    async tick() {
      const roles = config.getRoles?.() ?? [];
      if (!roles.includes('launching')) return; // hot-spawn gate
      // ... existing poll/post logic ...
    },
    // ... existing exports ...
  };
}
```

- [ ] **Step 4: Update `client/src/main.ts` to wire the role-getter**

Find the existing block that read `cfg.predictionV1LauncherEnabled` to decide whether to create the generator. Replace with:

```ts
// Always create the generator; the role gate inside its tick is what controls
// whether work happens. This makes role flips (e.g. from the launcher-mode
// setup flow) take effect within one cadence without restarting the daemon.
const predictionGenerator = makePredictionV1Generator({
  ...predictionGeneratorOpts,
  getRoles: () => cfg.solverNets?.prediction?.roles ?? [],
});
```

Remove all references to `predictionV1LauncherEnabled` (the env-var binding was removed in Task 1; remove its read sites here).

- [ ] **Step 5: Run tests + typecheck**

```bash
cd client && npx tsc --noEmit
cd client && npx vitest run test/solver-types/prediction-v1-auto-role-gate.test.ts
cd client && npx vitest run test/config.test.ts test/api
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/solver-types/prediction-v1-auto.ts client/src/main.ts client/test/solver-types/prediction-v1-auto-role-gate.test.ts
git commit -m "feat(generator): hot-spawn gate via roles.includes('launching')

Replace startup-time predictionV1LauncherEnabled boolean with a runtime
role check inside the generator tick. Toggling 'launching' in or out of
roles takes effect within one cadence — no daemon restart. Closes the
schema migration started in Task 1."
```

---

## Task 5: Expose generator state for the launcher status endpoint

**Files:**
- Modify: `client/src/solver-types/prediction-v1-auto.ts` — add `getState()` method returning poll history
- Test: `client/test/solver-types/prediction-v1-auto-state.test.ts` (new)

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { makePredictionV1Generator } from '../../src/solver-types/prediction-v1-auto.js';

describe('prediction-v1-auto: state exposure', () => {
  it('returns last-poll summary after a successful tick', async () => {
    const gen = makePredictionV1Generator({
      polymarket: { fetchEligibleMarkets: async () => [/* 3 mock markets */] },
      getRoles: () => ['launching'],
      cadenceMs: 1,
    });
    await gen.tick();
    const state = gen.getState();
    expect(state.lastPollAt).toBeTruthy();
    expect(state.lastPollSummary).toMatchObject({ evaluated: 3, posted: expect.any(Number), skipped: expect.any(Number) });
    expect(state.lastError).toBeUndefined();
    expect(state.cadenceMs).toBeGreaterThan(0);
  });

  it('captures error on poll failure', async () => {
    const gen = makePredictionV1Generator({
      polymarket: { fetchEligibleMarkets: async () => { throw new Error('polymarket 503'); } },
      getRoles: () => ['launching'],
      cadenceMs: 1,
    });
    await gen.tick();
    const state = gen.getState();
    expect(state.lastError?.message).toContain('polymarket 503');
  });

  it('reports stale=false within 2x cadence; logic lives in the status endpoint, not here', () => {
    // staleness is computed by the status endpoint (Task 6); this test just verifies
    // getState() reports lastPollAt and cadenceMs, which the endpoint uses.
    const gen = makePredictionV1Generator({ polymarket: ..., getRoles: () => ['launching'], cadenceMs: 60_000 });
    const state = gen.getState();
    expect(state.cadenceMs).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd client && npx vitest run test/solver-types/prediction-v1-auto-state.test.ts`
Expected: FAIL — `getState()` does not exist.

- [ ] **Step 3: Implement `getState()` and internal state tracking**

In `client/src/solver-types/prediction-v1-auto.ts` add internal mutable state:

```ts
interface GeneratorPersistentState {
  lastPollAt?: string;
  lastPollSummary?: { evaluated: number; posted: number; skipped: number; skipReasons?: Record<string, number> };
  lastError?: { message: string; at: string };
}

export function makePredictionV1Generator(config: PredictionV1AutoConfig = {}) {
  const state: GeneratorPersistentState = {};
  // ... existing dedup map etc. ...

  return {
    async tick() {
      const roles = config.getRoles?.() ?? [];
      if (!roles.includes('launching')) return;
      try {
        const eligible = await config.polymarket.fetchEligibleMarkets(...);
        // existing posting logic; track posted/skipped counts as you go
        const summary = { evaluated: eligible.length, posted, skipped, skipReasons };
        state.lastPollAt = new Date().toISOString();
        state.lastPollSummary = summary;
        state.lastError = undefined;
      } catch (err) {
        state.lastError = { message: err instanceof Error ? err.message : String(err), at: new Date().toISOString() };
      }
    },
    getState() {
      return {
        ...state,
        cadenceMs: config.cadenceMs ?? DEFAULT_CADENCE_MS,
      };
    },
    // ... other existing exports ...
  };
}
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd client && npx tsc --noEmit
cd client && npx vitest run test/solver-types/prediction-v1-auto-state.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/prediction-v1-auto.ts client/test/solver-types/prediction-v1-auto-state.test.ts
git commit -m "feat(generator): expose poll state via getState()

Surface lastPollAt, lastPollSummary, lastError, cadenceMs so the
upcoming /v1/launcher/status endpoint can render generator health.
Stale-poll detection (lastPollAt + 2*cadence) lives in the endpoint."
```

---

## Task 6: `GET /v1/launcher/status` endpoint

**Files:**
- Create: `client/src/api/launcher-status.ts`
- Create: `client/src/api/launcher-endpoints.ts`
- Modify: `client/src/api/server.ts` — register the launcher route module
- Test: `client/test/api/launcher-endpoints.test.ts` (new)

- [ ] **Step 1: Write failing test for `GET /v1/launcher/status`**

```ts
import { describe, it, expect } from 'vitest';
import { buildTestApp } from './fixtures.js'; // existing helper used by setup-endpoints test

describe('GET /v1/launcher/status', () => {
  it('returns per-net launcher status for nets with launching role', async () => {
    const { app, token } = await buildTestApp({ solverNets: { prediction: { roles: ['launching'], ...rest } } });
    const res = await app.request('/v1/launcher/status', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.nets).toHaveLength(1);
    expect(body.nets[0]).toMatchObject({
      name: 'prediction',
      generator: { state: expect.stringMatching(/active|paused|errored/), cadenceMs: expect.any(Number), stale: expect.any(Boolean) },
      openTasks: expect.any(Number),
      budget: { safeAddress: expect.any(String), safeBalanceWei: expect.any(String) },
    });
  });

  it('omits nets without launching role', async () => {
    const { app, token } = await buildTestApp({ solverNets: { prediction: { roles: ['solving'], ...rest } } });
    const res = await app.request('/v1/launcher/status', { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json();
    expect(body.nets).toEqual([]);
  });

  it('reports stale=true when lastPollAt is older than 2x cadence', async () => {
    const fakeNow = Date.now();
    const stalePollAt = new Date(fakeNow - 60_000 * 3).toISOString(); // 3 minutes ago, cadence is 1 minute
    const { app, token } = await buildTestApp({
      solverNets: { prediction: { roles: ['launching'], ...rest } },
      generatorState: { lastPollAt: stalePollAt, cadenceMs: 60_000 },
      now: () => fakeNow,
    });
    const res = await app.request('/v1/launcher/status', { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json();
    expect(body.nets[0].generator.stale).toBe(true);
  });

  it('requires auth', async () => {
    const { app } = await buildTestApp({ solverNets: { prediction: { roles: ['launching'], ...rest } } });
    const res = await app.request('/v1/launcher/status');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd client && npx vitest run test/api/launcher-endpoints.test.ts -t "GET /v1/launcher/status"`
Expected: FAIL — endpoint not registered.

- [ ] **Step 3: Implement `client/src/api/launcher-status.ts`**

```ts
import type { JinnConfig } from '../config.js';
import type { Generator } from '../solver-types/prediction-v1-auto.js';

export interface LauncherStatusResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: Array<{
    name: string;
    generator: {
      state: 'active' | 'paused' | 'errored';
      lastPollAt?: string;
      lastPollSummary?: { evaluated: number; posted: number; skipped: number; skipReasons?: Record<string, number> };
      lastError?: { message: string; at: string };
      cadenceMs: number;
      stale?: boolean;
    };
    openTasks: number;
    budget: { safeAddress: string; safeBalanceWei: string; reservedBudgetWei: string; runwayDays?: number };
  }>;
}

export interface GatherLauncherStatusDeps {
  config: JinnConfig;
  generators: Map<string, Generator>; // keyed by SolverNet name
  getOpenTaskCount: (netName: string) => Promise<number>;
  getReservedBudgetWei: (netName: string) => Promise<string>;
  getSafeBalanceWei: () => Promise<string>;
  safeAddress: string;
  now?: () => number;
}

export async function gatherLauncherStatus(deps: GatherLauncherStatusDeps): Promise<LauncherStatusResponse> {
  const now = deps.now?.() ?? Date.now();
  const nets: LauncherStatusResponse['nets'] = [];
  for (const [name, net] of Object.entries(deps.config.solverNets ?? {})) {
    if (!net.roles?.includes('launching')) continue;
    const gen = deps.generators.get(name);
    const genState = gen?.getState();
    const stale = genState?.lastPollAt
      ? (now - Date.parse(genState.lastPollAt)) > 2 * (genState.cadenceMs ?? 0)
      : false;
    const generatorState = genState?.lastError ? 'errored' : (gen ? 'active' : 'paused');
    const reservedBudgetWei = await deps.getReservedBudgetWei(name);
    const safeBalanceWei = await deps.getSafeBalanceWei();
    nets.push({
      name,
      generator: { state: generatorState, lastPollAt: genState?.lastPollAt, lastPollSummary: genState?.lastPollSummary, lastError: genState?.lastError, cadenceMs: genState?.cadenceMs ?? 0, stale },
      openTasks: await deps.getOpenTaskCount(name),
      budget: { safeAddress: deps.safeAddress, safeBalanceWei, reservedBudgetWei },
    });
  }
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), nets };
}
```

- [ ] **Step 4: Implement `client/src/api/launcher-endpoints.ts`**

```ts
import type { Hono } from 'hono';
import { gatherLauncherStatus, type GatherLauncherStatusDeps } from './launcher-status.js';

export interface LauncherRoutesDeps extends Omit<GatherLauncherStatusDeps, 'config'> {
  getConfig: () => GatherLauncherStatusDeps['config'];
}

export function addLauncherRoutes(app: Hono, deps: LauncherRoutesDeps): void {
  app.get('/v1/launcher/status', async (c) => {
    const body = await gatherLauncherStatus({ ...deps, config: deps.getConfig() });
    return c.json(body);
  });
}
```

- [ ] **Step 5: Register in `client/src/api/server.ts`**

Add the import and call `addLauncherRoutes(app, launcherDeps)` next to the existing `addSetupRoutes(app, ...)` call. Wire the deps from the daemon's main.ts when constructing the API server.

- [ ] **Step 6: Run tests**

Run: `cd client && npx vitest run test/api/launcher-endpoints.test.ts -t "/v1/launcher/status"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/api/launcher-status.ts client/src/api/launcher-endpoints.ts client/src/api/server.ts client/test/api/launcher-endpoints.test.ts
git commit -m "feat(api): GET /v1/launcher/status with stale-poll detection

Per-SolverNet generator + budget state for the Launcher mode UI.
Stale flag set when lastPollAt is older than 2x cadenceMs."
```

---

## Task 7: `GET /v1/launcher/tasks` endpoint

**Files:**
- Create: `client/src/api/launcher-tasks.ts`
- Modify: `client/src/api/launcher-endpoints.ts` — register the tasks route
- Test: `client/test/api/launcher-endpoints.test.ts` — extend

- [ ] **Step 1: Write failing test**

```ts
describe('GET /v1/launcher/tasks', () => {
  it('returns tasks posted by this daemon\'s creator address, paginated', async () => {
    const { app, token, postedTasksFixture } = await buildTestApp({
      solverNets: { prediction: { roles: ['launching'], ...rest } },
      postedTasks: [
        { taskId: '0xa', taskCid: 'Qm…', solverNet: 'prediction', postedAt: '2026-05-05T10:00:00Z', state: 'open', claims: { current: 0, max: 25 }, budget: { totalWei: '1000000', remainingWei: '1000000' } },
        { taskId: '0xb', taskCid: 'Qm…', solverNet: 'prediction', postedAt: '2026-05-05T11:00:00Z', state: 'claims-in-flight', claims: { current: 5, max: 25 }, budget: { totalWei: '1000000', remainingWei: '800000' } },
      ],
    });
    const res = await app.request('/v1/launcher/tasks', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].taskId).toBe('0xb'); // most recent first
  });

  it('respects ?cursor=before:<iso>&limit=N pagination', async () => { /* ... */ });
  it('requires auth', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to confirm failure**

- [ ] **Step 3: Implement `client/src/api/launcher-tasks.ts`**

```ts
export interface LauncherTasksResponse {
  schemaVersion: 1;
  generatedAt: string;
  cursor?: { before: string };
  tasks: Array<{
    taskId: string;
    taskCid: string;
    solverNet: string;
    postedAt: string;
    state: 'open' | 'claims-in-flight' | 'fully-claimed' | 'settled' | 'failed';
    claims: { current: number; max: number };
    budget: { totalWei: string; remainingWei: string; reclaimableAt?: string };
    summary?: { title?: string; resolutionTime?: string };
  }>;
}

export interface GatherLauncherTasksDeps {
  creatorAddress: string;
  // Reuse existing router-watcher / on-chain log indexer that l2zl.12 will harden later.
  // For v1, accept a function that returns posted-task records from the daemon's existing
  // store (see client/src/store/store.ts) — filtered by creatorAddress.
  fetchPostedTasks: (opts: { creatorAddress: string; limit: number; before?: string }) => Promise<Array<...>>;
}

export async function gatherLauncherTasks(deps: GatherLauncherTasksDeps, opts: { limit?: number; before?: string }): Promise<LauncherTasksResponse> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const tasks = await deps.fetchPostedTasks({ creatorAddress: deps.creatorAddress, limit, before: opts.before });
  const cursor = tasks.length === limit ? { before: tasks[tasks.length - 1].postedAt } : undefined;
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), cursor, tasks };
}
```

- [ ] **Step 4: Wire route in `launcher-endpoints.ts`**

```ts
app.get('/v1/launcher/tasks', async (c) => {
  const cursor = c.req.query('cursor');
  const before = cursor?.startsWith('before:') ? cursor.slice('before:'.length) : undefined;
  const limit = Number(c.req.query('limit') ?? '25');
  const body = await gatherLauncherTasks(deps.tasksDeps, { limit, before });
  return c.json(body);
});
```

- [ ] **Step 5: Run tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/launcher-tasks.ts client/src/api/launcher-endpoints.ts client/test/api/launcher-endpoints.test.ts
git commit -m "feat(api): GET /v1/launcher/tasks paginated by posted-time cursor

Reads from existing store; filter by this daemon's creator address.
Reuses router-watcher data already polled — l2zl.12 will harden the
log filter shape later."
```

---

## Task 8: `PATCH /v1/launcher/solvernets/:name` — launcher-mode setup endpoint

**Files:**
- Modify: `client/src/api/launcher-endpoints.ts`
- Test: `client/test/api/launcher-endpoints.test.ts` — extend

**Why:** Operator-mode setup endpoint never sees `launching` (Task 2). Launcher mode needs its own write surface that toggles `launching` on/off and edits generator-config keys.

- [ ] **Step 1: Write failing test**

```ts
describe('PATCH /v1/launcher/solvernets/:name', () => {
  it('adds launching to roles and persists generator config', async () => {
    const { app, token, readPersistedConfig } = await buildTestApp({ solverNets: { prediction: { roles: ['solving'], ...rest } } });
    const res = await app.request('/v1/launcher/solvernets/prediction', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ launching: true, generator: { cadenceMs: 30_000, maxNewRoundsPerPoll: 10 } }),
    });
    expect(res.status).toBe(200);
    const after = await readPersistedConfig();
    expect(after.solverNets.prediction.roles.sort()).toEqual(['launching', 'solving']);
    expect(after.predictionV1CadenceMs).toBe(30_000);
    expect(after.predictionV1MaxNewRoundsPerPoll).toBe(10);
  });

  it('removes launching from roles when launching: false', async () => {
    const { app, token, readPersistedConfig } = await buildTestApp({ solverNets: { prediction: { roles: ['solving', 'launching'], ...rest } } });
    const res = await app.request('/v1/launcher/solvernets/prediction', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ launching: false }),
    });
    expect(res.status).toBe(200);
    const after = await readPersistedConfig();
    expect(after.solverNets.prediction.roles).toEqual(['solving']);
  });

  it('rejects launching: false when it would leave roles empty (must keep at least one)', async () => {
    const { app, token } = await buildTestApp({ solverNets: { prediction: { roles: ['launching'], ...rest } } });
    const res = await app.request('/v1/launcher/solvernets/prediction', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ launching: false }),
    });
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.message).toMatch(/at least one role/i);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

- [ ] **Step 3: Implement the route**

```ts
app.patch('/v1/launcher/solvernets/:name', async (c) => {
  const name = c.req.param('name');
  const body = await c.req.json() as { launching?: boolean; generator?: Record<string, unknown> };
  // Read existing roles; flip launching; preserve operator roles.
  const existing = deps.getConfig().solverNets?.[name];
  if (!existing) return c.json({ message: 'Unknown SolverNet' }, 404);
  let newRoles = existing.roles ?? [];
  if (body.launching === true) newRoles = Array.from(new Set([...newRoles, 'launching']));
  if (body.launching === false) newRoles = newRoles.filter(r => r !== 'launching');
  if (newRoles.length === 0) return c.json({ message: 'At least one role required' }, 400);
  // Patch persisted config: roles + generator-config keys (predictionV1CadenceMs, etc.)
  await deps.persistConfigPatch({ solverNets: { [name]: { ...existing, roles: newRoles } }, ...mapGeneratorPatch(body.generator) });
  await deps.notifySolverNetsUpdated(); // matches the .15.4.12 cache-invalidation pattern
  return c.json({ ok: true });
});
```

`mapGeneratorPatch` translates the launcher-mode body's `generator: { cadenceMs, maxNewRoundsPerPoll, ... }` into the daemon's `predictionV1CadenceMs`, `predictionV1MaxNewRoundsPerPoll`, etc. config keys. Keep the mapping table in `launcher-endpoints.ts`.

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/launcher-endpoints.ts client/test/api/launcher-endpoints.test.ts
git commit -m "feat(api): PATCH /v1/launcher/solvernets/:name — launcher-mode setup

Toggle launching role and edit generator config in one call. Preserves
operator roles. Rejects role-empty result. Triggers the existing
solver-nets-updated cache invalidation so /v1/launcher/status reflects
the change immediately."
```

---

## Task 9: SPA — types and API client methods

**Files:**
- Modify: `client/src/dashboard/spa/src/api/types.ts`
- Modify: `client/src/dashboard/spa/src/api/client.ts`

- [ ] **Step 1: Add launcher types to `api/types.ts`**

```ts
export interface LauncherStatusResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: Array<{
    name: string;
    generator: {
      state: 'active' | 'paused' | 'errored';
      lastPollAt?: string;
      lastPollSummary?: { evaluated: number; posted: number; skipped: number; skipReasons?: Record<string, number> };
      lastError?: { message: string; at: string };
      cadenceMs: number;
      stale?: boolean;
    };
    openTasks: number;
    budget: { safeAddress: string; safeBalanceWei: string; reservedBudgetWei: string; runwayDays?: number };
  }>;
}

export interface LauncherTasksResponse {
  schemaVersion: 1;
  generatedAt: string;
  cursor?: { before: string };
  tasks: Array<{
    taskId: string;
    taskCid: string;
    solverNet: string;
    postedAt: string;
    state: 'open' | 'claims-in-flight' | 'fully-claimed' | 'settled' | 'failed';
    claims: { current: number; max: number };
    budget: { totalWei: string; remainingWei: string; reclaimableAt?: string };
    summary?: { title?: string; resolutionTime?: string };
  }>;
}

export interface LauncherSolverNetPatch {
  launching?: boolean;
  generator?: {
    cadenceMs?: number;
    maxNewRoundsPerPoll?: number;
    maxNewRoundsPerDay?: number;
    maxOpenRounds?: number;
    allowlistConditionIds?: string[];
    blocklistConditionIds?: string[];
    windowMs?: number;
    resolveGapMs?: number;
  };
}
```

Also narrow the operator-status types so `operator.solverNet.roles` excludes `'launching'`:

```ts
// in OverviewStatusV1 etc.
roles?: Array<'solving' | 'evaluating'>; // narrowed; daemon filters at boundary per spec §6.3
```

(`OperatorCard` already reads this — no change needed there.)

- [ ] **Step 2: Add client methods to `api/client.ts`**

```ts
export const api = {
  // ... existing methods ...
  fetchLauncherStatus: () => request<LauncherStatusResponse>('GET', '/v1/launcher/status'),
  fetchLauncherTasks: (opts: { cursor?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (opts.cursor) query.set('cursor', opts.cursor);
    if (opts.limit) query.set('limit', String(opts.limit));
    const qs = query.toString();
    return request<LauncherTasksResponse>('GET', `/v1/launcher/tasks${qs ? `?${qs}` : ''}`);
  },
  patchLauncherSolverNet: (name: string, patch: LauncherSolverNetPatch) =>
    request<{ ok: true }>('PATCH', `/v1/launcher/solvernets/${encodeURIComponent(name)}`, patch),
};
```

- [ ] **Step 3: Typecheck**

```bash
cd client/src/dashboard/spa && npx tsc -b
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/api/types.ts client/src/dashboard/spa/src/api/client.ts
git commit -m "feat(spa-api): launcher types + client methods

Adds LauncherStatusResponse / LauncherTasksResponse / LauncherSolverNetPatch
types and three api methods. Narrows operator-status roles to exclude
'launching' so Operator-mode UI cannot accidentally render launcher state."
```

---

## Task 10: SPA — `useAppMode` hook + `ModeSwitch` component

**Files:**
- Create: `client/src/dashboard/spa/src/shell/useAppMode.ts`
- Create: `client/src/dashboard/spa/src/shell/useAppMode.test.ts`
- Create: `client/src/dashboard/spa/src/shell/ModeSwitch.tsx`
- Create: `client/src/dashboard/spa/src/shell/ModeSwitch.test.tsx`

- [ ] **Step 1: Write failing test for `useAppMode`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAppMode } from './useAppMode.js';

describe('useAppMode', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defaults to "operator"', () => {
    const { result } = renderHook(() => useAppMode());
    expect(result.current.mode).toBe('operator');
  });

  it('persists mode to localStorage on change', () => {
    const { result } = renderHook(() => useAppMode());
    act(() => result.current.setMode('launcher'));
    expect(result.current.mode).toBe('launcher');
    expect(localStorage.getItem('jinn.app.mode')).toBe('launcher');
  });

  it('hydrates from localStorage on mount', () => {
    localStorage.setItem('jinn.app.mode', 'launcher');
    const { result } = renderHook(() => useAppMode());
    expect(result.current.mode).toBe('launcher');
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

- [ ] **Step 3: Implement `useAppMode.ts`**

```ts
import { useState, useEffect, useCallback } from 'react';

export type AppMode = 'operator' | 'launcher';
const STORAGE_KEY = 'jinn.app.mode';

export interface UseAppMode { mode: AppMode; setMode: (m: AppMode) => void; }

export function useAppMode(): UseAppMode {
  const [mode, setModeState] = useState<AppMode>(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return stored === 'launcher' ? 'launcher' : 'operator';
  });
  const setMode = useCallback((m: AppMode) => {
    setModeState(m);
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, m);
  }, []);
  return { mode, setMode };
}
```

- [ ] **Step 4: Run useAppMode tests; pass**

- [ ] **Step 5: Write failing test for `ModeSwitch`**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModeSwitch } from './ModeSwitch.js';

describe('ModeSwitch', () => {
  it('renders both modes; current is highlighted', () => {
    render(<ModeSwitch mode="operator" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Operator' })).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('button', { name: 'Launcher' })).toHaveAttribute('data-active', 'false');
  });

  it('fires onChange on click', () => {
    const onChange = vi.fn();
    render(<ModeSwitch mode="operator" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Launcher' }));
    expect(onChange).toHaveBeenCalledWith('launcher');
  });
});
```

- [ ] **Step 6: Implement `ModeSwitch.tsx`**

A two-button segmented control matching existing JetBrains Mono styling. Refer to `client/src/dashboard/spa/src/shell/TopTabs.tsx` for the segmented-control pattern. Two buttons (`Operator`, `Launcher`), `data-active` attribute on each, `var(--bg)` background for active, `transparent` for inactive.

```tsx
import type { AppMode } from './useAppMode.js';

interface ModeSwitchProps { mode: AppMode; onChange: (m: AppMode) => void; }
const MODES: AppMode[] = ['operator', 'launcher'];

export function ModeSwitch({ mode, onChange }: ModeSwitchProps): JSX.Element {
  return (
    <div role="group" aria-label="App mode" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
      {MODES.map((m, idx) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          data-active={mode === m ? 'true' : 'false'}
          style={{
            padding: '8px 16px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
            color: mode === m ? 'var(--fg)' : 'var(--fg-muted)',
            background: mode === m ? 'var(--bg)' : 'transparent',
            border: 'none',
            borderRight: idx < MODES.length - 1 ? '1px solid var(--border)' : 'none',
            cursor: 'pointer',
          }}
        >
          {m.charAt(0).toUpperCase() + m.slice(1)}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Run ModeSwitch tests; pass**

- [ ] **Step 8: Commit**

```bash
git add client/src/dashboard/spa/src/shell/useAppMode.ts client/src/dashboard/spa/src/shell/useAppMode.test.ts client/src/dashboard/spa/src/shell/ModeSwitch.tsx client/src/dashboard/spa/src/shell/ModeSwitch.test.tsx
git commit -m "feat(spa-shell): ModeSwitch component + useAppMode hook

Airbnb-style two-state mode toggle (Operator | Launcher) backed by
localStorage. Used by Header (next task) to switch routes between the
two modes."
```

---

## Task 11: SPA — header wiring + routes for `/launcher` and `/launcher/configuration`

**Files:**
- Modify: `client/src/dashboard/spa/src/shell/Header.tsx` — render `ModeSwitch`; on change, navigate via wouter
- Modify: `client/src/dashboard/spa/src/App.tsx` — add `/launcher` and `/launcher/configuration` routes
- Modify: `client/src/dashboard/spa/src/App.routing.test.tsx` — extend routing tests

- [ ] **Step 1: Extend `App.routing.test.tsx`**

```tsx
it('renders LauncherPage at /launcher', () => {
  // Use existing Router test harness pattern
  render(<MemoryRouter initialEntries={['/launcher']}><App /></MemoryRouter>);
  expect(screen.getByText(/Launch a SolverNet|Launched SolverNets/i)).toBeInTheDocument();
});

it('renders LauncherConfigurationPage at /launcher/configuration', () => {
  render(<MemoryRouter initialEntries={['/launcher/configuration']}><App /></MemoryRouter>);
  expect(screen.getByText(/Generator config/i)).toBeInTheDocument();
});
```

(The test will fail because the pages don't exist yet — acceptable; they'll be implemented in Tasks 12–18. Or stub the page imports here and let later tasks fill them in. Pragmatic: stub minimal `LauncherPage`/`LauncherConfigurationPage` placeholders that just render a heading; tighten the placeholders into real content in subsequent tasks. This keeps each task green at commit time.)

- [ ] **Step 2: Stub `Launcher.tsx` and `LauncherConfiguration.tsx`**

```tsx
// client/src/dashboard/spa/src/pages/Launcher.tsx
export function LauncherPage(): JSX.Element {
  return <div><h1>Launch a SolverNet</h1></div>;
}

// client/src/dashboard/spa/src/pages/LauncherConfiguration.tsx
export function LauncherConfigurationPage(): JSX.Element {
  return <div><h1>Generator config</h1></div>;
}
```

- [ ] **Step 3: Add routes in `App.tsx`**

```tsx
import { LauncherPage } from './pages/Launcher.js';
import { LauncherConfigurationPage } from './pages/LauncherConfiguration.js';
// inside <Switch>:
<Route path="/launcher" component={LauncherPage} />
<Route path="/launcher/configuration" component={LauncherConfigurationPage} />
```

- [ ] **Step 4: Wire `ModeSwitch` into `Header.tsx`**

```tsx
import { useAppMode } from './useAppMode.js';
import { ModeSwitch } from './ModeSwitch.js';
import { useLocation } from 'wouter';

export function Header(): JSX.Element {
  const { mode, setMode } = useAppMode();
  const [, setLocation] = useLocation();
  const onModeChange = (m: 'operator' | 'launcher') => {
    setMode(m);
    setLocation(m === 'operator' ? '/overview' : '/launcher');
  };
  return (
    // existing header content + ModeSwitch in its right slot
    <ModeSwitch mode={mode} onChange={onModeChange} />
  );
}
```

(Refer to existing `Header.tsx` layout — slot the ModeSwitch on the right or center per existing visual rhythm.)

- [ ] **Step 5: Run tests**

```bash
cd client && npx vitest run src/dashboard/spa
```
Expected: all SPA tests pass (App.routing.test.tsx, ModeSwitch.test.tsx, useAppMode.test.ts, plus all existing).

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/App.tsx client/src/dashboard/spa/src/App.routing.test.tsx client/src/dashboard/spa/src/shell/Header.tsx client/src/dashboard/spa/src/pages/Launcher.tsx client/src/dashboard/spa/src/pages/LauncherConfiguration.tsx
git commit -m "feat(spa-shell): mount /launcher routes + wire ModeSwitch in Header

Mode change triggers navigation: 'operator' -> /overview, 'launcher' -> /launcher.
Pages are placeholders; subsequent tasks fill in real content."
```

---

## Task 12: SPA — `LauncherEmptyState` and `SetupFlow`

**Files:**
- Create: `client/src/dashboard/spa/src/pages/launcher/EmptyState.tsx`
- Create: `client/src/dashboard/spa/src/pages/launcher/EmptyState.test.tsx`
- Create: `client/src/dashboard/spa/src/pages/launcher/SetupFlow.tsx`
- Create: `client/src/dashboard/spa/src/pages/launcher/SetupFlow.test.tsx`

- [ ] **Step 1: Failing test for `EmptyState`**

```tsx
it('renders headline and CTA', () => {
  const onLaunch = vi.fn();
  render(<EmptyState onLaunch={onLaunch} />);
  expect(screen.getByText("You haven't launched a SolverNet yet.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Launch Prediction SolverNet/i }));
  expect(onLaunch).toHaveBeenCalledWith('prediction');
});
```

- [ ] **Step 2: Implement `EmptyState.tsx`**

```tsx
interface EmptyStateProps { onLaunch: (netName: string) => void; }
export function EmptyState({ onLaunch }: EmptyStateProps): JSX.Element {
  return (
    <div style={{ /* SectionCard-like container; use existing tokens */ }}>
      <h1>You haven't launched a SolverNet yet.</h1>
      <p>A SolverNet directs the network's effort toward producing a kind of knowledge. As Launcher you fund the Tasks operators attempt — and own what gets produced.</p>
      <button type="button" onClick={() => onLaunch('prediction')}>Launch Prediction SolverNet</button>
    </div>
  );
}
```

(Match `SectionCard` rhythm: `var(--bg)` panel, `var(--border)` 1px, JetBrains Mono. Reference `client/src/dashboard/spa/src/components/SectionCard.tsx`.)

- [ ] **Step 3: Failing test for `SetupFlow`**

```tsx
it('walks through 4 steps and patches launcher config on Save', async () => {
  const patchSpy = vi.fn().mockResolvedValue({ ok: true });
  render(<SetupFlow netName="prediction" defaults={genDefaults} safeBalanceWei="1000000000000000000" onPatch={patchSpy} onComplete={vi.fn()} />);
  // step 1: confirm SolverNet — click Next
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
  // step 2: confirm generator defaults — click Next
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
  // step 3: budget plan informational — click Next
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
  // step 4: save
  fireEvent.click(screen.getByRole('button', { name: /Save/i }));
  await waitFor(() => expect(patchSpy).toHaveBeenCalledWith('prediction', { launching: true, generator: expect.any(Object) }));
});
```

- [ ] **Step 4: Implement `SetupFlow.tsx` as a 4-step wizard**

Single component with `useState<step>` (1..4). Each step renders content + Back/Next; step 4 has Save button. Save calls `onPatch('prediction', { launching: true, generator: defaultsAsLauncherGenerator })`. Use existing form patterns from `NetCard.tsx`.

- [ ] **Step 5: Run tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/pages/launcher/EmptyState.tsx client/src/dashboard/spa/src/pages/launcher/EmptyState.test.tsx client/src/dashboard/spa/src/pages/launcher/SetupFlow.tsx client/src/dashboard/spa/src/pages/launcher/SetupFlow.test.tsx
git commit -m "feat(spa-launcher): empty state + 4-step setup flow

Empty state shows the knowledge-direction framing; CTA opens setup.
Setup walks through SolverNet confirm, generator defaults, budget plan,
save -> patches launcher config and triggers onComplete."
```

---

## Task 13: SPA — `KnowledgeProductionCard` (tier 1) and `EmissionsPlaceholder` (tier 4)

**Files:**
- Create: `client/src/dashboard/spa/src/pages/launcher/KnowledgeProductionCard.tsx` (+ test)
- Create: `client/src/dashboard/spa/src/pages/launcher/EmissionsPlaceholder.tsx` (+ test)

**KnowledgeProductionCard** is the headline tier in the configured-state overview (spec §6.5). It surfaces:
- The SolverNet's intent ("Calibrated probabilistic forecasts of Polymarket-listed events")
- The Brier-spread scoreboard summary (reuse the existing scoreboard data — see `client/src/corpus/prediction-brier-scoreboard.ts` for the calculator and the existing operator-status panel from `.l2zl.6` for SPA-side rendering pattern)
- Corpus growth (count of settled Verdicts in window — also from existing prediction-operator-ux data)
- 5 most recent settled forecasts (predicate + outcome)

For v1 the card can be a simple composition that calls existing data sources. If a backing endpoint doesn't exist for "5 recent settled forecasts," reuse data from `/v1/launcher/tasks` filtering to `state === 'settled'`. If the Brier scoreboard isn't already wire-readable from the SPA, wire a thin `/v1/launcher/scoreboard/:net` endpoint reusing `prediction-brier-scoreboard-report.ts` — but only if needed; otherwise reuse the existing operator-status panel data.

- [ ] **Step 1: Failing test for `KnowledgeProductionCard`**

```tsx
it('renders SolverNet intent + scoreboard headline + recent forecasts', () => {
  render(<KnowledgeProductionCard netName="prediction" scoreboard={fixtureScoreboard} recentSettled={fixtureSettled} />);
  expect(screen.getByText(/Calibrated probabilistic forecasts/i)).toBeInTheDocument();
  expect(screen.getByText(/Brier spread/i)).toBeInTheDocument();
  expect(screen.getAllByTestId('recent-settled-row')).toHaveLength(5);
});
```

- [ ] **Step 2: Implement `KnowledgeProductionCard.tsx`**

Refer to spec §6.5 information hierarchy. Use existing scoreboard rendering patterns. Wrap in `SectionCard`.

- [ ] **Step 3: Failing test for `EmissionsPlaceholder`**

```tsx
it('renders Phase B+ placeholder copy', () => {
  render(<EmissionsPlaceholder />);
  expect(screen.getByText(/ve-JINN gauges|Phase B/i)).toBeInTheDocument();
});
```

- [ ] **Step 4: Implement `EmissionsPlaceholder.tsx`**

Plain disabled `SectionCard` with explanatory copy from spec §6.5 tier 4. No interactivity.

- [ ] **Step 5: Run tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/pages/launcher/KnowledgeProductionCard.tsx client/src/dashboard/spa/src/pages/launcher/KnowledgeProductionCard.test.tsx client/src/dashboard/spa/src/pages/launcher/EmissionsPlaceholder.tsx client/src/dashboard/spa/src/pages/launcher/EmissionsPlaceholder.test.tsx
git commit -m "feat(spa-launcher): tier 1 knowledge-production + tier 4 emissions placeholder

Tier 1 surfaces what the SolverNet is producing (intent, Brier
scoreboard, recent settled forecasts). Tier 4 is a disabled
ve-JINN-gauge placeholder for Phase B+ visibility."
```

---

## Task 14: SPA — `GeneratorStatusCard` (tier 3) with stale-poll banner

**Files:**
- Create: `client/src/dashboard/spa/src/pages/launcher/GeneratorStatusCard.tsx` (+ test)

- [ ] **Step 1: Failing test**

```tsx
it('renders state pill, last poll timestamp, and last poll summary', () => {
  render(<GeneratorStatusCard status={fixtureActiveStatus} onPause={vi.fn()} onResume={vi.fn()} />);
  expect(screen.getByText('Active')).toBeInTheDocument();
  expect(screen.getByText(/last poll/i)).toBeInTheDocument();
  expect(screen.getByText(/3 markets evaluated/)).toBeInTheDocument();
});

it('renders stale banner when stale=true', () => {
  render(<GeneratorStatusCard status={{ ...fixtureActiveStatus, stale: true }} onPause={vi.fn()} onResume={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/generator may be stuck/i);
});

it('renders error banner when state=errored', () => {
  render(<GeneratorStatusCard status={fixtureErroredStatus} onPause={vi.fn()} onResume={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/polymarket 503/i);
});
```

- [ ] **Step 2: Implement `GeneratorStatusCard.tsx`**

Pattern after `OperatorCard.tsx`. State pill colors: active=`var(--vow-green)`, paused=`var(--fg-muted)`, errored=`var(--break-red)`. Stale banner uses `var(--break-red)` border, "Generator may be stuck — last poll was Xm ago, expected within Ym" copy.

- [ ] **Step 3: Run tests; pass**

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/pages/launcher/GeneratorStatusCard.tsx client/src/dashboard/spa/src/pages/launcher/GeneratorStatusCard.test.tsx
git commit -m "feat(spa-launcher): GeneratorStatusCard with stale-poll banner

Renders generator state pill, last poll summary, error / stale banners.
Stale banner triggers when status.stale=true (set server-side when
lastPollAt + 2*cadence < now)."
```

---

## Task 15: SPA — `CostCard` (tier 2) and `PostedTasksList` (tier 3)

**Files:**
- Create: `client/src/dashboard/spa/src/pages/launcher/CostCard.tsx` (+ test)
- Create: `client/src/dashboard/spa/src/pages/launcher/PostedTasksList.tsx` (+ test)

- [ ] **Step 1: Failing test for `CostCard`**

```tsx
it('renders 7-day burn rate, Tasks funded, open-task budget reservations', () => {
  render(<CostCard burn7dWei="500000000000000000" tasksFunded7d={42} openTaskBudgetWei="200000000000000000" />);
  expect(screen.getByText(/0.5 ETH/)).toBeInTheDocument(); // formatted from wei
  expect(screen.getByText(/42 Tasks/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Implement `CostCard.tsx`**

Use existing wei-formatting helper from `client/src/dashboard/spa/src/...` (likely `formatEth`). `SectionCard` wrapper. Three-cell mini-stat layout.

- [ ] **Step 3: Failing test for `PostedTasksList`**

```tsx
it('renders 5 most recent tasks with state pill and budget remaining', () => {
  render(<PostedTasksList tasks={fixture10Tasks} onLoadMore={vi.fn()} />);
  expect(screen.getAllByTestId('posted-task-row')).toHaveLength(5);
  expect(screen.getByRole('button', { name: /View all/i })).toBeInTheDocument();
});

it('calls onLoadMore on View all click', () => { /* ... */ });
```

- [ ] **Step 4: Implement `PostedTasksList.tsx`**

5 rows by default. State pill colors mirror `GeneratorStatusCard` palette. "View all" button calls `onLoadMore` which in the parent (Task 16) triggers paginated fetch via `api.fetchLauncherTasks`.

- [ ] **Step 5: Run tests; pass**

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/pages/launcher/CostCard.tsx client/src/dashboard/spa/src/pages/launcher/CostCard.test.tsx client/src/dashboard/spa/src/pages/launcher/PostedTasksList.tsx client/src/dashboard/spa/src/pages/launcher/PostedTasksList.test.tsx
git commit -m "feat(spa-launcher): tier 2 cost card + tier 3 posted-tasks list

Cost card shows 7-day burn, Tasks funded, open-budget reservations.
Posted-tasks list defaults to 5 rows with View-all expansion via
api.fetchLauncherTasks pagination."
```

---

## Task 16: SPA — `Launcher.tsx` page composition

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Launcher.tsx` — replace stub with full composition
- Create: `client/src/dashboard/spa/src/pages/Launcher.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
it('renders empty state when no SolverNet has launching role', async () => {
  vi.mocked(api.fetchLauncherStatus).mockResolvedValue({ schemaVersion: 1, generatedAt: '...', nets: [] });
  render(<LauncherPage />);
  await screen.findByText("You haven't launched a SolverNet yet.");
});

it('renders configured-state overview when a SolverNet has launching role', async () => {
  vi.mocked(api.fetchLauncherStatus).mockResolvedValue(fixtureLauncherStatus);
  vi.mocked(api.fetchLauncherTasks).mockResolvedValue(fixtureLauncherTasks);
  render(<LauncherPage />);
  await screen.findByText(/Calibrated probabilistic forecasts/i);
  expect(screen.getByText(/Brier spread/i)).toBeInTheDocument();
  expect(screen.getByText(/0\.5 ETH/i)).toBeInTheDocument();
  expect(screen.getByText(/Active/i)).toBeInTheDocument();
});

it('opens setup flow on launch CTA click and patches launcher config on save', async () => {
  vi.mocked(api.fetchLauncherStatus).mockResolvedValue({ schemaVersion: 1, generatedAt: '...', nets: [] });
  vi.mocked(api.patchLauncherSolverNet).mockResolvedValue({ ok: true });
  render(<LauncherPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Launch Prediction SolverNet/i }));
  // step through wizard
  // ... fireEvent clicks ...
  await waitFor(() => expect(api.patchLauncherSolverNet).toHaveBeenCalledWith('prediction', { launching: true, generator: expect.any(Object) }));
});
```

- [ ] **Step 2: Implement `Launcher.tsx`**

```tsx
export function LauncherPage(): JSX.Element {
  const { data: status } = useQuery({ queryKey: ['launcher-status'], queryFn: api.fetchLauncherStatus, refetchInterval: 30_000 });
  const { data: tasks } = useQuery({ queryKey: ['launcher-tasks'], queryFn: () => api.fetchLauncherTasks() });
  const [setupOpen, setSetupOpen] = useState(false);

  if (!status) return <LoadingScreen />;
  if (status.nets.length === 0 && !setupOpen) {
    return <EmptyState onLaunch={() => setSetupOpen(true)} />;
  }
  if (setupOpen) {
    return <SetupFlow netName="prediction" /* ...defaults from config catalog... */ onPatch={api.patchLauncherSolverNet} onComplete={() => { setSetupOpen(false); /* refetch */ }} />;
  }
  // configured state
  return (
    <div>
      {status.nets.map(net => (
        <Fragment key={net.name}>
          <KnowledgeProductionCard netName={net.name} scoreboard={...} recentSettled={...} />
          <CostCard burn7dWei={...} tasksFunded7d={...} openTaskBudgetWei={net.budget.reservedBudgetWei} />
          <GeneratorStatusCard status={net.generator} onPause={...} onResume={...} />
          <PostedTasksList tasks={tasks?.tasks.filter(t => t.solverNet === net.name) ?? []} onLoadMore={...} />
          <EmissionsPlaceholder />
        </Fragment>
      ))}
    </div>
  );
}
```

(Use `@tanstack/react-query` already in the SPA's deps. Mock for tests using `vi.mocked(api.fetchLauncherStatus)`.)

- [ ] **Step 3: Run tests; pass**

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/pages/Launcher.tsx client/src/dashboard/spa/src/pages/Launcher.test.tsx
git commit -m "feat(spa-launcher): compose overview page from tier 1-4 cards

Empty state -> setup flow -> configured state with KnowledgeProductionCard,
CostCard, GeneratorStatusCard, PostedTasksList, EmissionsPlaceholder
in spec §6.5 order."
```

---

## Task 17: SPA — `LauncherConfiguration.tsx` page + `GeneratorConfigSection`

**Files:**
- Create: `client/src/dashboard/spa/src/pages/launcher/GeneratorConfigSection.tsx` (+ test)
- Modify: `client/src/dashboard/spa/src/pages/LauncherConfiguration.tsx` — replace stub
- Create: `client/src/dashboard/spa/src/pages/LauncherConfiguration.test.tsx`

- [ ] **Step 1: Failing test for `GeneratorConfigSection`**

```tsx
it('renders fields for cadence, max-per-poll, max-per-day, max-open, allowlist, blocklist, window, resolveGap', () => {
  render(<GeneratorConfigSection netName="prediction" config={fixtureGenConfig} onSave={vi.fn()} />);
  expect(screen.getByLabelText(/Cadence/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Max new rounds per poll/i)).toBeInTheDocument();
  // ... and so on for all 8 fields ...
});

it('calls onSave with the generator-shaped patch', async () => {
  const onSave = vi.fn().mockResolvedValue({ ok: true });
  render(<GeneratorConfigSection netName="prediction" config={fixtureGenConfig} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText(/Cadence/i), { target: { value: '120000' } });
  fireEvent.click(screen.getByRole('button', { name: /Save/i }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ generator: expect.objectContaining({ cadenceMs: 120_000 }) }));
});
```

- [ ] **Step 2: Implement `GeneratorConfigSection.tsx`**

Pattern after `client/src/dashboard/spa/src/pages/configuration/NetCard.tsx`'s editable fields. Use `ConfigField` for each. **No restart-required signaling** — edits hot-apply per spec §6.6.

- [ ] **Step 3: Failing test + implementation for `LauncherConfiguration.tsx`**

The page composes `GeneratorConfigSection` for each launching SolverNet (today only `prediction`). Save calls `api.patchLauncherSolverNet(netName, { generator })`.

- [ ] **Step 4: Run tests; pass**

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/launcher/GeneratorConfigSection.tsx client/src/dashboard/spa/src/pages/launcher/GeneratorConfigSection.test.tsx client/src/dashboard/spa/src/pages/LauncherConfiguration.tsx client/src/dashboard/spa/src/pages/LauncherConfiguration.test.tsx
git commit -m "feat(spa-launcher): generator configuration page

Edits to cadence, market caps, allowlist/blocklist, window, resolveGap.
No restart-required pill — edits hot-apply per spec §5.2."
```

---

## Task 18: End-to-end mode-switch happy-path integration test

**Files:**
- Create: `client/src/dashboard/spa/src/Launcher.e2e.test.tsx` (or extend `App.routing.test.tsx`)

- [ ] **Step 1: Write failing happy-path integration test**

Mock api responses per state. Walk through:
1. Default Operator mode at `/overview`
2. Click ModeSwitch → `Launcher` → URL becomes `/launcher`
3. Empty state visible → click `Launch Prediction SolverNet`
4. Walk through 4-step setup → click Save → `api.patchLauncherSolverNet` called
5. Mock subsequent `api.fetchLauncherStatus` to return launching net → KnowledgeProductionCard visible
6. Click ModeSwitch → `Operator` → URL becomes `/overview`, Operator-mode UI does NOT show launcher state
7. Verify localStorage persists `jinn.app.mode = 'operator'` across this test run

- [ ] **Step 2: Implementation**

Compose existing test fixtures. No new components. The test simply orchestrates clicks + assertions.

- [ ] **Step 3: Run; pass**

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/Launcher.e2e.test.tsx
git commit -m "test(spa): launcher mode end-to-end happy path

Walks Operator -> Launcher mode switch, empty state -> setup -> configured,
back to Operator with strict information separation maintained."
```

---

## Task 19: Final verification + push-readiness

- [ ] **Step 1: Full daemon typecheck + tests**

```bash
cd client && npx tsc --noEmit
cd client && yarn vitest run
```
Expected: clean typecheck; all daemon + SPA tests pass.

- [ ] **Step 2: Manual exercise**

Start daemon locally against an Anvil fork (`anvil --fork-url https://mainnet.base.org`), run `JINN_PASSWORD=test yarn start`, open the SPA, switch to Launcher mode, complete setup flow, verify generator polls within one cadence. Verify no daemon restart was required. Switch back to Operator mode; verify no launcher state visible.

- [ ] **Step 3: Close bd issues**

If a parent bd issue was filed for this implementation, close it referencing the spec + plan + final commit hash. (TBD: file `jinn-mono-l2zl.16` or sibling under `l2zl` for "Implement Launcher role and Launcher mode per spec/2026-05-05-launcher-role-and-mode.md" before starting; close on completion.)

- [ ] **Step 4: Push**

Per the project's session-completion protocol (see root `CLAUDE.md`):

```bash
git pull --rebase
bd dolt push
git push
```

---

## Self-Review Notes

**Spec coverage check:**
- §3 invariants 1–6 → all reflected in implementation choices (1 net = 1 launcher in §1 framing of bd close note; shared Safe in Task wallet/bootstrap reuse; multi-role in Task 1; modes ≠ daemon state in Task 10/11; roles configured by mode in Task 8 + Task 11; economics deferred in §4 of plan).
- §5.1 role enum → Task 1.
- §5.2 hot-spawn → Task 4.
- §5.3 endpoints → Tasks 6 (status), 7 (tasks). Plus Task 8 for the launcher-side write endpoint (added during implementation planning to satisfy strict-mode-separation properly).
- §6.1 mode switch → Task 10.
- §6.2 routes → Task 11.
- §6.3 strict separation → Task 3 (boundary filter) + Task 9 (type narrowing).
- §6.4 empty/setup → Task 12.
- §6.5 configured overview tiers → Tasks 13, 14, 15, 16.
- §6.6 launcher config page → Task 17.
- §7 wallet/bootstrap → no new code; called out in plan §Conventions.
- §8 in-scope items 1–10 → all mapped to a task.

**Placeholder scan:**
- "TBD: file `jinn-mono-l2zl.16`" in Task 19 step 3 — this is a deferred decision, not a missing-task placeholder. The bd parent ID is genuinely TBD until filed; the action is named.
- No other TBDs / TODOs.

**Type consistency check:**
- `LauncherStatusResponse`, `LauncherTasksResponse`, `LauncherSolverNetPatch` are defined in Task 9 and used identically in Tasks 6, 7, 8, 16, 17.
- `gen.getState()` shape from Task 5 matches consumption in Task 6.
- `getRoles` callback signature consistent across Tasks 4 and 5.
- `roles: Array<'solving' | 'evaluating'>` narrowed type used consistently in Tasks 3, 9, and the operator-status payload.
