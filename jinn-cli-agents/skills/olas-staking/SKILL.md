---
name: olas-staking
description: Manage OLAS service staking on Base — restake evicted services, migrate between contracts, check status, and manage the activity checker whitelist. Covers Safe transaction patterns, bond management, and troubleshooting.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
user-invocable: true
emoji: null
---

# OLAS Staking

Manage OLAS service staking on Base: restaking, migration, status checks, and whitelist management.

---

## Quick Reference

| Contract | Address |
|----------|---------|
| Jinn Staking v1 | `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139` |
| Jinn Staking v2 | `0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488` |
| AgentsFun1 | `0x2585e63df7BD9De8e058884D496658a030b5c6ce` |
| Activity Checker (v1) | `0x1dF0be586a7273a24C7b991e37FE4C0b1C622A9B` |
| Activity Checker (v2) | `0xe575393b921C98288a842217AFBeDBA8197496D5` |
| ServiceRegistry | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |
| ServiceRegistryTokenUtility | `0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5` |
| ServiceManagerToken (CORRECT) | `0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6` |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |
| Marketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |

### Our Services

| Service | Master EOA | Master Safe | Service Safe | .operate profile |
|---------|-----------|-------------|-------------|-----------------|
| 165 (Oak) | `0xB1517bB...02CC2` | `0x15aDF0E...4645` | `0xb8B7A897...D92` | `olas-operate-middleware/.operate/` |
| 359 (Venture-Test) | `0x443ad86...ffE7` | `0xcea8407...E0e` | `0xD2C24F6...10B` | `/Users/gcd/Repositories/main/jinn-node/.operate/` |
| 387 (Fleet) | `0xB1517bB...02CC2` | `0x15aDF0E...4645` | — | `olas-operate-middleware/.operate/` |
| 388 (Fleet) | `0xB1517bB...02CC2` | `0x15aDF0E...4645` | — | `olas-operate-middleware/.operate/` |
| 389 (Fleet) | `0xB1517bB...02CC2` | `0x15aDF0E...4645` | — | `olas-operate-middleware/.operate/` |
| 390 (Fleet) | `0xB1517bB...02CC2` | `0x15aDF0E...4645` | — | `olas-operate-middleware/.operate/` |

Venture Safe (AMP2): `0x900Db2954a6c14C011dBeBE474e3397e58AE5421`

### Service Ownership Mapping (Jinn Staking Contract)

| Safe | Services |
|------|----------|
| Oak Master Safe (`0x15aDF0eD...4645`) | 165, 387, 388, 389, 390 |
| Venture-Test Safe (`0xcea8407...E0e`) | 359 |
| Unknown (`0x953d212b...f0`) | 378, 379 |
| Unknown (`0x58795797...87`) | 372 |
| Unknown (`0xd810e967...98`) | 375 |
| Unknown (`0x40abf47b...6f`) | 392 |

**Jinn staking contract**: 10 max slots, 6 currently used (as of March 2026).

---

## 1. Restaking (Evicted Service)

When a service is evicted (staking state = 2), it needs to be unstaked (reclaim NFT) then re-staked. The service stays DEPLOYED (state 4) throughout — no terminate/register cycle needed.

### Flow

```
1. unstake(serviceId)        — reclaim NFT from staking contract
2. approve(stakingContract, serviceId) — approve NFT transfer on ServiceRegistry
3. stake(serviceId)          — re-stake in the same or different contract
```

### Script (Recommended: dedicated restake script)

```bash
# Service 165 (Oak):
source .env && OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
  npx tsx scripts/restake-service.ts --service-id=165

# Service 359 (Venture-Test) — DIFFERENT .operate profile (absolute path required):
source .env && OPERATE_PROFILE_DIR=/Users/gcd/Repositories/main/jinn-node/.operate \
  npx tsx scripts/restake-service.ts --service-id=359

# Batch restake multiple services (comma-separated):
source .env && OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
  npx tsx scripts/restake-service.ts --service-id=387,388,389,390

# Custom staking contract:
source .env && OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
  npx tsx scripts/restake-service.ts --service-id=165 --staking-contract=0x...
```

This script uses direct ethers.js (NOT Safe SDK) for all steps, avoiding the GS013 issue entirely. It checks staking state first and skips if already staked.

### Alternative: migration script (NOT recommended for simple restake)

```bash
# The migration script uses Safe SDK which FAILS on approve+stake with GS013
source .env && OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
  npx tsx scripts/migrate-staking-contract.ts \
  --service-id=165 --source=jinn --target=jinn
```

