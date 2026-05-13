# Plug-in builder entry point — design

- **Date:** 2026-05-13
- **Author:** opus (drafted with Captain `oak`)
- **Status:** Proposal
- **Version:** 0.5
- **Bead:** `jinn-mono-52x3` (epic)
- **Tracks:** Phase A.2 builder-surface layer; sequenced after `jinn-mono-uy6v` (first public release) and `jinn-mono-8psp` (Hermes harness integration).

## 1. Purpose and framing

This spec scopes a single epic — **the builder entry point for plug-ins on the SWE-rebench v2 SolverNet running against the Hermes harness** — and identifies the minimum loop closure required so that the first external builder can publish a plug-in, have it discoverable to operators, and have its score visible on the network explorer with the builder attributed.

The epic is the builder-facing complement to `uy6v` (operator install path) and `8psp` (Hermes harness integration). **The substrate is largely built.** Plug-in attribution is already in the signed execution envelope (`executor.plugins[]` in `jinn.execution.v1`). Cross-operator score aggregation already ships under `jinn-mono-ebu7` (network explorer). Identity + reputation primitives already ship via ERC-8004 (`client/src/erc8004/{identity,reputation}.ts`). Stake-backed reputation slashing is already scoped under `jinn-mono-0www` (Phase B.2).

The remaining gap is **discovery + builder identity + builder-shape view**: builders publish plug-ins to npm but operators can't find them; the existing ERC-8004 identity primitive is operator-only by convention even though the contract layer is role-agnostic; the existing leaderboard aggregates by operator-running-the-plug-in, not by builder-shipping-the-plug-in.

