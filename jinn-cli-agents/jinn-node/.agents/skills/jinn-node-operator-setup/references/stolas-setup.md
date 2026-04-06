# stOLAS Setup

stOLAS uses the ExternalStakingDistributor so operators stake without providing OLAS. LemonTree depositors fund the capital. Only ETH is needed for gas.

## 1. Run stOLAS setup

```bash
cd jinn-node
yarn setup --stolas 2>&1
```

The `--stolas` flag handles the entire flow end-to-end:

1. Create Master EOA + Master Safe (if they don't exist)
2. **Capture the mnemonic** — relay to operator (see Step 5 in SKILL.md)
3. Exit requesting funding if Master EOA needs ETH
4. Operator funds Master EOA with ~0.01 ETH (excess automatically transfers to Master Safe)
5. Rerun `yarn setup --stolas 2>&1` — continues from where it left off
6. Preflight check (distributor + slots)
7. Generate new agent EOA
8. Route `stake()` through Master Safe → creates service on-chain
9. Discover serviceId + Safe
10. Store agent key + **back up key to `~/.jinn/key-backups/`** + import config
11. Fund agent EOA from Master Safe
12. Deploy mech via service Safe
13. Update config with mech address

> **Important:** Always use `yarn setup --stolas` — never `yarn setup` without the flag. The `--stolas` flag handles wallet and Safe creation itself. Running `yarn setup` (standard) would attempt OLAS staking.

> **Key backup:** Encrypted with `OPERATE_PASSWORD`. Inform the operator to store both the backup file and the password securely.

## 2. Funding

The operator only needs to fund **one address**: the Master EOA with ~0.01 ETH. During Safe creation, excess ETH automatically transfers to the Master Safe via `transfer_excess_assets`. The stOLAS bootstrap then cascades funds: Safe → Agent EOA → mech deployment.

If the setup exits requesting funding:
1. Note the Master EOA address printed
2. Send ~0.01 ETH to it
3. Rerun `yarn setup --stolas 2>&1`

## 3. If mech deployment fails

If mech deployment fails (insufficient Master Safe ETH):
```bash
npx tsx scripts/deploy-mech.ts --service-config-id=<id>
```

Return to **Step 5** in SKILL.md.
