# Issue #114 — Owned Launched Manifest Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GET /v1/solvernets/registry/:cid` serve the owner's locally-cached manifest for just-launched and registry-error scenarios so the launched dashboard renders real fields instead of placeholders.

**Architecture:** Broaden the existing owned-record fallback in `client/src/api/solvernets-endpoints.ts` along two axes — (1) `localLifecycleForRecord` synthesises a lifecycle when `metadataBlockNumber` is missing (the `launching`/`failed` window), (2) the `/registry/:cid` handler re-tries the owned-cache lookup if the wired registry client throws. The hash-verified read inside `tryGetOwnedCachedManifest` is unchanged — verification semantics for non-owned SolverNets stay intact.

**Tech Stack:** Hono (Node), Vitest, React + React Query (SPA).

**Out of scope:** `client/src/solvernets/launch-state-machine.ts` and `client/src/solvernets/store.ts` are NOT modified — `writeManifestCache` already persists at the `recording` phase. No new disk persistence, no schema changes. No SPA source change — only an additional SPA test.

---

### Task 1: Flip the existing "before lifecycle anchored" parametric test to assert the new behaviour (regression-first)

**Files:**
- Modify: `client/test/api/solvernets-endpoints.test.ts:2307-2340`

- [ ] **Step 1: Rewrite the existing `it.each(['launching', 'failed'])` block to expect 200 + manifest body + synthetic lifecycle**

Replace the block at `client/test/api/solvernets-endpoints.test.ts:2307-2340` with:

```ts
  it.each(['launching', 'failed'] as const)(
    'serves an owned cached %s manifest before the lifecycle is anchored (issue #114)',
    async (status) => {
      const cid = `bafyowned${status}prebroadcast1234567890`;
      const solverNetId = `owned-${status}-prebroadcast`;
      const manifest = makeManifest({ solverNetId, manifestCid: cid });
      const manifestPath = await store.writeManifestCache(cid, manifest);
      await store.writeRecord({
        ...makeOwnedRecord({ solverNetId, status }),
        manifestCid: cid,
        manifestHash: manifestHash(manifest),
        manifestPath,
        registry: {},
        launchProgress: {
          phase: 'broadcasting',
          attemptCount: status === 'failed' ? 3 : 0,
          ...(status === 'failed'
            ? { txError: { message: 'setMetadata failed', at: '2026-05-06T00:00:00.000Z' } }
            : {}),
        },
      });

      const { app } = buildTestApp({ store });

      const res = await app.request(`/v1/solvernets/registry/${cid}`, {
        method: 'GET',
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        manifest: SolverNetManifestV1;
        lifecycle: { status: string; statusUpdatedAt: string; sourceBlock: number };
      };
      expect(body.manifest.solverNetId).toBe(solverNetId);
      // No on-chain anchor yet — synthesise a `launched` lifecycle so the SPA
      // can render real manifest fields. The record-level `status` (carried
      // separately in the record query) still shows the `launching`/`failed` pill.
      expect(body.lifecycle.status).toBe('launched');
      expect(body.lifecycle.sourceBlock).toBe(0);
      expect(typeof body.lifecycle.statusUpdatedAt).toBe('string');
    },
  );
```

- [ ] **Step 2: Run the flipped test and confirm it fails against current source**

Run: `cd client && yarn vitest run test/api/solvernets-endpoints.test.ts -t "before the lifecycle is anchored"`
Expected: 2 failing cases (launching, failed) — current handler returns 503 / `registry_unavailable`.

- [ ] **Step 3: Commit the regression test only**

```bash
git add client/test/api/solvernets-endpoints.test.ts
git commit -m "test(api): assert owned cached manifest is served before lifecycle anchored (#114)"
```

Maps to acceptance criterion: *Add an API test covering the no-subgraph owned-record path.*

---

### Task 2: Synthesise a lifecycle for owned records lacking `metadataBlockNumber`

**Files:**
- Modify: `client/src/api/solvernets-endpoints.ts:653-668`

- [ ] **Step 1: Replace `localLifecycleForRecord` so it never returns null**

Replace the function at `client/src/api/solvernets-endpoints.ts:653-668` with:

```ts
function localLifecycleForRecord(record: LaunchedSolverNetRecord): {
  status: 'launched' | 'paused' | 'retired';
  statusUpdatedAt: string;
  sourceBlock: number;
} {
  // For records whose lifecycle has not yet been anchored on chain
  // (status === 'launching' or 'failed' — `metadataBlockNumber` undefined),
  // synthesise a `launched` display-lifecycle with `sourceBlock: 0`. The
  // manifest body IS real (hash-verified by `tryGetOwnedCachedManifest`),
  // so the launched dashboard can render names + prices instead of
  // placeholders. The record-level `status` field (queried separately by
  // the SPA via `/v1/solvernets/launched/:id`) continues to carry the
  // `launching`/`failed` signal for the status pill.
  const sourceBlock = record.registry.metadataBlockNumber ?? 0;
  return {
    status:
      record.status === 'paused' || record.status === 'retired'
        ? record.status
        : 'launched',
    statusUpdatedAt: record.statusUpdatedAt,
    sourceBlock,
  };
}
```

