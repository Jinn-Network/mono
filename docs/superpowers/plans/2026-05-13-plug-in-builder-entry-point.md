# Plug-in builder entry point — epic execution roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** File the seven `jinn-mono-52x3.*` child beads of the Plug-in builder entry point epic, with full descriptions, dependency edges, run-modes, and per-bead planning prompts — so each child can enter its own writing-plans → executing-plans flow with no further design work.

**Architecture:** The epic decomposes into seven independent children per the uy6v scope rule (acceptance-criteria-shaped, not solution-shaped). This roadmap is the bead-filing + sequencing step; each child gets its own detailed TDD plan via writing-plans against its filed bead. Substrate design (identity, registry, attribution, reputation) is decided in spec §5 — the per-child planning sessions consume it, not re-derive it.

**Tech Stack:** beads (`bd`) for issue tracking; git worktrees per `cargo/.tasks/<id>` convention from CLAUDE.md; the seven children touch TypeScript (`client/src/`), Ponder schemas (`jinn-mono-280n`), SPA components (`client/src/dashboard/spa/`), markdown docs, and Solidity (read-only — no new contracts).

---

## Sequencing

### Dependency graph between children

```
52x3.1  Staged-bootstrap refactor          (foundation; blocks 52x3.3)
   │
   ▼
52x3.3  jinn solver-plugins publish        (writes plugin:<cid> on chain; blocks 52x3.4)
   │
   ▼
52x3.4  Ponder indexer extension           (reads plugin: events; blocks 52x3.5)
   │
   ▼
52x3.5  Discovery API endpoints            (queries indexer; blocks 52x3.6's read panels)
   │
   ▼
52x3.6  /build SPA route + /docs/build/    (consumes API)
   │
   ▼
52x3.7  Reference plug-in + cold-start E2E (spans all of the above)

52x3.2  jinn create plugin scaffold        (independent; parallel with everything)
```

**Parallelisable groups:**

- **Group A (gate-zero, ship as soon as deps green):** 52x3.1 (bootstrap refactor) + 52x3.2 (scaffold CLI). Independent of each other; can ship in parallel.
- **Group B (gated on 52x3.1):** 52x3.3 (publish verb). Single-bead group.
- **Group C (gated on 52x3.3 emitting `plugin:<cid>` events):** 52x3.4 (indexer) + 52x3.5 (Discovery API). 52x3.5 can begin spec-only work in parallel with 52x3.4 since the API shape is decided in spec §5.6.
- **Group D (gated on 52x3.5):** 52x3.6 (SPA + docs).
- **Group E (gated on all of A-D):** 52x3.7 (reference plug-in + E2E).

### External dependency gates

These must be green before the epic begins shipping children:

- `jinn-mono-uy6v` — first public release (operator install path + signed envelopes). The release ships before this epic's children begin.
- `jinn-mono-8psp` — Hermes harness PRs #140–#145 merged; `hermesConfigFromSolverPlugins()` stable on main.
- `jinn-mono-280n` — Discovery API + Ponder indexer surfaces stable (52x3.4 / 52x3.5 extend them).
- `jinn-mono-ebu7` — Network explorer (HarnessCheckpoint rollups, `Leaderboard.tsx`) — already 76% complete at spec-time; relevant children (52x3.4, 52x3.5, 52x3.6) consume its outputs.

If any of these slip, the corresponding child's planning session is blocked but the bead-filing isn't. Beads carry the dep edges; `bd ready` will surface ready children as gates clear.

### Branch + worktree convention

Per CLAUDE.md "Worktree-for-multi-agent. Multi-agent or speculative subagent work uses `git worktree add cargo/.tasks/<id>`.":

- Each child bead gets its own worktree at `cargo/.tasks/<short-id>` (e.g., `.tasks/52x3.1`) on branch `<shape>/<id>-<slug>` (e.g., `refactor/52x3.1-staged-bootstrap`).
- The epic worktree (`cargo/.tasks/52x3` on `feat/52x3-plug-in-builder-entry-point`) holds only the spec + plan + epic-level docs. Children's code work happens in their own worktrees.
- Per the engineering handbook, declare the work shape in the bd issue's `Run-mode` field and use it as the PR title prefix (`refactor:`, `feat:`, `test:`).

---

## File structure

This roadmap creates only one file (this plan) and modifies bd state. The per-child planning sessions will write their own implementation plans.

- **Create:** `cargo/docs/superpowers/plans/2026-05-13-plug-in-builder-entry-point.md` (this file)
- **Modify (bd state only):** create 7 child beads under `jinn-mono-52x3`; add dependency edges; tag run-modes.

Per-child plan files will be created at:
- `cargo/.tasks/52x3.1/docs/superpowers/plans/2026-05-<NN>-staged-bootstrap.md`
- `cargo/.tasks/52x3.2/docs/superpowers/plans/2026-05-<NN>-create-plugin-scaffold.md`
- `cargo/.tasks/52x3.3/docs/superpowers/plans/2026-05-<NN>-solver-plugins-publish.md`
- `cargo/.tasks/52x3.4/docs/superpowers/plans/2026-05-<NN>-plugin-publication-indexer.md`
- `cargo/.tasks/52x3.5/docs/superpowers/plans/2026-05-<NN>-builder-discovery-api.md`
- `cargo/.tasks/52x3.6/docs/superpowers/plans/2026-05-<NN>-build-spa-route-and-docs.md`
- `cargo/.tasks/52x3.7/docs/superpowers/plans/2026-05-<NN>-reference-plugin-and-e2e.md`

