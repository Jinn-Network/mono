---
title: OLAS Fund Recovery Guide
purpose: runbook
scope: [deployment]
last_verified: 2026-01-30
related_code:
  - scripts/recover-stranded-olas.ts
  - scripts/check-agent-balances.ts
  - scripts/check-all-safes-comprehensive.ts
  - olas-operate-middleware/.operate/keys
keywords: [olas, recovery, funds, safe, eoa, agent, stranded, tokens]
when_to_read: "When recovering stranded OLAS or ETH from agent EOAs or Service Safes after failed deployments"
---

# OLAS Fund Recovery Guide

**Complete guide for recovering OLAS and ETH from agent EOAs and Service Safes**

Last Updated: October 2, 2025

---

## Overview

When service deployments fail or services are terminated, OLAS tokens and ETH can become stranded in two places:

1. **Agent EOAs** - Direct wallet addresses (simple recovery)
2. **Service Safes** - Gnosis Safe multisig contracts (requires Safe SDK)

This guide covers both recovery methods.

---

## Recovery Summary (Oct 2, 2025)

**Total Recovered: 150 OLAS**

| Source | Amount | Method | Transaction |
|--------|--------|--------|-------------|
| Agent EOA #1 | 50 OLAS | Direct transfer | `0x8619498cea0f2b6261ec5bf14f631027d09c17ca232544d1f02a1c2631731419` |
| default-service Safe | 50 OLAS | Safe SDK | `0x044eed37f991f2cfdf828d0e8de25461c79f6c14276ea39fe1798739c78e970e` |
| Agent EOA #2 (default-service) | 50 OLAS | Direct transfer | `0xe918c1d597dafeb2666dc0a53a7a526b52b934a54c0b9726d0c97458e00e470f` |

**Final Master Safe Balance: 115.32 OLAS**

---

## Part 1: Identifying Recoverable Funds

### Step 1: Check All Agent Keys

```bash
yarn tsx scripts/check-agent-balances.ts
```

This scans all agent keys in `olas-operate-middleware/.operate/keys/` and reports OLAS balances.

**Example Output:**
```
✅ 0x52c25D37D9765BC0799CCdf69AdD2d83bCa3012e
   OLAS: 50.0, ETH: 0.0005
```

### Step 2: Check All Service Safes

```bash
BASE_LEDGER_RPC="https://quick-sly-needle.base-mainnet.quiknode.pro/..." \
  yarn tsx scripts/check-all-safes-comprehensive.ts
```

This checks:
- Current services in `olas-operate-middleware/.operate/services/`
- Backed up services in `service-backups/`
- Both Safe and agent EOA balances

**Example Output:**
```
📦 default-service
   Safe: 0xa70Ea55b009fB50AFae9136049bB1EB52880691e
   Agent: 0x879f73A2F355BD1d1bB299D21d9B621Ce6C4c285
   Safe OLAS: 50.0
   Agent OLAS: 50.0
```

---

## Part 2: Recovery Methods

### Method A: Recovering from Agent EOAs

**When to use:** Agent key has OLAS in its direct wallet address (not in Safe)

**Requirements:**
- Agent private key (from `/.operate/keys/AGENT_ADDRESS`)
- Sufficient ETH in agent wallet for gas (~0.0001 ETH)

**Steps:**

1. **Edit recovery script** with agent details:
   ```typescript
   // scripts/recover-stranded-olas.ts
   const AGENTS = [
     {
       address: '0xAGENT_ADDRESS',
       privateKey: '0xPRIVATE_KEY',
     },
   ];
   ```

2. **Run recovery:**
   ```bash
   yarn tsx scripts/recover-stranded-olas.ts
   ```

3. **Verify:**
   ```bash
   yarn tsx scripts/check-master-safe-balance.ts
   ```

**Script Flow:**
- Checks OLAS balance in agent EOA
- Checks ETH balance for gas
- Estimates gas cost
- Transfers OLAS to Master Safe
- Returns transaction hash

**Success Example:**
```
✅ Success! Recovered 50.0 OLAS
📝 Tx Hash: 0x8619498cea0f2b6261ec5bf14f631027d09c17ca232544d1f02a1c2631731419
```

---

### Method B: Recovering from Service Safes (Safe SDK)

**When to use:** OLAS is locked in a Gnosis Safe (Service Safe)

**Requirements:**
- Agent private key (the Safe owner/signer)
- Safe SDK installed (`@safe-global/protocol-kit`)
- RPC provider (QuickNode recommended to avoid rate limits)

**Steps:**

1. **Identify the Safe and agent:**
   ```bash
   # From service config
   jq -r '.chain_configs.base.chain_data.multisig, .agent_addresses[0]' \
     olas-operate-middleware/.operate/services/SERVICE_ID/config.json
   ```