- [ ] **Step 2: Update the caller at `client/src/api/solvernets-endpoints.ts:1567-1575` to drop the null branch**

Replace lines 1567-1575 with:

```ts
    if (ownedCached) {
      return c.json({
        manifest: ownedCached.manifest,
        lifecycle: localLifecycleForRecord(ownedCached.record),
      });
    }
```

- [ ] **Step 3: Run the flipped test and confirm it now passes**

Run: `cd client && yarn vitest run test/api/solvernets-endpoints.test.ts -t "before the lifecycle is anchored"`
Expected: 2 passing.

- [ ] **Step 4: Run the full registry-endpoint describe block to confirm hash-mismatch + happy-path + 404 paths still work**

Run: `cd client && yarn vitest run test/api/solvernets-endpoints.test.ts -t "GET /v1/solvernets/registry/:cid"`
Expected: all tests pass, including the hash-mismatch test at line 2281 (verification semantics preserved).

- [ ] **Step 5: Commit**

```bash
git add client/src/api/solvernets-endpoints.ts
git commit -m "fix(api): serve owned cached manifest for launching/failed records (#114)"
```

Maps to acceptance criteria: *A just-launched owned SolverNet dashboard displays manifest details when no subgraph / registry client is configured* and *The fix does not weaken registry verification for non-owned SolverNets.*

---

### Task 3: Re-fall-back to the owned cache when the wired registry client throws

**Files:**
- Modify: `client/src/api/solvernets-endpoints.ts:1599-1632`
- Modify: `client/test/api/solvernets-endpoints.test.ts` (add new test after the existing `'returns 404 when the lifecycle lookup throws'` test, around line 2409)

- [ ] **Step 1: Add a failing test for "registry wired but throws → falls back to owned cache"**

Insert after line 2409 in `client/test/api/solvernets-endpoints.test.ts`:

```ts
  it('falls back to owned cached manifest when the registry client throws (issue #114)', async () => {
    const cid = 'bafyownedregistrythrows1234567890';
    const manifest = makeManifest({
      solverNetId: 'owned-registry-throws',
      manifestCid: cid,
    });
    const manifestPath = await store.writeManifestCache(cid, manifest);
    await store.writeRecord({
      ...makeOwnedRecord({ solverNetId: 'owned-registry-throws', status: 'launching' }),
      manifestCid: cid,
      manifestHash: manifestHash(manifest),
      manifestPath,
      registry: {},
    });

    // Registry IS wired but every call throws — simulates Anvil/local dev
    // where the Ponder indexer is unreachable but the operator owns the
    // record + has the manifest in the local cache.
    const registry = makeMockRegistryGet({
      getManifestError: new Error('subgraph unreachable'),
    });
    const { app } = buildTestApp({ store, registry });

    const res = await app.request(`/v1/solvernets/registry/${cid}`, {
      method: 'GET',
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: SolverNetManifestV1;
      lifecycle: { status: string; sourceBlock: number };
    };
    expect(body.manifest.solverNetId).toBe('owned-registry-throws');
    expect(body.lifecycle.status).toBe('launched');
    expect(body.lifecycle.sourceBlock).toBe(0);
  });
```

Note: the existing "ignores an owned cached manifest whose canonical hash does not match" test (line 2281) does not pre-stage an `ownedCached` hit because the hash mismatch causes `tryGetOwnedCachedManifest` to return null — the re-fallback added below will likewise miss for it, so 503 (no registry configured) remains the correct outcome. No test edit required there.

- [ ] **Step 2: Run the new test and confirm it fails**

Run: `cd client && yarn vitest run test/api/solvernets-endpoints.test.ts -t "falls back to owned cached manifest when the registry client throws"`
Expected: FAIL — current handler returns 404 `manifest_not_found`.

- [ ] **Step 3: Modify the `registry.getManifest` catch block to re-attempt the owned cache before returning 404**

Replace `client/src/api/solvernets-endpoints.ts:1599-1610` with:

```ts
    let manifest: SolverNetManifestV1;
    try {
      manifest = await registry.getManifest({ manifestCid: cid });
    } catch (err) {
      // Registry is wired but unreachable (e.g. Anvil/local dev, Ponder
      // subgraph down). If the operator owns this manifest and the local
      // cache has a hash-verified copy, serve it with a synthesised
      // lifecycle so the launched dashboard does not render placeholders.
      // The hash check inside tryGetOwnedCachedManifest is unchanged —
      // non-owned manifests still fall through to the 404 path.
      if (ownedCached) {
        return c.json({
          manifest: ownedCached.manifest,
          lifecycle: localLifecycleForRecord(ownedCached.record),
        });
      }
      return c.json(
        {
          error: 'manifest_not_found',
          message: err instanceof Error ? err.message : String(err),
        },
        404,
      );
    }
```

