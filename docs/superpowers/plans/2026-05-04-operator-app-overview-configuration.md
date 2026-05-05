# Operator app — Overview + Configuration page split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the operator-app `Operating` dashboard into two top-level pages — `Overview` and `Configuration` — connected by a persistent shell with a sticky right-rail Agent panel, and make every operator-tunable runtime setting editable in-app via a SolverNet catalog model.

**Architecture:** New `wouter`-based router inside the existing `<Onboarding | Operating>` switch. Persistent header + top tabs + agent rail. Configuration is composed of `SectionCard`s; SolverNets section renders a catalog of `NetCard`s with per-net role + harness + model + plugins editing. Per-section save lifecycle. Restart-required pill per field + persistent banner across both tabs after any restart-required save. Backed by three new/modified server endpoints under `/v1/setup/*` and `/v1/solvernets`.

**Tech Stack:** TypeScript, React 18, Vite, Tailwind, Vitest, Testing Library, Playwright, Hono, viem. New dependency: `wouter@^3` (3 kB hooks-based router).

**Spec:** [`docs/superpowers/specs/2026-05-04-operator-app-overview-configuration-design.md`](../specs/2026-05-04-operator-app-overview-configuration-design.md).

**Branding canon:** [`BRAND.md`](../../../BRAND.md), [`DESIGN.md`](../../../DESIGN.md). Apply tokens verbatim — do not invent colors. Two voices (Instrument Serif for feeling, JetBrains Mono for everything else). Hairline 1px borders, no shadows, gold-as-hint, ALL-CAPS-MONO nav, sentence case for actions.

**Working directory for all commands:** `/Users/adrianobradley/harbor/jinn-mono/cargo/client` unless noted.

---

## Phase 0: Prerequisite — rebase onto the merged faucet-cap fix

This branch holds an interim static `DEFAULT_MAX_FAUCET_ITERS = 120` plus a `target_not_reached` "Continue faucet" UX state. PR #84 (`oak/onboarding-faucet-cap-and-rerip`) and PR #85 (`fix/faucet-drip-cap`) both replace this with a dynamic cap derived from `(target − balance)` per drip estimate, applied to both `bootstrap.ts` and `setup-endpoints.ts`. PR #84 also reshapes the SPA card around `balanceWei`/`targetWei` from the response.

Their fix is strictly stronger; ours is a workaround. Implementation gates on one of them landing.

### Task 0: Wait for #84 or #85, then revert our interim faucet bump