### IMPORTANT: Safe SDK GS013 — use direct ethers.js for ALL staking ops

The `@safe-global/protocol-kit` (Safe SDK) fails with **GS013 during gas estimation** for `approve()` AND `stake()`. The SDK's viem-based gas estimation triggers a revert during `estimateContractGas`, but the actual call works fine when sent with explicit gasLimit.

**Workaround**: Use direct ethers.js `execTransaction` with explicit `gasLimit: 2_000_000` and manual signature construction (eth_sign format, v+4). This bypasses the SDK's gas estimation. The `restake-service.ts` script uses this approach. See also the `execSafeTx` helper in Section 5.

**March 2026 update**: The migration script's ethers.js fallback had a bug where it sent empty `data: ""` for the approve call (the calldata wasn't passed through). The dedicated `restake-service.ts` script fixes this.

### Post-Restake Checklist

- [ ] Verify `getStakingState(serviceId)` returns 1 (Staked)
- [ ] Verify service ID appears in `getServiceIds()`
- [ ] **Whitelist mechs** — REQUIRED after restaking: `tsx scripts/activity-checker-whitelist.ts add --from-staking` (see Section 4)
- [ ] Verify `maxDeliveryRate` is 99 on the mech (`yarn mech:check-rate`)

### New Staking Contract Checklist

When deploying a **new staking contract**, the following must also be updated:

- [ ] `ponder/ponder.config.ts` → add address to `StakingContracts.address[]`
- [ ] `ponder/src/index.ts` → add address to `JINN_STAKING_CONTRACTS[]`
- [ ] `jinn-node/src/worker/filters/stakingFilter.ts` → update `DEFAULT_JINN_STAKING_CONTRACT`
- [ ] `jinn-node/src/worker/staking/restake.ts` → update `DEFAULT_STAKING_CONTRACT`
- [ ] `jinn-node/src/worker/SimplifiedServiceBootstrap.ts` → update fallback address
- [ ] `jinn-node/src/setup/cli.ts` → update fallback addresses (2 locations)
- [ ] `jinn-node/src/worker/config/ServiceConfig.ts` → update `DEFAULT_STAKING_PROGRAM_ID`
- [ ] `frontend/explorer/src/lib/staking/constants.ts` → update `JINN_STAKING_CONTRACT`
- [ ] This skill file → update Quick Reference table above
- [ ] `skills/deploy-staking/SKILL.md` → update Step 5 config update list
- [ ] `docs/reference/jinn-staking.md` → update deployed contracts
- [ ] Redeploy Ponder indexer to pick up new contract events

---

## 2. Migration (Between Staking Contracts)

Full migration from one staking contract to another (e.g., AgentsFun1 -> Jinn). Requires terminate/re-register cycle if bond amounts differ.

### Script

```bash
source .env && OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
  npx tsx scripts/migrate-staking-contract.ts \
  --service-id=165 --source=agentsfun1 --target=jinn [--dry-run]
```

### Full Migration Flow (when bond increase needed)

```
1. Unstake from source
2. Terminate       — DEPLOYED -> TERMINATED_BONDED (returns security deposit)
3. Unbond          — TERMINATED_BONDED -> PRE_REGISTRATION (returns agent bond)
4. Update bond     — ServiceManagerToken.update() with new bond amount
5. Activate        — PRE_REGISTRATION -> ACTIVE_REGISTRATION (costs security deposit in OLAS + 1 wei)
6. Register agents — ACTIVE_REGISTRATION -> FINISHED_REGISTRATION (costs agent bond in OLAS + 1 wei)
7. Deploy multisig — FINISHED_REGISTRATION -> DEPLOYED
8. Approve NFT     — approve(targetContract, serviceId) on ServiceRegistry
9. Stake in target — stake(serviceId) on target contract
10. Set maxDeliveryRate to 99
```

### OLAS Funding Requirements

| Item | Amount | When Paid |
|------|--------|-----------|
| Security Deposit | 1 x min_staking_deposit | Activation (step 5) |
| Agent Bond | 1 x min_staking_deposit per agent | Registration (step 6) |
| **Total (1 agent)** | **2 x min_staking_deposit** | |

For Jinn (5,000 OLAS min): **10,000 OLAS total** needed in the Master Safe.
Both deposits are returned when terminated and unbonded.

### Deploy Step — Multisig Reuse vs Fresh

