---
title: Quick Start - Setting Up an OLAS Service
purpose: runbook
scope: [deployment]
last_verified: 2026-02-04
related_code:
  - olas-operate-middleware/.operate/services
  - worker/SimplifiedServiceBootstrap.ts
  - env/operate-profile.ts
keywords: [olas, service, deployment, setup, wizard, master-wallet, master-safe]
when_to_read: "When deploying your first OLAS service using the interactive setup wizard"
---

# Quick Start: Setting Up an OLAS Service

This guide walks you through deploying your first OLAS service using the HTTP daemon flow.

## Prerequisites

1. **Node.js and Yarn**: Ensure you have Node.js (v22+) and Yarn installed
2. **Python Environment**: Python 3.11+ with Poetry
3. **Funds**: You'll need ETH and OLAS tokens on Base mainnet
   - ~0.005 ETH (for gas across all operations)
   - 100 OLAS (50 bond + 50 stake)
   - OLAS Token: `0x54330d28ca3357F294334BDC454a032e7f353416` (Base)
4. **RPC Access**: A reliable RPC endpoint (e.g., Tenderly, Alchemy)

## Step 1: Environment Setup

Create a `.env` file in the project root:

```bash
# Required
OPERATE_PASSWORD="your-secure-password-here"  # Used to encrypt/decrypt keystores
RPC_URL="https://your-base-rpc-url"

# Optional aliases
BASE_LEDGER_RPC="https://your-base-rpc-url"
```

> **Important**: `OPERATE_PASSWORD` is used to encrypt agent private keys. Choose a secure password and store it safely - you'll need it to run the worker.

Run the development setup:

```bash
yarn setup:dev
```

This will:
- Initialize git submodules (olas-operate-middleware)
- Set up Python/Poetry environment
- Install Node.js dependencies

### Verify Poetry Environment

If you encounter module errors (e.g., `ModuleNotFoundError: No module named 'certifi'`), manually install dependencies:

```bash
cd olas-operate-middleware
poetry install  # Installs ~124 packages
cd ..
```

## Step 2: Run the Service Setup

Launch the setup wizard with mech deployment:

```bash
yarn setup:service --chain=base --with-mech
```

This starts an HTTP daemon on port 8000 and guides you through deployment.

## Step 3: Fund Your Service (2 Steps)

For a **new operator** (fresh `.operate` directory), you'll fund **2 addresses**:

### 3.1: Fund Master EOA

The setup will display:

```
📍 FUNDING REQUIRED - Master EOA
───────────────────────────────────────────────────────────────────────────────
🔑 Address: 0x310b8970...

💰 Required:
   • ~0.005 ETH (for gas)

Waiting for funding...
```

**What to do:**
1. Send ~0.005 ETH to the Master EOA address shown
2. The wizard automatically detects the funds and proceeds

### 3.2: Fund Master Safe

After the Master Safe is created:

```
📍 FUNDING REQUIRED - Master Safe
───────────────────────────────────────────────────────────────────────────────
🔑 Address: 0xe14eb268...

💰 Required:
   • Small amount of ETH (for gas)
   • 100 OLAS (50 bond + 50 stake)

   OLAS Token: 0x54330d28ca3357F294334BDC454a032e7f353416
```

**What to do:**
1. Send 100 OLAS tokens to the Master Safe address
2. The wizard automatically detects funds and proceeds to deploy

> **Note**: The 100 OLAS is split: 50 for the security bond, 50 for staking.

### Automatic Deployment

Once funded, the system automatically:
1. Creates the service configuration
2. Generates and encrypts agent keys
3. Deploys the Service Safe
4. Registers the service on-chain
5. Stakes the service
6. Deploys the mech contract (if `--with-mech`)

## Step 4: Success!

```
════════════════════════════════════════════════════════════════════════════════
  ✅ SETUP COMPLETED SUCCESSFULLY
════════════════════════════════════════════════════════════════════════════════

📋 Service Config ID: sc-ea36ee26-af1c-4f36-b888-631fe1ea843d
🔐 Service Safe: 0x04F2c0dba7EdC67472bd6d89e88849c2dd832aBC

📝 Setup details saved to: /tmp/jinn-service-setup-1234567890.json
```

