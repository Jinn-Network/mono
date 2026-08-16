# Testnet `manifestDigest` cutover — Base Sepolia

**Date:** 2026-05-06 (planned)
**Branch:** `opus/solvernet-creation-and-launch`
**Spec:** [`spec/2026-05-05-solvernet-creation-and-launch.md`](../../spec/2026-05-05-solvernet-creation-and-launch.md) §14, §15, §17 Decision 6
**Plan task:** [`docs/superpowers/plans/2026-05-06-solvernet-creation-and-launch-plan.md`](../superpowers/plans/2026-05-06-solvernet-creation-and-launch-plan.md) Task 26

## What changes

The TaskCoordinator + JinnRouterV3 contracts rename their `solverTypeDigest` storage/event field to `manifestDigest`. The Solidity rename itself is purely cosmetic at the wire level (storage layout, event topics, function selectors all unchanged — Solidity selectors and topics are computed from types, not param names).

What is **not** cosmetic: the daemon's task-posting code now computes the bytes32 stored in that field as `keccak256(manifestCid)` instead of `keccak256(solverType)`. Existing testnet tasks created before this cutover have a digest derived from the old semantic. New tasks created after will have a digest derived from the launched-instance manifest cid.

## Operational impact — testnet task-data clean break

Per spec §15 + Decision 6 (C-semantic), this is a **clean break** on testnet task data. Whether a data-migration burden exists turns on the current external-operator set — enumerate it from on-chain state (claim events / ERC-8004 IdentityRegistry registrations) rather than assuming none.

After the cutover:

- **Fleets keep their identities.** Master EOAs, agent EOAs, agentIds, ERC-8004 IdentityRegistry records — all unchanged. No re-bootstrap.
- **TaskCoordinator + JinnRouterV3 keep their addresses.** Proxy upgrade preserves the public-facing addresses in `contracts/deployment-task-coordinator-router-v3-baseSepolia*.json`.
- **Existing in-flight tasks orphan.** Tasks created before the cutover have a digest of `keccak256("prediction.v1")`. New attempts/verdicts on those tasks will fail the policy hook's digest match. Operators will see them as stuck on-chain. Acceptable: in-flight count on Jinn-team's testnet is currently zero (verified before cutover; see "pre-cutover check" below).
- **New tasks work normally.** New `prediction.v1` tasks posted by the launcher daemon carry the manifest cid in the canonical task body and the `manifestDigest = keccak256(cid)` on chain.

## Subgraph

Subgraph V3 indexing has not yet been built (jinn-mono-qwdc.36). Until that lands, the operator catalog `/configuration#solvernets` and post-launch dashboard `/launcher/launched/:id` cannot show launched SolverNets across machines — daemon-side launch flow works, but cross-machine discovery is blocked. Plan to land V3 indexing before announcing the cutover to any external operators.

## Pre-cutover checklist

- [ ] `cd contracts && yarn test` — 449/449 passing on the renamed contracts (verified at commit `217cb804`)
- [ ] `cd operator && npx tsc --noEmit && yarn vitest run` — daemon typecheck + tests green (verified at commit `11e3d47f`)
- [ ] Verify no in-flight tasks on Base Sepolia TaskCoordinator (`https://sepolia.basescan.org/address/<address>`) — should be 0 or only tasks the team is intentionally orphaning
- [ ] Confirm `DEPLOYER_PRIVATE_KEY` env var is set for the deploy environment
- [ ] Confirm `BASE_SEPOLIA_RPC_URL` is reachable
- [ ] Verify Studio/Graph deploy access token (only relevant once V3 indexing is built)

## Deploy command (TaskCoordinator + JinnRouterV3 implementation upgrade)

```bash
cd /path/to/jinn-mono/cargo/contracts
DEPLOYER_PRIVATE_KEY=<…> BASE_SEPOLIA_RPC_URL=<…> npx hardhat run scripts/upgrade-task-coordinator-router-v3.ts --network base-sepolia
```

The script preserves the public proxy addresses and replaces the implementation pointers. Output writes back to `deployment-task-coordinator-router-v3-baseSepolia*.json`.

## Post-deploy verification

1. Read `getTask(...)` against the proxy via the new ABI — struct field `manifestDigest` should decode correctly (same byte position; the rename is structurally cosmetic).
2. Post a fresh prediction.v1 Task via the daemon — verify the on-chain `TaskCreated.manifestDigest` topic equals `keccak256(<cid>)`.
3. Spot-check that pre-cutover tasks remain readable but their digest no longer matches the new policy-hook check (expected; they are orphaned).
4. Commit the updated deployment JSON (and any block-number updates) on the new branch with message:

```
chore(deploy): testnet upgrade for manifestDigest rename

TaskCoordinator + JinnRouterV3 implementation pointers swapped for the
post-rename bytecode. Proxy addresses preserved; storage layout
unchanged. Existing in-flight Tasks have orphan digests; new Tasks
carry keccak256(manifestCid) per spec §14 Decision 6.
```

## When to actually run

Defer until:
- The plan's Phase 7 daemon-side work is fully merged (currently on `opus/solvernet-creation-and-launch`)
- jinn-mono-qwdc.36 (subgraph V3 indexing) is in flight or complete, so post-deploy operators can actually see launched SolverNets
- Coordinated with anyone who has been dogfooding the testnet (currently: Jinn team only)
- All pre-deploy gates are green (see "Pre-deploy gates" below)

## Pre-deploy gates

Before running the upgrade for real, confirm all four gates pass.

```bash
# 1. Contracts regression — storage layout pins + ABI invariance + unit tests
cd contracts && yarn test
# Expected: 486 passing. Storage pins enforce slot stability for every
# load-bearing state variable on TaskCoordinator + JinnRouterV3 (17 pins).
# ABI invariance asserts every renamed selector + event topic is byte-
# identical to its pre-rename hash (23 tests). Drift on either == block.

# 2. Daemon Anvil-fork e2e — full lifecycle on a Base Sepolia fork with
#    the upgrade applied in-fork (canonical pre-deploy gate)
cd operator && yarn e2e
# Expected: 4 phases pass. The "Base Sepolia fork Task-first full loop
# with real Mech" phase is the load-bearing one — it forks live Base
# Sepolia via Anvil, runs `upgradeTaskStackInsideFork` to swap the
# TaskCoordinator + JinnRouterV3 implementations, bootstraps two
# operator fleets, and walks createTask -> claim -> submit ->
# claimEvaluation -> submitVerdict -> finalize against the upgraded
# stack. Verdict=SCORED + a non-zero score is the signal.
#
# This phase exercises:
#  - Real Base Sepolia state at fork time (no hardfork-history issues —
#    Anvil handles them natively)
#  - The proxy upgrade path against live deployment artifacts
#  - The new manifestDigest semantic end-to-end
#  - All 16 V3 event topics decode correctly via the renamed ABIs
#  - Real MechMarketplace + activity checker — not mocks
#  - Operator claim eligibility filtered by manifestDigest
#
# Skip the fork phase locally with JINN_E2E_SKIP_FORK=1 (falls back to a
# pure-local Anvil chain); for a deploy gate, leave it on.

# 3. Subgraph matchstick — handler decoding for all V3 event types
cd subgraph && yarn test
# Expected: 17 passing across task-coordinator + jinn-router-v3.
```

If gate 1 fails: a structural bug slipped past the unit-level checks. Block.

If gate 2 fails: the upgrade is NOT safe against actual deployed state. Block.

If gate 3 fails: the new V3 indexer has a handler bug. Doesn't strictly block the contract upgrade, but should land before the subgraph redeploy.

### Gate 2 caveats (gaps not yet automated)

`yarn e2e` does NOT automate these defensive checks. Run them manually before the live cutover if you want full coverage:

- **Existing-task storage compatibility** — pick the most recent live task on Base Sepolia (`coordinator.nextTaskId() - 1` or earlier), snapshot the full `getTask(taskId)` struct, run the live upgrade, re-read the struct, assert byte-equal. The storage-layout pins (gate 1) PROVE slot positions are unchanged, so this is belt-and-braces — but if you're paranoid about a subtle struct-internal field reorder, this is the empirical confirmation.
- **Bytecode-diff sanity** — `keccak256(provider.getCode(deployedNewImpl))` against `keccak256(<local artifact>.deployedBytecode)` — proves what you deployed is byte-identical to the local artifact. Cosmetic-rename should produce identical bytecode; surprises here surface compile-flag drift.
- **Activity-checker pre/post snapshot** — same shape as the existing-task snapshot, applied to the activity checker's per-creator counters.

These three gaps are NOT in `yarn e2e` because they require pre/post snapshot scaffolding that the e2e was never built for. They could be added to `runBaseSepoliaForkTaskFirstFullLoop` as a follow-up; for now, run them manually if the deployment risk profile warrants it.

## Cutover ordering — contracts first, subgraph second

The contract upgrade and the subgraph redeploy must land in this order:

1. **Run the contract upgrade first** (the script above). The new `manifestDigest`-bearing impl is now live behind the existing proxy addresses. Existing tasks orphan; new tasks emit `TaskCreated` with the new digest semantic.
2. **Wait ≤ ~15 min** for the daemon-side and operator-facing dust to settle. During this window, the legacy V1/V2 subgraph indexer is still running and continues to NOT index the V3 events (which is correct — it never did).
3. **Redeploy the subgraph** with the new V3 datasources (`yarn deploy:base-sepolia`). The new datasources start indexing from a `startBlock` chosen per `subgraph/networks.json`; pick a block ≥ the contract-upgrade block so the indexer doesn't pick up pre-upgrade events under the new schema.

**Do NOT redeploy the subgraph first.** If the subgraph picks up V3 events before the contract upgrade:
- It indexes pre-upgrade events with the new schema
- `Task.manifestDigest` rows decode but contain the old `keccak256(solverType)` semantics
- Operators get confusing `manifestDigest` values that don't resolve to any launched manifest

**Do NOT skip the subgraph redeploy.** If the contracts upgrade but the subgraph doesn't:
- The legacy indexer keeps indexing V1/V2 events with the old ABI
- New V3 `TaskCreated` events go un-indexed
- Operators see empty `api.solvernets.listRegistry()` responses indefinitely

The runbook order — contract first → ~15 min → subgraph — is the only safe sequence.

### Studio dry-run (recommended before subgraph redeploy)

The new schema adds `Task`, `TaskAttempt`, `Verdict`, `SolverNetManifestEvent` entities. If Studio's existing deployed subgraph version has conflicting names, the publish fails. Test first:

```bash
cd subgraph
yarn build:base-sepolia                    # substitutes addresses + start blocks
graph deploy <studio-slug> \
  --version-label v3-pre-cutover-dry-run \
  --node https://api.studio.thegraph.com/deploy/ \
  --ipfs https://api.thegraph.com/ipfs/
# Inspect the Studio UI for schema/datasource/handler validation errors.
# Do NOT publish (don't promote the version to active).
```

If Studio rejects the publish, fix the schema/handler issue before the live cutover. Once the dry-run version uploads cleanly, you can promote on cutover day.

## Post-deploy operator dogfood

After both contract upgrade and subgraph redeploy are live, walk the operator dashboard manually to confirm the loop works end-to-end. The existing `testing-jinn-app` skill has a recipe; the launcher-specific path is:

1. **Spawn the daemon** against your bootstrapped fleet (`node dist/bin/jinn.js run --no-ui`) — see `operator/CLAUDE.md` for the contributor flow.
2. **Switch to Launcher mode** in the dashboard. The list page should be empty if you've never launched.
3. **Walk Create flow** (`/launcher/create`) for the Prediction template. Steps 1–5: define → review contract → configure generator → configure pricing → review and launch. The launch action progresses pinning → recording → broadcasting → confirming → spawning → launched.
4. **Confirm the post-launch dashboard** at `/launcher/launched/:solverNetId` shows: status badge `launched`, manifest summary (name, contract id/version, prices), generator status, recent tasks (likely empty until first poll), spend panel.
5. **Switch to Operator mode**. The Configuration page's SolverNet catalog should show the just-launched SolverNet via the registry. Click Join, walk the join flow, confirm `solverNets[<manifestCid>]` lands in `~/.jinn-client/config.json`.
6. **Wait for the first generator tick** (default cadence is 6h; for a smoke walk, edit `generatorConfig.cadenceMs` to ~60000 from the launcher dashboard). Confirm a task lands on chain (`TaskCreated` event), the operator's daemon sees it (claim eligibility filtered by `joinedSolverNets[<cid>].roles`), and the lifecycle completes (claim → submit → verdict → finalize).
7. **Pause / Resume / Retire** from the launcher dashboard. Each emits a `setMetadata` write; subgraph picks it up; operator catalog reflects the new status.

If any step diverges from expected, capture the failure (logs, screenshots, daemon state) and decide whether to roll back via the section below or fix forward.

The Playwright e2e at `operator/test/dashboard/solvernet-flow.e2e.test.ts` covers scenario 1 (happy-path Launch) automatically; the lifecycle / operator catalog / empty states / crash-recovery scenarios are filed as `jinn-mono-qwdc.37` and would automate this walk further when complete.

## Rollback

If the upgrade reveals a regression:

```bash
cd contracts
# Re-deploy the previous implementation; pass the previous bytecode hash via env
DEPLOYER_PRIVATE_KEY=<…> npx hardhat run scripts/upgrade-task-coordinator-router-v3.ts \
  --network base-sepolia
# Confirm the impl pointer reverted in the deployment JSON
```

Storage layout is identical pre/post (param-name-only Solidity rename), so a rollback is fully safe and does not require any data migration.
