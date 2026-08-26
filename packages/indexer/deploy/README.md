# Deploying `@jinn-network/indexer`

This is a **standard Ponder deployment**. The patterns here come directly from Ponder's [Self-hosting docs](https://ponder.sh/docs/production/self-hosting); we have not invented any custom subsystems on top.

## Railway production service (`jinn-indexer`, config-as-code)

The live `jinn-indexer-production` service auto-deploys from `next`. Its build/deploy
config is pinned in [`railway.toml`](./railway.toml) (config-as-code) so it cannot
silently drift in the dashboard — drift to the RAILPACK auto-builder is what broke
the indexer on 2026-06-02 (RAILPACK can't resolve the indexer's portal siblings →
every deploy failed at `yarn install`, freezing the live code on stale commit
`57d6e610` for ~21 deploys while the last-good container kept serving).

`railway.toml` pins: the **Dockerfile** builder (`dockerfilePath = indexer/deploy/Dockerfile`,
relative to the `/packages` Root Directory — the build context the Dockerfile needs to
`COPY` the indexer tree and its portal siblings: `task-execution/protocol`,
`trust/core`, and `benchmarking/records`); **watch paths** scoped to those trees plus
`packages/indexer/**` so unrelated `next` merges (client SPA, dashboard, eval, …)
stop redeploying the indexer;
and a **`/ready` healthcheck** so a redeploy gates traffic cutover on the new container being
caught-up-to-realtime (the missing healthcheck was the "indexer goes down momentarily when I
merge a batch of PRs" symptom — every push redeployed, and cutover happened before the process
was up). `/ready` rather than `/health` because the daemon discovery layer probes `/ready`; the
old container keeps serving until the new one is `/ready`, so daemons never hit
`DiscoveryUnavailableError`. Verified zero-downtime on 2026-06-03 (deploy `b7f25e05`: 0 non-200
across the full build + cutover).

**One-time service settings (not expressible in `railway.toml`), set once via dashboard or API:**

- **Root Directory** → `/packages`
- **Config as code** → `packages/indexer/deploy/railway.toml` — set 2026-06-03; this file is now authoritative for the service's build/deploy config.

⚠️ **#846:** never move `railway.toml` to the repo root — a root `railway.toml` is applied
by Railway to *every* monorepo service and hijacks their build configs. Keep it here.