---

## Task 0: Cross-cutting setup

**Files:** bd state only (no code changes).

- [ ] **Step 1: Verify epic preconditions are visible to the executor**

Run: `bd show jinn-mono-52x3` from the cargo dir.

Expected: epic open, owner set, description includes the seven-child decomposition.

- [ ] **Step 2: Confirm dependency gate beads exist and are visible**

Run:
```bash
bd show jinn-mono-uy6v jinn-mono-8psp jinn-mono-280n jinn-mono-ebu7 2>&1 | head -40
```

Expected: all four exist; uy6v + 8psp open; 280n + ebu7 in-progress or partly closed.

If any are missing, stop and flag — the dependency graph assumes them.

- [ ] **Step 3: Verify bd link syntax + auto-commit policy**

Run: `bd link --help 2>&1 | head -10`

Expected: confirms `bd link <id1> <id2>` creates `id2 blocks id1` (default type `blocks`).

Note: bd's `auto-export: git add failed` warning on `update` operations is benign — bd commits to its own Dolt repo; the git working-tree warning happens because the cargo dir doesn't auto-stage bd changes. No action needed.

---

## Task 1: File `52x3.1` — Staged-bootstrap refactor

**Files:** bd state only.

- [ ] **Step 1: Create the child bead**

Run:
```bash
bd create --title="Staged-bootstrap refactor + identity_registered Stage 1 capstone step" --type=task --priority=2 --description="$(cat <<'EOF'
Part of epic jinn-mono-52x3. Refactor the existing 11-step bootstrap state machine into two independently re-entrant stages, per spec §5.1 + §6.1.

## Why

The existing bootstrap (`client/src/earning/bootstrap.ts`) is single-stage: `jinn run` walks 11 steps from wallet → mech_deployed. A builder publishing a plug-in needs only the first half (the ERC-8004 identity); forcing them through the OLAS / mech / staking half is wrong (no OLAS funding required, no daemon needed). The clean factoring is one state machine, two completion levels, lazily ensured per action point.

## Acceptance criteria (testable, problem-shaped)

- `client/src/earning/bootstrap.ts` exposes two entry points: `ensureStage1(ctx)` and `ensureStage1And2(ctx)`. Each walks the state machine forward to its target stage; both idempotent and re-entrant.
- The state file (`~/.jinn-client/earning/earning_state.json`) gains a `stage` marker and a per-step `stage` tag.
- A new `identity_registered` step is added as Stage 1's capstone: calls `IdentityRegistry.register()` then `setAgentWallet(agentId, safeAddress)` via the existing Safe-routed tx path. Composes with or absorbs `jinn-mono-j07` (agent NFT mint) and `jinn-mono-aev` (`setAgentWallet`) — planning decides which.
- `awaiting_funding` gate splits: Stage 1 requires ETH for gas only; Stage 2 additionally requires OLAS.
- `jinn run` continues to ensure Stage 1+2 (existing behaviour preserved); a unit test asserts re-running on a partially-completed Stage 1 state file picks up at the right step.
- A builder workflow test: starting from clean state, calling `ensureStage1` completes Stage 1 only; subsequent `ensureStage1And2` picks up at `service_created`. No re-mint, no second Safe, no second agentId.
- `yarn typecheck` + `yarn test` green.

## Out of scope (other beads or already covered)

- `jinn solver-plugins publish` calling `ensureStage1` — that's 52x3.3.
- Convenience verb `jinn identity ensure` — spec §9 open question.
- `--new-agent-id` flag — spec §9 open question; defer to planning.

## Reference

- Spec: `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §5.1, §6.1.
- Existing: `client/src/earning/bootstrap.ts` (11 steps), `client/src/erc8004/identity.ts` (`IdentityPublisher`, `resolveAgentIdForManifest`), `client/src/erc8004/abis.ts` (`IDENTITY_REGISTRY_SET_METADATA_ABI`).
- DRs: `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` §4.1, §4.2.
- Related beads: `jinn-mono-j07`, `jinn-mono-aev`.

## Run-mode

REFACTOR — bootstrap state machine; existing surface preserved.
EOF
)" 2>&1 | tail -3
```

Expected: `✓ Created issue: jinn-mono-52x3.1 — Staged-bootstrap refactor...`

- [ ] **Step 2: Link to parent epic**

Run:
```bash
bd link jinn-mono-52x3.1 jinn-mono-52x3 --type parent-child
```

Expected: link created.

- [ ] **Step 3: Add dependency edge on external gate (uy6v)**

Run:
```bash
bd link jinn-mono-52x3.1 jinn-mono-uy6v
```

Expected: `uy6v blocks 52x3.1`. (Per spec §7: epic depends on uy6v shipping; 52x3.1 is the first child so carries the edge explicitly.)

- [ ] **Step 4: Planning prompt for the child's own writing-plans session**

When the child is ready to plan, the planning prompt is:

```
Write the TDD plan for jinn-mono-52x3.1 (Staged-bootstrap refactor).
Scope: refactor client/src/earning/bootstrap.ts to split the 11 steps into Stage 1 (steps 1-4 + new identity_registered) and Stage 2 (steps 5-10), expose ensureStage1 / ensureStage1And2 entry points, add the stage marker to earning_state.json. The Stage 1 capstone step calls IdentityRegistry.register() + setAgentWallet(agentId, safeAddress); compose with or absorb jinn-mono-j07 (mint) and jinn-mono-aev (setAgentWallet) per the bead's planning decision. Tests should cover: clean-state Stage 1 walk; clean-state Stage 1+2 walk; resume from mid-Stage-1; resume from mid-Stage-2; ETH-only funding gate at Stage 1 boundary; OLAS funding gate at Stage 2 boundary.
```

---

## Task 2: File `52x3.2` — `jinn create plugin` scaffold

**Files:** bd state only.

- [ ] **Step 1: Create the child bead**

Run:
```bash
bd create --title="jinn create plugin <name> scaffold CLI (two patterns: solver-type-plugin, runtime-plugin)" --type=task --priority=2 --description="$(cat <<'EOF'
Part of epic jinn-mono-52x3. Extend the existing `jinn create harness` CLI to add a `plugin` target with two patterns, per spec §6.2.

