# Jinn testnet JINN faucet — deploy + seed runbook

An L2 admin stash for testnet JINN. Not wired into operator bootstrap.

**Why this exists:** L2 JINN is an `OptimismMintableERC20` — supply can only
grow via L1→L2 bridging, which is slow and admin-gated. This contract lets the
Jinn team keep a pre-bridged pool of testnet JINN on Base Sepolia without
manually re-bridging for every allocation. From here the admin can:

- Top up the stOLAS `ExternalStakingDistributor` so `distributor.stake()` has
  capital for operator service creation (testnet has no real L1 stakers yet,
  so the distributor pool must be seeded manually).
- Drip JINN to a recipient via `drip(recipient)` — rate-limited per recipient.
  Reserved for any future user-facing testnet flow (e.g. a staker UX) — the
  current `jinn bootstrap` does NOT call this.

This document explains how to deploy the faucet once, seed it with JINN, and
refill it when it runs low.

## One-time prerequisites

- `DEPLOYER_PRIVATE_KEY` — the JINN deployer key (mint authority on L1, deployer
  of existing phase1a/phase1b artifacts).
- `BASE_SEPOLIA_RPC_URL` and `SEPOLIA_RPC_URL` — set in `contracts/.env`.
- `foundry` installed (`cast` is used for the L1 mint + bridge steps).

## Step 1 — deploy the faucet on Base Sepolia

```bash
cd contracts
npx hardhat run scripts/deploy-jinn-testnet-faucet.ts --network baseSepolia
```

Outputs `contracts/deployment-jinn-testnet-faucet-baseSepolia.json` and copies it
into `client/deployments/deployment-jinn-testnet-faucet-baseSepolia-fast.json`.

Capture `FAUCET` from the "deployed to" line for the next steps.

## Step 2 — bridge JINN from Sepolia L1 to Base Sepolia L2

The L2 JINN token is an `OptimismMintableERC20`: L2 supply can only grow via
L1→L2 deposits. Mint L1 JINN, approve the L1 StandardBridge, and deposit.

```bash
# Addresses (Sepolia)
L1_JINN=0xc3ae831f146Eabbb8095E1EDf90a187AA4E5F408        # Jinn ERC20, owner/minter = DEPLOYER
L2_JINN=0xAB9a01cd4A379e36006ec6df2960CF39EF79df63        # OptimismMintableERC20 on Base Sepolia
L1_STANDARD_BRIDGE=0xfd0Bf71F60660E2f608ed56e1659C450eB113120   # canonical Base Sepolia bridge on Sepolia

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
AMOUNT=10000ether   # 10,000 JINN — 100 drips of runway

# A) Mint L1 JINN to the deployer
cast send "$L1_JINN" "mint(address,uint256)" "$DEPLOYER" "$AMOUNT" \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$SEPOLIA_RPC_URL"

# B) Approve the L1 StandardBridge to spend the newly-minted supply
cast send "$L1_JINN" "approve(address,uint256)" "$L1_STANDARD_BRIDGE" "$AMOUNT" \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$SEPOLIA_RPC_URL"

# C) Bridge L1 → L2 (deposit lands on L2 within ~3 minutes)
cast send "$L1_STANDARD_BRIDGE" \
  "depositERC20(address,address,uint256,uint32,bytes)" \
  "$L1_JINN" "$L2_JINN" "$AMOUNT" 200000 0x \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$SEPOLIA_RPC_URL"

# Wait ~3 minutes, then verify L2 supply arrived at the deployer:
cast call "$L2_JINN" "balanceOf(address)(uint256)" "$DEPLOYER" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
# expected: 10000000000000000000000 (10k JINN)
```

> **Verify the bridge address before the first run.** Different Optimism-stack
> testnets use different bridge addresses. For Base Sepolia, check
> https://docs.base.org/base-chain/network-information/base-sepolia-testnet for
> the current `L1StandardBridgeProxy` on Sepolia and substitute above if the
> value has drifted.

## Step 3 — transfer bridged JINN into the faucet

```bash
cast send "$L2_JINN" "transfer(address,uint256)" "$FAUCET" "$AMOUNT" \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$BASE_SEPOLIA_RPC_URL"

# Verify
cast call "$FAUCET" "balance()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
# expected: 10000000000000000000000
```

