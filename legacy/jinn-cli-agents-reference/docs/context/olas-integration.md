---
title: OLAS Integration Architecture
purpose: context
scope: [deployment]
last_verified: 2026-02-04
related_code:
  - olas-operate-middleware/.operate/wallets/
  - olas-operate-middleware/.operate/keys/
keywords: [olas, middleware, wallet, safe, staking, agent-keys, service-lifecycle]
when_to_read: "When working with OLAS middleware deployment, wallet management, or staking"
---

# OLAS Integration Architecture

How Jinn integrates with the OLAS middleware for service deployment and staking.

## Dual Key Storage System

The middleware maintains **two separate** key stores:

### 1. Master Wallet (EOA)

**Location**: `olas-operate-middleware/.operate/wallets/`
**Format**: Encrypted JSON keystore (one per chain)
**Encryption**: Uses `OPERATE_PASSWORD` environment variable

**Purpose**:
- Creates and deploys Gnosis Safes (pays gas for Safe deployment)
- Controls Safes during creation phase
- Acts as the transaction submitter for Safe operations

**Persistence**: MUST be preserved on mainnet to maintain access to created Safes.

### 2. Agent Keys

**Location**: `olas-operate-middleware/.operate/keys/`
**Format**: JSON with encrypted keystore in `private_key` field (scrypt KDF + AES-128-CTR)
**Encryption**: Uses `OPERATE_PASSWORD` environment variable
**Storage**: Global directory, shared across all services

> **Note**: Older middleware versions stored raw hex keys. Current versions store encrypted keystores.
> The worker automatically detects and decrypts the format using `OPERATE_PASSWORD`.

**Purpose**:
- Become the **signers** on Safe multisigs (1/1 configuration)
- Sign transactions from within the Safe
- Execute service operations on behalf of the Safe

**Lifecycle**:
- Created when service is created (`ServiceManager.create()`)
- Survive service deletion (stored globally, not per-service)
- Can be reused across service deployments

## Wallet Hierarchy

```
Master EOA (e.g., 0xB151...)
  └─> Master Safe (e.g., 0x15aD...)
      └─> Service Safes (one per service deployment)
          ├─> Service #149: 0x15aD...
          ├─> Service #150: 0xbcE2...
          └─> Agent Keys (signers on Service Safes)
```

**Key facts**:
- Agent keys stored globally in `/.operate/keys/` (survive service deletion)
- Master wallet creates multiple Safes (one per service deployment)
- Each Safe is independent with its own agent key signer
- Deleting a service does NOT delete the agent keys
- Safes can be recovered using agent private keys

## Service Lifecycle States

```
PRE_REGISTRATION → ACTIVE_REGISTRATION → FINISHED_REGISTRATION → DEPLOYED → DEPLOYED_AND_STAKED
```

| State | Meaning |
|-------|---------|
| PRE_REGISTRATION | Service created, NFT minted |
| ACTIVE_REGISTRATION | Service activated with security deposit |
| FINISHED_REGISTRATION | Agent registration complete |
| DEPLOYED | Service Safe deployed on-chain |
| DEPLOYED_AND_STAKED | Service staked in staking contract |

## Operating Modes

### Unattended Mode (Automation)

```bash
ATTENDED=false
OPERATE_PASSWORD=<password>
<CHAIN>_LEDGER_RPC=<rpc_url>
STAKING_PROGRAM=<program>
```

- No interactive prompts
- Requires pre-funded addresses
- Suitable for CI/CD and Tenderly testing

### Attended Mode (Interactive)

```bash
ATTENDED=true
OPERATE_PASSWORD=<password>
<CHAIN>_LEDGER_RPC=<rpc_url>
```

- Shows native middleware funding prompts
- Real-time balance polling
- Auto-continues when funding detected

**When to use each**:

| Mode | Tenderly | Mainnet | CI/CD |
|------|----------|---------|-------|
| Unattended | Recommended | Requires pre-funding | Ideal |
| Attended | Works if balance checks pass | Best UX | Blocks automation |

## Mech Deployment Timing

Mech deployment happens **only during service creation**, not post-deployment.

```typescript
// Correct: Deploy mech DURING service creation
await serviceManager.deployAndStakeService(undefined, {
  deployMech: true,
  mechType: 'Native',
  mechRequestPrice: '10000000000000000',
  mechMarketplaceAddress: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020'
});
```

The middleware detects empty `AGENT_ID` and `MECH_TO_CONFIG` env vars and calls `deploy_mech()` automatically.

## Key Files

| File | Purpose |
|------|---------|
| `worker/OlasOperateWrapper.ts` | HTTP API wrapper for middleware |
| `worker/OlasServiceManager.ts` | Service lifecycle orchestration |
| `worker/SimplifiedServiceBootstrap.ts` | Interactive setup |
| `worker/config/ServiceConfig.ts` | Service configuration |
| `worker/config/MechConfig.ts` | Mech deployment config |

## Related Documentation

- Protocol overview: `docs/context/olas-protocol.md`
- Contract addresses: `docs/reference/OLAS_CONTRACTS.md`
- Deployment: `docs/runbooks/deploy-olas-service.md`
- Troubleshooting: `docs/runbooks/troubleshoot-olas-middleware.md`
- Fund recovery: `docs/runbooks/recover-olas-funds.md`
