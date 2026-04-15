# stOLAS Bootstrap Integration

**Date**: 2026-04-09
**Author**: adrianobradley + Claude
**Status**: Draft

## Summary

Integrate the stOLAS (ExternalStakingDistributor) flow into the client's `EarningBootstrapper` as the default `standard` staking mode. Operators only need to fund a single wallet with ETH — no OLAS required. The existing OLAS-based flow is preserved as `self-bond` mode.

## Background

The Jinn staking contract (`0x51c5f...`) is now whitelisted on the stOLAS ExternalStakingDistributor (`0x40abf47B926181148000DbCC7c8DE76A3a61a66f`). This distributor allows operators to stake without providing OLAS — LemonTree depositors fund the capital. A single `distributor.stake()` call atomically creates the service, deploys a Safe, funds the bond, and stakes the service.

The jinn-node codebase (`legacy/jinn-cli-agents-reference/jinn-node/src/worker/stolas/StolasServiceBootstrap.ts`) already implements this flow using a Master Safe hierarchy. This design adapts it for our client's simpler agent-EOA-owns-Safe model.

## Design

### Staking Modes

- **`standard`** (default): stOLAS flow. Agent EOA calls `distributor.stake()` directly. Only ETH needed for gas (~0.005 ETH).
- **`self-bond`**: Current flow. Operator provides OLAS for bond + security deposit. Full 11-step state machine.

### Config Changes

New field in `EarningBootstrapperOptions`:

```typescript
stakingMode?: 'standard' | 'self-bond'; // defaults to 'standard'
```

New field in `EarningState`:

```typescript
staking_mode: 'standard' | 'self-bond';
```

Recorded at bootstrap start. Used on re-runs for idempotency.

### New Constants (contracts.ts)

```typescript
const STOLAS_DISTRIBUTOR = '0x40abf47B926181148000DbCC7c8DE76A3a61a66f';

const STOLAS_DISTRIBUTOR_ABI = [
  // Check if staking proxy is configured
  'function mapStakingProxyConfigs(address) view returns (uint256)',
  // Atomically create service + Safe + bond + stake
  'function stake(address stakingProxy, uint256 serviceId, uint256 agentId, bytes32 configHash, address agentInstance) external',
];
```

### Standard Mode Step Progression

| Step | Action |
|------|--------|
| `wallet` | Create agent EOA + keystore (unchanged) |
| `safe_predicted` | **Skipped** — distributor creates the Safe |
| `awaiting_funding` | Check agent EOA has ~0.005 ETH (ETH only, no OLAS, no Safe) |
| `safe_deployed` through `service_staked` | **All collapsed** into `stepStolasStake()` |
| `mech_deployed` | Deploy mech via the new Safe (unchanged) |
| `complete` | Done |

### stepStolasStake()

This is the core new step handler. It:

1. **Preflight**: Calls `distributor.mapStakingProxyConfigs(stakingContract)` to verify the distributor is configured. Calls `staking.getServiceIds()` and `staking.maxNumServices()` to verify slots are available.
2. **Stake**: The agent EOA calls `distributor.stake(stakingContract, 0, agentId, configHash, agentEOA)` as a contract call (encode calldata + `signer.sendTransaction()`). `serviceId=0` tells the distributor to create a new service.
3. **Parse events**: Extracts `CreateService` (for `serviceId`) and `CreateMultisigWithAgents` (for `safe_address`) from the tx receipt.
4. **Update state**: Patches `service_id`, `safe_address`, `staking_address`, and advances step to `mech_deployed`.

### State Machine Routing

`runStep()` branches on `staking_mode`:

- **Identical in both modes**: `wallet`, `mech_deployed`, `complete`
- **`safe_predicted`**: `standard` skips to `awaiting_funding`; `self-bond` predicts Safe as today
- **`awaiting_funding`**: `standard` checks ETH only on agent EOA; `self-bond` checks ETH + OLAS on EOA + Safe
- **`safe_deployed` through `service_staked`**: `standard` routes all to `stepStolasStake()`; `self-bond` runs existing handlers

### Reconciliation

`refreshServiceProgressState()` works unchanged — it reads on-chain state and fast-forwards. If a crash occurs between `stake()` succeeding and state being written, re-run detects the service exists on-chain and reconciles.

### Mech Deployment

The Safe created by the distributor has the agent EOA as its sole owner. `getSafe()` works as today — `initDeployedSafe()` with the agent's private key.

### Error Handling

- **Preflight failure** (distributor not configured, no slots): Returns `EarningBootstrapResult` with `ok: false` and actionable message.
- **stake() reverts**: Stay at current step. Safe to retry — no state mutated.
- **Event parsing failure**: Throw with tx hash for operator to check basescan.
- **FundingRequirement**: In `standard` mode, OLAS fields show 0/0 since they're irrelevant.

### Testing

- Unit tests for `standard` mode branching: skip Safe prediction, ETH-only funding check, `stepStolasStake()` routing.
- Existing `reconcilePredictedSafeState` and `reconcileServiceProgressState` tests unchanged.
- Existing 33 tests pass untouched (`self-bond` is the current flow with zero changes).
- E2e on Anvil fork stays `self-bond` for now (distributor is a third-party contract). Standard mode e2e deferred to testnet distributor availability.

### Scope Boundaries

This does NOT include:

- Master Safe / fleet management pattern
- Changes to daemon loops (creator, restorer, delivery-watcher)
- Changes to mech adapter or IPFS layer
- Config file schema gets `stakingMode` but defaults to `standard` so existing configs work without changes