**Watch-path base — confirmed repo-root-relative (2026-06-03).** `watchPatterns` use `packages/...`
paths anchored at the repo root (note this differs from `dockerfilePath`, which is relative to the
`/packages` Root Directory). Confirmed via a real merge-batch: a non-indexer merge (#952) was
`SKIPPED` by Railway, while an indexer-touching merge (#998, `packages/indexer/deploy/**`) produced
a real Dockerfile build that reached `/ready` before a zero-downtime cutover. If you ever change the
Root Directory, **re-confirm** with the check below — and note the
[`indexer-monitor`](../../../.github/workflows/indexer-monitor.yml) workflow (#548) watches **data
freshness, not deployed-code version**, so a wrong base (→ the indexer silently stops auto-deploying
its own changes) would not raise an alert.

**Watch-path check** (to re-confirm after any Root Directory change):

1. A merge to `next` touching only `client/**` or docs → the indexer must **not** redeploy (Railway marks it `SKIPPED`).
2. A merge touching `packages/indexer/**` → the indexer **must** redeploy, build via the
   Dockerfile (build log shows the multi-stage `[build N/16]` / `[stage-1]` steps, not
   `[railpack]`), and reach `/ready` before cutover.

If (2) does not auto-deploy, the base is rootDirectory-relative → set `watchPatterns` to
`["indexer/**", "sdk/**"]` and re-check.

## Required infrastructure

- **Postgres database** (managed or self-hosted). Same private network as the indexer process — Ponder's docs warn that round-trip latency above 50ms causes performance problems.
- **RPC endpoint(s)** for the chains being indexed. A HyperSync-backed URL (e.g. from [Envio](https://envio.dev)) is the fastest option for cold-start sync; Ponder treats it as a standard JSON-RPC endpoint, so no special config is needed beyond putting the URL in `PONDER_RPC_URL_*`.
- **Container runtime** (Docker, k8s, fly.io, Railway — anything that can run a Node 22 image).

## First deployment

1. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — Postgres connection string
   - `PONDER_RPC_URL_*` — RPC endpoints
   - `DATABASE_SCHEMA` — **leave unset.** It is auto-derived at boot from a hash of `ponder.schema.ts` (see §Automated schema derivation below). Only set it, together with `JINN_INDEXER_SCHEMA_AUTO=false`, if you deliberately want to pin a name.
2. `docker build -t jinn-indexer:latest -f deploy/Dockerfile .` from `packages/indexer/`.
3. `docker run --env-file deploy/.env -p 42069:42069 jinn-indexer:latest`.
4. Wait for `/ready` to return 200 — this means indexing has caught up to realtime.
5. Verify with `curl localhost:42069/graphql` (should return a GraphQL response).

## Endpoints

### Built-in Ponder endpoints

- `/graphql` — auto-generated GraphQL endpoint over the schema. This is the daemon's primary read path (`client/src/discovery-client/http.ts` hits `<indexer-url>/graphql`).
- `/health` — returns 200 immediately after the process starts. Use for liveness checks.
- `/ready` — returns 200 once indexing has reached realtime across all chains. Use for readiness checks and as the gate before swapping a load balancer onto a new deployment.

### Explorer endpoints (custom Hono routes, mounted alongside GraphQL)

Starting from `ebu7.5`, the indexer also serves the **Jinn network explorer** — anyone running `@jinn-network/indexer` serves an explorer for free. See `docs/superpowers/specs/2026-05-12-network-explorer-design.md` §3 for the architectural rationale.

- `/` — the network explorer SPA (React/Vite, built from `packages/indexer/explorer/`, output to `packages/indexer/public/` and served statically; deep links like `/solvernet/<cid>` and `/operator/<addr>` are SPA-fallback-served `index.html`). The canonical explorer URL is `<indexer-host>/`. The explorer build runs as part of `yarn build` (`ponder codegen && yarn build:explorer`) and in the Dockerfile; if `public/index.html` is absent (no frontend build), `/` falls back to a minimal placeholder page so the indexer is never broken. Built assets are under `/assets/*` (immutable-hashed, long-cacheable).
- `/explorer/network` — fleet-wide KPI bundle (tasks, attempts, operators, verdicts, resolved rate, JINN distributed, freshness) plus `composition` (share of attempts by mode train/frozen and by harness `implName`) and `enrichmentCoverage` (how many attempts have envelope metadata yet).
- `/explorer/solvernets` — one row per indexed SolverNetManifest with rollup stats (batched query).
- `/explorer/solvernet/:cid` — per-SolverNet KPIs + learning-curve time series (`?bucket=<blocks>`, `?k=<rolling-window>`, `?minVerdicts=<n>`) plus `trainBoard`/`frozenBoard` (operator leaderboards split by mode), `checkpointTimeline` (published HarnessCheckpoint anchors), and `freezeIntegrity` (codeDigest-drift violations + verified-frozen share).
- `/explorer/operators` — quality-first operator leaderboard (`?minVerdicts=<n>`, `?mode=train|frozen`, `?harness=<implName>`); each row carries `dominantMode`/`dominantHarness`.
- `/explorer/operator/:addr` — one operator across all SolverNets they participate in, with `dominantMode`/`dominantHarness`/`dominantSolverType` and per-SolverNet mode breakdowns.

The `/explorer/*` routes set `Cache-Control: public, max-age=30, stale-while-revalidate=60` and an `ETag` keyed on `lastIndexedBlock`, so a CDN absorbs traffic spikes. CDN-fronting is recommended for public deployments. (`behindHead` in the freshness block is currently always `null` — wiring it to a real chain-head RPC call is a tracked follow-up.)

**GraphQL is at `/graphql` only** — the daemon already uses `/graphql`, so no client change is needed following this move. The root path `/` now serves the explorer page instead of a GraphQL catch-all.

### Monitoring (`/health/task-coverage`)

`GET /health/task-coverage` is an operator-facing health probe added in response to issue #567 (the indexer's `TaskCreated` handler silently stopping). It resolves the active JinnRouter's `taskCoordinator()` view, reads that TaskCoordinator contract's authoritative on-chain `nextTaskId()` view (the storage slot is on `TaskCoordinator`, not JinnRouter), compares it against the indexer's `max(task.id)` and `max(attempt.taskId)`, and returns 200 when both gaps are within the configured threshold, 503 otherwise.

```
GET /health/task-coverage
```

Response shape (JSON):

```json
{
  "chainId": 84532,
  "onchainNextTaskId": "1234",
  "maxIndexedTaskId": "1233",
  "maxAttemptTaskId": "1230",
  "taskGap": 0,
  "attemptGap": 3,
  "status": "ok",
  "httpStatus": 200
}
```

- `taskGap = (onchainNextTaskId - 1) - maxIndexedTaskId` (the same shape for `attemptGap`).
- `status: 'ok'` (HTTP 200) when both gaps ≤ threshold.
- `status: 'degraded'` (HTTP 503) when either gap exceeds the threshold — the issue-#567 symptom.
- `status: 'unknown'` (HTTP 503) when the on-chain RPC is unavailable (so we cannot decide).
- Bigint values are serialised as decimal strings; `null` passes through when the indexer has no rows yet or the RPC failed.

The on-chain lookup is cached for 60 s (both success and null results, to avoid retry-storming a degraded RPC), so this probe is safe to wire into a 10 s monitoring loop.

Configuration:

- `JINN_TASK_COVERAGE_GAP_THRESHOLD` — integer, default `5`. The maximum gap allowed before the route returns 503. Set to a higher value if your `PONDER_RPC_URL_84532` latency keeps the indexer naturally a few blocks behind realtime.

#### #1304 tokenless deployment alignment note

The original "GraphQL serves 0 tasks" symptom no longer reproduces on production: raw GraphQL returns operator Safe tasks for the active Base Sepolia router `0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247`. The active causes found during #1304 were deployment-alignment defects:

- `/health/task-coverage` was reading a stale hard-coded coordinator instead of resolving `taskCoordinator()` from the active router, so the route returned `status: "unknown"` even when indexed tasks existed.
- The tokenless router no longer emits `requiredVerdicts`; `TaskCoordinator.recordVerdict` finalizes on the first delivered verdict, but old indexer rows persisted the missing value as `0` and never finalized.

Fixing existing bad rows requires a fresh data schema + re-sync so `TaskCreated` rows are re-folded with `requiredVerdicts = 1`. A `ponder.schema.ts` change already re-hashes to a new schema automatically (§Automated schema derivation); to force a re-sync without a schema change, pin `JINN_INDEXER_SCHEMA_AUTO=false` + a new explicit `DATABASE_SCHEMA` on both services. The verdict handler also normalizes existing non-positive rows during replay, but the deployment answer should be a fresh schema plus re-sync for legible state.

Post-deploy smoke for this class of issue:

1. Deploy the indexer and enrichment worker; both auto-derive the same `DATABASE_SCHEMA` from `ponder.schema.ts` (§Automated schema derivation).
2. Wait for `/ready` to return 200 before traffic cutover.
3. Verify `/health/task-coverage` returns 200 with `status: "ok"` and `taskGap` near 0.
4. Verify `/graphql` returns non-empty `task` rows for the active router/operator scope being tested.
5. Verify the daemon discovers claimable attempts and the first delivered verdict finalizes a task on the trimmed tokenless stack.

### Envelope enrichment (`JINN_INDEXER_ENRICH_ENVELOPES`, `JINN_IPFS_GATEWAY_URL`)

The harness/mode/plugin/model facets, the train/frozen leaderboard split, the checkpoint timeline, and freeze integrity come from an **IPFS-enrichment step**: for each indexed `envelope:<cid>` (execution evidence), the `MetadataSet` handler fetches the envelope body from an IPFS gateway and projects its `executor` block into the `attemptEnvelopeMeta` table (joined to attempts by `requestId`). It's resilient — a fetch/parse failure for one envelope is logged and skipped (Ponder reprocesses on the next sync), never crashes the indexer.

**The verdict (evaluation) path was split off in-handler by #779.** `JINN_INDEXER_ENRICH_ENVELOPES` now has a dual meaning:

- The **execution** path (`envelope:<cid>` → `attemptEnvelopeMeta`), the `solverNetManifest` body, and the `harnessCheckpoint` manifest still enrich **in-handler, default ON** — `false`/`0` skips them.
- The **evaluation** path (`evaluation:<cid>` → `verdictEnvelopeMeta`) now defaults to **anchor-only in-handler** (the `MetadataSet` handler writes the `envelope` anchor and returns — no verdict IPFS fetch). The IPFS-bound verdict enrichment is owned by the standalone **enrichment worker** (`packages/indexer-enrichment`), so a verdict-enrichment backlog can no longer starve `/graphql` (the 502 incident). Set `JINN_INDEXER_ENRICH_ENVELOPES=true` (or `1`) to restore in-handler verdict enrichment — the documented rollback lever.

- `JINN_INDEXER_ENRICH_ENVELOPES` — default `true` for the execution/manifest/checkpoint paths; the verdict path is OFF unless this is explicitly `true`/`1`.
- `JINN_IPFS_GATEWAY_URL` — default `https://gateway.autonolas.tech`. The gateway used for envelope fetches; the base is normalized to end with `/ipfs/`. **Shared with the enrichment worker.**

The historical sync is noticeably slower with execution enrichment on (one IPFS round-trip per execution envelope). If that's a problem, either run a faster (HyperSync-backed) RPC, or set `JINN_INDEXER_ENRICH_ENVELOPES=false` and accept that the enriched facets won't populate — note that Ponder won't backfill enrichment after the fact, so flipping it on later requires a re-sync (`DATABASE_SCHEMA` bump). `HarnessCheckpoint` anchors are indexed on-chain (key prefix `harness.checkpoint:`); their manifest bodies (codeDigest, parentCid, implStateDirCid) are not yet fetched, so per-checkpoint frozen-eval scores are pending — a tracked follow-up.

**Deploy sequencing with the enrichment worker (#779, #1429):** the verdict path is enriched by `packages/indexer-enrichment`, a separate Railway service on the **same** `DATABASE_URL` + `DATABASE_SCHEMA`. Adding the worker's `retryCount`/`nextAttemptAt` columns to `verdict_envelope_meta` is an `onchainTable` change (Ponder does not online-migrate), so it needs a fresh data schema + re-sync — but this is now **automatic**: both services derive `DATABASE_SCHEMA` from the byte-identical `ponder.schema.ts` (§Automated schema derivation), so they resolve the same `jinn_indexer_<hash>` name with no manual coordination. If you pin a name (`JINN_INDEXER_SCHEMA_AUTO=false`), set the identical `DATABASE_SCHEMA` on **both** services. See `packages/indexer-enrichment/README.md` for the worker's env, the O2/O3/O4 caveats, and the backfill-drain note.

## Automated schema derivation (#1429)

A `ponder.schema.ts` change to an `onchainTable` needs a fresh Ponder data schema — Ponder does not online-migrate, so reusing the old schema name after a schema change crash-loops the new container (`MigrationError: Schema "..." was previously used by a different Ponder app`) while the stale one keeps serving. This used to require a manual Railway `DATABASE_SCHEMA` bump per schema PR, and forgetting it was a silent failure (issue #1429).

`DATABASE_SCHEMA` is now **auto-derived at container boot** from a content hash of `ponder.schema.ts`:

- **Mechanism.** `deploy/derive-schema.mjs` computes `jinn_indexer_<sha256(ponder.schema.ts)[:8]>` and prints it to stdout; both Dockerfile CMDs capture it into `DATABASE_SCHEMA` before `exec`-ing the process (`export DATABASE_SCHEMA="$(node deploy/derive-schema.mjs)" && exec …`). An unchanged schema hashes to the same name → the deployment resumes in place. Any change → a fresh namespace → a clean re-sync, automatically.
- **Two entrypoints, one file.** The indexer image and the enrichment worker image (`packages/indexer-enrichment`) both COPY the byte-identical `indexer/ponder.schema.ts` and `indexer/deploy/derive-schema.mjs`, so they derive matching names and always write into the same schema — no manual coordination.
- **Boot log line.** Each container logs (to stderr) `[schema] auto-derived DATABASE_SCHEMA=jinn_indexer_<hash> from ponder.schema.ts` (or `[schema] using operator-set DATABASE_SCHEMA=<name> (JINN_INDEXER_SCHEMA_AUTO=false)`). Grep this in Railway logs to learn the resolved name for the recovery commands below.
- **Views schema unchanged.** `--views-schema=jinn_indexer` is unaffected; a hash-named data schema can never equal the literal `jinn_indexer` views schema.
- **Override.** To pin a name, set `JINN_INDEXER_SCHEMA_AUTO=false` and an explicit `DATABASE_SCHEMA` (validated against `/^[A-Za-z_][A-Za-z0-9_]*$/`). Set the **same** pair on both the indexer and the enrichment worker.

## Zero-downtime rolling deploys (the views pattern)

Ponder's canonical approach for re-deploys without operator-visible downtime:

1. Existing deployment runs under some data schema (e.g. `jinn_indexer_<hashA>`). Views in a static "public-facing" schema (`jinn_indexer`) point at that schema's tables.
2. Deploy a version whose `ponder.schema.ts` changed. It auto-derives a fresh data schema (`jinn_indexer_<hashB>`) and indexes from scratch into its own tables; the old deployment keeps serving. (If the schema is **unchanged**, the hash is identical, so the new deployment resumes in place under the same schema — no re-sync.)
3. Wait for `/ready` to return 200 on the new deployment.
4. Run `ponder db create-views --schema=jinn_indexer_<hashB> --views-schema=jinn_indexer` to swap the public-facing views over — or let the CMD do it (below).
5. Decommission the old instance and drop its schema.

The Dockerfile CMD runs `ponder start --views-schema=jinn_indexer`, so step 4 happens automatically: each deployment swaps the public-facing `jinn_indexer` views to its own data schema once `/ready` is 200. The data schema is auto-derived (§Automated schema derivation) — a hash-named schema can never equal the literal `jinn_indexer` views schema, so the historical "data schema collides with views schema" failure is now structurally impossible.

**Scope — what the auto-swap does and does not deliver.** The auto-swap benefits **external SQL consumers** (psql, the recovery procedure below, future read-replicas / BI) and removes the manual `ponder db create-views` footgun (the partial-swap hazard in §The all-entities-atomic view swap). It does **not** itself deliver operator-facing zero-downtime for `/explorer` + `/graphql` — those routes read through Ponder's runtime `db` bound to the running process's own `DATABASE_SCHEMA`, not through the public `jinn_indexer` views. Operator-facing zero-downtime is delivered by `railway.toml`'s `/ready` healthcheck cutover (#998): the old container keeps serving until the new one is `/ready`.

This is the recommended pattern when shipping schema changes that would otherwise require a re-sync. See Ponder's "Self-hosting" docs §"Production deployment" for the canonical recipe.

### The all-entities-atomic view swap

`ponder db create-views` rewrites the views for **every entity in the schema in a single transaction** — there is no per-entity flag. The full set of 9 entities the indexer publishes is:

```
task, attempt, verdict, solverNetManifest,
envelope, pluginPublication, harnessCheckpoint, attemptEnvelopeMeta,
verdictEnvelopeMeta
```

A **partial view swap** is the suspected root cause of issue #567 — the `task` view (and only the `task` view) was left pointing at a stale schema while the rest of the entities advanced, which presented as "the `TaskCreated` handler silently stopped writing rows." If you ever hand-roll the swap (e.g. by issuing `CREATE OR REPLACE VIEW` statements directly), you **must** rewrite all 10 views in the same transaction — anything less can produce the same silent-divergence symptom.

Wire `/health/task-coverage` (see §Monitoring above) into your post-deploy smoke and as a 503-paging probe; it catches the symptom within one cache window (60 s) instead of waiting for a human to notice missing task ids in the explorer.

## Recovery procedure (suspected stuck-view scenario)

If `/health/task-coverage` reports `status: 'degraded'` with a large `taskGap` but the indexer process is healthy (`/health` 200, `/ready` 200, logs show ongoing realtime indexing), the most likely cause is a partial view swap — the public-facing `task` view is pointing at a stale `DATABASE_SCHEMA`.

The recovery commands below need the deployment's **resolved** data schema. Since `DATABASE_SCHEMA` is auto-derived (§Automated schema derivation), read it from the boot log line — grep the Railway logs for `[schema] auto-derived DATABASE_SCHEMA=` (or `[schema] using operator-set DATABASE_SCHEMA=` if a name is pinned). Substitute that value for `<DATABASE_SCHEMA>` below.

Recovery:

1. **Confirm** the divergence is in the views layer, not the indexer:
   - `curl https://<indexer>/health/task-coverage` — note `maxIndexedTaskId` (from the public views) and `onchainNextTaskId`.
   - Query the live indexing schema directly. Obtain the connection string from Railway's service variables (the `DATABASE_URL` environment variable on the `indexer` service) and run: `psql $DATABASE_URL -c 'SELECT max(id::numeric) FROM <DATABASE_SCHEMA>.task;'`. If this number matches `onchainNextTaskId - 1`, the indexer is fine and the views are stuck. If it matches `maxIndexedTaskId`, the indexer itself is behind (continue at step 4 below).
2. **Re-run the view swap** atomically against the current `DATABASE_SCHEMA`:
   ```bash
   ponder db create-views --schema=<DATABASE_SCHEMA> --views-schema=jinn_indexer
   ```
   This rewrites all 10 entity views in a single transaction. Repeat the `/health/task-coverage` curl; the gap should close within one 60 s cache window.
3. **If the gap does not close**, the issue is in the indexing process itself. Continue with the indexer-side recovery:
   - Inspect the process logs for `TaskCreated`-handler errors. The handler is in `packages/indexer/src/handlers.ts`.
   - Bounce the process: a fresh `ponder start` with the same `DATABASE_SCHEMA` resumes from its last checkpoint and will catch up.
4. **Last-resort full re-sync**: force a fresh data schema. The clean way is a trivial `ponder.schema.ts` edit (any content change re-hashes to a new `jinn_indexer_<hash>`), deploy, wait for `/ready`, then perform the views swap as documented above. If you cannot touch the schema, pin `JINN_INDEXER_SCHEMA_AUTO=false` + a new explicit `DATABASE_SCHEMA` on both the indexer and the enrichment worker.

Per the all-entities-atomic note, never re-run a swap that only touches the `task` view — that is the failure mode this recovery procedure exists to undo.

## Scaling

For higher HTTP traffic, separate concerns:

- **One `ponder start` instance** — does the indexing and serves the HTTP API.
- **N `ponder serve` replicas** behind a load balancer — HTTP-only, read from the same Postgres, no indexing work.

The `ponder start` and `ponder serve` instances must use the same `DATABASE_SCHEMA` so the replicas see the indexed data.

## Operational notes

- **Crash recovery is automatic**: a Ponder process that restarts with the same `DATABASE_SCHEMA` resumes from its last checkpoint. No state to manage manually.
- **Cold-start sync time**: depends on the RPC endpoint. With plain RPC against Base mainnet from genesis, expect hours (and high RPC pressure). With a HyperSync-backed URL, expect minutes.
- **Build-info in logs**: `JINN_INDEXER_COMMIT` is passed in as a build arg and surfaces in the process so you can correlate a running instance to a specific commit.

## What this does NOT include

- IPFS snapshot publication or restoration. The indexer syncs from blockchain events; Postgres state is managed by Ponder; rolling deploys go through the views pattern. We do not ship a custom snapshot subsystem.
- Custom snapshot CID commitments on-chain. Not part of the Ponder model.
- Embedded-in-daemon mode. The indexer is a separate service. If a future spec adds an embedded option, it would be a configuration of the daemon process, not anything in this package.
