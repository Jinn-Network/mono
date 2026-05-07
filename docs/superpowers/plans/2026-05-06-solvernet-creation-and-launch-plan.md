# SolverNet Creation and Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the predecessor `opus/launcher-role-and-mode` Launcher mode (a local `'launching'` role toggle on a pre-existing Prediction config) with the SolverNet creation and launch experience defined in `spec/2026-05-05-solvernet-creation-and-launch.md`. Launchers create SolverNets via a 5-step Create flow, sign a manifest, anchor it on-chain via `IdentityRegistry.setMetadata`, pin to IPFS, and the launcher daemon runs the launcher-owned generator. Operators discover launched SolverNets via a global subgraph-indexed registry and join by writing manifest-cid-keyed config.

**Architecture (the eleven locked decisions):**
- Discovery anchor: `IdentityRegistry.setMetadata(launcherAgentId, "solvernet-manifest:<cid>", payload)` — replicates the `IdentityPublisher` + network-trust v0 pattern. Subgraph indexes all events globally; no follow-list.
- Manifest: signed by agent EOA; immutable post-launch; full embedded contract (no ref/embed split); JSON Schema for schemas. `solutionPriceWei` / `verdictPriceWei` are the day-1 economics fields.
- Lifecycle: `setMetadata` writes with same key + updated payload; most-recent-wins resolver. Pause + Resume + Retire; no Cancel.
- `solverType` removed: `{ id, version }` + `manifestCid` replace it. On-chain `solverTypeDigest` → `manifestDigest = keccak256(manifestCid)`. Solidity field rename via existing proxy upgrade. Subgraph rename + redeploy. Testnet task-data clean break accepted (pre-release).
- Persistence: `~/.jinn-client/solvernets/{drafts,launched}/<id>.json` mirroring earning-state precedent. Forward-only checkpointed launch state machine; daemon resumes in-flight launches on restart.
- Generator gating: launcher daemon spawns generator only when local launched record says owner + status === launched + generatorEnabled. Hot-apply for generator-config edits via in-memory mirror.
- Operator catalog: registry-only; legacy `solverNets.prediction` default config block dropped (pre-release, no migration burden).

**Tech Stack:** TypeScript, Vitest, Hardhat (Solidity), Hono (daemon HTTP), Wouter + React 18 (SPA), Zod (config), JSON Schema (manifest schemas), RFC 8785 JCS canonicalization, viem (chain interaction), IPFS via Autonolas gateway, The Graph (subgraph).

**Spec:** `spec/2026-05-05-solvernet-creation-and-launch.md` (v0.2, design-locked).

**Branch:** `opus/solvernet-creation-and-launch` (worktree at `/tmp/jinn-solvernet-create`), forked from `origin/opus/launcher-role-and-mode` at `425c4896`. The predecessor `opus/launcher-role-and-mode` branch may continue receiving the `jinn-mono-p1t4` fix work concurrently; this plan assumes a periodic merge from that branch into ours, with the predecessor Launcher mode files (`pages/Launcher.tsx`, `pages/launcher/SetupFlow.tsx`, etc.) being **deleted** in Phase 5 of this plan rather than fixed in place.

---

## File Structure

### SDK — modified
- `packages/sdk/src/contracts.ts` — `SolverNetContract` interface: add `id` + `version`, remove `solverType` and `defaultRuntimePlugins`. Update `PREDICTION_V1_SOLVER_NET_CONTRACT`.
- `packages/sdk/src/contracts.ts` — replace `getSolverNetContract(solverType: string)` with `getSolverNetContract({ id, version })`. Provide internal-only `solverTypeAlias({id, version})` helper for legacy harness dispatch during migration.
- `packages/sdk/src/solvernets/index.ts` — surface re-exports
- `packages/sdk/src/solvernets/prediction-v1.ts` — internal references updated

### SDK — created
- `packages/sdk/src/json-schema.ts` — Zod ↔ JSON Schema serialization helpers, plus type aliases.
- `packages/sdk/src/solvernets/manifest-schema.ts` — `SolverNetManifestV1` interface + Zod runtime validator.

### Client — modified (incremental)
- `client/src/main.ts` — replace generator-loop boot with launched-record-driven spawning; replace `roles.includes('launching')` gate; wire registry client; subscribe registry catalog.
- `client/src/config.ts` — drop default `solverNets.prediction` block; drop `predictionV1*` legacy top-level fields (cadence, allowlist, etc. — moves into the manifest's `generator` config when launched, and into the per-launched-record file for the daemon's running state); update Zod schemas; remove `'launching'` from operator role enum (the role-toggle model is gone).
- `client/src/api/server.ts` — register new `/v1/solvernets/*` routes module; remove old `/v1/launcher/*` routes module after SPA cutover.
- `client/src/solver-types/prediction-v1.ts` — read schemas/eval/agg from `PREDICTION_V1_SOLVER_NET_CONTRACT` (no behavior change beyond rename).
- `client/src/solver-types/prediction-v1-auto.ts` — generator constructor takes a launched-record ref instead of standalone config; in-memory mirror for hot-apply; `getRoles` callback removed (gating moves out).
- `client/src/solver-types/index.ts` — `collectTestnetAutoTaskGenerators` becomes `collectLauncherGenerators` with launched-record-keyed map; remove `getPredictionRoles` argument.
- `client/src/solver-nets/registry.ts` — `forSolverType` retired; replace with `forContractId({id, version})` (compatibility-layer alias) plus a launched-record lookup path. The pre-launch operator-mode `enabled` filter is removed.
- `client/src/api/launcher-endpoints.ts` — *deleted*. Replaced by `client/src/api/solvernets-endpoints.ts`.
- `client/src/api/launcher-status.ts` — *deleted*. Replaced by per-launched-record status reads through registry-backed paths.
- `client/src/api/launcher-tasks.ts` — *deleted*. Replaced by tasks-by-manifest-cid query.
- `client/src/store/store.ts` — `listPostedTasksByCreator` extended to filter by `solverNetManifestCid`; add `countPostedTasksByManifest` helper.
- `client/src/types/task.ts` — Task document gains `solverNetManifestCid` field; `solverType` removed from new types.
- `client/src/tasks/posting-service.ts` — task posting computes `manifestDigest = keccak256(manifestCid)`; passes it to TaskCoordinator (replaces `solverTypeDigest`); records `solverNetManifestCid` in store.
- `client/src/api/setup-endpoints.ts` — operator-mode setup endpoint cleaned of any `'launching'` role handling (legacy from predecessor branch).
- `client/src/api/gather-status.ts` — operator status reads launched-record + registry catalog instead of `solverNets.<name>` config.

### Client — created
- `client/src/solvernets/manifest.ts` — canonicalize / sign / hash / verify (replicates `client/src/network-trust/attestation.ts` shape).
- `client/src/solvernets/registry-client.ts` — `SolverNetRegistryClient` interface + `IdentityRegistryBackedSolverNetRegistryClient` implementation (`publishManifest`, `publishLifecycleTransition`, `listLaunched`, `getManifest`, `getLifecycleStatus`).
- `client/src/solvernets/store.ts` — local launched + draft persistence; matches `EarningBootstrapper` state-machine pattern. Exposes `loadOwnedRecords`, `writeRecord`, `deleteRecord`, `listDrafts`.
- `client/src/solvernets/launch-state-machine.ts` — forward-only checkpointed launch action with crash recovery (phases: pinning → recording → broadcasting → confirming → spawning).
- `client/src/solvernets/lifecycle-transitions.ts` — pause / resume / retire as `setMetadata` writes with checkpointing (phases: broadcasting → confirming).
- `client/src/solvernets/most-recent-wins.ts` — re-export or re-use `client/src/network-trust/most-recent-wins.ts` (lift to shared module if needed).
- `client/src/solvernets/discover.ts` — lift discovery-ranking helpers from `client/src/network-trust/discover.ts` for SolverNet-manifest registry queries.
- `client/src/api/solvernets-endpoints.ts` — `/v1/solvernets/*` Hono routes (drafts CRUD, launch action, lifecycle transitions, owned-list, registry-list).

