# SolverNet Catalog Indexer Enrichment (Issue #985, PR 1/N) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daemon's launched-SolverNet catalog list fully from indexer-enriched GraphQL fields with zero per-CID IPFS fetches on the hot path, survive an IPFS-gateway outage, and use the indexed `chainId` for chain scoping.

**Architecture:** Strangler-fig refactor, first stacked PR. The Ponder indexer gains 7 additive columns on `solverNetManifest` and writes them during its existing IPFS enrichment pass (criterion 1). The daemon's `HttpDiscoveryAPI` selects the new columns and projects them straight into the catalog summary (guarded on `manifestEnrichmentStatus === 'ok'`), with a defensive degrade to the old per-CID IPFS path when the query fails validation against an old indexer (criterion 2). The registry client's `listLaunched` stops fetching IPFS in the list path and filters on `chainId` instead of `manifest.network` (criterion 2). An integration test proves the catalog populates during an IPFS outage and never calls `ipfs.fetch` on the list path (criterion 4). Criterion 3 (staking state) is explicitly out of scope for this PR.

**Tech Stack:** TypeScript, Ponder 0.16.x (Drizzle-style schema + GraphQL codegen), Zod manifest schema, Vitest.

---

## Background facts (verified against the worktree — do not re-derive)

- **Manifest field sources** (`packages/sdk/src/solvernets/manifest-schema.ts`, `SolverNetManifestV1Schema` lines 110-130): top-level `network` (line 113, enum `'base-sepolia' | 'base'`), `name` (114), `description` (115), `solverNetId` (112), `solutionPriceWei` (120), `verdictPriceWei` (121), `openRoles` (122, `Array<'solver'|'evaluator'>`, `.min(1)`); nested `launcher.safeAddress` (`LauncherZ` line 94); nested `contract.id` (75-76 inside `ContractZ`) and `contract.version` (77).
- **`SolverNetManifestSummary`** is defined in `client/src/solvernets/registry-client.ts:67-82`. It currently has NO `chainId` field. This plan ADDS `chainId: number` to it (Task 3) because the new chain-scope filter compares `row.chainId`.
- **Indexer schema** `solverNetManifest` table: `packages/indexer/ponder.schema.ts:250-306`. Existing enriched columns `name`/`description`/`solverNetId` at 294-296; `manifestEnrichmentStatus` at 298; `chainId` at 285. Additive-column policy: lines 22-25 — additive columns do NOT bump schema version / force re-sync.
- **Indexer enrichment** lives in `packages/indexer/src/handlers.ts`: `SolverNetManifestLite` interface 531-535; `parseSolverNetManifestLite` 537-550; `safeStr` helper 570-572; the enrichment success/`.set({...})` branch 921-948 (success `.set` at 931-936). Array-column precedent: `pluginPublication.supports` (`t.text().array().notNull()`) at `ponder.schema.ts:416`.
- **Daemon read** `client/src/discovery/http.ts`: `LIST_SOLVER_NETS_QUERY` 137-156 (already selects `chainId`); `SolverNetRow` interface 386-394 (has `chainId: number`); the `.map()` projection in `listLaunchedSolverNets` 914-933 (sentinels at 919-927). The degrade-on-old-indexer precedent is `getPluginScores`' catch at 1147-1153 (`/Unknown type|Cannot query/`).
- **Registry client** `client/src/solvernets/registry-client-erc8004.ts`: `listLaunched` 336-394; the per-row IPFS fetch at 358-367; the network filter at 373 (`if (manifest.network !== args.network) continue`); the projection at 375-390. `this.network` is `'base-sepolia' | 'base'` (190, set at 222). `getManifest` (hash-verified detail path) at 396+ is left intact.
- **Production caller** `client/src/solvernets/daemon-init.ts:419` calls `registryClient.listLaunched({ network: config.network })`.
- **The on-chain floor** `client/src/discovery/onchain.ts:909-960` (`listLaunchedSolverNets`) also returns `SolverNetManifestSummary[]`; it has `opts.chainId` in scope (used widely, e.g. 1130). Adding `chainId` to the summary forces a one-line addition here too. chainId helper `chainForId` exists at onchain.ts:167-169 (`84532 → baseSepolia`).
- **Tests** `client/test/solvernets/registry-client-erc8004.test.ts`: `makeMockIpfs` 156-194 (`fetch` at 184-189; exposes `fetchCalls`); `makeMockDiscoveryApi` 276-337 (`listLaunchedSolverNets` returns sentinel fields, no `chainId`, at 297-312); the `describe('...listLaunched')` block 554-758. **The existing tests at 555, 643, 722 currently assume per-row IPFS enrichment AND `manifest.network` filtering — Task 5 updates them to the new contract.**
- **Indexer parser test precedent**: `packages/indexer/test/handlers.test.ts` has `describe('parseCheckpointManifestLite')` at 1049-1124 and imports lite parsers from `../src/handlers.js` (32-43). `parseSolverNetManifestLite` is currently NOT imported there and has no test.

## File Structure (what changes, and why)

- `packages/indexer/ponder.schema.ts` — +7 additive columns on `solverNetManifest` (criterion 1, persistence).
- `packages/indexer/src/handlers.ts` — extend `SolverNetManifestLite` + `parseSolverNetManifestLite` + the enrichment `.set({...})` (criterion 1, enrichment write).
- `packages/indexer/test/handlers.test.ts` — unit test for the extended parser (criterion 1, verification).
- `client/src/solvernets/registry-client.ts` — add `chainId: number` to `SolverNetManifestSummary` (criterion 2, type plumbing).
- `client/src/discovery/onchain.ts` — emit `chainId` in the on-chain floor's summary projection (type-consistency for the added field; the floor still returns IPFS sentinels — that's fine, it is not on this PR's hot path).
- `client/src/discovery/http.ts` — select the 7 new fields, project them guarded on `manifestEnrichmentStatus === 'ok'`, emit `chainId`, degrade to old behavior on GraphQL validation failure (criterion 2).
- `client/src/solvernets/registry-client-erc8004.ts` — drop the per-row IPFS fetch from `listLaunched`, map enriched summary straight through, filter on `chainId` (criterion 2).
- `client/test/solvernets/registry-client-erc8004.test.ts` — update `makeMockDiscoveryApi` + existing list tests to the new contract; add the IPFS-outage integration test + the enrichment-pending-row test (criterion 4).

