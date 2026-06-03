# Deploying `@jinn-network/indexer`

This is a **standard Ponder deployment**. The patterns here come directly from Ponder's [Self-hosting docs](https://ponder.sh/docs/production/self-hosting); we have not invented any custom subsystems on top.

## Railway production service (`jinn-indexer`, config-as-code)

The live `jinn-indexer-production` service auto-deploys from `next`. Its build/deploy
config is pinned in [`railway.toml`](./railway.toml) (config-as-code) so it cannot
silently drift in the dashboard — drift to the RAILPACK auto-builder is what broke
the indexer on 2026-06-02 (RAILPACK can't resolve the `@jinn-network/sdk@portal:../sdk`
sibling → every deploy failed at `yarn install`, freezing the live code on stale
commit `57d6e610` for ~21 deploys while the last-good container kept serving).

`railway.toml` pins: the **Dockerfile** builder (`dockerfilePath = indexer/deploy/Dockerfile`,
relative to the `/packages` Root Directory — the build context the Dockerfile needs to
`COPY` the sibling `sdk/`); **watch paths** scoped to `packages/indexer/**` + `packages/sdk/**`
so unrelated `next` merges (client SPA, dashboard, eval, …) stop redeploying the indexer;
and a **`/ready` healthcheck** so a redeploy gates traffic cutover on the new container being
caught-up-to-realtime (the missing healthcheck was the "indexer goes down momentarily when I
merge a batch of PRs" symptom — every push redeployed, and cutover happened before the process
was up). `/ready` rather than `/health` because the daemon discovery layer probes `/ready`; the
old container keeps serving until the new one is `/ready`, so daemons never hit
`DiscoveryUnavailableError`. Verified zero-downtime on 2026-06-03 (deploy `b7f25e05`: 0 non-200
across the full build + cutover).

**One-time service settings (not expressible in `railway.toml`), set once via dashboard or API:**

- **Root Directory** → `/packages`
- **Config as code** → `packages/indexer/deploy/railway.toml`

⚠️ **#846:** never move `railway.toml` to the repo root — a root `railway.toml` is applied
by Railway to *every* monorepo service and hijacks their build configs. Keep it here.

**Verify after enabling** (the watch-paths base is repo-root per Railway's monorepo docs,
but confirm empirically):

1. Merge a PR touching only `client/**` → the indexer must **not** redeploy.
2. Merge a PR touching `packages/indexer/**` → the indexer **must** redeploy, build via the
   Dockerfile (build log shows the multi-stage `[build N/16]` / `[stage-1]` steps, not
   `[railpack]`), and reach `/ready` before cutover.