## Step 4 — update the deployment artifact's `initialSupplyBridged`

Edit `contracts/deployment-jinn-testnet-faucet-baseSepolia.json` and
`client/deployments/deployment-jinn-testnet-faucet-baseSepolia-fast.json` so
`config.initialSupplyBridged` reflects the seeded amount (e.g. `"10000000000000000000000"`).
Commit both files.

## Refilling the faucet

Repeat Steps 2 and 3 with whatever `AMOUNT` is needed. No redeploy required;
`lastDripAt` state is preserved across refills.

## Changing parameters

Only the contract owner can tune parameters:

```bash
# Increase drip to 200 JINN
cast send "$FAUCET" "setDripAmount(uint256)" $(cast --to-wei 200 ether) \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$BASE_SEPOLIA_RPC_URL"

# Shorten rate-limit to 1 hour
cast send "$FAUCET" "setDripInterval(uint256)" 3600 \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$BASE_SEPOLIA_RPC_URL"

# Migrate supply out of the contract (drain before retiring)
cast send "$FAUCET" "withdraw(address,uint256)" "$DEPLOYER" $(cast call "$FAUCET" "balance()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL") \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

## How it's wired into the client

The client's `ChainConfig` loader (`client/src/earning/contracts.ts`) resolves
the faucet address from the deployment JSON at
`JINN_TESTNET_FAUCET_DEPLOYMENT` (default: the bundled copy in
`client/deployments/`). The address is available to any code that wants it
via `cfg.jinnFaucet`, but `jinn bootstrap` / `jinn run` do not currently call
the faucet — the address is inventory only. If a future flow needs programmatic
drips, the plumbing is in place; there is no active call site today.

On mainnet this contract does not exist at all.

## Seeding the stOLAS distributor (the current reason the faucet exists)

On testnet there are no L1 stakers, so `ExternalStakingDistributor`'s balance
is zero and `distributor.stake()` reverts with `Overflow(required, available)`
when an operator calls `jinn bootstrap`. Seed it once per deployment:

```bash
# Withdraw from faucet into the distributor
cast send "$FAUCET" "withdraw(address,uint256)" "$DISTRIBUTOR_L2" 900ether \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$BASE_SEPOLIA_RPC_URL"

# Verify
cast call "$DISTRIBUTOR_L2" "balanceOf(address)(uint256)" "$DISTRIBUTOR_L2" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"    # typo-safe way: balanceOf on the token
cast call "$L2_JINN" "balanceOf(address)(uint256)" "$DISTRIBUTOR_L2" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
# expected: 900000000000000000000 (900 JINN), enough for 45 services at 20 JINN each
```

Each new operator consumes `minStakingDeposit * (1 + NUM_AGENT_INSTANCES) =
~20 JINN` at `distributor.stake()` time. Refill the distributor when it runs
low by repeating Step 2+3 of this runbook (bridge more from L1) and then
`withdraw` into the distributor again.

## Automated keeper (recommended)

Use `scripts/keep-distributor-seeded.ts` to check the pool on a schedule and
top it up from the faucet automatically. Safe to invoke as a cron job:

```bash
cd contracts
npx hardhat run scripts/keep-distributor-seeded.ts --network baseSepolia
```

Behavior:
- Reads current L2 JINN balance of the distributor.
- If ≥ `DISTRIBUTOR_FLOOR_JINN` (default 500), exits OK.
- Otherwise, withdraws from the faucet to bring the distributor to
  `DISTRIBUTOR_TARGET_JINN` (default 1000).
- If the faucet is itself too low, prints the exact `cast` commands needed
  to bridge more JINN from Sepolia L1, then exits non-zero so cron alerts.

Tunables (env vars):
- `DISTRIBUTOR_FLOOR_JINN` — don't act until below this (default: 500).
- `DISTRIBUTOR_TARGET_JINN` — top up to this level (default: 1000).
- `FAUCET_ADDRESS` / `DISTRIBUTOR_ADDRESS` / `L2_JINN_ADDRESS` — overrides;
  default to the deployed/bundled addresses.

Operators never invoke this script and never see the distributor directly;
it's purely a protocol-team operational tool.
