# Rung 5 — Cosmos-Native Surfaces Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exercise the Cosmos-native surfaces of the rung-1 devnet (CometBFT RPC on `:26657`, SDK REST/LCD on `:1317`, and at least one Cosmos-native bank tx via `evmd tx`) and either prove they work or document the exact failure mode as a finding — satisfying issue [#1143](https://github.com/Jinn-Network/mono/issues/1143).

**Architecture:** Add `chain/rung5.sh` mirroring the existing `chain/check.sh` rung style: bring up the devnet via `chain/up.sh` (reuse-or-start, no FRESH), then run six PASS/FAIL subchecks against `:26657` (CometBFT RPC), `:1317` (SDK REST), and `evmd tx` (SDK CLI tx path). Reads use only `curl + jq`, avoiding the broken `evmd query` subtree (#1198). The script reports every subcheck so the operator can see exactly which surface broke even when one fails. Companion docs `chain/RUNG-5-GOAL.md` and a README paragraph match the rung 1–4 style.

**Tech Stack:** `bash`, `curl`, `jq`, `evmd` (Cosmos SDK CLI — `keys show`, `tx bank send`), the existing `chain/lib.sh` shared config, the running rung-1 devnet on `:8545 / :26657 / :1317`.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `chain/rung5.sh` | Create | Acceptance gate. Six PASS/FAIL subchecks across CometBFT RPC, SDK REST, and SDK CLI tx paths. Mirrors `chain/check.sh` ok/no/chk idiom. |
| `chain/RUNG-5-GOAL.md` | Create | Goal-prompt doc in the style of `RUNG-1-GOAL.md` … `RUNG-4-GOAL.md`. Mission / what's already de-risked / unknown / deliverables / hard fences / process. |
| `chain/README.md` | Modify | Add one line in the Usage block and one row in the Layout table for `rung5.sh`. |

**Files NOT modified:**
- `chain/up.sh` — already enables all APIs (`sed 's/enable = false/enable = true/g'` in §3 of up.sh) which covers `[api]`, `[grpc]`, and CometBFT RPC. We assert these, we do not configure them.
- `chain/lib.sh` — all needed config (CHAINHOME, EVMD, RPC_URL, BASE_DENOM, COSMOS_CHAIN_ID, DEV0 addr) is already exported. We add `COMETBFT_RPC` and `SDK_REST` as local constants inside `rung5.sh` rather than touch shared config.
- `chain/check.sh`, `chain/rung2.sh`, `chain/rung3.sh`, `chain/rung4.sh` — surgical scope. Rung 5 is additive.

---

## Pre-Flight — Read the Established Style

The implementer must read these before writing `rung5.sh` and `RUNG-5-GOAL.md`:

- [ ] **Step 1: Read existing rung scripts to mirror style**

Read in order:
- `chain/check.sh` (lines 1–68) — canonical `ok` / `no` / `chk` PASS/FAIL helpers, `pass=0; fail=0` counters, final `== $pass passed, $fail failed ==` summary, `[ "$fail" -eq 0 ]` as the exit gate. **`rung5.sh` mirrors this exactly.**
- `chain/rung2.sh` (lines 1–17) — minimal rung; `"$CHAIN_DIR/up.sh"` to ensure devnet, then run the assertions.
- `chain/rung3.sh` (lines 1–17) — same shape as rung2.
- `chain/rung4.sh` (lines 1–64) — the heavier rung; shows the `pkill -f "evmd start"` + `FRESH=1 ./up.sh` pattern (only used when genesis must change). **Rung 5 does NOT need FRESH** — we are reading and writing through running surfaces, not changing genesis.
- `chain/lib.sh` (lines 1–46) — confirm `CHAINHOME`, `EVMD`, `CHAIN_DIR`, `BASE_DENOM`, `COSMOS_CHAIN_ID`, `DEV0_ADDR`, `RPC_URL` are exported.

- [ ] **Step 2: Read existing RUNG-*-GOAL.md docs to mirror style**

Read in order:
- `chain/RUNG-1-GOAL.md` — full structure: Mission / Why / What's already de-risked / The unknown / Deliverables / Hard fences / Process / When green.
- `chain/RUNG-4-GOAL.md` — closest analogue: builds on a prior rung, has a "landmine (recon already done — don't rediscover it)" section, and an Operational note. **Rung 5 follows this shape.**

- [ ] **Step 3: Confirm the issue scope**

Open `gh issue view 1143 --repo Jinn-Network/mono`. Acceptance criteria are exactly:
1. CometBFT RPC (:26657) reachable, returns block/validator/status.
2. At least one Cosmos-native query AND one Cosmos-native tx succeed via SDK path (not EVM), OR the exact failure is documented as a finding.

No additional scope. **If a subcheck fails, the script must still exit 1 (red gate), but the failure must be captured verbatim in script output (stderr + the FAIL line) so it becomes the documented finding** — not silently swallowed.

---

## Discovery — One-Shot Commands to Derive Constants

These commands are run **once by the implementer** during development to discover constants that get hardcoded into `rung5.sh`. They are not part of the script itself.

- [ ] **Step 4: Discover the dev0 bech32 address**

```bash
cd /Users/gcd/Repositories/main/mono/.claude/worktrees/epic-bell-dab94c/chain
source lib.sh
"$EVMD" keys show dev0 -a --keyring-backend test --home "$CHAINHOME"
```

Expected output: a `cosmos1…` bech32 string (e.g. `cosmos1xv9tklw7d82sezh9haa573wufgy59vmwnxhnsl`). Record this. **This is the keys subtree, not the query subtree** — keys lookups work even when `evmd query` is broken (#1198 affects `query`, not `keys`).

**However** — the script must NOT hardcode this; it must re-derive each run via the same `evmd keys show` invocation, so the test is self-contained. Hardcode only as a fallback echo string.

- [ ] **Step 5: Discover the validator bech32 (cosmosvaloper) address**

Rung 4 already hardcoded this: `cosmosvaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pw4xyrql` (see `chain/rung4.sh:11`). Use the same constant — it's the genesis validator from `mykey`'s gentx.

For belt-and-braces verification during development, confirm via CometBFT RPC:

```bash
curl -s http://127.0.0.1:26657/validators | jq -r '.result.validators[0].address'
```

That returns the consensus address (a 40-hex string), not the bech32. The bech32 form is what the SDK staking module uses; the consensus address is what CometBFT exposes. **The script asserts the consensus-address path** (`/validators` returns a non-empty list); the bech32 is only used if a future delegation subcheck is added (out of scope for rung 5).

- [ ] **Step 6: Confirm `[api]` and `[grpc]` enable bits in `app.toml`**

```bash
grep -E '^enable = ' "$CHAINHOME/config/app.toml" | head -5
```

`chain/up.sh:86` does `sed 's/enable = false/enable = true/g; s/enabled = false/enabled = true/g'` across `app.toml` — so on a fresh genesis from this repo, `[api].enable`, `[grpc].enable`, `[json-rpc].enable` should all be `true`. **The script asserts this**, because a future regression in `up.sh`'s sed pattern would silently disable an API and we want a loud subcheck rather than a confusing connection refused.

Specifically, `rung5.sh` greps for these three lines (each must equal `enable = true`):
- `[api]` block's `enable`
- `[grpc]` block's `enable`
- `[json-rpc]` block's `enable`

Implementation hint: `awk '/^\[api\]/{flag=1} flag && /^enable/{print; exit}' "$CHAINHOME/config/app.toml"` for each section.

---

## Reproducibility Constraint

- [ ] **Step 7: Confirm the `up.sh` reuse pattern**

`chain/up.sh:20-23` already does this:
```bash
elif [ "$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || echo "")" = "$EVM_CHAIN_ID_DEC" ]; then
  log "reusing running node on $RPC_URL (chain $EVM_CHAIN_ID_DEC)"
  exit 0
fi
```

So `./rung5.sh` calls `"$CHAIN_DIR/up.sh"` (no `FRESH=1`), which reuses any running node or starts a fresh one if none. **This is the same pattern as `rung2.sh:9` and `rung3.sh:9`.** Do NOT replicate `rung4.sh`'s `pkill` + `FRESH=1` — rung 5 does not change genesis.

If `up.sh` has just brought up a fresh node, the CometBFT RPC, REST API, and gRPC need a few seconds before they accept connections. The script waits for `:26657/status` to return a non-zero block height before running the rest of the subchecks (max 30 attempts × 1s sleep). This polling is internal to subcheck 1.

---

## Task 1 — Skeleton `chain/rung5.sh`

**Files:**
- Create: `chain/rung5.sh`

- [ ] **Step 1: Write the skeleton matching `check.sh` idiom**

Create `chain/rung5.sh` with:

```bash
#!/usr/bin/env bash
# Rung-5 acceptance gate (#1143): exercise the Cosmos-native surfaces of the
# native-JINN devnet — CometBFT RPC, SDK REST/LCD query, SDK CLI tx — and prove
# they work, OR document the exact failure as a finding.
#
# Reads through :26657 and :1317 via raw curl, and uses `evmd tx bank send` for
# the tx path. Avoids `evmd query` entirely (#1198 — broken on v0.7.0). Each
# subcheck prints PASS/FAIL independently so the operator sees every surface,
# even on a partial-red run.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
log() { printf '[rung5] %s\n' "$*"; }

# Cosmos-native endpoints (default upstream config, enabled by up.sh's sed pass)
COMETBFT_RPC="http://127.0.0.1:26657"
SDK_REST="http://127.0.0.1:1317"

# 1. ensure the devnet (up.sh reuses an already-running node; rung 5 does not
#    change genesis, so do NOT use FRESH).
"$CHAIN_DIR/up.sh"

pass=0; fail=0
ok() { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
chk() { if eval "$2"; then ok "$1"; else no "$1${3:+ — $3}"; fi; }

echo "== rung-5 acceptance (Cosmos-native surfaces) =="

# (subchecks added in following tasks)

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Make executable and run**

```bash
chmod +x chain/rung5.sh
./chain/rung5.sh
```

Expected: skeleton prints the header, `0 passed, 0 failed`, exits 0. (We will tighten in later steps; this just proves the harness loads.)

- [ ] **Step 3: Commit**

```bash
git add chain/rung5.sh
git commit -m "spike(chain): scaffold rung5.sh Cosmos-native acceptance gate (#1143)"
```

---

## Task 2 — Subcheck 1: CometBFT RPC reachable

**Acceptance criterion:** "CometBFT RPC (:26657) is reachable and returns block/validator/status data via a reproducible check."

**Files:**
- Modify: `chain/rung5.sh` (insert before the trailing `echo "== $pass passed..."`)

- [ ] **Step 1: Add the wait-and-status subcheck**

Insert after the `echo "== rung-5 acceptance ..." ==` line:

```bash
# --- 1. CometBFT RPC reachable on :26657 ---
# Poll /status until it returns a non-zero block height (the node may have just
# started). Then assert network == COSMOS_CHAIN_ID and latest_block_height >= 1.
status_json=""
for _ in $(seq 1 30); do
  status_json="$(curl -fsS "$COMETBFT_RPC/status" 2>/dev/null || true)"
  h="$(printf '%s' "$status_json" | jq -r '.result.sync_info.latest_block_height // empty' 2>/dev/null)"
  [ -n "$h" ] && [ "$h" -ge 1 ] 2>/dev/null && break
  sleep 1
done
net="$(printf '%s' "$status_json" | jq -r '.result.node_info.network // empty' 2>/dev/null)"
h="$(printf '%s' "$status_json" | jq -r '.result.sync_info.latest_block_height // empty' 2>/dev/null)"
chk "1. CometBFT /status reachable (network=$net height=$h)" \
    '[ "$net" = "$COSMOS_CHAIN_ID" ] && [ -n "$h" ] && [ "$h" -ge 1 ] 2>/dev/null'
```

- [ ] **Step 2: Run it**

```bash
./chain/rung5.sh
```

Expected (devnet up):
```
== rung-5 acceptance (Cosmos-native surfaces) ==
  PASS  1. CometBFT /status reachable (network=9001 height=N)
== 1 passed, 0 failed ==
```

If the devnet was off, `up.sh` will start it; subcheck 1 will wait up to 30s.

- [ ] **Step 3: Commit**

```bash
git add chain/rung5.sh
git commit -m "spike(chain): rung5 subcheck 1 — CometBFT /status reachable on :26657"
```

---

## Task 3 — Subcheck 2: CometBFT /validators + /block

**Acceptance criterion (continued):** "...returns block/validator/status data."

**Files:**
- Modify: `chain/rung5.sh`

- [ ] **Step 1: Add validators + block subchecks**

Insert immediately after subcheck 1:

```bash
# --- 2. CometBFT /validators returns the genesis validator ---
v_json="$(curl -fsS "$COMETBFT_RPC/validators" 2>/dev/null || true)"
n_vals="$(printf '%s' "$v_json" | jq -r '.result.validators | length // 0' 2>/dev/null)"
chk "2. CometBFT /validators returns >= 1 validator (got: $n_vals)" \
    '[ -n "$n_vals" ] && [ "$n_vals" -ge 1 ] 2>/dev/null'

# --- 3. CometBFT /block?height=1 returns the genesis block ---
b_json="$(curl -fsS "$COMETBFT_RPC/block?height=1" 2>/dev/null || true)"
b_height="$(printf '%s' "$b_json" | jq -r '.result.block.header.height // empty' 2>/dev/null)"
chk "3. CometBFT /block?height=1 returns height=1 (got: ${b_height:-?})" \
    '[ "$b_height" = "1" ]'
```

- [ ] **Step 2: Run and verify**

```bash
./chain/rung5.sh
```

Expected:
```
  PASS  1. CometBFT /status reachable (...)
  PASS  2. CometBFT /validators returns >= 1 validator (got: 1)
  PASS  3. CometBFT /block?height=1 returns height=1 (got: 1)
```

- [ ] **Step 3: Commit**

```bash
git add chain/rung5.sh
git commit -m "spike(chain): rung5 subchecks 2-3 — CometBFT /validators + /block (#1143)"
```

---

## Task 4 — Subcheck 4: SDK REST query (bank balance, dual-view assertion)

**Acceptance criterion:** "...at least one Cosmos-native query ... succeed via the SDK path (not the EVM)."

This is the "one balance, two views" assertion from `docs/2026-06-09-simplified-launch-logic.md` §13: the Cosmos bank view and the EVM ERC-20 view must agree on the dev0 balance.

**Files:**
- Modify: `chain/rung5.sh`

- [ ] **Step 1: Add `[api]` enable-bit subcheck**

Surface a silent-off regression in `up.sh`'s sed pattern. Insert before subcheck 4:

```bash
# --- 4a. app.toml: [api].enable and [grpc].enable are true ---
# up.sh sed's `enable = false` -> `enable = true` across app.toml. A regression
# in that sed would silently disable the SDK surface; loud-fail if so.
api_en="$(awk '/^\[api\]/{flag=1; next} flag && /^\[/{exit} flag && /^enable[[:space:]]*=/{print; exit}' "$CHAINHOME/config/app.toml" | tr -d ' ')"
grpc_en="$(awk '/^\[grpc\]/{flag=1; next} flag && /^\[/{exit} flag && /^enable[[:space:]]*=/{print; exit}' "$CHAINHOME/config/app.toml" | tr -d ' ')"
chk "4a. app.toml [api].enable=true (got: ${api_en:-?})" '[ "$api_en" = "enable=true" ]'
chk "4b. app.toml [grpc].enable=true (got: ${grpc_en:-?})" '[ "$grpc_en" = "enable=true" ]'
```

- [ ] **Step 2: Run and confirm both bits true**

```bash
./chain/rung5.sh
```

Expected: 4a PASS, 4b PASS.

If either fails, the implementer must NOT silently fix `up.sh` — that is out of scope. Document the failure in `RUNG-5-GOAL.md` as a finding, exit red, stop.

- [ ] **Step 3: Add the SDK REST bank-balance query**

Insert after subcheck 4b:

```bash
# --- 4c. SDK REST: bank balance for dev0 (bech32), one balance / two views ---
# Derive dev0's bech32 via `evmd keys show` (keys subtree, NOT broken `query`).
DEV0_BECH32="$("$EVMD" keys show dev0 -a --keyring-backend test --home "$CHAINHOME" 2>/dev/null || echo "")"
# SDK REST (LCD) /cosmos/bank/v1beta1/balances/{addr}
bal_json="$(curl -fsS "$SDK_REST/cosmos/bank/v1beta1/balances/$DEV0_BECH32" 2>/dev/null || true)"
bank_bal="$(printf '%s' "$bal_json" | jq -r --arg d "$BASE_DENOM" '.balances[] | select(.denom==$d) | .amount // empty' 2>/dev/null)"
chk "4c. SDK REST bank balance for dev0 ($DEV0_BECH32) returns ajinn amount (got: ${bank_bal:-?})" \
    '[ -n "$bank_bal" ] && [ "$bank_bal" -gt 0 ] 2>/dev/null'

# --- 4d. EVM and bank views agree on dev0's balance (one balance, two views) ---
evm_bal_hex="$(cast call "$NATIVE_ERC20" 'balanceOf(address)(uint256)' "$DEV0_ADDR" --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1}' || echo "")"
chk "4d. EVM balanceOf(dev0) == bank balance (evm=${evm_bal_hex:-?} bank=${bank_bal:-?})" \
    '[ -n "$evm_bal_hex" ] && [ "$evm_bal_hex" = "$bank_bal" ]'
```

- [ ] **Step 4: Run and verify**

```bash
./chain/rung5.sh
```

Expected:
```
  PASS  4a. app.toml [api].enable=true (...)
  PASS  4b. app.toml [grpc].enable=true (...)
  PASS  4c. SDK REST bank balance for dev0 (cosmos1...) returns ajinn amount (got: 1000000000000000000000)
  PASS  4d. EVM balanceOf(dev0) == bank balance (evm=1000... bank=1000...)
```

**If 4c fails:** the SDK REST API surface is broken; capture stderr from the curl and the raw `bal_json` into the FAIL line and document under Findings in `RUNG-5-GOAL.md`. This counts as the "documented failure" branch of the acceptance criterion (criterion 2 is OR-shaped).

**If 4d fails but 4c passes:** the views disagree — that's a substrate bug, not a #1198-class issue. Document it; do not paper over.

- [ ] **Step 5: Commit**

```bash
git add chain/rung5.sh
git commit -m "spike(chain): rung5 subcheck 4 — SDK REST bank balance + dual-view (#1143)"
```

---

## Task 5 — Subcheck 5: Cosmos-native tx via `evmd tx bank send`

**Acceptance criterion:** "...one Cosmos-native tx ... succeed via the SDK path (not the EVM), or the exact failure (e.g. #1198 scope) is documented as a finding."

The tx subtree of `evmd` is distinct from the broken `query` subtree (#1198). It MAY work; if it doesn't, the verbatim stderr is the finding.

**Files:**
- Modify: `chain/rung5.sh`

- [ ] **Step 1: Add the SDK CLI bank-send subcheck**

Insert after subcheck 4d:

```bash
# --- 5. SDK CLI bank-send: dev0 -> mykey via `evmd tx bank send` ---
# This is the Cosmos-native tx path (NOT cast send / EVM). If `evmd tx` is also
# broken by #1198-class issues, capture stderr verbatim — that's the documented
# finding the issue allows.
MYKEY_BECH32="$("$EVMD" keys show mykey -a --keyring-backend test --home "$CHAINHOME" 2>/dev/null || echo "")"
SEND_AMT="1000000000000000000"  # 1 JINN (1e18 ajinn)
FEES="200000000000000${BASE_DENOM}"  # 2e14 ajinn fee; minimum-gas-prices=0 on the node
TX_STDERR="$BUILD_DIR/rung5-tx.stderr"
TX_STDOUT="$BUILD_DIR/rung5-tx.stdout"
"$EVMD" tx bank send dev0 "$MYKEY_BECH32" "${SEND_AMT}${BASE_DENOM}" \
  --keyring-backend test --home "$CHAINHOME" \
  --chain-id "$COSMOS_CHAIN_ID" \
  --node "$COMETBFT_RPC" \
  --fees "$FEES" \
  --gas auto --gas-adjustment 1.5 \
  -y -o json \
  >"$TX_STDOUT" 2>"$TX_STDERR" || true
tx_code="$(jq -r '.code // empty' "$TX_STDOUT" 2>/dev/null)"
tx_hash="$(jq -r '.txhash // empty' "$TX_STDOUT" 2>/dev/null)"
chk "5a. evmd tx bank send accepted (code=${tx_code:-?} hash=${tx_hash:-none})" \
    '[ "$tx_code" = "0" ] && [ -n "$tx_hash" ]'

# --- 5b. SDK REST: tx is queryable by hash ---
# Poll for inclusion (CheckTx code=0 != committed; we need the receipt).
tx_resp=""
if [ -n "$tx_hash" ]; then
  for _ in $(seq 1 20); do
    tx_resp="$(curl -fsS "$SDK_REST/cosmos/tx/v1beta1/txs/$tx_hash" 2>/dev/null || true)"
    [ -n "$(printf '%s' "$tx_resp" | jq -r '.tx_response.code // empty' 2>/dev/null)" ] && break
    sleep 1
  done
fi
tx_resp_code="$(printf '%s' "$tx_resp" | jq -r '.tx_response.code // empty' 2>/dev/null)"
chk "5b. SDK REST /cosmos/tx/v1beta1/txs/{hash} returns code=0 (got: ${tx_resp_code:-?})" \
    '[ "$tx_resp_code" = "0" ]'

# --- 5c. Re-read both balance views; both reflect the send ---
bal_json2="$(curl -fsS "$SDK_REST/cosmos/bank/v1beta1/balances/$DEV0_BECH32" 2>/dev/null || true)"
bank_bal2="$(printf '%s' "$bal_json2" | jq -r --arg d "$BASE_DENOM" '.balances[] | select(.denom==$d) | .amount // empty' 2>/dev/null)"
evm_bal2_hex="$(cast call "$NATIVE_ERC20" 'balanceOf(address)(uint256)' "$DEV0_ADDR" --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1}' || echo "")"
chk "5c. post-tx EVM view == bank view (evm=${evm_bal2_hex:-?} bank=${bank_bal2:-?})" \
    '[ -n "$evm_bal2_hex" ] && [ "$evm_bal2_hex" = "$bank_bal2" ]'

# Surface tx stderr in the FAIL stream so the operator can paste it into #1143
# as the documented finding, if 5a or 5b failed.
if [ "$tx_code" != "0" ] || [ "$tx_resp_code" != "0" ]; then
  echo "---- evmd tx stderr (rung5 finding) ----" >&2
  cat "$TX_STDERR" >&2
  echo "---- evmd tx stdout ----" >&2
  cat "$TX_STDOUT" >&2
  echo "---- end ----" >&2
fi
```

- [ ] **Step 2: Run and observe**

```bash
./chain/rung5.sh
```

Two possible outcomes:

**Outcome A (tx path works):**
```
  PASS  5a. evmd tx bank send accepted (code=0 hash=ABC123...)
  PASS  5b. SDK REST /cosmos/tx/v1beta1/txs/{hash} returns code=0 (got: 0)
  PASS  5c. post-tx EVM view == bank view (evm=999... bank=999...)
== 8 passed, 0 failed ==
```
→ Exit 0. Six (now eight with the 4a/4b enable-bit checks) PASS lines. Acceptance criterion 2 satisfied by the "succeed" branch.

**Outcome B (tx path fails, finding documented):**
```
  FAIL  5a. evmd tx bank send accepted (code=? hash=none)
  ...
---- evmd tx stderr (rung5 finding) ----
<verbatim error from evmd>
---- end ----
== N passed, M failed ==
```
→ Exit 1. The stderr capture is the documented finding. Update `RUNG-5-GOAL.md` Findings section (Task 7) with the verbatim error.

- [ ] **Step 3: Commit**

```bash
git add chain/rung5.sh
git commit -m "spike(chain): rung5 subcheck 5 — evmd tx bank send + REST tx query (#1143)"
```

---

## Task 6 — Create `chain/RUNG-5-GOAL.md`

**Files:**
- Create: `chain/RUNG-5-GOAL.md`

- [ ] **Step 1: Write the goal doc matching RUNG-4-GOAL.md structure**

Section ordering (mirroring `RUNG-4-GOAL.md`):

1. Title: `# Workstream B — rung 5 goal: Cosmos-native surfaces`
2. One-paragraph framing: "Goal-prompt for an autonomous Claude Code session. Read it, plan against the live environment, execute to a green gate. Implements issue [#1143](https://github.com/Jinn-Network/mono/issues/1143). Builds on rungs 1–4 (native-JINN chain + veJINN + loop + JINN-as-stake)."
3. `## Mission (definition of done)` — the six-subcheck PASS recipe; `cd chain && ./rung5.sh` exits 0 iff:
   1. CometBFT `/status` returns block height ≥ 1 and `network == "9001"`.
   2. CometBFT `/validators` returns ≥ 1 validator.
   3. CometBFT `/block?height=1` returns height = 1.
   4. SDK REST `/cosmos/bank/v1beta1/balances/{dev0_bech32}` returns the `ajinn` amount, AND it equals `cast call NATIVE_ERC20 balanceOf(dev0)` on `:8545` ("one balance, two views").
   5. `evmd tx bank send dev0 mykey 1ajinn …` returns `code=0` and a tx hash; the SDK REST `/cosmos/tx/v1beta1/txs/{hash}` confirms `code=0`; the post-tx EVM/bank views still agree.
   6. (Operational) `app.toml`'s `[api].enable` and `[grpc].enable` are both `true` — surfaces a silent-off regression in `up.sh`'s sed pattern.
4. `## Why this rung` — Rungs 1–4 tested only the EVM JSON-RPC. CometBFT RPC, SDK REST/gRPC query, and the SDK CLI tx path are untested. Per `docs/2026-06-09-simplified-launch-logic.md` §6 (sovereign Cosmos) and §12, the chain must work natively — not just through the EVM shim. Validators, governance, and (later) IBC all live Cosmos-side.
5. `## The landmine (recon already done — don't rediscover it)` —
   - `evmd query` is broken on v0.7.0 (#1198). Rung 5 uses **only** raw `curl` against `:26657` and `:1317`, and `evmd tx` (the tx subtree, not query). **`evmd keys show` is fine** (keys subtree, independent of query).
   - The `:1317` REST API and `:9090` gRPC are enabled by `up.sh:86`'s `sed 's/enable = false/enable = true/g'` pass — but a regression in that sed would silently disable them. The script asserts both bits.
   - `evmd tx bank send` may also hit #1198-class breakage. If it does, **capture stderr verbatim and document it as a finding** — the issue explicitly accepts a documented failure as the second acceptance branch.
6. `## Operational note` — Rung 5 does NOT change genesis; do NOT use `FRESH=1`. `up.sh`'s reuse-guard (lib.sh-loaded, see `up.sh:20`) reuses any running rung-1/2/3 devnet. Run rung 4 LAST, since it re-inits a fresh chain — rung 5 should be run before rung 4 on a single session, or after a non-FRESH `up.sh` re-bring-up.
7. `## Key facts to build on` —
   - CometBFT RPC default port: `:26657` (no auth, JSON over HTTP).
   - SDK REST (LCD) default port: `:1317`; gRPC: `:9090`.
   - `dev0` bech32 is derived live: `evmd keys show dev0 -a --keyring-backend test --home "$CHAINHOME"`.
   - `mykey` bech32 same way.
   - Validator bech32 is `cosmosvaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pw4xyrql` (from `rung4.sh:11`).
   - All amounts in `ajinn` (1e18 = 1 JINN); fees pay `--minimum-gas-prices=0ajinn` so any non-zero fee works.
8. `## Suggested shape (yours to refine)` — Mirror `chain/check.sh`'s `ok` / `no` / `chk` PASS-FAIL idiom; pass=0/fail=0 counters; final `[ "$fail" -eq 0 ]` exit. Subcheck order: CometBFT (status → validators → block), then `app.toml` enable bits, then SDK REST bank query (dual-view), then `evmd tx bank send` + tx receipt query + post-tx dual-view.
9. `## Hard fences (do not cross)` —
   - **Do not fix #1198.** That's a separate issue. If `evmd query` (the query subtree, distinct from `tx` and `keys`) is broken, document — do not patch.
   - No validator-set changes. No second validator.
   - No genesis tweaks. No FRESH=1.
   - No new modules, no IBC bring-up, no governance proposal, no slashing execution.
   - No JINN.sol, no contract deploys.
   - This is a **spike**: output is a finding (script + doc + commit), not a new feature.
10. `## Process` — `spike` (engineering handbook): write the script, run it, capture output. The spike does NOT merge code beyond the script and docs. If subchecks 5a/5b fail, paste the verbatim stderr into the `## Findings` section at the bottom of this doc and reference it in the PR body and issue #1143 comment.
11. `## Findings (post-execution)` — Section the implementer fills in after running `./rung5.sh`. If green, write "All six subchecks PASS. Cosmos-native surfaces work end-to-end." If red, paste the verbatim stderr from `BUILD_DIR/rung5-tx.stderr` and name the broken surface.
12. `## When green` — Open a PR titled `spike: validate Cosmos-native surfaces`, reference #1143, paste the `./rung5.sh` output (PASS lines + exit code) into the PR body, and stop.

- [ ] **Step 2: Verify the doc reads cleanly**

```bash
wc -l chain/RUNG-5-GOAL.md
```

Expected: 100–130 lines (in line with RUNG-1/2/3/4-GOAL.md which range 114–133 lines).

- [ ] **Step 3: Commit**

```bash
git add chain/RUNG-5-GOAL.md
git commit -m "spike(chain): add RUNG-5-GOAL.md for #1143"
```

---

## Task 7 — Update `chain/README.md`

**Files:**
- Modify: `chain/README.md`

- [ ] **Step 1: Add the rung 5 line in the Usage block**

Edit the Usage code block in `chain/README.md`. Replace:

```bash
./rung4.sh     # verify JINN secures consensus (staking)
./down.sh      # stop the node
```

with:

```bash
./rung4.sh     # verify JINN secures consensus (staking)
./rung5.sh     # verify Cosmos-native surfaces (CometBFT RPC, SDK REST, SDK tx)
./down.sh      # stop the node
```

- [ ] **Step 2: Add a clarifying sentence on rung-5 ordering**

The existing README paragraph after the Usage block says: "Run them in order. ... `./rung4.sh` re-initialises a fresh chain, so run it last."

Update to:

> Run them in order. The first `./up.sh` compiles the node from source (a few
> minutes, cached afterwards). `./rung5.sh` reuses the running devnet and reads
> over CometBFT RPC and the SDK REST API. `./rung4.sh` re-initialises a fresh
> chain, so run it last. `FRESH=1 ./up.sh` resets chain state. Each check exits
> `0` on success.

- [ ] **Step 3: Add the Layout row**

In the Layout table, replace:

```
| `check.sh`, `rung2.sh`, `rung3.sh`, `rung4.sh` | verification checks |
```

with:

```
| `check.sh`, `rung2.sh`, `rung3.sh`, `rung4.sh`, `rung5.sh` | verification checks |
```

- [ ] **Step 4: Verify the README still renders sensibly**

```bash
cat chain/README.md
```

Expected: ~38 lines, the new `rung5.sh` line and the new sentence in place.

- [ ] **Step 5: Commit**

```bash
git add chain/README.md
git commit -m "docs(chain): document rung5.sh in chain/README.md (#1143)"
```

---

## Task 8 — Run the Full Gate and Capture Findings

**Files:**
- Modify (if findings warrant): `chain/RUNG-5-GOAL.md` (the `## Findings` section)

- [ ] **Step 1: Cold run from a freshly-initialised devnet**

```bash
cd /Users/gcd/Repositories/main/mono/.claude/worktrees/epic-bell-dab94c/chain
FRESH=1 ./up.sh
./rung5.sh
echo "exit code: $?"
```

The FRESH=1 first ensures we test on a clean genesis (matches what a fresh-clone CI would do).

- [ ] **Step 2: Reproduce on an already-running devnet**

```bash
./rung5.sh   # second run; up.sh reuses the node
echo "exit code: $?"
```

Both runs should be identical (idempotency). If the second run differs (e.g. balance-equality subchecks 4d/5c diverge), the tx subcheck has state-leak — investigate before claiming green.

- [ ] **Step 3: Fill in `## Findings` in `RUNG-5-GOAL.md`**

If green (exit 0 both runs): write
```
## Findings (post-execution)

All six subchecks PASS on a fresh devnet and on the reused devnet. The Cosmos-native surfaces — CometBFT RPC (:26657), SDK REST API (:1317), and the SDK CLI tx path (`evmd tx bank send`) — are functional end-to-end on cosmos/evm v0.7.0. Issue #1198 is confined to the `evmd query` subtree, not the `tx` or `keys` subtrees, and not the REST/gRPC SDK surface.

PASS recipe (paste into #1143):
- CometBFT /status reachable (network=9001 height=N)
- CometBFT /validators returns >= 1 validator
- CometBFT /block?height=1 returns height=1
- SDK REST bank balance for dev0 returns ajinn amount; matches EVM balanceOf
- evmd tx bank send accepted (code=0); SDK REST tx receipt returns code=0
- Post-tx EVM view == bank view (one balance, two views)
```

If red (exit 1 in either run): paste the verbatim FAIL line and the stderr block under `## Findings`, name the broken surface explicitly (CometBFT? REST? `evmd tx`?), and link to the relevant upstream issue (#1198 if applicable, or open a new one).

- [ ] **Step 4: Commit findings**

```bash
git add chain/RUNG-5-GOAL.md
git commit -m "spike(chain): rung5 findings — Cosmos-native surfaces validated (#1143)"
```

(If red: `git commit -m "spike(chain): rung5 findings — <surface> fails, see doc (#1143)"`.)

---

## Task 9 — Acceptance Verification Against Issue #1143

Cross-reference each issue acceptance criterion to a subcheck and confirm the script output proves it.

- [ ] **Step 1: Verify mapping criterion → subcheck**

| Issue acceptance | rung5.sh subcheck(s) | Evidence in output |
|---|---|---|
| CometBFT RPC (:26657) reachable + block/validator/status | 1 (`/status`), 2 (`/validators`), 3 (`/block`) | Three PASS lines naming `/status`, `/validators`, `/block` |
| One Cosmos-native query succeeds via SDK path | 4c (SDK REST bank balance) + 4d (dual-view) | Two PASS lines naming SDK REST + dual-view equality |
| One Cosmos-native tx succeeds via SDK path | 5a (evmd tx bank send) + 5b (SDK REST tx receipt) + 5c (post-tx dual-view) | Three PASS lines; OR documented failure via stderr capture + Findings section |

- [ ] **Step 2: One-line PR/issue paste recipe**

Final summary to paste into the #1143 comment when green:

```
$ ./chain/rung5.sh
== rung-5 acceptance (Cosmos-native surfaces) ==
  PASS  1. CometBFT /status reachable (network=9001 height=N)
  PASS  2. CometBFT /validators returns >= 1 validator (got: 1)
  PASS  3. CometBFT /block?height=1 returns height=1 (got: 1)
  PASS  4a. app.toml [api].enable=true
  PASS  4b. app.toml [grpc].enable=true
  PASS  4c. SDK REST bank balance for dev0 returns ajinn amount
  PASS  4d. EVM balanceOf(dev0) == bank balance
  PASS  5a. evmd tx bank send accepted (code=0 hash=...)
  PASS  5b. SDK REST tx receipt returns code=0
  PASS  5c. post-tx EVM view == bank view
== 10 passed, 0 failed ==
exit code: 0
```

If red, the comment is the same output with FAIL lines and the `---- evmd tx stderr ----` block, prefixed with "Documented finding: <broken surface> fails on cosmos/evm v0.7.0. See chain/RUNG-5-GOAL.md `## Findings` for the verbatim stderr."

- [ ] **Step 3: Open the PR**

```bash
git push -u origin claude/epic-bell-dab94c
gh pr create --title "spike: validate Cosmos-native surfaces (rung 5)" --body "$(cat <<'EOF'
## Summary

Adds `chain/rung5.sh` exercising the Cosmos-native surfaces of the rung-1 devnet — CometBFT RPC (:26657), SDK REST/LCD (:1317), and the SDK CLI tx path (`evmd tx bank send`) — to satisfy issue #1143. All reads go through raw `curl + jq`, avoiding the broken `evmd query` subtree (#1198). Companion docs: `chain/RUNG-5-GOAL.md` and a paragraph in `chain/README.md`.

Closes #1143.

## Test plan

- [ ] `cd chain && FRESH=1 ./up.sh && ./rung5.sh` exits 0
- [ ] `cd chain && ./rung5.sh` (reuse path) exits 0
- [ ] Output PASS recipe pasted into the issue comment
EOF
)"
```

---

## What This Spike Does NOT Do

Explicit out-of-scope to prevent scope creep:

1. **No fix for #1198.** The broken `evmd query` subtree is untouched. Rung 5 routes around it; it does not repair it.
2. **No validator-set changes.** Single genesis validator only. No second validator, no consensus changes.
3. **No genesis tweaks.** Rung 5 does NOT use `FRESH=1` and does NOT modify `up.sh`'s genesis-init block. (4a/4b assert the existing sed pattern still produces `enable = true`; if it doesn't, the script fails loud — but the fix lives in a separate issue.)
4. **No new SDK modules.** No IBC bring-up, no x/auth tweaks, no x/gov proposal.
5. **No slashing execution.** Rung 4 already confirms slashing is *configured*. No actual slash.
6. **No JINN.sol or contract deploys.** This is purely a surface-validation spike.
7. **No CI integration.** The script is run manually as the rung-1–4 scripts are; CI integration is a separate work item if desired later.
8. **No production tx-flooding or load testing.** One bank-send is the entire tx-path proof.

If the implementer finds themselves doing any of the above, they have left rung 5 — stop and report.

---

## Self-Review

**1. Spec coverage.**
- Acceptance criterion 1 (CometBFT RPC reachable + block/validator/status) → subchecks 1, 2, 3.
- Acceptance criterion 2 (Cosmos-native query AND Cosmos-native tx, OR documented failure) → query covered by 4c+4d; tx covered by 5a+5b+5c; documented failure branch covered by stderr capture in `RUNG-5-GOAL.md` `## Findings`.
- "Files/components: chain/" → all changes confined to `chain/rung5.sh`, `chain/RUNG-5-GOAL.md`, `chain/README.md`.
- "Relates to #1198" → explicitly routed around in subchecks; called out in `RUNG-5-GOAL.md` Landmine section.

**2. Placeholder scan.** No TBD/TODO/"add appropriate"/"similar to" — every code block is concrete and runnable.

**3. Type / name consistency.**
- `COMETBFT_RPC` and `SDK_REST` defined once in Task 1 step 1, reused in Tasks 2/3/4/5.
- `DEV0_BECH32`, `MYKEY_BECH32` derived live from `evmd keys show` (no hardcoding mismatch).
- `BASE_DENOM`, `NATIVE_ERC20`, `DEV0_ADDR`, `RPC_URL`, `COSMOS_CHAIN_ID`, `EVMD`, `CHAINHOME` all come from `lib.sh` (verified Step 1 of Pre-Flight).
- `pass`, `fail`, `ok`, `no`, `chk` mirror `check.sh:7-10` exactly.
- `$tx_code` (from CheckTx) vs `$tx_resp_code` (from DeliverTx via REST) are distinct on purpose — both must be 0.

Plan is internally consistent.
