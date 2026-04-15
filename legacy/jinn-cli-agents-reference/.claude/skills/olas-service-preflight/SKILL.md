---
name: olas-service-preflight
description: Check the state of OLAS services before provisioning — verify wallet balances (OLAS + ETH), staking slot availability, and existing service health. Use before adding new services or troubleshooting funding issues.
allowed-tools: Bash, Read, Glob, Grep
user-invocable: true
---

# OLAS Service Preflight Check

> Verify wallet balances, staking capacity, and service health before provisioning.

## When to Use

- Before running `yarn service:add` to provision new services
- When troubleshooting "insufficient balance" or "gas too low" errors
- To get a quick overview of fleet funding state
- Before batch provisioning to calculate max capacity

---

## Preflight Procedure

### 1. Locate Wallet Addresses

The operate profile stores wallet info at `.operate/wallets/ethereum.json`:

```bash
# From jinn-node directory (or wherever .operate/ lives)
python3 -c "
import json
with open('.operate/wallets/ethereum.json') as f:
    w = json.load(f)
print(f'Master EOA:  {w[\"address\"]}')
print(f'Master Safe: {w[\"safes\"][\"base\"]}')
"
```

### 2. Check OLAS Balance (Master Safe)

Each new service requires **10,000 OLAS** (5k security deposit + 5k agent bond).

```bash
# Using cast (foundry)
cast call 0x54330d28ca3357F294334BDC454a032e7f353416 \
  "balanceOf(address)(uint256)" <MASTER_SAFE_ADDRESS> \
  --rpc-url "$RPC_URL" | cast from-wei

# Using RPC directly
curl -s -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x54330d28ca3357F294334BDC454a032e7f353416","data":"0x70a08231000000000000000000000000<SAFE_ADDRESS_NO_0x>"},"latest"],"id":1}' \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(f'{int(r[\"result\"],16)/1e18:.2f} OLAS')"
```

**Budget:** `available_olas / 10,000 = max_new_services`

### 3. Check ETH Balance (Master EOA)

The Master EOA submits all on-chain transactions. Needs **~0.01 ETH per service** for:
- `createService` on ServiceManagerToken
- `activateRegistration` (5k OLAS approval + deposit)
- `registerAgents` (5k OLAS approval + bond)
- Safe deployment
- `stake` on staking contract

```bash
cast balance <MASTER_EOA_ADDRESS> --rpc-url "$RPC_URL" -e

# Or via RPC
curl -s -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["<MASTER_EOA_ADDRESS>","latest"],"id":1}' \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(f'{int(r[\"result\"],16)/1e18:.6f} ETH')"
```

**Minimum:** 0.01 ETH per service being provisioned.

### 4. Check Staking Slot Availability

```bash
# Query current staked services count
cast call <STAKING_CONTRACT> "getServiceIds()(uint256[])" --rpc-url "$RPC_URL"

# Check max slots (if ABI available)
cast call <STAKING_CONTRACT> "maxNumServices()(uint256)" --rpc-url "$RPC_URL"
```

### 5. Check Existing Service Health

```bash
# Full dashboard
yarn service:status

# JSON for automation
yarn service:fleet
```

---

## Summary Checklist

| Check | Minimum | Command |
|-------|---------|---------|
| Master Safe OLAS | 10,000 per new service | `cast call <OLAS> "balanceOf(address)(uint256)" <SAFE>` |
| Master EOA ETH | ~0.01 per new service | `cast balance <EOA>` |
| Staking slots | At least 1 free | `cast call <STAKING> "getServiceIds()(uint256[])"` |
| Existing services healthy | No evictions | `yarn service:status` |

## Key Addresses

| Asset | Address (Base) |
|-------|---------------|
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |
| Jinn Staking (current) | `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139` |
| Jinn Staking v2 | `0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488` |

## Gotchas

- **Master EOA vs Master Safe**: The EOA signs transactions but OLAS lives in the Safe. Both need funding.
- **Middleware creates config before checking balance**: If OLAS is insufficient, you get a stale config in `.operate/services/` that needs manual cleanup or will be cleaned by `cleanupUndeployedConfigs`.
- **Gas estimation can fail silently**: The middleware error "intrinsic gas too low: gas 0" means the EOA has insufficient ETH, not a gas limit issue.