## Criteria → Task map (read this before starting)

- **Criterion 1** (indexer persists + exposes the full launched-SolverNet fields): Tasks 1, 2, 2b.
- **Criterion 2** (daemon lists in a single GraphQL query, no per-CID IPFS fetch in the hot path, chain-scope via indexed `chainId`): Tasks 3, 4, 6, 7.
- **Criterion 4** (integration test proves IPFS-outage survival + `ipfs.fetch` never called on the list hot path): Tasks 5, 8.
- **Backward-compat degrade path** (old indexer without new fields): Task 7 (implementation) + Task 7 (its own degrade test).
- **Criterion 3** (staking state from subgraph): OUT OF SCOPE — do not implement.

## TDD ordering note

The criterion-4 integration test (Task 8) is written and watched fail **before** the daemon migration (Tasks 6/7) makes it pass — but it depends on the type change (Task 3) and the mock/test-contract update (Task 5) compiling first. So the order is: indexer (1→2b, independently type-checkable), then daemon type plumbing (3→4), then **flip the existing tests to the new contract (Task 5) and watch the migration tests fail**, then the migration (6→7), then add the outage test (Task 8) and watch it pass. Commit after every task.

---

### Task 1: Add 7 additive columns to the indexer `solverNetManifest` table

**Files:**
- Modify: `packages/indexer/ponder.schema.ts:294-298`

**Criterion:** 1.

- [ ] **Step 1: Add the columns**

In `packages/indexer/ponder.schema.ts`, replace the existing enriched-fields block (currently lines 294-298, ending just before the closing `}),` of the column callback at line 299):

```ts
    name: t.text().notNull().default(''),
    description: t.text().notNull().default(''),
    solverNetId: t.text().notNull().default(''),
    // ── Full launched-SolverNet summary fields (issue #985, criterion 1) ────
    // Additive, non-breaking. Populated by the same IPFS enrichment pass that
    // fills name/description/solverNetId (see handlers.ts). Empty-string /
    // empty-array defaults when enrichment hasn't landed. Per the schema-
    // version policy above (lines 22-25), pure-additive columns do NOT bump
    // the schema version or force a re-sync. `openRoles` mirrors the
    // pluginPublication.supports text[] column (line 416).
    network: t.text().notNull().default(''),
    solutionPriceWei: t.text().notNull().default(''),
    verdictPriceWei: t.text().notNull().default(''),
    openRoles: t.text().array().notNull().default([]),
    launcherSafeAddress: t.text().notNull().default(''),
    contractId: t.text().notNull().default(''),
    contractVersion: t.text().notNull().default(''),
    /** 'pending' | 'ok' | 'failed' — enrichment lifecycle. */
    manifestEnrichmentStatus: t.text().notNull().default('pending'),
```

(The `manifestEnrichmentStatus` line already exists at 298 — keep exactly one copy; the block above shows the full intended ordering with the existing `manifestEnrichmentStatus` retained at the end.)

- [ ] **Step 2: Run codegen + typecheck to verify the schema compiles**

Run: `cd packages/indexer && yarn codegen && yarn typecheck`
Expected: PASS (zero errors). `ponder codegen` regenerates the GraphQL types from the schema; the 7 new columns become queryable with no resolver code.

- [ ] **Step 3: Commit**

```bash
git add packages/indexer/ponder.schema.ts
git commit -m "refactor(indexer): add additive launched-SolverNet summary columns to solverNetManifest"
```

---

### Task 2: Extend `SolverNetManifestLite` + `parseSolverNetManifestLite` to read the 7 fields

**Files:**
- Modify: `packages/indexer/src/handlers.ts:531-550`

**Criterion:** 1.

- [ ] **Step 1: Extend the interface**

Replace `packages/indexer/src/handlers.ts:531-535` (`export interface SolverNetManifestLite { ... }`) with:

```ts
export interface SolverNetManifestLite {
  name: string;
  description: string;
  solverNetId: string;
  network: string;
  solutionPriceWei: string;
  verdictPriceWei: string;
  openRoles: string[];
  launcherSafeAddress: string;
  contractId: string;
  contractVersion: string;
}
```

- [ ] **Step 2: Extend the parser**

Replace the body of `parseSolverNetManifestLite` (`packages/indexer/src/handlers.ts:537-550`) with:

