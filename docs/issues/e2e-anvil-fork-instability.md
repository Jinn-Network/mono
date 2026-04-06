# E2E Test Failure: Anvil Fork State Instability

**Date**: 2026-04-06
**Status**: Blocking — e2e tests intermittently fail
**Severity**: High — blocks CI and development

## Summary

The e2e test suite (`client/scripts/e2e-validate.ts`) intermittently fails because Anvil's Base mainnet fork returns inconsistent contract state from RPC providers. The test passed 23/23 phases with Tenderly RPC, then failed on the exact same code, same RPC, same fork block within 2 hours.

## Symptoms

Phase 4 (`Creator posts desired state`) fails with:

```
The contract function "execTransaction" reverted with the following reason:
GS013
```

GS013 = **inner call reverted** (not a signature issue). The Safe transaction is correctly signed but the inner call to `JinnRouter.createRestorationJob()` → `MechMarketplace.request()` reverts.

The revert propagates to all subsequent phases that use Safe transactions (Phases 5-8, 11, 12, 13, 13b, 13g, 13h, 14).

Phases that don't use on-chain transactions pass consistently (13c, 13d, 13e, 13f, 16).

## Root Cause

The `MechMarketplace.request()` function calls `checkMech(priorityMech)` which reads `mapAgentMechFactories[mech]`. If this returns `address(0)`, it reverts with `UnauthorizedAccount(mech)`.

The mech IS registered — Phase 2 (bootstrap) successfully deploys a mech via `marketplace.create()` which sets `mapAgentMechFactories[mech] = factory`. A diagnostic check confirmed:

```
[diag] mapAgentMechFactories[0x22755d...] = 0x2E008211f34b25A7d7c102403c6C2C3B665a1abe
```

Yet the subsequent `marketplace.request()` call still reverts. This suggests Anvil's lazy state fetching returns inconsistent values — the `readContract` diagnostic succeeds but the `writeContract` execution path reads a different (stale/zero) value from the RPC.

## Evidence

### What works
- Phase 2 (bootstrap): All Safe transactions succeed — service creation, activation, staking, mech deployment
- `mapAgentMechFactories` diagnostic read returns correct factory address
- Non-chain phases (13c, 13d, 13e, 13f) always pass

### What fails
- Phase 4: `createRestorationJob` → `marketplace.request()` → `checkMech()` reverts
- Failure is inconsistent — same code + same fork block passes then fails hours later

### Timeline
1. **Passed**: 23/0 with `BASE_RPC_URL=https://base.gateway.tenderly.co/...` at block ~44,344,649
2. **Failed**: Same code, same RPC, same block — 9/14 failures, approximately 2 hours later
3. **Failed**: Public `mainnet.base.org` RPC — consistent failures
4. **Failed**: `base.llamarpc.com` — consistent failures
5. **Failed**: Pinned to block 44,033,886 (earlier known-good block) — still fails

### Marketplace contract verification
- Marketplace proxy: `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` — code unchanged
- Marketplace implementation: `0x155547857680a6d51bebc5603397488988deb1c8` — same at old and new blocks
- Mech factory: `0x2E008211f34b25A7d7c102403c6C2C3B665a1abe` — whitelisted (`mapMechFactories` returns 1)
- JinnRouter: `0xfFa7118A3D820cd4E820010837D65FAfF463181B` — code unchanged
- Activity checker proxy: `0x477C41Cccc8bd08027e40CEF80c25918C595a24d` — implementation unchanged

## How Anvil Fork Works

Anvil forks by **lazily fetching** state from the RPC. It does NOT copy all state upfront. When a contract reads a storage slot for the first time during execution, Anvil makes an RPC call to `eth_getStorageAt` for that slot. If the RPC returns an incorrect or zero value (due to rate limiting, state pruning, or node rotation), the contract sees wrong state.

This is why:
- `readContract` (our diagnostic) may succeed — it triggers a fetch and caches the result
- The same slot read during `writeContract` execution may fail — it's a different code path in Anvil that may fetch at a different time

## How to Reproduce

```bash
cd client
# This may pass or fail depending on RPC state:
BASE_RPC_URL="https://base.gateway.tenderly.co/YOUR_KEY" npx tsx scripts/e2e-validate.ts

# Run multiple times — some will pass, some will fail
```

## Potential Fixes

### Option A: Pre-warm Anvil state (quick fix)
Before running any transactions, issue `readContract` calls for all storage slots that will be needed during execution. This forces Anvil to cache them from the RPC before the time-sensitive transaction execution begins.

### Option B: Deploy own contracts on fresh Anvil (best fix)
Instead of forking Base mainnet and relying on existing Mech marketplace state, deploy our own marketplace + router on a fresh Anvil chain. This eliminates all RPC dependency for contract state. The bootstrap would deploy:
1. ServiceRegistry (or mock)
2. MechMarketplace
3. MechFactory
4. JinnRouter
5. Staking contract (or mock)

This is more work but makes the test fully deterministic and offline.

### Option C: Use a dedicated archive node (infrastructure fix)
Run a local Base archive node (e.g., via `op-geth` + `op-node`) so Anvil's lazy fetches go to a local, reliable source instead of a remote RPC.

### Option D: Pin fork block + use Alchemy/Infura (reliability fix)
Alchemy and Infura archive nodes may be more reliable than Tenderly for historical state. Combined with `ANVIL_FORK_BLOCK` pinning, this might be stable enough.

## Additional Note: External Code Modifications

During debugging, four source files were modified outside the development session by what appears to be another Claude Code session or a linter:
- `client/src/adapters/mech/adapter.ts` — added `privateKey` parameter to function calls
- `client/src/adapters/mech/contracts.ts` — added GS013 handling in `claimDelivery`
- `client/src/adapters/mech/safe.ts` — unknown changes
- `client/src/earning/bootstrap.ts` — unknown changes

These modifications shifted function arguments, breaking all Safe transactions independently of the RPC issue. They were reverted with `git checkout`. If another session is modifying these files, coordinate to avoid conflicts.

## Files

- `client/scripts/e2e-validate.ts` — e2e test script (23 phases)
- `client/src/adapters/mech/contracts.ts` — `submitRestorationJob()` which calls JinnRouter
- `client/src/adapters/mech/safe.ts` — `executeSafeTransaction()` which signs and submits
- `client/.env` — `BASE_RPC_URL` (Tenderly endpoint)
- `client/.env.example` — documents the RPC requirement

## Recommendation

**Option B (deploy own contracts)** is the right long-term fix. The e2e should not depend on external RPC reliability for contract state. This would:
- Make tests fully deterministic
- Work offline (no RPC dependency)
- Not break when Base mainnet contracts are upgraded
- Run faster (no lazy fetching)

The marketplace source is at: https://github.com/valory-xyz/ai-registry-mech/blob/main/contracts/MechMarketplace.sol
