# @jinn-network/indexer

## Tier map (DR-2026-07-30 logical split, #2296 step 1)

This package hosts two roles pending the physical split (#2296 step 2,
gated on the operator-daemon cutover's discovery-serving stage):

- **Projector role** (`src/` handlers, enrichment): aspirationally tier 3;
  being replaced by the stack projector (`packages/marketplace/projector`
  is projector #1). Post-split this process's role is hosted archive +
  query plane.
- **Explorer SPA** (`explorer/`, `src/api/explorer.ts`): tier 4 product;
  physically separates at step 2.

The legacy `@jinn-network/sdk` edge is severed and guarded
(`.github/scripts/indexer-boundaries.test.mjs`).

Ponder indexer for the Jinn protocol. Indexes four entities (Task, Attempt,
SolverNetManifest, Envelope) from JinnRouter and IdentityRegistry events on
Base Sepolia and Base mainnet.

## Architecture: a standalone Ponder service

This package is a normal Ponder app. It runs as its own service — Node process, Postgres backend, GraphQL endpoint on port 42069. Deploy it like any other web service. The canonical patterns (Postgres + `DATABASE_SCHEMA` + views for zero-downtime rolling deploys) are described in `deploy/README.md` and come straight from Ponder's [Self-hosting docs](https://ponder.sh/docs/production/self-hosting). We do not ship custom subsystems on top.

The daemon (`@jinn-network/operator`) consumes this service via the GraphQL adapter at `operator/src/discovery-client/http.ts`. The daemon does not bundle or embed this package; it talks to it over HTTP like any other backend.

Schema definitions, event handlers, and Ponder runtime live here. The wire contract (the GraphQL queries the daemon issues) lives in the daemon's source tree. Both sides depend on the same schema shape; when the schema changes, both sides update.

## Network explorer

This package also serves the Jinn network explorer SPA at `/` — a React/Vite app in `explorer/` that builds to `public/` (run as part of `yarn build` and in the Dockerfile; a minimal placeholder is served if no build is present; deep links like `/solvernet/<cid>`, `/operators`, `/operator/<addr>` are SPA-fallback-served `index.html`). Aggregation JSON routes are at `/explorer/*` (network KPIs + composition, per-SolverNet learning curves + leaderboards, operator leaderboards, operator detail). Anyone running `@jinn-network/indexer` serves an explorer for free — no separate deployment needed. See `docs/superpowers/specs/2026-05-12-network-explorer-design.md` for the full design and `deploy/README.md` for the deployment guide.

The schema includes `harnessCheckpoint` (on-chain checkpoint anchors keyed by `harness.checkpoint:<cid>` MetadataSet events) and `attemptEnvelopeMeta` (envelope-sourced harness/mode/plugin/model per attempt, populated by an IPFS-enrichment step). The `/explorer/*` routes expose harness/mode composition, train/frozen leaderboard splits, a checkpoint timeline, and freeze-integrity diagnostics. Enrichment is gated by `JINN_INDEXER_ENRICH_ENVELOPES` (default on) and uses `JINN_IPFS_GATEWAY_URL` — see `deploy/README.md` for details.

## Running locally (PGlite, no external database)

```bash
# Install dependencies
yarn install

# Provide at least one RPC URL (Ponder will error if neither is set and
# no default RPC is reachable; the defaults in ponder.config.ts are public
# Base RPC endpoints that may rate-limit in production).
export PONDER_RPC_URL_84532=https://sepolia.base.org
export PONDER_RPC_URL_8453=https://mainnet.base.org

# Start the indexer in dev mode (PGlite under .ponder/, hot reload)
yarn dev
```

The GraphQL explorer is available at http://localhost:42069/graphql by default.

### Built-in health endpoints

Ponder ships two health endpoints out of the box:

```bash
curl http://localhost:42069/health   # 200 once the process has started
curl http://localhost:42069/ready    # 200 once indexing has caught up to realtime
```

Use `/ready` as the gate before swapping a load balancer onto a new deployment.

## Running in production

See `deploy/README.md` for the full production deployment guide. The short version:

- Postgres (managed or self-hosted).
- `DATABASE_URL` + `DATABASE_SCHEMA` env vars (per-deployment schema isolation enables rolling deploys via the views pattern).
- HyperSync-backed RPC URL recommended for fast cold-start sync.
- `docker build -t jinn-indexer -f deploy/Dockerfile .` then `docker run --env-file deploy/.env -p 42069:42069 jinn-indexer`.

## Schema-version policy

Any **breaking change** to an existing entity — renaming or removing a column,
changing a column type — requires a re-sync of the indexed state. The canonical
Ponder pattern for this is rolling deploys via `DATABASE_SCHEMA` + views (see
`deploy/README.md` §"Zero-downtime rolling deploys"): the new schema indexes
from genesis in its own Postgres schema while the old version keeps serving;
swap when ready.

**Pure-additive changes** (new columns with defaults, new entities, new indexes)
do not require a re-sync — Ponder handles them automatically.

## Known limitations (v0.1)

### Builder attribution requires `attemptEnvelopeMeta` (ebu7)

The `/builders/:agentId/runs` route and `DiscoveryAPI.getPluginScores` return empty arrays until the `attemptEnvelopeMeta` entity from ebu7 is present in the deployed schema. The `pluginPublication` rows exist in the indexer once attd is deployed, but without ebu7's attempt envelope joins there is no way to attribute which runs used which plugins. The route is safe to call before ebu7; it returns HTTP 200 with `[]` and automatically picks up data when ebu7 lands without code changes.

### No TaskFinalized / TaskRefunded events

JinnRouter V3 does not emit a standalone `TaskFinalized` event. The indexer
recomputes `task.finalized` in the `VerdictDeliveryClaimed` handler. For the
current tokenless router, `TaskCreated` no longer emits `requiredVerdicts` and
`TaskCoordinator.recordVerdict` finalizes on the first delivered verdict, so
new missing values are stored as `1` and any previously persisted
`requiredVerdicts <= 0` rows are normalized to first-verdict finalization at
verdict time (issue #1304). Explicit positive values still require that many
delivered verdicts (issue #530). `finalized` is NOT set on
`SolutionDeliveryClaimed` — that event is the start of the evaluation phase,
not finalization.

`task.refunded` is populated from `JinnRouter.TaskBudgetRefunded` (wired in
`ebu7.2`). `TaskBudgetRefunded` does exist on V3 — the prior comment claiming
it did not was stale.

The daemon compensates: its `canClaimTask` simulation (in
`client/src/adapters/mech/contracts.ts`) is the correctness gate before any
claim is attempted. The indexer is an acceleration path; the simulation is the
truth.

### claimWindowStart / claimWindowEnd not indexed

These fields are part of the `policy` tuple passed to `createTask` but are not
emitted in the `TaskCreated` event. Decoding them requires reading the
originating transaction input (call traces). At v0.1 these columns are stored
as nullable; `findClaimableTasks` in the adapter compensates by falling back to
the `nowSeconds` parameter for client-side filtering and relying on
`canClaimTask` simulation for correctness.

Enabling `includeCallTraces` in `ponder.config.ts` and decoding the `policy`
tuple from `createTask` args is the fix; tracked in `jinn-mono-280n.4`.

### HyperSync is not a separate Ponder transport at v0.16.x

Ponder 0.16.x uses standard JSON-RPC transports. Use a HyperSync-backed RPC
URL (e.g. from Envio) in `PONDER_RPC_URL_*` to get HyperSync performance.
Native HyperSync transport support may arrive in a later Ponder release.

### `SolverNetManifestSummary` is a partial mirror

The GraphQL endpoint exposes 6 on-chain-derivable fields per SolverNet
(`manifestCid`, `solverNetId`, `launcherAgentId`, `status`, `statusUpdatedAt`,
`anchorBlock`) derived entirely from on-chain index data. The canonical
`SolverNetManifestSummary` in `client/src/discovery-client/types.ts` has
14 fields; the remaining 8 (`name`, `network`, `launcherSafeAddress`,
`contractId`, `contractVersion`, `solutionPriceWei`, `verdictPriceWei`,
`openRoles`) live in the IPFS manifest body and are not stored in the indexer.

The daemon's `createHttpDiscoveryClient` (at `client/src/discovery-client/http.ts`) fills
these 8 fields with sentinel values and leaves enrichment to the caller. This
matches how `solvernets/registry-client-erc8004.ts:listLaunched` already works
post-`280n.3`: it fetches the IPFS manifest for each summary row.

### `CorpusQuery.solverType` cannot be filtered at the indexer level

`solverType` is a field of the IPFS manifest body, not part of the on-chain
envelope payload (`IdentityRegistry.MetadataSet` only carries the ABI-encoded
`(version, tier, manifestHash, ...)` tuple). The indexer cannot populate or
filter by `solverType`.

Callers that need per-`solverType` filtering must do so client-side after
fetching and decoding the IPFS manifests referenced by the returned
`EnvelopeRef` rows. Passing `solverType` in a `CorpusQuery` to
`queryEnvelopes` is accepted at the interface level but is silently ignored by
the indexer adapter.

## Schema

### Task

One JinnRouter task (created on `TaskCreated`; `finalized` recomputed on `VerdictDeliveryClaimed` when delivered verdicts reach normalized `requiredVerdicts`, with tokenless missing/non-positive values finalizing on the first verdict, issues #530/#1304). Primary key: `id` (taskId as decimal string). Supports `findClaimableTasks` filtering by manifest digest, finalized flag, refunded flag, and joining with `Attempt` for attempt counts.

### Attempt

One task attempt (created on `TaskAttemptCreated`). Composite primary key: `(taskId, attemptIndex, chainId)`. Multiple attempts per task. Indexed by `taskId` and `operator` for filtering.

### SolverNetManifest

Current lifecycle state of a launched SolverNet (populated from `IdentityRegistry.MetadataSet` where key starts with `solvernet-manifest:`). Primary key: `id` (manifestCid). Most-recent-wins semantics; each upsert overwrites status fields if the new event is from the same or later block (using `(block, transactionIndex, logIndex)` tiebreak). Payload tuple: `(version, status, at, manifestHash, ...)` per `client/src/erc8004/abis.ts::MANIFEST_LIFECYCLE_TUPLE`.

### Envelope

Corpus envelope reference (populated from `IdentityRegistry.MetadataSet` where key matches `envelope:<manifestCid>`, `evaluation:<manifestCid>`, or `capture:<manifestCid>`). Primary key: composite `(agentId, metadataKey, chainId)`. Stores evidence tier (0=self-signed, 1=committed, 3=attested), manifest hash, and block provenance for recency ordering.

### PluginPublication

A published plug-in record (populated from `IdentityRegistry.MetadataSet` where key starts with `plugin:` per `spec/2026-05-13-plug-in-builder-entry-point-design.md` §5.2/§5.6). Primary key: composite `<builderAgentId>:<pluginCid>`. Payload tuple format: v1 (publication, 6 fields) or v2 (revocation marker, 3 fields) per `client/src/erc8004/abis.ts::PLUGIN_PAYLOAD_TUPLE` and `REVOCATION_PAYLOAD_TUPLE`. Most-recent-wins semantics with `(blockNumber, txIndex, logIndex)` tiebreak. Version updates ship a new tarball (new CID, new row); revocations overwrite the same key with v2 payload setting `revoked: true`. Stores builder attribution via `pluginSha256` (fork-attribution join key against `envelope.plugins[].sha256`).

## Custom routes

### `/builders/:agentId/runs`

Returns attributed run summaries for the builder identified by `agentId`. The response is `[]` until the `attemptEnvelopeMeta` and `verdict` entities from ebu7 land in the deployed schema. Once ebu7 is present, the route joins `pluginPublication` against `attemptEnvelopeMeta` and `verdict` to produce builder-attributed task runs with plugin usage metadata.

The route is safe to call before ebu7 — it returns `[]` and succeeds with HTTP 200. When ebu7 is deployed, no changes to this file are required; the route automatically picks up the new entities via the schema import.

## Development commands

```bash
yarn dev       # Ponder dev server (hot reload, PGlite)
yarn build     # Ponder build (codegen — regenerates ponder-env.d.ts; this Ponder
               # version has no separate `ponder build` command)
yarn start     # Ponder production server (indexer + HTTP, requires DATABASE_URL)
yarn serve     # Ponder production HTTP server only (no indexer, requires DATABASE_URL)
yarn codegen   # Regenerate ponder-env.d.ts type artifacts
yarn typecheck # TypeScript check (no emit)
yarn test      # Vitest unit tests for the event handlers (test/handlers.test.ts).
```

### What the handler tests cover, and how

`test/handlers.test.ts` exercises the event-folding logic in `src/handlers.ts`:
MetadataSet key routing (manifest vs. envelope vs. ignored), envelope-payload
decode with the V2→V1 fallback (and garbage-payload tolerance), most-recent-wins
upsert ordering — including the `(block, transactionIndex, logIndex)` tiebreak
and idempotent re-sync — the `SolutionDeliveryClaimed` missing-row guard, and
Task/Attempt folding (cross-checked against the GraphQL field names
`client/src/discovery-client/http.ts` queries).

Ponder 0.16.x has no first-class unit-test util for indexing functions, and the
`ponder:registry` / `ponder:schema` modules are virtual modules the Ponder
build resolves — not importable from Vitest. So the handler logic is extracted
out of the `ponder.on(...)` registrations in `src/index.ts` into exported pure
functions in `src/handlers.ts` (`src/index.ts` is now thin shims that forward
`{ event, context }` plus the schema table objects), and the tests run those
pure functions against `test/helpers/in-memory-db.ts` — a stub that mirrors the
`find / insert / update / onConflictDoNothing / onConflictDoUpdate` surface the
handlers use. The two-operator end-to-end (a real Ponder service indexing a live
testnet contract) is tracked separately.

The daemon-side GraphQL **client** surface (the queries `createHttpDiscoveryClient`
issues against this service) is covered by `operator/src/discovery-client/http.ts`
in the `@jinn-network/operator` package.
