# Onboarding SPA (PR B, #983) — Stacked-on-PR-A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the #983 guided onboarding flow actually work end-to-end on a hot-applying daemon: (1) gate the dashboard hand-off on a genuine "onboarding finished" flag instead of `joinedSolverNets`-non-empty, and (2) re-source the onboarding SolverNet step from the live registry so the join is keyed by the real manifest cid the running daemon filters on.

**Architecture:** The branch already carries six SPA commits from the first attempt, plus PR A's daemon hot-apply of a join (a join made after the bootstrap→running flip takes effect with no restart, returning `restartRequired:false`). PR A's join-applier also mutates the in-memory `config.joinedSolverNets`, so the `GET /v1/bootstrap` `configReader` reflects an onboarding join live. This plan adds a parallel `config.onboardingComplete` flag (persisted to disk + mutated in-memory via the same pattern), surfaces it in `/v1/bootstrap`, and flips the `App.tsx` overlay gate to read it. Separately it rewrites `SolverNetStep` to read `api.solvernets.listRegistry()` / `api.solvernets.getManifest(cid)` (filtered to `swe-rebench-v2`, 503-tolerant) and joins under the real cid, and threads that cid through `Onboarding.tsx`'s harness/model upsert and the new "Enter dashboard" → finished-flag write.

**Tech Stack:** TypeScript, Hono (daemon HTTP API), Zod (config schema), React + @tanstack/react-query + shadcn/ui (SPA), Vitest (unit), Playwright (`testing-jinn-app` E2E), chrome-devtools MCP (manual smoke).

---

## Premise audit (read before starting)

All premises in the brief were validated against the worktree **except one**, which is reframed below. Stop-and-report any further premise that does not hold during execution.

1. **PR A mutates in-memory config on hot-apply — CONFIRMED and load-bearing.** `client/src/daemon/join-applier.ts:72-73` does `deps.config.joinedSolverNets[cid] = entry`. The bootstrap endpoint's `configReader` (`client/src/main.ts:1185-1189`) closes over the same in-memory `config` object and surfaces `config.joinedSolverNets`. **This is the only reason the existing `App.tsx` gate ever sees an onboarding join** — the join *endpoint* itself (`client/src/api/setup-endpoints.ts:548-612`) reads/writes **disk only** and never touches the in-memory object. Consequence for this plan: the new `onboardingComplete` flag MUST also mutate the in-memory `config` object (not just persist to disk), or it will never appear in `/v1/bootstrap` until the next daemon boot. Task 1 does exactly that, mirroring the join-applier pattern.

2. **Brief said `api.solvernets.registry` (list) — the actual method name is `api.solvernets.listRegistry()`.** See `client/src/dashboard/spa/src/api/client.ts:366-377`. The manifest loader is `api.solvernets.getManifest(cid)` (`client/.../api/client.ts:378-381`). The plan uses the real names.

3. **Registry summary shape carries the manifest cid and contract id — CONFIRMED.** `SolverNetManifestSummary` (`client/.../api/types.ts:674-689`) has `manifestCid`, `contractId`, `contractVersion`, `name`, `openRoles`, `status`. Filter onboarding to `contractId === 'swe-rebench-v2'` and `status === 'launched'`, then join under `summary.manifestCid`.

4. **503 `subsystem_not_ready` is surfaced as a thrown `Error` with `.code` — CONFIRMED.** `jfetch` sets `error.code = payload?.error` and `error.status = res.status` (`client/.../api/client.ts:71-76`). `RegistryCatalog.tsx:59-113` and `HarnessSelectStep.tsx:39` both branch on this code; `SolverNetStep` will adopt the same swallow-and-retry pattern.

5. **`config-reread.ts` is gone — CONFIRMED.** Do not reintroduce it. The stale doc comments referencing it (`SolverNetStep.tsx:23`, `App.tsx:95-96`) are corrected as part of Tasks 1-2.

6. **Spec is authoritative and unchanged.** `client/OPERATOR-APP-SPEC.md` §2.4/§2.8/§2.9/§2.10 confirm: ≥1 joined SolverNet + ready solver harness + selected model is the Bootstrap completion criterion (§2.8 lines 197-206); onboarding's "join a SolverNet to finish" is a takeover-phase message distinct from running-mode `no_solvernets_joined` (§2.10 line 302). Do not edit the spec.

