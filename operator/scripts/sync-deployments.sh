#!/usr/bin/env bash
# Sync deployment artifacts from contracts/ into operator/deployments/.
# Run after deploying new contracts to update the bundled defaults.
#
# Usage: ./scripts/sync-deployments.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$(cd "$CLIENT_DIR/../contracts" && pwd)"
DEST="$CLIENT_DIR/deployments"

mkdir -p "$DEST"

FILES=(
  deployment-phase1a-token-baseSepolia-fast.json:deployment-phase1a-token-baseSepolia-fast.json
  deployment-phase1a-l2-baseSepolia-fast.json:deployment-phase1a-l2-baseSepolia-fast.json
  deployment-phase1b-mech-baseSepolia-fast.json:deployment-phase1b-mech-baseSepolia-fast.json
  deployment-stolas-l2-baseSepolia-fast.json:deployment-stolas-l2-baseSepolia-fast.json
  deployment-task-coordinator-router-v3-baseSepolia-fast.json:deployment-task-coordinator-router-v3-baseSepolia-fast.json
  deployment-claim-registry-baseSepolia.json:deployment-claim-registry-baseSepolia.json
)

for entry in "${FILES[@]}"; do
  src_name="${entry%%:*}"
  dest_name="${entry##*:}"
  src="$CONTRACTS_DIR/$src_name"
  if [ -f "$src" ]; then
    cp "$src" "$DEST/$dest_name"
    echo "✓ $dest_name"
  else
    echo "⚠ Missing: $src"
  fi
done

echo ""
echo "Deployment artifacts synced to $DEST"
