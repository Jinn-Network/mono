# Deploying `@jinn-network/indexer`

This is a **standard Ponder deployment**. The patterns here come directly from Ponder's [Self-hosting docs](https://ponder.sh/docs/production/self-hosting); we have not invented any custom subsystems on top.

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

- `/` — the network explorer page. Currently a placeholder (serves verifiable data from `/explorer/network`); `ebu7.4` will replace it with the real SPA bundle and add static-asset serving. The canonical explorer URL is `<indexer-host>/`.
- `/explorer/network` — fleet-wide KPI bundle (tasks, attempts, operators, verdicts, resolved rate, JINN distributed, freshness) plus `composition` (share of attempts by mode train/frozen and by harness `implName`) and `enrichmentCoverage` (how many attempts have envelope metadata yet).
- `/explorer/solvernets` — one row per indexed SolverNetManifest with rollup stats (batched query).
- `/explorer/solvernet/:cid` — per-SolverNet KPIs + learning-curve time series (`?bucket=<blocks>`, `?k=<rolling-window>`, `?minVerdicts=<n>`) plus `trainBoard`/`frozenBoard` (operator leaderboards split by mode), `checkpointTimeline` (published HarnessCheckpoint anchors), and `freezeIntegrity` (codeDigest-drift violations + verified-frozen share).
- `/explorer/operators` — quality-first operator leaderboard (`?minVerdicts=<n>`, `?mode=train|frozen`, `?harness=<implName>`); each row carries `dominantMode`/`dominantHarness`.
- `/explorer/operator/:addr` — one operator across all SolverNets they participate in, with `dominantMode`/`dominantHarness`/`dominantSolverType` and per-SolverNet mode breakdowns.

The `/explorer/*` routes set `Cache-Control: public, max-age=30, stale-while-revalidate=60` and an `ETag` keyed on `lastIndexedBlock`, so a CDN absorbs traffic spikes. CDN-fronting is recommended for public deployments. (`behindHead` in the freshness block is currently always `null` — wiring it to a real chain-head RPC call is a tracked follow-up.)

**GraphQL is at `/graphql` only** — the daemon already uses `/graphql`, so no client change is needed following this move. The root path `/` now serves the explorer page instead of a GraphQL catch-all.

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
