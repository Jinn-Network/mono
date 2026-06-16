# Workstream B — rung 1 goal: native-JINN Cosmos EVM devnet

This file is the goal-prompt for an autonomous Claude Code session. Read it, plan
against the live environment, then execute to a green `check.sh`. It implements
GitHub issue [#1133](https://github.com/Jinn-Network/mono/issues/1133).

## Mission (the only definition of done)

A new top-level `chain/` directory, committed, such that on a clean clone:

```
cd chain && ./up.sh && ./check.sh
```

`check.sh` exits `0` **iff ALL** of the following hold:

1. `evmd` is built from `cosmos/evm` @ tag `v0.7.0`.
2. A single-node devnet is live with the EVM JSON-RPC on `:8545`.
3. The chain's **base denom — gas + staking + value — is JINN**, minted at genesis.
4. `eth_chainId` returns `0x40000` (262144).
5. One JINN transfer settles.
6. The recipient's balance, **read back over the EVM JSON-RPC** (bank precompile
   or an `x/erc20` token-pair view — **not** the Cosmos query CLI), reflects the
   transfer.

If `check.sh` exits 0 on a clean clone, the seed is done. Stop there.

## Why JINN is native, not a contract

The sovereign chain (see [`../docs/2026-06-09-simplified-launch-logic.md`](../docs/2026-06-09-simplified-launch-logic.md) §13
and [`../spec/2026-06-05-independent-blockchain-launch.md`](../spec/2026-06-05-independent-blockchain-launch.md))
makes **JINN a native `x/bank` coin** — the single source of truth for value,
gas, and staking — surfaced to the EVM via a bank/ERC-20 precompile so existing
Solidity contracts can treat it as `IERC20`. There is **one balance, two views.**

Therefore: do **not** deploy `JINN.sol` as an ERC-20 on the EVM module. That would
be a different token that isn't the chain's gas/stake/value asset — a dead-end.
JINN is the chain's base denom, defined in genesis.

## What the substrate spike already established

[`../spec/2026-06-08-substrate-spike-cosmos-evm.md`](../spec/2026-06-08-substrate-spike-cosmos-evm.md)
(Decided — Cosmos EVM) confirmed, empirically, on `evmd` v0.7.0:

- `git clone https://github.com/cosmos/evm`, tag `v0.7.0` ("Krakatoa"),
  `make install` → `evmd` (cosmos-sdk v0.54.3). Built with no patches.
- The shipped `./local_node.sh` brings up a single-node devnet, EVM JSON-RPC on
  `:8545`, EVM chain-id **262144 (0x40000)**.
- Cosmos EVM ships stateful precompiles for staking, gov, distribution, **bank**,
  IBC, and **ERC20**, at the `0x…0100 / 0400 / 0800` address range — they never
  collide with normal EVM contract address space.

The spike proved EVM **contract** fidelity. It did **not** exercise the native
bank-coin or the precompile read path — that is precisely what this rung exists
to de-risk, so expect the genuinely new work to live there.

## The unknown this rung must resolve

The spike used the **stock** `local_node.sh` denom and read state via deployed
contracts. This rung changes two things the spike did not:

1. **Base denom = JINN.** `local_node.sh` sets a base/stake denom (e.g.
   `atest` / `aevmd` / `stake`). Re-point it to a JINN denom at genesis. Match EVM
   wei semantics (18-decimal `a`-prefixed base denom, display `JINN`) so the EVM
   view and the bank view agree on magnitude. Establish the exact config; do not
   assume the variable name.
2. **Reading the native balance over EVM JSON-RPC.** Pick the simplest reliable
   path and document it in `up.sh`/`check.sh`:
   - the **bank precompile** (fixed address, `balances`/`balanceOf` via
     `eth_call`), or
   - register an **`x/erc20` token pair** so the denom gets an ERC-20 contract
     address with a standard `balanceOf`.

   The reason the read must go over EVM JSON-RPC, not the Cosmos CLI: known bug
   **#1198** — `evmd query` fails on stock `local_node.sh` at v0.7.0. Every
   acceptance check above is EVM-RPC-side, so #1198 does not gate this rung.
   **Do not rabbit-hole on #1198.**

## Deliverables (committed under `chain/`)

- `up.sh` — clone/build `evmd` @ v0.7.0 (cache the build; idempotent), configure
  genesis so the base denom is JINN, start the single-node devnet.
- `check.sh` — assert the six conditions above; exit non-zero with a clear message
  on the first failure. This is the acceptance gate; keep it honest.
- A short `chain/README.md` — how to run, the denom decision, and the chosen
  EVM-read path (bank precompile vs `x/erc20` pair), with the exact addresses.
- Pin versions explicitly (the `cosmos/evm` tag, `evmd`/SDK versions). Do not
  float to `main` or an RC.

## Hard fences (out of scope — do not cross)

- No `JINN.sol` on the EVM module.
- No veJINN / gauge / router / activity-checker; no lock → vote → tick (rungs 2–3).
- No validator-set / consensus changes beyond the stock single node.
- No genesis cold-start params (validator count, voting-power caps).
- No bake-to-node / custom Go module / custom precompile work.

If you find yourself doing any of these, you have left rung 1 — stop and report.

## Process

This is a `feat` (see the engineering handbook): write a short plan first
(`writing-plans`), drive `check.sh` as the failing acceptance test before it
passes (test-first), and run `verification-before-completion` before claiming
done — paste the actual `./up.sh && ./check.sh` output, exit code included.

**Babysit clause — do not fabricate.** The fragile stage is the Go build and the
devnet bring-up. If `make install` fails, `local_node.sh` won't start, or the
RPC never answers, **stop and report the exact error** — do not paper over a dead
chain with a "running" claim. A red `check.sh` reported honestly is success for
the session; a green claim over a broken devnet is failure.

## When rung 1 is green

Open a PR targeting `next` (title prefix `feat:`), reference #1133, and stop.
Rungs 2–3 (veJINN/gauge/router pointed at the JINN precompile address, then the
bit-identical lock→vote→tick gate from the spike's §5) are separate issues.
