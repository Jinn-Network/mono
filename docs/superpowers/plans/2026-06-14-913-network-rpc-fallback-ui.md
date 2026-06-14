# Settings → Network: Full RPC Fallback Chain + Primary RPC UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the full shipped public RPC fallback chain (ordered, read-only, per-slot health) in Settings → Network, and let the operator set/clear a single Primary RPC that prepends to the runtime `rpcUrls` array.

**Architecture:** The daemon already resolves the live ordered chain into `config.rpcUrls: readonly string[]` and probes each slot at boot via `probeFallbackChain` (results currently logged and dropped). We capture the boot probe into a module-scoped variable, surface `rpcUrls` + `publicDefaults` + `rpcSlotHealth` (host-masked) through the existing `/v1/bootstrap` `configReader`, change `POST /v1/setup/network` to persist the **array** `[primary, ...publicDefaults]` instead of a single string, and rewrite the SPA `NetworkSectionContent` to render a read-only slot list plus one editable Primary RPC input. No new endpoints; all new `/v1/bootstrap` fields are optional/back-compat.

**Tech Stack:** TypeScript, Hono (daemon HTTP), viem (RPC transport), React + @tanstack/react-query + shadcn/ui (operator SPA), Vitest (+ @testing-library/react) for tests.

---

## Background — verified file/line facts

These were verified against the worktree on 2026-06-14 (line numbers drift; anchor on the named symbol):

- `client/src/config.ts:724` — `JinnConfig.rpcUrls: readonly string[]` is the live ordered chain (head = `rpcUrl`).
- `client/src/config.ts:763` — `DEFAULT_TESTNET_RPC_URLS = ['https://base-sepolia.publicnode.com', 'https://sepolia.base.org']`.
- `client/src/config.ts:1263-1265` — `defaultRpcUrls = parsed.network === 'testnet' ? DEFAULT_TESTNET_RPC_URLS : ['https://mainnet.base.org']`.
- `client/src/config.ts:51` — schema `rpcUrl: z.union([z.string(), z.array(z.string()).min(1)]).optional()` (arrays accepted).
- `client/src/config.ts:1334` — `persistTopLevelConfigValue(key, value: unknown, configPath?)` writes any JSON value (arrays fine).
- `client/src/preflight/rpc-network.ts:195` — `ProbeResult = ProbeOk | ProbeFail`; `ProbeOk = { ok: true; host; latencyMs }`, `ProbeFail = { ok: false; host; code?; reason?; message }`. Hosts already masked via `maskRpcHost`.
- `client/src/preflight/rpc-network.ts:231` — `probeFallbackChain(urls, network, layer, options?): Promise<ProbeResult[]>`.
- `client/src/main.ts:875-876` — boot probe runs and is logged; the returned `ProbeResult[]` is discarded.
- `client/src/main.ts:224-225` — `NETWORK_CHAIN`, `CHAIN_CONFIG`.
- `client/src/main.ts:1185-1190` — `bootstrap.configReader` closure returns `{ rpcUrl, defaultRpcUrl, joinedSolverNets, onboardingComplete }`.
- `client/src/main.ts:1308` — setup dep `defaultRpcUrlForChain: () => CHAIN_CONFIG.rpcUrl`.
- `client/src/api/bootstrap-endpoint.ts:23-28` — `configReader` return type; `:249-252` — spread into `/v1/bootstrap` JSON.
- `client/src/api/setup-endpoints.ts:762-813` — `POST /v1/setup/network` (persists a single string today).
- `client/src/api/setup-endpoints.ts:105` — `defaultRpcUrlForChain?: () => string` dep.
- `client/src/dashboard/spa/src/api/types.ts:105-128` — `BootstrapState`, `rpcUrl?`, `defaultRpcUrl?`.
- `client/src/dashboard/spa/src/api/client.ts:205` — `updateNetwork({ rpcUrl: string | null })` → `POST /v1/setup/network`.
- `client/src/dashboard/spa/src/pages/operator/NetworkTab.tsx:26-333` — `NetworkSectionContent` + `TaskPostsCard` (TaskPostsCard untouched).
- `client/src/dashboard/spa/src/pages/operator/NetworkTab.test.tsx` — existing SPA tests.
- `client/test/api/setup-endpoints.test.ts:685-787` — existing `POST /v1/setup/network` tests.
- `client/test/api/bootstrap-endpoint.test.ts` — existing bootstrap tests (no `configReader` coverage yet).
- `client/OPERATOR-APP-SPEC.md` §2.11 (lines ~307-335).

## File structure (what each touched file owns)

- `client/src/api/bootstrap-endpoint.ts` — extend `configReader` return type + response spread with `rpcUrls`, `publicDefaults`, `rpcSlotHealth`.
- `client/src/api/setup-endpoints.ts` — `POST /v1/setup/network` persists `[primary, ...publicDefaults]` array; add `defaultRpcUrlsForChain?: () => readonly string[]` dep.
- `client/src/main.ts` — module-scoped `lastL2Probe`; capture boot probe into it; wire `rpcUrls` / `publicDefaults` / `rpcSlotHealth` into `configReader`; add `defaultRpcUrlsForChain` to setup deps.
- `client/src/dashboard/spa/src/api/types.ts` — extend `BootstrapState` with `rpcUrls?`, `publicDefaults?`, `rpcSlotHealth?` mirror types.
- `client/src/dashboard/spa/src/api/client.ts` — `updateNetwork` body unchanged (`{ rpcUrl: string | null }`); no behavior change (verify only).
- `client/src/dashboard/spa/src/pages/operator/NetworkTab.tsx` — rewrite `NetworkSectionContent`; `TaskPostsCard` untouched.
- `client/OPERATOR-APP-SPEC.md` — §2.11 Network domain-model update.
- Tests: `client/test/api/bootstrap-endpoint.test.ts`, `client/test/api/setup-endpoints.test.ts`, `client/src/dashboard/spa/src/pages/operator/NetworkTab.test.tsx`.

