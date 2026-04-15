---
title: Troubleshoot Interactive Service Setup
purpose: runbook
scope: [deployment]
last_verified: 2026-01-30
related_code:
  - olas-operate-middleware/.operate/services
keywords: [troubleshoot, setup, service, funding, password, gas, rpc]
when_to_read: "When the interactive service setup wizard fails or hangs during deployment"
---

# Troubleshooting: Interactive Service Setup (JINN-202)

## Common Issues and Solutions

### 1. "Password required" Prompt Appears

**Symptom:**
```
Enter password for Master EOA:
```

**Cause:** `OPERATE_PASSWORD` environment variable not set.

**Fix:**
```bash
# Add to .env file
echo "OPERATE_PASSWORD=your-secure-password" >> .env

# Or export directly
export OPERATE_PASSWORD="your-secure-password"

# Then retry
yarn setup:service --chain=base
```

---

### 2. Process Hangs at "Waiting for Funding"

**Symptom:**
```
[base] Please transfer at least 0.001 ETH to Agent Key 0x9876...
⠋ [base] Waiting for at least 0.001 ETH... (0.001 ETH remaining)
```
Process hangs indefinitely.

**Causes:**
- Address not funded
- Transfer not confirmed on-chain
- Insufficient amount sent
- Wrong address funded

**Fix:**
1. **Verify transfer was sent:**
   ```bash
   # Check transaction on block explorer
   https://basescan.org/address/0x9876...
   ```

2. **Wait for confirmation:**
   - Base: ~2 seconds per block
   - Gnosis: ~5 seconds per block
   - Wait 1-2 minutes for confirmation

3. **Check exact amount:**
   - Send **at least** the amount shown
   - Include gas fees in your wallet balance check
   - Middleware waits for exact amount or more

4. **Verify correct address:**
   - Copy-paste carefully (no spaces)
   - Check address matches middleware prompt
   - Use checksummed address format

---

### 3. "Intrinsic Gas Too Low" Error

**Symptom:**
```
ValueError: {'code': -32000, 'message': 'intrinsic gas too low'}
```

**Cause:** RPC rate limiting from too many requests.

**Fix:**
1. **Wait and retry:**
   ```bash
   # Wait 5 minutes
   sleep 300
   
   # Retry setup
   yarn setup:service --chain=base
   ```

2. **Use higher-tier RPC:**
   - QuickNode: Upgrade to paid tier
   - Alchemy: Check rate limits
   - Infura: Verify plan limits

3. **Check RPC endpoint:**
   ```bash
   # Test RPC connectivity
   curl -X POST $BASE_LEDGER_RPC \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   ```

---

### 4. Interrupted with Ctrl+C

**Symptom:**
User pressed Ctrl+C during setup.

**Effect:**
- Partial service state left in `.operate/services/sc-XXX/`
- Service may be partially minted on-chain
- Funds may be locked in addresses

**Fix:**

**If interrupted before on-chain minting:**
```bash
# Next run auto-cleans corrupt state
yarn setup:service --chain=base
# No manual action needed
```

**If interrupted during/after on-chain minting:**
```bash
# Check service state
ls -la olas-operate-middleware/.operate/services/

# If service has token ID > -1, it's minted
# Cannot reuse - must create NEW service
yarn setup:service --chain=base
# Gets new token ID
```

**If funds are stranded:**
```bash
# Use recovery script
yarn recover-funds
# Or manually transfer using agent key
```

---

### 5. "Service Already Running" Error

**Symptom:**
```
Service is already running on this configuration.
```

**Cause:** Previous service not stopped properly.

**Fix:**
```bash
# Stop all running services
cd olas-operate-middleware
poetry run python -m operate.cli stop --all

# Retry setup
cd ..
yarn setup:service --chain=base
```

---

### 6. Missing RPC URL

**Symptom:**
```
❌ Error: BASE_LEDGER_RPC environment variable is required
```

**Cause:** RPC URL not configured for the target chain.