7. **Scope guard — do NOT touch** `client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.tsx` or any Settings surface (those are #1024 / the #983 split per §2.9 line 241, §2.11 line 311).

---

## File Structure

**Backend (daemon):**
- `client/src/config.ts` — add `onboardingComplete: z.boolean().optional()` to the config schema (near `joinedSolverNets`, ~line 473). MODIFY.
- `client/src/api/setup-endpoints.ts` — add `POST /v1/operator/onboarding-complete` route + a `markOnboardingComplete?` config callback to `SetupRoutesConfig`. MODIFY.
- `client/src/api/bootstrap-endpoint.ts` — extend `configReader` return type with `onboardingComplete?: boolean` and spread it into the running-mode response. MODIFY.
- `client/src/main.ts` — supply `onboardingComplete` in the bootstrap `configReader` (line 1185-1189) and wire `markOnboardingComplete` into `addSetupRoutes` so it mutates the in-memory `config`. MODIFY.

**SPA:**
- `client/src/dashboard/spa/src/api/types.ts` — add `onboardingComplete?: boolean` to `BootstrapState` (~line 146). MODIFY.
- `client/src/dashboard/spa/src/api/client.ts` — add `operator.completeOnboarding()` calling the new endpoint (~line 462, after `listJoined`). MODIFY.
- `client/src/dashboard/spa/src/App.tsx` — gate on `mode==='running' && onboardingComplete` (lines 87-101). MODIFY.
- `client/src/dashboard/spa/src/regions/onboarding/SolverNetStep.tsx` — re-source from live registry, join under real cid, 503-tolerant. REWRITE.
- `client/src/dashboard/spa/src/regions/Onboarding.tsx` — thread the real cid through the harness upsert + call `completeOnboarding()` from "Enter dashboard" (lines 125-151, 271-278). MODIFY.

**Tests:**
- `client/test/api/setup-endpoints.test.ts` — new `describe('POST /v1/operator/onboarding-complete')`. MODIFY.
- `client/test/api/bootstrap-endpoint.test.ts` — assert `onboardingComplete` surfaces. MODIFY.
- `client/src/dashboard/spa/src/App.routing.test.tsx` — update the three #983 gate tests (lines 380-425) to use `onboardingComplete`. MODIFY.
- `client/src/dashboard/spa/src/regions/onboarding/SolverNetStep.test.tsx` — REWRITE for the live-registry mocks + 503 case.
- `client/src/dashboard/spa/src/regions/Onboarding.test.tsx` — EXISTS (320 lines). It mocks the API client (`getSolverNets`, `operator.join`, `harnessReadiness`) and drives the **real** child steps. Task 3 changes `SolverNetStep` to read `listRegistry` and key joins by the real cid, so this suite's `getSolverNets` mock and synthetic-`'swe-rebench-v2'`-keyed `joinedSolverNets` fixtures must be migrated (Task 4.2). MODIFY (do not create a new file).

---

## Task 1 — Backend: `onboardingComplete` config flag + endpoint + bootstrap surfacing

**Files:**
- Modify: `client/src/config.ts:473` (schema, add sibling field)
- Modify: `client/src/api/setup-endpoints.ts:62-122` (config type), `:466` (new route, register near the join route)
- Modify: `client/src/api/bootstrap-endpoint.ts:23-27` (reader type), `:236-260` (response spread)
- Modify: `client/src/main.ts:1185-1189` (configReader), and the `setup: { ... }` block (`client/src/main.ts:1289`, which is the `SetupRoutesConfig` passed to `addSetupRoutes` via `client/src/api/server.ts:616`) to pass `markOnboardingComplete`
- Test: `client/test/api/setup-endpoints.test.ts`, `client/test/api/bootstrap-endpoint.test.ts`

### Step 1.1 — Add the config schema field

- [ ] **Add `onboardingComplete` to the Zod config schema.**

In `client/src/config.ts`, immediately after the `joinedSolverNets` block closes (after line 494, before the `trustedImplSigners` block), add:

```ts
  /**
   * Set true once the operator clicks "Enter dashboard" at the end of the
   * #983 guided onboarding takeover. Distinct from `joinedSolverNets` being
   * non-empty: a node can have a membership mid-onboarding (the first join
   * populates the map) yet not have finished harness/model selection. The SPA
   * gates the bootstrap→dashboard hand-off on this flag (see App.tsx), so the
   * first join no longer ejects the operator before the harness step.
   *
   * Written by POST /v1/operator/onboarding-complete (persisted to disk AND
   * mutated in-memory so GET /v1/bootstrap reflects it without a restart).
   */
  onboardingComplete: z.boolean().optional(),
```

### Step 1.2 — Write the failing endpoint test

- [ ] **Add the endpoint test (will fail: route not defined).**

In `client/test/api/setup-endpoints.test.ts`, add a new describe block after the `POST /v1/operator/join/:cid` block (after line ~880, follow the existing `writeConfig` / `mkdtempSync` style):

```ts
describe('POST /v1/operator/onboarding-complete', () => {
  const writeConfig = (path: string, body: unknown): void => {
    require('node:fs').writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  };

  it('persists onboardingComplete:true and preserves other keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-onboarding-complete-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet' });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/onboarding-complete', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; onboardingComplete: boolean };
    expect(body.ok).toBe(true);
    expect(body.onboardingComplete).toBe(true);

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.onboardingComplete).toBe(true);
    expect(persisted.network).toBe('testnet');
  });

  it('invokes the in-memory markOnboardingComplete callback when supplied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-onboarding-complete-cb-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {});
    const markOnboardingComplete = vi.fn();

    const app = new Hono();
    addSetupRoutes(app, { configPath, markOnboardingComplete });

    const res = await app.request('/v1/operator/onboarding-complete', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(markOnboardingComplete).toHaveBeenCalledTimes(1);
  });
});
```

Confirm `vi` and `readFileSync` are already imported at the top of the file (they are used elsewhere in this suite; add to the import if absent).

### Step 1.3 — Run the test to confirm it fails

- [ ] Run: `cd client && yarn vitest run test/api/setup-endpoints.test.ts`
  Expected: FAIL — `404` from the unregistered route (or `markOnboardingComplete` unknown).

### Step 1.4 — Add the config callback + route

- [ ] **Extend `SetupRoutesConfig` and register the route.**

In `client/src/api/setup-endpoints.ts`, add to the `SetupRoutesConfig` interface (after `joinApplier?`, line ~121):

```ts
  /**
   * #983: called after POST /v1/operator/onboarding-complete persists the flag
   * to disk, so the daemon's in-memory config reflects it and GET /v1/bootstrap
   * (which reads the in-memory config) returns onboardingComplete:true without
   * a restart. Mirrors the join-applier's in-memory mutation (join-applier.ts).
   */
  markOnboardingComplete?: () => void;
```

Then register the route. Place it immediately after the `POST /v1/operator/join/:cid` handler closes (after line ~638, before the `DELETE` handler at line ~645):

```ts
  // POST /v1/operator/onboarding-complete — #983. The operator clicked
  // "Enter dashboard" at the end of the guided onboarding takeover (gated SPA-
  // side on ≥1 join AND a ready solver harness AND a selected model). Persists
  // the flag to disk and mutates the in-memory config so GET /v1/bootstrap
  // reflects it live; App.tsx then drops the takeover for <Operating>.
  app.post('/v1/operator/onboarding-complete', (c) => {
    const cfgPath = config.configPath ?? DEFAULT_CONFIG_PATH;
    try {
      persistConfigValue('onboardingComplete', true, cfgPath);
    } catch (err) {
      return c.json({
        error: 'config_write_failed',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }
    config.markOnboardingComplete?.();
    return c.json({ ok: true, onboardingComplete: true });
  });
```

`persistConfigValue` and `DEFAULT_CONFIG_PATH` are already in scope in this function (line 127, line 40).

### Step 1.5 — Run the endpoint test to confirm it passes

- [ ] Run: `cd client && yarn vitest run test/api/setup-endpoints.test.ts`
  Expected: PASS (both new cases + all pre-existing join cases unchanged).

### Step 1.6 — Write the failing bootstrap-surfacing test

- [ ] **Add a bootstrap-endpoint test (will fail: field not surfaced).**

In `client/test/api/bootstrap-endpoint.test.ts`, add inside the `describe('GET /v1/bootstrap')` block:

```ts
  it('surfaces onboardingComplete from the configReader in running mode', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, {
      earningDir,
      configReader: () => ({ onboardingComplete: true }),
    });
    const res = await app.request('/v1/bootstrap');
    const body = (await res.json()) as { mode: string; onboardingComplete?: boolean };
    expect(body.mode).toBe('running');
    expect(body.onboardingComplete).toBe(true);
  });

  it('omits onboardingComplete when the configReader does not set it', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir, configReader: () => ({}) });
    const res = await app.request('/v1/bootstrap');
    const body = (await res.json()) as { onboardingComplete?: boolean };
    expect(body.onboardingComplete).toBeUndefined();
  });
```

### Step 1.7 — Run to confirm it fails

- [ ] Run: `cd client && yarn vitest run test/api/bootstrap-endpoint.test.ts`
  Expected: FAIL — `onboardingComplete` is `undefined` in the first case.

### Step 1.8 — Surface the field in the bootstrap endpoint

- [ ] **Extend the reader type and the running-mode response.**

In `client/src/api/bootstrap-endpoint.ts`, extend the `configReader` return type (lines 23-27) to add the field after `joinedSolverNets`:

```ts
  configReader?: () => {
    rpcUrl?: string;
    defaultRpcUrl?: string;
    joinedSolverNets?: Record<string, unknown>;
    onboardingComplete?: boolean;
  };
```

Then in the running/setup response object (after line 250, the `joinedSolverNets` spread), add:

```ts
      ...(cfg.onboardingComplete !== undefined ? { onboardingComplete: cfg.onboardingComplete } : {}),
```

(Do NOT add it to the `uninitialized` branch at lines 179-187 — onboarding is never complete pre-state-file.)

### Step 1.9 — Run to confirm it passes

- [ ] Run: `cd client && yarn vitest run test/api/bootstrap-endpoint.test.ts`
  Expected: PASS.

### Step 1.10 — Wire main.ts (configReader + callback)

- [ ] **Surface the flag and wire the in-memory mutation.**

In `client/src/main.ts`, extend the bootstrap `configReader` (lines 1185-1189):

```ts
        configReader: () => ({
          rpcUrl: config.rpcUrl,
          defaultRpcUrl: CHAIN_CONFIG.rpcUrl,
          joinedSolverNets: config.joinedSolverNets as Record<string, unknown> | undefined,
          onboardingComplete: config.onboardingComplete,
        }),
```

Then, in the `setup: { ... }` block (`client/src/main.ts:1289` — the `SetupRoutesConfig` that already passes `configPath`, `joinApplier`, etc., consumed by `addSetupRoutes` in `client/src/api/server.ts:616`), add:

```ts
        // #983: mutate the in-memory config so GET /v1/bootstrap reflects the
        // completion flag live (the endpoint persists to disk; this keeps the
        // configReader's in-memory read consistent — same pattern as the
        // join-applier's config write). Cast: JinnConfig has the optional field.
        markOnboardingComplete: () => {
          (config as { onboardingComplete?: boolean }).onboardingComplete = true;
        },
```

Confirm `config` is the same object referenced by the `configReader` closure (it is — both close over the module-level `const config = loadConfig(CONFIG_PATH)` at line 199).

### Step 1.11 — Typecheck + commit

- [ ] Run: `cd client && yarn typecheck`
  Expected: zero errors.
- [ ] Run: `cd client && yarn vitest run test/api/setup-endpoints.test.ts test/api/bootstrap-endpoint.test.ts`
  Expected: PASS.
- [ ] Commit:

```bash
git add client/src/config.ts client/src/api/setup-endpoints.ts client/src/api/bootstrap-endpoint.ts client/src/main.ts client/test/api/setup-endpoints.test.ts client/test/api/bootstrap-endpoint.test.ts
git commit -m "feat(api): onboarding-complete flag — endpoint + in-memory + bootstrap surfacing (#983)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**AC mapping:** Spec §2.8 (Bootstrap completion criterion is a real flag, not inferred); §3.2 (hot-apply: no restart — in-memory mutation + disk persist).

---

## Task 2 — SPA: `App.tsx` full-completion gate

**Files:**
- Modify: `client/src/dashboard/spa/src/api/types.ts:146` (add `onboardingComplete?` to `BootstrapState`)
- Modify: `client/src/dashboard/spa/src/App.tsx:87-101` (gate logic + stale comment)
- Test: `client/src/dashboard/spa/src/App.routing.test.tsx:380-425`

### Step 2.1 — Add the SPA type

- [ ] **Add `onboardingComplete` to `BootstrapState`.**

In `client/src/dashboard/spa/src/api/types.ts`, inside `interface BootstrapState`, after the `joinedSolverNets` field (after line 155, before the `error` field at line 157):

```ts
  /**
   * #983: true once the operator clicked "Enter dashboard" at the end of the
   * guided onboarding takeover. App.tsx gates the bootstrap→dashboard hand-off
   * on `mode==='running' && onboardingComplete` so the first SolverNet join no
   * longer ejects the operator before the harness/model step. Sourced from the
   * daemon's in-memory config (POST /v1/operator/onboarding-complete writes it).
   */
  onboardingComplete?: boolean;
```

### Step 2.2 — Update the failing routing tests

- [ ] **Rewrite the three #983 gate tests to use `onboardingComplete`.**

In `client/src/dashboard/spa/src/App.routing.test.tsx`:

(a) The "routes /operator/network directly to NetworkTab" test (lines 380-387) — add `onboardingComplete: true` to the mocked bootstrap so it still reaches the operator Switch:

```ts
    vi.mocked(api.getBootstrap).mockResolvedValue({
      mode: 'running',
      chain: 'base-sepolia',
      joinedSolverNets: { 'bafkreich-x': { manifestCid: 'bafkreich-x', roles: ['solver'] } },
      onboardingComplete: true,
    } as unknown as BootstrapState);
```

(b) The "holds Onboarding when running but no SolverNet is joined" test (lines 399-414) — rename intent to "holds Onboarding when running but onboarding not complete" and drop the join while leaving `onboardingComplete` absent:

```ts
  it('holds Onboarding when running but onboarding is not complete (#983)', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      mode: 'running',
      chain: 'base-sepolia',
      currentStep: 'complete',
      services: [],
      steps: [],
      schemaVersion: 1,
      // A mid-onboarding node may already have a membership (first join populates
      // it) yet not have finished — onboardingComplete is still false/absent.
      joinedSolverNets: { 'bafkreich-x': { manifestCid: 'bafkreich-x', roles: ['solver'] } },
    } as unknown as BootstrapState);
    render(withProviders(<App />, '/overview'));
    await waitFor(() => expect(screen.getByTestId('onboarding-progress')).toBeTruthy());
    expect(screen.queryByTestId('network-tab')).toBeNull();
  });