## Wire shape (locked — used across every task)

Mirror type added to `types.ts` (matches `ProbeResult` minus the daemon-internal `message`/`reason` we don't render):

```typescript
/** Per-slot boot-probe health for one RPC fallback slot (#913). Host is masked. */
export interface RpcSlotHealth {
  ok: boolean;
  host: string;
  latencyMs?: number;
  /** HTTP status when the slot failed with one (e.g. 429, 503). */
  code?: number;
}
```

`/v1/bootstrap` gains three optional fields (old `rpcUrl` / `defaultRpcUrl` retained for back-compat):

- `rpcUrls?: string[]` — the live ordered chain (`config.rpcUrls`).
- `publicDefaults?: string[]` — the bundled public chain for the current network.
- `rpcSlotHealth?: RpcSlotHealth[]` — boot-probe result per slot, index-aligned to `rpcUrls`.

`POST /v1/setup/network` body is unchanged: `{ rpcUrl: string | null }`. Persistence target changes string→array.

## Acceptance-criterion → task map

- **AC1** (full chain rendered ordered, read-only, slot+URL+health): Tasks 1, 2, 6.
- **AC2** (add single Primary RPC, prepends): Tasks 3, 7.
- **AC3** (persisted shape `[primary, ...publicDefaults]` / `[...publicDefaults]`): Task 3.
- **AC4** (Primary row "tried first" copy + per-slot health indicator): Tasks 2, 6, 7.
- **AC5** (spec §2.11 update): Task 8.

---

### Task 1: Capture boot probe + surface chain through `/v1/bootstrap` (backend wiring)

**Files:**
- Modify: `client/src/main.ts` (boot probe ~875-876; `configReader` ~1185-1190; constants near `NETWORK_CHAIN` ~224-225)
- (Type only) Modify: `client/src/api/bootstrap-endpoint.ts` (`configReader` type ~23-28; response spread ~239-262)

- [ ] **Step 1: Extend the `configReader` return type in `bootstrap-endpoint.ts`**

In `client/src/api/bootstrap-endpoint.ts`, add an exported `RpcSlotHealthEntry` type and extend the `configReader` return type. Replace the existing `configReader?: () => { ... }` block:

```typescript
/** Per-slot boot-probe health (#913). Host masked by the daemon before this point. */
export interface RpcSlotHealthEntry {
  ok: boolean;
  host: string;
  latencyMs?: number;
  code?: number;
}

export interface BootstrapEndpointConfig {
  earningDir: string;
  /** Reads operator-tunable runtime fields (rpcUrl, defaultRpcUrl, rpcUrls,
   *  publicDefaults, rpcSlotHealth, joinedSolverNets) and merges them into the
   *  response so the SPA's Configuration page can render them without a
   *  separate fetch. */
  configReader?: () => {
    rpcUrl?: string;
    defaultRpcUrl?: string;
    rpcUrls?: readonly string[];
    publicDefaults?: readonly string[];
    rpcSlotHealth?: readonly RpcSlotHealthEntry[];
    joinedSolverNets?: Record<string, unknown>;
    onboardingComplete?: boolean;
  };
}
```

- [ ] **Step 2: Spread the new fields into the `/v1/bootstrap` response**

In `client/src/api/bootstrap-endpoint.ts`, inside the `c.json({ ... })` at the end of `addBootstrapRoutes` (after the existing `cfg.defaultRpcUrl` spread, ~line 250), add:

```typescript
      ...(cfg.rpcUrls !== undefined ? { rpcUrls: cfg.rpcUrls } : {}),
      ...(cfg.publicDefaults !== undefined ? { publicDefaults: cfg.publicDefaults } : {}),
      ...(cfg.rpcSlotHealth !== undefined ? { rpcSlotHealth: cfg.rpcSlotHealth } : {}),
```

- [ ] **Step 3: Add a module-scoped probe capture in `main.ts`**

In `client/src/main.ts`, near the top-level module scope (next to other top-level `let` daemon state — search for `let retryBootstrapResolve`), add:

```typescript
/** #913: last L2 boot-probe result per RPC slot. Captured at boot, surfaced
 *  via /v1/bootstrap so Settings → Network can render per-slot health. Hosts
 *  are already masked by probeFallbackChain. The RPC chain is restart-required,
 *  so this never drifts without a re-probing restart. */
let lastL2Probe: import('./preflight/rpc-network.js').ProbeResult[] = [];
```

If `ProbeResult` is already imported at the top of `main.ts` (it imports `probeFallbackChain` from `./preflight/rpc-network.js` ~line 130), prefer a named import instead — change that import line to also import the type:

```typescript
  probeFallbackChain,
  type ProbeResult,
```

and declare `let lastL2Probe: ProbeResult[] = [];`.

- [ ] **Step 4: Capture the boot probe result**

In `client/src/main.ts`, change the boot probe call (~line 875) from:

```typescript
  await probeFallbackChain(config.rpcUrls, config.network, 'L2');
```

to:

```typescript
  lastL2Probe = await probeFallbackChain(config.rpcUrls, config.network, 'L2');
```

Leave the `summarizeFallbackChain` log line and the L1 probe untouched.

- [ ] **Step 5: Compute `publicDefaults` and pass new fields into `configReader`**

In `client/src/main.ts`, near `NETWORK_CHAIN` / `CHAIN_CONFIG` (~224-225), add:

```typescript
const RPC_PUBLIC_DEFAULTS: readonly string[] =
  NETWORK_CHAIN === 'base-sepolia' ? DEFAULT_TESTNET_RPC_URLS : [CHAIN_CONFIG.rpcUrl];
```

Ensure `DEFAULT_TESTNET_RPC_URLS` is imported from `./config.js` (add to the existing config import if absent).

Then extend the `bootstrap.configReader` closure (~1185-1190) to:

```typescript
        configReader: () => ({
          rpcUrl: config.rpcUrl,
          defaultRpcUrl: CHAIN_CONFIG.rpcUrl,
          rpcUrls: config.rpcUrls,
          publicDefaults: RPC_PUBLIC_DEFAULTS,
          rpcSlotHealth: lastL2Probe.map((p) =>
            p.ok
              ? { ok: true as const, host: p.host, latencyMs: p.latencyMs }
              : { ok: false as const, host: p.host, code: p.code },
          ),
          joinedSolverNets: config.joinedSolverNets as Record<string, unknown> | undefined,
          onboardingComplete: config.onboardingComplete,
        }),
```

- [ ] **Step 6: Typecheck**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" add client/src/main.ts client/src/api/bootstrap-endpoint.ts
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" commit -m "feat(#913): surface RPC fallback chain + per-slot health on /v1/bootstrap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend test — `/v1/bootstrap` surfaces `rpcUrls` + `publicDefaults` + `rpcSlotHealth`

**Files:**
- Test: `client/test/api/bootstrap-endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `client/test/api/bootstrap-endpoint.test.ts` (inside the top-level `describe('GET /v1/bootstrap', ...)` block, or as a new sibling `describe`):

```typescript
  it('surfaces rpcUrls, publicDefaults and rpcSlotHealth from configReader (#913)', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, {
      earningDir,
      configReader: () => ({
        rpcUrl: 'https://my-alchemy.example/key',
        defaultRpcUrl: 'https://base-sepolia.publicnode.com',
        rpcUrls: [
          'https://my-alchemy.example/key',
          'https://base-sepolia.publicnode.com',
          'https://sepolia.base.org',
        ],
        publicDefaults: [
          'https://base-sepolia.publicnode.com',
          'https://sepolia.base.org',
        ],
        rpcSlotHealth: [
          { ok: true, host: 'my-alchemy.example', latencyMs: 12 },
          { ok: true, host: 'base-sepolia.publicnode.com', latencyMs: 40 },
          { ok: false, host: 'sepolia.base.org', code: 429 },
        ],
      }),
    });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      rpcUrls: string[];
      publicDefaults: string[];
      rpcSlotHealth: Array<{ ok: boolean; host: string; latencyMs?: number; code?: number }>;
    };
    expect(body.rpcUrls).toEqual([
      'https://my-alchemy.example/key',
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
    expect(body.publicDefaults).toEqual([
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
    expect(body.rpcSlotHealth).toHaveLength(3);
    expect(body.rpcSlotHealth[2]).toEqual({ ok: false, host: 'sepolia.base.org', code: 429 });
  });

  it('omits the new RPC fields when no configReader is supplied (back-compat)', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('rpcUrls');
    expect(body).not.toHaveProperty('publicDefaults');
    expect(body).not.toHaveProperty('rpcSlotHealth');
  });
```

- [ ] **Step 2: Run the test to verify it passes (Task 1 already implemented the surface)**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn vitest run test/api/bootstrap-endpoint.test.ts`
Expected: PASS (both new cases green). If the first case fails, the spread in Task 1 Step 2 is missing or mis-keyed; fix it before continuing.

- [ ] **Step 3: Commit**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" add client/test/api/bootstrap-endpoint.test.ts
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" commit -m "test(#913): /v1/bootstrap surfaces rpc chain + slot health

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `POST /v1/setup/network` persists `[primary, ...publicDefaults]` array (TDD)

**Files:**
- Modify: `client/src/api/setup-endpoints.ts` (dep type ~105; route ~762-813)
- Test: `client/test/api/setup-endpoints.test.ts` (within `describe('POST /v1/setup/network', ...)` ~685)

- [ ] **Step 1: Write the failing tests**

In `client/test/api/setup-endpoints.test.ts`, inside `describe('POST /v1/setup/network', ...)`, add:

```typescript
  it('persists [primary, ...publicDefaults] when a primary URL is given (#913)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-primary-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet' });

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      defaultRpcUrlsForChain: () => [
        'https://base-sepolia.publicnode.com',
        'https://sepolia.base.org',
      ],
    });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: 'https://my-alchemy.example/key' }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toEqual([
      'https://my-alchemy.example/key',
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
  });

  it('persists [...publicDefaults] when the primary is cleared to null (#913)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-clear-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {
      network: 'testnet',
      rpcUrl: ['https://old-primary.example/k', 'https://base-sepolia.publicnode.com'],
    });

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      defaultRpcUrlsForChain: () => [
        'https://base-sepolia.publicnode.com',
        'https://sepolia.base.org',
      ],
    });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: null }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toEqual([
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
  });
```

Note: the two pre-existing tests at lines 690-735 (`persists a custom RPC URL` asserting a *string*, and `reverts to default when rpcUrl is null` asserting a *string*) will break once persistence becomes an array. Update them in this same step:

In `persists a custom RPC URL` — add `defaultRpcUrlsForChain: () => ['https://default.example']` to the `addSetupRoutes` call (it currently writes `{ network: 'testnet', rpcUrl: 'https://default.example' }`), and change the two assertions from string equality to:

```typescript
    expect(body.rpcUrl).toEqual(['https://my-tenderly.example.com/abc', 'https://default.example']);
    // ...
    expect(persisted.rpcUrl).toEqual(['https://my-tenderly.example.com/abc', 'https://default.example']);
```

In `reverts to default when rpcUrl is null` — replace `defaultRpcUrlForChain: () => 'https://sepolia.base.org'` with `defaultRpcUrlsForChain: () => ['https://sepolia.base.org']` and change the assertion to:

```typescript
    expect(persisted.rpcUrl).toEqual(['https://sepolia.base.org']);
```

In `creates config.json when it does not exist` — add `defaultRpcUrlsForChain: () => ['https://base-sepolia.publicnode.com', 'https://sepolia.base.org']` to `addSetupRoutes`, and change both `rpcUrl` assertions to arrays:

```typescript
    expect(body.rpcUrl).toEqual([
      'https://base-sepolia.gateway.tenderly.co/abc123',
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
    // ...
    expect(persisted.rpcUrl).toEqual([
      'https://base-sepolia.gateway.tenderly.co/abc123',
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
```

Leave `rejects a non-URL string` unchanged (still 400).

- [ ] **Step 2: Run to verify the new + edited tests fail**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn vitest run test/api/setup-endpoints.test.ts -t "/v1/setup/network"`
Expected: FAIL — the route still persists a single string, so array assertions fail.

- [ ] **Step 3: Add the `defaultRpcUrlsForChain` dep type**

In `client/src/api/setup-endpoints.ts`, next to `defaultRpcUrlForChain?: () => string;` (~105), add:

```typescript
  /** #913: returns the chain's bundled public RPC fallback chain. The network
   *  endpoint persists `[primary, ...defaults]` (or `[...defaults]` when the
   *  primary is cleared) so the operator never loses the public backup chain. */
  defaultRpcUrlsForChain?: () => readonly string[];
```

- [ ] **Step 4: Rewrite the persist body in the route**

In `client/src/api/setup-endpoints.ts`, replace the `let nextRpcUrl: string; ... persistConfigValue('rpcUrl', nextRpcUrl, cfgPath);` block (~780-812) with array assembly. The route body validation for the primary stays; only the assembled value changes:

```typescript
    const publicDefaults: readonly string[] =
      config.defaultRpcUrlsForChain?.() ??
      (config.defaultRpcUrlForChain
        ? [config.defaultRpcUrlForChain()]
        : ['https://base-sepolia.publicnode.com', 'https://sepolia.base.org']);

    let nextRpcUrls: string[];
    if (body.rpcUrl === null || body.rpcUrl === '') {
      nextRpcUrls = [...publicDefaults];
    } else if (typeof body.rpcUrl === 'string') {
      try {
        const parsed = new URL(body.rpcUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return c.json({ error: 'invalid_body', detail: '`rpcUrl` must use http or https' }, 400);
        }
      } catch {
        return c.json({ error: 'invalid_body', detail: '`rpcUrl` is not a valid URL' }, 400);
      }
      // De-dupe: if the operator pastes a URL that is already the first public
      // default, don't double it — the input drives a single Primary slot.
      nextRpcUrls = publicDefaults[0] === body.rpcUrl
        ? [...publicDefaults]
        : [body.rpcUrl, ...publicDefaults];
    } else {
      return c.json({ error: 'invalid_body', detail: '`rpcUrl` must be a string or null' }, 400);
    }

    try {
      persistConfigValue('rpcUrl', nextRpcUrls, cfgPath);
    } catch (err) {
      return c.json({
        error: 'config_write_failed',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    return c.json({
      ok: true,
      restartRequired: true,
      rpcUrl: nextRpcUrls,
    });
```

Note the response `rpcUrl` field is now an array. The SPA does not read this field's value (it re-polls `/v1/bootstrap`), so widening it is safe; update the client type in Task 5.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn vitest run test/api/setup-endpoints.test.ts -t "/v1/setup/network"`
Expected: PASS (all network cases, including the edited pre-existing ones).

- [ ] **Step 6: Typecheck**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" add client/src/api/setup-endpoints.ts client/test/api/setup-endpoints.test.ts
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" commit -m "feat(#913): persist RPC chain as [primary, ...publicDefaults]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire `defaultRpcUrlsForChain` into the daemon's setup deps

**Files:**
- Modify: `client/src/main.ts` (setup deps ~1290-1308)

- [ ] **Step 1: Pass the public-defaults provider to setup deps**

In `client/src/main.ts`, in the `setup: { ... }` object (next to `defaultRpcUrlForChain: () => CHAIN_CONFIG.rpcUrl,` ~1308), add:

```typescript
        defaultRpcUrlsForChain: () => RPC_PUBLIC_DEFAULTS,
```

(`RPC_PUBLIC_DEFAULTS` was defined in Task 1 Step 5.)

- [ ] **Step 2: Typecheck**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" add client/src/main.ts
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" commit -m "feat(#913): wire publicDefaults into setup network endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Extend SPA wire types (`BootstrapState` + `updateNetwork` response)

**Files:**
- Modify: `client/src/dashboard/spa/src/api/types.ts` (`BootstrapState` ~105-128)
- Modify: `client/src/dashboard/spa/src/api/client.ts` (`updateNetwork` ~205)

- [ ] **Step 1: Add the `RpcSlotHealth` type and extend `BootstrapState`**

In `client/src/dashboard/spa/src/api/types.ts`, immediately above `export interface BootstrapState {`, add:

```typescript
/** Per-slot boot-probe health for one RPC fallback slot (#913). Host masked. */
export interface RpcSlotHealth {
  ok: boolean;
  host: string;
  latencyMs?: number;
  /** HTTP status when the slot failed with one (e.g. 429, 503). */
  code?: number;
}
```

Then inside `BootstrapState`, after the existing `defaultRpcUrl?: string;` field (~128), add:

```typescript
  /** #913: the live ordered RPC fallback chain (slot 0 = head/primary). */
  rpcUrls?: string[];
  /** #913: the bundled public RPC chain for the current network. */
  publicDefaults?: string[];
  /** #913: boot-probe health per slot, index-aligned to `rpcUrls`. */
  rpcSlotHealth?: RpcSlotHealth[];
```

- [ ] **Step 2: Widen the `updateNetwork` response type**

In `client/src/dashboard/spa/src/api/client.ts`, change the `updateNetwork` return generic (~205-213) from `rpcUrl: string` to `rpcUrl: string | string[]` (body unchanged):

```typescript
  updateNetwork: (patch: { rpcUrl: string | null }) =>
    jfetch<{ ok: boolean; restartRequired: boolean; rpcUrl: string | string[] }>(
      '/v1/setup/network',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ),
```

- [ ] **Step 3: Typecheck the SPA**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn typecheck`
Expected: zero errors. (NetworkTab.tsx still uses its local `BootstrapWithChain` interface, so no SPA component breaks yet.)

- [ ] **Step 4: Commit**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" add client/src/dashboard/spa/src/api/types.ts client/src/dashboard/spa/src/api/client.ts
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" commit -m "feat(#913): SPA wire types for rpc chain + slot health

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: SPA test — read-only slot list with per-slot health (TDD, AC1 + AC4)

**Files:**
- Test: `client/src/dashboard/spa/src/pages/operator/NetworkTab.test.tsx`

- [ ] **Step 1: Update the shared `getBootstrap` mock to carry the new fields**

In `client/src/dashboard/spa/src/pages/operator/NetworkTab.test.tsx`, change the `getBootstrap` mock (~11-15) to return the chain shape:

```typescript
    getBootstrap: vi.fn(async () => ({
      chain: 'base-sepolia',
      rpcUrl: 'https://my-alchemy.example/key',
      defaultRpcUrl: 'https://base-sepolia.publicnode.com',
      rpcUrls: [
        'https://my-alchemy.example/key',
        'https://base-sepolia.publicnode.com',
        'https://sepolia.base.org',
      ],
      publicDefaults: [
        'https://base-sepolia.publicnode.com',
        'https://sepolia.base.org',
      ],
      rpcSlotHealth: [
        { ok: true, host: 'my-alchemy.example', latencyMs: 12 },
        { ok: true, host: 'base-sepolia.publicnode.com', latencyMs: 40 },
        { ok: false, host: 'sepolia.base.org', code: 429 },
      ],
    })),
```

- [ ] **Step 2: Write the failing tests**

Replace the existing `describe('NetworkTab', ...)` block's third test (`renders the chain locked chip + RPC URL input`) keeping the first two, and add new cases. The whole `describe('NetworkTab', ...)` becomes:

```typescript
describe('NetworkTab', () => {
  it('renders the network-tab container', () => {
    render(withProviders(<NetworkTab />));
    expect(screen.getByTestId('network-tab')).toBeTruthy();
  });

  it('renders the Network section heading', () => {
    render(withProviders(<NetworkTab />));
    const heading = screen.getByRole('heading', { name: /^network$/i });
    expect(heading).toBeTruthy();
  });

  it('renders the chain locked chip', async () => {
    render(withProviders(<NetworkTab />));
    await waitFor(() => expect(screen.getByText(/locked/i)).toBeTruthy());
  });

  it('renders one ordered read-only row per slot with masked host + health (AC1/AC4)', async () => {
    render(withProviders(<NetworkTab />));
    const list = await screen.findByTestId('network-rpc-slots');
    const rows = list.querySelectorAll('[data-testid="network-rpc-slot"]');
    expect(rows).toHaveLength(3);
    // Ordered by slot index; hosts are masked (no path / key segment).
    expect(rows[0]!.textContent).toMatch(/my-alchemy\.example/);
    expect(rows[0]!.textContent).not.toMatch(/\/key/);
    expect(rows[1]!.textContent).toMatch(/base-sepolia\.publicnode\.com/);
    expect(rows[2]!.textContent).toMatch(/sepolia\.base\.org/);
    // The 429 slot renders a degraded badge.
    expect(rows[2]!.textContent).toMatch(/429|unhealthy|degraded/i);
  });

  it('shows the Primary RPC input prefilled with the current primary (AC2)', async () => {
    render(withProviders(<NetworkTab />));
    const input = await screen.findByLabelText(/primary rpc/i);
    expect((input as HTMLInputElement).value).toBe('https://my-alchemy.example/key');
  });

  it('renders the "tried first — falls back to public chain on failure" copy (AC4)', async () => {
    render(withProviders(<NetworkTab />));
    await waitFor(() =>
      expect(screen.getByTestId('network-tab').textContent).toMatch(
        /tried first.*falls back to public chain on failure/i,
      ),
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn vitest run src/dashboard/spa/src/pages/operator/NetworkTab.test.tsx`
Expected: FAIL — `network-rpc-slots`, `/primary rpc/i` label, and the "tried first" copy do not exist yet.

- [ ] **Step 4: Commit the failing test**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" add client/src/dashboard/spa/src/pages/operator/NetworkTab.test.tsx
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" commit -m "test(#913): network slot list + primary rpc UI (red)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Rewrite `NetworkSectionContent` — slot list + Primary RPC input (AC1–AC4)

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/operator/NetworkTab.tsx` (lines 26-333; `TaskPostsCard` untouched)

- [ ] **Step 1: Replace the local bootstrap shape + `NetworkTab` wiring**

In `client/src/dashboard/spa/src/pages/operator/NetworkTab.tsx`, replace the `BootstrapWithChain` interface (~26-30) and the `NetworkTab` body's chain/rpc derivation + `NetworkSectionContent` props (~36-65) with:

```typescript
import type { RpcSlotHealth } from '../../api/types.js';

interface BootstrapWithChain {
  chain?: 'base' | 'base-sepolia';
  rpcUrls?: string[];
  publicDefaults?: string[];
  rpcSlotHealth?: RpcSlotHealth[];
}

export interface NetworkTabProps {
  onRestartPending?: () => void;
}

export function NetworkTab({
  onRestartPending = () => undefined,
}: NetworkTabProps = {}): JSX.Element {
  const { data } = useQuery<BootstrapWithChain>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap() as Promise<BootstrapWithChain>,
    refetchInterval: 1500,
  });

  const chain = data?.chain ?? 'base-sepolia';
  const publicDefaults = data?.publicDefaults ?? [];
  const rpcUrls =
    data?.rpcUrls ?? (publicDefaults.length > 0 ? publicDefaults : []);
  const slotHealth = data?.rpcSlotHealth ?? [];

  return (
    <div data-testid="network-tab" className="flex flex-col gap-4">
      <NetworkSectionContent
        chain={chain}
        rpcUrls={rpcUrls}
        publicDefaults={publicDefaults}
        slotHealth={slotHealth}
        onRestartPending={onRestartPending}
      />
      <TaskPostsCard />
    </div>
  );
}
```

Keep the `import { ... } from '../../api/types.js'` near the other imports at the top of the file (move it up if the inline placement above causes a lint error — imports must be top-level).

- [ ] **Step 2: Replace `NetworkSectionContentProps` and `NetworkSectionContent`**

Replace the entire `interface NetworkSectionContentProps { ... }` and `function NetworkSectionContent(...) { ... }` block (~164-333) with:

```typescript
interface NetworkSectionContentProps {
  chain: 'base' | 'base-sepolia';
  rpcUrls: string[];
  publicDefaults: string[];
  slotHealth: RpcSlotHealth[];
  onRestartPending: () => void;
}

/** Mask an RPC URL to its hostname so paths / api-key segments never render. */
function maskHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** True when slot 0 is operator-provided (i.e. not the first public default). */
function hasPrimary(rpcUrls: string[], publicDefaults: string[]): boolean {
  if (rpcUrls.length === 0) return false;
  return rpcUrls[0] !== publicDefaults[0];
}

function SlotHealthBadge({ health }: { health?: RpcSlotHealth }): JSX.Element {
  if (!health) {
    return <Badge variant="outline">unknown</Badge>;
  }
  if (health.ok) {
    return (
      <Badge variant="success">
        healthy{health.latencyMs !== undefined ? ` · ${health.latencyMs}ms` : ''}
      </Badge>
    );
  }
  return (
    <Badge variant={health.code === 429 ? 'warning' : 'destructive'}>
      {health.code !== undefined ? `degraded · ${health.code}` : 'unreachable'}
    </Badge>
  );
}

function NetworkSectionContent({
  chain,
  rpcUrls,
  publicDefaults,
  slotHealth,
  onRestartPending,
}: NetworkSectionContentProps): JSX.Element {
  const primaryConfigured = hasPrimary(rpcUrls, publicDefaults);
  const currentPrimary = primaryConfigured ? rpcUrls[0]! : '';
  const [draft, setDraft] = useState(currentPrimary);
  const [saving, setSaving] = useState(false);

  const dirty = draft.trim() !== currentPrimary;
  const chainLabel =
    chain === 'base' ? 'Base mainnet (chain id 8453)' : 'Base Sepolia (chain id 84532)';
  const chainShort = chainLabel.split(' (')[0];

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = draft.trim().length === 0 ? null : draft.trim();
      const res = await api.updateNetwork({ rpcUrl: next });
      toast.success(next ? 'Primary RPC saved' : 'Primary RPC cleared', {
        description: res.restartRequired
          ? 'Restart pending — applies on next daemon start.'
          : 'Applied to the running daemon.',
      });
      if (res.restartRequired) onRestartPending();
    } catch (err) {
      toast.error('Failed to save Primary RPC', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <Network className="h-3.5 w-3.5" aria-hidden="true" />
            Network
          </CardTitle>
          <CardDescription>
            {chainShort} · {rpcUrls.length} RPC slot{rpcUrls.length === 1 ? '' : 's'}
          </CardDescription>
        </div>
        <Badge variant="outline">locked</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Chain (read-only) */}
        <div className="flex flex-col gap-2">
          <Label>Chain</Label>
          <div className="rounded-md border border-border bg-[var(--bg-sunken)] px-3 py-2 font-mono text-[13px] text-muted-foreground">
            {chainLabel}
          </div>
          <p className="font-mono text-[11px] text-[var(--fg-dim)]">
            Switching chains resets fleet state — that's a separate flow.
          </p>
        </div>

        {/* Primary RPC slot (editable) */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="primary-rpc">Primary RPC</Label>
            {dirty && <Badge variant="warning">Restart</Badge>}
          </div>
          <Input
            id="primary-rpc"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://your-key.example (optional)"
            className={dirty ? 'border-primary' : undefined}
          />
          <p className="font-mono text-[11px] text-[var(--fg-dim)]">
            Tried first — falls back to public chain on failure.
          </p>
          {!primaryConfigured && (
            <p className="font-mono text-[11px] text-[var(--fg-dim)]">
              You're on the shared public chain — fine for setup, not reliable
              under load. Get your own free key from{' '}
              <a
                href="https://dashboard.tenderly.co/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                Tenderly <ExternalLink className="h-2.5 w-2.5" />
              </a>
              ,{' '}
              <a
                href="https://www.alchemy.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                Alchemy <ExternalLink className="h-2.5 w-2.5" />
              </a>
              , or{' '}
              <a
                href="https://www.quicknode.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                QuickNode <ExternalLink className="h-2.5 w-2.5" />
              </a>{' '}
              and paste it above.
            </p>
          )}
          {dirty && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setDraft(currentPrimary)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                type="button"
                disabled={saving}
                onClick={() => {
                  void save();
                }}
              >
                {saving ? 'Saving…' : currentPrimary && draft.trim().length === 0 ? 'Clear' : 'Save'}
              </Button>
            </div>
          )}
        </div>

        {/* Full fallback chain (read-only, ordered) */}
        <div className="flex flex-col gap-2">
          <Label>RPC fallback chain</Label>
          <div
            data-testid="network-rpc-slots"
            className="flex flex-col divide-y divide-border rounded-md border border-border"
          >
            {rpcUrls.map((url, i) => (
              <div
                key={`${i}-${url}`}
                data-testid="network-rpc-slot"
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-[11px] text-[var(--fg-dim)]">
                    slot {i}
                  </span>
                  <span className="truncate font-mono text-[12px] text-foreground">
                    {maskHost(url)}
                  </span>
                </div>
                <SlotHealthBadge health={slotHealth[i]} />
              </div>
            ))}
          </div>
          <p className="font-mono text-[11px] text-[var(--fg-dim)]">
            Primary → public backups, in order. Health from the last boot probe.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Remove now-unused imports**

The rewritten section no longer uses the `Alert`, `AlertDescription`, `AlertTitle` components inside `NetworkSectionContent`, but `TaskPostsCard` still imports and uses `Alert*` and `AlertTriangle`. Verify with the typecheck below; do not remove imports that `TaskPostsCard` still needs (`Alert`, `AlertDescription`, `AlertTitle`, `AlertTriangle`, `Activity`). The `Activity` icon and `Alert*` stay. Only remove an import if `yarn typecheck` reports it as unused under `noUnusedLocals`.

- [ ] **Step 4: Run the SPA test to verify it passes**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn vitest run src/dashboard/spa/src/pages/operator/NetworkTab.test.tsx`
Expected: PASS (all `NetworkTab` + `Task posts panel` cases green).

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" add client/src/dashboard/spa/src/pages/operator/NetworkTab.tsx
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" commit -m "feat(#913): Settings → Network renders full RPC chain + Primary RPC input

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Update `client/OPERATOR-APP-SPEC.md` §2.11 Network domain model (AC5)

**Files:**
- Modify: `client/OPERATOR-APP-SPEC.md` (§2.11, ~313-335)

- [ ] **Step 1: Update §2.11 to declare the Network component along all four axes**

The four-axis domain model must enumerate: **State** (current chain + slot-list + per-slot health), **State messages** (Primary RPC missing / unhealthy), **Collections** (the slot list), and **Actions** (Set Primary, Clear Primary).

In `client/OPERATOR-APP-SPEC.md`, within §2.11, after the existing task-posts **State** bullet, add a Network State bullet and revise the RPC entry. Insert under the `- **State** (read-only)` group a sub-bullet:

```markdown
  - current chain — read-only chain identity (`base` chain id 8453 / `base-sepolia` chain id 84532). Switching chains is a separate fleet-reset flow, not editable here.
  - RPC fallback chain — the live ordered `rpcUrls` chain (slot 0 = primary/head). Each slot renders **slot index + masked host + per-slot health**. Health comes from the boot-time `probeFallbackChain` probe (`rpcSlotHealth`, index-aligned to `rpcUrls`): `healthy` (+ latency) / `degraded · <http-status>` (e.g. 429) / `unreachable`. The probe is boot-time only — the RPC chain is restart-required, so health cannot drift without a re-probing restart. Hosts are masked (path + api-key query strings never render); only hostnames appear.
```

Add a **Collections** group (the spec's four-axis model requires it; §2.11 currently lists State / Static / Actions / State messages — add Collections explicitly):

```markdown
- **Collections**
  - RPC slots — the ordered `rpcUrls` chain. Item shape: `{ slot: number; host: string (masked); health: 'healthy' | 'degraded' | 'unreachable'; latencyMs?: number; code?: number }`. Ordering: by slot index (0 = primary). No pagination (capped at 4 slots). Read-only.
```

Revise the RPC entry under **Actions** to name the two operator verbs, replacing the generic `edit setting` / `reset to default` for the Network/RPC case:

```markdown
  - Set Primary — write a single Primary RPC URL via the labeled input. Prepends to the runtime chain: persisted shape becomes `[primary, ...publicDefaults]`. Lifecycle: `idle → saving → saved (restart pending)`; terminal `failed` on write error. Restart-required to apply.
  - Clear Primary — clear the Primary RPC input. Persisted shape reverts to `[...publicDefaults]` (the bundled public backup chain). Same lifecycle and restart semantics as Set Primary.
```

Add two **State messages** entries (alongside the existing RPC fallback / degraded / all-failed taxonomy):

```markdown
  - Primary RPC missing — informational: no operator-provided primary is configured; the node is on the shared public chain (fine for setup, not reliable under load). Maps to the optional Set Primary action; links to free-key providers.
  - Primary RPC unhealthy — the boot probe saw slot 0 fail (HTTP 429 / 5xx / unreachable). Informational; a secondary slot served. Operators with a paid primary may want to inspect the key's quota; no forced action.
```

Keep the existing restart-required note (`The RPC chain is **restart-required**`) and the `discovery.fallbackToOnchain` distinction paragraph.

- [ ] **Step 2: Sanity-check the spec edit**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" && grep -n "Set Primary\|Clear Primary\|RPC slots\|Primary RPC missing\|Primary RPC unhealthy" client/OPERATOR-APP-SPEC.md`
Expected: each phrase appears once.

- [ ] **Step 3: Commit**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" add client/OPERATOR-APP-SPEC.md
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" commit -m "docs(#913): spec §2.11 Network — chain slot-list, health, Set/Clear Primary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full-suite verification + build

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole client**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn typecheck`
Expected: zero errors.

- [ ] **Step 2: Run the touched test files**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn vitest run \
  test/api/bootstrap-endpoint.test.ts \
  test/api/setup-endpoints.test.ts \
  src/dashboard/spa/src/pages/operator/NetworkTab.test.tsx
```
Expected: all PASS.

- [ ] **Step 3: Run the full vitest suite (catch collateral breakage)**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn test`
Expected: all PASS. If a `spa-config.e2e` or dashboard e2e test asserts the old single-string `rpcUrl` on `/v1/bootstrap`, update it to the array shape — search: `grep -rn "defaultRpcUrl\|rpcUrl" test/dashboard/`.

- [ ] **Step 4: Build (compiles tsc + bundles SPA)**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913/client" && yarn build`
Expected: clean build, dashboard bundle emitted.

- [ ] **Step 5: Final commit if any e2e fixes were needed**

```bash
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" add -A
git -C "/Users/adrianobradley/life's-work/jinn-mono_worktrees/913" commit -m "test(#913): align e2e fixtures with array rpc persist shape

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:**
- AC1 (full ordered read-only chain, slot + URL + chain-id health) — Task 1 surfaces `rpcUrls` + `rpcSlotHealth`; Task 7 renders `network-rpc-slots` ordered by index with masked host + `SlotHealthBadge`; Task 6 asserts it. Covered. (Note: per the Stage-1 design note, "chain-id health" is the boot-probe `eth_blockNumber` reachability/latency/HTTP-status signal, which is what the shipped probe provides; `checkRpcNetwork` already fail-loud gates chain-id mismatch at the head URL before boot.)
- AC2 (add a single Primary RPC that prepends) — Task 3 assembles `[primary, ...publicDefaults]`; Task 7 renders the labeled `Primary RPC` input; Tasks 3 + 6 assert. Covered.
- AC3 (persisted `[primary, ...publicDefaults]` on save, `[...publicDefaults]` on clear) — Task 3 Steps 1+4; backend tests assert both shapes. Covered.
- AC4 ("tried first — falls back to public chain on failure" copy + per-slot health) — Task 7 renders the exact copy + `SlotHealthBadge`; Task 6 asserts the copy and the 429 badge. Covered.
- AC5 (spec §2.11 State / State messages / Collections / Actions) — Task 8. Covered.

**Placeholder scan:** No TBD / "add error handling" / "write tests for the above" / "similar to Task N". Every code step carries the literal code.

**Type consistency:**
- `RpcSlotHealth` (SPA, `types.ts`) ↔ `RpcSlotHealthEntry` (daemon, `bootstrap-endpoint.ts`) — same field set (`ok`, `host`, `latencyMs?`, `code?`); the JSON wire shape is identical so the two names describe one contract. The daemon maps `ProbeResult` (which also has `message`/`reason`) down to this set in Task 1 Step 5.
- `rpcUrls` / `publicDefaults` / `rpcSlotHealth` field names are identical across `main.ts` configReader, `bootstrap-endpoint.ts` type + spread, `types.ts` `BootstrapState`, and `NetworkTab.tsx` consumption.
- `defaultRpcUrlsForChain` (plural) is the new dep; `defaultRpcUrlForChain` (singular) is retained as a fallback inside the route — both referenced consistently in Task 3 Step 4 and Task 4.
- `updateNetwork` body stays `{ rpcUrl: string | null }`; response widened to `rpcUrl: string | string[]` in Task 5; the SPA never reads the response value, only `restartRequired`.

No gaps found.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-14-913-network-rpc-fallback-ui.md`. Recommended execution: subagent-driven (fresh subagent per task, review between tasks). Backend (Tasks 1–4) lands before SPA (Tasks 5–7); spec (Task 8) last; full verification (Task 9) closes out.