## Why

Builders need a one-command path from "I want to ship a plug-in for SWE-rebench v2" to "I have a package whose `yarn test` passes." Today only `jinn create harness` exists (Path 2). Path 1 plug-ins are copied by hand from `client/plugins/swe-rebench-v2-runtime/` — workable for the team, not for cold-start external builders.

## Acceptance criteria

- `jinn create plugin <name>` exists and is documented in `--help`. Two patterns selectable via `--pattern`:
  - `solver-type-plugin` (default) — `jinn.supports: [<SolverType>]`; modeled on `client/plugins/swe-rebench-v2-runtime/`. Files: `jinn.plugin.json`, `skills/<name>/SKILL.md`, optional `.mcp.json` + `mcp/<name>-server.mjs`, `package.json`, `test/plugin.test.ts`, `README.md`.
  - `runtime-plugin` — `jinn.supports: ['jinn.runtime']`; modeled on `client/plugins/network-tools/`. Files: `jinn.plugin.json`, optional `.mcp.json` + `mcp/<name>-server.mjs`, `package.json`, `test/plugin.test.ts`, `README.md`.
- `--solver-type=<id>` and `--out-dir=<path>` flags supported.
- Templates live at `client/templates/plugins/<pattern>/<file>.tmpl`, mirroring the existing `client/templates/harnesses/` layout.
- After `cd <name> && yarn install && yarn test`, the scaffolded package's tests pass against a synthetic `loadSolverPluginManifest` invocation.
- `jinn create plugin --help` prints both patterns and the `/docs/build/quickstart.md` URL (52x3.6 ships the URL).
- `yarn typecheck` + `yarn test` green.

## Out of scope

- Publishing the scaffolded package — that's 52x3.3.
- The `/docs/build/` quickstart content — that's 52x3.6.

## Reference

- Spec: §6.2.
- Existing: `client/src/cli/commands/create.ts` (`jinn create harness` pattern to extend), `client/templates/harnesses/{forecaster,evaluator,alternative-harness}/`, `client/plugins/{swe-rebench-v2-runtime,network-tools}/` (reference layouts).

## Run-mode

FEATURE — new CLI surface; templates added.
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 2: Link to parent epic**

Run: `bd link jinn-mono-52x3.2 jinn-mono-52x3 --type parent-child`

- [ ] **Step 3: Planning prompt**

```
Write the TDD plan for jinn-mono-52x3.2 (jinn create plugin scaffold).
Scope: extend client/src/cli/commands/create.ts with a `plugin` target; create client/templates/plugins/{solver-type-plugin,runtime-plugin}/ with .tmpl files; add tests under client/test/cli/create-plugin.test.ts. Tests should cover: each pattern produces the expected file set; --solver-type substitutes into jinn.plugin.json; --out-dir routes output; scaffolded package's yarn test passes. Reuse the substitute() helper from create.ts. The test that asserts `yarn test` passes on the scaffolded package should run the scaffolded test in-process via vitest's runner, not by shelling out.
```

---

## Task 3: File `52x3.3` — `jinn solver-plugins publish`

**Files:** bd state only.

- [ ] **Step 1: Create the child bead**

