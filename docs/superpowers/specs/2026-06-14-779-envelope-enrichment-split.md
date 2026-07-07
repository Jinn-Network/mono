# Design — Split envelope enrichment off the indexer's GraphQL event loop (#779)

- **Version:** 0.1
- **Date:** 2026-06-14
- **Author:** Claude (implement-issue #779)
- **Shape:** `refactor` (strangler-fig, stacked PRs, design-upfront required)

## Problem

The Ponder indexer's `IdentityRegistry:MetadataSet` handler (`packages/indexer/src/handlers.ts`,
`handleMetadataSet`) does **synchronous, in-process IPFS fetches** for evaluation envelopes
(`evaluation:<cid>` keys): one fetch for the verdict envelope body, plus — for `swe-rebench-v2`
only, since #669 — a second fetch for the task body to resolve `instance_id` and
`solverNetManifestCid`. These `await fetchIpfsJson(...)` calls (5 s timeout each) run on the same
single Node event loop that `ponder serve` uses to answer `/graphql`. While enrichment is blocked
on IPFS, incoming GraphQL requests queue behind it and the Railway proxy times them out as
**502 Bad Gateway**. The cause is structural (Node is single-threaded), not a function of request
volume — even a modest enrichment backlog starves the read path. The same pattern exists for
`attemptEnvelopeMeta` (execution envelopes) and for `harnessCheckpoint` / `solverNetManifest` body
enrichment, but #779 scopes the fix to the **verdict (evaluation) envelope** path; the others are
follow-ups that reuse the same machinery.

## Chosen approach: out-of-process polling worker, CID-anchor discovery, raw-`pg` writes to the live Ponder schema

Move the IPFS-bound enrichment of `verdictEnvelopeMeta` out of the indexing handler into a new
standalone service, `packages/indexer-enrichment/`, that polls the shared Postgres for evaluation
envelopes lacking an enriched verdict row, performs the IPFS fetches in its own process, and writes
the result back into Ponder's `verdict_envelope_meta` table. The indexing handler, when the split is
active, does **no IPFS I/O** on the evaluation path — it only writes the on-chain `envelope` anchor
row (which it already does today before any fetch) and returns. This is the strangler-fig: the
worker grows alongside the existing in-handler path, and a feature flag flips traffic from old to new.

The single most important realization is the **discovery key**. `verdictEnvelopeMeta` is primary-keyed
by `(requestId, chainId)`, but `requestId` lives *inside the IPFS body* (`task.requestId`) — so the
handler cannot write a `requestId`-keyed "skeleton" row without first doing IPFS, which is exactly
what we are removing. We do **not** need to. The handler **already** writes an IPFS-free, CID-keyed
anchor for every evaluation key into the existing `envelope` table (`kind='evaluation'`,
`manifestCid=<cid>`, PK `(agentId, metadataKey, chainId)` — see `handlers.ts` ~1089). That anchor IS
the skeleton. The worker's discovery query is a left-anti-join: *"evaluation `envelope` rows that have
no `ok` `verdict_envelope_meta` row joined by CID."* This keeps `verdictEnvelopeMeta`'s schema and PK
exactly as #669 left them (no re-key, no migration of the launcher's read path), and means AC1's
"skeleton row with `enrichmentStatus='pending'` and no IPFS I/O" is satisfied by the `envelope` anchor
the handler already emits — the handler's evaluation branch reduces to the envelope upsert plus an
early return, trivially under 10 ms p99.

### Components and data flow

1. **Indexer handler (`packages/indexer/src/handlers.ts`)** — when enrichment is *off* (the new
   default once rolled out), the `kind === 'evaluation'` branch skips the verdict IPFS fetch+write
   entirely; it relies on the `envelope` upsert already executed above it. The existing
   `enrichEnvelopes` parameter is reused unchanged — `JINN_INDEXER_ENRICH_ENVELOPES=true` keeps
   today's in-handler enrichment (AC5 reversibility, the rollback lever), `=false` makes the handler
   write anchors only and defers enrichment to the worker. No new flag is introduced; the existing one
   gains the worker as its `false`-branch companion. The verdict-envelope parsing logic
   (`parseVerdictEnvelopeLite`, `normalizeVerdict`, `fetchIpfsJson`, `FetchLike`, `DEFAULT_IPFS_GATEWAY`)
   is **extracted to a place both packages import** — either promoted into `@jinn-network/sdk` or
   exported from `packages/indexer` and consumed via `portal:` — so the worker and the (legacy)
   in-handler path share one parser and cannot drift. Extraction-without-behavior-change is its own
   stacked layer (below).

