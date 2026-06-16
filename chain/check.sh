#!/usr/bin/env bash
# Acceptance gate for issue #1133. Exits 0 iff ALL six conditions hold.
# Reads chain state over the EVM JSON-RPC (and the on-disk genesis) — never the
# Cosmos query CLI, which is broken on v0.7.0 (#1198).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

pass=0; fail=0
ok()   { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
chk()  { if eval "$2"; then ok "$1"; else no "$1${3:+ — $3}"; fi; }

echo "== rung-1 acceptance =="

# 1. evmd built from cosmos/evm v0.7.0
tag="$(git -C "$EVM_SRC" describe --tags 2>/dev/null || echo none)"
chk "1. evmd built from cosmos/evm $EVM_TAG (got: $tag)" \
    '[ -x "$EVMD" ] && "$EVMD" version >/dev/null 2>&1 && [ "$tag" = "$EVM_TAG" ]'

# 2. single-node devnet live, EVM JSON-RPC on :8545
bn="$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null || echo "")"
chk "2. devnet live on :8545 (block: ${bn:-unreachable})" \
    '[ -n "$bn" ] && [ "$bn" -ge 1 ] 2>/dev/null'

# 3. base denom (gas+staking+value) = JINN — on-disk genesis + EVM view agree
G="$CHAINHOME/config/genesis.json"
evm_d="$(jq -r '.app_state.evm.params.evm_denom' "$G" 2>/dev/null || echo "")"
bond_d="$(jq -r '.app_state.staking.params.bond_denom' "$G" 2>/dev/null || echo "")"
mint_d="$(jq -r '.app_state.mint.params.mint_denom' "$G" 2>/dev/null || echo "")"
sym="$(cast call "$NATIVE_ERC20" 'symbol()(string)' --rpc-url "$RPC_URL" 2>/dev/null | tr -d '"' || echo "")"
dec="$(cast call "$NATIVE_ERC20" 'decimals()(uint8)' --rpc-url "$RPC_URL" 2>/dev/null || echo "")"
chk "3a. genesis evm/bond/mint denom = $BASE_DENOM (got: $evm_d/$bond_d/$mint_d)" \
    '[ "$evm_d" = "$BASE_DENOM" ] && [ "$bond_d" = "$BASE_DENOM" ] && [ "$mint_d" = "$BASE_DENOM" ]'
chk "3b. EVM view: symbol()=$SYMBOL decimals()=18 (got: ${sym:-?}/${dec:-?})" \
    '[ "$(printf %s "$sym" | tr a-z A-Z)" = "$SYMBOL" ] && [ "$dec" = "18" ]'

# 4. eth_chainId == 0x40000
cid="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || echo "")"
chk "4. eth_chainId = $EVM_CHAIN_ID_DEC ($EVM_CHAIN_ID_HEX) (got: ${cid:-?})" \
    '[ "$cid" = "$EVM_CHAIN_ID_DEC" ]'

# 5 + 6. a JINN transfer settles, and the recipient's ERC-20 view reflects it.
# Submit (async, retried until a tx hash is returned) and confirm (poll the
# receipt) are split so a freshly-started node's submit race never double-sends.
amt="1000000000000000000" # 1 JINN
bal() { cast call "$NATIVE_ERC20" 'balanceOf(address)(uint256)' "$1" --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1}'; }
before="$(bal "$DEV1_ADDR")"
txh=""
for _ in 1 2 3 4 5; do
  txh="$(cast send "$DEV1_ADDR" --value "$amt" --private-key "$DEV0_PRIV" --rpc-url "$RPC_URL" --async 2>/dev/null || true)"
  [ "${txh#0x}" != "$txh" ] && break   # got a 0x… hash
  sleep 2
done
status=""
[ "${txh#0x}" != "$txh" ] && for _ in $(seq 1 20); do
  status="$(cast receipt "$txh" status --rpc-url "$RPC_URL" 2>/dev/null || true)"
  [ -n "$status" ] && break
  sleep 1
done
after="$(bal "$DEV1_ADDR")"
status1="${status%% *}"   # cast prints "1 (success)"; take the first token
chk "5. JINN transfer settles (tx: ${txh:-none} status: ${status:-none})" \
    '[ "$status1" = "1" ] || [ "$status1" = "0x1" ]'
delta=""; [ -n "$before" ] && [ -n "$after" ] && delta="$(echo "$after - $before" | bc 2>/dev/null || echo "")"
chk "6. recipient ERC-20 balance +$amt (delta: ${delta:-?})" \
    '[ "$delta" = "$amt" ]'

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