2. **Get agent private key:**
   ```bash
   cat olas-operate-middleware/.operate/keys/AGENT_ADDRESS | jq -r .private_key
   ```

3. **Create recovery script** (or use template):
   ```typescript
   // scripts/recover-service-safe-SERVICENAME.ts
   import Safe from '@safe-global/protocol-kit';
   import { ethers } from 'ethers';

   const RPC_URL = process.env.BASE_LEDGER_RPC || 'https://mainnet.base.org';
   const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';
   const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';

   const SERVICE_SAFE = '0xSERVICE_SAFE_ADDRESS';
   const AGENT_KEY_PRIVATE_KEY = '0xAGENT_PRIVATE_KEY';

   const ERC20_ABI = [
     'function balanceOf(address owner) view returns (uint256)',
     'function transfer(address to, uint256 amount) returns (bool)',
   ];

   async function main() {
     const provider = new ethers.JsonRpcProvider(RPC_URL);
     const olasToken = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
     
     // Check balance
     const balance = await olasToken.balanceOf(SERVICE_SAFE);
     console.log(`Safe OLAS Balance: ${ethers.formatEther(balance)}`);
     
     // Initialize Safe SDK
     const protocolKit = await Safe.init({
       provider: RPC_URL,
       signer: AGENT_KEY_PRIVATE_KEY,
       safeAddress: SERVICE_SAFE,
     });

     // Encode OLAS transfer
     const olasInterface = new ethers.Interface(ERC20_ABI);
     const data = olasInterface.encodeFunctionData('transfer', [MASTER_SAFE, balance]);

     // Create Safe transaction
     const safeTransaction = await protocolKit.createTransaction({
       transactions: [{
         to: OLAS_TOKEN,
         value: '0',
         data: data,
       }]
     });

     // Sign and execute
     const signedTx = await protocolKit.signTransaction(safeTransaction);
     const executeTxResponse = await protocolKit.executeTransaction(signedTx);
     
     console.log(`Tx: ${executeTxResponse.hash}`);
     await executeTxResponse.transactionResponse?.wait();
     console.log('✅ Recovery Successful!');
   }

   main().catch(console.error);
   ```

4. **Run recovery with QuickNode RPC:**
   ```bash
   BASE_LEDGER_RPC="https://quick-sly-needle.base-mainnet.quiknode.pro/..." \
     yarn tsx scripts/recover-service-safe-SERVICENAME.ts
   ```

**Success Example:**
```
✅ Recovery Successful!
   Recovered: 50.0 OLAS
   Tx: 0x044eed37f991f2cfdf828d0e8de25461c79f6c14276ea39fe1798739c78e970e
```

**Common Errors:**

| Error | Cause | Solution |
|-------|-------|----------|
| `GS026` | Invalid signature format | Use Safe SDK (not manual execTransaction) |
| `Rate limit (429)` | Public RPC overloaded | Use QuickNode or wait and retry |
| `Insufficient funds` | Agent lacks gas | Fund agent EOA with ETH first |

---

## Part 3: Alternative Manual Recovery (Safe UI)

**When to use:** Programmatic recovery fails or you prefer manual control

**Steps:**

1. **Import agent key to MetaMask:**
   - MetaMask → Import Account
   - Paste private key: `0xAGENT_PRIVATE_KEY`

2. **Access Safe UI:**
   ```
   https://app.safe.global/home?safe=base:SERVICE_SAFE_ADDRESS
   ```

3. **Connect MetaMask** (agent key now controls the 1/1 Safe)

4. **Send transaction:**
   - New Transaction → Send tokens
   - Select OLAS token
   - Amount: (full balance)
   - Recipient: `0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645` (Master Safe)

5. **Sign and execute** with MetaMask

---

## Part 4: Best Practices

### Before Recovery

1. **Backup service configs:**
   ```bash
   mkdir -p service-backups
   cp -r olas-operate-middleware/.operate/services/SERVICE_ID \
         service-backups/SERVICE_ID-$(date +%Y%m%d-%H%M%S)
   ```

2. **Document Safe addresses:**
   ```bash
   jq -r '.chain_configs.base.chain_data.multisig' \
     olas-operate-middleware/.operate/services/*/config.json > safes.txt
   ```

3. **Check all sources:**
   - Current services
   - Backed up services
   - Agent EOAs
   - Service Safes

### During Recovery

1. **Use reliable RPC:**
   - QuickNode (15 req/sec)
   - Alchemy
   - NOT public `https://mainnet.base.org` (rate limited)

2. **Add rate limiting:**
   ```typescript
   await new Promise(r => setTimeout(r, 1000)); // 1 second between calls
   ```

3. **Verify balances before/after:**
   ```bash
   # Before
   yarn tsx scripts/check-master-safe-balance.ts
   
   # Recover
   yarn tsx scripts/recover-stranded-olas.ts
   
   # After
   yarn tsx scripts/check-master-safe-balance.ts
   ```

