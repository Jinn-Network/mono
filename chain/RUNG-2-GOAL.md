# Workstream B — rung 2 goal: veJINN lock on native JINN

Goal-prompt for an autonomous Claude Code session. Read it, plan against the live
environment, execute to a green gate. Implements issue [#1135](https://github.com/Jinn-Network/mono/issues/1135).
Builds directly on rung 1 ([RUNG-1-GOAL.md](RUNG-1-GOAL.md), PR #1134).

## Mission (definition of done)

Reusing the rung-1 devnet, on a clean run:

```
cd chain && ./up.sh && ./rung2.sh
```

`rung2.sh` exits `0` **iff ALL** of the following hold:

1. veJINN (`veOLAS`) is deployed against the live devnet with `token()` == the
   native JINN ERC-20 precompile `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`.
   **No `JINN.sol` is deployed** — the token is the native coin.
2. A locker `approve`s veJINN on the precompile and `createLock(amount, unlockTime)`
   succeeds.
3. Escrow is proven on both sides: the locker's native JINN balance dropped by
   `amount`, and veJINN's JINN balance (precompile `balanceOf`) rose by `amount`.
4. veJINN lock state reflects it: locked `amount` == `amount`, `lockedEnd` is in
   the future, and the locker's ve balance (`balanceOf`) > 0.
5. Fidelity: a `createLock` exceeding the approved allowance **reverts** — the
   precompile enforces allowance for a contract spender.

Stop when green. Rungs 3+ (gauge, router, lock→vote→tick) are separate issues.

## Why this rung, and what's already de-risked

ve-JINN is the bonding primitive that directs emissions (§3 of
[`../docs/2026-06-09-simplified-launch-logic.md`](../docs/2026-06-09-simplified-launch-logic.md))
and a required testnet component (§9). The unknown it isolates: **a
JINN-consuming Solidity contract working when JINN is the native precompile, not
a deployed ERC-20.** `veOLAS.createLock` pulls tokens with
`IERC20(token).transferFrom(msg.sender, address(this), amount)`
([`../contracts/src/vendor/governance/veOLAS.sol`](../contracts/src/vendor/governance/veOLAS.sol):364),
so the locker `approve`s veJINN, then `createLock` does the `transferFrom`.

**Already confirmed by recon on the rung-1 devnet:** the native precompile
honours `approve` / `allowance` / `transferFrom` at the EOA level — allowance was
set, decremented by the exact `transferFrom` amount, and balances moved exactly.
So the ERC-20 surface works. The residual unknowns this rung closes:

- the **contract-as-spender** path (veJINN as `msg.sender` of `transferFrom`), and
- veOLAS calls `transferFrom` **without checking the return value** (line 363
  comment: relies on "returns true or reverts"). Confirm the precompile reverts
  on failure rather than returning `false` silently — otherwise an unchecked
  failure could mint ve-balance without escrow. The escrow-both-sides assert (3)
  is what catches that.

## Key facts to build on

- **veJINN = `veOLAS`**, `contracts/src/vendor/governance/veOLAS.sol`.
  Constructor: `constructor(address _token, string name, string symbol)`;
  `token` is immutable. Entry points: `createLock(uint256 amount, uint256 unlockTime)`.
  `unlockTime` is an absolute timestamp, rounded down to whole weeks, must be
  `> now` and `<= now + MAXTIME` (~4 years). Use e.g. `now + 365 days`.
- **Toolchain:** the repo's Hardhat project at `contracts/` already compiles
  these contracts (`yarn hardhat compile`). Deploy with ethers v6 via a Hardhat
  script (pattern: `contracts/scripts/lib/deploy-helpers.ts` deploys
  `veOLAS` as `VeOLAS.deploy(token, name, symbol)` — reuse it, but pass the
  **native precompile address** as `token`, not a deployed JINN).
- **Pointing Hardhat at the devnet:** `contracts/hardhat.config.ts` has a
  `localhost` network (`url: LOCAL_RPC_URL || http://127.0.0.1:8545`,
  `chainId: LOCAL_CHAIN_ID || 31337`). Run with `LOCAL_RPC_URL=http://127.0.0.1:8545`
  and `LOCAL_CHAIN_ID=262144` (must match the node's `eth_chainId`, else Hardhat
  errors on chainId mismatch). The `localhost` network has **no `accounts`** — add
  `accounts: process.env.LOCAL_PRIVATE_KEY ? [process.env.LOCAL_PRIVATE_KEY] : []`
  (surgical config edit) and pass the deployer key.
- **Deployer:** dev0 from [`lib.sh`](lib.sh) (`DEV0_PRIV` / `DEV0_ADDR`), funded
  with native JINN in the rung-1 genesis.
- **JINN ERC-20:** `NATIVE_ERC20=0xEeee…eEEeE` (in `lib.sh`). `balanceOf` /
  `approve` / `allowance` / `transferFrom` / `decimals(18)` / `symbol(JINN)` all work.

## Suggested shape (yours to refine)

- `contracts/scripts/deploy-vejinn-native.ts` — Hardhat script: deploy
  `veOLAS(NATIVE_ERC20, "Voting Escrow JINN", "veJINN")`, then `approve` +
  `createLock` from dev0, then the assertions (3)–(5). Exit non-zero on any
  failed assertion. Record the veJINN address.
- `chain/rung2.sh` — thin wrapper: ensure the devnet (`./up.sh`), then run the
  Hardhat script with the env above. This is the acceptance gate; keep it honest.

## Hard fences (do not cross)

- No gauge / `VoteWeighting`, no router / checker, no lock→vote→tick (rung 3).
- No `JINN.sol` deployed — token is the native precompile.
- No genesis / validator / consensus changes — reuse the rung-1 chain unchanged.
- No bake-to-node / custom precompile work.

If you're doing any of these, you've left rung 2 — stop and report.

## Process

`feat` (engineering handbook): write `rung2.sh` / the assertion script as the
failing gate first, then implement the deploy + lock to green; run
`verification-before-completion` before claiming done — paste the actual
`./up.sh && ./rung2.sh` output, exit code included.

**Babysit clause — do not fabricate.** The novel surface is the contract-as-spender
`transferFrom`. If `createLock` reverts, or "succeeds" without moving JINN
(unchecked-return failure), **stop and report the exact precompile behaviour** —
do not claim a lock that didn't escrow. A clear finding that the
contract-spender path is unsupported or misbehaves is a **valid rung-2 outcome**:
document it, file the workaround issue, and stop. Do not hack around it.

## Stacking / when green

This branch is stacked on rung 1 (`feat/1133-cosmos-evm-seed`) for the `chain/`
harness. If PR #1134 has merged to `next`, rebase onto `next`. Open a PR
(title prefix `feat:`) targeting `next`, referencing #1135, and stop.
