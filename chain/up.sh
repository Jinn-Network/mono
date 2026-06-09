#!/usr/bin/env bash
# Stand up a single-node Cosmos EVM devnet whose native base denom is JINN.
# Idempotent: builds evmd if missing, inits genesis if missing, starts the node
# if not already running, then waits for the EVM JSON-RPC and the first block.
#
# Env:
#   FRESH=1   wipe chain state and re-init genesis from scratch
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

log() { printf '[up] %s\n' "$*"; }

# --- 0. reuse an already-serving devnet, UNLESS FRESH ---
# Non-FRESH: if the right chain is already up, skip build/init/start (no rebuild).
# FRESH: a from-scratch re-init must REPLACE any running node, not reuse it — so
# stop it first and fall through. (Reusing on FRESH would silently keep the old
# chain/genesis.)
if [ "${FRESH:-0}" = "1" ]; then
  pkill -f "evmd start" 2>/dev/null || true
  for _ in $(seq 1 15); do cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 || break; sleep 1; done
elif [ "$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || echo "")" = "$EVM_CHAIN_ID_DEC" ]; then
  log "reusing running node on $RPC_URL (chain $EVM_CHAIN_ID_DEC)"
  exit 0
fi

# --- 1. toolchain gate ---
command -v go  >/dev/null || { echo "[up] FATAL: go not on PATH"  >&2; exit 1; }
command -v jq  >/dev/null || { echo "[up] FATAL: jq not on PATH"  >&2; exit 1; }

# --- 2. build evmd (cached) ---
if [ ! -x "$EVMD" ] || [ "${FORCE_BUILD:-0}" = "1" ]; then
  if [ ! -d "$EVM_SRC/.git" ]; then
    log "cloning $EVM_REPO @ $EVM_TAG"
    git clone --depth 1 --branch "$EVM_TAG" "$EVM_REPO" "$EVM_SRC"
  fi
  log "building evmd (go install) -> $EVMD"
  ( cd "$EVM_SRC" && CGO_ENABLED=1 GOBIN="$BIN_DIR" make install )
fi
"$EVMD" version >/dev/null 2>&1 || { echo "[up] FATAL: evmd not runnable" >&2; exit 1; }
log "evmd ready: $("$EVMD" version 2>&1 | head -1)"

