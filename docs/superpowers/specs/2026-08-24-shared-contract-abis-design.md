# Shared contract ABIs — design (issue #1577)

**Version:** 0.1  
**Date:** 2026-08-24  
**Shape:** refactor  
**Status:** design note for implementation

## Problem

Jinn-owned and substrate-vendored contract ABIs are hand-copied in multiple TypeScript consumers. When `contracts/` changes, slices drift silently until runtime decode/encode failures.

## Consumer inventory (repository evidence)

Verified by import/search on base `892a10067`. **Out of scope:** legacy subtree, specs, dead copies with no importers.

| Consumer | Path | Contracts consumed | Notes |
|---|---|---|---|
| Indexer | `packages/indexer/abis/` | JinnRouterV3 events/views, TaskCoordinator `nextTaskId`, ExternalStakingDistributor, StakingProxy, IdentityRegistry | IdentityRegistry is ERC-8004 external — **not** in `contracts/` compile output; stays local |
| Operator mech | `operator/src/adapters/mech/types.ts`, `contracts.ts` | JinnRouterV3, MechMarketplace, OlasMech, claim-delivery legacy slices | Primary runtime adapter |
| Marketplace binding | `packages/marketplace/binding/src/abis/` | JinnRouterV3, JinnRouterV4, TaskCoordinator, MechMarketplace, OlasMech | Published `@jinn-network/marketplace-binding` |
| Marketplace projector | `packages/marketplace/projector/src/events.ts` | Imports binding ABIs; V4 event slices verified against artifacts today | Revised V4 slices stay projector-owned (Addendum §7.28–7.29 freeze); verified via shared full ABI + existing parity tests |
| Marketplace venue-base | imports from `@jinn-network/marketplace-binding` | — | No direct ABI copies |
| SDK | `packages/sdk/src/contracts.ts` | SolverNet schemas only | **No** Jinn router/coordinator ABI consumption |
| Broadcast-bot | `apps/broadcast-bot` | — | **No** matches for router/coordinator ABIs |

E2e/test harnesses read artifacts directly for deployment — unchanged; they already track compile output.

## Approach

Introduce **`@jinn-network/contract-abis`** (`packages/contract-abis/`):

1. **Authoritative representation:** committed, normalized full ABIs extracted from `contracts/artifacts/` after `yarn compile`.
2. **Slices:** named subsets (consumer export names preserved) defined in `slices.manifest.json` and generated as typed `as const` modules from the full ABI via deterministic `pickAbiItems`.
3. **Drift gate:** `yarn check-drift` compiles contracts, regenerates into a temp dir, and diffs against committed `generated/`. Non-zero exit on mismatch.
4. **No repo-wide workspace:** package uses Yarn `portal:` resolutions like other mono packages; not a root workspace (#1571).

### Normalization rules (deterministic)

From each Hardhat artifact, keep only the `abi` array. For each item, retain: `type`, `name`, `inputs`, `outputs`, `stateMutability`, `indexed`, `anonymous` (when true), `components`. Drop `internalType`. Recurse into tuple `components`. Sort full ABI items by `(type, name)` for stable JSON.

### Contract manifest (compile output)

| Key | Artifact path |
|---|---|
| `JinnRouterV3` | `src/staking/JinnRouterV3.sol/JinnRouterV3.json` |
| `JinnRouterV4` | `src/staking/JinnRouterV4.sol/JinnRouterV4.json` |
| `TaskCoordinator` | `src/tasks/TaskCoordinator.sol/TaskCoordinator.json` |
| `TaskCoordinatorV4` | `src/tasks/TaskCoordinatorV4.sol/TaskCoordinatorV4.json` |
| `MechMarketplace` | `src/vendor/mech/MechMarketplace.sol/MechMarketplace.json` |
| `OlasMech` | `src/vendor/mech/OlasMech.sol/OlasMech.json` |
| `ExternalStakingDistributor` | `src/vendor/stolas/ExternalStakingDistributor.sol/ExternalStakingDistributor.json` |
| `StakingTokenLocked` | `src/vendor/stolas/l2/StakingTokenLocked.sol/StakingTokenLocked.json` |

### Migration strategy (strangler)

1. Land package + generator + drift check (green alone).
2. Migrate indexer `abis/` (except IdentityRegistry) to re-export shared slices.
3. Migrate marketplace-binding `src/abis/` to re-export shared slices; keep export surface in `index.ts`.
4. Migrate operator mech types to import shared slices; preserve exported constant names.
5. Projector continues importing binding; parity tests remain, now backed by shared full ABIs.

Public exports (`JINN_ROUTER_V3_ABI`, `TASK_COORDINATOR_ABI`, etc.) keep the same names; binding `index.ts` re-exports unchanged.

## Non-goals

- Root Yarn workspace (#1571).
- Migrating IdentityRegistry (not compiled in `contracts/`).
- Migrating projector V4 frozen event fixtures (separate contract generation; still artifact-checked).
- Operator earning OLAS/staking ABIs (different surface; not duplicated across listed consumers).

## Verification

- `cd contracts && yarn test`
- `cd packages/contract-abis && yarn test && yarn check-drift`
- `cd packages/indexer && yarn test`
- `cd packages/marketplace/binding && yarn test`
- `cd packages/marketplace/projector && yarn test`
- `cd operator && yarn test test/adapters/mech/ test/hermetic/abi-selector-conformance.test.ts`

## Risks

- **Slice order:** consumers rely on declaration order for some tests; slices manifest preserves explicit item order (not artifact sort order).
- **Indexer createTask policy:** migrating from artifact fixes stale policy tuple relative to tokenless V3 — intentional drift correction.
- **Package publish:** new `@jinn-network/contract-abis` must be added to operator bundle list before release cut.