| Scenario | Contract | Address |
|----------|----------|---------|
| Reuse + recovery | `recovery_module` | `0x359d53C326388D24037b3b1590d217fdb5EEE74c` |
| Reuse, no recovery | `gnosis_safe_same_address_multisig` | `0xFbBEc0C8b13B38a9aC0499694A69a10204c5E2aB` |
| Fresh + recovery | `safe_multisig_with_recovery_module` | `0x8c534420Db046d6801A1A8bE6fb602cC8F257453` |
| Fresh, no recovery | `gnosis_safe_proxy_factory` | `0x22bE6fDcd3e29851B29b512F714C328A00A96B83` |

**Reuse payload**: `0x` + serviceId.toString(16).padStart(64, '0')

**CRITICAL**: Do NOT use `gnosis_safe_same_address_multisig` with empty data — it will revert.

---

## 3. Status Checks

### Check staking state

```bash
CAST=~/.foundry/bin/cast
RPC=https://base.publicnode.com

# getStakingState: 0=Unstaked, 1=Staked, 2=Evicted
$CAST call 0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139 \
  "getStakingState(uint256)(uint8)" 165 --rpc-url $RPC

# List all staked services
$CAST call 0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139 \
  "getServiceIds()(uint256[])" --rpc-url $RPC

# Check service state on registry (0-5, see table below)
$CAST call 0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE \
  "getService(uint256)" 165 --rpc-url $RPC

# Check NFT owner
$CAST call 0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE \
  "ownerOf(uint256)(address)" 165 --rpc-url $RPC
```

### Service States (on-chain)

| State | Value | Meaning |
|-------|-------|---------|
| NON_EXISTENT | 0 | Not registered |
| PRE_REGISTRATION | 1 | Registered, not yet activated |
| ACTIVE_REGISTRATION | 2 | Activated, agents can register |
| FINISHED_REGISTRATION | 3 | All agents registered |
| DEPLOYED | 4 | Multisig deployed, ready to stake |
| TERMINATED_BONDED | 5 | Terminated, bond held |

### Staking States

- **Actively staked**: NFT owned by staking contract AND service ID in `getServiceIds()` list
- **Evicted**: NFT owned by staking contract but NOT in `getServiceIds()` list. `unstake()` still works.
- **Unstaked**: NFT owned by the service owner (Master Safe). Ready to stake elsewhere.

---

## 4. Activity Checker Whitelist

The activity checker gates which mechs count toward staking liveness — mechs not on the whitelist won't earn rewards. See also: `skills/activity-checker-whitelist/SKILL.md`.

### Script

```bash
# List all whitelisted mechs
source .env && RPC_URL="$RPC_URL" npx tsx scripts/activity-checker-whitelist.ts list

# Check a specific address
source .env && RPC_URL="$RPC_URL" npx tsx scripts/activity-checker-whitelist.ts check 0x1234...

# Add all staked mechs
source .env && RPC_URL="$RPC_URL" OPERATE_PASSWORD="$OPERATE_PASSWORD" \
  npx tsx scripts/activity-checker-whitelist.ts add --from-staking

# Add specific address
source .env && RPC_URL="$RPC_URL" OPERATE_PASSWORD="$OPERATE_PASSWORD" \
  npx tsx scripts/activity-checker-whitelist.ts add 0x1234...
```

### After restaking or migration

Always verify the service's multisig is whitelisted. The multisig address is in `ServiceStaked` event `topics[3]`, or from `getService(serviceId).multisig`.

---

## 5. Direct Safe Transaction Approach

For staking operations that need to bypass the middleware (e.g., scripted migrations, custom flows), use direct ethers.js + Safe execTransaction.

### Prerequisites

1. Master EOA private key (from `.operate/wallets/ethereum.txt`, decrypt with OPERATE_PASSWORD)
2. Master Safe must be sole owner of the service Safe (threshold=1)
3. ETH for gas (~0.02 ETH sufficient for full flow)

### execSafeTx Helper (ethers.js)