```ts
export function parseSolverNetManifestLite(body: unknown): SolverNetManifestLite | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const name = safeStr(b['name']);
  if (!name) return null;
  const description = safeStr(b['description']);
  // solverNetId may be number or string in the manifest; normalize to string.
  let solverNetId = '';
  const raw = b['solverNetId'];
  if (typeof raw === 'string') solverNetId = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) solverNetId = String(raw);
  else if (typeof raw === 'bigint') solverNetId = raw.toString();

  // Issue #985 criterion 1: read the remaining summary fields with the same
  // defensive reads. Field sources are manifest-schema.ts: top-level network /
  // solutionPriceWei / verdictPriceWei / openRoles; nested launcher.safeAddress;
  // nested contract.id / contract.version.
  const network = safeStr(b['network']);
  const solutionPriceWei = safeStr(b['solutionPriceWei']);
  const verdictPriceWei = safeStr(b['verdictPriceWei']);
  const openRoles = Array.isArray(b['openRoles'])
    ? (b['openRoles'] as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  const launcher = b['launcher'];
  const launcherObj: Record<string, unknown> =
    launcher !== null && typeof launcher === 'object' ? (launcher as Record<string, unknown>) : {};
  const launcherSafeAddress = safeStr(launcherObj['safeAddress']);
  const contract = b['contract'];
  const contractObj: Record<string, unknown> =
    contract !== null && typeof contract === 'object' ? (contract as Record<string, unknown>) : {};
  const contractId = safeStr(contractObj['id']);
  const contractVersion = safeStr(contractObj['version']);

  return {
    name,
    description,
    solverNetId,
    network,
    solutionPriceWei,
    verdictPriceWei,
    openRoles,
    launcherSafeAddress,
    contractId,
    contractVersion,
  };
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/indexer && yarn typecheck`
Expected: PASS. (The enrichment `.set({...})` at 931-936 still only writes the original 4 fields — that compiles because the new lite fields are simply unused for now; Task 2b wires them in.)

- [ ] **Step 3: Commit**

```bash
git add packages/indexer/src/handlers.ts
git commit -m "refactor(indexer): parse full launched-SolverNet summary from manifest body"
```

---

### Task 2b: Write the new fields in the enrichment success branch

**Files:**
- Modify: `packages/indexer/src/handlers.ts:929-936` (the success `.set({...})`)

**Criterion:** 1.

- [ ] **Step 1: Extend the `.set({...})`**

In `packages/indexer/src/handlers.ts`, the enrichment success branch currently reads (lines 929-936):

```ts
          await context.db
            .update(solverNetManifest, { id: manifestCid })
            .set({
              name: m.name,
              description: m.description,
              solverNetId: m.solverNetId,
              manifestEnrichmentStatus: 'ok',
            });
```

Replace the `.set({...})` argument with the full field set (do NOT touch the surrounding `if (m) { ... } else { ... }` lifecycle or the `manifestEnrichmentStatus: 'failed'` markers at 941/947):

```ts
          await context.db
            .update(solverNetManifest, { id: manifestCid })
            .set({
              name: m.name,
              description: m.description,
              solverNetId: m.solverNetId,
              network: m.network,
              solutionPriceWei: m.solutionPriceWei,
              verdictPriceWei: m.verdictPriceWei,
              openRoles: m.openRoles,
              launcherSafeAddress: m.launcherSafeAddress,
              contractId: m.contractId,
              contractVersion: m.contractVersion,
              manifestEnrichmentStatus: 'ok',
            });
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/indexer && yarn typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/indexer/src/handlers.ts
git commit -m "refactor(indexer): persist full launched-SolverNet summary on enrichment success"
```

---

### Task 2c: Unit-test the extended parser

**Files:**
- Modify: `packages/indexer/test/handlers.test.ts` — import line 32-43; add a `describe` block after `parseCheckpointManifestLite` (after line 1124).

**Criterion:** 1 (verification).

- [ ] **Step 1: Add `parseSolverNetManifestLite` to the test import**

In `packages/indexer/test/handlers.test.ts`, the import from `../src/handlers.js` is at lines 32-43. Add `parseSolverNetManifestLite,` to that import list (alongside `parseCheckpointManifestLite,` at line 40):

```ts
  parseCheckpointManifestLite,
  parseSolverNetManifestLite,
  parseVerdictEnvelopeLite,
```

- [ ] **Step 2: Write the failing test block**

Insert this `describe` block immediately after the closing `});` of `describe('parseCheckpointManifestLite', ...)` (after line 1124):

