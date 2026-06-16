#!/usr/bin/env bash
# Rung-3 acceptance gate (#1137): ensure the native-JINN devnet, then close the
# protocol loop on it — lock -> vote -> activity tick -> read back.
# Exits 0 iff all rung-3 assertions pass.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
log() { printf '[rung3] %s\n' "$*"; }

# 1. ensure the devnet (up.sh reuses an already-running node)
"$CHAIN_DIR/up.sh"

# 2. deploy veJINN + gauge + router + checker, run the loop, assert — via Hardhat
CONTRACTS="$(cd "$CHAIN_DIR/.." && pwd)/contracts"
[ -d "$CONTRACTS/node_modules" ] || { echo "[rung3] FATAL: contracts deps missing — run 'corepack yarn install' in $CONTRACTS" >&2; exit 1; }
log "deploying loop contracts + lock/vote/tick via Hardhat (localhost -> $RPC_URL, chain $EVM_CHAIN_ID_DEC)"
cd "$CONTRACTS"
LOCAL_RPC_URL="$RPC_URL" LOCAL_CHAIN_ID="$EVM_CHAIN_ID_DEC" LOCAL_PRIVATE_KEY="$DEV0_PRIV" \
  corepack yarn hardhat run scripts/deploy-loop-native.ts --network localhost