# --- 3. init JINN genesis (replicates upstream local_node.sh, denom swapped) ---
G="$CHAINHOME/config/genesis.json"
if [ ! -f "$G" ] || [ "${FRESH:-0}" = "1" ]; then
  log "initialising fresh chain state (base denom = $BASE_DENOM)"
  rm -rf "$CHAINHOME"
  KR=(--keyring-backend test --home "$CHAINHOME")

  "$EVMD" config set client chain-id "$COSMOS_CHAIN_ID" --home "$CHAINHOME" >/dev/null
  "$EVMD" config set client keyring-backend test --home "$CHAINHOME" >/dev/null
  echo "$VAL_MNEMONIC"  | "$EVMD" keys add mykey --recover --algo eth_secp256k1 "${KR[@]}" >/dev/null
  echo "$DEV0_MNEMONIC" | "$EVMD" keys add dev0  --recover --algo eth_secp256k1 "${KR[@]}" >/dev/null
  echo "$VAL_MNEMONIC"  | "$EVMD" init localtestnet -o --chain-id "$COSMOS_CHAIN_ID" --home "$CHAINHOME" --recover >/dev/null 2>&1

  T="$CHAINHOME/config/tmp_genesis.json"
  setg() { jq "$1" "$G" > "$T" && mv "$T" "$G"; }

  # denom swap across staking / gov / evm / mint
  setg ".app_state.staking.params.bond_denom=\"$BASE_DENOM\""
  setg ".app_state.gov.params.min_deposit[0].denom=\"$BASE_DENOM\""
  setg ".app_state.gov.params.expedited_min_deposit[0].denom=\"$BASE_DENOM\""
  setg ".app_state.evm.params.evm_denom=\"$BASE_DENOM\""
  setg ".app_state.mint.params.mint_denom=\"$BASE_DENOM\""

  # bank metadata: JINN
  setg ".app_state.bank.denom_metadata=[{\"description\":\"The native staking and value token for Jinn.\",\"denom_units\":[{\"denom\":\"$BASE_DENOM\",\"exponent\":0,\"aliases\":[\"attojinn\"]},{\"denom\":\"$DISPLAY_DENOM\",\"exponent\":18,\"aliases\":[]}],\"base\":\"$BASE_DENOM\",\"display\":\"$DISPLAY_DENOM\",\"name\":\"Jinn\",\"symbol\":\"$SYMBOL\",\"uri\":\"\",\"uri_hash\":\"\"}]"

  # native coin exposed to the EVM as a standard ERC-20 (x/erc20 token pair)
  setg ".app_state.erc20.native_precompiles=[\"$NATIVE_ERC20\"]"
  setg ".app_state.erc20.token_pairs=[{contract_owner:1,erc20_address:\"$NATIVE_ERC20\",denom:\"$BASE_DENOM\",enabled:true}]"

  # enable the static precompiles (staking 0x..0800, gov, distribution, bank, etc.)
  # — matches upstream local_node.sh. Without this the list is empty.
  setg '.app_state.evm.params.active_static_precompiles=["0x0000000000000000000000000000000000000100","0x0000000000000000000000000000000000000400","0x0000000000000000000000000000000000000800","0x0000000000000000000000000000000000000801","0x0000000000000000000000000000000000000802","0x0000000000000000000000000000000000000803","0x0000000000000000000000000000000000000804","0x0000000000000000000000000000000000000805","0x0000000000000000000000000000000000000806","0x0000000000000000000000000000000000000807"]'

  setg '.consensus.params.block.max_gas="10000000"'

  # fund validator + dev0 (dev0 is the EVM sender in check.sh)
  "$EVMD" genesis add-genesis-account mykey 100000000000000000000000000"$BASE_DENOM" "${KR[@]}" >/dev/null
  "$EVMD" genesis add-genesis-account dev0  1000000000000000000000"$BASE_DENOM"        "${KR[@]}" >/dev/null
  "$EVMD" genesis gentx mykey 1000000000000000000000"$BASE_DENOM" --gas-prices 10000000"$BASE_DENOM" --chain-id "$COSMOS_CHAIN_ID" "${KR[@]}" >/dev/null 2>&1
  "$EVMD" genesis collect-gentxs --home "$CHAINHOME" >/dev/null 2>&1
  "$EVMD" genesis validate-genesis --home "$CHAINHOME" >/dev/null

  # enable all APIs (incl. JSON-RPC) for the dev node
  APP_TOML="$CHAINHOME/config/app.toml"
  sed -i.bak 's/enable = false/enable = true/g; s/enabled = false/enabled = true/g' "$APP_TOML"
  # the EVM mempool requires comet's mempool.type = "app" (not "flood")
  CONFIG_TOML="$CHAINHOME/config/config.toml"
  sed -i.bak 's/type = "flood"/type = "app"/g' "$CONFIG_TOML"
  log "genesis ready"
fi

# --- 4. start node (background) if not already serving ---
if cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  log "node already serving on $RPC_URL"
else
  log "starting evmd (logs -> $NODE_LOG)"
  nohup "$EVMD" start \
    --pruning nothing \
    --log_level info \
    --minimum-gas-prices=0"$BASE_DENOM" \
    --evm.min-tip=0 \
    --home "$CHAINHOME" \
    --json-rpc.enable \
    --json-rpc.address 127.0.0.1:8545 \
    --json-rpc.api eth,net,web3,txpool,debug \
    --chain-id "$COSMOS_CHAIN_ID" \
    >"$NODE_LOG" 2>&1 &
  echo $! > "$NODE_PID"
fi

# --- 5. wait for RPC + first block ---
log "waiting for JSON-RPC + first block..."
for i in $(seq 1 60); do
  bn="$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null || echo "")"
  if [ -n "$bn" ] && [ "$bn" -ge 1 ] 2>/dev/null; then
    log "node live at block $bn on $RPC_URL"
    exit 0
  fi
  # surface an early crash instead of waiting the full minute
  if [ -f "$NODE_PID" ] && ! kill -0 "$(cat "$NODE_PID")" 2>/dev/null; then
    echo "[up] FATAL: evmd exited during startup. Last log lines:" >&2
    tail -30 "$NODE_LOG" >&2
    exit 1
  fi
  sleep 1
done
echo "[up] FATAL: node did not reach block 1 within 60s. Last log lines:" >&2
tail -30 "$NODE_LOG" >&2
exit 1