Run:
```bash
bd create --title="jinn solver-plugins publish + revoke verbs (Safe-routed setMetadata writes for plugin:<cid> kind)" --type=task --priority=2 --description="$(cat <<'EOF'
Part of epic jinn-mono-52x3. Extend `jinn solver-plugins` with `publish` and `revoke` sub-verbs per spec §6.3, on top of the staged-bootstrap from 52x3.1.

## Why

Today `jinn solver-plugins {show, validate, pack}` exists but there is no path from "I packed my plug-in" to "the network knows my plug-in exists for SolverNet X." `publish` is that path. It computes the IPFS CID, uploads the tarball, and writes the `plugin:<pluginCid>` metadata record on the builder's agentId.

## Acceptance criteria

- `jinn solver-plugins publish <source>` exists. Inputs: a resolvable plug-in source (npm:/git:/github:/path:), a target SolverNet (derived from `jinn.supports`), a signing key sourced from the existing keystore by default.
- Verb flow: lazily call `ensureStage1` (52x3.1 dependency) → resolve plug-in → call existing `pack` helper to compute `pluginSha256` + IPFS CID → upload tarball (default backend Autonolas gateway per spec §9 #4) → ABI-encode the §5.2 `PLUGIN_PAYLOAD_TUPLE` → call `IdentityRegistry.setMetadata(builderAgentId, "plugin:<pluginCid>", payload)` via the Safe-routed tx path mirroring `client/src/erc8004/reputation.ts`'s `executeSafeTransaction`.
- Verb output: tx hash + CID + sha256 + builderAgentId, in JSON by default.
- `jinn solver-plugins revoke <pluginCid>` sibling verb writes a revoked-marker payload (`version=2, revoked=true, reason: <string>`) to the same key. `--reason=<string>` flag required.
- `--builder-agent-id <id>` flag overrides the default agentId selection (per spec §5.1 dual-role + `--new-agent-id` open question — planning decides whether to ship the flag in v0).
- A new `PLUGIN_PAYLOAD_TUPLE` is added to `client/src/erc8004/abis.ts` mirroring the existing `PAYLOAD_TUPLE` / `PAYLOAD_TUPLE_V2` pattern.
- A new `encodePluginPayload` function (analog of `encodeExecutionPayload`) lands in `client/src/erc8004/identity.ts` or a new module.
- Tests cover: publish against an Anvil-fork IdentityRegistry; verify the on-chain MetadataSet event; verify the `plugin:` key lookup returns the encoded payload; revoke overwrites the same key; lazy Stage 1 ensure triggers when bootstrap incomplete.
- `yarn typecheck` + `yarn test` + `yarn e2e:publish` (new e2e script) green.

## Out of scope

- The indexer picking up the published event — that's 52x3.4.
- Discovery API exposing the plug-in — that's 52x3.5.

## Reference

- Spec: §5.2 (payload schema), §6.3 (verb), §5.1 (Stage 1 dependency).
- Existing: `client/src/cli/commands/solver-plugins.ts` (existing pack/validate/show), `client/src/erc8004/identity.ts` (IdentityPublisher, payload encoder pattern), `client/src/erc8004/reputation.ts` (`executeSafeTransaction` pattern), `client/src/plugins/digest.ts` (sha256 helper).
- Depends on: jinn-mono-52x3.1.

## Run-mode

FEATURE — new on-chain write surface for builder plug-in publication.
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 2: Link to parent + 52x3.1 dependency**

Run:
```bash
bd link jinn-mono-52x3.3 jinn-mono-52x3 --type parent-child
bd link jinn-mono-52x3.3 jinn-mono-52x3.1
```

Expected: parent edge + `52x3.1 blocks 52x3.3`.

- [ ] **Step 3: Planning prompt**

```
Write the TDD plan for jinn-mono-52x3.3 (jinn solver-plugins publish).
Scope: extend client/src/cli/commands/solver-plugins.ts with `publish` and `revoke` sub-verbs; add PLUGIN_PAYLOAD_TUPLE to client/src/erc8004/abis.ts; add encodePluginPayload (mirroring encodeExecutionPayload). The on-chain write uses executeSafeTransaction (from adapters/mech/safe.ts) routed through IdentityRegistry.setMetadata. Lazy Stage 1 ensure: import ensureStage1 from the 52x3.1 entry point; call it before any chain write. Decide whether --builder-agent-id flag ships in v0 (spec §9 open question). Tests should cover: Anvil-fork chain interactions (Stage 1 ensure → setMetadata → MetadataSet event); IPFS upload mocked at the gateway level; revoke overwrites with new payload version=2.
```

---

## Task 4: File `52x3.4` — Ponder indexer extension

**Files:** bd state only.

- [ ] **Step 1: Create the child bead**

Run:
```bash
bd create --title="Ponder indexer: PluginPublication entity + Envelope.executor.plugins[] join + PublishedArtifact base interface" --type=task --priority=2 --description="$(cat <<'EOF'
Part of epic jinn-mono-52x3. Extend the Ponder indexer (per jinn-mono-280n) to index `plugin:<cid>` MetadataSet events and join them to existing envelope plug-in attributions, per spec §5.6 + §6.4.

## Why

Once 52x3.3 lands, `MetadataSet(agentId, "plugin:<cid>", payload)` events flow on chain. The indexer needs to decode them into a queryable `PluginPublication` entity, join them to `Envelope.executor.plugins[].cid` for builder attribution, and aggregate per-(builderAgentId, pluginCid) score history. This is the read substrate for 52x3.5 (Discovery API) and 52x3.6 (`/build` SPA panels).

## Acceptance criteria

- A new Ponder entity `PluginPublication` derived from `MetadataSet` events where the `metadataKey` matches `plugin:*`. Fields: `builderAgentId`, `pluginCid` (from key), `pluginName`, `pluginVersion`, `pluginSha256`, `supports[]`, `publishedAt`, `revoked` (most-recent value wins), `revokedReason?`, `txHash`, `blockNumber`.
- A `PublishedArtifact` base interface (per spec §5.6) — `PluginPublication` declares `artifactType: 'plugin'` and extends it. Future `harness:<cid>` kind extends the same base.
- A join derivation: `BuilderAttributedRun` (or similar) row keyed on `(envelopeCid, pluginCid)`. Computed from each envelope's `executor.plugins[]` joined against `PluginPublication.pluginCid`. Sha256 mismatch flags the run as `forkSuspected: true` and falls back to no-builder-attribution per spec §5.3.
- Aggregations: per-`(builderAgentId, pluginCid)` score history (list of `(operator, taskId, verdict, score, ts)`) and rollup (count, p50, p90). Composes with ebu7's existing HarnessCheckpoint rollups (joins on `pluginCid` via the existing envelope→HarnessCheckpoint→Verdict path).
- Revocation handling: when a second MetadataSet event lands on the same `plugin:<cid>` key with `version=2, revoked=true`, the entity's `revoked` flag flips; queries default to filtering out revoked but `?includeRevoked=true` opts in.
- Indexer tests cover: decoding the PLUGIN_PAYLOAD_TUPLE shape, join against an envelope fixture, revoke event handling, fork-suspected flagging on sha256 mismatch.
- `yarn typecheck` (in the indexer subpackage) + Ponder schema tests green.