```typescript
import { ethers } from 'ethers';

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];

async function execSafeTx(
  safe: ethers.Contract,
  signer: ethers.Wallet,
  to: string,
  data: string,
): Promise<ethers.TransactionReceipt> {
  // Use public RPC for nonce to avoid Tenderly cache staleness
  const publicProvider = new ethers.JsonRpcProvider('https://base.publicnode.com');
  const publicSafe = new ethers.Contract(safe.target, SAFE_ABI, publicProvider);
  const nonce = await publicSafe.nonce();

  const txHash = await publicSafe.getTransactionHash(
    to, 0n, data, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );

  // eth_sign format: v + 4 for Safe
  const signature = await signer.signMessage(ethers.getBytes(txHash));
  const sigBytes = ethers.getBytes(signature);
  const r = ethers.hexlify(sigBytes.slice(0, 32));
  const s = ethers.hexlify(sigBytes.slice(32, 64));
  const v = sigBytes[64] + 4;
  const adjustedSig = ethers.concat([r, s, new Uint8Array([v])]);

  const safeWithSigner = safe.connect(signer) as ethers.Contract;
  const tx = await safeWithSigner.execTransaction(
    to, 0n, data, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig,
    { gasLimit: 2_000_000 },
  );

  return await tx.wait();
}
```

**Key points:**
- Always use public RPC (`base.publicnode.com`) for nonce reads — Tenderly cache can be stale
- Add 3s delay after TX before verification reads
- `gasLimit: 2_000_000` explicit — do NOT rely on gas estimation (it fails for some calls)

### Alternative: Middleware (`yarn service:add`)

```bash
# Preferred for staking operations — uses OlasOperateWrapper
OPERATE_PASSWORD=<pwd> RPC_URL=<rpc> yarn service:add --staking-contract <address>
```

---

## 6. Batch Service Provisioning

Create multiple services at once for fleet scaling. See `skills/fleet-management/SKILL.md` for the full workflow.

### Budget Planning

| Resource | Per Service | Formula |
|----------|-----------|---------|
| OLAS | 10,000 (5k deposit + 5k bond) | `available_olas / 10,000 = max_services` |
| ETH | ~0.01 (Safe + agent + gas) | From Master Safe |
| Staking slots | 1 | Max 100 in v2 contract |

All OLAS is returned when a service is terminated and unbonded.

### Script

```bash
# Fleet-wide balance check (Master EOA/Safe + all service Safes/Agents)
tsx scripts/fleet-balances.ts

# Dry run — check balances and slot availability
yarn service:add --count=7 --dry-run

# Provision 7 services end-to-end (unattended)
OPERATE_PASSWORD=<pwd> RPC_URL=<rpc> yarn service:add --count=7 --unattended
```

Each service goes through: create config → activate registration (5k OLAS) → register agents (5k OLAS) → deploy Safe → stake → whitelist mech. The middleware funds the Safe from the Master Safe automatically.

### Post-Provisioning Checklist

- [ ] New services appear in `yarn service:list`
- [ ] Mechs whitelisted (`tsx scripts/activity-checker-whitelist.ts list`)
- [ ] First deliveries recorded within 1-2 hours
- [ ] Re-deploy Railway worker (`yarn deploy:railway -- --project jinn-multi-v2 --skip-import`)
- [ ] Worker restarted with updated `WORKER_COUNT` if needed

---

## Environment

- `OPERATE_PASSWORD` — Decrypts master wallet keystore
- `RPC_URL` or `BASE_RPC_URL` — Tenderly RPC (required for writes)
- `OPERATE_PROFILE_DIR` — Override .operate directory path (default: `olas-operate-middleware/.operate/`)

---

## Files

| File | Purpose |
|------|---------|
| `scripts/restake-service.ts` | **Restake evicted service** (direct ethers.js, no Safe SDK) |
| `scripts/migrate-staking-contract.ts` | Full migration between contracts (Safe SDK — see GS013 note) |
| `scripts/activity-checker-whitelist.ts` | Whitelist management CLI |
| `scripts/check-post-unstake.ts` | Diagnostic: check state after unstaking |
| `scripts/mech/set-max-delivery-rate.ts` | Set mech maxDeliveryRate |
| `olas-operate-middleware/operate/ledger/profiles.py` | Patched: ServiceManagerToken for Base |

---

## Staking ABI

```solidity
// Read
function getServiceIds() view returns (uint256[])
function mapServiceInfo(uint256 serviceId) view returns (address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity)
function minStakingDeposit() view returns (uint256)
function maxNumServices() view returns (uint256)
function getStakingState(uint256 serviceId) view returns (uint8)
function availableRewards() view returns (uint256)

// Write
function stake(uint256 serviceId) external
function unstake(uint256 serviceId) external returns (uint256)
```

```solidity
event ServiceStaked(uint256 epoch, uint256 indexed serviceId, address indexed owner, address indexed multisig, uint256[] nonces)
event ServiceUnstaked(uint256 epoch, uint256 indexed serviceId, address indexed owner, address indexed multisig, uint256[] nonces, uint256 reward, uint256 availableRewards)
```