The setup JSON file contains all addresses:
- **Master EOA**: Your primary wallet
- **Master Safe**: Controls all services
- **Service Safe**: Executes operations, holds staked OLAS
- **Agent EOA**: Signs transactions from Service Safe
- **Mech Contract**: Receives marketplace requests (if deployed)
- **Service Token ID**: On-chain service identifier

## Step 5: Run the Worker

Now that your service is deployed and staked, start the worker:

```bash
# Build first
yarn build

# Run the worker
yarn start
```

The worker will:
- Process jobs from the on-chain marketplace
- Execute OLAS staking operations every hour
- Manage the service lifecycle automatically

## Troubleshooting

### "Insufficient funds" after transferring

**Problem**: You transferred funds but the wizard still shows insufficient balance.

**Solutions**:
1. Wait 5-10 seconds for the transaction to confirm
2. Type `check` to refresh the balance
3. Verify you sent to the correct address
4. Check block explorer to confirm transaction succeeded

### "User not logged in" error

**Problem**: Middleware session expired during setup.

**Solution**: The wrapper automatically re-authenticates. If persistent, restart the wizard.

### "Failed to deploy service"

**Problem**: Service Safe has insufficient funds for on-chain operations.

**Solutions**:
1. Verify the Service Safe has the required amounts
2. Check gas prices aren't unusually high
3. Ensure OLAS token approvals are set (usually automatic)

### Want to skip funding verification?

**CAUTION**: Only use in testing environments!

Type `skip` at any funding prompt to bypass the balance check. The deployment may fail later if funds are actually insufficient.

## Understanding the Architecture

### Master Wallet (EOA)
- Your primary wallet
- Deploys the Master Safe
- Needs ETH for gas only
- **Location**: `.operate/wallets/{chain}.txt` (encrypted)

### Master Safe
- Gnosis Safe contract
- Owns and controls all services
- Needs ETH for gas + OLAS for service funding
- **Controlled by**: Master Wallet

### Agent Key
- Service-specific key
- Signs transactions from Service Safe
- Stored globally, survives service deletion
- **Location**: `.operate/keys/{address}` (encrypted with `OPERATE_PASSWORD`)
- **Format**: JSON with encrypted keystore in `private_key` field

### Service Safe
- Gnosis Safe for the service
- Executes service operations
- Holds staked OLAS
- **Controlled by**: Agent Key (1/1 multisig)
- **Owned by**: Master Safe

### Flow Diagram

```
Master Wallet (EOA)
    │
    ├─> Deploys Master Safe
    │
Master Safe (Gnosis Safe)
    │
    ├─> Creates Service Config
    │   └─> Generates Agent Key
    │
    ├─> Deploys Service Safe
    │   └─> Agent Key as signer (1/1)
    │
    └─> Funds Service Safe
        └─> Stakes OLAS
```

## Next Steps

- **Monitor your service**: Check the Olas Dashboard at https://operate.olas.network
- **View staking rewards**: Your service earns OLAS rewards while staked
- **Deploy a mech**: Run `yarn setup:service --with-mech` for marketplace participation
- **Review logs**: Worker logs show job processing and OLAS operations

## Advanced: Manual Recovery

If you need to access funds from a Safe:

1. **Find the agent key file**: `.operate/keys/{agent-address}`
2. **Decrypt the keystore**: The `private_key` field contains an encrypted keystore
   ```bash
   # The worker's decryption is in env/keystore-decrypt.ts
   # Or use ethers.js:
   const wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, OPERATE_PASSWORD);
   ```
3. **Import to MetaMask**: Use the decrypted private key
4. **Access Safe**: Visit https://app.safe.global and connect with the imported key

> **Note**: Agent keys are encrypted with `OPERATE_PASSWORD`. You need this password to decrypt them.

See `docs/runbooks/recover-olas-funds.md` for complete recovery procedures.

## Resources

- **Full Documentation**: [AGENTS.md](../../AGENTS.md)
- **Wallet Architecture**: `ARCHITECTURE_WALLET_SAFES.md`
- **Safety Guide**: `MAINNET_SAFETY.md`
- **OLAS Dashboard**: https://operate.olas.network
- **Base Explorer**: https://basescan.org