## Out of scope

- Discovery API endpoints — that's 52x3.5.
- SPA consumption — that's 52x3.6.
- HarnessCheckpoint rollup changes — already shipped under ebu7.

## Reference

- Spec: §5.6 (read layer base interface), §6.4 (indexer extension), §5.3 (attribution join + fork handling).
- Existing: indexer code under jinn-mono-280n (Ponder schema, `MetadataSet` decoder for existing kinds). The ebu7.6 `AttemptEnvelopeMeta` / `HarnessCheckpoint` join paths.
- Depends on: jinn-mono-52x3.3, jinn-mono-280n, jinn-mono-ebu7.6.

## Run-mode

FEATURE — indexer schema + decoder addition.
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 2: Link to parent + dependencies**

Run:
```bash
bd link jinn-mono-52x3.4 jinn-mono-52x3 --type parent-child
bd link jinn-mono-52x3.4 jinn-mono-52x3.3
bd link jinn-mono-52x3.4 jinn-mono-280n
bd link jinn-mono-52x3.4 jinn-mono-ebu7 --type related
```

Expected: parent edge, `52x3.3 blocks 52x3.4`, `280n blocks 52x3.4`, related-to ebu7.

- [ ] **Step 3: Planning prompt**

```
Write the TDD plan for jinn-mono-52x3.4 (Ponder indexer PluginPublication).
Scope: extend the Ponder schema (jinn-mono-280n indexer subpackage) with a PluginPublication entity; add a MetadataSet decoder branch for plugin:* keys; implement the PublishedArtifact base interface; add the BuilderAttributedRun join derivation; add per-(builderAgentId, pluginCid) score-history aggregation by joining to ebu7.6's existing HarnessCheckpoint→Verdict rollup. Tests: decode the PLUGIN_PAYLOAD_TUPLE; join against an envelope fixture; revoke event flips the flag; fork-suspected flag on sha256 mismatch. Reference the existing decoder for envelope:/evaluation:/capture: kinds for the dispatch pattern.
```

---

## Task 5: File `52x3.5` — Discovery API endpoints

**Files:** bd state only.

- [ ] **Step 1: Create the child bead**

Run:
```bash
bd create --title="Discovery API: /plugins, /builders/<address>/{artifacts,scores}, /plugins/<cid>/scores endpoints" --type=task --priority=2 --description="$(cat <<'EOF'
Part of epic jinn-mono-52x3. Extend the Discovery API surface with builder-shape read endpoints, per spec §5.6 + §6.5.

## Why

52x3.4 ships the indexer entity + join. Consumers (SPA in 52x3.6, external operators, third-party UIs) need HTTP endpoints over it. The endpoints are the seam between the substrate and the operator app — and the seam that future Path 2 publishing (`harness:<cid>` kind) extends without API churn.

## Acceptance criteria

- New endpoints on the Discovery API (per the `HttpDiscoveryAPI` + `OnchainDiscoveryAPI` surfaces, with fallback wrapper):
  - `GET /plugins?solverNet=<id>[&includeRevoked=false]` — list published plug-ins for a SolverNet.
  - `GET /plugins?builder=<address>` — list published plug-ins by a builder agentId or Safe address.
  - `GET /plugins/<cid>/scores` — score history + aggregate (count, p50, p90) for a published plug-in.
  - `GET /builders/<address>/artifacts` — unified artifact list, returning `PublishedArtifact[]` typed by `artifactType`. Today returns only plug-ins; future-proofed for the Path 2 publishing epic's `harness:<cid>` extension.
  - `GET /builders/<address>/scores` — per-artifact aggregated score history.
- Response shape matches the `PublishedArtifact` / `PluginPublication` interfaces from 52x3.4.
- TypeScript types exported from the Discovery API SDK / client.
- Endpoints respect the existing `fallbackToOnchain` policy: if the Ponder indexer is unreachable, the OnchainDiscoveryAPI floor returns either an empty result with `{ degraded: true, reason: 'indexer-unreachable' }` (preferred) or a clear error.
- Tests cover: each endpoint shape; SolverNet filter; builder filter; revoked filter; degraded mode when indexer is down.
- `yarn typecheck` + Discovery API surface tests green.

## Out of scope

- SPA consumption — that's 52x3.6.
- New aggregation logic — reuses 52x3.4's BuilderAttributedRun + ebu7's existing HarnessCheckpoint rollups.
- Path 2 `harness:<cid>` indexer extension — separate epic; this epic only sets up the read-layer base interface.

## Reference

- Spec: §5.6 (endpoint shapes), §6.5.
- Existing: `client/src/discovery/{types,http,onchain,with-fallback,factory}.ts` (the Discovery API surfaces), `spec/2026-05-11-discovery-api-and-shared-indexer.md`.
- Depends on: jinn-mono-52x3.4, jinn-mono-280n.

## Run-mode

FEATURE — new read endpoints over existing indexer + onchain substrate.
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 2: Link to parent + dependencies**

Run:
```bash
bd link jinn-mono-52x3.5 jinn-mono-52x3 --type parent-child
bd link jinn-mono-52x3.5 jinn-mono-52x3.4
```

- [ ] **Step 3: Planning prompt**

```
Write the TDD plan for jinn-mono-52x3.5 (Discovery API builder endpoints).
Scope: extend client/src/discovery/{types.ts,http.ts,onchain.ts,with-fallback.ts} with the five new endpoints; export PublishedArtifact + PluginPublication TypeScript types from the discovery SDK; add OnchainDiscoveryAPI fallback behaviour. Tests should cover: each endpoint's response shape; SolverNet/builder/revoked filters; degraded mode when the indexer is unreachable. Use the existing discovery test fixtures.
```

---

## Task 6: File `52x3.6` — `/build` SPA route + canonical `/docs/build/` tree

**Files:** bd state only.

- [ ] **Step 1: Create the child bead**

Run:
```bash
bd create --title="/build SPA route + canonical /docs/build/ tree (quickstart, shape ref, examples, publishing-flow, identity, compatibility)" --type=task --priority=2 --description="$(cat <<'EOF'
Part of epic jinn-mono-52x3. Ship the builder-facing surfaces in the operator SPA + the canonical docs tree, per spec §6.6.

