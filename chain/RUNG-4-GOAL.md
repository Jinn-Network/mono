# Workstream B — rung 4 goal: JINN as consensus stake

Goal-prompt for an autonomous Claude Code session. Read it, plan against the live
environment, execute to a green gate. Implements issue [#1139](https://github.com/Jinn-Network/mono/issues/1139).
Builds on rungs 1–3 (native-JINN chain, veJINN lock, closed loop).

## Mission (definition of done)

Make JINN the **consensus** stake: delegate native JINN to the chain's validator
through the `x/staking` precompile and prove the bond. On a clean run:

```
cd chain && ./rung4.sh
```

`rung4.sh` exits `0` **iff ALL** of the following hold:

1. The **staking precompile** (`0x0000000000000000000000000000000000000800`) is
   active on the chain.
2. A delegation of N JINN from a funded account to the validator
   `cosmosvaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pw4xyrql`, **via the staking
   precompile**, succeeds.
3. The delegation reads back as bonded (>= N) via the precompile / EVM.
4. The delegator's native JINN balance fell by >= N.
5. Slashing params for JINN are present in genesis (`signed_blocks_window`,
   `slash_fraction_double_sign`, `slash_fraction_downtime`).

This proves the third of the doc's three locks (§3): JINN secures consensus, not
just governance (rung 2) and execution (rung 3). Stop when green.

## The landmine (recon already done — don't rediscover it)

Our chain's `active_static_precompiles` is currently **`[]`**. Rung-1 `up.sh`
swapped the denom but never set the precompile list (upstream `local_node.sh`
did). The native-JINN ERC-20 worked anyway because that's the `x/erc20` module's
*dynamic* precompile (a token pair), independent of the static list. **The
staking precompile is therefore NOT active.** Enabling it is the first task:

- Add to `up.sh`'s genesis init a `setg` line setting
  `.app_state.evm.params.active_static_precompiles` to the upstream set
  (`0x…0100, 0400, 0800, 0801, 0802, 0803, 0804, 0805, 0806, 0807`). `0x…0800`
  is staking.
- This is a **genesis change**, so the running rung-1 devnet (which lacks it)
  must be replaced — see Operational note.

## Operational note (genesis changes → fresh chain)

`up.sh`'s reuse-guard skips startup if *any* chain-id-262144 node is already
serving — but the running rung-1 node has the old genesis (no staking precompile).
So:

1. Stop the running devnet first: `../1133-cosmos-evm-seed/chain/down.sh` (or
   whichever worktree started it), or kill the `evmd` on `:8545`.
2. This worktree's `.build` is empty — to skip the ~10-min evmd rebuild, copy the
   prebuilt binary: `mkdir -p chain/.build/bin && cp
   ../1133-cosmos-evm-seed/chain/.build/bin/evmd chain/.build/bin/`.
3. `FRESH=1 ./up.sh` — re-inits genesis (now with the staking precompile) and
   starts the node.

`rung4.sh` should encode this: stop any stale node, ensure the binary, `FRESH`
re-init when the genesis lacks the precompile.

## Key facts to build on

- **Staking precompile interface:** read `chain/.build/evm/precompiles/staking/`
  for the exact Solidity ABI. Expect roughly `delegate(address delegator, string
  validatorAddress, uint256 amount)` and `delegation(address delegator, string
  validatorAddress) → (shares, balance)`. The validator is a **bech32 string**
  (`cosmosvaloper…`); the delegator is the EVM address (mapped to its cosmos
  account). Confirm the real signatures from the source — do not assume.
- **Validator:** `cosmosvaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pw4xyrql` (the
  single genesis validator; `mykey`/`dev0` are the funded accounts in
  [`lib.sh`](lib.sh)).
- **Denoms/amounts:** bond denom is `ajinn` (18-dec); delegate in `ajinn` (wei).
- **Reads over EVM:** call the precompile via `cast`/ethers over the JSON-RPC.
  The Cosmos query CLI is broken on v0.7.0 (#1198) — do not depend on it.
- **Slashing:** params already in genesis (5% double-sign, 1% downtime) — assert
  their presence by reading `genesis.json` on disk (not the CLI).

## Suggested shape (yours to refine)

- Extend `up.sh` genesis init with the `active_static_precompiles` line.
- `chain/rung4.sh` — stop stale node / ensure binary / `FRESH` up, then run the
  delegation + assertions. The staking-precompile calls are simplest via `cast`
  (`cast send 0x…0800 "delegate(...)" …` and `cast call` for `delegation`), or a
  small Hardhat/ethers script if you prefer typed ABIs. Fresh nothing-special
  account is fine; `dev0` is already funded.

## Hard fences (do not cross)

- **One validator** — delegate to the existing one. No second validator, no
  multi-validator consensus.
- **No slash execution** — only confirm slashing is *configured*.
- No genesis cold-start economics (validator-count / voting-power caps, the
  published neutrality threshold) — that's the irreversible launch step, later.
- No mech marketplace, no tokenomics stack, no `JINN.sol`.

If you're doing any of these, you've left rung 4 — stop and report.

## Process

`feat` (engineering handbook): write `rung4.sh` / the assertion gate as the
failing test first, then implement to green; run `verification-before-completion`
before claiming done — paste the actual `./rung4.sh` output and exit code.

**Babysit clause — do not fabricate.** The novel surface is the staking precompile
delegation from an EVM account. If `delegate` reverts, the EVM→cosmos delegator
mapping doesn't resolve, or the delegation won't read back, **stop and report the
exact behaviour**. A clear finding (e.g. "the staking precompile can't delegate
from a bare EVM EOA; it needs a Cosmos-side tx") is a **valid outcome** — document
it and report. Never claim a bond that didn't happen.

## Stacking / when green

Stacked on rung 3 (`feat/1137-close-loop-native`). Rebase down the stack toward
`next` as #1134/#1136/#1138 merge. Open a PR (title `feat:`) referencing #1139,
base the lowest unmerged ancestor (or `next` once the stack has merged), and stop.

---

After this rung, what remains is genuinely new and separately scoped: a **second
validator + real multi-validator consensus**, **executing a slash**, and the
**irreversible genesis cold-start economics**. Each is its own rung — do not pull
them in here.
