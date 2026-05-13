# Staged-bootstrap fit findings

- **Date:** 2026-05-14
- **Author:** spike subagent (feature-dev:code-explorer)
- **Status:** Findings
- **For bead:** `jinn-mono-nghf`
- **Parent spec:** `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §5.1

---

## 1. Fleet vs single-Safe

The codebase is a pure **per-service-Safe model** with no fleet-level identity or Safe. `FleetState` (`client/src/earning/types.ts:97-103`) holds a `master_address` (the HD-derived EOA that funds everything) and an array of `ServiceState` records. There is no "fleet Safe" or "fleet agentId." Each `ServiceState` record has its own `safe_address`, `service_id`, `mech_address`, and — post-jinn-mono-j07 — its own `agent_id` (`types.ts:73-90`).

The "master" is a funding wallet only: HD index-0, signs `stake()` calls in standard mode (`bootstrap.ts:900-927`), sends ETH to agent EOAs in self-bond mode (`bootstrap.ts:1341-1353`). It does not own a Safe, hold an agentId, or participate in identity at all.

A "fleet with 0 services" therefore has no Safe and no agentId. The spec's two-stage model implies promoting the first service's lifecycle to carry both identity and operator state, which requires a structural change.

## 2. Mode differences

**Standard mode (stOLAS — testnet default):**
- Step sequence: `awaiting_stake` → `staked` → `mech_deployed` → `agent_registered` → `safe_binding_pending` → `complete` (`types.ts:12-17`)
- `distributor.stake()` atomically creates the service AND the Safe in a single tx (`bootstrap.ts:869-954`). The Safe address is parsed from the `CreateMultisigWithAgents` event (`bootstrap.ts:942-944`). There is no separate Safe predict or Safe deploy step.
- Only ETH for master gas is required; OLAS is handled by the stOLAS distributor.

**Self-bond mode (legacy):**
- Step sequence: `awaiting_stake` → `service_created` → `service_activated` → `agents_registered` → `service_deployed` → `service_staked` → `staked` → `mech_deployed` → `agent_registered` → `safe_binding_pending` → `complete` (`types.ts:10-18`)
- Safe is predicted deterministically from the agent private key before any service registry call, at `stepSelfBondSetup` (`bootstrap.ts:1320-1329`).
- Requires direct OLAS holding (bond in Safe) and ~8 Safe-originated txs.

**Mode defaults:** constructor default is `'standard'` (`bootstrap.ts:168`). Self-bond is marked "legacy" (`types.ts:8`). Testnet ships standard mode; no mainnet distributorAddress is in the bundled config. v1 ships standard mode.

**Critical implication for Stage 1 design:** the spec's Stage 1 steps (`safe_predicted` → `awaiting_funding` → `safe_deployed`) match self-bond topology, not standard mode. In standard mode there is no predict step — the Safe is a side-effect of `stake()`.

## 3. Identity ordering — why `agent_registered` is at the end

`stepRegisterAgent` (`bootstrap.ts:1134-1290`) performs two sub-steps:

- **Sub-step A (mint):** `IdentityRegistry.register()` from the agent EOA (`bootstrap.ts:1182-1220`). Requires only the agent EOA + ETH for gas. No service, Safe, or staking prerequisite exists on-chain.
- **Sub-step B (bind):** `IdentityRegistry.setAgentWallet(agentId, safe, deadline, sig)` from the agent EOA (`bootstrap.ts:1246-1286`). Requires the Safe address to be known AND the Safe to be deployed, because the contract invokes ERC-1271 `isValidSignature` on the Safe. The Safe must have bytecode.

The mint is at the end **purely by historical ordering**: the entity-model spec (`docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md:202`) literally says "append a new step (`agent_registered`)" after `complete`. There is no on-chain reason to defer the mint past staking.

Moving the mint to run immediately after the Safe is deployed is safe for both modes. Moving the bind to immediately follow the mint is also safe as long as the Safe is deployed. The constraint is the bind's dependency on a deployed Safe, not on a staked or mech-deployed service.

## 4. Existing Safe lifecycle

**Standard mode:** Safe does not exist before `stake()`. It is created atomically inside `distributor.stake()` (`bootstrap.ts:942-954`). The Safe address depends on what the stOLAS distributor computes — the client does not control it and cannot predict it before calling `stake()`. There is no `safe_predicted` state in the standard path.

**Self-bond mode:** Safe is predicted deterministically from the agent private key via `initPredictedSafe` at `stepSelfBondSetup` (`bootstrap.ts:1321-1329`). This prediction is pure math (Safe factory counterfactual). The Safe is deployed in the same step if not yet on-chain (`bootstrap.ts:1402-1433`). The Safe address does not depend on a service_id; it depends only on the agent private key.

For the proposed Stage 1 (`safe_predicted` → `safe_deployed` → `identity_registered`): this is the self-bond Safe path. The Safe creation in standard mode makes Stage 1 impossible-without-OLAS unless Stage 1 adopts the self-bond Safe topology unconditionally.

## 5. Migration risk

Testnet operators in the wild may be at any step including `service_staked` or `mech_deployed` with no `agent_id` yet (pre-jinn-mono-j07 state). The existing resume logic already handles forward-walking through `stepRegisterAgent` for these operators (`bootstrap.ts:806-814`, `bootstrap.ts:856-864`, `bootstrap.ts:770-777`). The pattern — detect `agent_id === null`, run mint — is already established.

If nghf adds a new step (`identity_registered`) earlier in the chain, existing operators' persisted steps (`mech_deployed`, `service_staked`) would be "ahead" of the new step. The safe migration path: resume logic checks `fleet.fleet_agent_id === null` (in the Option A schema) and runs Stage 1 before advancing to Stage 2, regardless of what `services[0].step` says. The `recoverEvictedService` idiom at `bootstrap.ts:1010-1017` (force step back to `mech_deployed` to re-walk through `stepRegisterAgent`) shows the team already uses step-forcing for this pattern.

No on-chain migration is required. State file migration is a one-time field promotion (copy `services[0].agent_id` → `fleet.fleet_agent_id` when present).

## 6. uy6v conflict surface

All in-flight `uy6v.*` branches were checked by inspecting worktree copies of `earning/bootstrap.ts` and `earning/types.ts`. The uy6v8, uy6v10, uy6v11 worktrees all carry bootstrap.ts identical to main on `stepRegisterAgent`, `resumeService`, `resumeServiceStandard`, `resumeServiceSelfBond`, and `ServiceStepSchema`. The 52x3 and et6s worktrees (the epic parent) are likewise unmodified on these surfaces.

The uy6v.* work is entirely in the SWE-rebench eval loop, reputation feedback writes, and docker image GC — none of which touch the bootstrap state machine.

**Conflict surface: zero.** nghf has a clean file-level isolation from all in-flight uy6v work.

## 7. "Builder with 0 services" coherence

A fleet with `services: []` currently has no Safe and no agentId. `IdentityRegistry.register()` is called by an agent EOA (`bootstrap.ts:1152-1153`), not the master. For a builder to have identity without any service row, the bootstrap would need an agent EOA, ETH, and a Safe — none of which are attached to the current `FleetState` schema without a `ServiceState` row.

The `FleetStateSchema` (`types.ts:97-103`) has no fleet-level `agent_id`, `safe_address`, or identity fields. All identity state is in `ServiceState` (`types.ts:73-90`). A pure builder with 0 services would require either:
- A new fleet-level identity field set in `FleetState` (Option A), or
- A stub service row with `service_id: null`, `mech_address: null` (awkward schema abuse), or
- A separate identity state file (Option C).

The current schema does not support a builder with 0 services without a schema change.

## 8. Bridge proposal

### The options

**Option A (fleet-level Stage 1 fields):** Add `fleet_agent_id`, `fleet_safe_address`, `fleet_identity_registry`, and `fleet_stage: 'none' | 'stage1' | 'stage1_and_2'` to `FleetState`. Stage 1 uses the self-bond Safe topology unconditionally (predict Safe from agent key, deploy it, register identity, bind wallet). Service rows remain purely Stage 2. Builders get fleet-level identity with `services: []`.

**Option B (first service as identity):** Service[1] walks through Stage 1 (to `identity_registered`). Stage 2 continues with staking. For standard mode, the Safe only appears after `stake()` — so Stage 1 cannot complete until after `stake()`, which requires OLAS. **This violates the "ETH-only Stage 1" design goal.**

**Option C (separate builder identity):** New `builder_state.json`. Clean decoupling. Dual-role users carry two state files and two identities.

**Option D (universal self-bond Stage 1, regardless of staking mode):** Stage 1 always uses the self-bond Safe path (deterministic prediction). Stage 2 in standard mode creates a separate "staking Safe" via `stake()`. Two Safes coexist for dual-role operators: one identity Safe (Stage 1), one staking Safe (Stage 2). `setMetadata` calls go through the identity Safe; on-chain activity goes through the staking Safe.

### Recommendation: Option A

Option A is the right factoring. It requires the smallest schema change (four fields added to `FleetState`), the smallest bootstrap refactor (a new `ensureStage1(password)` method that runs the self-bond Safe predict+deploy+identity path against a fleet-level slot, separate from the existing per-service Stage 2 path), and produces the cleanest dual-role experience for the most common case. Migration from existing state files is a one-time non-destructive field promotion. Builders with `services: []` get a coherent identity. `jinn run` calls `ensureStage1And2`, detects `fleet_stage === 'stage1'`, and creates the first service row at `awaiting_stake` — forward from Stage 1 without re-minting.

Option B fails for standard mode (Safe unavailable until after OLAS staking). Option C breaks dual-role coherence (two identities, two state files, no natural merge). Option D adds two-Safe complexity to operators that is unnecessary.

**Caveat for the captain to decide:** under Option A in standard mode, a dual-role operator who runs `jinn solver-plugins publish` first (creating a Stage 1 identity Safe via self-bond topology) and then later runs `jinn run` (which goes to standard mode and creates a staking Safe via `distributor.stake()`) will end up with TWO Safes — the identity Safe holds the agentId; the staking Safe runs OLAS activity. setMetadata calls flow through the identity Safe; reward distributions land in the staking Safe. This is awkward but mechanically clean. Self-bond mode operators would reuse one Safe.

If the two-Safe-in-standard-mode case is unacceptable, the alternative is to constrain Stage 1 to only fire in self-bond mode (or require dual-role users to opt into self-bond) — but standard mode is the v1 default, so this effectively means dual-role isn't supported in v1 ergonomically.

## 9. Spec §5.1 amendments needed

**Amendment 1 — Step sequence is mode-specific, not universal.** The sentence in §5.1:

> Steps: `wallet` → `safe_predicted` → `awaiting_funding` (ETH only — no OLAS required) → `safe_deployed` → `identity_registered`

Is accurate only for the self-bond Safe path. In standard mode, there is no `safe_predicted` or `safe_deployed` step — the Safe is a side-effect of `distributor.stake()`. The spec must state that Stage 1 unconditionally uses the self-bond Safe topology:

> Stage 1 uses the self-bond Safe topology regardless of the operator's eventual staking mode. The agent EOA deterministically predicts a Safe address via the Safe factory, the master funds the agent with ETH, the Safe is deployed, and `IdentityRegistry.register()` + `setAgentWallet()` completes identity. No OLAS is required at Stage 1 in either mode.

**Amendment 2 — Schema change must be specified.** The sentence:

> The bootstrap state machine in `client/src/earning/bootstrap.ts` is refactored to carry a stage marker

Is too vague. It should read:

> `FleetState` (currently `client/src/earning/types.ts:97-103`) gains four fleet-level fields: `fleet_agent_id: string | null`, `fleet_safe_address: string | null`, `fleet_identity_registry: string | null`, and `fleet_stage: 'none' | 'stage1' | 'stage1_and_2'`. Service rows in `services[]` remain strictly Stage 2 state. The `FleetBootstrapper` exposes two entry points: `ensureStage1(password): Promise<FleetBootstrapResult>` and `ensureStage1And2(password): Promise<FleetBootstrapResult>`.

**Amendment 3 — "continues from `service_created`" needs the mechanism.** The sentence:

> A builder who later wants to operate continues from `service_created` — no re-mint, no second Safe, no second agentId.

Should be extended to specify the transition:

> A builder-only user has `fleet_stage: 'stage1'` and `services: []`. Calling `jinn run` triggers `ensureStage1And2`, which detects `fleet_stage === 'stage1'` and creates the first service row, beginning Stage 2 from `awaiting_stake`. The Stage 1 identity (`fleet_agent_id`, `fleet_safe_address`) is reused for `setMetadata` calls; Stage 2 in standard mode creates a separate staking Safe (an awkward but mechanically clean two-Safe topology for dual-role operators); in self-bond mode, Stage 2 reuses the Stage 1 Safe. No re-mint occurs.

---

## Essential files

- `client/src/earning/bootstrap.ts` — state machine; `stepRegisterAgent` (line 1134), `resumeServiceStandard` (line 787), `stepStolasStake` (line 869), `stepSelfBondSetup` (line 1310)
- `client/src/earning/types.ts` — `FleetStateSchema`, `ServiceStateSchema`, `ServiceStepSchema` — needs the fleet-level identity fields
- `client/src/earning/store.ts` — `FleetStateStore.patchFleet()` is the fleet-level write path
- `client/src/earning/agent-wallet-binding.ts` — `bindAgentWalletToSafe()` — the ERC-1271 bind call (reused in Stage 1)
- `client/src/earning/safe-adapter.ts` — `initPredictedSafe()` — deterministic Safe prediction (the Stage 1 Safe path)
- `client/src/main.ts` — the `bootstrap()` function (lines 404-661) that calls `FleetBootstrapper` and gates the daemon
- `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` — parent epic spec §5.1
