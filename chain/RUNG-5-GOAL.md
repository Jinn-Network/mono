# Workstream B — rung 5 goal: Cosmos-native surfaces

Goal-prompt for an autonomous Claude Code session. Read it, plan against the live
environment, execute to a green gate. Implements issue [#1143](https://github.com/Jinn-Network/mono/issues/1143).
Builds on rungs 1–4 (native-JINN chain, veJINN lock, closed loop, JINN as
consensus stake).

## Mission (definition of done)

Exercise the **Cosmos-native** surfaces of the rung-1 devnet — CometBFT RPC on
`:26657`, SDK REST/LCD on `:1317`, and the SDK CLI tx path (`evmd tx bank send`)
— and either prove they work or document the exact failure as a finding. On a
clean run:

```
cd chain && ./rung5.sh
```

`rung5.sh` exits `0` **iff ALL** of the following hold:

1. CometBFT `/status` returns block height ≥ 1 and `network == "9001"`.
2. CometBFT `/validators` returns ≥ 1 validator.
3. CometBFT `/block?height=1` returns height = 1.
4. `app.toml`'s `[api].enable` and `[grpc].enable` are both `true` (operational
   guard against silent regression in `up.sh`'s sed pattern).
5. SDK REST `/cosmos/bank/v1beta1/balances/{dev0_bech32}` returns the `ajinn`
   amount, AND it equals `cast call NATIVE_ERC20 balanceOf(dev0)` on `:8545`
   ("one balance, two views" per [`docs/2026-06-09-simplified-launch-logic.md`](../docs/2026-06-09-simplified-launch-logic.md) §13).
6. `evmd tx bank send dev0 mykey 1ajinn …` returns `code=0` and a tx hash; the
   SDK REST `/cosmos/tx/v1beta1/txs/{hash}` confirms `code=0`; the post-tx
   EVM/bank views still agree.

Stop when green.

## Why this rung

Rungs 1–4 tested the chain only through the EVM JSON-RPC (`cast`/`ethers` on
`:8545`), avoiding the Cosmos query CLI due to [#1198](https://github.com/Jinn-Network/mono/issues/1198).
CometBFT RPC, SDK REST/gRPC query, and the SDK CLI tx path were untested. Per
[`docs/2026-06-09-simplified-launch-logic.md`](../docs/2026-06-09-simplified-launch-logic.md)
§6 (sovereign Cosmos) and §12, the chain must work natively — not just through
the EVM shim. Validators, governance, and (later) IBC all live Cosmos-side.

## The landmine (recon already done — don't rediscover it)

- **`evmd query` is broken on v0.7.0 (#1198).** Rung 5 uses **only** raw `curl`
  against `:26657` and `:1317`, plus `evmd tx` (tx subtree) and `evmd keys` (keys
  subtree — independent of the broken `query` subtree).
- **REST/gRPC ports are enabled by `up.sh`'s sed pass** (line 86:
  `sed 's/enable = false/enable = true/g; s/enabled = false/enabled = true/g'`)
  — but a regression in that sed would silently disable them. The script asserts
  both `[api].enable` and `[grpc].enable` are `true`.
- **`evmd tx bank send` is independent of #1198** and works end-to-end. The send
  path uses Cosmos-native signing and inclusion; the REST tx-receipt query
  confirms the bank module credited the recipient.
- **Bank balances are 21-digit integers** (1e21 ajinn ≈ 1000 JINN). `[ "$x" -gt 0 ]`
  overflows bash's 64-bit comparison; use string comparison (`[ "$x" != "0" ]`).

## Operational note

Rung 5 does NOT change genesis; do NOT use `FRESH=1`. `up.sh`'s reuse-guard
([`up.sh:20`](up.sh)) reuses any running rung-1–4 devnet. Run rung 4 LAST in a
session (it re-inits a fresh chain with the staking precompile), since rung 5
reuses whatever chain is already serving.

If the running chain is from a sibling worktree (common during stacked work),
`rung5.sh` discovers the running `evmd` binary and `--home` from `ps` output,
copies the binary locally, and signs from the public dev mnemonics
(`DEV0_MNEMONIC` / `VAL_MNEMONIC` from [`lib.sh`](lib.sh)) — no rebuild, no
re-init.

## Key facts to build on

- **CometBFT RPC** default port: `:26657` (JSON over HTTP, no auth).
- **SDK REST (LCD)** default port: `:1317`; gRPC: `:9090`.
- `dev0` and `mykey` bech32 are derived live: `evmd keys show <name> -a
  --keyring-backend test --home "$CHAINHOME"`.
- Validator bech32 (from [`rung4.sh:11`](rung4.sh)):
  `cosmosvaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pw4xyrql`.
- All amounts in `ajinn` (1e18 ajinn = 1 JINN); the node runs with
  `--minimum-gas-prices=0ajinn`, so any non-zero fee works.

## Suggested shape (yours to refine)

Mirror [`check.sh`](check.sh)'s `ok` / `no` / `chk` PASS-FAIL idiom; `pass=0` /
`fail=0` counters; final `[ "$fail" -eq 0 ]` exit. Subcheck order:

1. CometBFT (status → validators → block)
2. `app.toml` enable bits (operational guard)
3. SDK REST bank query (dual-view equality)
4. `evmd tx bank send` → SDK REST tx receipt → post-tx dual-view

Each subcheck prints PASS/FAIL independently so a partial-red run still shows
which surfaces work.

## Hard fences (do not cross)

- **Do not fix #1198.** The broken `evmd query` subtree is a separate issue.
  Rung 5 routes around it; it does not repair it.
- **No validator-set changes.** Single genesis validator only.
- **No genesis tweaks. No `FRESH=1`.** Rung 5 reads through running surfaces.
- **No new SDK modules**, no IBC bring-up, no governance proposal, no slashing
  execution, no `JINN.sol`, no contract deploys.
- **No CI integration.** Rung 5 is run manually like rungs 1–4.

If you're doing any of the above, you've left rung 5 — stop and report.

## Process

`spike` (engineering handbook): output is a finding — the script, this doc, and
the captured `./rung5.sh` transcript. If subchecks 5a/5b fail, paste the verbatim
stderr from `BUILD_DIR/rung5-tx.stderr` into `## Findings` below and reference it
in the PR body and the #1143 issue comment. A documented failure is a valid
spike outcome.

## Findings (post-execution)

All ten subchecks PASS on the running devnet (rung-4's `FRESH=1` chain, chain id
`262144`, network `9001`). The Cosmos-native surfaces — CometBFT RPC (`:26657`),
SDK REST API (`:1317`), and the SDK CLI tx path (`evmd tx bank send`) — are
functional end-to-end on cosmos/evm v0.7.0. Issue [#1198](https://github.com/Jinn-Network/mono/issues/1198)
is confined to the `evmd query` subtree, not the `tx` or `keys` subtrees, and
not the REST/gRPC SDK surface.

```
$ ./rung5.sh
[up] reusing running node on http://127.0.0.1:8545 (chain 262144)
== rung-5 acceptance (Cosmos-native surfaces) ==
  PASS  1. CometBFT /status reachable (network=9001 height=12917)
  PASS  2. CometBFT /validators returns >= 1 validator (got: 1)
  PASS  3. CometBFT /block?height=1 returns height=1 (got: 1)
  PASS  4a. app.toml [api].enable=true (got: enable=true)
  PASS  4b. app.toml [grpc].enable=true (got: enable=true)
  PASS  4c. SDK REST bank balance for dev0 (cosmos1cml96vmptgw99syqrrz8az79xer2pcgp95srxm) returns ajinn amount
  PASS  4d. EVM balanceOf(dev0) == bank balance
  PASS  5a. evmd tx bank send accepted (code=0 hash=…)
  PASS  5b. SDK REST /cosmos/tx/v1beta1/txs/{hash} returns code=0 (got: 0)
  PASS  5c. post-tx EVM view == bank view
== 10 passed, 0 failed ==
```

The dual-view equality holds before AND after the SDK-side bank send — both the
EVM ERC-20 view and the bank module view debit by exactly the (send + fee)
amount in `ajinn`. The "one balance, two views" claim from §13 is end-to-end
falsifiable.

## When green

Open a PR titled `spike(chain): validate Cosmos-native surfaces (rung 5)`,
reference #1143, paste the `./rung5.sh` output (PASS lines + exit code) into the
PR body, and stop.