```

(c) The "routes to <Operating> when running with ≥1 joined SolverNet" test (lines 416-425) — gate on the flag:

```ts
  it('routes to <Operating> when running and onboarding is complete (#983)', async () => {
    vi.mocked(api.getBootstrap).mockResolvedValue({
      mode: 'running',
      chain: 'base-sepolia',
      joinedSolverNets: { 'bafkreich-x': { manifestCid: 'bafkreich-x', roles: ['solver'] } },
      onboardingComplete: true,
    } as unknown as BootstrapState);
    render(withProviders(<App />, '/operator/network'));
    await waitFor(() => expect(screen.getByTestId('network-tab')).toBeTruthy());
    expect(screen.queryByTestId('onboarding-progress')).toBeNull();
  });
```

### Step 2.3 — Run to confirm (b) fails against current App.tsx

- [ ] Run: `cd client && yarn vitest run src/dashboard/spa/src/App.routing.test.tsx`
  Expected: FAIL on test (b) — current `App.tsx` gates on `joinedSolverNets` non-empty, so a node WITH a join but no flag would wrongly route to `<Operating>` (network-tab present), failing the "must NOT appear" assertion.

### Step 2.4 — Flip the App.tsx gate

- [ ] **Gate on `mode==='running' && onboardingComplete`.**

In `client/src/dashboard/spa/src/App.tsx`, replace the gate block (lines 87-101). Replace the stale comment (which references the removed `config-reread.ts`) and the `onboardingComplete` derivation:

```ts
  // #983: keep the onboarding takeover until the operator finishes the guided
  // flow. The daemon flips mode→running on the earning state machine alone; a
  // node that finished bootstrap but has not completed onboarding (joined ≥1
  // SolverNet AND readied a solver harness AND selected a model) is not yet
  // usable. The first join populates joinedSolverNets mid-flow, so gating on
  // that map ejected the operator before the harness step (#983 MEDIUM). We
  // gate instead on an explicit completion flag the daemon surfaces from its
  // in-memory config, set by POST /v1/operator/onboarding-complete when the
  // operator clicks "Enter dashboard". The harness-ready and model-selected
  // legs are enforced inside <Onboarding>'s own Enter-dashboard gate.
  const onboardingComplete = data?.onboardingComplete === true;
  if (data && (data.mode !== 'running' || !onboardingComplete)) {
    return (
      <TooltipProvider delayDuration={150}>
        <Onboarding />
        <Toaster />
      </TooltipProvider>
    );
  }