### Client — tests
- `client/test/solvernets/manifest.test.ts`
- `client/test/solvernets/registry-client.test.ts`
- `client/test/solvernets/store.test.ts`
- `client/test/solvernets/launch-state-machine.test.ts`
- `client/test/solvernets/lifecycle-transitions.test.ts`
- `client/test/api/solvernets-endpoints.test.ts`
- `client/test/solver-types/prediction-v1-auto-launched-gate.test.ts` — generator runs only with owned launched record
- `client/test/solver-nets/registry-launched.test.ts` — `forContractId` / launched-record lookup
- `client/test/store/posted-tasks-by-manifest.test.ts`
- `client/test/dashboard/solvernet-flow.e2e.test.ts` — Playwright real-daemon e2e (launch happy path)

### Contracts (Solidity) — modified
- `contracts/src/tasks/TaskCoordinator.sol` — rename `solverTypeDigest` → `manifestDigest` in struct, event, function args. Storage layout unchanged (same slot, same wire format).
- `contracts/src/staking/JinnRouterV3.sol` — propagate rename through router calls.
- `contracts/src/tasks/AcceptAllChecker.sol` — and any policy hooks using the field.
- `contracts/test/*` — update tests to new naming.
- `contracts/scripts/upgrade-task-coordinator-router-v3.ts` — no logic change; runs against renamed bytecode.

### Subgraph — modified
- `subgraph/schema.graphql` — entity field rename `solverTypeDigest` → `manifestDigest`.
- `subgraph/src/*.ts` — handler rename; `event.params.<name>` access updated.
- `subgraph/abis/TaskCoordinator.json` — re-generated from contracts.

### SPA — modified
- `client/src/dashboard/spa/src/App.tsx` — register new `/launcher/*` routes; deregister predecessor routes during cutover.
- `client/src/dashboard/spa/src/api/types.ts` — replace `LauncherStatusResponse` with `SolverNetSummary`, `LaunchedSolverNet`, `RegistryEntry`, `LaunchAction`, `LifecycleTransition`.
- `client/src/dashboard/spa/src/api/client.ts` — `solvernets.*` client methods (drafts, launch, lifecycle, list).
- `client/src/dashboard/spa/src/shell/Header.tsx` — wordmark + tab nav are mode-aware (also fixes `jinn-mono-p1t4.10` if not already merged from predecessor branch).
- `client/src/dashboard/spa/src/shell/TopTabs.tsx` — mode-aware paths.

### SPA — created
- `client/src/dashboard/spa/src/pages/Launcher.tsx` — owned SolverNets list + Create CTA. **Replaces** predecessor `pages/Launcher.tsx`.
- `client/src/dashboard/spa/src/pages/LauncherCreate.tsx` — 5-step Create flow shell.
- `client/src/dashboard/spa/src/pages/launcher-create/Step1Define.tsx` — name, description, purpose.
- `client/src/dashboard/spa/src/pages/launcher-create/Step2ReviewContract.tsx` — schemas, eval, agg, claim policy, credentials (read-only).
- `client/src/dashboard/spa/src/pages/launcher-create/Step3ConfigureGenerator.tsx` — cadence, allowlist, blocklist, max-rounds, window.
- `client/src/dashboard/spa/src/pages/launcher-create/Step4ConfigurePricing.tsx` — Safe address, prices, balance + runway.
- `client/src/dashboard/spa/src/pages/launcher-create/Step5ReviewLaunch.tsx` — manifest summary + open-roles selection + launch action.
- `client/src/dashboard/spa/src/pages/LauncherLaunched.tsx` — post-launch dashboard for one owned SolverNet.
- `client/src/dashboard/spa/src/pages/launcher-launched/StatusHeader.tsx` — status badge + actions.
- `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx` — last poll, errors, hot-apply config form.
- `client/src/dashboard/spa/src/pages/launcher-launched/TasksPanel.tsx` — recent posted tasks.
- `client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.tsx` — Safe balance + runway + spend.
- `client/src/dashboard/spa/src/pages/launcher-launched/PauseRetireDialog.tsx` — confirmation dialogs.
- `client/src/dashboard/spa/src/pages/operator-catalog/RegistryCatalog.tsx` — operator-side launched-SolverNets list (replaces the auto-prediction default).
- `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx` — manifest-cid-keyed participation flow.

### SPA — deleted (after Phase 5 cutover)
- `client/src/dashboard/spa/src/pages/launcher/SetupFlow.tsx`
- `client/src/dashboard/spa/src/pages/launcher/EmptyState.tsx`
- `client/src/dashboard/spa/src/pages/launcher/KnowledgeProductionCard.tsx`
- `client/src/dashboard/spa/src/pages/launcher/CostCard.tsx`
- `client/src/dashboard/spa/src/pages/launcher/GeneratorStatusCard.tsx`
- `client/src/dashboard/spa/src/pages/launcher/PostedTasksList.tsx`
- `client/src/dashboard/spa/src/pages/launcher/EmissionsPlaceholder.tsx`
- `client/src/dashboard/spa/src/pages/launcher/GeneratorConfigSection.tsx`
- `client/src/dashboard/spa/src/pages/LauncherConfiguration.tsx`
- `client/src/dashboard/spa/src/Launcher.e2e.test.tsx` — replaced by `client/test/dashboard/solvernet-flow.e2e.test.ts`

### Skill — modified
- `.claude/skills/testing-jinn-app/SKILL.md` — Update Walk Surfaces (replace `/launcher` + `/launcher/configuration` with `/launcher`, `/launcher/create`, `/launcher/launched/:id`); update mock list (drop `fetchLauncherStatus` etc., add `solvernets.*`); update "Things to watch for" with launch-state-machine recovery checks and registry-catalog rendering.

---

## Conventions

- TDD per task: write the failing test first, run to confirm failure, write minimal implementation, run to confirm pass, commit.
- Each task ends with a single conventional-commit message: `feat(scope):`, `refactor(scope):`, `test(scope):`, `chore(scope):`. Solidity goes under `contracts(...)`. Subgraph under `subgraph(...)`.
- TypeScript strict; never `any`. Zod is the runtime validator authority for in-app types. JSON Schema is the wire-format authority for manifest schemas.
- Test runner: Vitest. Run via `cd client && yarn vitest run <path>` or `npx tsc --noEmit` for typecheck.
- Subgraph local testing via `cd subgraph && yarn build && yarn test`. Production deploy via the standard subgraph CLI flow.
- Solidity testing via `cd contracts && yarn test`. Live upgrade via `npx hardhat run contracts/scripts/upgrade-task-coordinator-router-v3.ts --network base-sepolia`.
- All file paths in tasks are relative to the worktree root (`/tmp/jinn-solvernet-create`).
- Coordination with predecessor branch: before each Phase, run `git fetch origin && git merge origin/opus/launcher-role-and-mode --no-edit` to absorb in-flight `jinn-mono-p1t4` fixes. Conflicts in the predecessor's `pages/launcher/*` files: take ours (we delete those files in Phase 5 anyway).