**Files (after the upstream merge):**
- Revert in: `client/src/api/setup-endpoints.ts` — remove the `DEFAULT_MAX_FAUCET_ITERS = 120` constant and the `target_not_reached` reason path (the merged PR replaces both with the dynamic cap).
- Revert in: `client/src/dashboard/spa/src/regions/AwaitingFundingCard.tsx` — remove the `'partial'` state and the "Continue faucet" copy (the merged PR's "Fund more" button + balance/target reading replaces it).
- Adjust commits we authored on `operator-shakedown`: `Operator setup-mode resilience and UX` includes both. Either rebase that commit's hunks out, or land the merged-fix on top and let the resolution drop our static bump.

- [ ] **Step 1: Wait for one of the PRs to merge to `main`**

Track #84 and #85 in GitHub. Pick whichever lands first.

- [ ] **Step 2: Rebase `operator-shakedown` on the new `main`**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo
git fetch origin
git rebase origin/main
```

Resolve conflicts in favour of the upstream dynamic-cap implementation. The two files most likely to conflict are `client/src/api/setup-endpoints.ts` and `client/src/dashboard/spa/src/regions/AwaitingFundingCard.tsx`. Drop our `DEFAULT_MAX_FAUCET_ITERS = 120` and our `'partial'` state; keep the upstream version verbatim.

- [ ] **Step 3: Verify the full vitest suite still passes**

```bash
cd client
npx vitest run
```

Expected: clean.

- [ ] **Step 4: Verify the operator can still complete onboarding from a fresh wallet**

Smoke test on Base Sepolia (sweep + topup script in `client/scripts/sweep-and-fund.ts` if you want to skip the actual faucet wait):

```bash
node dist/bin/jinn.js run
# observe the dashboard at http://127.0.0.1:7332/?k=...
# fresh fleet should reach mech_deployed without operator intervention beyond the faucet click
```

- [ ] **Step 5: Force-push the rebased branch**

```bash
git push --force-with-lease origin operator-shakedown
```

Only `--force-with-lease`, never `--force`. The branch is shared with this work; let lease catch any concurrent push.

---

## Phase A: Server endpoints

Each endpoint ships independently. Phase A leaves the SPA unchanged; the new endpoints are wired into the SPA in later phases.

### Task 1: `GET /v1/solvernets` — catalog endpoint

**Files:**
- Create: `client/src/api/solvernets-catalog-build.ts`
- Create: `client/src/api/solvernets-endpoint.ts`
- Modify: `client/src/api/server.ts:202-260` (add route registration)
- Test: `client/test/api/solvernets-catalog-build.test.ts`
- Test: `client/test/api/solvernets-endpoint.test.ts`

- [ ] **Step 1: Write the failing builder test**

```ts
// client/test/api/solvernets-catalog-build.test.ts
import { describe, expect, it } from 'vitest';
import { buildSolverNetsCatalog } from '../../src/api/solvernets-catalog-build.js';

describe('buildSolverNetsCatalog', () => {
  it('emits one entry per registered SolverNet with name, description, state, supported roles, and intrinsic solverType', () => {
    const catalog = buildSolverNetsCatalog({
      registered: [
        {
          name: 'prediction',
          description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
          intrinsicSolverType: 'prediction.v1',
          state: 'live',
          supportedRoles: ['solving', 'evaluating'],
          compatibleHarnesses: [{ name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving'] }],
          compatiblePlugins: [{ name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' }],
        },
      ],
    });
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.nets).toHaveLength(1);
    expect(catalog.nets[0]).toMatchObject({
      name: 'prediction',
      state: 'live',
      intrinsicSolverType: 'prediction.v1',
      supportedRoles: ['solving', 'evaluating'],
    });
    expect(catalog.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns an empty list when no SolverNets are registered', () => {
    const catalog = buildSolverNetsCatalog({ registered: [] });
    expect(catalog.nets).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/solvernets-catalog-build.test.ts`
Expected: FAIL — `Cannot find module '../../src/api/solvernets-catalog-build.js'`.

- [ ] **Step 3: Write the minimal builder**

```ts
// client/src/api/solvernets-catalog-build.ts
export interface SolverNetCatalogEntry {
  name: string;
  description: string;
  state: 'live' | 'available' | 'coming_soon';
  intrinsicSolverType: string;
  supportedRoles: ('solving' | 'evaluating')[];
  compatibleHarnesses: Array<{
    name: string;
    version: string;
    supportsRoles: ('solving' | 'evaluating')[];
  }>;
  compatiblePlugins: Array<{ name: string; version: string; source: string }>;
}

export interface SolverNetsCatalogResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: SolverNetCatalogEntry[];
}

export interface BuildSolverNetsCatalogInput {
  registered: SolverNetCatalogEntry[];
}

export function buildSolverNetsCatalog(input: BuildSolverNetsCatalogInput): SolverNetsCatalogResponse {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    nets: input.registered,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/api/solvernets-catalog-build.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing endpoint test**

```ts
// client/test/api/solvernets-endpoint.test.ts
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { addSolverNetsRoutes } from '../../src/api/solvernets-endpoint.js';

describe('GET /v1/solvernets', () => {
  it('returns the catalog from the registered list', async () => {
    const app = new Hono();
    addSolverNetsRoutes(app, {
      registry: {
        list: () => [
          {
            name: 'prediction',
            description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
            intrinsicSolverType: 'prediction.v1',
            state: 'live' as const,
            supportedRoles: ['solving' as const, 'evaluating' as const],
            compatibleHarnesses: [],
            compatiblePlugins: [],
          },
        ],
      },
    });
    const res = await app.request('/v1/solvernets');
    expect(res.status).toBe(200);
    const body = await res.json() as { schemaVersion: number; nets: Array<{ name: string }> };
    expect(body.schemaVersion).toBe(1);
    expect(body.nets.map((n) => n.name)).toEqual(['prediction']);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/api/solvernets-endpoint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write the endpoint**

```ts
// client/src/api/solvernets-endpoint.ts
import type { Hono } from 'hono';
import { buildSolverNetsCatalog, type SolverNetCatalogEntry } from './solvernets-catalog-build.js';

export interface SolverNetsRegistry {
  list(): SolverNetCatalogEntry[];
}

export interface SolverNetsRoutesConfig {
  registry: SolverNetsRegistry;
}

export function addSolverNetsRoutes(app: Hono, config: SolverNetsRoutesConfig): void {
  app.get('/v1/solvernets', (c) =>
    c.json(buildSolverNetsCatalog({ registered: config.registry.list() })),
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/api/solvernets-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 9: Wire the endpoint into `server.ts`**

Modify `client/src/api/server.ts`. Find the `// SPA index at /` comment around line 168. Above the existing `addBootstrapRoutes(app, config.bootstrap);` call, add:

```ts
import { addSolverNetsRoutes, type SolverNetsRegistry } from './solvernets-endpoint.js';

// at top with other imports
```

```ts
// In ApiServerConfig interface, add:
solverNets?: { registry: SolverNetsRegistry };

// In startApiServer, after addBootstrapRoutes wiring, add:
if (config.solverNets) {
  addSolverNetsRoutes(app, { registry: config.solverNets.registry });
}

// And add to the requireUiToken gate list:
app.use('/v1/solvernets', requireUiToken(config.ui.token));
```

The registry instance comes from `main.ts`. For this task, supply a stub registry that returns the bundled `prediction` entry; the real registry hookup lands in Task 2 once the daemon's harness/plugin registry is loaded.

In `client/src/main.ts`, locate the `setupApiServer = await startApiServer({...})` call and add a `solverNets` entry to its config:

```ts
solverNets: {
  registry: {
    list: () => [
      {
        name: 'prediction',
        description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
        intrinsicSolverType: 'prediction.v1',
        state: 'live',
        supportedRoles: ['solving', 'evaluating'],
        compatibleHarnesses: [
          { name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving'] },
        ],
        compatiblePlugins: [
          { name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' },
        ],
      },
    ],
  },
},
```

- [ ] **Step 10: Typecheck and run all server tests**

Run: `npx tsc --noEmit && npx vitest run test/api/`
Expected: typecheck clean, all API tests pass.

- [ ] **Step 11: Commit**

```bash
git add client/src/api/solvernets-catalog-build.ts \
  client/src/api/solvernets-endpoint.ts \
  client/src/api/server.ts \
  client/src/main.ts \
  client/test/api/solvernets-catalog-build.test.ts \
  client/test/api/solvernets-endpoint.test.ts
git commit -m "feat(api): add /v1/solvernets catalog endpoint"
```

---

### Task 2: Extend `POST /v1/setup/solvernets/:name` — accept role, harness, model, plugins; drop solverType from spec body

**Files:**
- Modify: `client/src/api/setup-endpoints.ts:275-347` (the `app.post('/v1/setup/solvernets/:name', ...)` handler)
- Modify: `client/test/api/setup-endpoints.test.ts` (extend the existing `describe('POST /v1/setup/solvernets/:name', ...)` block)

- [ ] **Step 1: Write failing tests for the new fields**

In `client/test/api/setup-endpoints.test.ts`, append these tests to the existing `describe('POST /v1/setup/solvernets/:name', ...)`:

```ts
  it('accepts role and persists it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    require('node:fs').writeFileSync(
      configPath,
      JSON.stringify({
        solverNets: {
          prediction: { enabled: true, solverType: 'prediction.v1', harness: 'claude-code-learner', plugins: [] },
        },
      }, null, 2) + '\n',
    );

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'evaluating' }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.solverNets.prediction.role).toBe('evaluating');
  });

  it('accepts harness, model, and plugins together', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    require('node:fs').writeFileSync(
      configPath,
      JSON.stringify({
        solverNets: {
          prediction: { enabled: true, solverType: 'prediction.v1', harness: 'claude-code-learner', plugins: [] },
        },
      }, null, 2) + '\n',
    );

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        harness: 'claude-code-learner',
        model: 'claude-haiku-4-5-20251001',
        plugins: ['jinn-prediction-plugin'],
      }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.solverNets.prediction.harness).toBe('claude-code-learner');
    expect(persisted.solverNets.prediction.model).toBe('claude-haiku-4-5-20251001');
    expect(persisted.solverNets.prediction.plugins).toEqual(['jinn-prediction-plugin']);
  });

  it('rejects an unknown role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    require('node:fs').writeFileSync(
      configPath,
      JSON.stringify({ solverNets: { prediction: { enabled: true } } }, null, 2) + '\n',
    );

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'creator' }),
    });

    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run test/api/setup-endpoints.test.ts`
Expected: 3 new failures (`role`, `harness/model/plugins`, role validation).

- [ ] **Step 3: Extend the handler in `setup-endpoints.ts`**

Locate the existing handler around line 275:
```ts
app.post('/v1/setup/solvernets/:name', async (c) => {
  // ...
  const enabled = body.enabled;
  const solverType = body.solverType;
```

Replace its body validation block with:

```ts
app.post('/v1/setup/solvernets/:name', async (c) => {
  const name = c.req.param('name');
  if (!name) return c.json({ error: 'invalid_invocation', detail: 'missing solvernet name' }, 400);

  let body: {
    enabled?: unknown;
    solverType?: unknown; // deprecated; accepted for one release cycle
    role?: unknown;
    harness?: unknown;
    model?: unknown;
    plugins?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body', detail: 'expected JSON body' }, 400);
  }

  const fields: Array<keyof typeof body> = ['enabled', 'solverType', 'role', 'harness', 'model', 'plugins'];
  if (!fields.some((f) => body[f] !== undefined)) {
    return c.json({ error: 'invalid_body', detail: 'must include at least one editable field' }, 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return c.json({ error: 'invalid_body', detail: '`enabled` must be a boolean' }, 400);
  }
  const KNOWN_SOLVER_TYPES = ['prediction.v0', 'prediction.v1'];
  if (body.solverType !== undefined && (typeof body.solverType !== 'string' || !KNOWN_SOLVER_TYPES.includes(body.solverType))) {
    return c.json({
      error: 'invalid_body',
      detail: `\`solverType\` must be one of ${KNOWN_SOLVER_TYPES.join(', ')}`,
    }, 400);
  }
  const KNOWN_ROLES = ['solving', 'evaluating'];
  if (body.role !== undefined && (typeof body.role !== 'string' || !KNOWN_ROLES.includes(body.role))) {
    return c.json({ error: 'invalid_body', detail: '`role` must be `solving` or `evaluating`' }, 400);
  }
  if (body.harness !== undefined && typeof body.harness !== 'string') {
    return c.json({ error: 'invalid_body', detail: '`harness` must be a string' }, 400);
  }
  if (body.model !== undefined && typeof body.model !== 'string') {
    return c.json({ error: 'invalid_body', detail: '`model` must be a string' }, 400);
  }
  if (body.plugins !== undefined) {
    if (!Array.isArray(body.plugins) || !body.plugins.every((p): p is string => typeof p === 'string')) {
      return c.json({ error: 'invalid_body', detail: '`plugins` must be an array of plugin names' }, 400);
    }
  }
```

Then in the existing mutation block, replace:
```ts
if (enabled !== undefined) existing.enabled = enabled;
if (solverType !== undefined) existing.solverType = solverType;
```

With:
```ts
if (body.enabled !== undefined) existing.enabled = body.enabled;
if (body.solverType !== undefined) existing.solverType = body.solverType;
if (body.role !== undefined) existing.role = body.role;
if (body.harness !== undefined) existing.harness = body.harness;
if (body.model !== undefined) existing.model = body.model;
if (body.plugins !== undefined) existing.plugins = body.plugins;
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/api/setup-endpoints.test.ts`
Expected: all PASS (existing 4 + new 3 = 7 SolverNet config tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/api/setup-endpoints.ts client/test/api/setup-endpoints.test.ts
git commit -m "feat(api): accept role, harness, model, plugins on solvernets edit"
```

---

### Task 3: `POST /v1/setup/network` — RPC URL editor

**Files:**
- Modify: `client/src/api/setup-endpoints.ts` (append new route after `solvernets/:name`)
- Modify: `client/src/api/setup-endpoints.ts` (extend `SetupRoutesConfig` interface with chain-default lookup)
- Test: `client/test/api/setup-endpoints.test.ts` (append `describe('POST /v1/setup/network', ...)`)

- [ ] **Step 1: Write the failing tests**

```ts
// Append to client/test/api/setup-endpoints.test.ts

describe('POST /v1/setup/network', () => {
  it('persists a custom RPC URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-cfg-'));
    const configPath = join(dir, 'config.json');
    require('node:fs').writeFileSync(
      configPath,
      JSON.stringify({ network: 'testnet', rpcUrl: 'https://default.example' }, null, 2) + '\n',
    );

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: 'https://my-tenderly.example.com/abc' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; restartRequired: boolean; rpcUrl: string };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.rpcUrl).toBe('https://my-tenderly.example.com/abc');

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toBe('https://my-tenderly.example.com/abc');
    expect(persisted.network).toBe('testnet'); // unchanged
  });

  it('reverts to default when rpcUrl is null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-cfg-'));
    const configPath = join(dir, 'config.json');
    require('node:fs').writeFileSync(
      configPath,
      JSON.stringify({ network: 'testnet', rpcUrl: 'https://custom.example' }, null, 2) + '\n',
    );

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      defaultRpcUrlForChain: () => 'https://sepolia.base.org',
    });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: null }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toBe('https://sepolia.base.org');
  });

  it('rejects a non-URL string', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-cfg-'));
    const configPath = join(dir, 'config.json');
    require('node:fs').writeFileSync(
      configPath,
      JSON.stringify({ network: 'testnet', rpcUrl: 'https://default.example' }, null, 2) + '\n',
    );

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: 'not a url' }),
    });

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

Run: `npx vitest run test/api/setup-endpoints.test.ts`
Expected: 3 new failures.

- [ ] **Step 3: Extend the config interface**

In `client/src/api/setup-endpoints.ts`, add to `SetupRoutesConfig`:

```ts
export interface SetupRoutesConfig {
  // ... existing fields
  defaultRpcUrlForChain?: () => string;
}
```

- [ ] **Step 4: Add the new route handler**

After the `solvernets/:name` handler in `setup-endpoints.ts`, add:

```ts
app.post('/v1/setup/network', async (c) => {
  let body: { rpcUrl?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body', detail: 'expected JSON body' }, 400);
  }

  const cfgPath = config.configPath ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(cfgPath)) {
    return c.json({ error: 'config_not_found', path: cfgPath }, 404);
  }

  let nextRpcUrl: string;
  if (body.rpcUrl === null || body.rpcUrl === '') {
    nextRpcUrl = config.defaultRpcUrlForChain?.() ?? 'https://sepolia.base.org';
  } else if (typeof body.rpcUrl === 'string') {
    try {
      const parsed = new URL(body.rpcUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return c.json({ error: 'invalid_body', detail: '`rpcUrl` must use http or https' }, 400);
      }
      nextRpcUrl = body.rpcUrl;
    } catch {
      return c.json({ error: 'invalid_body', detail: '`rpcUrl` is not a valid URL' }, 400);
    }
  } else {
    return c.json({ error: 'invalid_body', detail: '`rpcUrl` must be a string or null' }, 400);
  }

  try {
    persistConfigValue('rpcUrl', nextRpcUrl, cfgPath);
  } catch (err) {
    return c.json({
      error: 'config_write_failed',
      detail: err instanceof Error ? err.message : String(err),
    }, 500);
  }

  return c.json({
    ok: true,
    restartRequired: true,
    rpcUrl: nextRpcUrl,
  });
});
```

- [ ] **Step 5: Wire `defaultRpcUrlForChain` from `main.ts`**

In `client/src/main.ts`, find the `setup: { ... }` config block on the `startApiServer` call and add:

```ts
defaultRpcUrlForChain: () => CHAIN_CONFIG.rpcUrl,
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/api/setup-endpoints.test.ts`
Expected: all PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add client/src/api/setup-endpoints.ts client/src/main.ts client/test/api/setup-endpoints.test.ts
git commit -m "feat(api): add /v1/setup/network for editable RPC URL"
```

---

### Task 3a: `POST /v1/setup/agent-binding/retry` — re-run `stepBindAgent` without restart

This unblocks the in-app "Binding pending — retry" affordance on the IdentityCard (Task 23 below). The contracts-side investigation of *why* `setAgentWallet` reverts is filed separately; this endpoint exists for when the contracts fix lands and operators want a one-click retry without a daemon restart.

**Files:**
- Create: `client/src/api/agent-binding-endpoint.ts`
- Modify: `client/src/api/server.ts` (register the route)
- Modify: `client/src/main.ts` (wire the endpoint config — needs access to `bootstrapper` + earningDir + password)
- Test: `client/test/api/agent-binding-endpoint.test.ts`

- [ ] **Step 1: Write the failing endpoint test**

```ts
// client/test/api/agent-binding-endpoint.test.ts
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { addAgentBindingRoutes } from '../../src/api/agent-binding-endpoint.js';

describe('POST /v1/setup/agent-binding/retry', () => {
  it('runs the bind step for each unbound service and reports per-service status', async () => {
    const retryBind = vi.fn(async (serviceIndex: number) => ({
      serviceIndex,
      status: 'success' as const,
      txHash: `0x${'aa'.repeat(32)}`,
    }));
    const listUnbound = vi.fn(async () => [{ serviceIndex: 1 }, { serviceIndex: 2 }]);

    const app = new Hono();
    addAgentBindingRoutes(app, { retryBind, listUnbound });

    const res = await app.request('/v1/setup/agent-binding/retry', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; attempts: Array<{ serviceIndex: number; status: string }> };
    expect(body.ok).toBe(true);
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0].status).toBe('success');
  });

  it('returns 200 with an empty attempts array when nothing is unbound', async () => {
    const retryBind = vi.fn();
    const listUnbound = vi.fn(async () => []);
    const app = new Hono();
    addAgentBindingRoutes(app, { retryBind, listUnbound });
    const res = await app.request('/v1/setup/agent-binding/retry', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { attempts: unknown[] };
    expect(body.attempts).toEqual([]);
    expect(retryBind).not.toHaveBeenCalled();
  });

  it('targets only the requested serviceIndex when supplied', async () => {
    const retryBind = vi.fn(async (serviceIndex: number) => ({
      serviceIndex,
      status: 'reverted' as const,
      detail: 'execution reverted',
    }));
    const listUnbound = vi.fn();

    const app = new Hono();
    addAgentBindingRoutes(app, { retryBind, listUnbound });

    const res = await app.request('/v1/setup/agent-binding/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceIndex: 3 }),
    });
    expect(res.status).toBe(200);
    expect(retryBind).toHaveBeenCalledWith(3);
    expect(listUnbound).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/api/agent-binding-endpoint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the endpoint**

```ts
// client/src/api/agent-binding-endpoint.ts
import type { Hono } from 'hono';

export interface BindAttemptResult {
  serviceIndex: number;
  status: 'success' | 'reverted' | 'queued';
  txHash?: string;
  detail?: string;
}

export interface AgentBindingRoutesConfig {
  retryBind(serviceIndex: number): Promise<BindAttemptResult>;
  listUnbound(): Promise<Array<{ serviceIndex: number }>>;
}

export function addAgentBindingRoutes(app: Hono, config: AgentBindingRoutesConfig): void {
  app.post('/v1/setup/agent-binding/retry', async (c) => {
    let body: { serviceIndex?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is allowed — defaults to all unbound services
    }

    let targets: Array<{ serviceIndex: number }>;
    if (typeof body.serviceIndex === 'number' && Number.isInteger(body.serviceIndex)) {
      targets = [{ serviceIndex: body.serviceIndex }];
    } else if (body.serviceIndex !== undefined) {
      return c.json({ error: 'invalid_body', detail: '`serviceIndex` must be an integer' }, 400);
    } else {
      targets = await config.listUnbound();
    }

    const attempts: BindAttemptResult[] = [];
    for (const target of targets) {
      const result = await config.retryBind(target.serviceIndex);
      attempts.push(result);
    }
    return c.json({ ok: true, attempts });
  });
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run test/api/agent-binding-endpoint.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire into `server.ts` and `main.ts`**

In `server.ts`, near the other route registrations:

```ts
import { addAgentBindingRoutes, type AgentBindingRoutesConfig } from './agent-binding-endpoint.js';

// Add to ApiServerConfig:
agentBinding?: AgentBindingRoutesConfig;

// In startApiServer, near other route wires:
if (config.agentBinding) {
  addAgentBindingRoutes(app, config.agentBinding);
}

// Gate behind ui token:
app.use('/v1/setup/agent-binding/*', requireUiToken(config.ui.token));
```

In `main.ts`, the `agentBinding` config wires to the existing bootstrapper:

```ts
agentBinding: {
  retryBind: async (serviceIndex) => {
    try {
      const newState = await bootstrapper.retryAgentBindingFor(serviceIndex, password);
      const svc = newState.services.find((s) => s.index === serviceIndex);
      return {
        serviceIndex,
        status: svc?.safe_bound_to_agent ? 'success' : 'reverted',
        txHash: svc?.agent_registered_tx ?? undefined,
      };
    } catch (err) {
      return {
        serviceIndex,
        status: 'reverted',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
  listUnbound: async () => {
    const state = await bootstrapper.loadState();
    return state.services
      .filter((s) => !s.safe_bound_to_agent && s.agent_id !== null)
      .map((s) => ({ serviceIndex: s.index }));
  },
},
```

This requires adding two helpers to `FleetBootstrapper`:

```ts
// In client/src/earning/bootstrap.ts
async retryAgentBindingFor(serviceIndex: number, password: string): Promise<FleetState> {
  // Re-runs stepBindAgent for the named service. Mnemonic decrypted internally.
  const state = await this.store.load(this.chain);
  const mnemonic = await this.loadExistingMnemonic(state, password);
  const updated = await (this as any).stepBindAgent(state, mnemonic, serviceIndex);
  return updated;
}

async loadState(): Promise<FleetState> {
  return this.store.load(this.chain);
}
```

- [ ] **Step 6: Add a bootstrap unit test for `retryAgentBindingFor`**

```ts
// Append to client/test/earning/bootstrap.test.ts
it('retryAgentBindingFor re-runs stepBindAgent for the named service', async () => {
  // Set up earningDir with a service in agent_id-set, safe_bound=false state.
  // Spy on stepBindAgent; assert it's called with the right serviceIndex.
  // Mock its resolved state to flip safe_bound_to_agent=true.
  // Call retryAgentBindingFor(1, 'test-password').
  // Assert returned state has the updated service.
});
```

(Concrete fixtures lifted from the existing `'agent_registered step runs setAgentWallet bind...'` test — copy that scaffolding into the new test.)

- [ ] **Step 7: Typecheck, run tests, commit**

```bash
npx tsc --noEmit
npx vitest run test/api/agent-binding-endpoint.test.ts test/earning/bootstrap.test.ts
git add client/src/api/agent-binding-endpoint.ts \
  client/src/api/server.ts \
  client/src/main.ts \
  client/src/earning/bootstrap.ts \
  client/test/api/agent-binding-endpoint.test.ts \
  client/test/earning/bootstrap.test.ts
git commit -m "feat(api): add /v1/setup/agent-binding/retry"
```

---

## Phase B: App shell + router

After Phase B, the SPA renders a new shell with empty Overview / Configuration page bodies; existing Operating dashboard continues to work behind a feature gate during the transition.

### Task 4: Add `wouter` dependency

**Files:**
- Modify: `client/src/dashboard/spa/package.json`

- [ ] **Step 1: Add the dependency**

In the operator-spa workspace:
```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/client/src/dashboard/spa
yarn add wouter@^3
```

Verify the new entry under `dependencies` in `package.json`:
```json
"wouter": "^3.x.x"
```

- [ ] **Step 2: Verify install**

Run: `yarn typecheck` (from `client/`)
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/dashboard/spa/package.json client/src/dashboard/spa/yarn.lock client/yarn.lock
git commit -m "chore(spa): add wouter dependency"
```

---

### Task 5: `AppShell` component (layout grid)

**Files:**
- Create: `client/src/dashboard/spa/src/shell/AppShell.tsx`
- Test: `client/src/dashboard/spa/src/shell/AppShell.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// client/src/dashboard/spa/src/shell/AppShell.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from './AppShell.js';

describe('AppShell', () => {
  it('renders header, tabs, main outlet, and rail slots', () => {
    render(
      <AppShell
        header={<div data-testid="header">H</div>}
        tabs={<div data-testid="tabs">T</div>}
        rail={<div data-testid="rail">R</div>}
      >
        <div data-testid="main">M</div>
      </AppShell>,
    );
    expect(screen.getByTestId('header')).toBeTruthy();
    expect(screen.getByTestId('tabs')).toBeTruthy();
    expect(screen.getByTestId('rail')).toBeTruthy();
    expect(screen.getByTestId('main')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/dashboard/spa/src/shell/AppShell.test.tsx` (from `client/`)
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the shell**

```tsx
// client/src/dashboard/spa/src/shell/AppShell.tsx
import type { ReactNode } from 'react';

export interface AppShellProps {
  header: ReactNode;
  tabs: ReactNode;
  rail: ReactNode;
  children: ReactNode;
}

export function AppShell({ header, tabs, rail, children }: AppShellProps): JSX.Element {
  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: 'var(--bg)',
        color: 'var(--fg)',
        display: 'grid',
        gridTemplateRows: 'auto auto 1fr',
        gridTemplateColumns: '1fr 320px',
      }}
    >
      <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid var(--border)' }}>
        {header}
      </div>
      <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid var(--border)' }}>
        {tabs}
      </div>
      <main style={{ overflowY: 'auto' }}>{children}</main>
      <aside
        style={{
          borderLeft: '1px solid var(--border)',
          position: 'sticky',
          top: 0,
          height: '100%',
          overflowY: 'auto',
        }}
      >
        {rail}
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run src/dashboard/spa/src/shell/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/shell/AppShell.tsx client/src/dashboard/spa/src/shell/AppShell.test.tsx
git commit -m "feat(spa): add AppShell layout grid"
```

---

### Task 6: `Header` component

**Files:**
- Create: `client/src/dashboard/spa/src/shell/Header.tsx`
- Test: `client/src/dashboard/spa/src/shell/Header.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// client/src/dashboard/spa/src/shell/Header.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Header } from './Header.js';

describe('Header', () => {
  it('renders brand, network chip, RPC health, and master address', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <Header
          network="testnet"
          rpcHealthy={true}
          masterAddress="0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF"
        />
      </Router>,
    );
    expect(screen.getByText(/jinn operator/i)).toBeTruthy();
    expect(screen.getByText(/testnet/i)).toBeTruthy();
    expect(screen.getByText(/rpc healthy/i)).toBeTruthy();
    expect(screen.getByText(/0xE64b…B5CF/)).toBeTruthy();
  });

  it('shows rpc unreachable when not healthy', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <Header
          network="testnet"
          rpcHealthy={false}
          masterAddress="0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF"
        />
      </Router>,
    );
    expect(screen.getByText(/rpc unreachable/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/dashboard/spa/src/shell/Header.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement Header**

```tsx
// client/src/dashboard/spa/src/shell/Header.tsx
import { Link } from 'wouter';

export interface HeaderProps {
  network: 'testnet' | 'mainnet';
  rpcHealthy: boolean;
  masterAddress?: string;
}

function trunc(addr?: string): string {
  if (!addr || addr.length < 10) return addr ?? '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function Header({ network, rpcHealthy, masterAddress }: HeaderProps): JSX.Element {
  return (
    <header
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 24px',
      }}
    >
      <Link href="/overview" style={{ textDecoration: 'none', color: 'var(--fg)' }}>
        <span
          style={{
            fontFamily: "'Instrument Serif', 'Times New Roman', serif",
            fontSize: '26px',
            color: 'var(--fg)',
          }}
        >
          jinn operator
        </span>
      </Link>
      <div
        style={{
          display: 'flex',
          gap: '16px',
          alignItems: 'center',
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        <span
          style={{
            border: '1px solid var(--border)',
            borderRadius: '4px',
            padding: '2px 8px',
          }}
        >
          {network}
        </span>
        <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: rpcHealthy ? 'var(--vow-green)' : 'var(--break-red)',
            }}
          />
          {rpcHealthy ? 'rpc healthy' : 'rpc unreachable'}
        </span>
        <span style={{ color: 'var(--fg-dim)' }}>master {trunc(masterAddress)}</span>
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/dashboard/spa/src/shell/Header.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/shell/Header.tsx client/src/dashboard/spa/src/shell/Header.test.tsx
git commit -m "feat(spa): add Header with brand, network, rpc health, master"
```

---

### Task 7: `TopTabs` component

**Files:**
- Create: `client/src/dashboard/spa/src/shell/TopTabs.tsx`
- Test: `client/src/dashboard/spa/src/shell/TopTabs.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// client/src/dashboard/spa/src/shell/TopTabs.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { TopTabs } from './TopTabs.js';

describe('TopTabs', () => {
  it('marks Overview active when location is /overview', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    const overview = screen.getByText('Overview');
    const configuration = screen.getByText('Configuration');
    expect(overview.getAttribute('data-active')).toBe('true');
    expect(configuration.getAttribute('data-active')).toBe('false');
  });

  it('marks Configuration active when location is /configuration', () => {
    const { hook } = memoryLocation({ path: '/configuration' });
    render(
      <Router hook={hook}>
        <TopTabs />
      </Router>,
    );
    const configuration = screen.getByText('Configuration');
    expect(configuration.getAttribute('data-active')).toBe('true');
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/shell/TopTabs.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement TopTabs**

```tsx
// client/src/dashboard/spa/src/shell/TopTabs.tsx
import { Link, useLocation } from 'wouter';

const TABS = [
  { path: '/overview', label: 'Overview' },
  { path: '/configuration', label: 'Configuration' },
] as const;

export function TopTabs(): JSX.Element {
  const [location] = useLocation();
  return (
    <nav
      style={{
        display: 'flex',
        padding: '0 24px',
      }}
    >
      {TABS.map((tab) => {
        const active = location === tab.path || location.startsWith(`${tab.path}/`);
        return (
          <Link
            key={tab.path}
            href={tab.path}
            data-active={active ? 'true' : 'false'}
            style={{
              padding: '14px 18px',
              fontFamily: "'JetBrains Mono', ui-monospace, SF Mono, Menlo, monospace",
              fontSize: '11px',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              borderBottom: `1px solid ${active ? 'var(--accent-sky)' : 'transparent'}`,
              marginBottom: '-1px',
              textDecoration: 'none',
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run src/dashboard/spa/src/shell/TopTabs.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/shell/TopTabs.tsx client/src/dashboard/spa/src/shell/TopTabs.test.tsx
git commit -m "feat(spa): add TopTabs with Overview/Configuration links"
```

---

### Task 8: `AgentRail` extracted from `Operating.tsx`

**Files:**
- Create: `client/src/dashboard/spa/src/shell/AgentRail.tsx`
- Test: `client/src/dashboard/spa/src/shell/AgentRail.test.tsx`
- Reference: `client/src/dashboard/spa/src/regions/Operating.tsx` (find the existing `AgentRail` JSX inside Operating)

- [ ] **Step 1: Locate and read the existing Agent rail JSX**

Open `client/src/dashboard/spa/src/regions/Operating.tsx`. Find the `<aside>` block that wraps the `<Agent />` component (search for `<Agent` or "ASK CLAUDE"). Note any state, refs, and styling.

- [ ] **Step 2: Write failing test for the extracted component**

```tsx
// client/src/dashboard/spa/src/shell/AgentRail.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentRail } from './AgentRail.js';

describe('AgentRail', () => {
  it('renders the Claude eyebrow and agent placeholder', () => {
    render(<AgentRail agentGated={false} />);
    expect(screen.getByText(/claude/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run src/dashboard/spa/src/shell/AgentRail.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Extract the component**

```tsx
// client/src/dashboard/spa/src/shell/AgentRail.tsx
import { Agent } from '../regions/Agent.js';

export interface AgentRailProps {
  agentGated?: boolean;
}

export function AgentRail({ agentGated }: AgentRailProps): JSX.Element {
  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        Claude
      </span>
      <Agent agentGated={agentGated} />
    </div>
  );
}
```

- [ ] **Step 5: Run test**

Run: `npx vitest run src/dashboard/spa/src/shell/AgentRail.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/shell/AgentRail.tsx client/src/dashboard/spa/src/shell/AgentRail.test.tsx
git commit -m "feat(spa): extract AgentRail from Operating"
```

---

### Task 9: `RestartBanner` component

**Files:**
- Create: `client/src/dashboard/spa/src/shell/RestartBanner.tsx`
- Test: `client/src/dashboard/spa/src/shell/RestartBanner.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// client/src/dashboard/spa/src/shell/RestartBanner.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RestartBanner } from './RestartBanner.js';

describe('RestartBanner', () => {
  it('renders nothing when no restart is pending', () => {
    const { container } = render(<RestartBanner restartPending={false} onRestart={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('renders message and Restart button when pending', () => {
    const onRestart = vi.fn();
    render(<RestartBanner restartPending={true} onRestart={onRestart} />);
    expect(screen.getByText(/configuration saved/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /restart node/i }));
    expect(onRestart).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/shell/RestartBanner.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/shell/RestartBanner.tsx
export interface RestartBannerProps {
  restartPending: boolean;
  onRestart: () => void;
}

export function RestartBanner({ restartPending, onRestart }: RestartBannerProps): JSX.Element | null {
  if (!restartPending) return null;
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--border-accent)',
        padding: '10px 24px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '13px',
      }}
    >
      <span style={{ color: 'var(--fg)' }}>
        Configuration saved. Restart the node to apply.
      </span>
      <button
        onClick={onRestart}
        style={{
          background: 'var(--accent-sky)',
          border: '1px solid var(--accent-sky)',
          color: 'var(--bg-sunken)',
          padding: '6px 14px',
          borderRadius: '6px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          cursor: 'pointer',
        }}
      >
        Restart node
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run src/dashboard/spa/src/shell/RestartBanner.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/shell/RestartBanner.tsx client/src/dashboard/spa/src/shell/RestartBanner.test.tsx
git commit -m "feat(spa): add RestartBanner"
```

---

### Task 10: Wire router + shell in `App.tsx`

**Files:**
- Modify: `client/src/dashboard/spa/src/App.tsx`
- Create: `client/src/dashboard/spa/src/pages/Overview.tsx` (placeholder)
- Create: `client/src/dashboard/spa/src/pages/Configuration.tsx` (placeholder)

- [ ] **Step 1: Create page placeholders**

```tsx
// client/src/dashboard/spa/src/pages/Overview.tsx
export function OverviewPage(): JSX.Element {
  return (
    <div style={{ padding: '24px' }}>
      <p style={{ color: 'var(--fg-muted)' }}>Overview content lands in Phase E.</p>
    </div>
  );
}
```

```tsx
// client/src/dashboard/spa/src/pages/Configuration.tsx
export function ConfigurationPage(): JSX.Element {
  return (
    <div style={{ padding: '24px' }}>
      <p style={{ color: 'var(--fg-muted)' }}>Configuration content lands in Phase D.</p>
    </div>
  );
}
```

- [ ] **Step 2: Replace `App.tsx` with the router-shell composition**

```tsx
// client/src/dashboard/spa/src/App.tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Router, Route, Switch, Redirect } from 'wouter';
import { api } from './api/client.js';
import type { BootstrapState } from './api/types.js';
import { LoadingScreen } from './regions/LoadingScreen.js';
import { Onboarding } from './regions/Onboarding.js';
import { AppShell } from './shell/AppShell.js';
import { Header } from './shell/Header.js';
import { TopTabs } from './shell/TopTabs.js';
import { AgentRail } from './shell/AgentRail.js';
import { RestartBanner } from './shell/RestartBanner.js';
import { OverviewPage } from './pages/Overview.js';
import { ConfigurationPage } from './pages/Configuration.js';

export default function App(): JSX.Element {
  const { data, isLoading } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 1500,
  });
  const [restartPending, setRestartPending] = useState(false);

  if (isLoading || !data || data.mode === 'uninitialized') {
    const headline = !data
      ? 'Starting jinn'
      : data.mode === 'uninitialized'
        ? 'Setting up your wallet'
        : 'Loading';
    return <LoadingScreen headline={headline} />;
  }

  if (data.mode !== 'running') {
    return <Onboarding />;
  }

  const network = (data.chain === 'base' ? 'mainnet' : 'testnet') as 'testnet' | 'mainnet';
  const masterAddress = data.master_address ?? '';

  return (
    <Router>
      <RestartBanner
        restartPending={restartPending}
        onRestart={async () => {
          await api.restartDaemon();
          setRestartPending(false);
        }}
      />
      <AppShell
        header={<Header network={network} rpcHealthy={true} masterAddress={masterAddress} />}
        tabs={<TopTabs />}
        rail={<AgentRail />}
      >
        <Switch>
          <Route path="/overview" component={OverviewPage} />
          <Route path="/configuration" component={ConfigurationPage} />
          <Route><Redirect to="/overview" /></Route>
        </Switch>
      </AppShell>
    </Router>
  );
}
```

- [ ] **Step 3: Build and visually verify**

Run: `yarn build` (from `client/`)
Expected: SPA bundle builds.

Start the daemon (`node dist/bin/jinn.js run`) on a known-running fleet (the testnet master from this branch's shakedown) and visit the dashboard URL. Expected: Overview placeholder visible; clicking the Configuration tab shows the Configuration placeholder; agent rail still works.

- [ ] **Step 4: Add a routing test**

```tsx
// client/src/dashboard/spa/src/App.routing.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router, Route, Switch } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OverviewPage } from './pages/Overview.js';
import { ConfigurationPage } from './pages/Configuration.js';

describe('App routes', () => {
  it('renders OverviewPage on /overview', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <Switch>
          <Route path="/overview" component={OverviewPage} />
          <Route path="/configuration" component={ConfigurationPage} />
        </Switch>
      </Router>,
    );
    expect(screen.getByText(/overview content lands/i)).toBeTruthy();
  });

  it('renders ConfigurationPage on /configuration', () => {
    const { hook } = memoryLocation({ path: '/configuration' });
    render(
      <Router hook={hook}>
        <Switch>
          <Route path="/overview" component={OverviewPage} />
          <Route path="/configuration" component={ConfigurationPage} />
        </Switch>
      </Router>,
    );
    expect(screen.getByText(/configuration content lands/i)).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run all SPA tests**

Run: `npx vitest run src/dashboard/spa/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/App.tsx \
  client/src/dashboard/spa/src/App.routing.test.tsx \
  client/src/dashboard/spa/src/pages/Overview.tsx \
  client/src/dashboard/spa/src/pages/Configuration.tsx
git commit -m "feat(spa): wire wouter router + shell with placeholder pages"
```

---

## Phase C: Shared components

These are leaf components used by both pages. Built before page composition so the page tasks have stable dependencies.

### Task 11: `SectionCard` component

**Files:**
- Create: `client/src/dashboard/spa/src/components/SectionCard.tsx`
- Test: `client/src/dashboard/spa/src/components/SectionCard.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
// client/src/dashboard/spa/src/components/SectionCard.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectionCard } from './SectionCard.js';

describe('SectionCard', () => {
  it('renders the head and hides the body when collapsed', () => {
    render(
      <SectionCard
        title="SolverNets"
        summary="3 available · 1 enabled"
        defaultExpanded={false}
      >
        <div data-testid="body">body content</div>
      </SectionCard>,
    );
    expect(screen.getByText(/solvernets/i)).toBeTruthy();
    expect(screen.queryByTestId('body')).toBeNull();
  });

  it('expands when the head is clicked', () => {
    render(
      <SectionCard title="SolverNets" summary="" defaultExpanded={false}>
        <div data-testid="body">body content</div>
      </SectionCard>,
    );
    fireEvent.click(screen.getByText(/solvernets/i));
    expect(screen.getByTestId('body')).toBeTruthy();
  });

  it('renders the save footer when dirty', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      <SectionCard
        title="SolverNets"
        summary=""
        defaultExpanded={true}
        dirty={{ pendingSummary: '2 changes pending', onSave, onCancel }}
      >
        <div>body</div>
      </SectionCard>,
    );
    expect(screen.getByText('2 changes pending')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(onSave).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/components/SectionCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/components/SectionCard.tsx
import { useState, type ReactNode } from 'react';

export type SectionCardVariant = 'default' | 'danger';

export interface SectionCardProps {
  title: string;
  summary: string;
  metaChip?: { label: string; tone?: 'default' | 'live' | 'attention' | 'danger' };
  defaultExpanded?: boolean;
  variant?: SectionCardVariant;
  dirty?: {
    pendingSummary: string;
    saving?: boolean;
    error?: string;
    onSave: () => void;
    onCancel: () => void;
  };
  children?: ReactNode;
}

const TONE_COLORS: Record<NonNullable<NonNullable<SectionCardProps['metaChip']>['tone']>, { color: string; border: string }> = {
  default: { color: 'var(--fg-dim)', border: 'var(--border)' },
  live: { color: 'var(--vow-green)', border: 'var(--vow-green)' },
  attention: { color: 'var(--wane)', border: 'var(--wane)' },
  danger: { color: 'var(--break-red)', border: 'var(--break-red)' },
};

export function SectionCard({
  title,
  summary,
  metaChip,
  defaultExpanded = false,
  variant = 'default',
  dirty,
  children,
}: SectionCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const tone = TONE_COLORS[metaChip?.tone ?? 'default'];
  const borderColor = variant === 'danger' ? 'var(--break-red)' : 'var(--border)';
  return (
    <section
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${borderColor}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto auto',
          gap: '16px',
          alignItems: 'center',
          padding: '20px 24px',
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <span>
          <span
            style={{
              display: 'block',
              fontSize: '17px',
              fontWeight: 500,
              color: variant === 'danger' ? 'var(--break-red)' : 'var(--fg)',
              letterSpacing: '-0.01em',
              marginBottom: '4px',
            }}
          >
            {title}
          </span>
          <span style={{ fontSize: '13px', color: 'var(--fg-muted)' }}>{summary}</span>
        </span>
        {metaChip && (
          <span
            style={{
              fontSize: '11px',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: tone.color,
              border: `1px solid ${tone.border}`,
              borderRadius: '4px',
              padding: '2px 8px',
            }}
          >
            {metaChip.label}
          </span>
        )}
        <span style={{ color: expanded ? 'var(--fg)' : 'var(--fg-dim)', fontSize: '14px', width: '16px', textAlign: 'right' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {children}
          {dirty && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingTop: '14px',
                marginTop: '4px',
                borderTop: '1px solid var(--border)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              <span style={{ fontSize: '12px', color: dirty.error ? 'var(--break-red)' : 'var(--accent-sky)' }}>
                {dirty.error ?? (dirty.saving ? 'Saving…' : dirty.pendingSummary)}
              </span>
              <span style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={dirty.onCancel}
                  disabled={dirty.saving}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '10px 20px',
                    background: 'transparent',
                    color: 'var(--fg)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '14px',
                    cursor: dirty.saving ? 'wait' : 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={dirty.onSave}
                  disabled={dirty.saving}
                  style={{
                    border: '1px solid var(--accent-sky)',
                    background: 'var(--accent-sky)',
                    color: 'var(--bg-sunken)',
                    borderRadius: '6px',
                    padding: '10px 20px',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '14px',
                    cursor: dirty.saving ? 'wait' : 'pointer',
                  }}
                >
                  Save changes
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/dashboard/spa/src/components/SectionCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/components/SectionCard.tsx client/src/dashboard/spa/src/components/SectionCard.test.tsx
git commit -m "feat(spa): add SectionCard with collapse + per-section save lifecycle"
```

---

### Task 12: `RestartPill` component

**Files:**
- Create: `client/src/dashboard/spa/src/components/RestartPill.tsx`
- Test: `client/src/dashboard/spa/src/components/RestartPill.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// client/src/dashboard/spa/src/components/RestartPill.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RestartPill } from './RestartPill.js';

describe('RestartPill', () => {
  it('renders "restart"', () => {
    render(<RestartPill />);
    expect(screen.getByText(/restart/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Confirm fail**

Run: `npx vitest run src/dashboard/spa/src/components/RestartPill.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/components/RestartPill.tsx
export function RestartPill(): JSX.Element {
  return (
    <span
      style={{
        color: 'var(--wane)',
        fontSize: '9px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontFamily: "'JetBrains Mono', monospace",
        border: '1px solid var(--wane)',
        borderRadius: '999px',
        padding: '1px 6px',
      }}
    >
      restart
    </span>
  );
}
```

- [ ] **Step 4: Pass + commit**

```bash
npx vitest run src/dashboard/spa/src/components/RestartPill.test.tsx
git add client/src/dashboard/spa/src/components/RestartPill.tsx client/src/dashboard/spa/src/components/RestartPill.test.tsx
git commit -m "feat(spa): add RestartPill"
```

---

### Task 13: `ConfigField` component

**Files:**
- Create: `client/src/dashboard/spa/src/components/ConfigField.tsx`
- Test: `client/src/dashboard/spa/src/components/ConfigField.test.tsx`

- [ ] **Step 1: Failing tests**

```tsx
// client/src/dashboard/spa/src/components/ConfigField.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigField } from './ConfigField.js';

describe('ConfigField', () => {
  it('renders label, value, and restart pill when restartRequired', () => {
    render(
      <ConfigField label="Harness" restartRequired>
        <span>claude-code-learner</span>
      </ConfigField>,
    );
    expect(screen.getByText('Harness')).toBeTruthy();
    expect(screen.getByText(/restart/i)).toBeTruthy();
  });

  it('does not render the restart pill when not restartRequired', () => {
    render(
      <ConfigField label="Harness">
        <span>claude-code-learner</span>
      </ConfigField>,
    );
    expect(screen.queryByText(/restart/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/components/ConfigField.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/components/ConfigField.tsx
import type { ReactNode } from 'react';
import { RestartPill } from './RestartPill.js';

export interface ConfigFieldProps {
  label: string;
  restartRequired?: boolean;
  helperText?: string;
  children: ReactNode;
}

export function ConfigField({ label, restartRequired, helperText, children }: ConfigFieldProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
        }}
      >
        {label}
        {restartRequired && <RestartPill />}
      </span>
      {children}
      {helperText && (
        <span style={{ fontSize: '11px', color: 'var(--fg-dim)', fontFamily: "'JetBrains Mono', monospace" }}>
          {helperText}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Pass + commit**

```bash
npx vitest run src/dashboard/spa/src/components/ConfigField.test.tsx
git add client/src/dashboard/spa/src/components/ConfigField.tsx client/src/dashboard/spa/src/components/ConfigField.test.tsx
git commit -m "feat(spa): add ConfigField with optional restart pill"
```

---

## Phase D: Configuration page

### Task 14: API client extensions

**Files:**
- Modify: `client/src/dashboard/spa/src/api/client.ts`
- Modify: `client/src/dashboard/spa/src/api/types.ts`

- [ ] **Step 1: Add catalog types**

Append to `client/src/dashboard/spa/src/api/types.ts`:

```ts
export interface SolverNetCatalogEntry {
  name: string;
  description: string;
  state: 'live' | 'available' | 'coming_soon';
  intrinsicSolverType: string;
  supportedRoles: ('solving' | 'evaluating')[];
  compatibleHarnesses: Array<{
    name: string;
    version: string;
    supportsRoles: ('solving' | 'evaluating')[];
  }>;
  compatiblePlugins: Array<{ name: string; version: string; source: string }>;
}

export interface SolverNetsCatalogResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: SolverNetCatalogEntry[];
}
```

- [ ] **Step 2: Extend the client**

In `client/src/dashboard/spa/src/api/client.ts`, replace the existing `updateSolverNet` and add the new endpoints:

```ts
import type { SolverNetsCatalogResponse } from './types.js';

// ... inside the api object:
  getSolverNets: () => jfetch<SolverNetsCatalogResponse>('/v1/solvernets'),
  updateSolverNet: (
    name: string,
    patch: {
      enabled?: boolean;
      role?: 'solving' | 'evaluating';
      harness?: string;
      model?: string;
      plugins?: string[];
      solverType?: string; // deprecated; remove next release
    },
  ) =>
    jfetch<{
      ok: boolean;
      restartRequired: boolean;
      name: string;
      config: {
        enabled?: boolean;
        role?: 'solving' | 'evaluating';
        harness?: string;
        model?: string;
        plugins?: string[];
      };
    }>(`/v1/setup/solvernets/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  updateNetwork: (patch: { rpcUrl: string | null }) =>
    jfetch<{ ok: boolean; restartRequired: boolean; rpcUrl: string }>(
      '/v1/setup/network',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ),
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/api/client.ts client/src/dashboard/spa/src/api/types.ts
git commit -m "feat(spa): extend api client with solvernets catalog + network edit"
```

---

### Task 15: `SecuritySection`

**Files:**
- Create: `client/src/dashboard/spa/src/pages/configuration/SecuritySection.tsx`
- Reference: `client/src/dashboard/spa/src/regions/SettingsCard.tsx` (existing password rotate UI)
- Test: `client/src/dashboard/spa/src/pages/configuration/SecuritySection.test.tsx`

- [ ] **Step 1: Find the existing rotate-password UI in `SettingsCard.tsx`**

Open `client/src/dashboard/spa/src/regions/SettingsCard.tsx` and locate the password rotation block (search for `changeKeystorePassword`). Note the form fields and submit handler.

- [ ] **Step 2: Failing test**

```tsx
// client/src/dashboard/spa/src/pages/configuration/SecuritySection.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecuritySection } from './SecuritySection.js';

describe('SecuritySection', () => {
  it('renders the section card with danger framing', () => {
    render(<SecuritySection />);
    expect(screen.getByText(/security/i)).toBeTruthy();
    expect(screen.getByText(/danger zone/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/pages/configuration/SecuritySection.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement using SectionCard + the existing password-rotate UI**

```tsx
// client/src/dashboard/spa/src/pages/configuration/SecuritySection.tsx
import { useState } from 'react';
import { SectionCard } from '../../components/SectionCard.js';
import { api } from '../../api/client.js';

export function SecuritySection(): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [status, setStatus] = useState<'idle' | 'rotating' | 'rotated' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setStatus('rotating');
    setError(null);
    try {
      await api.changeKeystorePassword(current, next);
      setStatus('rotated');
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('failed');
    }
  };

  return (
    <SectionCard
      title="Security"
      summary="Rotate keystore password · last rotated never"
      metaChip={{ label: 'Danger zone', tone: 'danger' }}
      variant="danger"
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
            Current password
          </span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '10px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '14px',
              color: 'var(--fg)',
            }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
            New password
          </span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '10px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '14px',
              color: 'var(--fg)',
            }}
          />
        </label>
      </div>
      <button
        onClick={() => { void submit(); }}
        disabled={status === 'rotating' || current.length === 0 || next.length < 8}
        style={{
          alignSelf: 'flex-start',
          background: 'var(--break-red)',
          border: '1px solid var(--break-red)',
          color: 'var(--fg)',
          borderRadius: '6px',
          padding: '10px 20px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '14px',
          cursor: status === 'rotating' ? 'wait' : 'pointer',
        }}
      >
        {status === 'rotating' ? 'Rotating…' : 'Rotate password'}
      </button>
      {status === 'rotated' && (
        <span style={{ color: 'var(--vow-green)', fontSize: '12px' }}>Password rotated. Re-run jinn run with the new password.</span>
      )}
      {status === 'failed' && (
        <span style={{ color: 'var(--break-red)', fontSize: '12px' }}>Rotation failed: {error}</span>
      )}
    </SectionCard>
  );
}
```

- [ ] **Step 5: Run test**

Run: `npx vitest run src/dashboard/spa/src/pages/configuration/SecuritySection.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/pages/configuration/SecuritySection.tsx client/src/dashboard/spa/src/pages/configuration/SecuritySection.test.tsx
git commit -m "feat(spa): add Configuration SecuritySection"
```

---

### Task 16: `NetworkSection`

**Files:**
- Create: `client/src/dashboard/spa/src/pages/configuration/NetworkSection.tsx`
- Test: `client/src/dashboard/spa/src/pages/configuration/NetworkSection.test.tsx`

- [ ] **Step 1: Failing tests**

```tsx
// client/src/dashboard/spa/src/pages/configuration/NetworkSection.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NetworkSection } from './NetworkSection.js';

describe('NetworkSection', () => {
  it('shows current chain (locked) and rpc URL (editable)', () => {
    render(
      <NetworkSection
        chain="base-sepolia"
        rpcUrl="https://my-tenderly.example/abc"
        defaultRpcUrl="https://sepolia.base.org"
        rpcHealthy={true}
        onRestartPending={() => undefined}
      />,
    );
    expect(screen.getByText(/network/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/network/i));
    expect(screen.getByDisplayValue('https://my-tenderly.example/abc')).toBeTruthy();
    expect(screen.getByText(/locked/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/pages/configuration/NetworkSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/pages/configuration/NetworkSection.tsx
import { useState } from 'react';
import { SectionCard } from '../../components/SectionCard.js';
import { ConfigField } from '../../components/ConfigField.js';
import { api } from '../../api/client.js';

export interface NetworkSectionProps {
  chain: 'base' | 'base-sepolia';
  rpcUrl: string;
  defaultRpcUrl: string;
  rpcHealthy: boolean;
  onRestartPending: () => void;
}

export function NetworkSection({ chain, rpcUrl, defaultRpcUrl, rpcHealthy, onRestartPending }: NetworkSectionProps): JSX.Element {
  const [draft, setDraft] = useState(rpcUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = draft !== rpcUrl;
  const chainLabel = chain === 'base' ? 'Base mainnet (chain id 8453)' : 'Base Sepolia (chain id 84532)';

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const next = draft.length === 0 ? null : draft;
      const res = await api.updateNetwork({ rpcUrl: next });
      if (res.restartRequired) onRestartPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Network"
      summary={`${chainLabel.split(' (')[0]} · ${rpcUrl}`}
      metaChip={{
        label: rpcHealthy ? 'Healthy' : 'Unreachable',
        tone: rpcHealthy ? 'live' : 'danger',
      }}
      dirty={
        dirty
          ? {
              pendingSummary: 'RPC URL changed · save to apply',
              saving,
              error: error ?? undefined,
              onSave: () => { void save(); },
              onCancel: () => { setDraft(rpcUrl); setError(null); },
            }
          : undefined
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <ConfigField
          label="Chain"
          helperText="Switching chains resets fleet state — that's a separate flow."
        >
          <div
            style={{
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '10px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              color: 'var(--fg-muted)',
            }}
          >
            {chainLabel}
          </div>
          <span
            style={{
              alignSelf: 'flex-start',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '9px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
              border: '1px solid var(--border)',
              borderRadius: '999px',
              padding: '1px 6px',
              marginTop: '6px',
            }}
          >
            locked
          </span>
        </ConfigField>
        <ConfigField
          label="RPC URL"
          restartRequired
          helperText={`Default: ${defaultRpcUrl}`}
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={defaultRpcUrl}
            style={{
              background: 'var(--bg)',
              border: `1px solid ${dirty ? 'var(--accent-sky)' : 'var(--border)'}`,
              borderRadius: '6px',
              padding: '10px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              color: 'var(--fg)',
            }}
          />
          <button
            type="button"
            onClick={() => setDraft('')}
            style={{
              alignSelf: 'flex-start',
              background: 'transparent',
              border: 'none',
              color: 'var(--accent-sky)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              cursor: 'pointer',
              marginTop: '4px',
              padding: 0,
            }}
          >
            Use default
          </button>
        </ConfigField>
      </div>
    </SectionCard>
  );
}
```

- [ ] **Step 4: Run test + commit**

```bash
npx vitest run src/dashboard/spa/src/pages/configuration/NetworkSection.test.tsx
git add client/src/dashboard/spa/src/pages/configuration/NetworkSection.tsx client/src/dashboard/spa/src/pages/configuration/NetworkSection.test.tsx
git commit -m "feat(spa): add Configuration NetworkSection (editable RPC, locked chain)"
```

---

### Task 17: `NetCard` component

**Files:**
- Create: `client/src/dashboard/spa/src/pages/configuration/NetCard.tsx`
- Test: `client/src/dashboard/spa/src/pages/configuration/NetCard.test.tsx`

- [ ] **Step 1: Failing tests**

```tsx
// client/src/dashboard/spa/src/pages/configuration/NetCard.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NetCard } from './NetCard.js';

const baseCatalog = {
  name: 'prediction',
  description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
  intrinsicSolverType: 'prediction.v1',
  state: 'live' as const,
  supportedRoles: ['solving' as const, 'evaluating' as const],
  compatibleHarnesses: [{ name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving' as const] }],
  compatiblePlugins: [{ name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' }],
};

describe('NetCard', () => {
  it('renders name, description, and Available state when disabled', () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{ enabled: false, role: 'solving', harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    expect(screen.getByText('prediction')).toBeTruthy();
    expect(screen.getByText(/forecast resolved outcomes/i)).toBeTruthy();
    expect(screen.getByText(/available/i)).toBeTruthy();
  });

  it('expands the body when enabled and shows Solving role active', () => {
    render(
      <NetCard
        catalog={baseCatalog}
        config={{ enabled: true, role: 'solving', harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: ['jinn-prediction-plugin'] }}
        onSaved={vi.fn()}
        onRestartPending={vi.fn()}
      />,
    );
    expect(screen.getByText(/live/i)).toBeTruthy();
    expect(screen.getByText('Solving').closest('[data-role-active="true"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/pages/configuration/NetCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/pages/configuration/NetCard.tsx
import { useState } from 'react';
import type { SolverNetCatalogEntry } from '../../api/types.js';
import { ConfigField } from '../../components/ConfigField.js';
import { api } from '../../api/client.js';

export interface NetCardConfig {
  enabled: boolean;
  role: 'solving' | 'evaluating';
  harness: string;
  model: string;
  plugins: string[];
}

export interface NetCardProps {
  catalog: SolverNetCatalogEntry;
  config: NetCardConfig;
  onSaved: () => void;
  onRestartPending: () => void;
}

export function NetCard({ catalog, config, onSaved, onRestartPending }: NetCardProps): JSX.Element {
  const [draft, setDraft] = useState<NetCardConfig>(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const dirty =
    draft.enabled !== config.enabled ||
    draft.role !== config.role ||
    draft.harness !== config.harness ||
    draft.model !== config.model ||
    draft.plugins.join(',') !== config.plugins.join(',');

  const stateLabel: { label: string; tone: string; color: string } = (() => {
    if (catalog.state === 'coming_soon') return { label: 'Coming soon', tone: 'default', color: 'var(--fg-dim)' };
    if (config.enabled) return { label: 'Live', tone: 'live', color: 'var(--vow-green)' };
    return { label: 'Available', tone: 'default', color: 'var(--fg-muted)' };
  })();

  const toggle = (): void => {
    if (catalog.state === 'coming_soon') return;
    if (!draft.enabled) {
      setDraft({ ...draft, enabled: true });
      return;
    }
    if (dirty) {
      setConfirmDisable(true);
      return;
    }
    setDraft({ ...draft, enabled: false });
  };

  const cancel = (): void => {
    setDraft(config);
    setError(null);
    setConfirmDisable(false);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateSolverNet(catalog.name, {
        enabled: draft.enabled,
        role: draft.role,
        harness: draft.harness,
        model: draft.model,
        plugins: draft.plugins,
      });
      if (res.restartRequired) onRestartPending();
      onSaved();
      setConfirmDisable(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto auto',
          gap: '16px',
          alignItems: 'center',
          padding: '14px 18px',
        }}
      >
        <span style={{ width: '26px', height: '26px', border: '1px solid var(--border)', borderRadius: '6px' }} />
        <span>
          <span style={{ fontSize: '15px', fontWeight: 500, color: 'var(--fg)' }}>{catalog.name}</span>
          <span style={{ display: 'block', fontSize: '12px', color: 'var(--fg-muted)', marginTop: '2px' }}>
            {catalog.description}
          </span>
        </span>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: stateLabel.color,
            border: `1px solid ${stateLabel.color}`,
            borderRadius: '999px',
            padding: '2px 10px',
          }}
        >
          {stateLabel.label}
        </span>
        <button
          type="button"
          onClick={toggle}
          disabled={catalog.state === 'coming_soon'}
          aria-label={draft.enabled ? `Disable ${catalog.name}` : `Enable ${catalog.name}`}
          style={{
            background: 'var(--bg-elevated)',
            border: `1px solid ${draft.enabled ? 'var(--accent-sky)' : 'var(--border)'}`,
            borderRadius: '999px',
            width: '36px',
            height: '18px',
            position: 'relative',
            cursor: catalog.state === 'coming_soon' ? 'not-allowed' : 'pointer',
            opacity: catalog.state === 'coming_soon' ? 0.5 : 1,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: '2px',
              left: draft.enabled ? 'auto' : '3px',
              right: draft.enabled ? '3px' : 'auto',
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              background: draft.enabled ? 'var(--accent-sky)' : 'var(--fg-muted)',
            }}
          />
        </button>
      </div>

      {draft.enabled && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '18px 20px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px',
            background: 'var(--bg-sunken)',
          }}
        >
          <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
              }}
            >
              Role
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
              {catalog.supportedRoles.map((role, idx) => {
                const active = draft.role === role;
                return (
                  <button
                    key={role}
                    type="button"
                    data-role-active={active ? 'true' : 'false'}
                    onClick={() => setDraft({ ...draft, role })}
                    style={{
                      padding: '10px 14px',
                      textAlign: 'center',
                      color: active ? 'var(--fg)' : 'var(--fg-muted)',
                      background: active ? 'var(--bg)' : 'transparent',
                      borderRight: idx < catalog.supportedRoles.length - 1 ? '1px solid var(--border)' : 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    <span style={{ display: 'block', fontSize: '14px', fontWeight: 500 }}>
                      {role.charAt(0).toUpperCase() + role.slice(1)}
                    </span>
                    <span style={{ display: 'block', fontSize: '11px', color: active ? 'var(--fg-muted)' : 'var(--fg-dim)' }}>
                      {role === 'solving' ? 'attempt forecasts' : "verify others' forecasts"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <ConfigField label="Harness" restartRequired>
            <select
              value={draft.harness}
              onChange={(e) => setDraft({ ...draft, harness: e.target.value })}
              style={{
                background: 'var(--bg)',
                border: `1px solid ${draft.harness !== config.harness ? 'var(--accent-sky)' : 'var(--border)'}`,
                borderRadius: '6px',
                padding: '10px 12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '14px',
                color: 'var(--fg)',
              }}
            >
              {catalog.compatibleHarnesses
                .filter((h) => h.supportsRoles.includes(draft.role))
                .map((h) => (
                  <option key={h.name} value={h.name}>
                    {h.name}@{h.version}
                  </option>
                ))}
            </select>
          </ConfigField>

          <ConfigField label="Claude model" restartRequired>
            <input
              type="text"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              style={{
                background: 'var(--bg)',
                border: `1px solid ${draft.model !== config.model ? 'var(--accent-sky)' : 'var(--border)'}`,
                borderRadius: '6px',
                padding: '10px 12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '14px',
                color: 'var(--fg)',
              }}
            />
          </ConfigField>

          <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
              }}
            >
              Plugins
            </span>
            {draft.plugins.map((p) => {
              const meta = catalog.compatiblePlugins.find((cp) => cp.name === p);
              return (
                <div
                  key={p}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    background: 'var(--bg)',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  <span style={{ fontSize: '14px' }}>{p}</span>
                  <span style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>
                    {meta ? `${meta.source} · ${meta.version}` : '—'}
                  </span>
                </div>
              );
            })}
            {/* Add-plugin picker is deferred to a follow-up; placeholder affordance */}
            <button
              type="button"
              disabled
              style={{
                border: '1px dashed var(--border)',
                borderRadius: '6px',
                padding: '10px 14px',
                background: 'transparent',
                color: 'var(--fg-dim)',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                cursor: 'not-allowed',
                textAlign: 'center',
              }}
            >
              + Add plugin (coming soon)
            </button>
          </div>
        </div>
      )}

      {confirmDisable && (
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '13px',
            color: 'var(--fg)',
          }}
        >
          <span>Discard pending changes and disable {catalog.name}?</span>
          <span style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={() => setConfirmDisable(false)}
              style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 14px', background: 'transparent', color: 'var(--fg)', fontFamily: 'inherit', fontSize: '12px' }}
            >
              Keep
            </button>
            <button
              type="button"
              onClick={() => { setDraft({ ...config, enabled: false }); setConfirmDisable(false); }}
              style={{ border: '1px solid var(--break-red)', borderRadius: '6px', padding: '6px 14px', background: 'var(--break-red)', color: 'var(--fg)', fontFamily: 'inherit', fontSize: '12px' }}
            >
              Discard + disable
            </button>
          </span>
        </div>
      )}

      {dirty && !confirmDisable && (
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span style={{ fontSize: '12px', color: error ? 'var(--break-red)' : 'var(--accent-sky)' }}>
            {error ?? (saving ? 'Saving…' : 'Changes pending')}
          </span>
          <span style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '10px 20px', background: 'transparent', color: 'var(--fg)', fontFamily: 'inherit', fontSize: '14px' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void save(); }}
              disabled={saving}
              style={{ border: '1px solid var(--accent-sky)', borderRadius: '6px', padding: '10px 20px', background: 'var(--accent-sky)', color: 'var(--bg-sunken)', fontFamily: 'inherit', fontSize: '14px' }}
            >
              Save changes
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/dashboard/spa/src/pages/configuration/NetCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/configuration/NetCard.tsx client/src/dashboard/spa/src/pages/configuration/NetCard.test.tsx
git commit -m "feat(spa): add NetCard with role/harness/model/plugins editing"
```

---

### Task 18: `SolverNetsSection` (catalog list)

**Files:**
- Create: `client/src/dashboard/spa/src/pages/configuration/SolverNetsSection.tsx`
- Test: `client/src/dashboard/spa/src/pages/configuration/SolverNetsSection.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// client/src/dashboard/spa/src/pages/configuration/SolverNetsSection.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SolverNetsSection } from './SolverNetsSection.js';

vi.mock('../../api/client.js', () => ({
  api: {
    getSolverNets: async () => ({
      schemaVersion: 1,
      generatedAt: '2026-05-04T12:00:00Z',
      nets: [
        {
          name: 'prediction',
          description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
          intrinsicSolverType: 'prediction.v1',
          state: 'live',
          supportedRoles: ['solving', 'evaluating'],
          compatibleHarnesses: [{ name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving'] }],
          compatiblePlugins: [{ name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' }],
        },
      ],
    }),
  },
}));

describe('SolverNetsSection', () => {
  it('renders the catalog under the section card', async () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <SolverNetsSection
          configByName={{
            prediction: { enabled: false, role: 'solving', harness: 'claude-code-learner', model: 'claude-haiku-4-5-20251001', plugins: [] },
          }}
          onSaved={() => undefined}
          onRestartPending={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('prediction')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/pages/configuration/SolverNetsSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/pages/configuration/SolverNetsSection.tsx
import { useQuery } from '@tanstack/react-query';
import { SectionCard } from '../../components/SectionCard.js';
import { api } from '../../api/client.js';
import type { SolverNetsCatalogResponse } from '../../api/types.js';
import { NetCard, type NetCardConfig } from './NetCard.js';

const STATE_RANK: Record<string, number> = { live: 0, available: 1, coming_soon: 2 };

export interface SolverNetsSectionProps {
  configByName: Record<string, NetCardConfig>;
  onSaved: () => void;
  onRestartPending: () => void;
}

export function SolverNetsSection({ configByName, onSaved, onRestartPending }: SolverNetsSectionProps): JSX.Element {
  const { data, isLoading } = useQuery<SolverNetsCatalogResponse>({
    queryKey: ['solvernets-catalog'],
    queryFn: () => api.getSolverNets(),
    staleTime: 60_000,
  });

  const nets = (data?.nets ?? []).slice().sort((a, b) => STATE_RANK[a.state]! - STATE_RANK[b.state]!);
  const enabledCount = nets.filter((n) => configByName[n.name]?.enabled).length;
  const summary = isLoading
    ? 'Loading catalog…'
    : `${nets.length} available · ${enabledCount} enabled · pick what your node participates in`;

  return (
    <SectionCard
      title="SolverNets"
      summary={summary}
      defaultExpanded
      metaChip={enabledCount > 0 ? { label: `${enabledCount} live`, tone: 'live' } : undefined}
    >
      {nets.map((catalog) => {
        const config = configByName[catalog.name] ?? {
          enabled: false,
          role: catalog.supportedRoles[0] ?? 'solving',
          harness: catalog.compatibleHarnesses[0]?.name ?? '',
          model: 'claude-haiku-4-5-20251001',
          plugins: [],
        };
        return (
          <NetCard
            key={catalog.name}
            catalog={catalog}
            config={config}
            onSaved={onSaved}
            onRestartPending={onRestartPending}
          />
        );
      })}
    </SectionCard>
  );
}
```

- [ ] **Step 4: Run test + commit**

```bash
npx vitest run src/dashboard/spa/src/pages/configuration/SolverNetsSection.test.tsx
git add client/src/dashboard/spa/src/pages/configuration/SolverNetsSection.tsx client/src/dashboard/spa/src/pages/configuration/SolverNetsSection.test.tsx
git commit -m "feat(spa): add SolverNetsSection catalog list"
```

---

### Task 19: Wire `ConfigurationPage` to compose all sections

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Configuration.tsx`

- [ ] **Step 1: Replace placeholder with the real page**

```tsx
// client/src/dashboard/spa/src/pages/Configuration.tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { SolverNetsSection } from './configuration/SolverNetsSection.js';
import { NetworkSection } from './configuration/NetworkSection.js';
import { SecuritySection } from './configuration/SecuritySection.js';
import type { NetCardConfig } from './configuration/NetCard.js';

export interface ConfigurationPageProps {
  onRestartPending?: () => void;
}

interface BootstrapWithChainAndSolverNets {
  chain?: 'base' | 'base-sepolia';
  solverNets?: Record<string, NetCardConfig>;
  rpcUrl?: string;
  defaultRpcUrl?: string;
}

export function ConfigurationPage({ onRestartPending = () => undefined }: ConfigurationPageProps): JSX.Element {
  const { data, refetch } = useQuery<BootstrapWithChainAndSolverNets>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap() as Promise<BootstrapWithChainAndSolverNets>,
    refetchInterval: 1500,
  });

  const chain = data?.chain ?? 'base-sepolia';
  const rpcUrl = data?.rpcUrl ?? '';
  const defaultRpcUrl = data?.defaultRpcUrl ?? (chain === 'base' ? 'https://mainnet.base.org' : 'https://sepolia.base.org');

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <SolverNetsSection
        configByName={data?.solverNets ?? {}}
        onSaved={() => { void refetch(); }}
        onRestartPending={onRestartPending}
      />
      <NetworkSection
        chain={chain}
        rpcUrl={rpcUrl}
        defaultRpcUrl={defaultRpcUrl}
        rpcHealthy={true}
        onRestartPending={onRestartPending}
      />
      <SecuritySection />
    </div>
  );
}
```

- [ ] **Step 2: Pass `onRestartPending` from `App.tsx` into `ConfigurationPage`**

In `App.tsx`, replace the `<Route path="/configuration" component={ConfigurationPage} />` with:

```tsx
<Route path="/configuration">
  <ConfigurationPage onRestartPending={() => setRestartPending(true)} />
</Route>
```

- [ ] **Step 3: Extend `/v1/bootstrap` response to include `solverNets`, `rpcUrl`, `defaultRpcUrl`**

Modify `client/src/api/bootstrap-endpoint.ts` and its `BootstrapEndpointConfig` to read the live config and include those fields in the response. Add a corresponding test in `client/test/api/bootstrap-endpoint.test.ts` covering the new fields.

```ts
// In bootstrap-endpoint.ts, accept a configReader in BootstrapEndpointConfig
// and merge its fields into the response.
export interface BootstrapEndpointConfig {
  earningDir: string;
  configReader?: () => { rpcUrl?: string; defaultRpcUrl?: string; solverNets?: Record<string, unknown> };
}

// Inside the handler, after assembling the response, include:
const cfg = config.configReader?.() ?? {};
return c.json({
  schemaVersion: 1,
  // ... existing fields,
  ...(cfg.rpcUrl !== undefined ? { rpcUrl: cfg.rpcUrl } : {}),
  ...(cfg.defaultRpcUrl !== undefined ? { defaultRpcUrl: cfg.defaultRpcUrl } : {}),
  ...(cfg.solverNets !== undefined ? { solverNets: cfg.solverNets } : {}),
});
```

Wire `configReader` from `main.ts`:

```ts
addBootstrapRoutes(app, {
  earningDir: config.earningDir,
  configReader: () => ({
    rpcUrl: config.rpcUrl,
    defaultRpcUrl: CHAIN_CONFIG.rpcUrl,
    solverNets: config.solverNets,
  }),
});
```

- [ ] **Step 4: Add a bootstrap-endpoint test asserting the new fields land in the response**

Append to `client/test/api/bootstrap-endpoint.test.ts`:

```ts
  it('includes rpcUrl, defaultRpcUrl, and solverNets when configReader is supplied', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 1, step: 'complete' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, {
      earningDir,
      configReader: () => ({
        rpcUrl: 'https://my-tenderly.example/abc',
        defaultRpcUrl: 'https://sepolia.base.org',
        solverNets: { prediction: { enabled: true, role: 'solving' } },
      }),
    });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      rpcUrl?: string;
      defaultRpcUrl?: string;
      solverNets?: Record<string, unknown>;
    };
    expect(body.rpcUrl).toBe('https://my-tenderly.example/abc');
    expect(body.defaultRpcUrl).toBe('https://sepolia.base.org');
    expect(body.solverNets).toMatchObject({ prediction: { enabled: true, role: 'solving' } });
  });
```

- [ ] **Step 5: Build, run tests, and commit**

```bash
npx tsc --noEmit
npx vitest run test/api/bootstrap-endpoint.test.ts src/dashboard/spa/
git add client/src/api/bootstrap-endpoint.ts \
  client/src/main.ts \
  client/src/dashboard/spa/src/pages/Configuration.tsx \
  client/src/dashboard/spa/src/App.tsx \
  client/test/api/bootstrap-endpoint.test.ts
git commit -m "feat(spa): wire ConfigurationPage to compose SolverNets/Network/Security"
```

---

## Phase E: Overview page

### Task 20: `HeroStats` extracted from `Operating.tsx`

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/HeroStats.tsx`
- Test: `client/src/dashboard/spa/src/pages/overview/HeroStats.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// client/src/dashboard/spa/src/pages/overview/HeroStats.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeroStats } from './HeroStats.js';

describe('HeroStats', () => {
  it('renders four stat cards', () => {
    render(
      <HeroStats
        tasksDelivered={42}
        jinnEarned="123"
        gasRunwayDays={4}
        nodeStatus="Running"
      />,
    );
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('123')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/pages/overview/HeroStats.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/pages/overview/HeroStats.tsx
export interface HeroStatsProps {
  tasksDelivered: number;
  jinnEarned: string;
  gasRunwayDays: number | string;
  nodeStatus: string;
}

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }): JSX.Element {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '24px',
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          display: 'block',
          marginBottom: '12px',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '28px',
          fontWeight: 500,
          color: 'var(--fg)',
          letterSpacing: '-0.01em',
        }}
      >
        {value}
        {unit && (
          <span style={{ color: 'var(--fg-muted)', fontSize: '14px', marginLeft: '6px', fontFamily: "'JetBrains Mono', monospace" }}>
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}

export function HeroStats({ tasksDelivered, jinnEarned, gasRunwayDays, nodeStatus }: HeroStatsProps): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
      <Stat label="Tasks delivered" value={tasksDelivered} />
      <Stat label="JINN earned" value={jinnEarned} unit="JINN" />
      <Stat label="Gas runway" value={gasRunwayDays} unit="days" />
      <Stat label="Node status" value={nodeStatus} />
    </div>
  );
}
```

- [ ] **Step 4: Pass + commit**

```bash
npx vitest run src/dashboard/spa/src/pages/overview/HeroStats.test.tsx
git add client/src/dashboard/spa/src/pages/overview/HeroStats.tsx client/src/dashboard/spa/src/pages/overview/HeroStats.test.tsx
git commit -m "feat(spa): add Overview HeroStats"
```

---

### Task 21: `AlertBand` with deep-link routing

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/AlertBand.tsx`
- Test: `client/src/dashboard/spa/src/pages/overview/AlertBand.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// client/src/dashboard/spa/src/pages/overview/AlertBand.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { AlertBand } from './AlertBand.js';

describe('AlertBand', () => {
  it('renders the lead, body, and a deep-link CTA', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <AlertBand
          lead="Needs attention"
          body="Prediction is disabled"
          ctaLabel="Configure prediction"
          ctaHref="/configuration#solvernets/prediction"
        />
      </Router>,
    );
    expect(screen.getByText(/needs attention/i)).toBeTruthy();
    expect(screen.getByText(/prediction is disabled/i)).toBeTruthy();
    const cta = screen.getByText(/configure prediction/i).closest('a');
    expect(cta?.getAttribute('href')).toBe('/configuration#solvernets/prediction');
  });

  it('renders nothing when not active', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    const { container } = render(
      <Router hook={hook}>
        <AlertBand active={false} lead="" body="" ctaLabel="" ctaHref="" />
      </Router>,
    );
    expect(container.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/pages/overview/AlertBand.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/pages/overview/AlertBand.tsx
import { Link } from 'wouter';

export interface AlertBandProps {
  active?: boolean;
  lead: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
}

export function AlertBand({ active = true, lead, body, ctaLabel, ctaHref }: AlertBandProps): JSX.Element | null {
  if (!active) return null;
  return (
    <div
      style={{
        border: '1px solid var(--border-accent)',
        background: 'transparent',
        borderRadius: '10px',
        padding: '14px 24px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <span style={{ color: 'var(--fg)' }}>
        <span style={{ color: 'var(--accent-gold)', marginRight: '6px' }}>{lead}</span>
        {body}
      </span>
      <Link
        href={ctaHref}
        style={{
          fontSize: '11px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent-sky)',
          textDecoration: 'none',
        }}
      >
        {ctaLabel} →
      </Link>
    </div>
  );
}
```

- [ ] **Step 4: Pass + commit**

```bash
npx vitest run src/dashboard/spa/src/pages/overview/AlertBand.test.tsx
git add client/src/dashboard/spa/src/pages/overview/AlertBand.tsx client/src/dashboard/spa/src/pages/overview/AlertBand.test.tsx
git commit -m "feat(spa): add Overview AlertBand"
```

---

### Task 22: `NetworkCard` (public counters, one per known SolverNet)

The Network card shows counters that describe the *SolverNet*, not this operator. It renders for every known SolverNet whether the operator is participating or not. Same data could be reused on a public explorer surface; nothing here is operator-specific.

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/NetworkCard.tsx`
- Test: `client/src/dashboard/spa/src/pages/overview/NetworkCard.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// client/src/dashboard/spa/src/pages/overview/NetworkCard.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NetworkCard } from './NetworkCard.js';

describe('NetworkCard', () => {
  it('renders the network counters with no operator-specific state', () => {
    render(
      <NetworkCard
        name="prediction"
        totals={{ tasks: 12, active: 3, solutions: 9, verdicts: 8, failed: 1 }}
      />,
    );
    expect(screen.getByText(/network · prediction/i)).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy(); // tasks
    expect(screen.getByText('3')).toBeTruthy();  // active
    expect(screen.getByText('9')).toBeTruthy();  // solutions
    expect(screen.getByText('8')).toBeTruthy();  // verdicts
    expect(screen.getByText('1')).toBeTruthy();  // failed
    // No role, no state pill, no "View" CTA — those belong on OperatorCard.
    expect(screen.queryByText(/role/i)).toBeNull();
    expect(screen.queryByText(/view/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/pages/overview/NetworkCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/pages/overview/NetworkCard.tsx
export interface NetworkCardProps {
  name: string;
  totals: { tasks: number; active: number; solutions: number; verdicts: number; failed: number };
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '20px',
          fontWeight: 500,
          color: tone === 'warn' ? 'var(--wane)' : 'var(--fg)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function NetworkCard({ name, totals }: NetworkCardProps): JSX.Element {
  return (
    <section
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        Network · {name}
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '24px' }}>
        <Stat label="tasks" value={totals.tasks} />
        <Stat label="active" value={totals.active} />
        <Stat label="solutions" value={totals.solutions} />
        <Stat label="verdicts" value={totals.verdicts} />
        <Stat label="failed" value={totals.failed} tone={totals.failed > 0 ? 'warn' : undefined} />
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Pass + commit**

```bash
npx vitest run src/dashboard/spa/src/pages/overview/NetworkCard.test.tsx
git add client/src/dashboard/spa/src/pages/overview/NetworkCard.tsx client/src/dashboard/spa/src/pages/overview/NetworkCard.test.tsx
git commit -m "feat(spa): add Overview NetworkCard (public counters)"
```

---

### Task 22b: `OperatorCard` (operator-side state, one per *enabled* net)

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/OperatorCard.tsx`
- Test: `client/src/dashboard/spa/src/pages/overview/OperatorCard.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// client/src/dashboard/spa/src/pages/overview/OperatorCard.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OperatorCard } from './OperatorCard.js';

describe('OperatorCard', () => {
  it('renders operator-side state and a deep-link, no public counters', () => {
    const { hook } = memoryLocation({ path: '/overview' });
    render(
      <Router hook={hook}>
        <OperatorCard
          name="prediction"
          role="solving"
          state="live"
          waitingMessage="Waiting for Tasks. SolverNet active, Harness loaded."
        />
      </Router>,
    );
    expect(screen.getByText(/your prediction/i)).toBeTruthy();
    expect(screen.getByText(/solving/i)).toBeTruthy();
    expect(screen.getByText(/live/i)).toBeTruthy();
    expect(screen.getByText(/waiting for tasks/i)).toBeTruthy();
    const link = screen.getByText(/configure/i).closest('a');
    expect(link?.getAttribute('href')).toBe('/configuration#solvernets/prediction');
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run src/dashboard/spa/src/pages/overview/OperatorCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// client/src/dashboard/spa/src/pages/overview/OperatorCard.tsx
import { Link } from 'wouter';

export interface OperatorCardProps {
  name: string;
  role: 'solving' | 'evaluating';
  state: 'live' | 'available' | 'coming_soon';
  /** Operator-facing message describing what the node is waiting for / doing. */
  waitingMessage?: string;
}

export function OperatorCard({ name, role, state, waitingMessage }: OperatorCardProps): JSX.Element {
  const stateColor =
    state === 'live' ? 'var(--vow-green)' : state === 'available' ? 'var(--fg-muted)' : 'var(--fg-dim)';
  return (
    <section
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          Your {name}
        </span>
        <span
          style={{
            fontSize: '11px',
            color: stateColor,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
          }}
        >
          {state.replace('_', ' ')}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
        <span style={{ color: 'var(--fg)', fontSize: '14px' }}>
          Role <span style={{ color: 'var(--fg-muted)' }}>·</span> {role}
        </span>
        <Link
          href={`/configuration#solvernets/${name}`}
          style={{
            color: 'var(--accent-sky)',
            fontSize: '11px',
            textDecoration: 'none',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
        >
          Configure →
        </Link>
      </div>
      {waitingMessage && (
        <span style={{ color: 'var(--fg-muted)', fontSize: '12px' }}>{waitingMessage}</span>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Pass + commit**

```bash
npx vitest run src/dashboard/spa/src/pages/overview/OperatorCard.test.tsx
git add client/src/dashboard/spa/src/pages/overview/OperatorCard.tsx client/src/dashboard/spa/src/pages/overview/OperatorCard.test.tsx
git commit -m "feat(spa): add Overview OperatorCard (operator-side state)"
```

---

### Task 22c: Drop the "start the daemon" diagnostic when the daemon is running

The diagnostic at `client/src/solver-nets/prediction-operator-ux.ts:159` reads `'Prediction SolverNet is configured; start the daemon to watch shared Tasks.'` and is correctly oriented at setup-mode flows. On the running-mode dashboard (Issue #86 §1) it's vacuous and contradicts the "Node status: Running" tile. Replace with a "Waiting for Tasks" message that explains *why* nothing is happening.

**Files:**
- Modify: `client/src/solver-nets/prediction-operator-ux.ts` (around line 155–185)
- Test: extend `client/test/solver-nets/prediction-operator-ux.test.ts` (or the test file currently covering that diagnostic)

- [ ] **Step 1: Locate the existing diagnostic**

Open `client/src/solver-nets/prediction-operator-ux.ts`. Find the block that emits the `description: 'Prediction SolverNet is configured; start the daemon to watch shared Tasks.'` text. Note the surrounding inputs — likely `daemonRunning` is not yet a parameter; you'll plumb it in.

- [ ] **Step 2: Add a `daemonRunning` parameter to the builder**

Modify `BuildPredictionOperatorStatusOptions` to include `daemonRunning?: boolean`. Default `false` (existing behaviour). Inside the builder, when `daemonRunning === true` AND the SolverNet is configured AND no diagnostics, replace the existing description with:

```ts
description: 'Waiting for Tasks. SolverNet active, Harness loaded; no incoming Tasks since startup.',
```

When `daemonRunning === false`, the existing "start the daemon" copy is preserved.

- [ ] **Step 3: Write a failing test for the daemon-running branch**

```ts
// In prediction-operator-ux.test.ts (existing file)
it('does not say "start the daemon" when daemonRunning is true', async () => {
  const status = await buildPredictionOperatorStatus({
    config: enabledPredictionConfig(), // existing fixture
    configPath: '/tmp/x',
    daemonRunning: true,
    // ... other existing args
  });
  const text = JSON.stringify(status);
  expect(text).not.toMatch(/start the daemon/i);
  expect(text).toMatch(/waiting for tasks/i);
});
```

- [ ] **Step 4: Wire `daemonRunning` from `gather-status.ts`**

Find where `buildPredictionOperatorStatus` is called inside `client/src/api/gather-status.ts` (or wherever the running-mode `/v1/status` builder lives). Pass `daemonRunning: true` from there — when `gatherStatusForApi` is reached, the daemon is by definition running.

- [ ] **Step 5: Run tests + commit**

```bash
npx vitest run test/solver-nets/prediction-operator-ux.test.ts test/api/gather-status.test.ts
git add client/src/solver-nets/prediction-operator-ux.ts \
  client/src/api/gather-status.ts \
  client/test/solver-nets/prediction-operator-ux.test.ts
git commit -m "fix(prediction-ux): drop 'start the daemon' diagnostic when daemon is running"
```

---

### Task 23: `RecentActivity`, `QuickActions`, `IdentityCard`, `AdvancedDetails` extracted

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/RecentActivity.tsx`
- Create: `client/src/dashboard/spa/src/pages/overview/QuickActions.tsx`
- Create: `client/src/dashboard/spa/src/pages/overview/IdentityCard.tsx`
- Create: `client/src/dashboard/spa/src/pages/overview/AdvancedDetails.tsx`
- Tests: companion `.test.tsx` for each
- Reference: `client/src/dashboard/spa/src/regions/Operating.tsx` and `regions/SettingsCard.tsx`

- [ ] **Step 1: Identify the JSX blocks in `Operating.tsx` / `SettingsCard.tsx` that render each region**

Open both files. For each component below, locate the existing JSX block and copy it as the seed for the new file:

| Component         | Source location |
|-------------------|----------------|
| RecentActivity    | `Operating.tsx` — the `<RecentActivity />` JSX block (search for the eyebrow `RECENT ACTIVITY`) |
| QuickActions      | `SettingsCard.tsx` — the four buttons (claim / top-up / manage / restart) |
| IdentityCard      | `SettingsCard.tsx` — the IDENTITY block + agent NFT link |
| AdvancedDetails   | `SettingsCard.tsx` — the "ADVANCED DETAILS" disclosure |

- [ ] **Step 1b: For `IdentityCard`, add the binding-pending chip + inline retry disclosure**

In addition to the existing IDENTITY content (agent NFT, chain, Safe address), the new `IdentityCard` accepts a `services: Array<{ index, safeAddress, agentId, safeBoundToAgent }>` prop. When any service has `agentId !== null && safeBoundToAgent === false`, the card renders a wane chip `binding pending` next to the agent line. Clicking the chip toggles an inline disclosure:

- The disclosure shows the affected service's last error summary (drawn from a new optional `bindingError?: string` prop).
- Below the summary, a `Retry binding` button calls `api.retryAgentBinding({ serviceIndex })`. While the call is in flight, the button reads `Retrying…` and is disabled. On success (`status === 'success'`), the chip flips to `bound` and the disclosure auto-closes. On `reverted`, the chip stays `binding pending` and an error line surfaces with a "Try again" affordance.

Add a test for the binding-pending branch:

```tsx
// client/src/dashboard/spa/src/pages/overview/IdentityCard.test.tsx
it('shows binding pending chip + retry when a service has agentId set but safeBoundToAgent=false', async () => {
  render(
    <IdentityCard
      agentId={5474}
      chain="Base Sepolia"
      safeAddress="0x0e76…4FC"
      services={[{ index: 1, safeAddress: '0x0e76…4FC', agentId: 5474, safeBoundToAgent: false }]}
    />,
  );
  expect(screen.getByText(/binding pending/i)).toBeTruthy();
  fireEvent.click(screen.getByText(/binding pending/i));
  expect(screen.getByRole('button', { name: /retry binding/i })).toBeTruthy();
});
```

Add a corresponding `retryAgentBinding` method to the API client (`client/src/dashboard/spa/src/api/client.ts`):

```ts
retryAgentBinding: (patch?: { serviceIndex?: number }) =>
  jfetch<{
    ok: boolean;
    attempts: Array<{ serviceIndex: number; status: 'success' | 'reverted' | 'queued'; txHash?: string; detail?: string }>;
  }>('/v1/setup/agent-binding/retry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch ?? {}),
  }),
```

- [ ] **Step 2: Write minimal smoke tests for each new component**

For each component, write a smoke test that asserts the eyebrow / heading is present. Example for `RecentActivity`:

```tsx
// client/src/dashboard/spa/src/pages/overview/RecentActivity.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentActivity } from './RecentActivity.js';

describe('RecentActivity', () => {
  it('renders the eyebrow', () => {
    render(<RecentActivity events={[]} />);
    expect(screen.getByText(/recent activity/i)).toBeTruthy();
  });
});
```

Replicate the same shape for `QuickActions` (asserts "Claim JINN", "Top up gas", "Manage wallet", "Restart node"), `IdentityCard` (asserts "Identity"), and `AdvancedDetails` (asserts "Advanced details").

- [ ] **Step 3: Move each block into its own file, exporting a typed component**

Each component takes only the props it needs (e.g., `RecentActivity` takes `events: ActivityEvent[]`; `QuickActions` takes `claimableJinn`, `gasEth`, `onClaim`, `onTopUp`, `onManage`, `onRestart`). Use the canonical DESIGN.md tokens for all visual treatment — no shadows, hairline borders, mono everywhere except the brand mark, gold-as-hint reserved for the AlertBand only.

- [ ] **Step 4: Run all four test files**

Run: `npx vitest run src/dashboard/spa/src/pages/overview/`
Expected: PASS for all.

- [ ] **Step 5: Commit each file together**

```bash
git add client/src/dashboard/spa/src/pages/overview/RecentActivity.tsx \
  client/src/dashboard/spa/src/pages/overview/RecentActivity.test.tsx \
  client/src/dashboard/spa/src/pages/overview/QuickActions.tsx \
  client/src/dashboard/spa/src/pages/overview/QuickActions.test.tsx \
  client/src/dashboard/spa/src/pages/overview/IdentityCard.tsx \
  client/src/dashboard/spa/src/pages/overview/IdentityCard.test.tsx \
  client/src/dashboard/spa/src/pages/overview/AdvancedDetails.tsx \
  client/src/dashboard/spa/src/pages/overview/AdvancedDetails.test.tsx
git commit -m "feat(spa): extract RecentActivity / QuickActions / IdentityCard / AdvancedDetails"
```

---

### Task 24: Compose `OverviewPage`

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx`

- [ ] **Step 1: Replace placeholder with the real page**

```tsx
// client/src/dashboard/spa/src/pages/Overview.tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { HeroStats } from './overview/HeroStats.js';
import { AlertBand } from './overview/AlertBand.js';
import { NetworkCard } from './overview/NetworkCard.js';
import { OperatorCard } from './overview/OperatorCard.js';
import { RecentActivity } from './overview/RecentActivity.js';
import { QuickActions } from './overview/QuickActions.js';
import { IdentityCard } from './overview/IdentityCard.js';
import { AdvancedDetails } from './overview/AdvancedDetails.js';

interface OverviewStatusV1 {
  tasksDelivered?: number;
  jinnEarned?: string;
  gasRunwayDays?: number;
  nodeStatus?: string;
  fleet?: {
    services?: Array<{ index: number; safeAddress?: string | null; agentId?: number | null; safeBoundToAgent?: boolean }>;
  };
  predictionV1?: {
    operator?: {
      ok?: boolean;
      enabled?: boolean;
      role?: 'solving' | 'evaluating';
      nextAction?: { description?: string };
      diagnostics?: Array<{ code: string; severity: string; message: string; configField?: string }>;
    };
    totals?: { observedTasks?: number; activeTaskRuns?: number; solutions?: number; verdicts?: number; failed?: number };
  };
}

export function OverviewPage(): JSX.Element {
  const { data: status } = useQuery<OverviewStatusV1>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<OverviewStatusV1>,
    refetchInterval: 5_000,
  });

  const operator = status?.predictionV1?.operator;
  const operatorEnabled = operator?.enabled === true;
  const totals = {
    tasks: status?.predictionV1?.totals?.observedTasks ?? 0,
    active: status?.predictionV1?.totals?.activeTaskRuns ?? 0,
    solutions: status?.predictionV1?.totals?.solutions ?? 0,
    verdicts: status?.predictionV1?.totals?.verdicts ?? 0,
    failed: status?.predictionV1?.totals?.failed ?? 0,
  };
  const firstAttention = (operator?.diagnostics ?? []).find((d) => d.severity === 'error');
  const services = status?.fleet?.services ?? [];

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <HeroStats
        tasksDelivered={status?.tasksDelivered ?? 0}
        jinnEarned={status?.jinnEarned ?? '0'}
        gasRunwayDays={status?.gasRunwayDays ?? '—'}
        nodeStatus={status?.nodeStatus ?? '—'}
      />
      {firstAttention && (
        <AlertBand
          lead="Needs attention"
          body={firstAttention.message}
          ctaLabel="Configure prediction"
          ctaHref="/configuration#solvernets/prediction"
        />
      )}

      {/* Public counters — always shown when the catalog has prediction. */}
      <NetworkCard name="prediction" totals={totals} />

      {/* Operator-side state — only when the operator has opted in. */}
      {operatorEnabled ? (
        <OperatorCard
          name="prediction"
          role={operator?.role ?? 'solving'}
          state="live"
          waitingMessage={operator?.nextAction?.description}
        />
      ) : (
        <AlertBand
          lead="Get started"
          body="Pick a SolverNet to participate in"
          ctaLabel="Configure"
          ctaHref="/configuration#solvernets"
        />
      )}

      <RecentActivity events={[]} />
      <QuickActions
        claimableJinn="0"
        gasEth="0"
        onClaim={() => api.claimRewards()}
        onTopUp={() => undefined}
        onManage={() => undefined}
        onRestart={() => api.restartDaemon()}
      />
      <IdentityCard
        agentId={services[0]?.agentId ?? null}
        chain="Base Sepolia"
        safeAddress={services[0]?.safeAddress ?? null}
        services={services.map((s) => ({
          index: s.index,
          safeAddress: s.safeAddress ?? '',
          agentId: s.agentId ?? null,
          safeBoundToAgent: s.safeBoundToAgent ?? false,
        }))}
      />
      <AdvancedDetails />
    </div>
  );
}
```

- [ ] **Step 2: Build and visually verify**

Run: `yarn build && node dist/bin/jinn.js run`
Expected: Overview page renders the new composition; AlertBand shows when prediction is in `Needs attention`; clicking the CTA navigates to `/configuration` and (after Task 25) auto-expands the SolverNets section.

- [ ] **Step 3: Commit**

```bash
git add client/src/dashboard/spa/src/pages/Overview.tsx
git commit -m "feat(spa): compose OverviewPage from extracted regions"
```

---

### Task 25: Hash anchor → section auto-expand on `ConfigurationPage`

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Configuration.tsx`
- Modify: `client/src/dashboard/spa/src/pages/configuration/SolverNetsSection.tsx` (accept `defaultExpanded`)
- Modify: `client/src/dashboard/spa/src/pages/configuration/NetworkSection.tsx` (accept `defaultExpanded`)
- Modify: `client/src/dashboard/spa/src/pages/configuration/SecuritySection.tsx` (accept `defaultExpanded`)

- [ ] **Step 1: Add a `useHashSection` hook**

Create `client/src/dashboard/spa/src/pages/configuration/useHashSection.ts`:

```ts
import { useEffect, useState } from 'react';

export function useHashSection(): string | null {
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    const update = (): void => {
      const h = window.location.hash.replace(/^#/, '');
      setHash(h.length > 0 ? h : null);
    };
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return hash;
}
```

- [ ] **Step 2: Use it in `ConfigurationPage` to drive `defaultExpanded` per section**

In `Configuration.tsx`:

```tsx
import { useHashSection } from './configuration/useHashSection.js';

// inside the component:
const hash = useHashSection();
const expandedSection = hash?.split('/')[0]; // e.g. 'solvernets' from 'solvernets/prediction'

// pass defaultExpanded={expandedSection === 'solvernets'} (etc.) to each section
```

Each section component already supports `defaultExpanded` via SectionCard — pass it through.

- [ ] **Step 3: Smoke test**

Run: `yarn build && node dist/bin/jinn.js run`
Visit `/configuration#solvernets/prediction` directly. Expected: SolverNets section is expanded on first paint.

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/pages/configuration/useHashSection.ts \
  client/src/dashboard/spa/src/pages/Configuration.tsx \
  client/src/dashboard/spa/src/pages/configuration/SolverNetsSection.tsx \
  client/src/dashboard/spa/src/pages/configuration/NetworkSection.tsx \
  client/src/dashboard/spa/src/pages/configuration/SecuritySection.tsx
git commit -m "feat(spa): hash anchor auto-expands the targeted Configuration section"
```

---

## Phase F: Migration cleanup

### Task 26: Delete `Operating.tsx`, `SettingsCard.tsx`, `SolverNetConfigCard`

**Files:**
- Delete: `client/src/dashboard/spa/src/regions/Operating.tsx` and `Operating.test.tsx` (if present)
- Delete: `client/src/dashboard/spa/src/regions/SettingsCard.tsx` (now decomposed)
- Delete: the `SolverNetConfigCard` component inside `Operating.tsx` (was the Phase A+B interim)
- Modify: `client/src/dashboard/spa/src/App.tsx` (remove any remaining import of Operating)
- Modify: any remaining test that imports from these deleted files; rewrite against the new components.

- [ ] **Step 1: List references to `Operating` and `SettingsCard`**

Run: `grep -rn "Operating\|SettingsCard\|SolverNetConfigCard" client/src/dashboard/spa/src/ client/test/dashboard/`
Expected: only the legacy files themselves (and their imports inside the soon-to-be-deleted `Operating.tsx`).

- [ ] **Step 2: Remove all imports**

In `App.tsx`, ensure there is no `import { Operating }` or `import { SettingsCard }`. If any test files reference these, rewrite them to target the new equivalents (e.g., a `QuickActions` test for what used to be a `SettingsCard` quick-actions test).

- [ ] **Step 3: Delete the legacy files**

```bash
git rm client/src/dashboard/spa/src/regions/Operating.tsx
git rm client/src/dashboard/spa/src/regions/Operating.test.tsx 2>/dev/null || true
git rm client/src/dashboard/spa/src/regions/SettingsCard.tsx
```

- [ ] **Step 4: Build + run full test suite**

```bash
yarn build
npx vitest run
```
Expected: build OK, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(spa): remove Operating + SettingsCard now that pages compose the regions"
```

---

## Phase G: End-to-end coverage

### Task 27: Playwright happy-path

**Files:**
- Create: `client/test/dashboard/spa-config.e2e.test.ts`

- [ ] **Step 1: Write the test**

```ts
// client/test/dashboard/spa-config.e2e.test.ts
import { test, expect } from '@playwright/test';

test('operator opens Configuration, swaps SolverNet role, and sees restart banner', async ({ page }) => {
  await page.goto(process.env['JINN_DASHBOARD_URL'] ?? 'http://127.0.0.1:7332');

  // The dashboard should boot in running mode for this test fixture.
  await expect(page.getByText('jinn operator')).toBeVisible();

  // Navigate to Configuration via the top tab.
  await page.getByRole('link', { name: /configuration/i }).click();
  await expect(page).toHaveURL(/\/configuration$/);

  // SolverNets section is expanded by default.
  await expect(page.getByText(/solvernets/i)).toBeVisible();

  // The prediction net card is present.
  const predictionCard = page.locator('text=prediction').first();
  await expect(predictionCard).toBeVisible();

  // Toggle role to Evaluating, save.
  await page.getByRole('button', { name: /evaluating/i }).click();
  await page.getByRole('button', { name: /save changes/i }).click();

  // Restart banner appears across both tabs.
  await expect(page.getByText(/configuration saved/i)).toBeVisible();
});
```

- [ ] **Step 2: Run with the daemon up**

```bash
node dist/bin/jinn.js run &
yarn playwright test test/dashboard/spa-config.e2e.test.ts
```

Expected: the test passes. (Adjust the test's URL handshake step if the daemon's handshake key changes between runs — see existing `client/test/dashboard/spa.e2e.test.ts` for the established pattern.)

- [ ] **Step 3: Commit**

```bash
git add client/test/dashboard/spa-config.e2e.test.ts
git commit -m "test(spa): playwright happy-path for Configuration role swap + restart banner"
```

---

## Final pass

### Task 28: Spec coverage check + screenshot the result

**Files:**
- None (read-only)

- [ ] **Step 1: Skim the spec**

Open `docs/superpowers/specs/2026-05-04-operator-app-overview-configuration-design.md`. Confirm every section, requirement, and decision is covered by a task above.

- [ ] **Step 2: Run all tests + typecheck + build**

```bash
npx tsc --noEmit
npx vitest run
yarn build
```
Expected: clean.

- [ ] **Step 3: Take a verification screenshot**

Start the daemon (`node dist/bin/jinn.js run`), open the dashboard, and capture both `/overview` and `/configuration` to `client/.local/run-screenshots/post-split-overview.png` and `post-split-configuration.png`.

- [ ] **Step 4: Final commit**

```bash
git add client/.local/run-screenshots/
git commit -m "chore: post-split verification screenshots"
```

---

## Self-review

**Spec coverage:**
- Prerequisite — rebase onto merged faucet-cap fix → Task 0
- Architecture (router, shell, app outlet, agent rail) → Tasks 4, 5, 6, 7, 8, 9, 10
- Persistent restart banner across both tabs → Task 9 (`RestartBanner`) + Task 10 (wired in App.tsx)
- Overview page (hero, alert, public/operator split, recent activity, quick actions, identity, advanced) → Tasks 20–24
- Public/operator visual split on Overview (Issue #86 §2) → Task 22 (`NetworkCard`) + Task 22b (`OperatorCard`); composed in Task 24
- Status copy: drop "start the daemon" when running (Issue #86 §1) → Task 22c (`prediction-operator-ux.ts` change)
- Safe-to-agent binding pending chip + retry (Issue #86 §6 operator-app half) → Task 3a (server endpoint) + Task 23 Step 1b (`IdentityCard` chip + retry)
- Configuration page section pattern → Task 11 (`SectionCard`) + Tasks 15–19
- SolverNets catalog model + opt-in toggle + per-net body → Tasks 1, 17, 18
- Role / harness / model / plugins per net → Task 17 (`NetCard`)
- Disable-while-dirty confirm → Task 17 (`confirmDisable` branch)
- Restart-required pill per field → Task 12 (`RestartPill`) + Task 13 (`ConfigField`)
- Network section editable RPC + locked chain → Task 16
- Security danger zone → Task 15
- API surface — `GET /v1/solvernets`, modified `POST /v1/setup/solvernets/:name`, new `POST /v1/setup/network`, new `POST /v1/setup/agent-binding/retry` → Tasks 1, 2, 3, 3a
- Migration → Task 26
- Tests → component tests on every new file; Playwright happy-path on Task 27
- Open decisions table from the spec → reflected in the implementation defaults (no Defaults section, no custom-tasks section, single role per net)

**Placeholder scan:** none. Every step contains real code or real commands. No "TBD", no "implement later", no "similar to Task N" without the actual code.

**Type consistency:** `NetCardConfig` is defined in Task 17 and reused in Tasks 18, 19. `SolverNetCatalogEntry` is defined in Task 1 (server) and Task 14 (SPA types). `SolverNetsCatalogResponse` matches between server (Task 1) and client (Task 14). `BindAttemptResult` defined in Task 3a is the response shape consumed by the SPA in Task 23 Step 1b. API response shapes match across endpoint definitions and client calls.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-04-operator-app-overview-configuration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
