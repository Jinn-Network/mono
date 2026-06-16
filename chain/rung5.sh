#!/usr/bin/env bash
# Rung-5 acceptance gate (#1143): exercise the Cosmos-native surfaces of the
# native-JINN devnet — CometBFT RPC (:26657), SDK REST/LCD (:1317), and the SDK
# CLI tx path (`evmd tx bank send`) — and either prove they work or document the
# exact failure as a finding. Reads go through raw curl + jq; the tx uses the
# `evmd tx` subtree. Deliberately avoids `evmd query` (#1198 — broken on v0.7.0).
# Each subcheck prints PASS/FAIL independently so the operator sees every surface
# even when one fails.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
log() { printf '[rung5] %s\n' "$*"; }

# Cosmos-native endpoints (default upstream ports, enabled by up.sh's sed pass)
COMETBFT_RPC="http://127.0.0.1:26657"
SDK_REST="http://127.0.0.1:1317"

# --- 0. ensure evmd binary (reuse sibling worktree or the live process) ---
# (Pipe to head; the `|| true` swallows any SIGPIPE under `pipefail`.)
RUNNING_CMD="$(ps -ax -o command 2>/dev/null | grep 'evmd start' | grep -v grep | head -1 || true)"
RUNNING_EVMD="$(printf '%s\n' "$RUNNING_CMD" | awk '{print $1}')"
RUNNING_HOME="$(printf '%s\n' "$RUNNING_CMD" | sed -nE 's/.*--home[[:space:]]+([^[:space:]]+).*/\1/p')"
if [ ! -x "$EVMD" ]; then
  mkdir -p "$BIN_DIR"
  # Try sibling worktrees in the same parent first; fall back to the live binary.
  CAND="$(ls "$CHAIN_DIR"/../../*/chain/.build/bin/evmd 2>/dev/null | grep -vF "$EVMD" | head -1 || true)"
  if [ -z "$CAND" ] && [ -x "$RUNNING_EVMD" ]; then
    CAND="$RUNNING_EVMD"
  fi
  [ -n "$CAND" ] && cp "$CAND" "$EVMD" && log "reused evmd binary from $CAND"
fi

# --- 1. ensure the devnet (up.sh reuses an already-running node) ---
"$CHAIN_DIR/up.sh"

# --- 2. ensure dev0 + mykey are in our keyring so `evmd tx` can sign ---
# up.sh's reuse-guard `exit 0`s before populating our CHAINHOME's keyring when
# another worktree is already serving. Re-add the keys from the public dev
# mnemonics in lib.sh; the tx will go to the live chain.
mkdir -p "$CHAINHOME"
KR=(--keyring-backend test --home "$CHAINHOME")
if ! "$EVMD" keys show dev0 -a "${KR[@]}" >/dev/null 2>&1; then
  echo "$DEV0_MNEMONIC" | "$EVMD" keys add dev0  --recover --algo eth_secp256k1 "${KR[@]}" >/dev/null 2>&1 || true
fi
if ! "$EVMD" keys show mykey -a "${KR[@]}" >/dev/null 2>&1; then
  echo "$VAL_MNEMONIC"  | "$EVMD" keys add mykey --recover --algo eth_secp256k1 "${KR[@]}" >/dev/null 2>&1 || true
fi

pass=0; fail=0
ok() { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
chk() { if eval "$2"; then ok "$1"; else no "$1${3:+ — $3}"; fi; }

echo "== rung-5 acceptance (Cosmos-native surfaces) =="

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

# --- 4a/4b. app.toml: [api].enable and [grpc].enable are true ---
# up.sh sed's `enable = false` -> `enable = true` across app.toml. A regression
# in that sed would silently disable the SDK surface; loud-fail if so. Check the
# running chain's app.toml (RUNNING_HOME discovered in §0), not ours.
APP_TOML="${RUNNING_HOME:-$CHAINHOME}/config/app.toml"
api_en="$(awk '/^\[api\]/{flag=1; next} flag && /^\[/{exit} flag && /^enable[[:space:]]*=/{print; exit}' "$APP_TOML" 2>/dev/null | tr -d ' ')"
grpc_en="$(awk '/^\[grpc\]/{flag=1; next} flag && /^\[/{exit} flag && /^enable[[:space:]]*=/{print; exit}' "$APP_TOML" 2>/dev/null | tr -d ' ')"
chk "4a. app.toml [api].enable=true (got: ${api_en:-?})" '[ "$api_en" = "enable=true" ]'
chk "4b. app.toml [grpc].enable=true (got: ${grpc_en:-?})" '[ "$grpc_en" = "enable=true" ]'

# --- 4c. SDK REST: bank balance for dev0 (bech32), one balance / two views ---
# Derive dev0's bech32 via `evmd keys show` (keys subtree, NOT broken `query`).
DEV0_BECH32="$("$EVMD" keys show dev0 -a "${KR[@]}" 2>/dev/null || echo "")"
bal_json="$(curl -fsS "$SDK_REST/cosmos/bank/v1beta1/balances/$DEV0_BECH32" 2>/dev/null || true)"
bank_bal="$(printf '%s' "$bal_json" | jq -r --arg d "$BASE_DENOM" '.balances[] | select(.denom==$d) | .amount // empty' 2>/dev/null)"
chk "4c. SDK REST bank balance for dev0 ($DEV0_BECH32) returns $BASE_DENOM amount (got: ${bank_bal:-?})" \
    '[ -n "$bank_bal" ] && [ "$bank_bal" != "0" ]'

# --- 4d. EVM and bank views agree on dev0's balance (one balance, two views) ---
evm_bal_hex="$(cast call "$NATIVE_ERC20" 'balanceOf(address)(uint256)' "$DEV0_ADDR" --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1}' || echo "")"
chk "4d. EVM balanceOf(dev0) == bank balance (evm=${evm_bal_hex:-?} bank=${bank_bal:-?})" \
    '[ -n "$evm_bal_hex" ] && [ "$evm_bal_hex" = "$bank_bal" ]'

# --- 5a. SDK CLI bank-send: dev0 -> mykey via `evmd tx bank send` ---
# Cosmos-native tx path (NOT cast send / EVM). If `evmd tx` is also broken by
# #1198-class issues, capture stderr verbatim — that's the documented finding the
# issue allows.
MYKEY_BECH32="$("$EVMD" keys show mykey -a "${KR[@]}" 2>/dev/null || echo "")"
SEND_AMT="1000000000000000000"            # 1 JINN (1e18 ajinn)
FEES="200000000000000${BASE_DENOM}"       # 2e14 ajinn fee (minimum-gas-prices=0)
TX_STDERR="$BUILD_DIR/rung5-tx.stderr"
TX_STDOUT="$BUILD_DIR/rung5-tx.stdout"
mkdir -p "$BUILD_DIR"
"$EVMD" tx bank send dev0 "$MYKEY_BECH32" "${SEND_AMT}${BASE_DENOM}" \
  "${KR[@]}" \
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

# --- 5b. SDK REST: tx is queryable by hash (poll for inclusion) ---
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

# Surface tx stderr/stdout in the FAIL stream so the operator can paste it into
# #1143 as the documented finding, if 5a or 5b failed.
if [ "$tx_code" != "0" ] || [ "$tx_resp_code" != "0" ]; then
  echo "---- evmd tx stderr (rung5 finding) ----" >&2
  cat "$TX_STDERR" >&2
  echo "---- evmd tx stdout ----" >&2
  cat "$TX_STDOUT" >&2
  echo "---- end ----" >&2
fi

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