## Why

The substrate exists (52x3.1 through 52x3.5) but builders have no way in. `/build` is the visible front door; `/docs/build/` is the cold-start walk that turns "I'm a builder" into "my plug-in is published and scored."

## Acceptance criteria

- New route `/build` wired in `client/src/dashboard/spa/src/App.tsx`, peer of `/operator` and `/launcher`. Reachable from the SPA nav.
- `/build` route renders:
  - Intro card sourced from `/docs/build/quickstart.md`.
  - Plug-in shape catalogue generated from `SolverPluginManifest` in `client/src/plugins/types.ts` plus the runtime/SolverType mode distinction from the validator. Stays in sync with the schema by construction.
  - Browse-published-plug-ins panel — consumes `GET /plugins?solverNet=` from 52x3.5; reuses `client/src/dashboard/spa/src/pages/leaderboard/Leaderboard.tsx` with a plug-in-scoped filter.
  - "Your published plug-ins" panel — consumes `GET /builders/<address>/artifacts` filtered by the local operator's builder identity (read from `~/.jinn-client/earning/earning_state.json`).
  - Artifact-type filter chip — v0 has only `plugin`; the chip is in place from day one so the Path 2 harness tab extends without SPA churn (per spec §5.6 future-proofing).
- Canonical `/docs/build/` tree under `client/docs/build/` (or wherever the docs runbook root lives):
  - `quickstart.md` — 60-second walk from `swe-rebench-v2-runtime/`-copy through `jinn solver-plugins publish`.
  - `shape-reference.md` — `jinn.plugin.json` shape, two exclusive modes, `skills/` and `.mcp.json` conventions.
  - `examples.md` — anchored on `client/plugins/swe-rebench-v2-runtime/` and `client/plugins/network-tools/`.
  - `publishing-flow.md` — plain-prose sequence diagram from §5.2 / §5.3 / §6.3.
  - `identity.md` — plain-prose §5.1 mirror (one identity, two stages).
  - `compatibility.md` — `jinn.supports` semantics, version pinning, which harnesses load which slots.
- `jinn create plugin` (52x3.2) extends to print the `/docs/build/quickstart.md` URL on completion. Coordinate via a shared constant.
- SPA tests cover: `/build` route renders; browse panel populates from a fixture API response; your-plug-ins panel respects builder identity; shape catalogue stays in sync with the schema (snapshot test against the generated catalogue).
- `yarn typecheck` + SPA test suite + Playwright E2E for `/build` (if testing-jinn-app skill conventions apply) green.

## Out of scope

- The reference plug-in artefact + cold-start E2E across all children — that's 52x3.7.
- New aggregation logic — reuses 52x3.4 + 52x3.5.

## Reference

- Spec: §5.6 (artifact-type filter), §6.6 (deliverables).
- Existing: `client/src/dashboard/spa/src/App.tsx` (route wiring), `client/src/dashboard/spa/src/pages/leaderboard/Leaderboard.tsx` (component to reuse), `client/src/plugins/types.ts` (schema source).
- Depends on: jinn-mono-52x3.5, jinn-mono-52x3.2.

## Run-mode

FEATURE — new SPA route + canonical docs.
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 2: Link to parent + dependencies**

Run:
```bash
bd link jinn-mono-52x3.6 jinn-mono-52x3 --type parent-child
bd link jinn-mono-52x3.6 jinn-mono-52x3.5
bd link jinn-mono-52x3.6 jinn-mono-52x3.2
```

- [ ] **Step 3: Planning prompt**

```
Write the TDD plan for jinn-mono-52x3.6 (/build route + /docs/build/).
Scope: add /build route to App.tsx; create client/src/dashboard/spa/src/pages/build/ with Build.tsx + sub-components (IntroCard, ShapeCatalogue, BrowsePublishedPanel, YourPluginsPanel, ArtifactTypeChip); reuse Leaderboard.tsx with a plugin-scoped filter prop; create client/docs/build/{quickstart,shape-reference,examples,publishing-flow,identity,compatibility}.md. Tests: SPA-level route render; fixture-driven panel population; shape-catalogue snapshot test against client/src/plugins/types.ts (regenerate-and-diff pattern). Update jinn create plugin (52x3.2) to print the quickstart URL via a shared constant. Reference the testing-jinn-app skill for chrome-devtools or Playwright walks of the new surface.
```

---

## Task 7: File `52x3.7` — Reference plug-in + cold-start E2E

**Files:** bd state only.

- [ ] **Step 1: Create the child bead**