---

## Phase 1 — Foundation (additive, no existing code touched)

Each task in this phase creates new files and tests; merging into the predecessor branch is conflict-free.

### Task 1: JSON Schema serialization helpers + manifest schema module

**Files:**
- Create: `packages/sdk/src/json-schema.ts`
- Create: `packages/sdk/src/solvernets/manifest-schema.ts`
- Create: `packages/sdk/test/json-schema.test.ts`
- Create: `packages/sdk/test/solvernets/manifest-schema.test.ts`

- [ ] **Step 1: Define `JsonSchema` type alias and `zodToJsonSchema` helper.** Use existing dependency `zod-to-json-schema` if present; add to `package.json` if not. Add `jsonSchemaToZod` for the reverse direction.
- [ ] **Step 2: Test serialization round-trip.** A Zod schema → JSON Schema → Zod schema validates the same set of inputs.
- [ ] **Step 3: Define `SolverNetManifestV1` interface and Zod validator** in `packages/sdk/src/solvernets/manifest-schema.ts`. Match the shape in `spec/2026-05-05-solvernet-creation-and-launch.md` §7 exactly.
- [ ] **Step 4: Test the validator** with valid and invalid manifests; round-trip JSON.
- [ ] **Step 5: Run `npx tsc --noEmit` from the SDK root.** Should pass.
- [ ] **Step 6: `git add packages/sdk/src/json-schema.ts packages/sdk/src/solvernets/manifest-schema.ts packages/sdk/test/json-schema.test.ts packages/sdk/test/solvernets/manifest-schema.test.ts && git commit -m "feat(sdk): JsonSchema serialization helpers and SolverNetManifestV1 validator"`**

### Task 2: Manifest canonicalize / sign / hash / verify module

**Files:**
- Create: `client/src/solvernets/manifest.ts`
- Create: `client/test/solvernets/manifest.test.ts`

- [ ] **Step 1: Reuse `canonicalJson` from `client/src/harnesses/engine/canonical-json.ts`** (RFC 8785 JCS, already used by network-trust v0).
- [ ] **Step 2: Implement `signManifest(manifest, agentEoaPrivateKey)`.** Strip `signature` field, canonicalize, sha256, EIP-191 personal_sign, return signature struct. Use viem.
- [ ] **Step 3: Implement `verifyManifestSignature(manifest)`.** Recover signer from sig + canonical hash; return `{ valid, signer }`.
- [ ] **Step 4: Implement `manifestHash(manifest)` → `bytes32`** as the canonical hash (without `signature`).
- [ ] **Step 5: Implement `verifyManifestAgainstChain(manifest, identityRegistry, atBlock?)`** — recover signer, query `getAgentByWallet`, query `getSafeForAgent`, assert match against `manifest.launcher.agentId` and `manifest.launcher.safeAddress`. Returns `{ valid, reason? }`.
- [ ] **Step 6: Tests** — sign/verify round trip; tampered body fails; wrong signer fails; chain-binding mismatch detected with mocked IdentityRegistry client.
- [ ] **Step 7: Commit:** `feat(solvernets): manifest canonicalize/sign/hash/verify primitives`.

### Task 3: Registry client interface + types

**Files:**
- Create: `client/src/solvernets/registry-client.ts` (interface only; impl in Task 4)
- Create: `client/test/solvernets/registry-client-types.test.ts`

- [ ] **Step 1: Define `SolverNetRegistryClient` interface** matching spec §13 exactly.
- [ ] **Step 2: Define `SolverNetManifestSummary` and `SignerWithAgentEoa` types.**
- [ ] **Step 3: Smoke test** the interface by building a no-op test double; satisfies the interface.
- [ ] **Step 4: Commit:** `feat(solvernets): SolverNetRegistryClient interface + summary types`.

### Task 4: IdentityRegistry-backed registry client implementation

**Files:**
- Create: `client/src/solvernets/registry-client-erc8004.ts`
- Create: `client/src/solvernets/most-recent-wins.ts` (or import from network-trust)
- Create: `client/test/solvernets/registry-client-erc8004.test.ts`

- [ ] **Step 1: Implement `IdentityRegistryBackedSolverNetRegistryClient`** wrapping `IdentityPublisher` for the `setMetadata` writes. Use existing IPFS client (`client/src/adapters/mech/ipfs.ts`) for pin/fetch.
- [ ] **Step 2: `publishManifest` flow** — pin canonical JSON to IPFS → call `setMetadata(launcherAgentId, "solvernet-manifest:<cid>", encode({status: 'launched', at, hash}))` → return `{cid, txHash, blockNumber}`. Idempotent: re-publish same canonical content yields the same cid.
- [ ] **Step 3: `publishLifecycleTransition` flow** — same `setMetadata` mechanism with target status payload; reuses cid in the key.
- [ ] **Step 4: `listLaunched` flow** — subgraph query for Registered events with `key LIKE 'solvernet-manifest:%'`, fold via `most-recent-wins` to current status per (agentId, cid). No agentId filter (registry is global).
- [ ] **Step 5: `getManifest` flow** — IPFS fetch by cid; verify canonical hash matches; return parsed manifest.
- [ ] **Step 6: `getLifecycleStatus` flow** — query latest `setMetadata` event for the cid; return current status + block.
- [ ] **Step 7: Tests** — mock IPFS + IdentityRegistry + subgraph; verify each method's contract; verify most-recent-wins correctly resolves multiple lifecycle events for the same cid.
- [ ] **Step 8: Commit:** `feat(solvernets): IdentityRegistry-backed registry client (publish/discover/lifecycle)`.

### Task 5: Local launched + draft store

**Files:**
- Create: `client/src/solvernets/store.ts`
- Create: `client/test/solvernets/store.test.ts`

- [ ] **Step 1: Define `LaunchedSolverNetRecord`** TypeScript type matching spec §6.2.
- [ ] **Step 2: Implement `loadOwnedRecords()`** — scan `~/.jinn-client/solvernets/launched/*.json`, parse + validate, return list.
- [ ] **Step 3: Implement `writeRecord(record)`** — atomic write via tmp + rename.
- [ ] **Step 4: Implement `deleteRecord(solverNetId)`** — remove file (used by abandon-failed-launch flow).
- [ ] **Step 5: Implement `loadDraft(draftId)` / `writeDraft(record)` / `listDrafts()` / `deleteDraft(draftId)`** in the parallel `drafts/` directory.
- [ ] **Step 6: Tests** — disk write/read round-trip; corrupted file recovery (file exists but JSON parse fails → log + skip); concurrent-writer safety (atomic-rename pattern).
- [ ] **Step 7: Commit:** `feat(solvernets): local launched + draft persistence store`.

---

## Phase 2 — SDK contract refactor (`solverType` removal at the SDK surface)

This phase is the highest-fanout change; ~414 read sites. Plan: lock the new contract shape first, migrate read sites in batches, keep tests green throughout.

### Task 6: Add `id` + `version`; remove `defaultRuntimePlugins`; update `PREDICTION_V1_SOLVER_NET_CONTRACT`

**Files:**
- Modify: `packages/sdk/src/contracts.ts`
- Modify: `packages/sdk/test/contracts.test.ts`

