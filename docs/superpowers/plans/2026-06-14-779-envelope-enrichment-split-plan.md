# Implementation Plan — Split envelope enrichment off the indexer's GraphQL event loop (#779)

- **Version:** 0.1
- **Date:** 2026-06-14
- **Author:** Claude (planning subagent, #779)
- **Shape:** `refactor` (strangler-fig; stacked, independently-sound commits in one draft PR)
- **Design note:** `docs/superpowers/specs/2026-06-14-779-envelope-enrichment-split.md` (READ FIRST)
- **Methodology for the implementer:** `superpowers:test-driven-development` then `superpowers:executing-plans`

---

## 0. Pre-flight: design-vs-code discrepancies (read before starting)

While planning, the design's file/line claims were verified against the actual code. Four
discrepancies were found. The implementer MUST account for these — they change the work, not just
the citations.

1. **`enrichEnvelopes` default is `true`, not `false`.** Design §1 (line 51) implies the handler
   default is anchor-only today. It is not. `packages/indexer/src/index.ts:42-44` computes
   `enrichEnvelopes = env !== 'false' && env !== '0'` → **default true** (in-handler enrichment is
   the live behavior). The handler *function* signature defaults the param to `false`
   (`handlers.ts:848`), but the production wiring in `index.ts` is `true`. **The cutover (Layer 3)
   flips the production default to `false`** by changing `index.ts`. AC5 reversibility is: set
   `JINN_INDEXER_ENRICH_ENVELOPES=true` to restore in-handler enrichment.

2. **`fetchIpfsJson` / `FetchLike` / `DEFAULT_IPFS_GATEWAY` already live in an importable module**
   — `packages/indexer/src/ipfs.ts` (35 lines, no Ponder coupling). They do NOT need extracting.
   Only the **parsers** need a shared home: `parseVerdictEnvelopeLite` (exported) plus its private
   deps `safeStr`, `safeInt`, `normalizeVerdict`, the `VerdictEnvelopeLite` interface, **and the
   swe-rebench-v2 task-body → `instance_id` + `solverNetManifestCid` resolution that is currently
   inlined in the handler** (`handlers.ts:1238-1262`, not yet a function). The shared module must
   expose that task-body resolution as a function so the worker and the legacy handler path cannot
   drift.

3. **The indexer test harness uses an in-memory stub, NOT PGlite.** Design §Testing claims "PGlite
   (already an indexer transitive dep via Ponder, used in `test/api.slice.route.test.ts`)". Verified
   false: `test/api.slice.route.test.ts:21,38` explicitly states *"There is no PGlite / Ponder boot
   in the test"*; the handler tests use `test/helpers/in-memory-db.ts` (a hand-rolled stub). Neither
   `@electric-sql/pglite` nor `pg` resolves from the indexer package today (verified via
   `require.resolve`). **Therefore:** the handler unit tests (Layer 1/3, AC1/AC5) keep using the
   in-memory stub — they assert "no fetch, no row," which needs no real DB. The **worker's** DB
   tests (Layer 2, handbook rule 6 — real DB for the contract surface) add `@electric-sql/pglite` +
   `drizzle-orm/pglite` as **explicit devDependencies of the new worker package** and run Drizzle
   against an in-memory PGlite instance with the real schema applied. Production uses plain `pg`
   `Pool` via `drizzle-orm/node-postgres`.

4. **`getInstanceSuccessCounts` filter lives in `INSTANCE_SUCCESS_COUNTS_QUERY`** (a GraphQL string
   const in `client/src/discovery/http.ts`, ~line 277), not at `http.ts:276` as a function. The
   filter shape is confirmed verbatim: `solverNetManifestCid`, `solverType_starts_with:
   "swe-rebench-v2"`, `actualPassed: true`, `enrichmentStatus: "ok"`, `instanceId_not: ""`. **This
   string is not touched by #779** — AC4 is preserved by the worker writing the same five fields and
   only flipping `enrichmentStatus='ok'` once both `instanceId` and `solverNetManifestCid` are
   populated.

Two further confirmations the design got right:
- The `envelope` anchor upsert (`handlers.ts:1089-1128`) runs **before** any IPFS fetch and is
  unconditional — it IS the CID-keyed skeleton (AC1). The evaluation enrichment block
  (`handlers.ts:1215-1335`) is fully gated behind `enrichEnvelopes && verdictEnvelopeMeta`.
- `verdictEnvelopeMeta` PK is `(requestId, chainId)` with `onConflictDoUpdate` guarded by
  `blockNumber >= row.enrichedAtBlock` (handlers.ts:1288). The worker mirrors this.

**Open question O1 (retry-state location) is resolved per the design brief:** start with the two new
nullable columns (`retryCount`, `nextAttemptAt`) on `verdictEnvelopeMeta` + a transient `retry`
`enrichmentStatus`; do NOT build a side table. Recorded in the plan; no further decision needed.

---

## 1. Goal & success criteria

Move IPFS-bound enrichment of `verdict_envelope_meta` out of the Ponder indexing handler into a new
standalone polling worker (`packages/indexer-enrichment/`), so a verdict-enrichment backlog can never
starve the indexer's `/graphql` read path. The handler keeps writing the IPFS-free `envelope` anchor;
the worker discovers un-enriched evaluation anchors via a CID left-anti-join and writes the full
field set back into the live Ponder schema.

**Done when all six ACs hold, verified by the commands in §7:**

| AC | Statement | Verifying task |
|----|-----------|----------------|
| AC1 | Handler writes anchor with `enrichmentStatus='pending'`, NO IPFS I/O; returns < 10ms p99 in tests | T1.3, T3.2 |
| AC2 | Worker polls `enrichmentStatus IN ('pending','retry')`, fetches IPFS, writes full field set | T2.4, T2.5 |
| AC3 | 40 rapid `/graphql` probes during backlog all return HTTP 200 | T2.7 |
| AC4 | `getInstanceSuccessCounts` filter shape unchanged; #669 anti-farming holds | T1.1 (keep green), T2.6 |
| AC5 | Reversible via `JINN_INDEXER_ENRICH_ENVELOPES` | T3.2 (parametric) |
| AC6 | Worker idempotent — re-run against `ok` row leaves it unchanged | T2.5 |

---

## 2. Stacked layering (strangler-fig)

One draft PR, four ordered, independently-sound layers. Each layer ends with all prior tests green.

- **Layer 1 — Schema + parser extraction (no behavior change).** Add `retryCount` / `nextAttemptAt`
  columns + `retry` status to `verdict_envelope_meta`; extract the verdict parser + task-body
  resolver into a shared indexer module both `handlers.ts` and the worker import. Pure refactor.
- **Layer 2 — New `packages/indexer-enrichment/` worker.** Scaffolded from `claim-relayer`, full
  unit + real-DB (PGlite) integration tests, but **not wired into any deploy** and the indexer still
  enriches in-handler (`enrichEnvelopes` stays `true`). Worker exercised by tests only.
- **Layer 3 — Cutover flag.** Flip the production default in `index.ts` so
  `JINN_INDEXER_ENRICH_ENVELOPES` is `false` unless explicitly set; handler writes anchors only;
  worker owns verdict enrichment. Flag stays the documented rollback.
- **Layer 4 — Deploy artifacts (ship, do not provision).** `deploy/Dockerfile` + `deploy/railway.toml`
  + `indexer-enrichment-ci.yml` + worker README. No Railway service stood up in this PR.

---

## 3. LAYER 1 — Schema + parser extraction (no behavior change)

### T1.0 — Regression baseline (do this first)

Before any change, confirm the existing suite is green so later "stay green" claims are meaningful.

- **Files:** none (verification only).
- **Command:** from `packages/sdk` run `yarn install --immutable && yarn build`; then from
  `packages/indexer` run `yarn install --immutable && yarn codegen && yarn typecheck && yarn test`.
- **Done when:** indexer test suite passes (record the count). If `yarn install` cannot reach the
  network in the sandbox, note it and proceed — CI (§7) is the gate.

### T1.1 — Lock the #669 anti-farming behavior as a kept-green test (AC4)

The launcher-filter test already exists in `client/test/discovery/http.test.ts` (the
`getInstanceSuccessCounts` / `INSTANCE_SUCCESS_COUNTS_QUERY` coverage). **Do not modify it.** This
task is purely a checkpoint: identify the exact test(s) that assert the
`enrichmentStatus:"ok"` + `instanceId_not:""` + `solverNetManifestCid` + `actualPassed:true` +
`solverType_starts_with:"swe-rebench-v2"` filter, and record their names in the PR description as the
AC4 regression guard. These MUST stay green through every layer.

- **Files (read-only):** `client/src/discovery/http.ts`, `client/test/discovery/http.test.ts`.
- **Done when:** the AC4 guard test names are written into the PR description and confirmed green on
  `main`/`next` baseline (no code change in this task).

### T1.2 — Add `retryCount` / `nextAttemptAt` columns + `retry` status to the schema

TDD: write the schema-shape assertion first.

- **Test first:** extend `packages/indexer/test/handlers.test.ts` (the existing
  `MetadataSet evaluation: enrichment → verdictEnvelopeMeta` describe block) OR add a focused
  `schema.verdict-envelope-meta.test.ts` mirroring `schema.attempt-envelope-meta.test.ts`. Assert
  that an inserted `verdictEnvelopeMeta` row defaults `retryCount` to `0` and `nextAttemptAt` to
  `null`, and that the existing `enrichmentStatus` default stays `'pending'`. (Use the in-memory db
  stub; this is a column-default assertion, not a DB-engine test.)
- **Implementation:** in `packages/indexer/ponder.schema.ts`, inside the `verdictEnvelopeMeta`
  `onchainTable` (lines 622-721), add:
  - `retryCount: t.integer().notNull().default(0)` — worker-owned retry counter.
  - `nextAttemptAt: t.bigint()` — nullable epoch-ms of the next eligible attempt (bigint, not
    timestamp, to match Ponder's bigint convention used elsewhere in this schema and to keep the
    worker's comparison arithmetic simple). NULL = eligible now.
  - Update the `enrichmentStatus` doc comment (line 697) to read
    `'pending' | 'retry' | 'ok' | 'failed'` (`retry` transient, `failed` terminal).
  - Add an index supporting the discovery scan's status/due predicate, e.g.
    `dueIdx: index().on(table.enrichmentStatus, table.nextAttemptAt)`.
- **Important — the in-memory-db stub must learn the new defaults.** `test/helpers/in-memory-db.ts`
  applies column defaults from the schema. Verify it picks up `retryCount`/`nextAttemptAt`
  automatically (it reads the Drizzle column config); if it hard-codes a column list anywhere, extend
  it. This is the most likely place a "no behavior change" claim silently breaks.
- **Done when:** the new schema test passes; the whole existing `handlers.test.ts` stays green;
  `yarn codegen && yarn typecheck` clean. **Note (O3/O4 — runtime):** adding columns to an
  `onchainTable` requires a `DATABASE_SCHEMA` bump (full re-sync) at deploy — Ponder does not
  online-migrate. This is a deploy-runbook note (Layer 4), not a code task.

### T1.3 — Tighten the AC1 handler test: anchor-only path does no IPFS I/O and is fast

The existing test `does NOT fetch or write when enrichEnvelopes:false` (handlers.test.ts:1681-1698)
already asserts `called === false` and `verdictEnvelopeMeta count === 0`. Strengthen it for AC1:

- **Test (extend existing, do not duplicate):**
  - Keep the `called` flag assertion (`fetchImpl` stub flips `called=true`; assert `called===false`).
  - **Add:** assert the `envelope` anchor row exists after the call with `kind==='evaluation'` and
    the expected `manifestCid` (proving the skeleton is written even with enrichment off). The
    `envelope` table has no `enrichmentStatus` column — AC1's "skeleton row with
    `enrichmentStatus='pending'`" refers to the *discovery contract*: an `evaluation` envelope anchor
    with no `ok` `verdict_envelope_meta`. Assert that the anchor exists AND
    `verdictEnvelopeMeta count === 0` (i.e. it presents as un-enriched to the worker's join).
  - **Add a timing guard:** wrap the `handleMetadataSet` call in `performance.now()` deltas and
    assert sub-10ms (generous; the anchor-only path is a single in-memory upsert). Keep the bound
    loose enough to not flake in CI but tight enough to catch an accidental re-introduced fetch.
- **Files:** `packages/indexer/test/handlers.test.ts`.
- **Done when:** the strengthened test passes; no production code changed in this task (behavior is
  already correct — this just pins AC1 before the cutover).

### T1.4 — Extract the shared verdict-parse + task-body-resolve module (no behavior change)

Create one new module **inside the indexer package** that both `handlers.ts` and the worker import.
Do NOT promote to `@jinn-network/sdk` (the parsers are indexer-internal and the indexer already has a
clean `ipfs.ts`; keeping them in-package and having the worker `portal:`-link the indexer is the
lower-surface choice — see T2.1 dependency wiring). Do NOT make the worker import the 1483-line
`handlers.ts` (it pulls Ponder-context types).

- **New file:** `packages/indexer/src/enrichment-parse.ts`. Move from `handlers.ts` (cut, not copy):
  - `VerdictEnvelopeLite` interface (lines 703-719)
  - `safeStr` (609), `safeInt` (721), `normalizeVerdict` (731), `parseVerdictEnvelopeLite` (741-828)
  - **A NEW exported function** capturing the inlined swe-rebench-v2 task-body resolution
    (handlers.ts:1238-1262), e.g.
    `resolveInstanceFields(taskBody: unknown): { instanceId: string; solverNetManifestCid: string }`
    — pure, takes the already-fetched task body, returns the two fields (`''` defaults). The IPFS
    *fetch* stays at the call sites (handler + worker) using `fetchIpfsJson` from `ipfs.ts`; only the
    *parsing* of the fetched body is shared. Keep `safeStr` import-shared if `parseEnvelopeLite` /
    `parseSolverNetManifestLite` (which stay in `handlers.ts`) also use it — re-export `safeStr` from
    the new module and import it back into `handlers.ts`, OR leave a copy; pick whichever keeps the
    diff smallest while leaving ONE definition of each. (Verify: `safeStr` is used by
    `parseSolverNetManifestLite` at 544 and `parseEnvelopeLite` at 613 — so export it from the new
    module and import into `handlers.ts` to avoid duplication.)
- **`handlers.ts` change:** replace the moved definitions with an `import` from
  `./enrichment-parse.js`; replace the inlined task-body block (1238-1262) with a `fetchIpfsJson` +
  `resolveInstanceFields(taskBody)` call. **Behavior must be byte-identical.**
- **Re-export for tests:** `handlers.test.ts` imports `parseVerdictEnvelopeLite` from `../src/handlers.js`
  (line ~41). Keep that import working by re-exporting `parseVerdictEnvelopeLite` from `handlers.ts`
  (`export { parseVerdictEnvelopeLite } from './enrichment-parse.js'`), OR update the test import to
  the new module path. Prefer re-export (smaller blast radius on the test file).
- **Test first (characterization):** before moving code, confirm the existing
  `parseVerdictEnvelopeLite` direct-call tests (handlers.test.ts:1479-1596 — the "parses a SWE-rebench
  v2 verdict envelope", "parses graded counts", "normalizes generic verdict values" block) pass.
  After extraction they must pass **unchanged**. Add one direct unit test for the new
  `resolveInstanceFields` (given a `task.v1` body with `spec.instance_id` +
  top-level `solverNetManifestCid`, returns both; given a body missing them, returns `''`/`''`) — this
  is the function the worker will rely on, so it earns its own test.
- **Files:** new `packages/indexer/src/enrichment-parse.ts`; edit `packages/indexer/src/handlers.ts`;
  possibly touch `packages/indexer/test/handlers.test.ts` import line.
- **Done when:** all of `handlers.test.ts` passes unchanged (modulo the import line); the new
  `resolveInstanceFields` test passes; `yarn typecheck` clean. This is the "extraction cannot change
  behavior" gate.

**Layer 1 exit criteria:** `cd packages/indexer && yarn codegen && yarn typecheck && yarn test && yarn build`
all green. No worker exists yet; the indexer still enriches in-handler.

---

## 4. LAYER 2 — New `packages/indexer-enrichment/` worker

Model file-for-file on `packages/claim-relayer/` (the standing-worker template). Key delta from the
template: this worker **depends on the indexer package** (for `ponder.schema.ts` and
`enrichment-parse.ts`) and on the **sdk** transitively — so it carries `portal:` links, unlike the
fully-standalone claim-relayer. It uses Postgres (`pg` + `drizzle-orm/node-postgres`), not
`better-sqlite3`.

### T2.1 — Scaffold the package (no logic yet)

- **New files:**
  - `packages/indexer-enrichment/package.json` — name `@jinn-network/indexer-enrichment`, `type:
    module`, `bin: { "jinn-indexer-enrichment": "./dist/index.js" }`, scripts mirroring claim-relayer
    (`build`/`typecheck`/`test`/`dev`). **Dependencies:** `pg`, `drizzle-orm` (pin to the indexer's
    `^0.45.2` to match the shared schema's Drizzle version — a mismatch risks column-mapping drift),
    `@jinn-network/indexer: portal:../indexer`, `@jinn-network/sdk: portal:../sdk` (the indexer's
    schema/parsers may transitively touch sdk types). **devDependencies:** `@types/pg`,
    `@electric-sql/pglite`, `@types/node`, `tsx`, `typescript`, `vitest`.
  - `packages/indexer-enrichment/tsconfig.json` — copy claim-relayer's (Bundler resolution, ES2022).
  - `packages/indexer-enrichment/vitest.config.ts` — copy claim-relayer's.
  - `packages/indexer-enrichment/.yarnrc.yml` — match the indexer's (`nodeLinker: node-modules` if
    the indexer uses it; check `packages/indexer/.yarnrc.yml`). `portal:` links require the sibling
    packages resolvable at install — mirror exactly how the indexer resolves `portal:../sdk`.
- **Decision to verify during scaffolding:** can a `portal:`-linked `@jinn-network/indexer` resolve
  `ponder.schema.ts`? The indexer's `package.json` has no `exports` map pointing at the schema. **Two
  options — pick by inspection:**
  - (a) Add an `exports` subpath to `packages/indexer/package.json` for the schema + parse module
    (e.g. `"./schema": "./ponder.schema.ts"`, `"./enrichment-parse": "./src/enrichment-parse.ts"`)
    and have the worker import `@jinn-network/indexer/schema`. Cleanest, but the indexer ships
    TS-source (no build of these files today) — confirm the worker's `tsc`/`vitest` can consume the
    `.ts` directly via the portal (it can, with `moduleResolution: Bundler` + sources present).
  - (b) Have the worker import via a **relative path through the portal symlink** is not portable;
    avoid. Prefer (a). If (a) is friction (e.g. the schema imports `ponder` runtime that won't load
    outside ponder), fall back to **defining a minimal Drizzle table mirror in the worker** typed
    against the real schema via a compile-time `satisfies` check importing the column list — but this
    is the O2 coupling the design wants to avoid, so try (a) first.
  - **Flag in PR:** record which option was taken and why. If the schema can't be imported standalone
    (ponder-runtime coupling), that is a genuine finding that may push retry-state toward the side
    table (O1) — escalate rather than hack around it.
- **Done when:** `cd packages/indexer-enrichment && yarn install --immutable && yarn typecheck`
  resolves the indexer schema import and a trivial `src/index.ts` stub compiles.

### T2.2 — `src/config.ts` (env → typed config)

- **Test first:** `test/config.test.ts` (mirror claim-relayer/test/config.test.ts). Assert: missing
  `DATABASE_URL` throws; defaults applied for poll interval / batch size / port; `DATABASE_SCHEMA`
  required (or defaulted to match the indexer's convention — read `packages/indexer/deploy/README.md`
  §64 which uses `jinn_indexer_v1`). Reuse the indexer's env var names exactly: `DATABASE_URL`,
  `DATABASE_SCHEMA`, `JINN_IPFS_GATEWAY_URL`.
- **Implementation:** `EnrichmentWorkerConfig` with: `databaseUrl`, `databaseSchema`,
  `ipfsGateway` (default `''` → `fetchIpfsJson` falls back to `DEFAULT_IPFS_GATEWAY`), `port`
  (default e.g. 8738 — NOT 8737, claim-relayer's), `pollIntervalMs` (default e.g. 10_000),
  `batchSize` (default e.g. 25 — the O4 drain knob), `ipfsTimeoutMs` (default 5000),
  `maxRetries` (default e.g. 5 before `failed`). Env prefix: `JINN_ENRICHMENT_*` for worker-specific
  knobs; share `DATABASE_*` + `JINN_IPFS_GATEWAY_URL` with the indexer.
- **Add a `redactConfig`** (mirror claim-relayer) that masks the `DATABASE_URL` credentials for the
  `/status` payload.
- **Done when:** config tests pass.

### T2.3 — `src/db.ts` (Postgres access via Drizzle)

- **Test first:** `test/db.test.ts` against **PGlite** (real Postgres engine, in-memory; handbook
  rule 6). Setup helper: create a PGlite instance, create the schema (`CREATE SCHEMA
  <DATABASE_SCHEMA>`), apply the `envelope` + `verdict_envelope_meta` table DDL (derive from the
  imported Drizzle schema via `drizzle-kit`'s SQL generation, or hand-write the two CREATE TABLEs
  matching `ponder.schema.ts` — prefer generating from the schema so it can't drift; if generation is
  awkward, hand-write and assert column parity in a test). Tests:
  - `discoverDue(batchSize)` returns CIDs of `evaluation` `envelope` rows with NO `ok`
    `verdict_envelope_meta` joined by `manifestCid`, AND (for retry rows) `enrichmentStatus IN
    ('pending','retry') AND (nextAttemptAt IS NULL OR nextAttemptAt <= now)`. Seed a mix: an
    un-enriched eval anchor (appears), an eval anchor with an `ok` verdict row (excluded), an eval
    anchor with a `retry` verdict row due now (appears), a `retry` row with `nextAttemptAt` in the
    future (excluded), a `failed` row (excluded). Assert exactly the expected CID set.
  - The discovery statement uses `FOR UPDATE SKIP LOCKED` — assert two concurrent `discoverDue`
    transactions over the same backlog return **disjoint** CID sets (T2.7 covers the fuller
    concurrency case; a minimal two-tx assertion here proves the lock clause is present).
  - `upsertVerdict(...)` inserts a full-field-set row keyed `(requestId, chainId)` and on conflict
    updates **only when `blockNumber >= existing.enrichedAtBlock`** (mirror handlers.ts:1288),
    setting `enrichmentStatus='ok'`. Assert a second call at an older block is a no-op (AC6 building
    block).
  - `markRetry(requestId, chainId, blockNumber, ...)` sets `enrichmentStatus='retry'`,
    `retryCount=retryCount+1`, `nextAttemptAt=now+backoff`; after `retryCount >= maxRetries` sets
    `enrichmentStatus='failed'` (terminal).
- **Implementation:** `EnrichmentStore` class. Constructor takes a Drizzle instance (so tests inject
  PGlite-backed Drizzle, production injects `node-postgres`-backed Drizzle). **All reads/writes
  schema-qualified by `DATABASE_SCHEMA`** — set the Drizzle schema or `SET search_path` per
  connection; the worker writes ONLY `verdict_envelope_meta` and reads `envelope` +
  `verdict_envelope_meta`. **Tolerate schema-not-yet-exists** (fresh deploy / O3): a query against a
  missing schema must be caught and surfaced as "not ready, back off," not crash the process.
- **Done when:** db tests pass against PGlite; the worker writes only `verdict_envelope_meta`.

### T2.4 — `src/enrich.ts` (claim → fetch → parse → write, one batch)

- **Test first:** `test/enrich.test.ts` against PGlite + stubbed `FetchLike` (the `ipfs.ts` seam).
  Seed an `evaluation` anchor for a CID; stub the gateway to return a swe-rebench-v2 verdict body
  (and, for the task fetch, a `task.v1` body with `spec.instance_id` + `solverNetManifestCid`).
  Assert after `runOnce`:
  - `verdict_envelope_meta` has one row keyed by the body's `requestId` with the **five #669 fields**
    (`instanceId`, `solverNetManifestCid`, `actualPassed`, `actualScore`, `evaluatorVerdict`) plus
    `passedCount`/`totalCount` populated, `enrichmentStatus='ok'`, `enrichedAtBlock` =
    the anchor's `publishedAtBlock`.
  - A non-swe-rebench-v2 verdict body enriches WITHOUT a task-body fetch (assert the task-fetch stub
    was not called for that CID) and leaves `instanceId=''` — matching the handler's gating.
  - A verdict-body fetch that throws leaves NO `verdict_envelope_meta` row (we have no `requestId`);
    the anchor stays un-enriched and reappears in the next `discoverDue` (natural retry — design
    §4). Assert the row count stays 0 and the CID is re-discoverable.
  - A verdict body that parses but whose **task-body fetch fails** writes a `retry` row (we DO have
    `requestId` by then): assert `enrichmentStatus='retry'`, `retryCount=1`, `nextAttemptAt` set.
    This is the partially-enriched backoff path from design §4.
- **Implementation:** `enrichBatch(store, deps)`: `store.discoverDue(batchSize)` →
  for each CID: `fetchIpfsJson(gateway, cid)` → `parseVerdictEnvelopeLite(body)` (shared module) → if
  swe-rebench-v2 + `taskCid`: `fetchIpfsJson(gateway, taskCid)` → `resolveInstanceFields(taskBody)`
  (shared module) → `store.upsertVerdict({...})`. On verdict-fetch throw: no write (re-discovery). On
  task-fetch throw after a parsed verdict: `store.markRetry(...)`. **The enrichment field-mapping must
  call the SAME shared functions the handler uses** — that is the anti-drift contract.
- **`enrichedAtBlock` source:** the worker reads the anchor's `publishedAtBlock` from the `envelope`
  row (discovery returns it) and uses it as `enrichedAtBlock`, so the worker's most-recent-wins guard
  is comparable with the handler's (when both could write). Confirm `envelope.publishedAtBlock` is the
  right block — it is the MetadataSet block, same one the handler passes as `enrichedAtBlock`.
- **Done when:** enrich tests pass; the five #669 fields + status are written; failure modes behave
  as specified.

### T2.5 — Idempotency (AC6) explicit test

- **Test:** seed an already-`ok` `verdict_envelope_meta` row + its `evaluation` anchor. Run
  `enrichBatch` twice. Assert:
  - `discoverDue` does NOT return the CID (the `ok` row excludes it from the left-anti-join) — so the
    worker never even fetches it.
  - If the worker is forced to upsert at an older/equal block (call `upsertVerdict` directly), the
    `enrichedAtBlock`-guarded update branch leaves the row **field-for-field unchanged**.
  - Run the full `enrichBatch` against an all-`ok` backlog: zero fetches, zero writes, zero status
    changes.
- **Done when:** AC6 test green — re-running against an `ok` row is a provable no-op two ways
  (excluded from discovery + guarded upsert).

### T2.6 — #669 partial-enrichment guard (AC4)

- **Test:** for a swe-rebench-v2 verdict where the verdict body parses but the **task body lacks
  `instance_id`** (or the task fetch fails), assert the worker does NOT write `enrichmentStatus='ok'`
  with an empty `instanceId` that would leak into `getInstanceSuccessCounts`. Two acceptable
  behaviors — pick to match the handler's current semantics (verify against handlers.ts:1238-1262):
  the handler writes `enrichmentStatus='ok'` with `instanceId=''` on task-fetch failure (graceful
  degrade — the launcher's `instanceId_not:""` filter then simply excludes it). **Match that:** the
  worker writes `ok` with `instanceId=''`; the `instanceId_not:""` filter keeps it out of success
  counts. Assert the written row has `instanceId=''` and would be filtered. **Do NOT invent stricter
  behavior** than the handler — AC4 is "filter shape unchanged + property holds," and the property
  holds because the empty-`instanceId` row is filtered, exactly as today.
  - Cross-check the design's stated intent (§AC4: "only flips `enrichmentStatus` to `'ok'` after both
    the verdict and the task body have resolved"). **This conflicts with the handler's actual
    graceful-degrade behavior** (handler writes `ok` even when the task fetch fails, leaving
    `instanceId=''`). **Resolve in favor of matching the handler** (behavior-preserving refactor is
    the #779 mandate) and note the discrepancy in the PR. If a stricter "only ok when instanceId
    populated" is desired, that is a separate behavior change requiring its own issue.
- **Done when:** the worker's partial-enrichment behavior provably matches the handler's, and the
  `instanceId_not:""` filter still suppresses partial rows from success counts.

### T2.7 — `src/http.ts` + read-path-isolation integration test (AC3)

- **`src/http.ts`:** mirror claim-relayer's `/health` (always 200), `/ready` (200 once the worker has
  connected to the DB + done its first poll, 503 before), `/status` (JSON: uptime, redacted config,
  batch stats — discovered/enriched/retried/failed counts, last error). Test `test/http.test.ts`
  mirroring claim-relayer/test/http.test.ts (route + status codes).
- **AC3 integration test** — `test/read-path-isolation.test.ts`. This is the headline #779 proof.
  Two viable shapes; **prefer the lighter one** and document the choice:
  - **Preferred (lightweight):** spin up PGlite seeded with a large `pending` evaluation backlog
    (e.g. 500 anchors), point a minimal GraphQL-ish read endpoint OR a direct Drizzle read at the
    same PGlite, start the worker's poll loop against that DB with a **slow/blocking IPFS stub**
    (each fetch sleeps), then fire 40 concurrent reads of `verdict_envelope_meta` and assert all 40
    resolve successfully (the analog of "all 200") while the worker is mid-backlog. The point is that
    reads are not serialized behind enrichment — which, because the worker is a *separate event loop /
    process boundary*, is structurally guaranteed; the test documents and locks that guarantee.
  - **Heavier (only if the lightweight version can't represent "/graphql 200"):** boot `ponder serve`
    against a real Postgres with the backlog and fire 40 `/graphql` HTTP probes. This needs a real
    Postgres container + ponder boot in CI — higher cost and flake risk. **Default to the lightweight
    version**; record in the PR that AC3's "40 × 200" is proven at the DB-isolation layer because the
    worker shares no event loop with the read path (the actual mechanism that fixes the 502).
- **`src/index.ts`** (bin entry + poll loop): mirror claim-relayer's `index.ts`/`relayer.ts` shape —
  `loadConfig` → build Drizzle (`node-postgres` Pool) → `EnrichmentStore` → first `enrichBatch` →
  `setTimeout`-scheduled ticks (NOT `setInterval`; re-entrancy guard like
  `relayer.runOnce`'s `runInFlight`) → `/health`+`/ready`+`/status` server → SIGINT/SIGTERM shutdown
  closing the pool + server. **Guard the boot path** (the #1068 lesson in memory): a DB-connect failure
  must loud-log and exit non-zero (so Railway `ON_FAILURE` restarts), never silently wedge.
- **Done when:** http tests pass; the AC3 isolation test passes; `src/index.ts` typechecks and the
  poll loop has a re-entrancy guard + observable `/status`.

**Layer 2 exit criteria:** `cd packages/indexer-enrichment && yarn install --immutable && yarn typecheck && yarn test && yarn build`
all green. The indexer is untouched at runtime (`enrichEnvelopes` still defaults `true`); the worker
is exercised only by its own tests.

---

## 5. LAYER 3 — Cutover flag

### T3.1 — Flip the production default to anchor-only

- **Implementation:** `packages/indexer/src/index.ts:42-44`. Change the default so the verdict path
  is **anchor-only unless explicitly opted in**. Two design-faithful options — pick and document:
  - (a) Invert the default: `enrichEnvelopes` is `false` unless `JINN_INDEXER_ENRICH_ENVELOPES` is
    explicitly `'true'`/`'1'`. Simplest; matches design §3 "Default ... to `false`." **But** this also
    turns off the `attemptEnvelopeMeta` (execution) and `solverNetManifest` enrichment that share the
    same flag — which #779 does NOT scope. **Therefore (a) is too broad.**
  - (b) **Preferred — split the flag's reach for the verdict path only.** Keep `enrichEnvelopes`
    governing the execution/manifest/checkpoint enrichment at its current default (`true`), and add a
    narrow gate for the *evaluation* branch so the verdict path defaults to anchor-only. Cleanest: the
    handler's evaluation block (handlers.ts:1215) becomes gated by a verdict-specific resolution of
    the flag. Concretely, pass a second boolean `enrichVerdicts` (default `false`) into
    `handleMetadataSet`, wired in `index.ts` from the SAME `JINN_INDEXER_ENRICH_ENVELOPES` env but
    defaulting OFF: `enrichVerdicts = env === 'true' || env === '1'`. This honors the design's
    "reuse the existing flag" (no new env var) while scoping the cutover to verdicts only, leaving
    execution-envelope enrichment behavior unchanged (out of #779 scope). **Update the doc comments**
    in `index.ts` (38-47), `ponder.config.ts` (~28), and `deploy/README.md` (~136) to describe the
    flag's new dual meaning: `=true` → in-handler verdict enrichment (legacy/rollback); unset/`=false`
    → handler writes verdict anchors only, the enrichment worker owns verdict enrichment.
  - **Decision required at implementation:** confirm with the design intent that ONLY the verdict
    (evaluation) path cuts over in #779 (the design's Problem §21 says execution/checkpoint/manifest
    are "follow-ups that reuse the same machinery"). Therefore option (b) is correct — do NOT cut over
    execution-envelope enrichment in this PR.
- **Test first:** the parametric AC5 test (T3.2) drives this.
- **Done when:** with the env unset, `handleMetadataSet` on an `evaluation:` key does no verdict IPFS
  fetch and writes only the anchor; with `JINN_INDEXER_ENRICH_ENVELOPES=true` it enriches in-handler
  exactly as before; execution-envelope (`envelope:` key) enrichment is **unchanged** by this task.

### T3.2 — Parametric reversibility test (AC5) + AC1 timing under the new default

- **Test:** in `handlers.test.ts`, a parametric test over the new `enrichVerdicts ∈ {true,false}`
  (or however T3.1 wired it):
  - `false` (new default): `evaluation:` key → `called===false`, `verdictEnvelopeMeta count===0`,
    `envelope` anchor present, sub-10ms (AC1 + AC5-off).
  - `true` (rollback): `evaluation:` key with the swe-rebench stub → `verdictEnvelopeMeta` row written
    with `enrichmentStatus='ok'` and the five fields (AC5-on) — this is the existing
    `writes a verdictEnvelopeMeta row on successful fetch + parse` test (1617-1658) re-pointed at the
    explicit `enrichVerdicts:true`.
  - Assert the existing execution-envelope enrichment tests (1001+ "enrichEnvelopes: false" /
    attemptEnvelopeMeta cases) are **unchanged** — proving #779 didn't disturb the out-of-scope path.
- **Done when:** AC5 parametric test green; AC1 timing assertion holds under the new default; all
  pre-existing handler tests (execution path + #530 + manifest) stay green.

**Layer 3 exit criteria:** `cd packages/indexer && yarn typecheck && yarn test && yarn build` green;
`cd client && yarn test` (the AC4 launcher-filter tests) green. The handler now defaults to verdict
anchor-only; the worker owns verdict enrichment; the flag is a clean documented rollback.

---

## 6. LAYER 4 — Deploy artifacts (ship, do not provision)

No Railway service is stood up in this PR. Ship the artifacts and the CI gate; an operator provisions
later via the indexer's `deploy/README.md` conventions.

### T4.1 — `deploy/Dockerfile` (worker image)

- **New file:** `packages/indexer-enrichment/deploy/Dockerfile`. Model on the **indexer's**
  Dockerfile, NOT claim-relayer's — because the worker has `portal:` siblings (`indexer`, `sdk`) that
  must be COPYed into the build context. Build context is `packages/` (so the Dockerfile can COPY
  `sdk/`, `indexer/`, and `indexer-enrichment/`). Build the sdk + indexer's `enrichment-parse`/schema
  as needed, then the worker. Multi-stage (build → slim runtime), `CMD ["node", "dist/index.js"]`,
  `EXPOSE` the worker port (e.g. 8738). Mirror the indexer's `corepack enable && yarn install
  --immutable` + portal-resolution approach.
- **Done when:** the Dockerfile builds locally with context `packages/`
  (`docker build -f indexer-enrichment/deploy/Dockerfile -t jinn-enrichment-worker:ci .` from
  `packages/`). If Docker is unavailable in the sandbox, the CI `docker` job (T4.3) is the gate.

### T4.2 — `deploy/railway.toml` + worker README

- **New file:** `packages/indexer-enrichment/deploy/railway.toml`. Copy the indexer's structure
  (builder = DOCKERFILE, `dockerfilePath = "indexer-enrichment/deploy/Dockerfile"` relative to Root
  Directory `/packages`, `watchPatterns = ["packages/indexer-enrichment/**", "packages/indexer/**",
  "packages/sdk/**"]`, `/ready` healthcheck, `ON_FAILURE` restart). **#846 guardrail:** this file
  MUST live under `packages/indexer-enrichment/deploy/` — NEVER add a repo-root `railway.toml`. Add
  the same guardrail comment block the indexer's railway.toml carries.
- **New file:** `packages/indexer-enrichment/README.md`. Document: purpose (off-loads verdict
  enrichment per #779); the shared-schema write coupling + O2 risk note (worker imports
  `ponder.schema.ts` for compile-time coupling; writes only `verdict_envelope_meta`'s application
  columns); the env it shares with the indexer (`DATABASE_URL`, `DATABASE_SCHEMA`,
  `JINN_IPFS_GATEWAY_URL`) + worker knobs (`JINN_ENRICHMENT_*`); **the O3 deploy-runbook note** — on a
  `DATABASE_SCHEMA` bump (views-pattern cutover, or the T1.2 column-add re-sync) the worker's
  `DATABASE_SCHEMA` env must be repointed and the worker restarted together with the indexer; **the
  O4 backfill note** — first deploy drains the full historical un-enriched backlog at
  `batchSize` × `pollIntervalMs` rate (tune to avoid an IPFS-gateway / Postgres write storm).
- **Done when:** files exist, railway.toml passes the #846 guardrail (no root-level railway.toml in
  the diff — grep the diff to confirm), README covers O2/O3/O4.

### T4.3 — `indexer-enrichment-ci.yml`

- **New file:** `.github/workflows/indexer-enrichment-ci.yml`. Model on `indexer-ci.yml`: a `worker`
  job (build sdk + indexer's consumed sources, then `yarn install --immutable && yarn typecheck &&
  yarn test && yarn build` in `packages/indexer-enrichment`) and a `docker` job
  (`docker build -f indexer-enrichment/deploy/Dockerfile .` from `packages/`). `paths:` filter on
  `packages/indexer-enrichment/**`, `packages/indexer/**`, `packages/sdk/**`, and the workflow file.
  (claim-relayer has no CI; this worker gets one because it has a real DB contract surface and a
  Docker build.)
- **Done when:** the workflow file is valid YAML and its `paths`/jobs mirror `indexer-ci.yml`.

**Layer 4 exit criteria:** deploy artifacts + CI present; no repo-root railway.toml; README documents
the deploy/runbook caveats. Nothing is provisioned.

---

## 7. Verification commands (final-stage gate)

Run from the worktree root unless noted. `yarn install` may need network in the sandbox; CI is the
authoritative gate.

**Indexer (Layers 1 & 3):**
```
cd packages/sdk && yarn install --immutable && yarn build
cd packages/indexer && yarn install --immutable && yarn codegen && yarn typecheck && yarn test && yarn build
```

**New worker (Layer 2 & 4):**
```
cd packages/indexer-enrichment && yarn install --immutable && yarn typecheck && yarn test && yarn build
# Docker (if available):
cd packages && docker build -f indexer-enrichment/deploy/Dockerfile -t jinn-enrichment-worker:ci .
```

**Launcher anti-farming (AC4):**
```
cd client && yarn install --immutable && yarn test test/discovery/http.test.ts
```

**Guardrail check (AC: #846):**
```
git -C "<worktree>" diff --name-only main... | grep -E '^railway\.toml$' && echo "FAIL: repo-root railway.toml" || echo "ok: no repo-root railway.toml"
```

**AC-to-test cross-check (must all be green):**
- AC1 → T1.3 / T3.2 (no-fetch + sub-10ms + anchor present)
- AC2 → T2.4 / T2.5 (worker writes full field set on `pending`/`retry`)
- AC3 → T2.7 read-path-isolation
- AC4 → T1.1 (kept-green launcher-filter test) + T2.6 (partial-enrichment matches handler)
- AC5 → T3.2 parametric
- AC6 → T2.5 idempotent re-run

---

## 8. Tests that MUST stay green (regression guards)

- `packages/indexer/test/handlers.test.ts` — the entire file, especially:
  - `does NOT fetch or write when enrichEnvelopes:false` (1681) — the AC1/AC5 seed.
  - `writes a verdictEnvelopeMeta row on successful fetch + parse` (1617) — re-pointed to
    `enrichVerdicts:true` (rollback path) in T3.2, must still pass.
  - `populates instanceId and solverNetManifestCid from the task IPFS body` (1791) — proves
    `resolveInstanceFields` parity after extraction (T1.4).
  - the `parseVerdictEnvelopeLite` direct unit tests (1479-1596) — proves the extraction (T1.4) is
    behavior-preserving.
  - the execution-envelope / `attemptEnvelopeMeta` tests (1001+) and #530 verdict-finalization tests
    — prove #779's verdict-only cutover did NOT disturb out-of-scope paths.
- `client/test/discovery/http.test.ts` — the `getInstanceSuccessCounts` / `INSTANCE_SUCCESS_COUNTS_QUERY`
  filter tests (#669 anti-farming, AC4). **Unchanged.**

---

## 9. Risks & escalation triggers (do not hack around these)

- **R1 — indexer schema not standalone-importable (T2.1).** If `ponder.schema.ts` cannot be imported
  outside the ponder runtime (because `onchainTable` pulls ponder internals at module load), the
  worker can't type its writes against the real schema. **Escalate** — this is the O1/O2 fork point:
  it may justify the deferred CID-keyed `enrichment_queue` side table or a generated DDL artifact.
  Do not silently hand-mirror columns and hope they stay in sync.
- **R2 — Drizzle version skew.** The worker MUST pin `drizzle-orm` to the indexer's exact version
  (`^0.45.2`). A mismatch can silently change column mapping for the shared schema. Verify the
  resolved version matches.
- **R3 — AC4 behavior interpretation (T2.6).** The design says "ok only after both resolve"; the
  handler actually writes `ok` with `instanceId=''` on task-fetch failure (graceful degrade). The
  refactor mandate wins: **match the handler.** If a behavior change is wanted, file a separate issue.
- **R4 — AC3 test shape.** Default to the lightweight DB-isolation test; only boot `ponder serve` +
  real Postgres if a reviewer insists on a literal `/graphql` HTTP probe. Record the choice.
- **R5 — column-add requires re-sync (T1.2 / O3).** Adding `retryCount`/`nextAttemptAt` to an
  `onchainTable` needs a `DATABASE_SCHEMA` bump at deploy (Ponder won't online-migrate). This is a
  runbook note (T4.2), but flag it loudly in the PR so the operator sequences the deploy correctly:
  schema-bump the indexer, let it re-sync, then point + start the worker at the new schema.