This spec **explicitly reframes** the Skill Oracle v0 framing in [discussion #129](https://github.com/Jinn-Network/mono/discussions/129) from skill-as-unit to plug-in-as-unit, consistent with Ritsu's final comment in that thread ("SolverNet = tasks; Harness family = execution surface; Artifact = the concrete manifest being scored — skill, plug-in, harness config"). The `jinn.plugin.json` schema already in the repo is that "concrete manifest being scored". This epic operationalises the builder side of it for SolverNet 1 without redesigning the manifest, the envelope, or the aggregation.

### Composes with

- **`client/src/types/envelope.ts`** — the `jinn.execution.v1` envelope already carries `executor.plugins[]` (name, version, cid, sha256) per attempt. The epic consumes this; it does not extend it.
- **`client/src/erc8004/{identity,reputation,addresses,abis}.ts`** — the wired ERC-8004 IdentityRegistry + ReputationRegistry surfaces. The epic adds a new metadata kind (`plugin`) and reuses identity + reputation primitives unchanged.
- **`docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md`** — the entity model that decides "one agent NFT per Safe, per-execution commitments via `setMetadata`." This epic extends the enumerated kind set with `plugin` (and `revocation`), staying within "one agent NFT per Safe" — there is no parallel builder-agent primitive (see §5.1).
- **`docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md`** — the payload-schema design for `setMetadata` kinds. The epic adds a payload variant for `plugin:<cid>`.
- **`jinn-mono-ebu7`** (network explorer) — already ships per-operator + per-SolverNet leaderboards keyed on HarnessCheckpoint (which carries the plug-in set). Builder-side views fold into this; no new aggregation is built.
- **`jinn-mono-0www`** (Phase B.2 evaluator economics + reputation slashing) — owns stake-backed reputation and challenge mechanism. This epic ships record-only attribution and explicitly defers slashing.
- **`spec/2026-04-30-plug-in-surface.md`** — Path 1 plug-in surface (the design-level commitments). The phase-agent-override and topic-explorer slots are Claude-Code-shaped and out of scope here because Hermes drives its own kanban and learning loop.
- **`spec/2026-05-01-harness-pack-architecture.md`** — establishes the runtime/SolverType plug-in distinction enforced by `client/src/plugins/validator.ts`.
- GitHub Discussion [#129](https://github.com/Jinn-Network/mono/discussions/129) — Sharpening SolverNet 1.

## 2. What already exists

Before describing the gap, the existing substrate is enumerated so the epic's children remain net-additions rather than rewrites.

### 2.1 Plug-in manifest, validation, resolution

- `jinn.plugin.json` is the canonical plug-in manifest. `client/src/plugins/manifest.ts` declares the lookup order `['jinn.plugin.json', '.claude-plugin/plugin.json', 'gemini-extension.json']` — `jinn.plugin.json` wins when present.
- `client/src/plugins/validator.ts` enforces the two exclusive modes from `spec/2026-05-01-harness-pack-architecture.md` §5.1:
  - **Runtime plug-in** — `jinn.supports: ['jinn.runtime']` (singleton). Reference: `client/plugins/network-tools/`.
  - **SolverType plug-in** — every entry is a SolverType identifier. Reference: `client/plugins/swe-rebench-v2-runtime/` (`jinn.supports: ['swe-rebench-v2.v1']`).
- `client/src/plugins/resolvers.ts` resolves six source kinds — `bundled`, `local`, `npm`, `git`, `github`, `claude` — into a vendored package under `~/.jinn-client/solver-plugins/` with a materialisation lock and sha256 digest.
- `client/src/plugins/registry.ts` exposes `register`, `get`, `forSolverType`, `list`. `loadSolverPlugins()` is the daemon entry point.

### 2.2 Execution envelope already attributes plug-ins

`client/src/types/envelope.ts:62-67` — every signed `jinn.execution.v1` envelope's `executor` field carries:

```ts
plugins: z.array(z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  cid: z.string().min(1).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})),
```

Per-attempt plug-in attribution is **already published**. The epic does not extend this field; it consumes it.

### 2.3 ERC-8004 identity + reputation are wired

`client/src/erc8004/identity.ts` and `client/src/erc8004/reputation.ts` ship the IdentityRegistry + ReputationRegistry surfaces.

- **IdentityRegistry**: one ERC-721 agentId per operator Safe (per `2026-04-27-erc-8004-entity-model-design.md` §4.1). Per-execution commitments via `setMetadata(agentId, "<kind>:<cid>", payload)`. Existing kinds: `envelope`, `evaluation`, `capture`, `intent`. Payload format defined in `2026-04-27-erc-8004-payload-schema.md`.
- **ReputationRegistry**: evaluator-side `giveFeedback(harnessAgentId, score, scoreDecimals, tag1, tag2, endpoint, manifestRef="manifest:<cid>", manifestHash=evidenceHash)`. PASS=100/2-decimals, FAIL=0/2-decimals, REJECTED/INDETERMINATE skip. Self-feedback guard, agent-not-found guard.
- **Resolution**: `resolveAgentIdForManifest({manifestHash, discoveryApi})` looks up the harness agentId from a manifest hash via the Ponder indexer (O(1)).
- **Addresses**: Base mainnet `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, Base Sepolia `0x8004B663056A597Dffe9eCcC1965A193B7388713`, plus Ethereum + Sepolia equivalents.

These primitives apply to builder Safes by symmetry — see §5.

### 2.4 CLI surface

- `jinn create harness <pkg>` (`client/src/cli/commands/create.ts`) — Path 2 scaffold; three patterns `forecaster | evaluator | alternative-harness`; templates under `client/templates/harnesses/`. The pattern for the new plug-in scaffold to follow.
- `jinn solver-plugins {show, validate, pack}` (`client/src/cli/commands/solver-plugins.ts`) — author/curator tooling. Extended in this epic with a `publish` sub-verb.
- `jinn solver-nets {list, show, enable, disable, set-harness, add-plugin, remove-plugin, doctor, sample, validate-pool}` (`client/src/cli/commands/solver-nets.ts`) — operator-side, unchanged.

### 2.5 Network explorer already aggregates per-plug-in

`jinn-mono-ebu7` (76% complete at time of writing) has shipped:

- **ebu7.4** — Network + Per-SolverNet views, Learning panel, **faceted leaderboard**.
- **ebu7.6** — IPFS envelope-enrichment: **AttemptEnvelopeMeta**, **HarnessRollup**, FreezeViolation, LanguageRollup, **HarnessCheckpoint**.
- **ebu7.7** — Multi-net generalization: SolverNets index, **per-operator view**, cross-net leaderboard, summed network rollups.
- **rdod** — Public aggregate dashboard for SWE-rebench v2 (code complete, awaiting public deploy as a uy6v release gate).

HarnessCheckpoint is the unit the leaderboard ranks by; its enrichment already includes the plug-in set from the envelope's `executor.plugins[]`. **A builder's plug-in CID can already appear on the leaderboard via any operator who runs it.** What's missing is the **builder-side filter** (browse published plug-ins for a SolverNet, view scores keyed by a builder agentId) — a read-shape over the existing aggregation, not new aggregation.

### 2.6 Operator SPA

- Routes wired in `client/src/dashboard/spa/src/App.tsx`: `/overview`, `/overview/activity`, `/operator`, `/operator/join/:cid`, `/operator/execution-data`, `/configuration`, `/launcher`, `/launcher/create`, `/launcher/launched/:solverNetId`.
- `client/src/dashboard/spa/src/pages/leaderboard/` contains `Leaderboard.tsx`, `FrozenLeaderboardTable.tsx`, `TrainLeaderboardTable.tsx`, `VerifiedBadge.tsx`. Components are embedded in other surfaces; **no `/leaderboard` route is wired**. The `/build` route this epic introduces sits alongside.

### 2.7 Hermes harness (the 8psp PR stack #140–#145)

Per `feat(hermes): hermes-agent harness package (2/4)` (PR #141):

- `config-builder.ts: hermesConfigFromSolverPlugins()` translates each `SolverPlugin`'s standard `.mcp.json` (resolving `${CLAUDE_PLUGIN_ROOT}` templates) and `skills/` directory directly into Hermes's `mcp_servers:` and `skills.external_dirs:` config. **It does not consult `jinn.plugin.json`** — that file is daemon-side metadata, orthogonal to the harness↔MCP path.
- `HermesHarness.supports()` is scoped to `swe-rebench-v2.v1` solver role only for v1.
- The Jinn-side `learner` plug-in is **not loaded** under Hermes; Hermes drives its own learning loop.

The key implication: **the SolverPlugin shape is harness-agnostic**. A plug-in's `.mcp.json` and `skills/` directory work across `learner` (claude-code), `learner` (codex-code), and `hermes-agent` automatically. Harness-specific concerns (Hermes `platform_toolsets` allowlist, Claude hooks) live in the harness package, not the plug-in.

### 2.8 Reference plug-ins (the de facto worked examples)

- `client/plugins/swe-rebench-v2-runtime/` — Solver-side orient + plan skills for `swe-rebench-v2.v1`. The canonical example for a SolverType plug-in targeting this epic's SolverNet.
- `client/plugins/network-tools/` — `jinn.runtime` plug-in exposing `search_records`, `inspect_record`, `acquire_artifact`, `get_task` MCP tools.
- `client/plugins/jinn-prediction-plugin/` — combined MCP server (`polymarket`) + skills bundle for `prediction.v1`.
- `client/plugins/learner/` — the bundled harness's own plug-in (Claude/Codex-shaped; not loaded by Hermes).

### 2.9 Reputation slashing is already a Phase B bead

`jinn-mono-0www` — "Phase B: evaluator economics + reputation slashing for harness checkpoints" — owns: evaluator economics design, reputation registry surface for harness operators (slashing on detected freeze-mode violations, untruthful checkpoint publication), challenge mechanism re-homed from the original Phase 1b roadmap. **This epic does not encode stake-backed reputation or slashing**; the read-shape attribution it adds is record-only and feeds 0www when that lands.

## 3. The gap — discovery + builder identity + builder-shape filter

The substrate ships plug-ins, attributes them per attempt, and aggregates them per operator/SolverNet/HarnessCheckpoint. The remaining gap is **the builder side has never been formalised**:

1. **Discovery.** An operator running `jinn solver-nets add-plugin swe-rebench-v2 npm:@builder/<pkg>` works today — but only if they already know the package name. There is no network-level index of "plug-ins published for SolverNet X" that an operator can browse. Builders publishing to npm don't surface inside the operator app.
2. **Builder identity.** Envelopes attribute plug-ins by `{name, version, cid, sha256}`. Nothing on-chain or in the indexer binds those identifiers to a **builder identity** — the person who shipped the plug-in. The ERC-8004 IdentityRegistry primitive supports it; the wiring doesn't exist yet.
3. **Builder-shape view in the explorer.** ebu7 has per-operator and per-SolverNet views (`ebu7.7`). There is no per-builder filter or "browse published plug-ins" landing.
4. **Cold-start path.** No canonical `/docs/build/` tree; no `jinn create plugin` scaffold (only `jinn create harness` for Path 2 exists). A builder starting cold has no documented walk from "I want to ship a plug-in for SWE-rebench v2" to "my plug-in is running on operator fleets and visible to the network."

The epic ships the smallest closure of these four.

## 4. End-state acceptance

The epic is shipped when, on testnet, all of the following hold:

1. **First external builder publishes a plug-in.** Scaffolds via `jinn create plugin <name>`, edits skills + MCP tools, publishes to npm, runs `jinn solver-plugins publish <pkg>` — which lazily ensures bootstrap Stage 1 (identity) if not already complete (prompts for ETH funding, deploys Safe, registers agentId via `IdentityRegistry`) before writing the `plugin:<cid>` record on chain. **No separate `jinn builder init` step required.** Zero CLI workarounds.
2. **Published plug-in is discoverable in the operator app.** Operator opens the `/build` route (or equivalent surface), browses published plug-ins for `swe-rebench-v2.v1`, sees the new plug-in with builder attribution, and installs it via the existing `jinn solver-nets add-plugin` resolver path.
3. **Plug-in runs and scores via the existing pipeline.** Hermes's `hermesConfigFromSolverPlugins()` consumes the plug-in's `.mcp.json` and `skills/`. The attempt completes; the signed envelope's `executor.plugins[]` field carries the plug-in attribution (already in `jinn.execution.v1`); ebu7's HarnessCheckpoint enrichment picks it up.
4. **Score is visible in the builder-shape view.** The `/build` surface filters the existing ebu7 leaderboard by published-plug-in and by builder identity; the new plug-in's first verified score is visible alongside other published plug-ins for the same SolverNet.
5. **Builder reputation accrues (record-only).** Builder agentId ↔ published plug-in CIDs ↔ aggregated scores is queryable via the Discovery API extension this epic adds. Stake-backed slashing is **explicitly deferred** to `jinn-mono-0www` (Phase B.2).
6. **`/build` SPA route ships** the cold-start walk: intro, plug-in shape catalogue (drawn live from the schema in `client/src/plugins/types.ts`), scaffold instructions, browse-published-plug-ins panel (reuses `Leaderboard.tsx`), "your published plug-ins" panel for the local operator's builder identity. Reachable from the SPA nav.
7. **Canonical `/docs/build/` tree exists**: quickstart (60-second walk anchored on copying `swe-rebench-v2-runtime/`), shape reference, examples, publishing-flow doc, compatibility doc. `jinn create plugin` prints the quickstart URL on completion.
8. **`jinn create plugin <name>` scaffold ships**, producing a package whose `yarn test` passes on first run. Templates under `client/templates/plugins/`. Two patterns: `solver-type-plugin` (modeled on `swe-rebench-v2-runtime`) and `runtime-plugin` (modeled on `network-tools`).
9. **Bootstrap state machine is staged.** `client/src/earning/bootstrap.ts` is refactored into Stage 1 (identity: `wallet` → `safe_predicted` → `awaiting_funding` → `safe_deployed` → `identity_registered`) and Stage 2 (operator: `service_created` → `service_activated` → `agents_registered` → `service_deployed` → `service_staked` → `mech_deployed`). Each stage is independently re-entrant and idempotent. `jinn solver-plugins publish` lazily ensures Stage 1; `jinn run` lazily ensures Stage 1+2. A builder who later wants to operate continues from `service_created` — no re-mint, no second Safe, no second agentId.
10. **Cold-start E2E acceptance gate green** — a vitest that walks scaffold → publish to local npm registry → `jinn solver-plugins publish` (lazily completes Stage 1 against a stub IdentityRegistry) → operator discovers via the Discovery API → operator installs → run task → envelope publishes plug-in attribution → ebu7 reflects it → builder filter on `/build` shows the score. Plus `yarn typecheck` and `yarn build`.

## 5. Substrate design

Identity, attribution, reputation, and the on-chain registry are designed on the existing ERC-8004 substrate. **No new contracts.** Builder identity is the same primitive as operator identity, distinguished only by which metadata kinds the agentId publishes. The plug-in registry is a new metadata kind on the existing `IdentityRegistry.setMetadata` surface.

### 5.1 Identity is staged, not separate-per-role

There is **one stateful identity** per user — one EOA, one agentId, one keystore, one state file. There are **two completion levels** on that identity, each independently re-entrant.

> **Implementation reality check** (spike findings at `docs/superpowers/specs/2026-05-14-nghf-staged-bootstrap-fit-findings.md`): the existing bootstrap is a fleet-of-services state machine with per-service Safes. The standard (stOLAS) staking mode — the v1 testnet default — has no separate Safe-predict/deploy; the Safe is born atomically from `distributor.stake()` and requires OLAS. So the Stage 1 design described below adopts the **self-bond Safe topology** (deterministic Safe prediction from the agent EOA) unconditionally, regardless of the operator's eventual staking mode. Dual-role operators in standard mode therefore end up with **two Safes** — a Stage 1 identity Safe (where `setMetadata` and reputation accrue), and a Stage 2 staking Safe (where OLAS activity runs). The two Safes share an agent EOA. Mechanically clean; users see one agentId.

- **Stage 1 — Identity (universal).** Required for any participation, builder or operator. Steps: `wallet` → `safe_predicted` → `awaiting_funding` (ETH only — no OLAS required) → `safe_deployed` → `identity_registered`. The Safe is predicted deterministically from the agent EOA via the existing `initPredictedSafe` helper (`client/src/earning/safe-adapter.ts`); funding is ETH-only since standard-mode OLAS only matters in Stage 2. The `identity_registered` step calls `IdentityRegistry.register()` then `setAgentWallet(agentId, safeAddress)` (the existing flow from `jinn-mono-j07` / `jinn-mono-aev`, reordered to fire here). After Stage 1, the user has a full ERC-8004 identity and can sign `setMetadata` for any kind (envelope, evaluation, capture, intent, plugin, revocation).
- **Stage 2 — Operator (opt-in, daemon-driven).** Required only for users who want to run a daemon and claim/deliver tasks. In standard (stOLAS) mode: `awaiting_stake` → `staked` (this is where `distributor.stake()` creates the staking Safe and registers the OLAS service atomically) → `mech_deployed`. In self-bond mode (legacy): `service_created` → `service_activated` → `agents_registered` → `service_deployed` → `service_staked` (needs OLAS bond) → `mech_deployed`. In self-bond mode, Stage 2 reuses the Stage 1 Safe (one Safe total). In standard mode, Stage 2 creates a separate staking Safe via `distributor.stake()` (two Safes total — see implementation reality check above).

`FleetState` (`client/src/earning/types.ts`) gains four fleet-level fields to carry the Stage 1 result independent of service rows: `fleet_agent_id: string | null`, `fleet_safe_address: string | null`, `fleet_identity_registry: string | null`, and `fleet_stage: 'none' | 'stage1' | 'stage1_and_2'`. Service rows in `services[]` remain strictly Stage 2 state. `FleetBootstrapper` exposes two entry points: `ensureStage1(password): Promise<FleetBootstrapResult>` and `ensureStage1And2(password): Promise<FleetBootstrapResult>`. Each action point in the codebase ensures its own minimum stage:

| Action | Ensures stage | Notes |
|---|---|---|
| `jinn solver-plugins publish` | Stage 1 | Lazily triggers Stage 1 if not complete. Never touches Stage 2. |
| `jinn solver-plugins revoke` | Stage 1 | Same. |
| `jinn run` (and any operator-side action) | Stage 1 + 2 | Existing behaviour. A builder who later wants to operate runs `jinn run`; it detects Stage 1 done, continues at `service_created`. |
| Any envelope/evaluation/capture write | Stage 1 + 2 (de facto) | The daemon does these; the daemon requires Stage 2. |

**One EOA, one agentId by default.** A user becoming-an-operator-later doesn't migrate or re-mint anything; the state machine continues from where it stopped. A builder-only user has `fleet_stage: 'stage1'` and `services: []`. Calling `jinn run` triggers `ensureStage1And2`, which detects `fleet_stage === 'stage1'` and creates the first service row, beginning Stage 2 from `awaiting_stake` (standard mode) or `service_created` (self-bond mode). The Stage 1 identity (`fleet_agent_id`, `fleet_safe_address`) is reused for `setMetadata` calls; Stage 2 creates a separate staking Safe (standard mode) or reuses the Stage 1 Safe (self-bond mode). No re-mint occurs.

A dual-role user (operator-also-builder) is the natural case — same agentId; the Ponder indexer separates streams by metadata `kind` (operator activity under `envelope:` / `evaluation:` / `capture:` on the staking Safe in standard mode; builder activity under `plugin:` / `revocation:` on the identity Safe).

**The `--new-agent-id` flag** mints a second agentId on the same Safe for users who want explicit reputation-stream separation. Niche, opt-in. Default is one agentId for everything.

**Why staged-bootstrap is the right factoring**, not parallel-bootstraps-per-role:

- Builders don't carry operator state they don't need (no OLAS bond locked, no mech deployed, no staking, no service registration). ETH for gas is the only funding requirement.
- Dual-role is free — same identity, same Safe, same agentId. No switching between identities, no decision about "am I a builder or operator" at bootstrap time.
- Idempotent forward: re-run any action; the state machine picks up where it left off.
- Lowers the barrier to entry for builders — no OLAS funding required to publish a plug-in.
- The existing bootstrap state machine just needs to be made stage-aware. Not a new bootstrap; a refactor.

### 5.2 Plug-in registry = a new `kind=plugin` on `IdentityRegistry.setMetadata`

The plug-in registry is **not a new contract**. It is a new `kind` enumerant on the existing `setMetadata` surface (per `2026-04-27-erc-8004-entity-model-design.md` §4.2). Builders publish plug-in records via:

```solidity
IdentityRegistry.setMetadata(builderAgentId, "plugin:<pluginCid>", payload)
```

where `payload` is ABI-encoded:

```
abi.encode(
    version:        uint8,         // = 1
    pluginName:     string,        // npm package name, e.g. "@builder/swe-skill"
    pluginVersion:  string,        // semver, e.g. "0.1.0"
    pluginSha256:   bytes32,       // digestDirectory output
    supports:       string[],      // SolverType ids, e.g. ["swe-rebench-v2.v1"]
    publishedAt:    uint64         // unix seconds
)
```

The `pluginCid` in the metadata key is the IPFS CID of the packed plug-in tarball (computed via the existing `digestDirectory` + `jinn solver-plugins pack` path). The key is the canonical primary key for the plug-in record. The exact payload byte layout is defined as a `PLUGIN_PAYLOAD_TUPLE` in `client/src/erc8004/abis.ts`, mirroring the existing `PAYLOAD_TUPLE` / `PAYLOAD_TUPLE_V2` pattern.

**Revocation**: builder overwrites the same key with a revoked-marker payload (`version=2, revoked=true, reason: string`). Indexer treats the most recent metadata value as authoritative. The key stays `plugin:<pluginCid>` to maintain primary-key stability across overwrites.

**Version updates**: builder ships v0.2.0 → new tarball → new CID → new `plugin:<newCid>` key. The indexer maintains a version chain keyed on `(builderAgentId, pluginName)`.

**Naming collisions across builders**: two builders may publish different packages with the same npm name. Each plug-in record is keyed on `(builderAgentId, pluginCid)`, so there is no on-chain collision. The operator app surfaces the conflict; the builder agentId resolves the ambiguity.

### 5.3 Attribution = envelope's `executor.plugins[].cid` joins on plug-in record

When an operator runs a plug-in, the envelope's existing `executor.plugins[]` field publishes `{name, version, cid, sha256}` per plug-in. The Ponder indexer joins each envelope's `executor.plugins[].cid` against `PluginPublication.pluginCid` to resolve a builder agentId. Joining is O(1) — the indexer already indexes both event streams.

**Forks**: an envelope's `executor.plugins[].sha256` is verified against the matched plug-in record's `pluginSha256`. Mismatch flags the envelope as running a forked/modified plug-in; attribution falls back to "no plug-in record" (the run still scores, but the builder doesn't accrue reputation for it). This is the right honesty signal — anonymous forks shouldn't dilute the original builder's reputation.

**No matching record**: an operator can run a plug-in that was never published (installed via direct npm/local path). The envelope still publishes `executor.plugins[].cid`, but the join produces no builder; the score belongs to the operator only. Builders are invisible in this case — publication is opt-in for builder credit.

### 5.4 Reputation (v0: record-only, derived; Phase B.2: on-chain feedback writes)

**v0 (this epic)**: Builder reputation is **derived in the indexer**, not written on chain.

For each `(builderAgentId, pluginCid)`:
- The indexer aggregates verdict-attached envelopes whose `executor.plugins[]` includes `pluginCid`.
- Score history: list of `(operator, taskId, verdict, score, ts)`.
- Aggregate: count, p50, p90.

**Phase B.2 (under `jinn-mono-0www`)**: Evaluators extend `submitEvaluatorFeedback` to ALSO call `giveFeedback(builderAgentId, ...)` for each plug-in that ran in the evaluated envelope, with `manifestRef="manifest:<verdictCid>"`, `manifestHash=evidenceHash`, `tag1=solverType`. Same mechanism, additional target. Stake-backed; slashing applies. This epic ships the read substrate; 0www writes onto it later.

### 5.5 Validation / disputes — inherited, not redesigned

The existing `ValidationRegistry` operator-initiated self-validation surface (§4.4 of entity-model) extends to builders by symmetry: a builder approves a validator via `IdentityRegistry.approve`, the validator returns a 0-100 score for a `(plugin, taskOutcome)` pair. v0 does not wire this; the same `DisputeProxy` work tracked elsewhere applies symmetrically to builder agentIds.

Adversarial third-party challenge (`DisputeProxy`) is out of v0 scope for both operator and builder roles. Same architecture, same deferral.

### 5.6 Unified read layer across artifact types

This epic ships only `plugin:<cid>`. A future Path 2 publishing epic adds `harness:<cid>` as a sibling metadata kind with its own payload schema (the existing `client/schemas/jinn-manifest-v1.json` shape, which carries signed manifests + capability allow-lists + ed25519 signatures). To keep the future migration cheap, the read layer in this epic establishes a **`PublishedArtifact` base interface** that both kinds extend:

```ts
interface PublishedArtifact {
  builderAgentId: bigint;
  cid: string;
  name: string;
  version: string;
  supports: string[];
  publishedAt: number;
  artifactType: 'plugin';  // future: | 'harness'
}

interface PluginPublication extends PublishedArtifact {
  artifactType: 'plugin';
  pluginSha256: string;
}
```

Discovery API endpoints:
- **Per-artifact-type** (clean schemas, the primary read shape):
  - `GET /plugins?solverNet=<id>` — published plug-ins for a SolverNet.
  - `GET /plugins?builder=<address>` — published plug-ins by a builder.
  - `GET /plugins/<cid>/scores` — score history for a published plug-in.
- **Unified** (cross-type queries):
  - `GET /builders/<address>/artifacts` — all published artifacts by a builder, typed by `artifactType`. Today returns only plug-ins; future-proofed for harnesses.
  - `GET /builders/<address>/scores` — per-artifact aggregated score history.

The **on-chain layer stays per-artifact-type** (separate metadata kinds with distinct payload schemas — clean ABI typing, clean indexer dispatch). The **read layer unifies** so a builder's full footprint is queryable in one call.

The `/build` SPA surface uses the unified `/builders/<address>/artifacts` endpoint with a type filter chip. v0 has only one type to filter; the chip is in place from day one so the future harness-tab addition is a SPA-only change with no API churn.

### 5.7 What changes in `executor.plugins[]`? Nothing.

The envelope schema is **untouched**. `executor.plugins[].cid` is already the primary key that joins to plug-in records; no new field is needed.

## 6. Children (seven problem-shaped beads)

Per `uy6v`'s scope rule, each child is acceptance-criteria-shaped, not solution-shaped. Per-child planning sessions choose the implementation. The §5 substrate design grounds these — the children are implementation, not further design.

### 6.1 Staged-bootstrap refactor + `identity_registered` step

Refactor `client/src/earning/bootstrap.ts` to make Stage 1 (identity) and Stage 2 (operator) independently re-entrant per §5.1. Concretely:

- The state file (`~/.jinn-client/earning/earning_state.json`) gains a `stage` marker (`'stage-1' | 'stage-2'`) and a per-step `stage` tag.
- A new `identity_registered` step is added as the Stage 1 capstone: calls `IdentityRegistry.register()` then `setAgentWallet(agentId, safeAddress)` via the existing Safe-routed tx path. Composes with `jinn-mono-j07` (agent NFT mint) and `jinn-mono-aev` (`setAgentWallet`) — either by extending those beads' surfaces or absorbing their work here, depending on whether they have shipped at planning time.
- The bootstrap orchestrator gains two entry points: `ensureStage1(ctx)` and `ensureStage1And2(ctx)`. Each walks the state machine forward to its target stage, idempotent and re-entrant.
- `jinn solver-plugins publish` (and `revoke`, and any other builder action) calls `ensureStage1`. `jinn run` (and any operator action) calls `ensureStage1And2`. Today's `jinn run` already does the full bootstrap; the refactor preserves that behaviour and adds the Stage 1-only entry point.
- The existing `awaiting_funding` gate splits: in Stage 1 it requires ETH for gas only; in Stage 2 it additionally requires OLAS for the service bond and staking.

`--new-agent-id` and `--builder-agent-id <id>` are flags on `jinn solver-plugins publish` (and the daemon-side writers) for users who want explicit per-role agentId separation. Default is one agentId per Safe. No separate `jinn builder init` ship — the capability exists as a side effect of `publish`'s lazy stage-ensure.

If a convenience verb is desirable (`jinn identity ensure` or similar) so users can pre-provision Stage 1 ahead of any specific action, it ships as a thin wrapper around `ensureStage1`; not required by acceptance.

### 6.2 `jinn create plugin <name>` scaffold

Extend `client/src/cli/commands/create.ts` with a `plugin` target. Two patterns:

- `solver-type-plugin` — `jinn.supports: [<SolverType>]`; scaffold modeled on `client/plugins/swe-rebench-v2-runtime/`; generates `jinn.plugin.json`, `skills/<name>/SKILL.md`, optional `.mcp.json` + `mcp/<name>-server.mjs`, `package.json`, `test/plugin.test.ts` (validates manifest + tests load via `loadSolverPluginManifest`), `README.md` with a link to the canonical quickstart at `/docs/build/quickstart.md`.
- `runtime-plugin` — `jinn.supports: ['jinn.runtime']`; scaffold modeled on `client/plugins/network-tools/`.

Templates under `client/templates/plugins/<pattern>/`. First-run `yarn install && yarn test` passes. `jinn create plugin --help` documents both patterns and the `--solver-type` / `--out-dir` flags.

### 6.3 Plug-in publication: `jinn solver-plugins publish`

A new sub-verb on the existing `solver-plugins` command. Inputs: a resolvable plug-in source (npm, git, github, or local path), a target SolverNet, a builder signing key (sourced from the existing operator keystore by default; overridable with `--builder-agent-id`). The verb:

1. Calls the existing `pack` path to compute `pluginSha256` and the IPFS CID.
2. Uploads the packed tarball to IPFS via the existing IPFS surface (Autonolas gateway or operator-configured pin service).
3. ABI-encodes the §5.2 payload.
4. Submits `IdentityRegistry.setMetadata(builderAgentId, "plugin:<pluginCid>", payload)` via the Safe-routed tx path (mirroring `client/src/erc8004/reputation.ts`'s `executeSafeTransaction` pattern).
5. Returns the on-chain tx hash and the CID/sha256 to the builder for retention.

`jinn solver-plugins revoke <pluginCid>` is a sibling verb that writes the revoked-marker payload to the same key.

### 6.4 Ponder indexer extension + `PublishedArtifact` model

Extend the Ponder indexer (per `jinn-mono-280n`) with:

- A new entity `PluginPublication` derived from `IdentityRegistry.MetadataSet` events with `kind=plugin`.
- The `PublishedArtifact` base interface from §5.6.
- Decoder for the `PLUGIN_PAYLOAD_TUPLE` ABI shape.
- A join from `Envelope.executor.plugins[].cid` to `PluginPublication.pluginCid`, producing a derived `BuilderAttributedRun` row.
- Aggregations: per-`(builderAgentId, pluginCid)` score history and rollup; per-`builderAgentId` artifact list.
- Revocation handling (most-recent value wins; revocations flagged in queries).

### 6.5 Discovery API endpoints

Extend the Discovery API (per `jinn-mono-280n`) with the endpoints from §5.6:

- `GET /plugins?solverNet=<id>` — list published plug-ins for a SolverNet.
- `GET /plugins?builder=<address>` — list published plug-ins by a builder agentId or Safe address.
- `GET /plugins/<cid>/scores` — score history for a published plug-in (joins to ebu7's HarnessCheckpoint rollups).
- `GET /builders/<address>/artifacts` — unified artifact list (`PublishedArtifact[]`), typed by `artifactType`.
- `GET /builders/<address>/scores` — per-artifact aggregated score history.

Read-only. The aggregation reuses ebu7's existing rollups by joining on `pluginCid`; no new score aggregation is computed.

### 6.6 `/build` route in operator SPA + canonical `/docs/build/` tree

Two coupled deliverables; combined because the SPA route's intro card and shape catalogue draw their content live from the docs tree.

- `/build` route: intro card (rendered from `/docs/build/quickstart.md`); plug-in shape catalogue (generated from `SolverPluginManifest` in `client/src/plugins/types.ts` plus the validator's runtime/SolverType mode distinction); browse-published-plug-ins panel (consumes `/plugins?solverNet=` from §6.5, reuses `client/src/dashboard/spa/src/pages/leaderboard/Leaderboard.tsx`); "your published plug-ins" panel (consumes `/builders/<address>/artifacts` filtered by the local builder identity); artifact-type filter chip (per §5.6, future-proofs the harness tab).
- `/docs/build/` tree: `quickstart.md` (60-second walk from `swe-rebench-v2-runtime/`-copy through publish), `shape-reference.md` (`jinn.plugin.json` shape, two exclusive modes, `skills/` and `.mcp.json` conventions), `examples.md` (anchored on the in-repo reference plug-ins), `publishing-flow.md` (the sequence diagram from §5.2 / §5.3 / §6.3, plain-prose), `identity.md` (the §5.1 mirror, plain-prose), `compatibility.md` (`jinn.supports` semantics, version pinning, which harnesses load which slots).

`jinn create plugin` prints the `/docs/build/quickstart.md` URL on completion. The `/build` route is added to the SPA nav as a peer of `/operator` and `/launcher`.

### 6.7 Reference competing plug-in + cold-start E2E acceptance gate

Two concerns combined into one bead because they're naturally one piece of evidence:

- A separate published package that demonstrates the full builder loop and serves as the first-integrator artefact (per `spec/2026-04-30-plug-in-surface.md` §6's adaptation of #57 §3 — "the first integrator must have at least as good an experience as the second"). Lives outside `client/plugins/` (either under `examples/plug-ins/<name>/` in this repo or as its own published package). Targets `swe-rebench-v2.v1`. Demonstrates: scaffold → publish (which lazily completes Stage 1) → operator install → score.
- A vitest under `client/test/acceptance/` (or wherever the cold-start E2E pattern fits) that walks the loop end-to-end against a stub/fixture daemon: scaffold via `jinn create plugin` → pack → `jinn solver-plugins publish` against a stub IPFS + stub `IdentityRegistry` (Stage 1 ensured lazily, idempotent on re-run) → operator's Discovery API surfaces the published plug-in → operator installs (existing path) → stub-Hermes runs a SWE-rebench v2 task with the plug-in loaded → envelope emits `executor.plugins[]` → ebu7-compatible rollup picks it up → `/build` builder-filter shows the score → builder attribution record updates. The test should also exercise the dual-role path: an operator (who has completed Stage 1+2 via `jinn run`) publishes a plug-in via the same flow; Stage 1 detected as done; proceeds straight to packing + `setMetadata`.

## 7. Dependencies

- **`jinn-mono-uy6v`** (first public release) — operator install path and signed-verdict envelope are preconditions for §6.7's E2E. This epic should not begin shipping children until uy6v's release gates are green.
- **`jinn-mono-8psp`** (Hermes harness integration, PR #140–#145) — Hermes is the target harness. The §6.7 E2E and the §4 acceptance both assume `hermesConfigFromSolverPlugins()` is merged and stable.
- **`jinn-mono-280n`** (Discovery API / Ponder indexer) — §6.4 and §6.5 extend it.
- **`jinn-mono-ebu7`** (Network explorer) — §6.5 joins to its HarnessCheckpoint rollups; §6.6 reuses its `Leaderboard.tsx`. ebu7.4, ebu7.6, ebu7.7 are already closed; rdod is awaiting public deploy.
- **ERC-8004 mint + setAgentWallet flow** (`jinn-mono-j07` mint, `jinn-mono-aev` setAgentWallet) — §6.1 reuses or extends these existing beads.

This epic is a **post-v1 epic**. It depends on uy6v's release ship; it does not gate v1.

## 8. Out of scope

- **Path 2 (bring-your-own restorer impl) publishing flow** — separate epic for forecaster-shape recruits. The Path 2 substrate (`jinn create harness`, `jinn.manifest.json` schema, capability allow-list, ed25519 signature) already exists; the publishing analogue adds a sibling `harness:<cid>` metadata kind, surfaces in the same `/builders/<address>/artifacts` endpoint (per §5.6 future-proofing), and is otherwise mechanically symmetric. v0 sets up the read-layer base interface; the Path 2 publishing epic adds the kind + payload + indexer entry.
- **Parallel identity primitives per role.** Explicitly rejected — see §5.1. One agentId per Safe, two stages on one state machine, lazy stage-ensure per action. No separate "builder identity" primitive.
- **Stake-backed reputation slashing + challenge mechanism** — `jinn-mono-0www` (Phase B.2 evaluator economics).
- **New cross-operator score aggregation** — already shipped under ebu7.4, ebu7.6, ebu7.7.
- **Verdict envelope extensions for plug-in attribution** — `executor.plugins[]` already exists in `jinn.execution.v1`.
- **Evaluator re-execution with declared plug-in set** — not needed for SWE-rebench v2 (the evaluator scores patches against gold-patch test suites; plug-ins help produce the patch but don't change patch correctness, so re-installing them adds no signal).
- **Cross-harness plug-in travel for non-portable slots** — phase-agent-override and topic-explorer slots live inside the `learner` harness; this epic ships only the harness-portable surface (skills, MCP tools, optional hooks) that Hermes loads via `hermesConfigFromSolverPlugins()`. Wider harness coverage is a follow-on.
- **Plug-in marketplace beyond the browse-published-plug-ins panel** — Phase 2+.
- **Hot-reload of plug-ins inside a running daemon** — Phase 2+; consistent with the once-per-process model in `spec/2026-05-external-restorer-impls.md` §3.4.
- **New SolverNets beyond `swe-rebench-v2`** — Ritsu's reframe holds: same SolverNet, different views per harness family. New SolverNets are separate epics.

## 9. Open questions

1. **Whether `--new-agent-id` survives v0.** Default is one agentId per Safe — all activity flows through it, streams separated by metadata kind. `--new-agent-id` opt-in mints a second agentId on the same Safe for users who want explicit reputation-stream separation. Open: is the flag worth shipping in v0, or is one-agentId-everywhere sufficient until evidence shows users want separation? Defer to §6.1 planning.
2. **Convenience verb for pre-provisioning Stage 1.** `jinn identity ensure` (or `jinn init` or similar) as a thin wrapper around `ensureStage1` for users who want to provision an identity ahead of any specific action. Not required for acceptance (the lazy stage-ensure from `publish` is enough); shipping it is a UX question.
3. **`jinn solver-plugins publish` vs `jinn publish plugin <pkg>`.** Folding under `solver-plugins` (consistent with the current command tree) vs a top-level `publish` verb (clearer for cold-start). Defer to §6.3 planning.
4. **IPFS upload backend for `publish`.** Use the Autonolas gateway (already wired for envelopes/evaluations), or require operators to configure their own pin service, or fall back to a local-only mode for testing. Defer to §6.3 planning; default to Autonolas gateway for v0.
5. **Where the `/build` route lives in the SPA nav.** Top-level alongside `/operator` and `/launcher`, or under a new section. Recommend top-level peer.
6. **First-integrator candidate.** §6.7 commits to publishing one reference plug-in. Which recruit shape it anchors on — Hermes-migrator (per the growth lanes in #129's roadmap comment) vs sovereign-forker vs ERC-8004 builder — is a `GROWTH.md`-touching question; defer to §6.7 planning with input from `spec/2026-05-12-growth-target-ecosystem-builders.md`.

## 10. References

### Existing code
- `client/src/types/envelope.ts` — the `jinn.execution.v1` envelope with `executor.plugins[]`.
- `client/src/plugins/{manifest,validator,resolvers,registry,digest,index,types}.ts` — existing plug-in runtime.
- `client/src/erc8004/{identity,reputation,addresses,abis}.ts` — existing ERC-8004 surfaces.
- `client/src/earning/bootstrap.ts` — operator 11-step bootstrap that §6.1 builder bootstrap mirrors a subset of.
- `client/src/cli/commands/{create,solver-plugins,solver-nets}.ts` — existing CLI surface to extend.
- `client/templates/harnesses/` — pattern for the new `client/templates/plugins/` analogue.
- `client/plugins/{swe-rebench-v2-runtime,network-tools,jinn-prediction-plugin,learner}/` — reference plug-ins.
- `client/schemas/jinn-manifest-v1.json` — Path 2 harness manifest schema (reference for the future `harness:<cid>` kind).
- `client/src/dashboard/spa/src/pages/leaderboard/` — existing leaderboard components to reuse.
- `client/src/harnesses/impls/hermes-agent/` (incoming, PR #141) — target harness's plug-in consumption path via `hermesConfigFromSolverPlugins()`.

### Specs and DRs
- `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` — the entity model this epic extends by symmetry.
- `docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md` — the payload schema this epic adds a `plugin` variant to.
- `log/decisions/2026-05-06-trust-stack-composition.md` — trust stack the v0 record-only reputation sits in.
- `spec/2026-04-30-plug-in-surface.md` — Path 1 plug-in surface (design parent).
- `spec/2026-05-01-harness-pack-architecture.md` — runtime/SolverType mode distinction.
- `spec/2026-04-30-phase-a-umbrella.md` — Phase A umbrella.
- `spec/2026-05-12-growth-target-ecosystem-builders.md` — recruit shapes for §6.7 first-integrator candidate.

### Beads
- `jinn-mono-uy6v` — first public release (operator install path; signed envelopes).
- `jinn-mono-8psp` — Hermes harness integration (PR #140–#145).
- `jinn-mono-280n` — Discovery API + Ponder indexer (the read substrate §6.4/§6.5 extends).
- `jinn-mono-ebu7` — Network explorer (reuses HarnessCheckpoint rollups, `Leaderboard.tsx`, per-operator view).
- `jinn-mono-0www` — Phase B.2 evaluator economics + reputation slashing (future on-chain feedback writes for builder agentIds).
- `jinn-mono-j07` — IdentityRegistry agent NFT mint (existing bead the §6.1 bootstrap composes with).
- `jinn-mono-aev` — `setAgentWallet` wiring (existing bead the §6.1 bootstrap composes with).

### Discussions
- GitHub Discussion [#129](https://github.com/Jinn-Network/mono/discussions/129) — Sharpening SolverNet 1; this epic reframes skill-as-unit to plug-in-as-unit.
- GitHub Discussion [#59](https://github.com/Jinn-Network/mono/discussions/59) — knowledge-market substrate vision; this epic's compounding-knowledge framing inherits from it.

---

*End of v0.3.*