```ts
describe('parseSolverNetManifestLite (issue #985 — full summary fields)', () => {
  const SYNTHETIC_SOLVERNET_MANIFEST = {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: 'launcher/swe-rebench-v2',
    network: 'base-sepolia',
    name: 'SWE-rebench v2',
    description: 'A coding benchmark SolverNet.',
    launcher: {
      safeAddress: '0x' + 'ab'.repeat(20),
      agentEoa: '0x' + 'cd'.repeat(20),
      agentId: '5474',
    },
    contract: {
      id: 'swe-rebench-v2',
      version: 'v1',
    },
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
  };

  it('parses all summary fields from a valid manifest body', () => {
    const result = parseSolverNetManifestLite(SYNTHETIC_SOLVERNET_MANIFEST);
    expect(result).not.toBeNull();
    expect(result).toEqual({
      name: 'SWE-rebench v2',
      description: 'A coding benchmark SolverNet.',
      solverNetId: 'launcher/swe-rebench-v2',
      network: 'base-sepolia',
      solutionPriceWei: '1000000000000000',
      verdictPriceWei: '500000000000000',
      openRoles: ['solver', 'evaluator'],
      launcherSafeAddress: '0x' + 'ab'.repeat(20),
      contractId: 'swe-rebench-v2',
      contractVersion: 'v1',
    });
  });

  it('returns null for a non-object body', () => {
    expect(parseSolverNetManifestLite('string')).toBeNull();
    expect(parseSolverNetManifestLite(null)).toBeNull();
    expect(parseSolverNetManifestLite(42)).toBeNull();
  });

  it('returns null when the required name field is missing', () => {
    const { name: _omit, ...body } = SYNTHETIC_SOLVERNET_MANIFEST;
    expect(parseSolverNetManifestLite(body)).toBeNull();
  });

  it('degrades missing nested launcher/contract to empty strings (still parses)', () => {
    const { launcher: _l, contract: _c, ...body } = SYNTHETIC_SOLVERNET_MANIFEST;
    const result = parseSolverNetManifestLite(body);
    expect(result).not.toBeNull();
    expect(result?.launcherSafeAddress).toBe('');
    expect(result?.contractId).toBe('');
    expect(result?.contractVersion).toBe('');
  });

  it('degrades non-array openRoles to an empty array', () => {
    const body = { ...SYNTHETIC_SOLVERNET_MANIFEST, openRoles: 'solver' };
    const result = parseSolverNetManifestLite(body);
    expect(result?.openRoles).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test, verify it passes**

Run: `cd packages/indexer && yarn test handlers`
Expected: PASS — the new `describe('parseSolverNetManifestLite ...')` block all green (implementation already landed in Task 2; this block locks the contract).

- [ ] **Step 4: Commit**

```bash
git add packages/indexer/test/handlers.test.ts
git commit -m "test(indexer): cover parseSolverNetManifestLite full-summary parsing"
```

---

### Task 3: Add `chainId` to `SolverNetManifestSummary`

**Files:**
- Modify: `client/src/solvernets/registry-client.ts:67-82`

**Criterion:** 2 (the chain-scope filter compares `row.chainId`).

- [ ] **Step 1: Add the field**

In `client/src/solvernets/registry-client.ts`, add a `chainId` field to the `SolverNetManifestSummary` interface (insert after `anchorBlock: number;` at line 81, inside the interface body):

```ts
export interface SolverNetManifestSummary {
  manifestCid: string;
  solverNetId: string;
  name: string;
  network: string;
  launcherAgentId: string;
  launcherSafeAddress: `0x${string}`;
  status: 'launched' | 'paused' | 'retired';
  statusUpdatedAt: string;
  contractId: string;
  contractVersion: string;
  solutionPriceWei: string;
  verdictPriceWei: string;
  openRoles: Array<'solver' | 'evaluator'>;
  anchorBlock: number;
  /**
   * Indexed chain id from the on-chain MetadataSet event (84532 = base-sepolia,
   * 8453 = base). Used by listLaunched for chain scoping without an IPFS fetch.
   * Issue #985 criterion 2.
   */
  chainId: number;
}
```

- [ ] **Step 2: Run typecheck, observe the expected failures**

Run: `cd client && yarn typecheck`
Expected: FAIL — every producer of a `SolverNetManifestSummary` that doesn't yet set `chainId` is now a type error: `client/src/discovery/http.ts` (~914), `client/src/discovery/onchain.ts` (~941), and the test mock `client/test/solvernets/registry-client-erc8004.test.ts` (~297). These are fixed in Tasks 4, 6, and 5 respectively. (Do NOT commit yet — a broken typecheck must not be committed. Proceed to Task 4.)

---

### Task 4: Emit `chainId` from the on-chain floor projection

**Files:**
- Modify: `client/src/discovery/onchain.ts:941-956`

**Criterion:** 2 (type consistency for the added field; the floor stays IPFS-sentinel for the body fields — it is not this PR's hot path).

- [ ] **Step 1: Add `chainId` to the on-chain summary projection**

In `client/src/discovery/onchain.ts`, the `out.push({...})` block in `listLaunchedSolverNets` (lines 941-956) ends with `anchorBlock: row.anchorBlock,`. Add `chainId` using the in-scope `opts.chainId`:

```ts
        openRoles: [],                     // requires IPFS fetch
        anchorBlock: row.anchorBlock,
        chainId: opts.chainId,             // issue #985: indexed chain scope
      });
```

- [ ] **Step 2: Run typecheck**

Run: `cd client && yarn typecheck`
Expected: still FAIL, but `onchain.ts` is no longer among the errors — only `http.ts` (~914) and the test mock (~297) remain. (Proceed to Task 5; the typecheck goes green after Task 6.)

---

### Task 5: Flip the existing list tests + mock to the new contract (no-IPFS, chainId)

**Files:**
- Modify: `client/test/solvernets/registry-client-erc8004.test.ts` — `makeMockDiscoveryApi` 284-315; the list tests at 555-608, 643-699, 722-757.

**Criterion:** 2 + 4 (this redefines the behavioral contract the migration must satisfy; written first, watched fail).

This task encodes the NEW contract: the registry client must NOT fetch IPFS in the list path, and chain scoping uses `chainId`. After this task the list tests will FAIL against the un-migrated `listLaunched` (which still fetches IPFS and filters on `manifest.network`). Tasks 6/7 make them pass.

- [ ] **Step 1: Update `makeMockDiscoveryApi` to emit populated fields + chainId**

In `makeMockDiscoveryApi` (lines 284-315), the mock currently emits sentinel fields. It must now emit the manifest's real fields (read from the IPFS upload map so the test stays content-addressed) **and** a `chainId`. Replace the `for (const row of resolved) { ... out.push({...}); }` loop body (lines 294-313) with:

```ts
      for (const row of resolved) {
        if (args?.launcherAgentId !== undefined && row.launcherAgentId !== args.launcherAgentId) continue;
        if (args?.status !== undefined && !args.status.includes(row.status)) continue;
        // Simulate an indexer that has enriched the row: read the manifest the
        // launcher uploaded (the registry pinned it during publishManifest) and
        // project its summary fields, exactly as the real indexer would. The
        // registry client must NOT re-fetch this from IPFS on the list path.
        const body = ipfs.uploads.get(row.manifestCid) as
          | import('@jinn-network/sdk/solvernets').SolverNetManifestV1
          | undefined;
        out.push({
          manifestCid: row.manifestCid,
          solverNetId: body?.solverNetId ?? row.manifestCid,
          name: body?.name ?? '',
          network: body?.network ?? '',
          launcherAgentId: row.launcherAgentId,
          launcherSafeAddress: body?.launcher.safeAddress ?? '0x0000000000000000000000000000000000000000',
          status: row.status,
          statusUpdatedAt: row.statusUpdatedAt,
          contractId: body?.contract.id ?? '',
          contractVersion: body?.contract.version ?? '',
          solutionPriceWei: body?.solutionPriceWei ?? '0',
          verdictPriceWei: body?.verdictPriceWei ?? '0',
          openRoles: body?.openRoles ?? [],
          anchorBlock: row.anchorBlock,
          chainId: (body?.network ?? '') === 'base' ? 8453 : 84532,
        });
      }