```

### Step 2.5 — Run to confirm all three pass

- [ ] Run: `cd client && yarn vitest run src/dashboard/spa/src/App.routing.test.tsx`
  Expected: PASS (all three #983 tests + every other routing test).

### Step 2.6 — Typecheck + commit

- [ ] Run: `cd client && yarn typecheck`
  Expected: zero errors.
- [ ] Commit:

```bash
git add client/src/dashboard/spa/src/api/types.ts client/src/dashboard/spa/src/App.tsx client/src/dashboard/spa/src/App.routing.test.tsx
git commit -m "fix(spa): gate dashboard hand-off on onboardingComplete, not first join (#983)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**AC mapping:** Spec §2.8 (full completion criterion gates the flip); fixes the MEDIUM eject-before-harness path.

---

## Task 3 — SPA: `SolverNetStep` live-registry re-source (the BUG fix)

**Files:**
- Modify: `client/src/dashboard/spa/src/api/client.ts:462` (add `operator.completeOnboarding`)
- Rewrite: `client/src/dashboard/spa/src/regions/onboarding/SolverNetStep.tsx`
- Rewrite: `client/src/dashboard/spa/src/regions/onboarding/SolverNetStep.test.tsx`

### Step 3.1 — Add the SPA client method (used by Task 4, added here for cohesion)

- [ ] **Add `operator.completeOnboarding()`.**

In `client/src/dashboard/spa/src/api/client.ts`, inside the `operator:` block, after `listJoined` (after line ~462, before the closing `}` of `operator`):

```ts
    completeOnboarding: () =>
      jfetch<{ ok: boolean; onboardingComplete: boolean }>(
        '/v1/operator/onboarding-complete',
        { method: 'POST' },
      ),
```

### Step 3.2 — Write the failing SolverNetStep test (live registry + 503)

- [ ] **Rewrite `SolverNetStep.test.tsx` for the live-registry surface.**

Replace the file contents. The component now reads `api.solvernets.listRegistry()` and joins under the real `manifestCid`. Mock the registry, not `getSolverNets`:

```tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SolverNetStep } from './SolverNetStep.js';

const join = vi.fn();
const listRegistry = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    solvernets: { listRegistry: () => listRegistry() },
    operator: { join: (...a: unknown[]) => join(...a) },
  },
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const SWE_CID = 'bafkreichswerebenchv2example';

const sweSummary = {
  manifestCid: SWE_CID,
  solverNetId: 'sn-swe-1',
  name: 'SWE-rebench v2',
  network: 'base-sepolia',
  launcherAgentId: '42',
  launcherSafeAddress: '0xabc0000000000000000000000000000000000001',
  status: 'launched' as const,
  statusUpdatedAt: '2026-06-01T00:00:00.000Z',
  contractId: 'swe-rebench-v2',
  contractVersion: 'v1',
  solutionPriceWei: '0',
  verdictPriceWei: '0',
  openRoles: ['solver' as const, 'evaluator' as const],
  anchorBlock: 1,
};
const predictionSummary = {
  ...sweSummary,
  manifestCid: 'bafkreichpredictionexample',
  name: 'Prediction',
  contractId: 'prediction',
  solverNetId: 'sn-pred-1',
};

function listResponse(summaries: unknown[]) {
  return { summaries, lastRefreshedAt: '2026-06-01T00:00:00.000Z', lastError: null };
}

describe('SolverNetStep (live registry)', () => {
  beforeEach(() => {
    join.mockReset();
    join.mockResolvedValue({
      ok: true,
      restartRequired: false,
      manifestCid: SWE_CID,
      config: { manifestCid: SWE_CID, roles: ['solver'], name: 'SWE-rebench v2' },
    });
    listRegistry.mockReset();
  });

  it('renders only the swe-rebench-v2 card (filtered from the live registry)', async () => {
    listRegistry.mockResolvedValue(listResponse([predictionSummary, sweSummary]));
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-card')).toBeTruthy(),
    );
    expect(screen.queryByText('Prediction')).toBeNull();
  });

  it('shows a non-blocking loading state while the subsystem is starting (503)', async () => {
    const notReady = Object.assign(new Error('503 subsystem_not_ready'), {
      code: 'subsystem_not_ready',
      status: 503,
    });
    listRegistry.mockRejectedValue(notReady);
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-starting')).toBeTruthy(),
    );
    // 503 must NOT surface the hard error alert.
    expect(screen.queryByTestId('onboarding-solvernet-error')).toBeNull();
  });

  it('shows a hard error alert on a non-503 failure', async () => {
    listRegistry.mockRejectedValue(new Error('network'));
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-error')).toBeTruthy(),
    );
  });

  it('shows a starting state when the registry has no swe-rebench-v2 entry yet', async () => {
    listRegistry.mockResolvedValue(listResponse([predictionSummary]));
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-starting')).toBeTruthy(),
    );
  });

  it('joins as solver under the real manifest cid', async () => {
    listRegistry.mockResolvedValue(listResponse([sweSummary]));
    const onJoined = vi.fn();
    render(wrap(<SolverNetStep onJoined={onJoined} joinedCids={[]} />));
    await waitFor(() => screen.getByTestId('onboarding-solvernet-join'));
    fireEvent.click(screen.getByTestId('onboarding-solvernet-join'));
    await waitFor(() => expect(join).toHaveBeenCalled());
    expect(join.mock.calls[0]![0]).toBe(SWE_CID);
    expect(join.mock.calls[0]![1]).toMatchObject({ roles: ['solver'] });
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(SWE_CID));
  });

  it('reflects an already-joined state without re-joining', async () => {
    listRegistry.mockResolvedValue(listResponse([sweSummary]));
    render(wrap(<SolverNetStep onJoined={vi.fn()} joinedCids={[SWE_CID]} />));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-solvernet-card')).toBeTruthy(),
    );
    expect(screen.getByTestId('onboarding-solvernet-joined')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-solvernet-join')).toBeNull();
  });
});
```

### Step 3.3 — Run to confirm it fails

- [ ] Run: `cd client && yarn vitest run src/dashboard/spa/src/regions/onboarding/SolverNetStep.test.tsx`
  Expected: FAIL — current component imports `getSolverNets` / `SolverNetsCatalogResponse` and has no `onboarding-solvernet-starting` testid.

### Step 3.4 — Rewrite SolverNetStep

- [ ] **Rewrite the component to source the live registry and join under the real cid.**

Replace the full contents of `client/src/dashboard/spa/src/regions/onboarding/SolverNetStep.tsx`:

```tsx
import { type JSX } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { RegistryListResponse, SolverNetManifestSummary } from '../../api/types.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';

/**
 * Onboarding step 4 — pick your first SolverNet.
 *
 * Build-delta #4: onboarding surfaces only `swe-rebench-v2`, preselected. The
 * full registry is the post-onboarding surface (RegistryCatalog).
 *
 * #983 (PR B) fix: this step reads the LIVE registry
 * (`api.solvernets.listRegistry()`) and joins under the real `manifestCid`,
 * the same key the running daemon filters claimable tasks by
 * (taskDiscoveryManifestCids). The predecessor synthetic-catalog path keyed
 * the join by `contract.id` ('swe-rebench-v2'), which never matched the
 * daemon's cid set, so the node claimed nothing. The registry holder is
 * populated post-flip; onboarding's action steps render post-flip (under the
 * App overlay), so it is available by then — with a brief 503
 * `subsystem_not_ready` window right after the flip, handled as a
 * non-blocking "starting" state (mirrors RegistryCatalog / HarnessSelectStep).
 *
 * PR A hot-applies the join to the running daemon, so a join made here after
 * the flip takes effect with no restart (restartRequired:false).
 */
const ONBOARDING_CONTRACT_ID = 'swe-rebench-v2';

/** Treated as "still starting", not a hard error (mirrors RegistryCatalog). */
const STARTING_CODES = new Set(['subsystem_not_ready', 'registry_unavailable']);

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  if (err instanceof Error && err.message.includes('subsystem_not_ready')) {
    return 'subsystem_not_ready';
  }
  return undefined;
}

export function SolverNetStep({
  onJoined,
  joinedCids,
}: {
  onJoined: (cid: string) => void;
  joinedCids: string[];
}): JSX.Element {
  const registryQuery = useQuery<RegistryListResponse>({
    queryKey: ['solvernets', 'registry'],
    queryFn: () => api.solvernets.listRegistry(),
    // Re-poll so the brief post-flip not-ready window self-heals without an
    // operator action (same cadence as the readiness probes in JoinFlow).
    refetchInterval: 5_000,
    retry: false,
  });

  const entry: SolverNetManifestSummary | undefined = registryQuery.data?.summaries.find(
    (s) => s.contractId === ONBOARDING_CONTRACT_ID && s.status === 'launched',
  );
  const cid = entry?.manifestCid;
  const alreadyJoined = cid !== undefined && joinedCids.includes(cid);

  const joinMutation = useMutation({
    mutationFn: async () => {
      if (!entry) throw new Error('no swe-rebench-v2 registry entry');
      return api.operator.join(entry.manifestCid, {
        name: entry.name,
        contract: { id: entry.contractId, version: entry.contractVersion },
        roles: ['solver'],
      });
    },
    onSuccess: () => {
      if (entry) onJoined(entry.manifestCid);
    },
  });

  if (registryQuery.isLoading) {
    return (
      <div data-testid="onboarding-solvernet-loading" className="flex flex-col gap-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  // A definitive non-503 failure is a hard error. A 503 not-ready window, OR a
  // 200 response that does not (yet) carry the swe-rebench-v2 entry, is a
  // transient "still starting" state — keep polling, don't block the operator.
  const code = registryQuery.isError ? errorCode(registryQuery.error) : undefined;
  if (registryQuery.isError && !STARTING_CODES.has(code ?? '')) {
    return (
      <Alert variant="blocking" data-testid="onboarding-solvernet-error">
        <AlertTitle>Could not load SolverNets.</AlertTitle>
        <AlertDescription>
          The daemon could not read the SolverNet registry. Retry once startup
          finishes; check daemon logs if it keeps failing.
        </AlertDescription>
      </Alert>
    );
  }

  if (!entry) {
    return (
      <div
        data-testid="onboarding-solvernet-starting"
        className="flex items-center gap-3 font-mono text-[12px] text-[var(--fg-muted)]"
      >
        <Skeleton className="h-4 w-4 rounded-full" />
        Finding your first SolverNet…
      </div>
    );
  }

  return (
    <Card data-testid="onboarding-solvernet-card" data-manifest-cid={entry.manifestCid}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="font-mono text-[15px]">{entry.name}</CardTitle>
          {alreadyJoined ? (
            <Badge data-testid="onboarding-solvernet-joined">Joined</Badge>
          ) : (
            <Badge variant="secondary">Recommended</Badge>
          )}
        </div>
        <CardDescription>Pick your first SolverNet; add more later.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <p className="text-sm text-[var(--fg-muted)]">
          Solve coding tasks; your node claims and submits solutions.
        </p>
        {!alreadyJoined && (
          <Button
            data-testid="onboarding-solvernet-join"
            onClick={() => joinMutation.mutate()}
            disabled={joinMutation.isPending}
          >
            {joinMutation.isPending ? 'Joining…' : 'Join'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
```

Note on copy: the description must not imply the harness evaluates (BRAND/§2.9). "Solve coding tasks; your node claims and submits solutions" is solver-side only. The `SolverNetManifestSummary` has no `description` field, so derive copy locally — keep it plain.

### Step 3.5 — Run to confirm it passes

- [ ] Run: `cd client && yarn vitest run src/dashboard/spa/src/regions/onboarding/SolverNetStep.test.tsx`
  Expected: PASS (all six cases).

### Step 3.6 — Typecheck

- [ ] Run: `cd client && yarn typecheck`
  Expected: zero errors. (If `SolverNetsCatalogResponse` was the only consumer of an import that is now unused elsewhere, leave other files alone — Rule 3.)

### Step 3.7 — Commit

