# Standard OLAS Setup

Use when stOLAS slots are full or distributor is not configured. Requires ~10,000 OLAS.

## Run setup

```bash
cd jinn-node
yarn setup 2>&1
```

## Funding requirements

- Master EOA: ~0.005 ETH (gas)
- Master Safe: ~0.01 ETH (operational gas) + **~10,000 OLAS** (5k deposit + 5k bond)

## Funding loop

When setup exits for funding:
1. Capture required address/amount from output
2. Ask operator to fund (OLAS: Uniswap Base or bridge from Ethereum mainnet)
3. Rerun `yarn setup`
4. Repeat until complete

Return to **Step 5** in SKILL.md.