---

## Troubleshooting

### Safe SDK GS013 on stake() — use direct ethers.js

**Issue:** `@safe-global/protocol-kit` (Safe SDK) reverts with GS013 during `estimateContractGas` for `stake()`, even though the underlying call succeeds when simulated directly.

**Root Cause:** The Safe SDK uses viem's `estimateContractGas` before executing. For some calls (notably `stake()`), the gas estimation fails even though `cast call --from <safe>` succeeds. The estimation may fail due to state access patterns in the staking contract that confuse the estimator.

**Solution:** Use direct ethers.js `execTransaction` with explicit `gasLimit: 2_000_000`. This bypasses gas estimation entirely. See the `execSafeTx` helper in Section 5.

**Detection:** Error message contains `GS013` and `estimateContractGas` in the stack trace.

### Wrong ServiceManagerToken in autonomy library (CRITICAL)

**Issue:** Service management operations fail with `ManagerOnly` or `gas 0`.

**Root Cause:** Autonomy library has wrong address for Base. On-chain `ServiceRegistry.manager()` = `0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6`, autonomy has `0x63e66d7ad413C01A7b49C7FF4e3Bb765C4E4bd1b`.

**Solution:** Patched in `operate/ledger/profiles.py`.

### Gas 0 / intrinsic gas too low

The autonomy `get_raw_safe_transaction` uses `fallback_gas=0`. When `eth_estimateGas` fails (inner call would revert), the tx gets `gas=0`. The REAL issue is the inner revert — check middleware logs.

### GS013 (Safe inner transaction reverted)

Common causes: wrong contract address, insufficient OLAS, wrong service state, agent already registered.

### NoRewardsAvailable on stake()

`stake()` reverts with `NoRewardsAvailable()` (selector `0xafb0be33`) if `availableRewards == 0`. Deposit OLAS rewards first (permissionless `deposit(uint256)` function).

### 60 requests can still be ineligible (Jinn checker uses +1 margin)

Current Jinn staking liveness on Base is:
- `livenessPeriod = 86400`
- `livenessRatio = 694444444444444`
- `required = ceil(effectivePeriod * livenessRatio / 1e18) + 1`

With `effectivePeriod = 86400`, this is **61 requests**, so stopping at 60 can leave `pending rewards = 0`.

Worker logic should align with the same formula for gating/heartbeat:
- `effectivePeriod = max(livenessPeriod, now - tsCheckpoint [+ optional delay buffer])`
- `target = ceil(effectivePeriod * livenessRatio / 1e18) + safetyMargin`

Operator knobs:
- `WORKER_STAKING_TARGET` — hard override
- `WORKER_STAKING_SAFETY_MARGIN` — additive request margin (default `1`)
- `WORKER_STAKING_CHECKPOINT_DELAY_SEC` — optional delay buffer (default `0`)

### Direct EOA signing fails — must use Safe

Staking operations must be executed FROM the Safe (msg.sender check). Route through Safe `execTransaction`.

### Tenderly RPC staleness (nonce AND tx sending)

Always read nonce from public RPC (`base.publicnode.com`), not Tenderly. Tenderly can return stale values causing signature/nonce mismatch.

**TX sending**: Tenderly RPC can also hang indefinitely when sending transactions. If a TX is submitted but never mines or returns, switch to public RPC for sending too. The `execSafeTx` helper and migration script both default to Tenderly via `RPC_URL` — override by using `base.publicnode.com` as the signer provider.

### OPERATE_PROFILE_DIR path resolution gotcha

`OPERATE_PROFILE_DIR` is resolved relative to `jinn-node/` internally, so setting it to `jinn-node/.operate` results in `jinn-node/jinn-node/.operate` (doubled path). For service 359, use the **absolute path**: `OPERATE_PROFILE_DIR=/Users/gcd/Repositories/main/jinn-node/.operate`. For service 165, the relative path `olas-operate-middleware/.operate` works because it is inside the monorepo root.

**CRITICAL**: Each service has its own `.operate` profile with different master keys. Using the wrong profile will cause Safe `execTransaction` to revert silently (GS013 or status=0 with no logs) because the signature comes from the wrong EOA.

### Deploy with wrong multisig implementation

For reuse-with-recovery: use `recovery_module` (`0x359d53C...`). NOT `gnosis_safe_same_address_multisig`.

