# @jinn-network/indexer-enrichment

A standalone polling worker that off-loads IPFS-bound **verdict-envelope
enrichment** off the Ponder indexer's `/graphql` event loop (issue #779).

## Why it exists

The indexer's `IdentityRegistry:MetadataSet` handler used to do synchronous,
in-process IPFS fetches for evaluation envelopes (`evaluation:<cid>` keys) —
one for the verdict body, plus (for `swe-rebench-v2`, since #669) a second for
the task body to resolve `instance_id` + `solverNetManifestCid`. Those
`await fetchIpfsJson(...)` calls run on the same single Node event loop that
`ponder serve` answers `/graphql` on. While enrichment blocked on IPFS, GraphQL
requests queued behind it and the Railway proxy returned **502 Bad Gateway**.
The cause is structural (Node is single-threaded), not request volume.

This worker moves that enrichment into its **own process**. The handler now
writes the IPFS-free `envelope` anchor and returns; this worker polls Postgres
for evaluation anchors lacking an enriched verdict row, does the IPFS fetches in
its own event loop, and writes the result back into `verdict_envelope_meta`.

## How it works

1. **Discover** (`src/db.ts` `discoverDue`) — a CID left-anti-join: `evaluation`
   `envelope` rows that have **no** `ok` `verdict_envelope_meta` row joined by
   `manifest_cid` (or a `pending`/`retry` row whose `next_attempt_at` is due).
   `FOR UPDATE OF e SKIP LOCKED` so two worker instances claim disjoint sets.
2. **Fetch + parse** (`src/enrich.ts`) — fetch the verdict body (+ task body for
   `swe-rebench-v2`) over IPFS, parse with the **shared**
   `@jinn-network/indexer/enrichment-parse` module — the SAME parser the handler
   uses, so the in-handler path and this worker cannot drift.
3. **Write** (`src/db.ts` `upsertVerdict`) — upsert the full field set keyed
   `(request_id, chain_id)`, guarded by `enriched_at_block` most-recent-wins
   (mirrors the handler's `onConflictDoUpdate`), with `enrichment_status='ok'`.
4. **Retry** (`markRetry`) — when the verdict parsed but a follow-up step failed,
   set `enrichment_status='retry'`, bump `retry_count`, and back off via
   `next_attempt_at` (capped exponential); terminal `failed` at `maxRetries`.

The poll loop (`src/runner.ts`) is `setTimeout`-scheduled with a re-entrancy
guard. The boot path (`src/index.ts`) **fails loud** — a DB-connect failure
exits non-zero so Railway `ON_FAILURE` restarts it (the #1068 lesson).
`/health`, `/ready`, `/status` mirror the claim-relayer.

## Config

Shared with the indexer (the worker writes into the indexer's Ponder schema):

| Env | Required | Default | Notes |
|-----|----------|---------|-------|
| `DATABASE_URL` | yes | — | Same Postgres as the indexer. |
| `DATABASE_SCHEMA` | yes | — | Same per-deploy schema (e.g. `jinn_indexer_v1`). |
| `JINN_IPFS_GATEWAY_URL` | no | autonolas gateway | Shared with the indexer. |

Worker-specific knobs:

| Env | Default | Notes |
|-----|---------|-------|
| `JINN_ENRICHMENT_PORT` | `8738` | Status server port. |
| `JINN_ENRICHMENT_POLL_INTERVAL_MS` | `10000` | Between ticks. |
| `JINN_ENRICHMENT_BATCH_SIZE` | `25` | Anchors per tick (the O4 drain knob). |
| `JINN_ENRICHMENT_IPFS_TIMEOUT_MS` | `5000` | Per-fetch timeout. |
| `JINN_ENRICHMENT_MAX_RETRIES` | `5` | Before terminal `failed`. |

## Cutover / rollback

The verdict path is wired from the indexer's existing
`JINN_INDEXER_ENRICH_ENVELOPES` env:

- **unset / `false`** → the handler writes verdict anchors only; **this worker
  owns verdict enrichment** (the new default).
- **`true` / `1`** → in-handler verdict enrichment (legacy behaviour, the
  rollback lever). When rolled back, stop this worker; the handler enriches.

This worker does NOT touch the execution-envelope (`attemptEnvelopeMeta`),
manifest, or checkpoint enrichment — those stay in-handler under
`JINN_INDEXER_ENRICH_ENVELOPES` (out of #779 scope).

## Deploy

Ship-only here — provision the Railway service following
`packages/indexer/deploy/README.md` conventions (Root Directory `/packages`,
Config-as-code path `packages/indexer-enrichment/deploy/railway.toml`, `/ready`
healthcheck, `ON_FAILURE` restart). The Dockerfile build context is `packages/`.

### Caveats (from the #779 design note)

- **O2 — shared-schema write coupling.** A separate process writing into the
  indexer's `DATABASE_SCHEMA` is sanctioned by Ponder's replica story but is not
  a contract Ponder guarantees across minor upgrades (a future Ponder could add
  reorg shadow columns). Mitigation: the worker imports the table definition from
  `@jinn-network/indexer/schema` (`ponder.schema.ts`) at compile time, so a
  column change breaks the build (and the `schema parity` DB test), not
  production. The worker writes only the application columns of
  `verdict_envelope_meta`, never Ponder's bookkeeping tables.
- **O3 — `DATABASE_SCHEMA` repoint on a re-sync.** Adding the `retry_count` /
  `next_attempt_at` columns to `verdict_envelope_meta` is an `onchainTable`
  change, and Ponder does not online-migrate — the indexer's first deploy of the
  #779 schema needs a `DATABASE_SCHEMA` bump + full re-sync. During a
  views-pattern rolling cutover two schemas briefly coexist; the worker reads one
  `DATABASE_SCHEMA` from env, so **repoint the worker's `DATABASE_SCHEMA` and
  restart it together with the indexer** as part of the schema-bump procedure,
  or newly-synced evaluations under the new schema won't be enriched. The worker
  tolerates the schema not yet existing (`ready()` backs off rather than
  crashing) so a worker started before its schema exists just waits.
- **O4 — backfill drain.** On first deploy the worker sees the full historical
  backlog of un-enriched evaluation envelopes. It drains at
  `JINN_ENRICHMENT_BATCH_SIZE` × `JINN_ENRICHMENT_POLL_INTERVAL_MS` — tune those
  down on the first deploy to avoid an IPFS-gateway / Postgres write storm.

## Development

```bash
yarn install          # standalone package (own yarn.lock)
yarn typecheck
yarn test             # vitest; DB tests run against PGlite (a real Postgres engine)
yarn build            # tsc → dist/
```
