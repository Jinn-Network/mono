#!/usr/bin/env bash
# Shared config for the native-JINN Cosmos EVM devnet seed (issue #1133).
# Sourced by up.sh, check.sh, down.sh.
set -euo pipefail

CHAIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$CHAIN_DIR/.build"
BIN_DIR="$BUILD_DIR/bin"
EVMD="$BIN_DIR/evmd"
EVM_SRC="$BUILD_DIR/evm"
CHAINHOME="$BUILD_DIR/evmd-home"
NODE_LOG="$BUILD_DIR/node.log"
NODE_PID="$BUILD_DIR/node.pid"

# --- substrate pin (cosmos/evm) ---
EVM_REPO="https://github.com/cosmos/evm"
EVM_TAG="v0.7.0"

# --- JINN as the native base coin (gas + staking + value) ---
# 18-decimal base unit; the 'a' (atto) prefix makes 1 ajinn == 1 wei on the EVM
# side, so the bank view and the EVM view agree on magnitude.
BASE_DENOM="ajinn"
DISPLAY_DENOM="jinn"
SYMBOL="JINN"

# --- chain ids ---
COSMOS_CHAIN_ID="9001"        # cosmos-side id (upstream default; cosmetic for rung 1)
EVM_CHAIN_ID_DEC="262144"     # evmd's compiled EVM chain id
EVM_CHAIN_ID_HEX="0x40000"

# --- rpc ---
RPC_URL="http://127.0.0.1:8545"

# Native coin surfaced to the EVM as a standard ERC-20 via the x/erc20 token
# pair registered in genesis. This is the "one balance, two views" address.
NATIVE_ERC20="0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"

# --- public dev test keys (verbatim from upstream local_node.sh; testnet only) ---
VAL_MNEMONIC="gesture inject test cycle original hollow east ridge hen combine junk child bacon zero hope comfort vacuum milk pitch cage oppose unhappy lunar seat"
DEV0_MNEMONIC="copper push brief egg scan entry inform record adjust fossil boss egg comic alien upon aspect dry avoid interest fury window hint race symptom"
DEV0_PRIV="0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305"
DEV0_ADDR="0xC6Fe5D33615a1C52c08018c47E8Bc53646A0E101"
DEV1_ADDR="0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17"

# Tooling installed outside the default non-login PATH on this machine.
export PATH="/opt/homebrew/bin:$HOME/.foundry/bin:$HOME/go/bin:$PATH"