### After Recovery

1. **Clean up test services:**
   ```bash
   # Remove Tenderly test services only
   for dir in olas-operate-middleware/.operate/services/*/; do
     rpc=$(jq -r '.chain_configs.base.ledger_config.rpc' "$dir/config.json" 2>/dev/null)
     if [[ "$rpc" =~ "tenderly" ]]; then
       echo "Removing Tenderly service: $(basename $dir)"
       rm -rf "$dir"
     fi
   done
   ```

2. **Document recovered amounts:**
   ```bash
   echo "$(date): Recovered X OLAS from SERVICE_NAME" >> recovery-log.txt
   ```

---

## Part 5: Scripts Reference

### Core Recovery Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `check-agent-balances.ts` | Scan all agent keys | `yarn tsx scripts/check-agent-balances.ts` |
| `check-all-safes-comprehensive.ts` | Check all Safes | `yarn tsx scripts/check-all-safes-comprehensive.ts` |
| `recover-stranded-olas.ts` | Recover from agent EOAs | Edit agents array, then run |
| `recover-default-service-with-safe-sdk.ts` | Recover from Safe (template) | Copy and edit for each Safe |
| `check-master-safe-balance.ts` | Verify Master Safe balance | `yarn tsx scripts/check-master-safe-balance.ts` |

### Helper Scripts

| Script | Purpose |
|--------|---------|
| `check-all-service-balances.ts` | Check specific service list |
| `check-balances-service-149.ts` | Check Service #149 specifically |

---

## Part 6: Troubleshooting

### Issue: "Module not found: ethers"

**Cause:** Running script from `/tmp` instead of project directory

**Solution:** Create script in `scripts/` directory:
```bash
# Don't do this:
yarn tsx /tmp/my-script.ts

# Do this:
cp /tmp/my-script.ts scripts/my-script.ts
yarn tsx scripts/my-script.ts
```

### Issue: Rate Limit (429)

**Cause:** Too many RPC calls to public endpoint

**Solutions:**
1. Use QuickNode RPC (15 req/sec)
2. Add delays between calls (1 second recommended)
3. Wait 60 seconds and retry

### Issue: GS026 (Invalid Signature)

**Cause:** Manual `execTransaction` signature format incorrect

**Solution:** Use Safe SDK (`@safe-global/protocol-kit`)

### Issue: Insufficient Funds

**Cause:** Agent EOA lacks ETH for gas

**Solution:**
1. Check ETH balance: `provider.getBalance(agentAddress)`
2. Fund agent EOA with ~0.001 ETH
3. Retry recovery

---

## Part 7: Master Safe Details

**Master Safe Address:** `0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645`

**Network:** Base Mainnet

**View on BaseScan:**
- Address: https://basescan.org/address/0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645
- OLAS Transfers: https://basescan.org/token/0x54330d28ca3357F294334BDC454a032e7f353416?a=0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645

**View on Safe UI:**
- https://app.safe.global/home?safe=base:0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645

**OLAS Token:** `0x54330d28ca3357F294334BDC454a032e7f353416`

---

## Part 8: Where Did My OLAS Go?

If you started with 500 OLAS and now have 115 OLAS, the difference (~385 OLAS) was likely spent on:

1. **Service Bonds:** 50 OLAS per service (locked in service contract)
2. **Staking Deposits:** 50 OLAS per staked service (locked in staking contract)
3. **Failed Deployments:** OLAS sent to agents that never completed deployment

**To trace your OLAS:**

1. **View on BaseScan:**
   - OLAS transfers: https://basescan.org/token/0x54330d28ca3357F294334BDC454a032e7f353416?a=0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645
   - Shows all outgoing transfers with timestamps

2. **Check staked services:**
   ```bash
   cd olas-operate-middleware
   poetry run operate service status
   ```

3. **Recover from staked services:**
   - Must unstake first (releases 50 OLAS from staking contract)
   - Then terminate (returns 50 OLAS bond to Safe)
   - Then recover from Safe

---

## Appendix: Recovery Checklist

**Before Starting:**
- [ ] Identify all service Safes (current + backups)
- [ ] Identify all agent keys with balances
- [ ] Backup service configs
- [ ] Document current Master Safe balance

**Recovery Process:**
- [ ] Check agent EOA balances (`check-agent-balances.ts`)
- [ ] Recover from agent EOAs (`recover-stranded-olas.ts`)
- [ ] Check Service Safe balances (`check-all-safes-comprehensive.ts`)
- [ ] Recover from Service Safes (Safe SDK or manual)
- [ ] Verify Master Safe balance increased

**After Recovery:**
- [ ] Document recovered amounts
- [ ] Clean up Tenderly test services
- [ ] Check for any remaining stranded funds
- [ ] Update recovery log

---

**End of Fund Recovery Guide**

