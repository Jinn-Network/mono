---
title: Mainnet Staking Deployment Guide
purpose: runbook
scope: [deployment]
last_verified: 2026-01-30
related_code:
  - olas-operate-middleware/.operate/services
keywords: [staking, olas, mainnet, base, deployment, agentsfun1, mech]
when_to_read: "When deploying a staked OLAS service on Base mainnet or configuring staking options"
---

# Mainnet Staking Deployment Guide (JINN-186)

## Quick Start

Deploy a staked OLAS service on Base mainnet:

```bash
# 1. Ensure environment is configured
export OPERATE_PASSWORD="your-password"
export BASE_LEDGER_RPC="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"

# 2. Run deployment
yarn setup:service --chain=base

# That's it! Staking is enabled by default (JINN-204)
```

## What Happens

The middleware will:

1. **Create/Detect Master EOA** - Your wallet for signing transactions
2. **Create/Detect Master Safe** - Your master multisig wallet
3. **Create Agent Key** - Will prompt for ~0.001 ETH to fund it
4. **Deploy Service Safe** - Will prompt for ~0.001 ETH + 50 OLAS
5. **Stake Service** - Automatically stakes in AgentsFun1 contract
6. **Start Service** - Begins running the service

**Total Cost:**
- ~0.002 ETH for gas
- ~50 OLAS for staking deposit (refundable when unstaking)

## Funding Requirements

### Master Safe Must Have

Before running, ensure your Master Safe has:
- **ETH**: ~0.005 ETH for gas (creating Service Safe + transactions)
- **OLAS**: ~50 OLAS for staking deposit

**Master Safe Address**: Check `.operate/services/<latest>/config.json` or previous deployment logs.

### Middleware Will Prompt For

During deployment, you'll see prompts like:

```
[base] Please transfer at least 0.001 ETH to Agent EOA 0xABC...123
```

The middleware **auto-detects** when funds arrive and continues automatically.

## Staking Configuration

### Default (AgentsFun1)

Staking is **enabled by default** using the AgentsFun1 contract:

```bash
yarn setup:service --chain=base
```

**Contract:** `0x2585e63df7BD9De8e058884D496658a030b5c6ce`

### Jinn Staking (v2)

For Jinn operators, use the Jinn v2 staking contract:

```bash
yarn setup:service --chain=base --staking-contract=0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488
```

**Contract:** `0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488` (5,000 OLAS min, DeliveryActivityChecker)

### Custom Staking Contract

```bash
yarn setup:service --chain=base --staking-contract=0xYourContractAddress
```

### Disable Staking

```bash
yarn setup:service --chain=base --no-staking
```

## With Mech Deployment

Deploy with both staking + mech marketplace registration:

```bash
yarn setup:service --chain=base --with-mech
```

**Mech Contract:** `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` (Base mainnet)

## Verification

### Check Service State

```bash
# View service config
cat olas-operate-middleware/.operate/services/<latest>/config.json

# Look for:
# - "token": <service_id>
# - "chain_data.token": <on-chain_service_id>
```

### Verify On-Chain Staking

Use Tenderly or Etherscan to check:

```typescript
// AgentsFun1 Staking Contract: 0x2585e63df7BD9De8e058884D496658a030b5c6ce

// Check if service is staked:
getServiceIds() // Should include your service ID
getStakingState(serviceId) // 1 = Staked
```

### Check Logs

```bash
# Middleware logs show staking confirmation:
grep "Staking service" olas-operate-middleware/.operate/services/<latest>/logs/*

# Look for:
# [INFO] Staking service: 161
# [INFO] current_staking_program='agents_fun_1'
```

## Attended Mode Behavior

The middleware runs in **attended mode** by default, meaning:

1. **Environment variables are ignored** for staking settings
2. **You'll be prompted** to select staking program
3. **You'll manually enter** the staking contract address

This is expected behavior. The prompts look like:

```
------------------------------------------------
| Please, select your staking program preference 
------------------------------------------------

1) No staking
2) Custom Staking contract

Enter your choice (1 - 2): 2
Selected staking program: Custom Staking contract
Enter the staking contract address: 0x2585e63df7BD9De8e058884D496658a030b5c6ce
```

**Pro tip:** Copy-paste `0x2585e63df7BD9De8e058884D496658a030b5c6ce` when prompted.

## Safety Features

### Mainnet Banner

When deploying to mainnet, you'll see:

```
╔════════════════════════════════════════════════════════════╗
║              🌐 MAINNET DEPLOYMENT MODE                   ║
╚════════════════════════════════════════════════════════════╝

🌍 Network: BASE
💰 Real funds will be used
🔒 Staking: ENABLED (AgentsFun1)
   Contract: 0x2585e63df7BD9De8e058884D496658a030b5c6ce
   Required: ~50 OLAS for staking deposit
```

### Tenderly Testing (Cost-Free)

Test the exact same flow cost-free:

```bash
# 1. Create Tenderly VNet
yarn tsx scripts/setup-tenderly-vnet.ts

# 2. Update env.tenderly with the generated values
# (script outputs the exact values to copy)

# 3. Run with Tenderly
source env.tenderly  # or export $(cat env.tenderly | xargs)
yarn setup:service --chain=base --with-mech
```

See [AGENTS.md](../../AGENTS.md) for testing context.

## Troubleshooting

### "Operation failed after multiple attempts"

Use the CLI-based flow (already default in JINN-202): `yarn service:add --unattended`.

### "Insufficient OLAS balance"

Ensure Master Safe has at least 50 OLAS for staking deposit.

```bash
# Check balance on BaseScan:
# https://basescan.org/address/<master_safe_address>
```

### Staking Not Happening

Check logs for:
- `use_staking=True`
- `staking_program_id='agents_fun_1'` or `'0x2585e63df7BD9De8e058884D496658a030b5c6ce'`

If you see `use_staking=False` or `staking_program_id='no_staking'`, the config was overridden.

### Service ID Not Found

Service IDs are assigned during minting. Check:

```json
// config.json
{
  "chain_configs": {
    "base": {
      "chain_data": {
        "token": 161  // <-- This is your service ID
      }
    }
  }
}
```

## Previous Successful Deployments

✅ **Service #149**: `0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645` (DEPLOYED_AND_STAKED)  
✅ **Service #150**: `0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9` (DEPLOYED_AND_STAKED)  

Both deployed using the same flow you're running now.

## Next Steps After Deployment

1. **Verify Staking**: Check on-chain that service is in staking contract
2. **Monitor Service**: Service should start running automatically
3. **Wait for Checkpoint**: First rewards after ~24 hours (checkpoint interval)
4. **Claim Rewards**: Use worker's reward claiming (future JINN issue)

## Related Documentation

- `docs/context/olas-integration.md` - OLAS integration architecture
- `docs/reference/olas-contracts.md` - Contract addresses and config
- `docs/runbooks/deploy-olas-service.md` - Full deployment tutorial