### Middleware not available / scripted flow needed

Use the direct ethers.js Safe transaction approach (Section 5) when running automated scripts outside of the normal `yarn service:add` workflow.

### is_update=True infinite loop

When `current_staking_program=None`, fallback params have `staking_token=ZERO_ADDRESS`. Patched to skip comparison when unstaked.

### .env not loading

`import 'jinn-node/env'` resolves to `jinn-node/` as repo root. Pre-load root `.env` via explicit `dotenv.config()`.

### Master Safe vs Venture Safe

- **Master Safe (Operate)**: `0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645` — owns/stakes service 165
- **Venture Safe (AMP2)**: `0x900Db2954a6c14C011dBeBE474e3397e58AE5421` — treasury, DIFFERENT

---

## Migration Log

### Service 165: AgentsFun1 -> Jinn (COMPLETE)

1. Unstake from AgentsFun1 — TX: `0x07489d16...`
2. Fund Master Safe — 5,050 OLAS
3. Patch ServiceManagerToken
4. Terminate — TX: `0xcff76568...`
5. Unbond — TX: `0xe59f1574...`
6. Update/re-register — TX: `0x7f86fa01...` (5,000 OLAS bond)
7. Approve OLAS + Activate — TX: `0x127baad9...`
8. Fund Master Safe — ~4,900 OLAS
9. Register agents + Deploy — middleware POST
10. Deposit staking rewards — 50 OLAS
11. Stake in Jinn — middleware POST

### Service 165: Restake after eviction (COMPLETE, Feb 2026)

1. Unstake (evicted) — TX: `0x531dae52...` (via Safe SDK, worked)
2. Approve NFT — TX: `0x10373185...` (via Safe SDK, worked)
3. Stake in Jinn — TX: `0x1943053a...` (via direct ethers.js — Safe SDK failed with GS013)

Final: `getServiceIds()` = `[379, 359, 378, 165]`, staking state = 1 (Staked)

### Service 359: AgentsFun1 -> Jinn (COMPLETE)

Hybrid approach: middleware handled terminate/unbond/update, manual ethers.js for remaining steps.

1. Middleware PATCH + POST — terminate, unbond, update bond
2. Manual: Approve OLAS — TX: `0xe1c8d7e1...`
3. Manual: Activate — TX: `0x6c6dde76...`
4. Manual: Register — TX: `0xf69e03a3...`
5. Manual: Deploy (recovery_module) — TX: `0x0a802fcd...`
6. Manual: Approve NFT — TX: `0x52c3bafb...`
7. Manual: Stake — TX: `0xf02f2f7f...`

### Service 359: Restake after eviction (COMPLETE, Feb 2026)

1. Unstake (evicted) — TX: `0x24b68165...` (via Safe SDK fallback to direct ethers.js)
2. Approve NFT — TX: `0xa189d16f...` (via Safe SDK, worked)
3. Stake in Jinn — TX: `0x6fae7b86...` (manual script, public RPC — Tenderly hung on send)

Gotchas encountered:
- Wrong `.operate` profile used initially (service 165's keys instead of 359's) — caused silent revert
- `OPERATE_PROFILE_DIR=jinn-node/.operate` doubled to `jinn-node/jinn-node/.operate` — use absolute path
- Tenderly RPC hung on TX send — switched to `base.publicnode.com` for both read and write

Final: `getServiceIds()` includes 359, staking state = 1 (Staked)

### Services 359, 387, 388, 389, 390: Batch restake after eviction (COMPLETE, March 2026)

All 5 services were evicted from Jinn staking. Service 165 was still staked.

1. Discovered `migrate-staking-contract.ts` ethers.js fallback had a bug: sent empty `data: ""` for approve (calldata not passed through)
2. Created dedicated `scripts/restake-service.ts` with batch support (`--service-id=387,388,389,390`)
3. Restaked 359 separately (different .operate profile / Safe)
4. Restaked 387, 388, 389, 390 in batch via Oak's .operate profile
5. Whitelisted all mechs via `scripts/activity-checker-whitelist.ts add --from-staking`

Key learnings:
- Safe SDK GS013 affects BOTH `approve()` and `stake()` (not just stake as previously thought)
- Services 372, 375, 378, 379, 392 are evicted but owned by OTHER Safes — cannot restake them
- Jinn staking contract: 10 max slots, 6 used after restake

Final: `getServiceIds()` = [165, 359, 387, 388, 389, 390], all staking state = 1 (Staked)
