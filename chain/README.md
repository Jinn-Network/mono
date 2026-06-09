# chain — native-JINN Cosmos EVM devnet (Workstream B, rung 1)

A reproducible single-node [Cosmos EVM](https://github.com/cosmos/evm) devnet
whose **native base coin — gas, staking, and value — is JINN**. The seed for the
sovereign chain (Gall's Law: the smallest working system the rest grows from).
Implements issue [#1133](https://github.com/Jinn-Network/mono/issues/1133); see
[`RUNG-1-GOAL.md`](RUNG-1-GOAL.md) for the brief and
[`../docs/2026-06-09-simplified-launch-logic.md`](../docs/2026-06-09-simplified-launch-logic.md)
§13 for why JINN is native rather than an EVM contract.

## Run

```bash
cd chain
./up.sh        # build evmd (first run only), init JINN genesis, start the node
./check.sh     # acceptance gate — exits 0 iff all six conditions hold
./down.sh      # stop the node
```

First `./up.sh` compiles `evmd` from source (a full Cosmos SDK app — minutes, once;
cached in `.build/`). Subsequent runs reuse the binary and chain state.
`FRESH=1 ./up.sh` wipes chain state and re-inits genesis.

Requires: Go, `make`, `jq`, `git`, and Foundry's `cast` on PATH.

## What it stands up

- **Substrate:** `cosmos/evm` @ `v0.7.0`, built to `.build/bin/evmd`.
- **Native coin:** base denom `ajinn` (18-dec; the `a`/atto prefix makes
  1 `ajinn` == 1 wei, so the bank and EVM views agree on magnitude), display
  `jinn`, symbol `JINN`. Set as `bond_denom` / `evm_denom` / `mint_denom` and the
  bank metadata in genesis.
- **One balance, two views:** the native coin is registered as a standard ERC-20
  via an `x/erc20` token pair at the fixed address
  `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`. Solidity / `cast` read JINN there
  with `balanceOf` / `symbol` / `decimals`; a native value transfer is reflected
  in that ERC-20 balance.
- **EVM JSON-RPC:** `http://127.0.0.1:8545`, `eth_chainId` = `262144` (`0x40000`).

All state reads go over the EVM JSON-RPC (or the on-disk `genesis.json`), never
the Cosmos query CLI — that path is broken on v0.7.0
([#1198](https://github.com/Jinn-Network/mono/issues/1198)) and does not gate
anything here.

## Acceptance (`check.sh`)

1. `evmd` built from `cosmos/evm` `v0.7.0`.
2. Devnet live, JSON-RPC on `:8545`, past block 1.
3. Base denom = JINN — genesis `evm/bond/mint` denom = `ajinn`, and the EVM view
   reports `symbol() = JINN`, `decimals() = 18`.
4. `eth_chainId` = `0x40000`.
5. A JINN transfer settles (receipt status success).
6. The recipient's ERC-20 balance increases by exactly the transferred amount.

## Out of scope (rungs 2–3, separate issues)

No veJINN / gauge / router / checker, no lock→vote→tick, no validator-set or
genesis cold-start params, no bake-to-node / custom precompiles. The protocol
Solidity contracts reconnect at rung 2, pointed at the JINN ERC-20 address above
instead of a deployed token.

## Layout

| Path | Role |
|---|---|
| `up.sh` | build + genesis + start + wait-ready |
| `check.sh` | the six-assertion acceptance gate |
| `down.sh` | stop the node |
| `lib.sh` | shared config (denom, addresses, dev keys, pins) |
| `RUNG-1-GOAL.md` | the goal brief |
| `.build/` | evmd source, binary, chain home, logs (git-ignored) |

Dev keys in `lib.sh` are the public Cosmos EVM test mnemonics — **testnet only**.