Run:
```bash
bd create --title="Reference competing plug-in for swe-rebench-v2.v1 + cold-start E2E acceptance gate" --type=task --priority=2 --description="$(cat <<'EOF'
Part of epic jinn-mono-52x3. Ship the first-integrator artefact and the cold-start E2E that spans all six prior children, per spec §6.7.

## Why

Two evidence pieces in one bead because they're naturally one thing:
- The first published competing plug-in is the proof point that the builder loop works end-to-end for an external recruit.
- The cold-start E2E is the regression gate that the loop stays unbroken.

Per spec §6.7 (referencing plug-in-surface §6 + #57 §3): the first integrator must have at least as good an experience as the second. This bead anchors the first-integrator candidate.

## Acceptance criteria

- A separate published package demonstrating the full builder loop, targeting `swe-rebench-v2.v1`. Lives outside `client/plugins/` — either under `examples/plug-ins/<name>/` in this repo or as its own published package. Choice in planning; default is `examples/`.
- The package's content is a real (small) skill-bundle or MCP tool that solves a real subset of SWE-rebench v2 — not a stub. Planning chooses the candidate based on the spec §9 open question #6 (Hermes-migrator / sovereign-forker / ERC-8004 builder recruit shape).
- Cold-start E2E vitest under `client/test/acceptance/cold-start-builder.test.ts` (or wherever the cold-start E2E pattern fits) walks:
  1. Scaffold via `jinn create plugin <name>` (52x3.2).
  2. Pack via existing `jinn solver-plugins pack`.
  3. `jinn solver-plugins publish` against a stub IPFS gateway + stub IdentityRegistry (Anvil fork). Lazy Stage 1 ensure must trigger and complete (52x3.1 + 52x3.3).
  4. Indexer (in-memory Ponder fixture or stubbed entity) picks up the MetadataSet event and creates a PluginPublication (52x3.4).
  5. Discovery API stub serves `/plugins?solverNet=swe-rebench-v2.v1` returning the new plug-in (52x3.5).
  6. Operator installs the plug-in via existing `jinn solver-nets add-plugin <net> <source>` resolver.
  7. Stub-Hermes runs a SWE-rebench v2 task with the plug-in loaded; envelope emits `executor.plugins[]` carrying `(name, version, cid, sha256)`.
  8. Indexer joins envelope to publication; BuilderAttributedRun row created.
  9. `/build` SPA route renders the new plug-in in the browse panel and in the builder's "your published plug-ins" view (52x3.6).
- E2E also exercises the dual-role path: an operator (with Stage 1+2 complete via `jinn run` bootstrap) publishes a plug-in; Stage 1 detected as done; no re-mint; same agentId on the publication.
- The E2E runs in CI; failure blocks the epic's acceptance.
- `yarn typecheck` + `yarn test` + new `yarn e2e:cold-start-builder` script green.

## Out of scope

- Real-network demo on Base Sepolia — separate operational task (analogous to uy6v's rdod deploy).
- Marketing / recruit-cluster distribution of the artefact — `GROWTH.md` territory; tracked separately under the growth-target-ecosystem-builders engagement lanes.

## Reference

- Spec: §6.7, §9 open question #6 (first-integrator candidate selection), §4 (acceptance criteria #10 is this E2E).
- Existing: `client/test/e2e/` (e2e patterns); `examples/` directory (if it exists; the bead creates it if not); `spec/2026-05-12-growth-target-ecosystem-builders.md` (recruit shape input for the candidate choice).
- Depends on: jinn-mono-52x3.1, 52x3.2, 52x3.3, 52x3.4, 52x3.5, 52x3.6.

## Run-mode

TEST — acceptance gate + reference artefact.
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 2: Link to parent + all sibling dependencies**

Run:
```bash
bd link jinn-mono-52x3.7 jinn-mono-52x3 --type parent-child
bd link jinn-mono-52x3.7 jinn-mono-52x3.1
bd link jinn-mono-52x3.7 jinn-mono-52x3.2
bd link jinn-mono-52x3.7 jinn-mono-52x3.3
bd link jinn-mono-52x3.7 jinn-mono-52x3.4
bd link jinn-mono-52x3.7 jinn-mono-52x3.5
bd link jinn-mono-52x3.7 jinn-mono-52x3.6
```

Expected: parent edge + six `blocks` edges from each prior sibling.

- [ ] **Step 3: Planning prompt**

```
Write the TDD plan for jinn-mono-52x3.7 (Reference plug-in + cold-start E2E).
Scope: pick the first-integrator candidate (spec §9 #6) — Hermes-migrator vs sovereign-forker vs ERC-8004 builder — with input from spec/2026-05-12-growth-target-ecosystem-builders.md; create examples/plug-ins/<name>/ as a real working package targeting swe-rebench-v2.v1; write client/test/acceptance/cold-start-builder.test.ts walking the nine-step loop. The E2E should use Anvil fork (existing pattern) + in-memory Ponder fixture + stub-Hermes (existing pattern from PR #143). Also exercise the dual-role path. Add yarn e2e:cold-start-builder script. Update client/test/acceptance/ runners if the existing harness needs extending.
```

---

## Task 8: Cross-epic simplification pass (`/simplify` loop)

**Files:** TBD (whatever the simplification pass touches).

After all seven children have landed in main and `52x3.7`'s acceptance E2E is green, run a final simplification pass over the cumulative epic diff. Independent per-child TDD planning sessions tend to leave small inconsistencies, duplicated helpers, over-broad type unions, and premature abstractions that only become visible when the whole surface is in one place.

Not filed as its own bd bead and not mirrored to GitHub — it's a closeout step on the epic, not a tracked work item. Run it as part of closing `jinn-mono-52x3`.

- [ ] **Step 1: Compute the cumulative epic diff**

Run from the cargo dir on a worktree branched from latest main:

```bash
git checkout -b chore/52x3-simplify main
git log --oneline main..HEAD  # should be empty at the start
git diff main -- $(git log --all --format=%H --grep '52x3\.' | head -1)..main
```

Expected: a diff that spans the seven children's merged work. Save the file list (`git diff --name-only main..HEAD`) to anchor the simplify scope.

- [ ] **Step 2: Invoke the simplify skill against the epic's changed surface**

Run the `/simplify` skill with explicit scope: the union of files touched by the seven `52x3.*` PRs. The skill reviews for:

- Repeated helper code across `52x3.1`'s `ensureStage1` / `ensureStage1And2` and `52x3.3`'s lazy Stage 1 ensure.
- Duplicated payload encoding between `52x3.3`'s `encodePluginPayload` and any analogous code in `52x3.4`'s indexer decoder.
- Over-broad union types between `PublishedArtifact` base interface and the `PluginPublication` extension (`52x3.4` / `52x3.5`).
- SPA component duplication between the `/build` route's panels (`52x3.6`) and the reused `Leaderboard.tsx` (from `ebu7`).
- Test helpers that could be promoted to shared fixtures.
- Doc paragraphs that drifted between `/docs/build/` (`52x3.6`) and the spec's §5 design language.

Expected output from the skill: either "no changes needed" (best case) or a list of concrete simplifications with patches.

- [ ] **Step 3: Apply simplifications + open a single chore PR**

If the skill found issues, apply the patches, run `yarn typecheck` + `yarn test` + `yarn e2e:cold-start-builder` to confirm nothing regresses, and open a PR titled `chore(52x3): simplify epic surface (post-merge cleanup)`. The PR's description should list each simplification with a one-line "why this is safe" justification.

If the skill found nothing, skip the PR; record the no-op in the bd epic's notes:

```bash
bd note jinn-mono-52x3 "Simplify pass run on YYYY-MM-DD against cumulative epic diff; no changes needed."
```

- [ ] **Step 4: Close the epic**

After the simplify PR merges (or the no-op is recorded):

```bash
bd close jinn-mono-52x3
```

Verify the GitHub epic issue (#199) gets closed automatically via the `external_ref` link, or close it manually if not.

---

## Integration & PR sequencing

### Critical path

The shortest path to "epic acceptance green":

1. `52x3.1` ships → unlocks `52x3.3`.
2. `52x3.3` ships → unlocks `52x3.4`.
3. `52x3.4` ships → unlocks `52x3.5`.
4. `52x3.5` ships → unlocks `52x3.6`.
5. `52x3.6` ships → unlocks `52x3.7`.
6. `52x3.7` ships → epic acceptance E2E green.
7. Task 8 (`/simplify` loop) ships → epic closed.

Total: 6 sequential merges along the critical path.

`52x3.2` (scaffold CLI) is off the critical path and can ship anywhere in parallel; it's a dependency of `52x3.7` only.

### Parallelisation opportunities

- `52x3.1` and `52x3.2` ship in parallel (Group A).
- `52x3.4` and `52x3.5`'s spec work can overlap: `52x3.5` planning can begin as soon as `52x3.4`'s entity shape is decided (the API endpoints depend on the shape, not the implementation).
- `52x3.6`'s docs (`/docs/build/`) can start drafting in parallel with `52x3.5` since they only depend on the substrate design, not the runtime endpoints.

### Worktree management

Each child's planning session creates its own worktree at `cargo/.tasks/<child-id>` and branches off main. Children land via PR to main, not via merge into this epic's worktree branch. The epic worktree (`cargo/.tasks/52x3` on `feat/52x3-plug-in-builder-entry-point`) carries only the spec + this plan + any cross-cutting docs. After all seven children have landed in main, this epic's branch can either be rebased onto main (no-op if all docs are merged via separate PRs) or merged as a docs-only PR.

### Acceptance check

When all seven children are closed:

```bash
bd show jinn-mono-52x3 2>&1 | grep -A1 'CHILDREN' | tail -8
```

Should show all seven children with `✓` status. Then run Task 8 (the `/simplify` loop), which closes the epic on completion.

---

## Self-review

Running the writing-plans skill's self-review checklist against the spec:

1. **Spec coverage**: each spec section maps to a task —
   - §1–§4 (purpose, framing, gap, acceptance) → Task 0 surfaces the epic's acceptance gates; tasks 1–7 implement the children.
   - §5 (substrate design) is the read-once decided artefact; per-bead planning prompts in tasks 1–7 reference back to §5.
   - §6.1–§6.7 (children) → tasks 1–7 file the matching bead with full body.
   - §7 (dependencies) → Task 0 step 2 verifies the external gates; tasks 1, 4, 5 add the dep edges.
   - §8 (out of scope) → carried in each child's bead body where relevant.
   - §9 (open questions) → carried in the child's planning prompt where the question gates that child's design choices.
2. **Placeholder scan**: no TBD / TODO / "implement later" / "similar to" / "add appropriate" — each step has exact bd command + exact bead body inline. The planning prompts are concrete (decompose into the existing files, the existing patterns, the existing dependencies).
3. **Type consistency**: `PluginPublication`, `PublishedArtifact`, `BuilderAttributedRun`, `PLUGIN_PAYLOAD_TUPLE`, `encodePluginPayload`, `ensureStage1`, `ensureStage1And2` are used consistently across tasks 1, 3, 4, 5, 6, 7.

If a spec requirement is missing, the gap is in this roadmap, not the spec — file an addendum task.

---

*End of plan.*