- [ ] **Step 4: Modify the `registry.getLifecycleStatus` catch block to apply the same re-fallback**

Replace `client/src/api/solvernets-endpoints.ts:1617-1632` with:

```ts
    let lifecycle: {
      status: 'launched' | 'paused' | 'retired';
      statusUpdatedAt: string;
      sourceBlock: number;
    };
    try {
      lifecycle = await registry.getLifecycleStatus({ manifestCid: cid });
    } catch (err) {
      // Manifest body resolved on IPFS but lifecycle events lookup failed.
      // Same re-fallback rule as above: prefer the owned cache's
      // synthesised lifecycle over a 404 when the operator owns the record.
      if (ownedCached) {
        return c.json({
          manifest: ownedCached.manifest,
          lifecycle: localLifecycleForRecord(ownedCached.record),
        });
      }
      return c.json(
        {
          error: 'manifest_not_found',
          message: err instanceof Error ? err.message : String(err),
        },
        404,
      );
    }
```

- [ ] **Step 5: Run the new test and confirm it passes; run the full registry describe block to confirm no regressions**

Run: `cd client && yarn vitest run test/api/solvernets-endpoints.test.ts -t "GET /v1/solvernets/registry/:cid"`
Expected: all tests pass, including hash-mismatch (line 2281), happy-path (line 2342), registry-throws→404 for non-owned (line 2376), lifecycle-throws→404 (line 2393).

- [ ] **Step 6: Commit**

```bash
git add client/src/api/solvernets-endpoints.ts client/test/api/solvernets-endpoints.test.ts
git commit -m "fix(api): re-fall-back to owned cache when registry client throws (#114)"
```

Maps to acceptance criterion: *A just-launched owned SolverNet dashboard displays manifest details* (covers the registry-wired-but-unreachable variant).

---

### Task 4: SPA test — launched dashboard renders manifest fields for an owned launching-status record

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/LauncherLaunched.test.tsx` (append new `it` inside the existing `describe('LauncherLaunchedPage', …)` block — after the existing "renders all four panels" test around line 197)

- [ ] **Step 1: Add the SPA test**

Insert after the `it('renders all four panels when record + manifest load successfully', …)` block (ends near line 197):

```tsx
  it('renders manifest fields (not placeholders) for an owned launching record (issue #114)', async () => {
    // Simulates the just-launched window: record.status === 'launching',
    // registry.metadataBlockNumber undefined. The API now serves the
    // hash-verified owned manifest with a synthesised launched lifecycle
    // (sourceBlock: 0), so name + prices render instead of placeholders.
    vi.mocked(api.solvernets.get).mockResolvedValue(
      buildRecord({ status: 'launching', registry: {} }),
    );
    vi.mocked(api.solvernets.getManifest).mockResolvedValue({
      manifest: buildManifest({ name: 'Polymarket' }),
      lifecycle: {
        status: 'launched',
        statusUpdatedAt: '2026-05-05T15:00:00Z',
        sourceBlock: 0,
      },
    });
    wrap(<LauncherLaunchedPage solverNetId="sn-1" pollIntervalMs={1000} />);

    await waitFor(() =>
      expect(screen.getByTestId('launcher-launched-name').textContent).toBe('Polymarket'),
    );
    // Spend panel should render — i.e. it did not bail on a missing manifest.
    expect(screen.getByTestId('launcher-launched-spend-panel')).toBeTruthy();
    // No placeholder fallbacks visible.
    expect(screen.queryByText(/unnamed/i)).toBeNull();
    expect(screen.queryByText(/missing price/i)).toBeNull();
  });
```

- [ ] **Step 2: Run the SPA test**

Run: `cd client && yarn vitest run src/dashboard/spa/src/pages/LauncherLaunched.test.tsx -t "owned launching record"`
Expected: PASS (no SPA source change required — the manifestQuery resolves via the now-broadened API).

- [ ] **Step 3: Commit**

```bash
git add client/src/dashboard/spa/src/pages/LauncherLaunched.test.tsx
git commit -m "test(spa): assert launched dashboard renders manifest fields for owned launching record (#114)"
```

Maps to acceptance criterion: *Add or update a SPA test so the launched dashboard does not render unnamed / missing-price placeholders for an owned launched record.*

---

### Verification

Run from `/Users/adrianobradley/life's-work/jinn-mono_worktrees/114/client/`:

```bash
# 1. Affected files first (fast feedback)
yarn vitest run test/api/solvernets-endpoints.test.ts -t "GET /v1/solvernets/registry/:cid"
yarn vitest run src/dashboard/spa/src/pages/LauncherLaunched.test.tsx

# 2. Typecheck (zero errors expected)
yarn typecheck

# 3. Full client suite
yarn test
```

All three steps must pass before opening / requesting review on the PR. The contracts package is untouched and does not need to be re-run.
