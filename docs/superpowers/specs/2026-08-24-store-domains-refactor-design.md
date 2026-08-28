# Store domain ownership — design note (issue #1580)

**Date:** 2026-08-24  
**Shape:** refactor (strangler-fig, stacked green commits)  
**Scope:** `operator/src/store/store.ts` (~3,468 lines at base `892a1006`)

## Problem

`Store` still owns many unrelated SQLite domains in one class. Some compatibility
APIs are dead stubs. Unrelated schema/query changes collide; dead state persists by
inertia.

## Inventory — tables and ownership (base SHA)

| Table(s) | Active callers | Pre-refactor owner | Action |
| --- | --- | --- | --- |
| `phase_runs`, `phase_run_events` | generators, phase-run tests | `PhaseRunStore` | **Keep** — already extracted |
| `pending_captures`, `capture_spans` | captures ingest/publish, CLI, trajectory exporter | `CapturesStore` | **Keep** — already extracted |
| `native_*`, `engagement_ledger`, projector tables | daemon native loops, read models | schemas in `daemon/*`, read via `NativeTaskRunReadModel` / `NativeVerdictTallyReadModel` | **Keep** — owned outside `store.ts` body |
| `own_activity` | posting-service, activity tests | inline `Store` | **Extract** → `OwnActivityStore` |
| `config` | loop-heartbeat, composition-root, mech adapter, reward/balance loops, shutdown | inline `Store` | **Extract** → `OperatorConfigStore` |
| `artifacts` | API `/artifacts`, MCP, harness legacy-claude | inline `Store` | **Extract** → `ArtifactsStore` |
| `activity_events` | observability, spend caps, gather-status, posting projection | inline `Store` | **Extract** → `ActivityEventsStore` |
| `tx_submissions` | `tx-retry` ledger adapter, identity publisher | inline `Store` | **Extract** → `TxSubmissionsStore` |
| `reward_claims` | reward-claim intent | inline `Store` | **Extract** → `RewardClaimsStore` |
| `balance_cache` | gather-status wallet card | inline `Store` | **Extract** → `BalanceCacheStore` |
| `task_posts`, `task_post_locks` | posting-service, launcher tasks API | inline `Store` | **Extract** → `TaskPostsStore` |
| `served_artifacts`, `artifact_access_events` | x402, harness packaging, captures publisher | inline `Store` | **Extract** → `ServedArtifactsStore` |
| `network_artifacts` | MCP acquire-artifact, catalog resolve | inline `Store` | **Extract** → `NetworkArtifactsStore` |
| `envelope_projections`, `envelope_projection_metadata` | work-loop corpus, MCP search, operator-artifacts API | inline `Store` | **Extract** → `EnvelopeProjectionsStore` |
| `erc8004_anchors` | live-publisher, operator-artifacts API | inline `Store` | **Extract** → `Erc8004AnchorsStore` |
| `manifest_batch_journal` | manifest batch CAS (layer-live-deps script) | inline `Store` | **Extract** with erc8004 (same journal surface) |
| `eval_results` | eval orchestrator, screen-runner | inline `Store` | **Extract** → `EvalResultsStore` |

## Dead compatibility — delete, do not wrap

| API | Evidence |
| --- | --- |
| `getTaskEvidenceHash()` | Stub always returns `null`; zero callers |
| `insertRemoteArtifact()` | Zero production/test callers (peer-sync retired, Wave-4 D4) |
| `getRemoteDiscoveryMetadata()` | Zero callers |
| `markOwnActivity()` | Zero callers; enriched paths use `recordActivityEvent` directly |

`artifacts.remote` / `owner_address` / `endpoint` columns remain for existing rows;
only the write path (`insertRemoteArtifact`) is removed.

## Constraints (from issue)

- **One SQLite connection:** every domain store receives `Database.Database` from
  `Store.db`; no second connection.
- **Transaction boundaries:** cross-table orchestration (e.g. `recordOwnActivity`
  → activity event) stays on `Store` delegating to two domain stores in sequence;
  existing `db.transaction()` wrappers move with their domain.
- **Public API:** `Store` method signatures unchanged; strangler delegates inward.
- **No table splits** for inventory completeness alone.

## Stacked commit plan

1. This design note.
2. Delete dead compatibility methods.
3. Extract `EvalResultsStore`.
4. Extract `Erc8004AnchorsStore` (+ manifest journal + anchor migrations).
5. Extract `OperatorConfigStore`.
6. Extract `TxSubmissionsStore`.
7. Extract `RewardClaimsStore` + `BalanceCacheStore`.
8. Extract `OwnActivityStore` (table ops; `recordOwnActivity` orchestration stays on `Store`).
9. Extract `TaskPostsStore`.
10. Extract `ActivityEventsStore`.
11. Extract `ArtifactsStore`.
12. Extract `ServedArtifactsStore`.
13. Extract `NetworkArtifactsStore`.
14. Extract `EnvelopeProjectionsStore`.

Each commit: `yarn typecheck` + focused `operator/test/store/*.test.ts`.

## Non-goals

- Changing HTTP/MCP public surfaces.
- Moving native/projector schemas (already owned under `daemon/`).
- Repository-per-table for tables that share a cohesive domain.