**Fix:**
```bash
# Add to .env file
echo "BASE_LEDGER_RPC=https://mainnet.base.org" >> .env

# Or use QuickNode/Alchemy
echo "BASE_LEDGER_RPC=https://your-quicknode-url" >> .env

# Retry
yarn setup:service --chain=base
```

---

### 7. Insufficient OLAS Balance

**Symptom:**
```
[base] Please transfer at least 50.0 OLAS to Service Safe 0x1234...
```
But you don't have enough OLAS.

**Cause:** OLAS tokens required for staking bond.

**Fix:**

**Get OLAS on Base:**
1. **Swap on Uniswap:**
   - https://app.uniswap.org/
   - Token: `0x54330d28ca3357F294334BDC454a032e7f353416`
   - Swap ETH → OLAS

2. **Bridge from Ethereum:**
   - https://bridge.base.org/
   - Bridge OLAS from mainnet

3. **Buy on exchange:**
   - Purchase on CEX
   - Withdraw to Base network

**Minimum OLAS needed:**
- Service Safe: 50 OLAS (for agent instance)
- Master Safe: 100 OLAS (for service bond)
- **Total: 150 OLAS recommended**

---

### 8. Service Minted but Funding Failed

**Symptom:**
- Service has token ID (e.g., 151)
- But setup failed at funding step
- Funds may be stuck

**Effect:**
- Token ID consumed (cannot reuse)
- Service exists on-chain but unstaked
- OLAS/ETH may be in orphaned Safe

**Fix:**

**Create NEW service:**
```bash
# Cannot reuse token 151, must create new one
yarn setup:service --chain=base
# Gets new token ID (e.g., 152)
```

**Recover stuck funds:**
```bash
# Use recovery script with agent key
yarn recover-funds --address=0x... --key=0x...
```

**Check service state:**
```bash
# View on-chain service
https://basescan.org/address/<SERVICE_REGISTRY>
```

---

### 9. Mech Deployment Fails

**Symptom:**
```
[base] Failed to deploy mech contract
Error: Mech deployment not supported on this chain
```

**Cause:**
- Mech marketplace not deployed on chain
- Mech factory configuration missing
- Insufficient funds for deployment

**Fix:**

**For Base mainnet:**
```bash
# Mech marketplace exists
yarn setup:service --chain=base --with-mech
# Should work
```

**For other chains:**
```bash
# Check if mech marketplace deployed
# If not, skip mech deployment
yarn setup:service --chain=base
# Deploy service without mech
```

---

### 10. "Public ID Mismatch" Error

**Symptom:**
```
ValueError: Public ID mismatch: expected valory/trader:0.1.0, got ...
```

**Cause:** Wrong agent ID in service configuration.

**Fix:**

**Already fixed in JINN-198:**
- Agent ID updated from 14 → 43
- Should not occur with current code

**If still occurs:**
```typescript
// Check worker/config/ServiceConfig.ts
export const SERVICE_CONSTANTS = {
  DEFAULT_AGENT_ID: 43, // Correct for Base
```

---

## Recovery Procedures

### Clean Corrupt Service State

```bash
# Manual cleanup if auto-cleanup fails
cd olas-operate-middleware/.operate/services
ls -la

# Remove corrupt service
rm -rf sc-CORRUPTED-UUID

# Verify cleanup
ls -la

# Retry setup
cd ../../../..
yarn setup:service --chain=base
```

### Recover Stranded Funds

```bash
# Get agent private key
cat olas-operate-middleware/.operate/keys/0x...

# Use recovery script
yarn recover-funds \
  --from-safe=0xOLD_SAFE \
  --to-address=0xNEW_SAFE \
  --private-key=0x...
```

### Check Middleware State

```bash
# List all services
cd olas-operate-middleware
poetry run python -m operate.cli services list

# Check wallet info
poetry run python -m operate.cli wallet info

# View Safe balances
poetry run python -m operate.cli safe balances --chain=base
```

---

## Debugging Tips

### Enable Verbose Logging

```bash
# Set log level
export LOG_LEVEL=debug

# Run setup
yarn setup:service --chain=base
```

