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

## Endpoints (all built into Ponder)

- `/graphql` — auto-generated GraphQL endpoint over the schema.
- `/health` — returns 200 immediately after the process starts. Use for liveness checks.
- `/ready` — returns 200 once indexing has reached realtime across all chains. Use for readiness checks and as the gate before swapping a load balancer onto a new deployment.

We do not ship custom routes on top of these. If you need a custom endpoint (auth, rate limiting, alternative response shape), wire it in via Ponder's `api/index.ts` extension point.

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