```bash
git add client/src/dashboard/spa/src/api/client.ts client/src/dashboard/spa/src/regions/onboarding/SolverNetStep.tsx client/src/dashboard/spa/src/regions/onboarding/SolverNetStep.test.tsx
git commit -m "fix(spa): onboarding SolverNet step joins under the real manifest cid (#983)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**AC mapping:** The BUG fix — node now claims tasks because the join is keyed by the cid the daemon filters on (CLAUDE.md: tasks whose `solverNetManifestCid` is not in `joinedSolverNets` are ignored). Spec §2.4/§2.5 (Registry is the surface satisfying onboarding's SolverNet step); 503-tolerance per §2.10 / §3.2.

---

## Task 4 — SPA: `Onboarding.tsx` wiring (real cid + Enter-dashboard sets the flag)

**Files:**
- Modify: `client/src/dashboard/spa/src/regions/Onboarding.tsx:125-151, 262-280`
- Modify: `client/src/dashboard/spa/src/regions/Onboarding.test.tsx` (EXISTS — 320 lines; migrate the #983 action-step fixtures + add the completion-write assertion)

### Step 4.1 — Migrate the existing Onboarding test suite to the live-registry + completion-flag shapes

The existing suite (`Onboarding.test.tsx`) drives the **real** child steps and mocks the API client. Task 3 changed `SolverNetStep` to read `api.solvernets.listRegistry()` and key joins by the real cid, and added `api.operator.completeOnboarding()`. Migrate the mock + fixtures:

- [ ] **In the `vi.mock('../api/client.js', ...)` block (lines 17-32):** replace the `getSolverNets: () => getSolverNets()` line with a `solvernets.listRegistry` mock and add `completeOnboarding` to `operator`. Add module-level spies `const listRegistry = vi.fn();` and `const completeOnboarding = vi.fn();` (keep `operatorJoin`, `harnessReadiness`). The block becomes:

```tsx
const listRegistry = vi.fn();
const operatorJoin = vi.fn();
const completeOnboarding = vi.fn();
const harnessReadiness = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    getBootstrap: async (): Promise<BootstrapState> => ({
      schemaVersion: 1,
      mode: 'setup',
      steps: ['wallet', 'safe_predicted', 'awaiting_funding'],
      currentStep: 'wallet',
      services: [],
      chain: 'base-sepolia',
      ...bootstrapOverride,
    }),
    solvernets: { listRegistry: () => listRegistry() },
    operator: {
      join: (...a: unknown[]) => operatorJoin(...a),
      completeOnboarding: () => completeOnboarding(),
    },
    harnessReadiness: (n: string) => harnessReadiness(n),
  },
}));
```

- [ ] **In `beforeEach` (lines 46-72):** replace the `getSolverNets.mockResolvedValue({...nets:[...]})` with a registry response carrying a launched `swe-rebench-v2` summary keyed by a real cid, and reset `completeOnboarding`. Define a shared `const SWE_CID = 'bafkreichswerebenchv2example';` at module scope. The `beforeEach` body:

```tsx
  listRegistry.mockReset();
  listRegistry.mockResolvedValue({
    summaries: [
      {
        manifestCid: SWE_CID,
        solverNetId: 'sn-swe-1',
        name: 'SWE-rebench v2',
        network: 'base-sepolia',
        launcherAgentId: '42',
        launcherSafeAddress: '0xabc0000000000000000000000000000000000001',
        status: 'launched',
        statusUpdatedAt: '2026-06-01T00:00:00.000Z',
        contractId: 'swe-rebench-v2',
        contractVersion: 'v1',
        solutionPriceWei: '0',
        verdictPriceWei: '0',
        openRoles: ['solver', 'evaluator'],
        anchorBlock: 1,
      },
    ],
    lastRefreshedAt: '2026-06-01T00:00:00.000Z',
    lastError: null,
  });
  operatorJoin.mockReset();
  operatorJoin.mockResolvedValue({
    ok: true,
    restartRequired: false,
    manifestCid: SWE_CID,
    config: { manifestCid: SWE_CID, roles: ['solver'], name: 'SWE-rebench v2' },
  });
  completeOnboarding.mockReset();
  completeOnboarding.mockResolvedValue({ ok: true, onboardingComplete: true });
  harnessReadiness.mockReset();
  harnessReadiness.mockResolvedValue({ harnessName: 'codex', manifestCids: [], ready: true });
```

- [ ] **In the `describe('Onboarding action steps (#983)')` block (lines 225-319):** the `joinedSolverNets` fixtures are keyed by the synthetic id `'swe-rebench-v2'`. Re-key them to `[SWE_CID]` so they reflect the real cid (the `primaryCid` Onboarding reads). Update the three fixtures at lines 254-256, 269-271, 292-294, 305-307 to:

```tsx
      joinedSolverNets: {
        [SWE_CID]: { manifestCid: SWE_CID, roles: ['solver'] },
      },
```

### Step 4.2 — Add the failing completion-write assertion

- [ ] **Extend the "persists harness+model via a second join" test (lines 302-318)** to also assert the completion write and the real-cid target. Replace its body's tail (after the `operatorJoin` assertion) with:

```tsx
    fireEvent.click(screen.getByTestId('onboarding-enter-dashboard'));
    await waitFor(() => expect(operatorJoin).toHaveBeenCalled());
    const lastCall = operatorJoin.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe(SWE_CID); // upsert targets the real manifest cid
    expect(lastCall[1]).toMatchObject({ roles: ['solver'], harness: 'codex', model: 'gpt-5.4-mini' });
    // #983: clicking Enter dashboard writes the completion flag so App.tsx
    // drops the takeover.
    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledTimes(1));