```

`makeMockDiscoveryApi` must take the `ipfs` mock so it can read the upload map. Change its signature (line 276) from `function makeMockDiscoveryApi(subgraph: SubgraphClient)` to:

```ts
function makeMockDiscoveryApi(
  subgraph: SubgraphClient,
  ipfs: ReturnType<typeof makeMockIpfs>,
): DiscoveryAPI & { listLaunchedCalls: number } {
```

and update every call site in this file from `makeMockDiscoveryApi(subgraph)` to `makeMockDiscoveryApi(subgraph, ipfs)` (the `ipfs` and `subgraph` locals already exist at each call site).

- [ ] **Step 2: Assert no IPFS fetch on the happy-path list test**

In `it('returns summaries from discoveryApi with IPFS enrichment applied', ...)` (line 555): rename it to `'returns fully-enriched summaries from discoveryApi without fetching IPFS on the list path'`, and after the existing field assertions (after line 607 `expect(s.openRoles).toEqual(manifest.openRoles);`), add:

```ts
    // Criterion 2: the list path must not fetch IPFS — all fields come from
    // the indexer-enriched summary.
    expect(ipfs.fetchCalls).toBe(0);
    expect(s.chainId).toBe(84532); // base-sepolia
```

- [ ] **Step 3: Convert the network-filter test to chainId semantics**

The test `it('filters out manifests for a different network', ...)` (lines 722-757) currently relies on `manifest.network` filtering via IPFS. Its observable contract is unchanged (a base-sepolia manifest must not appear when listing `network: 'base'`), but the mechanism is now `chainId`. The body needs no change to its assertions (the mock now derives `chainId` from `body.network`), but add a no-IPFS assertion before the final `});`:

```ts
    // chainId-based scoping must not require an IPFS fetch.
    expect(ipfs.fetchCalls).toBe(0);
```

- [ ] **Step 4: Run the list tests and watch them fail**

Run: `cd client && yarn test registry-client-erc8004`
Expected: FAIL. The un-migrated `listLaunched` calls `fetchAndValidateManifest` per row, so `ipfs.fetchCalls` will be > 0 (the new assertions fail), and `s.chainId` is `undefined` (no `chainId` projected yet). This is the red state that Tasks 6/7 turn green.

- [ ] **Step 5: Commit (red tests + mock contract)**

```bash
git add client/test/solvernets/registry-client-erc8004.test.ts
git commit -m "test(client): redefine listLaunched contract — no IPFS on list path, chainId scoping"
```

---

### Task 6: Migrate `registry-client-erc8004.listLaunched` — no IPFS fetch, chainId filter

**Files:**
- Modify: `client/src/solvernets/registry-client-erc8004.ts:336-394`

**Criterion:** 2.

- [ ] **Step 1: Add a network→chainId helper near the top of the file**

In `client/src/solvernets/registry-client-erc8004.ts`, add a module-level helper after the `SOLVERNET_MANIFEST_KEY_PREFIX` constant (after line 50):

```ts
/**
 * Map the operator-facing network name to the on-chain chain id used by the
 * indexer for chain scoping. Mirrors discovery/onchain.ts chainForId.
 * Issue #985 criterion 2 — the list path filters on the indexed chainId, not
 * on a manifest body fetched per-row from IPFS.
 */
function networkToChainId(network: string): number {
  return network === 'base' ? 8453 : 84532;
}
```

- [ ] **Step 2: Replace the `listLaunched` body (steps 1-2 of the method)**

Replace the entire method body of `listLaunched` after the `if (!this.discoveryApi) { throw ... }` guard — i.e. replace lines 346-393 (from the `// Step 1` comment through the `return out;`) with:

```ts
    // Step 1: Obtain enriched summaries from the DiscoveryAPI. Post-#985 the
    // indexer persists every summary field (name/network/prices/openRoles/
    // launcher safe / contract id+version) on the solverNetManifest row, so a
    // single GraphQL query returns the full catalog. Note: listLaunchedSolverNets
    // does not accept sinceBlock — that was a subgraph optimisation that does
    // not translate to the abstract interface.
    const rawSummaries = await this.discoveryApi.listLaunchedSolverNets(
      args.statusFilter !== undefined ? { status: args.statusFilter } : undefined,
    );

    // Step 2: Chain-scope and project. The registry is global; the catalog is
    // chain-scoped. We filter on the INDEXED chainId — no per-row IPFS fetch.
    //
    // Trust delta: this list path now trusts the indexer's enriched fields.
    // The on-demand detail path (getManifest) still hash-verifies the IPFS body
    // against the on-chain advertised hash, so a tampered catalog row surfaces
    // the moment an operator opens that SolverNet's detail.
    const targetChainId = networkToChainId(args.network);
    const out: SolverNetManifestSummary[] = [];
    for (const row of rawSummaries) {
      if (row.chainId !== targetChainId) continue;
      out.push(row);
    }

    return out;
```

(Remove the now-unused per-row `fetchAndValidateManifest` loop and the `manifest.network !== args.network` filter. `fetchAndValidateManifest` / `getManifest` stay defined and are still used by the detail path — do not delete them.)

- [ ] **Step 3: Confirm `fetchAndValidateManifest` is still referenced**

Run: `grep -n "fetchAndValidateManifest" client/src/solvernets/registry-client-erc8004.ts`
Expected: at least one remaining reference inside `getManifest` (the method body after line 396). If the only references were the two you just removed, that would be a dead-code smell — but `getManifest` uses it, so this is fine.