### Capture Full Output

```bash
# Save all output to file
yarn setup:service --chain=base 2>&1 | tee setup.log

# Review later
cat setup.log
```

### Check Middleware Daemon Logs

```bash
# If daemon is running
cd olas-operate-middleware
cat .operate/logs/daemon.log
```

### Verify On-Chain State

```bash
# Check service registry
https://basescan.org/address/0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE

# Check staking contract
https://basescan.org/address/0x2585e63df7BD9De8e058884D496658a030b5c6ce

# Check OLAS token
https://basescan.org/token/0x54330d28ca3357F294334BDC454a032e7f353416
```

---

## Getting Help

### Report Issues

Include the following information:

1. **Command used:**
   ```bash
   yarn setup:service --chain=base --with-mech
   ```

2. **Environment:**
   - OS: macOS/Linux/Windows
   - Node version: `node --version`
   - Yarn version: `yarn --version`

3. **Error output:**
   - Full error message
   - Stack trace if available
   - Middleware logs

4. **On-chain state:**
   - Master Safe address
   - Service Safe address (if created)
   - Token ID (if minted)

5. **Timeline:**
   - When did it fail?
   - What step?
   - Had it worked before?

### Useful Commands

```bash
# Check versions
node --version
yarn --version
cd olas-operate-middleware && poetry --version

# Check environment
env | grep -E "OPERATE|RPC|BASE|GNOSIS"

# Test RPC
curl -X POST $BASE_LEDGER_RPC \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

---

## Preventive Measures

### Before Running Setup

1. **Check balances:**
   - Master EOA: ~0.002 ETH
   - Master Safe: ~0.002 ETH + 100 OLAS (if exists)
   - Have extra for gas: 0.005 ETH + 150 OLAS recommended

2. **Verify RPCs:**
   ```bash
   curl -X POST $BASE_LEDGER_RPC \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
   # Should return: {"jsonrpc":"2.0","id":1,"result":"0x2105"}
   # (8453 in hex = Base mainnet)
   ```

3. **Check middleware state:**
   ```bash
   ls -la olas-operate-middleware/.operate/services/
   # Should be empty or contain only valid services
   ```

### During Setup

1. **Don't interrupt** during "PLEASE, DO NOT INTERRUPT THIS PROCESS"
2. **Wait for confirmations** before funding next address
3. **Use block explorer** to verify transactions
4. **Keep terminal visible** to see prompts

### After Setup

1. **Save service info:**
   - Service Config ID
   - Service Safe address
   - Token ID
   - Agent Key address

2. **Backup keys:**
   ```bash
   mkdir -p ~/olas-backups/$(date +%Y%m%d)
   cp -r olas-operate-middleware/.operate/keys ~/olas-backups/$(date +%Y%m%d)/
   ```

3. **Document deployment:**
   - Chain used
   - Mech deployed? (yes/no)
   - Token ID
   - Staking status

---

## Success Indicators

✅ **Setup completed successfully if:**

1. Final message shows:
   ```
   ✅ SETUP COMPLETED SUCCESSFULLY
   ```

2. Service config ID shown:
   ```
   📋 Service Config ID: sc-abc123...
   ```

3. Service Safe address shown:
   ```
   🔐 Service Safe: 0x1234...
   ```

4. Result file saved:
   ```
   📝 Setup details saved to: /tmp/jinn-service-setup-1234567890.json
   ```

5. Middleware shows service running:
   ```bash
   cd olas-operate-middleware
   poetry run python -m operate.cli services list
   # Should show service as "RUNNING" or "STAKED"
   ```

---

## See Also

- [AGENTS.md](../../AGENTS.md) - Main documentation
- [ARCHITECTURE_WALLET_SAFES.md](../ARCHITECTURE_WALLET_SAFES.md) - Wallet hierarchy
- [MAINNET_SAFETY.md](../MAINNET_SAFETY.md) - Safety procedures
- [CORRUPT_SERVICE_CLEANUP.md](../CORRUPT_SERVICE_CLEANUP.md) - Auto-cleanup details