```

### Step 4.3 — Run to confirm it fails

- [ ] Run: `cd client && yarn vitest run src/dashboard/spa/src/regions/Onboarding.test.tsx`
  Expected: FAIL — current `enterMutation` (lines 131-144) does NOT call `completeOnboarding`, so the new `completeOnboarding` assertion fails. (The registry/cid migrations should already pass once Task 3's `SolverNetStep` is in place.)

### Step 4.4 — Wire the completion write into Onboarding.tsx

- [ ] **Add the `completeOnboarding` call to the enter mutation.**

In `client/src/dashboard/spa/src/regions/Onboarding.tsx`, the `primaryCid` derivation (lines 125-127) already reads `Object.keys(bootstrap?.joinedSolverNets ?? {})[0]` — this is now the **real cid** because SolverNetStep joins under it and PR A's applier surfaces it in bootstrap. No change needed there.

Modify the `enterMutation` (lines 131-144) to mark onboarding complete after the harness upsert:

```ts
  // Persist harness+model onto the joined membership (second upsert join keyed
  // by the real manifest cid), then mark onboarding complete so App.tsx drops
  // the takeover for <Operating>. PR A hot-applies the join live, so no restart.
  const enterMutation = useMutation({
    mutationFn: async () => {
      if (primaryCid && harnessSel) {
        await api.operator.join(primaryCid, {
          roles: ['solver'],
          harness: harnessSel.harness,
          model: harnessSel.model,
        });
      }
      await api.operator.completeOnboarding();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
```

Also fix the now-stale comment at lines 128-130 (it references the old gate "joinedSolverNets is non-empty"). Replace with:

```ts
  // The App-level overlay (App.tsx) closes the takeover once mode===running
  // AND onboardingComplete — set by completeOnboarding() below.
```

No other change to the JSX is required: the Enter-dashboard button already gates on `completionReady` (lines 150-151, 273) which requires `joinedCids.length > 0 && harnessSel?.ready === true && Boolean(harnessSel?.model)` — matching the spec §2.8 criterion.

### Step 4.5 — Run to confirm it passes

- [ ] Run: `cd client && yarn vitest run src/dashboard/spa/src/regions/Onboarding.test.tsx`
  Expected: PASS.

### Step 4.6 — Typecheck + commit

- [ ] Run: `cd client && yarn typecheck`
  Expected: zero errors.
- [ ] Commit:

```bash
git add client/src/dashboard/spa/src/regions/Onboarding.tsx client/src/dashboard/spa/src/regions/Onboarding.test.tsx
git commit -m "feat(spa): onboarding Enter-dashboard marks completion + upserts under real cid (#983)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**AC mapping:** Spec §2.8 (Enter-dashboard gate = ≥1 join AND ready harness AND model, then writes the completion flag); §3.2 (no separate restart — PR A hot-applies).

---

## Task 5 — Full-suite + scope-guard verification

**Files:** none (verification only). REQUIRED SUB-SKILL: superpowers:verification-before-completion.

### Step 5.1 — SPA unit suite

- [ ] Run: `cd client && yarn vitest run src/dashboard/spa`
  Expected: PASS, zero failures. In particular `notifications/derive.test.ts` (the no-residue lock for a freshly-onboarded node) stays green — confirm it did not need editing (it asserts no `no_solvernets_joined` residue when `joinedSolverNets` is non-empty; unaffected by this change).

### Step 5.2 — Backend suite (touched areas)

- [ ] Run: `cd client && yarn vitest run test/api`
  Expected: PASS.

### Step 5.3 — Full client typecheck

- [ ] Run: `cd client && yarn typecheck`
  Expected: zero errors.

### Step 5.4 — Scope-guard diff check

- [ ] Run: `git diff --stat feat/1037-hot-apply-join..HEAD`
  Expected: NO changes to `client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.tsx` or any `pages/.../settings`/Settings surface (#1024 scope). The changed files must be only those listed in this plan's File Structure. If any out-of-scope file appears, revert it.

### Step 5.5 — Full client unit run (final gate)

- [ ] Run: `cd client && yarn test`
  Expected: PASS. If a pre-existing flaky/unrelated failure appears, confirm it fails identically on the base branch before proceeding (do not "fix" unrelated tests — Rule 3).

---

## Task 6 — Browser walk (mandatory; human-surface change) — Stage 7 verify artifact

**REQUIRED SUB-SKILL:** Use `testing-jinn-app`. This is an operator-visible onboarding change, so a verify artifact is mandatory.

### Step 6.1 — Prefer the Playwright E2E path (deterministic, mocked daemon)

- [ ] Follow `testing-jinn-app`'s Playwright E2E path (mocked daemon API). Author or extend an E2E that exercises the post-flip onboarding action steps:
  1. Mock `GET /v1/bootstrap` → `mode:'running'`, `currentStep:'complete'`, `services:[]`, `joinedSolverNets:{}`, `onboardingComplete` absent → assert the onboarding takeover (`onboarding-progress`) is shown and the action steps (`onboarding-action-steps`) render.
  2. Mock `GET /v1/solvernets/registry` → one `launched` `swe-rebench-v2` summary → assert `onboarding-solvernet-card` renders with `data-manifest-cid` = the real cid.
  3. Mock the same registry returning `503 subsystem_not_ready` first, then 200 → assert `onboarding-solvernet-starting` shows, then self-heals to the card (validates the not-ready window handling).
  4. Click Join → assert `POST /v1/operator/join/<realcid>` fires with `roles:['solver']`.
  5. After the join, mock bootstrap to include the join in `joinedSolverNets` keyed by the real cid; drive the harness step to a ready selection; click Enter dashboard → assert `POST /v1/operator/onboarding-complete` fires.
  6. Mock bootstrap with `onboardingComplete:true` → assert the takeover drops and `<Operating>` (e.g. `network-tab` / overview) renders.
- [ ] Run the E2E: `cd client && yarn vitest run <new-e2e-path>` (or the project's Playwright command per the skill).
  Expected: PASS.

### Step 6.2 — Manual chrome-devtools smoke (only if the MCP is loaded)

- [ ] Per the skill, first `ToolSearch query="chrome devtools navigate"`. If the schemas surface, do a live walk against a running daemon and screenshot: (a) the onboarding takeover with the swe-rebench-v2 card, (b) the post-flip not-ready→card transition if reproducible, (c) Enter-dashboard → `<Operating>`. If the MCP is NOT loaded, the Step 6.1 Playwright path is the verify artifact — note that in the PR.

### Step 6.3 — Capture the verify artifact

- [ ] Record in the PR description: the E2E test path + its passing output (and screenshots if the manual walk ran). This is the Stage 7 verify artifact for the human-surface change.

### Step 6.4 — Commit the E2E (if new)

```bash
git add client/<new-e2e-path>
git commit -m "test(spa): e2e — post-flip onboarding join under real cid + completion gate (#983)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** §2.8 completion criterion → Tasks 1, 2, 4 (flag + gate + Enter-dashboard write). §2.4/§2.5 Registry-as-onboarding-source → Task 3 (live registry). §2.9 harness/model is already shipped (HarnessSelectStep, kept) and gated in Task 4's Enter-dashboard check. §2.10 no-residue lock → Task 5.1 (derive.test stays green). §3.2 hot-apply/no-restart → Tasks 1 & 4 (in-memory mutation + PR A applier). Scope guard §2.9 line 241 / §2.11 line 311 → Task 5.4.
- **Type consistency:** `onboardingComplete: boolean` is consistent across config schema (Task 1.1), `BootstrapState` (Task 2.1), endpoint response (Task 1.4), and App gate (Task 2.4). `completeOnboarding()` is added in Task 3.1 and consumed in Task 4.4. `SolverNetStep` joins via `(cid, body)` matching `api.operator.join`'s signature (`client.ts:408`). `onJoined(cid)` callback signature matches the existing `Onboarding.tsx:146` consumer (it already ignores the arg / invalidates).
- **Placeholder scan:** every code step shows full code; no TBD/TODO.
- **Premise reframed (not a blocker):** the brief's "method `api.solvernets.registry`" is actually `api.solvernets.listRegistry()`; the in-memory-config requirement for the flag (Premise 1) is the one subtlety the brief did not call out — handled in Task 1.10.