- [ ] **Step 4: Run typecheck**

Run: `cd client && yarn typecheck`
Expected: still FAIL on `client/src/discovery/http.ts` (~914) only — `http.ts` still omits `chainId` and reads sentinels. Fixed in Task 7. (Do not commit a red typecheck; proceed to Task 7.)

---

### Task 7: Migrate `HttpDiscoveryAPI` — select new fields, guarded projection, chainId, degrade

**Files:**
- Modify: `client/src/discovery/http.ts` — query 137-156; `SolverNetRow` 386-394; projection 914-933.

**Criterion:** 2 + backward-compat degrade path.

- [ ] **Step 1: Extend the GraphQL query**

In `client/src/discovery/http.ts`, the `LIST_SOLVER_NETS_QUERY` selection set (lines 145-153) currently selects `id, launcherAgentId, status, statusUpdatedAt, manifestHash, anchorBlock, chainId`. Add the 7 enriched fields + `manifestEnrichmentStatus`:

```graphql
    items {
      id
      launcherAgentId
      status
      statusUpdatedAt
      manifestHash
      anchorBlock
      chainId
      name
      network
      solutionPriceWei
      verdictPriceWei
      openRoles
      launcherSafeAddress
      contractId
      contractVersion
      solverNetId
      manifestEnrichmentStatus
    }
```

- [ ] **Step 2: Extend `SolverNetRow`**

Replace `client/src/discovery/http.ts:386-394` (`interface SolverNetRow { ... }`) with:

```ts
interface SolverNetRow {
  id: string;
  launcherAgentId: string;
  status: string;
  statusUpdatedAt: string;
  manifestHash: string;
  anchorBlock: string | number;
  chainId: number;
  // Issue #985: enriched summary fields. Absent (undefined) when querying an
  // OLD indexer that predates these columns — the degrade catch handles that.
  name?: string;
  network?: string;
  solutionPriceWei?: string;
  verdictPriceWei?: string;
  openRoles?: string[];
  launcherSafeAddress?: string;
  contractId?: string;
  contractVersion?: string;
  solverNetId?: string;
  manifestEnrichmentStatus?: string;
}
```

- [ ] **Step 3: Rewrite the projection with the enrichment guard + degrade fallback**

Replace the body of `listLaunchedSolverNets` after `await ensureReady();` — i.e. lines 900-932 (the `where` construction through the `.map(...)` return) — with:

```ts
    // Build the where object dynamically — only include filters that are set.
    // A null `status_in` is a SQL error in Ponder; a null `launcherAgentId`
    // means "IS NULL". Omit, don't nullify.
    const where: Record<string, unknown> = {};
    if (args?.status && args.status.length > 0) where['status_in'] = args.status;
    if (args?.launcherAgentId) where['launcherAgentId'] = args.launcherAgentId;

    let data: SolverNetPage;
    try {
      data = await postGql<SolverNetPage>(
        gqlUrl,
        fetchImpl,
        LIST_SOLVER_NETS_QUERY,
        { where, limit: 200 },
      );
    } catch (err) {
      // Backward-compat degrade (issue #985): an OLD indexer that predates the
      // enriched columns rejects the extended selection set with a GraphQL
      // validation error. Mirror the getPluginScores degrade pattern: re-run
      // the minimal legacy query and project sentinels, so a daemon on a new
      // build still lists against an old indexer (consumers re-enrich via IPFS).
      if (err instanceof Error && /Unknown type|Cannot query|Cannot query field/.test(err.message)) {
        data = await postGql<SolverNetPage>(
          gqlUrl,
          fetchImpl,
          LIST_SOLVER_NETS_QUERY_LEGACY,
          { where, limit: 200 },
        );
      } else {
        throw err;
      }
    }

    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
    return (data.solverNetManifests?.items ?? []).map((row): SolverNetManifestSummary => {
      // Only trust enriched fields when the indexer marked the row 'ok'. A
      // pending/failed row (or an old indexer that omits the field) keeps the
      // sentinel rather than presenting an empty-string price as a real value;
      // consumers degrade to a per-CID IPFS fetch for those rows.
      const enriched = row.manifestEnrichmentStatus === 'ok';
      const safeAddr = (a: string | undefined): `0x${string}` =>
        typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : (ZERO_ADDR as `0x${string}`);
      return {
        manifestCid: row.id,
        solverNetId: enriched && row.solverNetId ? row.solverNetId : row.id,
        name: enriched ? (row.name ?? '') : '',
        network: enriched ? (row.network ?? '') : '',
        launcherSafeAddress: enriched ? safeAddr(row.launcherSafeAddress) : (ZERO_ADDR as `0x${string}`),
        contractId: enriched ? (row.contractId ?? '') : '',
        contractVersion: enriched ? (row.contractVersion ?? '') : '',
        solutionPriceWei: enriched ? (row.solutionPriceWei ?? '0') : '0',
        verdictPriceWei: enriched ? (row.verdictPriceWei ?? '0') : '0',
        openRoles: enriched
          ? ((row.openRoles ?? []).filter((r): r is 'solver' | 'evaluator' => r === 'solver' || r === 'evaluator'))
          : [],
        launcherAgentId: row.launcherAgentId,
        status: (row.status as 'launched' | 'paused' | 'retired') ?? 'launched',
        statusUpdatedAt: row.statusUpdatedAt,
        anchorBlock: Number(row.anchorBlock),
        chainId: row.chainId,
      };
    });
```

- [ ] **Step 4: Add the legacy query constant for the degrade path**