- [ ] **Step 1: Add `id` and `version` fields to `SolverNetContract` interface** (alongside the existing `solverType` for now — both coexist in this task).
- [ ] **Step 2: Remove `defaultRuntimePlugins` from the interface and `PREDICTION_V1_SOLVER_NET_CONTRACT`.**
- [ ] **Step 3: Populate `id: 'prediction'` and `version: 'v1'` in `PREDICTION_V1_SOLVER_NET_CONTRACT`.**
- [ ] **Step 4: Add the JSON Schema serialization** of existing Zod schemas; add JSON-Schema field alongside Zod for the schemas block (manifest carries JSON Schema; daemon retains Zod for validation ergonomics).
- [ ] **Step 5: Test `PREDICTION_V1_SOLVER_NET_CONTRACT` round-trips through `manifestSchema`** (Phase 1 dependency).
- [ ] **Step 6: Commit:** `feat(sdk): SolverNetContract gains id/version; drop defaultRuntimePlugins`.

### Task 7: Add `getSolverNetContract({ id, version })` overload and internal `solverTypeAlias` helper

**Files:**
- Modify: `packages/sdk/src/contracts.ts`
- Modify: `packages/sdk/src/solvernets/index.ts`
- Modify: `packages/sdk/test/contracts.test.ts`

- [ ] **Step 1: Add `getSolverNetContract({ id, version }): SolverNetContract | undefined`** alongside the existing `getSolverNetContract(solverType: string)`.
- [ ] **Step 2: Implement internal `solverTypeAlias({ id, version }) → string`** as `${id}.${version}`. Used only by the daemon-internal harness dispatch during migration; not exported from the SDK surface.
- [ ] **Step 3: Mark `getSolverNetContract(solverType)` as `@deprecated`** with a TSDoc pointer to the new signature.
- [ ] **Step 4: Tests** — both signatures resolve `PREDICTION_V1_SOLVER_NET_CONTRACT` correctly; alias maps round-trip.
- [ ] **Step 5: Commit:** `feat(sdk): getSolverNetContract({id,version}) overload + internal solverType alias for migration`.

### Task 8: Migrate SDK + client read sites to `id` + `version`

**Files:** ~414 sites; touch in clusters by file. Batch one cluster per commit.

- [ ] **Step 1: Hot files first — `client/src/harnesses/engine/engine.ts` (44 sites)**, `client/src/cli/commands/tasks.ts` (23 sites), `client/src/store/store.ts` (18 sites), `client/src/solver-nets/registry.ts` (13 sites). For each: where the read site uses `solverType` as a routing string, leave it as-is internally (compatibility layer); where it uses `solverType` to look up `SolverNetContract`, switch to the new `({id, version})` getter.
- [ ] **Step 2: Tests touched — `client/test/harnesses/engine/registry.test.ts` (27 sites), `client/test/e2e/task-first-helpers.ts` (21 sites), `client/test/api/launcher-endpoints.test.ts` (13 sites — soon to be deleted), and others.** Update fixtures to use `{id: 'prediction', version: 'v1'}` keying where appropriate.
- [ ] **Step 3: After each cluster: `cd client && yarn vitest run` + `npx tsc --noEmit`.** Commit per cluster: `refactor(<scope>): migrate solverType reads to {id, version}`.
- [ ] **Step 4: Final clean: `npx tsc --noEmit` across the whole repo.** Should pass.
- [ ] **Step 5: Commit summary tag:** `refactor(sdk): all solverType reads migrated to {id, version} ({N} sites)`.

---

## Phase 3 — Daemon-side launch + lifecycle + generator gating

### Task 9: Launch state machine

**Files:**
- Create: `client/src/solvernets/launch-state-machine.ts`
- Create: `client/test/solvernets/launch-state-machine.test.ts`

- [ ] **Step 1: Define `LaunchAction`** state machine class wrapping the 5-phase forward-only progression: `pinning → recording → broadcasting → confirming → spawning`.
- [ ] **Step 2: Each phase persists progress to disk via `store.writeRecord(record)`** before attempting the side effect.
- [ ] **Step 3: Resume logic on daemon startup:** `recoverInFlightLaunches()` scans launched/ for `status: 'launching'` records and resumes from the recorded `launchProgress.phase`.
- [ ] **Step 4: Idempotency:** re-pinning identical canonical JSON yields same cid; setMetadata is event-only and re-broadcasts are safe; daemon scans subgraph for matching cid before re-broadcasting.
- [ ] **Step 5: Tests** — happy path; crash-resume from each phase; revert-on-broadcast handling; mempool-dropped-tx recovery; idempotency under retry.
- [ ] **Step 6: Commit:** `feat(solvernets): forward-only checkpointed launch state machine with crash recovery`.

### Task 10: Lifecycle transitions module

**Files:**
- Create: `client/src/solvernets/lifecycle-transitions.ts`
- Create: `client/test/solvernets/lifecycle-transitions.test.ts`

