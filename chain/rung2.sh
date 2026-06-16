#!/usr/bin/env bash
# Rung-2 acceptance gate (#1135): ensure the rung-1 native-JINN devnet, then
# deploy veJINN against native JINN and prove one lock escrows it.
# Exits 0 iff all five rung-2 assertions pass.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
log() { printf '[rung2] %s\n' "$*"; }

# 1. ensure the devnet (up.sh reuses an already-running node)
"$CHAIN_DIR/up.sh"

# 2. deploy veJINN + lock + assert, via Hardhat against the live node
CONTRACTS="$(cd "$CHAIN_DIR/.." && pwd)/contracts"
[ -d "$CONTRACTS/node_modules" ] || { echo "[rung2] FATAL: contracts deps missing — run 'corepack yarn install' in $CONTRACTS" >&2; exit 1; }
log "deploying veJINN + locking via Hardhat (localhost -> $RPC_URL, chain $EVM_CHAIN_ID_DEC)"
cd "$CONTRACTS"
LOCAL_RPC_URL="$RPC_URL" LOCAL_CHAIN_ID="$EVM_CHAIN_ID_DEC" LOCAL_PRIVATE_KEY="$DEV0_PRIV" \
  corepack yarn hardhat run scripts/deploy-vejinn-native.ts --network localhost
