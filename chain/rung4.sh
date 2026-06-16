#!/usr/bin/env bash
# Rung-4 acceptance gate (#1139): JINN as consensus stake. Brings up a fresh chain
# with the x/staking precompile enabled, delegates native JINN to the validator
# through it, and proves the bond. Exits 0 iff all assertions pass.
#
# Always re-inits a fresh chain: enabling the staking precompile is a genesis
# change, and a fresh chain keeps the gate idempotent (delegation == AMT exactly).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
log() { printf '[rung4] %s\n' "$*"; }

VALOPER="cosmosvaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pw4xyrql"   # genesis validator
SP="0x0000000000000000000000000000000000000800"                 # staking precompile
AMT="100000000000000000000"   # 100 JINN
GAS=1500000                   # explicit — cast under-estimates precompile gas (#765)

# --- fresh chain with the staking precompile ---
log "stopping any running devnet (rung 4 needs a fresh genesis with the staking precompile)"
pkill -f "evmd start" 2>/dev/null || true
for _ in $(seq 1 15); do cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 || break; sleep 1; done
# reuse a sibling worktree's evmd binary to skip the ~10-min build, else up.sh builds
if [ ! -x "$EVMD" ]; then
  mkdir -p "$BIN_DIR"
  CAND="$(ls "$CHAIN_DIR"/../../*/chain/.build/bin/evmd 2>/dev/null | grep -vF "$EVMD" | head -1 || true)"
  [ -n "$CAND" ] && cp "$CAND" "$EVMD" && log "reused evmd binary from $CAND"
fi
FRESH=1 "$CHAIN_DIR/up.sh"

# --- delegate + assert ---
pass=0; fail=0
ok() { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
chk() { if eval "$2"; then ok "$1"; else no "$1${3:+ — $3}"; fi; }

echo "== rung-4 acceptance (JINN as consensus stake) =="

# 1. staking precompile active (the delegation query decodes)
q0="$(cast call "$SP" 'delegation(address,string)(uint256,(string,uint256))' "$DEV0_ADDR" "$VALOPER" --rpc-url "$RPC_URL" 2>/dev/null || echo "")"
chk "1. staking precompile (0x..0800) active" '[ -n "$q0" ]'

# 2. delegate 100 JINN to the validator via the precompile (explicit gas)
before="$(cast balance "$DEV0_ADDR" --rpc-url "$RPC_URL" 2>/dev/null || echo 0)"
status="$(cast send "$SP" 'delegate(address,string,uint256)' "$DEV0_ADDR" "$VALOPER" "$AMT" --gas-limit "$GAS" --private-key "$DEV0_PRIV" --rpc-url "$RPC_URL" --json 2>/dev/null | jq -r '.status' 2>/dev/null || echo "")"
chk "2. delegate tx settles (status: ${status:-none})" '[ "$status" = "0x1" ]'

# 3. delegation reads back as bonded == AMT (Coin.amount on the 2nd return line)
q1="$(cast call "$SP" 'delegation(address,string)(uint256,(string,uint256))' "$DEV0_ADDR" "$VALOPER" --rpc-url "$RPC_URL" 2>/dev/null || echo "")"
bonded="$(printf '%s' "$q1" | sed -n '2p' | grep -oE '[0-9]{6,}' | head -1)"
chk "3. delegation bonded == $AMT (got: ${bonded:-?})" '[ "$bonded" = "$AMT" ]'

# 4. delegator's liquid JINN fell by >= AMT (bond + gas) — python for >64-bit ints
after="$(cast balance "$DEV0_ADDR" --rpc-url "$RPC_URL" 2>/dev/null || echo 0)"
delta="$(python3 -c "print($before-$after)" 2>/dev/null || echo 0)"
chk "4. delegator liquid JINN fell by >= $AMT (delta: $delta)" 'python3 -c "exit(0 if $delta>=$AMT else 1)"'

# 5. slashing configured for JINN (genesis on disk — not the broken Cosmos CLI)
G="$CHAINHOME/config/genesis.json"
sw="$(jq -r '.app_state.slashing.params.signed_blocks_window' "$G" 2>/dev/null)"
ds="$(jq -r '.app_state.slashing.params.slash_fraction_double_sign' "$G" 2>/dev/null)"
dt="$(jq -r '.app_state.slashing.params.slash_fraction_downtime' "$G" 2>/dev/null)"
chk "5. slashing configured (window=$sw double-sign=$ds downtime=$dt)" \
    '[ -n "$sw" ] && [ "$sw" != null ] && [ -n "$ds" ] && [ "$ds" != null ] && [ -n "$dt" ] && [ "$dt" != null ]'

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
