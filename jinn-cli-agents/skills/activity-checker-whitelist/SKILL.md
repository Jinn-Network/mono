---
name: activity-checker-whitelist
description: Manage the Jinn staking activity checker mech whitelist. Add, remove, list, or check whitelisted mech addresses. Use when a new service stakes on the Jinn contract and its mech needs whitelisting, or when auditing which mechs are currently approved.
allowed-tools: Bash, Read, Glob, Grep
user-invocable: false
emoji: null
---

# Activity Checker Whitelist Management

Manages the mech whitelist on the Jinn staking activity checker contract. The activity checker gates which mechs count toward staking liveness — mechs not on the whitelist won't earn rewards.

## Contract Addresses

| Contract | Address |
|----------|---------|
| Jinn Staking | `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139` |
| Activity Checker | `0x1dF0be586a7273a24C7b991e37FE4C0b1C622A9B` |
| Operate Safe (owner) | `0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645` |
| Marketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |

## Script

All operations use `scripts/activity-checker-whitelist.ts`.

### Prerequisites

- `RPC_URL` or `BASE_RPC_URL` env var (Tenderly — **never** use public RPCs for writes)
- `OPERATE_PASSWORD` env var (for add/remove — decrypts master EOA from `.operate` keystore)
- Root `.env` has both; source it before running

### Commands

```bash
# List whitelist status for all mechs that have ever staked
source .env && tsx scripts/activity-checker-whitelist.ts list

# Check a single address
source .env && tsx scripts/activity-checker-whitelist.ts check 0x1234...

# Add specific addresses
source .env && tsx scripts/activity-checker-whitelist.ts add 0x1234... 0x5678...

# Auto-discover all staked mechs and add any missing
source .env && tsx scripts/activity-checker-whitelist.ts add --from-staking

# Dry run (no transactions sent)
source .env && DRY_RUN=true tsx scripts/activity-checker-whitelist.ts add --from-staking

# Remove an address
source .env && tsx scripts/activity-checker-whitelist.ts remove 0x1234...
```

## How It Works

1. **Discovery**: Scans `ServiceStaked` events on the Jinn staking contract to find all mechs that have ever staked. The mech address is in `topics[3]` (indexed).
2. **Whitelist check**: Calls `isWhitelisted(address)` on the activity checker for each mech.
3. **Add/Remove**: Builds `addToWhitelist(address)` / `removeFromWhitelist(address)` calldata, wraps it in a Safe `execTransaction` via the Operate Safe (threshold=1, signed by master EOA with eth_sign format, v+4 adjustment).
4. **Verification**: After each TX, waits 3s then re-checks via public RPC to confirm.

## When to Use

- After a **new service stakes** on the Jinn contract — its mech needs whitelisting
- After a **service migration** (unstake/restake) — the new mech address may differ
- To **audit** which mechs are currently whitelisted vs staked
- To **remove** a decommissioned mech from the whitelist

## Gotchas

- The activity checker also has 2 **hardcoded** (pure) whitelisted addresses baked into bytecode: `0x8c083dfe9bee719a05ba3c75a9b16be4ba52c299` and `0xb55fadf1f0bb1de99c13301397c7b67fde44f6b1`. These cannot be removed via `removeFromWhitelist`.
- The Tenderly RPC can have **stale cache** for nonce reads. The script uses public RPC for nonce/verification to avoid this.
- `addToWhitelist` reverts with `AlreadyWhitelisted(address)` if the address is already added — the script skips these.
- The mech address in `ServiceStaked` events is the **AgentMech proxy** created during service deployment, NOT the factory-created marketplace mech from `CreateMech` events. These are different addresses.
- Safe `execTransaction` with `gasPrice=0` and `safeTxGas=0` uses `gasleft()` for the inner call, which works fine for simple calls like `addToWhitelist`.