Immediately after `LIST_SOLVER_NETS_QUERY` (after line 156), add the minimal legacy selection (the pre-#985 field set) used only by the degrade catch:

```ts
// Legacy selection for the backward-compat degrade path (issue #985): the
// pre-enrichment field set, safe against an OLD indexer that lacks the
// enriched columns. The projection fills sentinels for the missing fields and
// leaves manifestEnrichmentStatus undefined → treated as not-ok → sentinels.
const LIST_SOLVER_NETS_QUERY_LEGACY = `
query ListSolverNetsLegacy($where: solverNetManifestFilter, $limit: Int!) {
  solverNetManifests(
    where: $where,
    limit: $limit,
    orderBy: "anchorBlock",
    orderDirection: "desc"
  ) {
    items {
      id
      launcherAgentId
      status
      statusUpdatedAt
      manifestHash
      anchorBlock
      chainId
    }
  }
}
`;
```

- [ ] **Step 5: Run typecheck — now green**

Run: `cd client && yarn typecheck`
Expected: PASS (zero errors). All `SolverNetManifestSummary` producers now set `chainId`.

- [ ] **Step 6: Run the list tests — Task 5's red tests now green**

Run: `cd client && yarn test registry-client-erc8004`
Expected: PASS. `ipfs.fetchCalls === 0` on the list path; `chainId` projected; chainId-based network scoping works.

- [ ] **Step 7: Add a degrade unit test for the HTTP layer**

The degrade path needs its own coverage. Find the existing http discovery test file:

Run: `ls client/test/discovery/`
Then, in the file that tests `HttpDiscoveryAPI.listLaunchedSolverNets` (search: `grep -rln "listLaunchedSolverNets" client/test/discovery/`), add a test that:
1. Stubs `fetchImpl` (the injected fetch) so the FIRST POST (extended query) returns a GraphQL error body whose `errors[0].message` contains `"Cannot query field"`, and the SECOND POST (legacy query) returns a valid `solverNetManifests.items` page with `chainId` set and NO enriched fields.
2. Asserts `listLaunchedSolverNets()` resolves (does not throw), returns the row with sentinel body fields (`name === ''`, `solutionPriceWei === '0'`, `openRoles === []`) and the real `chainId`.

Use the existing test's harness for constructing `HttpDiscoveryAPI` with a stub `fetchImpl` (mirror how `getPluginScores`' degrade is tested if such a test exists; otherwise mirror the file's existing `listLaunchedSolverNets` test setup). Concretely the test body shape:

```ts
it('degrades to the legacy query against an old indexer (no enriched columns)', async () => {
  let call = 0;
  const fetchImpl = (async (_url: string, _init: unknown) => {
    call += 1;
    if (call === 1) {
      // Old indexer rejects the extended selection set.
      return {
        ok: true,
        json: async () => ({ errors: [{ message: 'Cannot query field "openRoles" on type "solverNetManifest".' }] }),
      };
    }
    // Legacy query succeeds.
    return {
      ok: true,
      json: async () => ({
        data: {
          solverNetManifests: {
            items: [{
              id: 'bafyold',
              launcherAgentId: '5474',
              status: 'launched',
              statusUpdatedAt: '2026-05-06T00:00:00Z',
              manifestHash: '0x' + 'ab'.repeat(32),
              anchorBlock: 100,
              chainId: 84532,
            }],
          },
        },
      }),
    };
  }) as unknown as typeof fetch;

  const api = /* construct HttpDiscoveryAPI with { fetchImpl, gqlUrl, ... } per this file's existing helper */;
  const rows = await api.listLaunchedSolverNets();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.chainId).toBe(84532);
  expect(rows[0]!.name).toBe('');            // sentinel — old indexer has no enriched field
  expect(rows[0]!.solutionPriceWei).toBe('0');
  expect(rows[0]!.openRoles).toEqual([]);
  expect(call).toBe(2);                       // proves the degrade re-query fired
});
```

Note: `postGql` throws an `Error` whose message includes the GraphQL `errors[0].message` — verify this by reading `postGql` in `client/src/discovery/http.ts` and matching the regex (`/Cannot query field/`) to the actual thrown message format. Adjust the stub's error string and the regex in Task 7 Step 3 if `postGql` wraps the message differently.

- [ ] **Step 8: Run the degrade test**

Run: `cd client && yarn test discovery`
Expected: PASS — including the new degrade test.

- [ ] **Step 9: Commit the daemon migration**

```bash
git add client/src/solvernets/registry-client.ts client/src/discovery/onchain.ts client/src/discovery/http.ts client/src/solvernets/registry-client-erc8004.ts client/test/discovery/
git commit -m "refactor(client): list launched SolverNets from indexer fields, no IPFS on hot path, chainId scoping"
```

---

### Task 8: IPFS-outage integration test (criterion 4)

**Files:**
- Modify: `client/test/solvernets/registry-client-erc8004.test.ts` — add tests inside the existing `describe('...listLaunched')` block (after line 757, before the block's closing `});`).

**Criterion:** 4.

- [ ] **Step 1: Add the IPFS-outage test**

Inside `describe('IdentityRegistryBackedSolverNetRegistryClient.listLaunched', ...)`, before its closing `});` (line 758), add:

```ts
  it('survives an IPFS-gateway outage — catalog populated from indexer fields, ipfs.fetch never called', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    const { manifest, signer } = await buildSignedManifest({ agentId: '5474' });
    const launch = await client.publishManifest({ manifest, signer });
    const cid = launch.manifestCid;
    subgraph.events.push({
      agentId: '5474',
      key: `solvernet-manifest:${cid}`,
      payload: {
        schemaVersion: 'solvernet.lifecycle.v1',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        hash: manifestHash(manifest),
      },
      blockNumber: 100,
      transactionIndex: 0,
    });

    // Simulate a total IPFS outage: every fetch throws. The mock's enriched
    // summary already carries the fields (it read the upload map at publish
    // time, mirroring the indexer's enrichment), so the list path needs no
    // IPFS at all.
    const ipfsFetchMock = vi.fn(async (_cid: string): Promise<unknown> => {
      throw new Error('IPFS gateway 504');
    });
    ipfs.fetch = ipfsFetchMock as unknown as typeof ipfs.fetch;

    const summaries = await client.listLaunched({ network: 'base-sepolia' });

    // Catalog is fully populated despite the outage.
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.name).toBe(manifest.name);
    expect(s.solutionPriceWei).toBe(manifest.solutionPriceWei);
    expect(s.verdictPriceWei).toBe(manifest.verdictPriceWei);
    expect(s.openRoles).toEqual(manifest.openRoles);
    expect(s.launcherSafeAddress).toBe(manifest.launcher.safeAddress);
    expect(s.contractId).toBe(manifest.contract.id);
    expect(s.contractVersion).toBe(manifest.contract.version);

    // The list hot path must never touch IPFS.
    expect(ipfsFetchMock).not.toHaveBeenCalled();
  });

  it('handles an enrichment-pending row gracefully (no crash; row still listed)', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    // A discoveryApi that returns a row the indexer has NOT yet enriched:
    // populated identity fields but sentinel body fields, status pending.
    const discoveryApi: DiscoveryAPI & { listLaunchedCalls: number } = {
      listLaunchedCalls: 0,
      async listLaunchedSolverNets() {
        return [{
          manifestCid: 'bafypending',
          solverNetId: 'bafypending',
          name: '',
          network: '',
          launcherAgentId: '5474',
          launcherSafeAddress: '0x0000000000000000000000000000000000000000' as `0x${string}`,
          status: 'launched' as const,
          statusUpdatedAt: '2026-05-06T00:00:00Z',
          contractId: '',
          contractVersion: '',
          solutionPriceWei: '0',
          verdictPriceWei: '0',
          openRoles: [],
          anchorBlock: 100,
          chainId: 84532,
        }];
      },
      async getLifecycleStatus() { return undefined; },
      async findClaimableTasks() { return []; },
      async queryEnvelopes() { return []; },
    };
    const ipfsFetchMock = vi.fn(async (): Promise<unknown> => { throw new Error('IPFS gateway 504'); });
    ipfs.fetch = ipfsFetchMock as unknown as typeof ipfs.fetch;

    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    // Does not throw; the pending row is listed with sentinel body fields.
    const summaries = await client.listLaunched({ network: 'base-sepolia' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.manifestCid).toBe('bafypending');
    expect(summaries[0]!.name).toBe('');
    expect(ipfsFetchMock).not.toHaveBeenCalled();
  });
```

Ensure `vi` is imported at the top of the test file (`import { describe, it, expect, vi } from 'vitest';`) — add `vi` to the existing vitest import if absent. Confirm `DiscoveryAPI` is imported (it is used by `makeMockDiscoveryApi`); add the type import if the inline-object test needs it.

- [ ] **Step 2: Run the integration tests**

Run: `cd client && yarn test registry-client-erc8004`
Expected: PASS — including both new tests.

- [ ] **Step 3: Commit**

```bash
git add client/test/solvernets/registry-client-erc8004.test.ts
git commit -m "test(client): prove SolverNet catalog survives IPFS outage, no fetch on list hot path"
```

---

## Verification (run after all tasks)

Run, in order, and confirm each is clean before claiming completion (per superpowers:verification-before-completion — evidence before assertions):

**Indexer (`packages/indexer/`):**
```bash
cd packages/indexer
yarn codegen        # regenerate GraphQL types from the extended schema
yarn typecheck      # tsc --noEmit — expect zero errors
yarn test           # vitest run — expect all green, incl. parseSolverNetManifestLite block
```

**Client (`client/`):**
```bash
cd client
yarn typecheck      # expect zero errors
yarn test           # full vitest suite — expect all green
```

Targeted re-runs while iterating:
```bash
cd packages/indexer && yarn test handlers
cd client && yarn test registry-client-erc8004
cd client && yarn test discovery
```

Do NOT run `yarn e2e` / `yarn e2e:daemon-harness` for this PR — they need a live indexer build + network; the unit + integration suites above are the gate for criteria 1, 2, 4.

## Self-review notes (already applied)

- **Spec coverage:** criterion 1 → Tasks 1/2/2b (persist + write) + 2c (parser proof); criterion 2 → Tasks 3/4/6/7 (single GraphQL query, no IPFS on hot path, chainId scope); criterion 4 → Tasks 5/8 (outage + no-fetch assertions). Criterion 3 intentionally absent.
- **Backward-compat:** Task 7 Steps 3-4 + the degrade test in Step 7 are the explicit, testable degrade path mirroring `getPluginScores` (http.ts:1147-1153).
- **Type consistency:** `SolverNetManifestSummary.chainId: number` is defined once (Task 3) and set by every producer — http.ts (Task 7), onchain.ts (Task 4), the test mock (Task 5) and the inline pending-row mock (Task 8). `SolverNetManifestLite`'s 7 new fields are defined in Task 2 and consumed in Task 2b.
- **Must-confirm-while-coding flags (do these as you implement):**
  - The exact thrown-error message format from `postGql` in `client/src/discovery/http.ts` — the degrade regex in Task 7 (`/Unknown type|Cannot query|Cannot query field/`) and the stub error string in Step 7 must match what `postGql` actually throws. Read `postGql` before finalizing the regex.
  - The exact `HttpDiscoveryAPI` construction helper used in `client/test/discovery/` — Task 7 Step 7's `const api = ...` placeholder must be replaced with that file's real factory call.
  - Whether `vi` and `DiscoveryAPI` are already imported in `client/test/solvernets/registry-client-erc8004.test.ts` (Task 8) — add to the imports if missing.
  - That Task 1's column block keeps exactly ONE `manifestEnrichmentStatus` line (it already exists at schema line 298).
