---
title: OLAS Contracts Reference
purpose: reference
scope: [deployment]
last_verified: 2026-01-30
related_code:
  - olas-operate-middleware/
  - worker/OlasStakingManager.ts
keywords: [olas, contracts, staking, mech marketplace, base, addresses]
when_to_read: "When looking up OLAS contract addresses or staking configuration"
---

# OLAS Contracts Reference

Contract addresses and configuration for OLAS integration on Base mainnet.

## Contract Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| Service Registry | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |
| Service Registry Token Util | `0x3d77596beb0f130a4415df3D2D8232B3d3D31e44` |
| AgentsFun1 Staking | `0x2585e63df7BD9De8e058884D496658a030b5c6ce` |
| Mech Marketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| Balance Tracker | `0xB3921F8D8215603f0Bd521341Ac45eA8f2d274c1` |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |
| Mech Factory (Native) | `0x2E008211f34b25A7d7c102403c6C2C3B665a1abe` |
| Mech Factory (Token) | `0x97371B1C0cDA1D04dFc43DFb50a04645b7Bc9BEe` |
| Mech Factory (Nevermined) | `0x847bBE8b474e0820215f818858e23F5f5591855A` |

## MechMarketplace Contract Methods

### Read Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `mapRequestIdInfos` | `(bytes32) -> (address priorityMech, address deliveryMech, address requester, uint256 responseTimeout, uint256 deliveryRate, bytes32 paymentType)` | Returns request metadata by ID |
| `getRequestStatus` | `(bytes32 requestId) -> uint8` | Returns request status enum |
| `getRequestId` | `(address mech, address requester, bytes data, uint256 deliveryRate, bytes32 paymentType, uint256 nonce) -> bytes32` | Computes request ID |
| `mapNonces` | `(address) -> uint256` | Returns current nonce for requester |

### Write Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `request` | `(bytes requestData, uint256 maxDeliveryRate, bytes32 paymentType, address priorityMech, uint256 responseTimeout, bytes paymentData) payable -> bytes32` | Posts a job request |
| `deliverMarketplace` | `(bytes32[] requestIds, uint256[] deliveryRates) -> bool[]` | Delivers responses |

### Events

| Event | Fields |
|-------|--------|
| `MarketplaceRequest` | `priorityMech (indexed), requester (indexed), numRequests, requestIds[], requestDatas[]` |
| `MarketplaceDelivery` | `deliveryMech (indexed), requesters[], numDeliveries, requestIds[], deliveredRequests[]` |
| `Deliver` (OlasMech) | `mech (indexed), mechServiceMultisig (indexed), requestId, deliveryRate, requestData, deliveryData` |

## Staking Programs

| Program | Total Required | Bond | Stake | Contract |
|---------|---------------|------|-------|----------|
| agents_fun_1 | **100 OLAS** | 50 OLAS | 50 OLAS | `0x2585e63df7BD9De8e058884D496658a030b5c6ce` |

Staking requires **two equal parts**:
1. **Bond Amount** - Security deposit in service contract
2. **Staking Amount** - Deposit in staking contract

## Environment Variables

### Required

```bash
OPERATE_PASSWORD=<password>         # Wallet encryption
<CHAIN>_LEDGER_RPC=<rpc_url>       # e.g., BASE_LEDGER_RPC
```

### Mode Selection

```bash
ATTENDED=true|false                 # Interactive vs automation
```

### Staking

```bash
STAKING_PROGRAM=<program>           # "no_staking" or "custom_staking"
CUSTOM_STAKING_ADDRESS=<address>    # If using custom_staking
```

### Tenderly Testing

```bash
TENDERLY_ACCESS_KEY=<key>
TENDERLY_ACCOUNT_SLUG=<account>
TENDERLY_PROJECT_SLUG=<project>
TENDERLY_ENABLED=true
```

## Commands Reference

### Service Management

```bash
# Interactive service setup
yarn setup:service --chain=base
yarn setup:service --chain=base --with-mech

# Check existing services
ls -la olas-operate-middleware/.operate/services/

# Check service status
cd olas-operate-middleware && poetry run operate service status
```

### Wallet & Key Management

```bash
# List all agent keys
ls -la olas-operate-middleware/.operate/keys/

# View agent key
cat olas-operate-middleware/.operate/keys/AGENT_ADDRESS

# Find which services use which Safes
for dir in olas-operate-middleware/.operate/services/sc-*/; do
  safe=$(jq -r '.chain_configs.base.chain_data.multisig // "none"' "$dir/config.json" 2>/dev/null)
  echo "$(basename $dir): safe=$safe"
done
```

### Fund Recovery

```bash
# Check agent balances
yarn tsx scripts/check-agent-balances.ts

# Recover from agent EOAs
yarn tsx scripts/recover-stranded-olas.ts

# Recover from Service Safe
yarn tsx scripts/recover-from-service-safe.ts
```

## Service Configuration Template

```json
{
  "name": "service-name",
  "hash": "bafybeihnzvqexxegm6auq7vcpb6prybd2xcz5glbvhos2lmmuazqt75nuq",
  "home_chain": "base",
  "configurations": {
    "base": {
      "agent_id": 14,
      "fund_requirements": {
        "0x0000000000000000000000000000000000000000": {
          "agent": 100000000000000000,
          "safe": 50000000000000000
        }
      }
    }
  }
}
```

**Configuration rules**:
- `home_chain`: Must be lowercase (`base`, not `Base`)
- `hash`: Must be a real IPFS hash (fake hashes cause ReadTimeout)
- `fund_requirements`: Must be integers, not strings

## Master Safe (Base Mainnet)

**Address**: `0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645`

- [View on BaseScan](https://basescan.org/address/0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645)
- [View on Safe UI](https://app.safe.global/home?safe=base:0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645)