2. **New `packages/indexer-enrichment/`** — a standalone npm package modelled file-for-file on
   `packages/claim-relayer/` (the repo's existing standing-worker template): `src/index.ts` (bin entry
   + poll loop), `src/config.ts` (env → typed config), `src/db.ts` (Postgres access), `src/enrich.ts`
   (claim → fetch → write one batch), `src/http.ts` (`/health` + `/ready` + a status payload mirroring
   claim-relayer's), `deploy/Dockerfile`, `deploy/railway.toml`, `test/`, `tsconfig.json`,
   `vitest.config.ts`. Its poll loop, every N seconds: (a) **claim** a bounded batch of due rows, (b)
   fetch the verdict envelope (+ task body for `swe-rebench-v2`) over IPFS, (c) parse with the shared
   `parseVerdictEnvelopeLite`, (d) UPSERT the full field set into `verdict_envelope_meta` with
   `enrichmentStatus='ok'`, or mark the attempt failed/retry on error.

3. **Postgres access (the riskiest unknown — resolved).** Ponder 0.16 writes its tables into a
   per-deploy schema named by `DATABASE_SCHEMA` (e.g. `jinn_indexer_v1`), with a static public-facing
   schema of views swapped on `/ready` (the "views pattern", `deploy/README.md` §Zero-downtime rolling
   deploys). The generated table name is `<DATABASE_SCHEMA>.verdict_envelope_meta` (snake_case of the
   `onchainTable('verdict_envelope_meta', …)` name). A separate writer is **architecturally sanctioned
   by Ponder's own scaling story** — the README already runs `ponder serve` replicas against the same
   `DATABASE_SCHEMA` as `ponder start`. The worker is a third process on that same schema. It connects
   with a plain `pg` `Pool` (add `pg` + `drizzle-orm` — already an indexer dep — to the worker; Drizzle
   gives us the same column mapping and lets us import the table definition from `ponder.schema.ts`
   rather than hand-writing SQL, keeping the worker's writes type-checked against the schema). The
   worker reads `DATABASE_URL` and `DATABASE_SCHEMA` from the **same env the indexer uses**, so a
   `DATABASE_SCHEMA` bump (full re-sync) repoints both processes together; the worker must `SET
   search_path` / qualify writes by `DATABASE_SCHEMA` and must tolerate the schema not yet existing
   (back off and retry) during a fresh deploy. The worker writes only `verdict_envelope_meta`; it never
   touches Ponder's reorg/checkpoint bookkeeping tables, and its UPSERT is on the same
   `(requestId, chainId)` PK Ponder uses, so the handler (when re-enabled) and the worker are
   write-compatible (last-write-wins by `enrichedAtBlock`, exactly the existing
   `onConflictDoUpdate` rule).

4. **Idempotency, claiming, retry/backoff (AC6).** Discovery + claim is one SQL statement using
   `FOR UPDATE SKIP LOCKED` over the join of `envelope` (kind='evaluation') against
   `verdict_envelope_meta`, so two worker instances never double-process a CID. Re-running against an
   already-`ok` row is a no-op two ways: the discovery query excludes rows that already have an `ok`
   `verdict_envelope_meta` (they don't appear), and the write is an UPSERT whose update branch is
   guarded by `enrichedAtBlock` most-recent-wins (a replay at an older/equal block leaves the row
   unchanged — the same no-op SET the handler already emits). Retry state is modelled on
   `verdict_envelope_meta.enrichmentStatus` plus two **new nullable columns**, `retryCount`
   (`integer default 0`) and `nextAttemptAt` (`timestamp` / `bigint` epoch-ms, nullable). On a failed
   fetch the worker inserts/updates a minimal row with `enrichmentStatus='retry'`,
   `retryCount = retryCount+1`, and `nextAttemptAt = now + backoff(retryCount)` (capped exponential);
   discovery includes `enrichmentStatus IN ('pending','retry') AND (nextAttemptAt IS NULL OR
   nextAttemptAt <= now)`. The `enrichmentStatus` enum already documents `pending`/`ok`/`failed`; we
   add `retry` as a transient state and keep `failed` as the terminal give-up after a max retry count.
   **Note:** because the worker needs a `retry`/`nextAttemptAt` row but the table is `requestId`-keyed
   and we don't have `requestId` until a successful body fetch, a transient *fetch* failure (no body)
   has no PK to write to — its retry state lives implicitly in the un-enriched `envelope` anchor
   (it simply reappears in discovery next tick); the `retryCount`/`nextAttemptAt` columns drive backoff
   only once a body has parsed but a *task-body* fetch or write failed (we have `requestId` by then).
   This keeps fetch-failure resilience identical to today (natural retry via re-discovery) while adding
   bounded backoff for the partially-enriched case. *(Open question O1 below revisits whether a
   CID-keyed `enrichment_queue` side table would model retry more cleanly than overloading the
   `requestId`-keyed target table.)*

### #669 anti-farming preservation (AC4)

The launcher's `getInstanceSuccessCounts` (`client/src/discovery/http.ts:276`) filters on
`enrichmentStatus: "ok"`, `instanceId_not: ""`, `actualPassed: true`, `solverType_starts_with:
"swe-rebench-v2"`, scoped by `solverNetManifestCid`. **This filter shape is unchanged** — the worker
writes exactly the same five enrichment fields (`instanceId`, `solverNetManifestCid`, `actualPassed`,
`actualScore`, `evaluatorVerdict`) and only flips `enrichmentStatus` to `'ok'` after both the verdict
and (for swe-rebench-v2) the task body have resolved. Un-enriched evaluations are invisible to the
launcher (they have no `ok` row), exactly as today's "no row on fetch failure" behavior — so the
anti-farming property is structurally identical and the existing #669 test on the filter is preserved
verbatim. The instance/solverNet indexes (`instanceIdIdx`, `solverNetInstanceIdIdx`) are untouched.

## Alternatives considered

- **Worker thread / `Piscina` inside the indexer process.** Keeps one deployable, but the IPFS wait
  still competes for the same Postgres connection pool and shares fate with the indexer process; a
  worker-thread crash or a `DATABASE_SCHEMA` bump entangles read-serving with enrichment. Rejected:
  doesn't deliver the operational isolation the 502 incident demands, and is harder to scale/roll
  independently. The handbook's strangler-fig requirement also favors a cleanly separable service.
- **Fire-and-forget `void fetchIpfsJson(...)` (don't await) inside the handler.** Cheapest diff, but
  Ponder's indexing functions must complete deterministically for checkpoint/reorg correctness;
  detaching async work inside a handler is unsupported and would corrupt Ponder's ordering guarantees.
  Rejected as unsafe.
- **Re-key `verdictEnvelopeMeta` by CID so the handler can write a true skeleton row.** Would make the
  "pending row" literal, but forces a PK migration and a rewrite of every `(requestId, chainId)` join
  (`verdict`, `attempt`, the launcher read path). Rejected: the `envelope` table already provides a
  CID-anchored skeleton for free, so this is unnecessary churn on #669's hard-won read path.
- **Separate enrichment database the worker owns, joined at read time.** Cleanest ownership boundary,
  but the launcher GraphQL query and the explorer SPA read `verdictEnvelopeMeta` *through Ponder's
  GraphQL*, which only sees Ponder's own schema. A separate DB would require teaching Ponder to expose
  foreign rows (it can't) or rewriting the read path off GraphQL. Rejected for #779; revisit if the
  shared-schema write coupling proves fragile (O2).

## Testing strategy

- **Handler does no IPFS I/O + returns fast (AC1, AC3).** Unit test in `packages/indexer/test/
  handlers.test.ts`: call `handleMetadataSet` on an `evaluation:` key with `enrichEnvelopes:false` and
  a `fetchImpl` stub that flips a `called` flag — assert `called === false`, assert the `envelope`
  anchor row exists, assert `verdict_envelope_meta` count is 0, and wrap the call in a timing assertion
  (sub-10 ms; the existing `does NOT fetch or write when enrichEnvelopes:false` test is already 90% of
  this). AC3's "40 rapid `/graphql` probes all 200 during a backlog" is an **integration test** in the
  worker package: boot `ponder serve` (or a minimal GraphQL-over-the-schema harness) against a real
  Postgres pre-loaded with a large `pending` backlog, run the worker against it, and fire 40 concurrent
  `/graphql` requests asserting all return 200 — proving the read path is decoupled from enrichment.
- **Worker against real Postgres (handbook rule 6 — migration/contract surface → real DB, not mocks).**
  The worker's `enrich.ts` and `db.ts` get integration tests using **PGlite** (already an indexer
  transitive dep via Ponder, used in `test/api.slice.route.test.ts`) or a throwaway Postgres container,
  seeded with `envelope` + `verdict_envelope_meta` rows, with IPFS stubbed via the existing `FetchLike`
  seam. Assert: discovery finds only un-enriched evaluations; a full run writes the five enrichment
  fields and `enrichmentStatus='ok'`; **re-running leaves an `ok` row byte-identical (AC6)**; a fetch
  failure leaves the row un-enriched and re-discoverable; `SKIP LOCKED` prevents two concurrent runs
  from double-writing.
- **#669 preserved (AC4).** Keep the existing launcher-filter test as-is; add a worker test asserting
  the worker only sets `enrichmentStatus='ok'` once both `instanceId` and `solverNetManifestCid` are
  populated for swe-rebench-v2 (so a partial enrichment never leaks into `getInstanceSuccessCounts`).
- **Reversibility (AC5).** Parametric handler test over `enrichEnvelopes ∈ {true,false}` asserting the
  two behaviors (in-handler enrich vs anchor-only), proving the flag is a clean rollback lever.

## Stacked-PR layering (strangler-fig)

Even though this pipeline opens one draft PR, the work is internally layered so review and rollback are
incremental:

1. **Schema + extraction (no behavior change).** Add `retryCount`/`nextAttemptAt` nullable columns to
   `verdict_envelope_meta`; extract `parseVerdictEnvelopeLite` + IPFS helpers into the shared module
   (sdk or indexer export). Both are pure refactors with existing tests green.
2. **New `packages/indexer-enrichment/` worker** (scaffold from claim-relayer) with full unit +
   integration tests, but **not yet wired into any deploy** and the indexer still enriching in-handler
   (`enrichEnvelopes=true`). The worker is exercised only by tests at this layer.
3. **Cutover flag.** Default `JINN_INDEXER_ENRICH_ENVELOPES` to `false` for the verdict path so the
   handler writes anchors only and the worker owns enrichment; the flag stays the documented rollback.
   Update `ponder.config.ts` / `index.ts` doc comments on the flag's new dual meaning.
4. **Deploy artifacts (design-only here; provision separately).** `deploy/Dockerfile` +
   `deploy/railway.toml` for a new `jinn-enrichment-worker` Railway service sharing the indexer's
   `DATABASE_URL`/`DATABASE_SCHEMA`/`JINN_IPFS_GATEWAY_URL` env. **No provisioning in this PR** — the
   artifacts ship; the Railway service is stood up by an operator following the indexer's
   `deploy/README.md` conventions (Root Directory `/packages`, Config-as-code path under
   `packages/indexer-enrichment/deploy/railway.toml`, `/ready` healthcheck, `ON_FAILURE` restart). The
   worker must NOT carry a repo-root `railway.toml` (the #846 guardrail).

## Open questions / risks

- **O1 — retry-state location.** Overloading the `requestId`-keyed `verdict_envelope_meta` with
  `retryCount`/`nextAttemptAt` is slightly awkward because pre-body fetch failures have no `requestId`
  to write to (their retry is implicit via the `envelope` anchor reappearing in discovery). A cleaner
  alternative is a small CID-keyed `enrichment_queue` side table the worker fully owns, decoupling
  retry bookkeeping from the read-facing target table. Recommendation: start with the two columns
  (smaller schema delta, AC2/AC6 satisfiable) and graduate to a side table only if the dual-failure-mode
  retry logic gets unwieldy. **Needs a decision before implementing layer 1.**
- **O2 — shared-schema write coupling.** A separate process writing into Ponder's `DATABASE_SCHEMA` is
  sanctioned by Ponder's replica story but is not a contract Ponder guarantees across minor upgrades;
  a future Ponder version could change table internals (e.g. add reorg shadow columns). Mitigation: the
  worker imports the table def from `ponder.schema.ts` (compile-time coupling catches column changes)
  and writes only the application columns of `verdict_envelope_meta`. Risk is low but should be noted
  in the worker README.
- **O3 — `DATABASE_SCHEMA` discovery during rolling deploys.** During a views-pattern cutover two
  `DATABASE_SCHEMA`s briefly coexist (`v1` serving, `v2` syncing). The worker reads one
  `DATABASE_SCHEMA` from env; if it points at the *old* schema during a cutover, newly-synced `v2`
  evaluations won't be enriched until the worker's env is repointed and it restarts. Acceptable for #779
  (enrichment is eventually-consistent and the launcher tolerates un-enriched rows), but the deploy
  runbook must call out repointing the worker as part of the schema-bump procedure.
- **O4 — backfill of the existing backlog.** Flipping the flag to `false` does not retroactively enrich
  evaluations indexed while `true`; conversely, evaluations indexed under `false` (anchor-only) need the
  worker to have run. On first worker deploy it will see the full historical backlog of un-enriched
  evaluation envelopes and should drain it at a bounded rate (batch size + sleep) to avoid an IPFS-gateway
  / Postgres write storm. Batch sizing is a config knob to tune at rollout.