The freshness/key-health of this service is watched by the [`indexer-monitor`](../../../.github/workflows/indexer-monitor.yml)
workflow (issue #548).

## Required infrastructure

- **Postgres database** (managed or self-hosted). Same private network as the indexer process — Ponder's docs warn that round-trip latency above 50ms causes performance problems.
- **RPC endpoint(s)** for the chains being indexed. A HyperSync-backed URL (e.g. from [Envio](https://envio.dev)) is the fastest option for cold-start sync; Ponder treats it as a standard JSON-RPC endpoint, so no special config is needed beyond putting the URL in `PONDER_RPC_URL_*`.
- **Container runtime** (Docker, k8s, fly.io, Railway — anything that can run a Node 22 image).

## First deployment

1. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — Postgres connection string
   - `DATABASE_SCHEMA` — e.g. `jinn_indexer_v1` (this becomes the schema under which Ponder writes tables; pick a name you can version)
   - `PONDER_RPC_URL_*` — RPC endpoints
2. `docker build -t jinn-indexer:latest -f deploy/Dockerfile .` from `packages/indexer/`.
3. `docker run --env-file deploy/.env -p 42069:42069 jinn-indexer:latest`.
4. Wait for `/ready` to return 200 — this means indexing has caught up to realtime.
5. Verify with `curl localhost:42069/graphql` (should return a GraphQL response).

## Endpoints

### Built-in Ponder endpoints

- `/graphql` — auto-generated GraphQL endpoint over the schema. This is the daemon's primary read path (`client/src/discovery/http.ts` hits `<indexer-url>/graphql`).
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

`GET /health/task-coverage` is an operator-facing health probe added in response to issue #567 (the indexer's `TaskCreated` handler silently stopping). It compares the TaskCoordinator contract's authoritative on-chain `nextTaskId()` view (the storage slot is on `TaskCoordinator`, not JinnRouter — JinnRouterV3 holds a reference to the coordinator but does not re-expose the view) against the indexer's `max(task.id)` and `max(attempt.taskId)` and returns 200 when both gaps are within the configured threshold, 503 otherwise.

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

### Envelope enrichment (`JINN_INDEXER_ENRICH_ENVELOPES`, `JINN_IPFS_GATEWAY_URL`)

The harness/mode/plugin/model facets, the train/frozen leaderboard split, the checkpoint timeline, and freeze integrity come from an **IPFS-enrichment step**: for each indexed `envelope:<cid>` (execution evidence), the `MetadataSet` handler fetches the envelope body from an IPFS gateway and projects its `executor` block into the `attemptEnvelopeMeta` table (joined to attempts by `requestId`). It's resilient — a fetch/parse failure for one envelope is logged and skipped (Ponder reprocesses on the next sync), never crashes the indexer.

- `JINN_INDEXER_ENRICH_ENVELOPES` — default `true`. Set to `false` (or `0`) to skip the per-envelope IPFS fetch and sync faster; the enriched facets above won't populate (the rest of the explorer still works).
- `JINN_IPFS_GATEWAY_URL` — default `https://gateway.autonolas.tech`. The gateway used for envelope fetches; the base is normalized to end with `/ipfs/`.

The historical sync is noticeably slower with enrichment on (one IPFS round-trip per execution envelope). If that's a problem, either run a faster (HyperSync-backed) RPC, or set `JINN_INDEXER_ENRICH_ENVELOPES=false` and accept that the enriched facets won't populate — note that Ponder won't backfill enrichment after the fact, so flipping it on later requires a re-sync (`DATABASE_SCHEMA` bump). `HarnessCheckpoint` anchors are indexed on-chain (key prefix `harness.checkpoint:`); their manifest bodies (codeDigest, parentCid, implStateDirCid) are not yet fetched, so per-checkpoint frozen-eval scores are pending — a tracked follow-up.

### Sepolia L1 RPC (`PONDER_RPC_URL_11155111`)

The indexer sources `JinnDistributor.Claimed` events from Sepolia L1 (chain 11155111) in addition to the Base Sepolia chain (84532). A public default RPC is baked into `ponder.config.ts`; **set a real RPC in production** — the public endpoint rate-limits and the Sepolia historical sync from the conservative start block is slow on a public endpoint. A HyperSync-backed RPC (e.g. from Envio) is strongly recommended, the same as for Base. Add it to `.env`:

```
PONDER_RPC_URL_11155111=https://your-sepolia-hypersync-rpc
```

## Zero-downtime rolling deploys (the views pattern)

Ponder's canonical approach for re-deploys without operator-visible downtime:

1. Existing deployment is running with `DATABASE_SCHEMA=jinn_indexer_v1`. Views in a static "public-facing" schema (e.g. `jinn_indexer`) point at `jinn_indexer_v1.*`.
2. Deploy a new version with `DATABASE_SCHEMA=jinn_indexer_v2`. It indexes from scratch into its own tables; the old `v1` deployment keeps serving.
3. Wait for `/ready` to return 200 on the new deployment.
4. Run `ponder db create-views --schema=jinn_indexer_v2 --views-schema=jinn_indexer` to swap the public-facing views over to `v2`'s tables.
5. Decommission the `v1` instance and drop its schema.

Or use `ponder start --views-schema=jinn_indexer` on the new deployment to automate the views swap on `/ready`.

This is the recommended pattern when shipping schema changes that would otherwise require a re-sync. See Ponder's "Self-hosting" docs §"Production deployment" for the canonical recipe.

### The all-entities-atomic view swap

`ponder db create-views` rewrites the views for **every entity in the schema in a single transaction** — there is no per-entity flag. The full set of 10 entities the indexer publishes is:

```
task, attempt, verdict, rewardDistribution, solverNetManifest,
envelope, pluginPublication, harnessCheckpoint, attemptEnvelopeMeta,
verdictEnvelopeMeta
```

A **partial view swap** is the suspected root cause of issue #567 — the `task` view (and only the `task` view) was left pointing at a stale schema while the rest of the entities advanced, which presented as "the `TaskCreated` handler silently stopped writing rows." If you ever hand-roll the swap (e.g. by issuing `CREATE OR REPLACE VIEW` statements directly), you **must** rewrite all 10 views in the same transaction — anything less can produce the same silent-divergence symptom.

Wire `/health/task-coverage` (see §Monitoring above) into your post-deploy smoke and as a 503-paging probe; it catches the symptom within one cache window (60 s) instead of waiting for a human to notice missing task ids in the explorer.

## Recovery procedure (suspected stuck-view scenario)

If `/health/task-coverage` reports `status: 'degraded'` with a large `taskGap` but the indexer process is healthy (`/health` 200, `/ready` 200, logs show ongoing realtime indexing), the most likely cause is a partial view swap — the public-facing `task` view is pointing at a stale `DATABASE_SCHEMA`. Recovery:

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
4. **Last-resort full re-sync**: bump `DATABASE_SCHEMA` (e.g. `jinn_indexer_v1` → `jinn_indexer_v2`), deploy, wait for `/ready`, then perform the views swap as documented above.

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