- [ ] **Step 1: `transitionLifecycle(record, target, registryClient)`** — write `lifecycleProgress.phase = 'broadcasting'`, call `registryClient.publishLifecycleTransition`, write txHash, await confirmation, update record `status` + clear `lifecycleProgress`, fire generator start/stop side-effects.
- [ ] **Step 2: Resume logic:** scan launched/ for records with `lifecycleProgress` set, resume from recorded phase.
- [ ] **Step 3: Generator side-effects:** on `paused | retired`, signal generator stop (via the launcher's launched-record-keyed generator map). On `launched`, signal start.
- [ ] **Step 4: Idempotency:** same target → no-op (already in that state); double pause → second is a no-op-ish event (most-recent-wins resolver handles).
- [ ] **Step 5: Tests** — pause → resume → retire chain; crash-resume from broadcast-pending; double-pause idempotency.
- [ ] **Step 6: Commit:** `feat(solvernets): lifecycle transitions (pause/resume/retire) with crash recovery`.

### Task 11: Daemon startup integration

**Files:**
- Modify: `client/src/main.ts`
- Modify: `client/src/daemon/daemon.ts`

- [ ] **Step 1: Replace startup-time generator construction** (current `collectTestnetAutoTaskGenerators`) with `loadOwnedRecords()` scan; for each record where `status === 'launched'` && `generatorEnabled`, construct the corresponding generator (initially only Prediction, sourced from the manifest's contract).
- [ ] **Step 2: Add `recoverInFlightLaunches()` and `recoverInFlightLifecycleTransitions()`** to startup sequence, after `EarningBootstrapper` completes.
- [ ] **Step 3: Wire registry catalog** for operator-mode reads (cached, refreshed on cadence).
- [ ] **Step 4: Tests** — daemon-init test with mocked store + registry (vitest); confirms generators spawn for each owned launched record; in-flight launch resumes correctly.
- [ ] **Step 5: Commit:** `feat(client): daemon startup loads launched records, resumes in-flight launches`.

### Task 12: Generator gating refactor (launched-record ownership + hot-apply)

**Files:**
- Modify: `client/src/solver-types/prediction-v1-auto.ts`
- Modify: `client/src/solver-types/prediction-v1.ts`
- Modify: `client/src/solver-types/index.ts`
- Modify: `client/src/main.ts`
- Modify: `client/test/solver-types/prediction-v1-auto-state.test.ts`
- Create: `client/test/solver-types/prediction-v1-auto-launched-gate.test.ts`

- [ ] **Step 1: Generator constructor** takes a launched-record reference (closure over the live record on disk). The `getRoles()` callback is **deleted** — gating is "is this generator constructed at all" (driven by Task 11) plus the per-tick `record.status === 'launched' && record.generatorEnabled` check.
- [ ] **Step 2: Hot-apply for generator config:** the constructor takes an `inMemoryConfigRef: { current: GeneratorConfig }`; the API endpoint (Task 14) updates this ref and persists to disk. Per-tick reads `inMemoryConfigRef.current.cadenceMs` etc.
- [ ] **Step 3: Tests** — generator does NOT poll if no owned launched record exists; does NOT poll if status === paused; DOES poll within one tick after status flips to launched; cadence change takes effect within one tick.
- [ ] **Step 4: Commit:** `feat(generator): gate on launched-record ownership; hot-apply config edits via in-memory mirror`.

---

## Phase 4 — Daemon API endpoints

### Task 13: Drafts CRUD endpoints

**Files:**
- Create: `client/src/api/solvernets-endpoints.ts` (initial scaffolding)
- Create: `client/test/api/solvernets-endpoints.test.ts`

- [ ] **Step 1: `POST /v1/solvernets/drafts`** — create draft (returns `draftId`).
- [ ] **Step 2: `GET /v1/solvernets/drafts/:id`**, **`PATCH /v1/solvernets/drafts/:id`**, **`DELETE /v1/solvernets/drafts/:id`**.
- [ ] **Step 3: `GET /v1/solvernets/drafts`** — list owned drafts.
- [ ] **Step 4: Tests** — happy path; validation errors (price not set, openRoles empty); 404 on unknown draft.
- [ ] **Step 5: Commit:** `feat(api): /v1/solvernets/drafts CRUD endpoints`.

### Task 14: Launch + lifecycle endpoints + generator-config hot-apply

**Files:**
- Modify: `client/src/api/solvernets-endpoints.ts`
- Modify: `client/test/api/solvernets-endpoints.test.ts`

- [ ] **Step 1: `POST /v1/solvernets/drafts/:id/launch`** — invokes `LaunchAction` from Task 9. Returns 202 with the in-flight `solverNetId` and a polling URL.
- [ ] **Step 2: `PATCH /v1/solvernets/launched/:id/lifecycle`** — body `{target: 'paused' | 'launched' | 'retired'}` triggers Task 10's transition.
- [ ] **Step 3: `PATCH /v1/solvernets/launched/:id/generator-config`** — updates the in-memory mirror (Task 12) AND writes to disk; returns 200 with the new effective config.
- [ ] **Step 4: `GET /v1/solvernets/launched/:id`** — returns the current launched record state.
- [ ] **Step 5: Tests** — launch happy path; pause/resume/retire transitions; generator-config edit reflected in subsequent `/v1/solvernets/launched/:id` reads; lifecycle on a `retired` record refuses to transition.
- [ ] **Step 6: Commit:** `feat(api): /v1/solvernets launch + lifecycle + generator-config hot-apply`.

### Task 15: Catalog endpoints

**Files:**
- Modify: `client/src/api/solvernets-endpoints.ts`
- Modify: `client/test/api/solvernets-endpoints.test.ts`

- [ ] **Step 1: `GET /v1/solvernets/launched`** — list owned launched records (= what this daemon launched).
- [ ] **Step 2: `GET /v1/solvernets/registry`** — list all launched SolverNets from the global registry. Server-side cached by the daemon's registry-catalog refresh loop.
- [ ] **Step 3: `GET /v1/solvernets/registry/:cid`** — fetch a specific manifest from the registry (lazy IPFS resolve).
- [ ] **Step 4: Tests** — owned vs registry list; cache hit/miss; lifecycle status reflected (paused launches still appear, retired still appear with retired indicator).
- [ ] **Step 5: Commit:** `feat(api): /v1/solvernets owned-list + global-registry endpoints`.

---

## Phase 5 — SPA Launcher Create flow + post-launch dashboard

### Task 16: New routing skeleton

**Files:**
- Modify: `client/src/dashboard/spa/src/App.tsx`
- Modify: `client/src/dashboard/spa/src/api/types.ts`
- Modify: `client/src/dashboard/spa/src/api/client.ts`

- [ ] **Step 1: Replace predecessor routes** `/launcher` and `/launcher/configuration` with new routes:
  - `/launcher` → owned-SolverNets list + Create CTA
  - `/launcher/create` → 5-step Create flow
  - `/launcher/launched/:solverNetId` → post-launch dashboard
- [ ] **Step 2: Replace predecessor `LauncherStatusResponse` types** with new `SolverNetSummary`, `LaunchedSolverNet`, `RegistryEntry`, `LaunchAction`, `LifecycleTransition`.
- [ ] **Step 3: Replace predecessor API client methods** (`fetchLauncherStatus`, `fetchLauncherTasks`, `patchLauncherSolverNet`) with `solvernets.{listLaunched, get, createDraft, updateDraft, launch, transitionLifecycle, updateGeneratorConfig, listRegistry, getManifest}`.
- [ ] **Step 4: Tests** — `App.routing.test.tsx` updates for new routes.
- [ ] **Step 5: Commit:** `feat(spa): replace launcher routes + API client with solvernets shape`.

### Task 17: Owned-SolverNets list page (`/launcher`)

**Files:**
- Create: `client/src/dashboard/spa/src/pages/Launcher.tsx` (replaces predecessor)
- Delete: predecessor `pages/Launcher.tsx` and `pages/launcher/{EmptyState,SetupFlow,KnowledgeProductionCard,CostCard,GeneratorStatusCard,PostedTasksList,EmissionsPlaceholder,GeneratorConfigSection}.tsx`
- Create: `client/src/dashboard/spa/src/pages/Launcher.test.tsx`

- [ ] **Step 1: Empty state** — "No SolverNets created yet" + `[Create SolverNet]` CTA.
- [ ] **Step 2: Owned-list state** — render each owned launched record with status badge, name, contract id/version, recent stats.
- [ ] **Step 3: Tests** — empty state renders correctly; populated list renders correctly.
- [ ] **Step 4: Delete predecessor files** in the same commit (cleanup is part of this task's diff).
- [ ] **Step 5: Commit:** `feat(spa): Launcher list page; delete predecessor SetupFlow / tier-card scaffolding`.

### Task 18: 5-step Create flow

**Files:**
- Create: `client/src/dashboard/spa/src/pages/LauncherCreate.tsx`
- Create: `client/src/dashboard/spa/src/pages/launcher-create/Step1Define.tsx`
- Create: `client/src/dashboard/spa/src/pages/launcher-create/Step2ReviewContract.tsx`
- Create: `client/src/dashboard/spa/src/pages/launcher-create/Step3ConfigureGenerator.tsx`
- Create: `client/src/dashboard/spa/src/pages/launcher-create/Step4ConfigurePricing.tsx`
- Create: `client/src/dashboard/spa/src/pages/launcher-create/Step5ReviewLaunch.tsx`
- Create: tests for each.

- [ ] **Step 1: Step1Define** — name, description, purpose; persists to draft via `solvernets.updateDraft`.
- [ ] **Step 2: Step2ReviewContract** — read-only schemas/eval/agg/policy/credentials, sourced from the chosen template (`PREDICTION_V1_SOLVER_NET_CONTRACT`). Forward only.
- [ ] **Step 3: Step3ConfigureGenerator** — cadence, allowlist, blocklist, max-rounds-per-poll/day, max-open-rounds, window. Pre-filled from template defaults.
- [ ] **Step 4: Step4ConfigurePricing** — funding Safe (defaults to launcher master), `solutionPriceWei`, `verdictPriceWei`, current Safe balance, projected number of Tasks at chosen prices. **Replaces** the predecessor's literal `N` placeholder budget step (jinn-mono-p1t4.4).
- [ ] **Step 5: Step5ReviewLaunch** — manifest summary, `openRoles` checkboxes, `[Launch]` action invokes `solvernets.launch(draftId)`. Shows launch-state-machine progress (`pinning → recording → broadcasting → confirming → spawning`).
- [ ] **Step 6: Tests** — each step's validation rules; full flow happy path with mocked API.
- [ ] **Step 7: Commit:** `feat(spa): 5-step Create flow with launch state-machine progress`.

### Task 19: Post-launch dashboard

**Files:**
- Create: `client/src/dashboard/spa/src/pages/LauncherLaunched.tsx`
- Create: `client/src/dashboard/spa/src/pages/launcher-launched/{StatusHeader,GeneratorPanel,TasksPanel,SpendPanel,PauseRetireDialog}.tsx`
- Create: tests for each.

- [ ] **Step 1: StatusHeader** — status badge (launched/paused/retired), name, launcher identity, Pause/Resume/Retire action buttons.
- [ ] **Step 2: GeneratorPanel** — last poll, errors, hot-apply config form (cadence, allowlist, etc.). Save invokes `solvernets.updateGeneratorConfig`.
- [ ] **Step 3: TasksPanel** — recent posted Tasks (paginated by posted-time cursor). Replaces predecessor PostedTasksList.
- [ ] **Step 4: SpendPanel** — Safe balance, projected runway at current prices.
- [ ] **Step 5: PauseRetireDialog** — Pause is single-click confirm; Retire requires typed-name match.
- [ ] **Step 6: Tests** — each panel renders correctly; lifecycle action flows; hot-apply visible without daemon restart (mocked refresh).
- [ ] **Step 7: Commit:** `feat(spa): post-launch dashboard with pause/retire/hot-apply`.

---

## Phase 6 — Operator catalog refactor

### Task 20: Operator catalog reads from registry

**Files:**
- Create: `client/src/dashboard/spa/src/pages/operator-catalog/RegistryCatalog.tsx`
- Modify: `client/src/dashboard/spa/src/pages/configuration/SolverNetsSection.tsx` — replaces the legacy hardcoded Prediction entry with registry-sourced list.
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx` — operator card sources from registry (or owned roles list).
- Modify: tests.

- [ ] **Step 1: New RegistryCatalog component** lists all launched SolverNets from `solvernets.listRegistry`, with status badges and "Join" CTAs.
- [ ] **Step 2: Replace SolverNetsSection's hardcoded entry** with the registry-driven list. Operator participation is per-manifest-cid.
- [ ] **Step 3: Overview's OperatorCard** shows the operator's joined SolverNets (from `solverNets[manifestCid]` config blocks); empty state if none. Replaces the legacy `enabled` flag gating (jinn-mono-p1t4.3).
- [ ] **Step 4: Tests** — empty registry state ("No launched SolverNets available"); populated state; operator-side join flow updates config correctly.
- [ ] **Step 5: Commit:** `feat(spa): operator catalog reads from registry; OperatorCard fixed gating`.

### Task 21: Operator participation flow keyed by manifestCid

**Files:**
- Create: `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx`
- Modify: `client/src/dashboard/spa/src/pages/configuration/NetCard.tsx` — keys per manifestCid instead of solverNet name.
- Modify: tests.

- [ ] **Step 1: JoinFlow component** — pick roles from `manifest.openRoles`; for solver role, pick harness/plugins/model; submit → API writes config keyed by manifestCid.
- [ ] **Step 2: NetCard renders** per joined manifestCid; shows manifest summary, current roles, harness selection.
- [ ] **Step 3: Tests** — joining writes correct config block; leaving deletes the block; evaluator role hides harness picker (harness comes from manifest.contract).
- [ ] **Step 4: Commit:** `feat(spa): operator participation flow keyed by manifestCid`.

### Task 22: Drop legacy `solverNets.prediction` default config + migrate Zod schema

**Files:**
- Modify: `client/src/config.ts`
- Modify: `client/test/config.test.ts`

- [ ] **Step 1: Drop the default `solverNets.prediction` block** entirely from the config schema; default is `{}`.
- [ ] **Step 2: Drop legacy fields** that are now handled by manifest/launched-record: `predictionV1CadenceMs`, `predictionV1MaxNewRoundsPerPoll`, `predictionV1MaxNewRoundsPerDay`, `predictionV1MaxOpenRounds`, `predictionV1AllowlistConditionIds`, `predictionV1BlocklistConditionIds`, `predictionV1WindowMs`, `predictionV1ResolveGapMs`. (Their values now live in the launched record's generator config block.)
- [ ] **Step 3: Drop `'launching'` from operator-role enum.** Operator config has only `'solving'` and `'evaluating'` roles. Launcher-side flagging happens via launched-record ownership, not via roles.
- [ ] **Step 4: Tests** — fresh config has no `solverNets`; legacy keys produce a warning + deprecation message (we accept and ignore for one cycle).
- [ ] **Step 5: Commit:** `chore(config): drop legacy solverNets.prediction default + predictionV1* fields + 'launching' role`.

---

## Phase 7 — On-chain wire format change (Solidity + subgraph)

### Task 23: Solidity rename `solverTypeDigest` → `manifestDigest`

**Files:**
- Modify: `contracts/src/tasks/TaskCoordinator.sol`
- Modify: `contracts/src/staking/JinnRouterV3.sol`
- Modify: any policy hooks (`AcceptAllChecker.sol`, `RestorationActivityChecker.sol`).
- Modify: `contracts/test/*` — rename usages.

- [ ] **Step 1: Rename in struct, event, function args.** Storage layout unchanged (same slot, same wire). Function selectors unchanged (param names don't affect them).
- [ ] **Step 2: Update Solidity tests** to use new naming.
- [ ] **Step 3: Run `cd contracts && yarn test`.** Should pass.
- [ ] **Step 4: Commit:** `contracts(tasks): rename solverTypeDigest -> manifestDigest`.

### Task 24: Task posting computes `manifestDigest = keccak256(manifestCid)`

**Files:**
- Modify: `client/src/tasks/posting-service.ts`
- Modify: `client/src/types/task.ts`
- Modify: `client/test/tasks/posting-service.test.ts`

- [ ] **Step 1: Task document gains `solverNetManifestCid` field** (BINDING, replaces `solverType` for protocol identity).
- [ ] **Step 2: `postTask` computes `manifestDigest = keccak256(manifestCid)`** and passes that in the TaskCoordinator call args (replaces the previous `keccak256(solverType)` digest).
- [ ] **Step 3: Tests** — posted task on-chain digest matches `keccak256(manifestCid)`; task store records `solverNetManifestCid`.
- [ ] **Step 4: Commit:** `feat(tasks): manifestDigest = keccak256(manifestCid); task documents carry solverNetManifestCid`.

### Task 25: Subgraph rename + redeploy

**Files:**
- Modify: `subgraph/schema.graphql`
- Modify: `subgraph/src/*.ts`
- Modify: `subgraph/abis/TaskCoordinator.json` (regenerated).

- [ ] **Step 1: Rename schema entity field `solverTypeDigest` → `manifestDigest`.**
- [ ] **Step 2: Rename handler accesses `event.params.solverTypeDigest` → `event.params.manifestDigest`.**
- [ ] **Step 3: Re-generate ABI.**
- [ ] **Step 4: `cd subgraph && yarn build && yarn test`.** Should pass.
- [ ] **Step 5: Document the re-deploy command** for testnet (graph deploy via the standard CLI flow); do not run live yet — bundled with Phase 9 deployment.
- [ ] **Step 6: Commit:** `subgraph: rename solverTypeDigest -> manifestDigest`.

### Task 26: Run upgrade-task-coordinator-router-v3 on testnet (deploys new bytecode under existing proxy)

This is a manual / coordinated step, not a code commit.

- [ ] **Step 1: Confirm `cd contracts && yarn test`** passes against the renamed contracts.
- [ ] **Step 2: `npx hardhat run contracts/scripts/upgrade-task-coordinator-router-v3.ts --network base-sepolia`** — preserves proxy addresses, replaces implementation.
- [ ] **Step 3: Verify the upgrade by calling the deployed contract** with the new ABI; struct field reads correctly.
- [ ] **Step 4: Document the testnet task-data clean-break** in a short ops note: in-flight tasks posted under the old digest semantic are orphaned; new tasks use `manifestDigest`. Fleets keep their identities.
- [ ] **Step 5: Subgraph re-deploy** (separate CLI invocation, with re-index from current block).
- [ ] **Step 6: No git commit** for the deployment itself; commit any deployment-tracking JSON updates (`deployment-task-coordinator-router-v3-baseSepolia*.json`) under: `chore(deploy): testnet upgrade for manifestDigest rename`.

---

## Phase 8 — Task attribution wire-up (final piece of the protocol-language refactor)

### Task 27: Task validation resolves manifest → contract → schemas

**Files:**
- Modify: `client/src/tasks/task-validation.ts` (or wherever task validation lives)
- Modify: `client/src/harnesses/engine/engine.ts`
- Modify: tests.

- [ ] **Step 1: Task validation pipeline** — given a task document, resolve `solverNetManifestCid` via the registry, fetch the manifest, validate the task body against `manifest.contract.schemas.task`. Drop the legacy `solverType`-keyed schema lookup path.
- [ ] **Step 2: Harness dispatch reads** `manifest.contract.id + version` (and uses `solverTypeAlias` internally where the legacy harness map keys by `solverType` string — alias getter from Task 7).
- [ ] **Step 3: Tests** — invalid task body fails validation; missing manifest fails resolution; harness dispatched correctly for prediction.v1.
- [ ] **Step 4: Commit:** `feat(tasks): validation resolves manifest -> contract -> schemas; harness dispatch via {id,version}`.

### Task 28: Operator-side claim-eligibility filter uses `manifestDigest`

**Files:**
- Modify: `client/src/daemon/{creator,delivery-watcher}.ts` and any claim policy hooks.
- Modify: tests.

- [ ] **Step 1: Operator's claim eligibility check** uses the on-chain `manifestDigest` (now manifest-bound) to filter to tasks they've joined (their config has `solverNets[manifestCid]` for matching cid). Replaces the previous `solverType`-based eligibility filter.
- [ ] **Step 2: Tests** — operator joined Launcher A's Prediction does NOT see Launcher B's Prediction tasks (different manifestCid → different manifestDigest).
- [ ] **Step 3: Commit:** `feat(daemon): claim eligibility filtered by manifestDigest`.

---

## Phase 9 — Cleanup + final verification

### Task 29: Real-daemon Playwright e2e for launch happy path

**Files:**
- Create: `client/test/dashboard/solvernet-flow.e2e.test.ts`

- [ ] **Step 1: Spawn daemon** against a fresh tmpdir HOME (not the operator's real `~/.jinn`), with mocked Polymarket adapter so launches don't actually post tasks beyond manifest publish.
- [ ] **Step 2: Mock IPFS** to a local in-memory store; mock `IdentityRegistry.setMetadata` to a deterministic fake; mock subgraph reads.
- [ ] **Step 3: Walk Operator → Launcher mode → Create flow steps 1-5 → Launch.** Assert: launched record on disk; manifest pinned; setMetadata fired with expected args; generator runtime ownership correct.
- [ ] **Step 4: Walk pause → resume → retire** through the post-launch dashboard. Assert: setMetadata called with each target status; generator stops on pause/retire; resumes on resume.
- [ ] **Step 5: Walk operator-side** — switch to Operator mode, see the launched SolverNet in the catalog (from the mocked subgraph), join, assert local config has the manifestCid-keyed entry, evaluator harness comes from the manifest (not operator config).
- [ ] **Step 6: Crash-resume scenario:** start a launch, kill the daemon mid-broadcast, restart, assert the launch resumes and completes.
- [ ] **Step 7: Commit:** `test(spa): real-daemon Playwright e2e for solvernet creation/launch/lifecycle`.

### Task 30: Remove SDK `solverType` field, delete unused legacy code

**Files:**
- Modify: `packages/sdk/src/contracts.ts` — delete `solverType` from `SolverNetContract` interface; delete the deprecated `getSolverNetContract(solverType)` overload (after confirming no client code uses it post-Phase 2).
- Delete: legacy `predictionV1*` files in client where superseded.
- Modify: `client/src/solver-types/solver-type.ts` — clean up legacy types.
- Modify: tests.

- [ ] **Step 1: Verify zero callers** of the deprecated `getSolverNetContract(solverType: string)` signature outside daemon-internal alias paths.
- [ ] **Step 2: Remove the deprecated signature.**
- [ ] **Step 3: Remove `solverType` field from `SolverNetContract`.**
- [ ] **Step 4: Delete unused legacy paths** — `client/src/solver-types/index.ts`'s `getPredictionRoles` parameter, etc.
- [ ] **Step 5: Final `cd client && yarn vitest run` + `npx tsc --noEmit`.** All green.
- [ ] **Step 6: Commit:** `chore(sdk): remove SolverNetContract.solverType + deprecated getter; delete legacy paths`.

### Task 31: Update `testing-jinn-app/SKILL.md` + spec text + CLAUDE.md

**Files:**
- Modify: `.claude/skills/testing-jinn-app/SKILL.md`
- Modify: `CLAUDE.md` (the cargo-level one) — update launcher-mode references to point at the new flow.
- Modify: `client/ARCHITECTURE.md` — update generator-ownership and registry sections.

- [ ] **Step 1: Skill update — Walk Surfaces** section: replace `/launcher` + `/launcher/configuration` with `/launcher`, `/launcher/create`, `/launcher/launched/:id`. Update mock list (drop predecessor methods, add new `solvernets.*`). Update "Things to watch for" with launch-state-machine recovery checks and registry-catalog rendering.
- [ ] **Step 2: CLAUDE.md** — update the "How the daemon works" section's generator description; update phase notes if needed.
- [ ] **Step 3: ARCHITECTURE.md** — update the launched-record gating section.
- [ ] **Step 4: Commit:** `docs: update testing-jinn-app skill, CLAUDE.md, ARCHITECTURE.md for solvernet creation flow`.

---

## Phase 10 — Bd epic + finalize

### Task 32: File bd epic + child issues mirroring this plan

(Done by the human / parent agent, not in code.)

- [ ] **Step 1: `bd create --type=epic --priority=1 --title="EPIC: SolverNet creation and launch experience"`** with a body summarizing the spec + plan + locked decisions.
- [ ] **Step 2: Create child issues** per task above. Use `--parent=<epic-id>` and titles matching the task headings.
- [ ] **Step 3: Cross-link** to `jinn-mono-p1t4` (the predecessor Launcher mode bug epic) noting that this epic supersedes the predecessor design and absorbs the fixes the other session has been making.

### Task 33: Final integration check + push

- [ ] **Step 1: Merge `origin/opus/launcher-role-and-mode` into our branch** one final time to absorb any straggler fixes from the predecessor session.
- [ ] **Step 2: Resolve conflicts** by deleting predecessor Launcher-mode files (which our Phase 5 already does) and keeping our new structure.
- [ ] **Step 3: Run full test sweep:** `cd client && yarn typecheck && yarn vitest run && yarn workspace @jinn-network/operator-spa build && (cd ../packages/sdk && yarn typecheck && yarn vitest run) && (cd ../contracts && yarn test) && (cd ../subgraph && yarn build && yarn test)`.
- [ ] **Step 4: `git push origin opus/solvernet-creation-and-launch`.**
- [ ] **Step 5: Open a PR** against `main` (or staging branch); cross-link the epic and the spec.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Solidity rename breaks fleets that haven't upgraded | Low (proxy upgrade preserves addresses) | Medium | Document the testnet clean-break; coordinate with any external testers |
| Subgraph re-index lag after redeploy | Medium | Low | Re-index from current block (not genesis); operator catalog will lag for ~minutes after upgrade |
| Manifest schema drift between SDK and daemon Zod parsers | Low | High | Single source of truth: SDK exports both JSON Schema and derived Zod parser; tests round-trip |
| Concurrent session merging the wrong way | Low (we delete predecessor Launcher files) | Medium | Phase 5 deletion + clear conventions in this plan; pre-merge resolution rule |
| Hot-apply mirror gets out of sync with disk record | Low | Medium | Single writer (the API endpoint); reads always go through the in-memory mirror; restart re-reads from disk |
| Launch state machine deadlocks on impossible-to-confirm tx | Low | Medium | Per-phase attemptCount + max retries; on max-retries-exceeded, mark `failed` and surface to UI for abandon-or-retry |
| `evaluationFunction.implementation` reference doesn't resolve at operator's daemon | Low (day-1 bundled) | High | Ship the canonical implementation in the daemon bundle; operators on the same release have the impl |
| Operator catalog spam (junk launchers) | Low day-1 (single launcher) | Medium long-term | Out-of-scope for this PR; future epic for filtering UI / followed-launchers |

---

## Verification checklist (run before opening PR)

- [ ] `cd client && yarn typecheck` passes
- [ ] `cd client && yarn vitest run` — all tests pass
- [ ] `cd client && yarn workspace @jinn-network/operator-spa build` — passes (with pre-existing Vite chunk warning OK)
- [ ] `cd packages/sdk && yarn typecheck && yarn vitest run` — passes
- [ ] `cd contracts && yarn test` — Hardhat tests pass
- [ ] `cd subgraph && yarn build && yarn test` — builds and tests pass
- [ ] `git diff --check` — no whitespace errors
- [ ] Solidity proxy upgrade ran successfully on Base Sepolia (deployment JSON updated)
- [ ] Subgraph redeployed on Base Sepolia (re-index from current block)
- [ ] Real-daemon Playwright e2e (`solvernet-flow.e2e.test.ts`) passes
- [ ] testing-jinn-app skill updated with new walk recipe
- [ ] Spec at `spec/2026-05-05-solvernet-creation-and-launch.md` matches what shipped (cross-check the eleven locked decisions)

---

## Out of scope for this PR (filed as follow-up issues)

- Cap fields in the manifest budget (`maxOpenBudgetWei`, `maxDailyBudgetWei`).
- Operator-side verification of manifest-vs-on-chain task policy match.
- Followed-launcher list, blocklists, curated launcher index UI.
- In-place version bumps without retire-relaunch (`previousManifestCid` chain).
- External-launcher distribution path for canonical evaluator implementations.
- Cancel-on-retire (close in-flight tasks on-chain).
- Removing the daemon-internal `solverType` alias (kept for one cycle through harness dispatch).
- Marketplace / payment redesign beyond TaskCoordinator.

---

## Appendix A — Predecessor branch coordination

The predecessor branch `opus/launcher-role-and-mode` has the following bd epic active: `jinn-mono-p1t4` (Launcher mode SPA-vs-daemon coherence bugs from the live smoke session). The other session has fixed:

- ✓ `.1` Generator never registered as TaskSource — via `generated-source-gate.ts`. **This becomes obsolete in this plan** — the new gating model (launched-record ownership, Phase 3 Task 12) replaces both the predecessor's `enabled`-flag filter and the `.1` gate. The new model has neither, so the gate file can be deleted in Phase 5 cleanup if it merges in.
- ✓ `.2` Generator-config edits do not hot-apply — fixed via in-memory mirror. **Carries forward**: the new generator constructor (Task 12) takes the same in-memory mirror pattern.
- ✓ `.3` OperatorCard empty state shown despite roles — fixed in Overview.tsx. **Carries forward** but is replaced wholesale by Task 20's registry-driven OperatorCard.
- ✓ `.4` Budget plan literal `N` placeholder — fixed in SetupFlow. **Replaced** wholesale by Task 18 Step4ConfigurePricing.
- ✓ `.5` Save feedback — fixed in GeneratorConfigSection. **Replaced** wholesale by Task 19 GeneratorPanel.
- ✓ `.8` xterm a11y leak — fixed in AgentRail.tsx. **Carries forward** unchanged.
- ✓ `.9` AgentRail terminal wrap — fixed in AgentRail. **Carries forward** unchanged.
- Open: `.6` real-daemon Playwright e2e — **subsumed** by Task 29 of this plan.
- Open: `.7` misleading startup log — fixable independently; a small cleanup either branch can take.
- Open: `.10` tab nav silently flips mode — should be fixed in this plan's Task 16 (Header / TopTabs become mode-aware).

Merge approach (per Phase preamble): periodic `git merge origin/opus/launcher-role-and-mode --no-edit` from the predecessor branch into this one. Conflicts in `pages/launcher/*.tsx` files resolve by **deleting our copies** (Phase 5 deletes them outright). Conflicts in `Header.tsx` / `TopTabs.tsx` resolve by taking the predecessor's `.10` fix and layering this plan's Task 16 mode-aware paths on top.

---

## Appendix B — Daemon-internal `solverType` alias retirement schedule

This plan intentionally keeps a daemon-internal `solverType` alias (computed as `${id}.${version}`) in:

- Harness dispatch (`client/src/harnesses/engine/engine.ts`)
- Task store keying (`client/src/store/store.ts`)
- A few CLI commands (`client/src/cli/commands/tasks.ts`)
- Subgraph indexer field name (post-rename it's `manifestDigest` for the digest, but a `solverType` derived field for human-readability may persist temporarily)

These aliases are non-product-surface (no manifest field, no SPA reference, no operator config keying). They retire in a follow-up: file `jinn-mono-XXXX` titled "Remove daemon-internal solverType alias" once the SolverNet creation work has been live for one cycle and we've confirmed no harness-pack consumers depend on the alias name in any plug-in manifest.
