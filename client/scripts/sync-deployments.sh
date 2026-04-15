#!/usr/bin/env bash
# Sync deployment artifacts from contracts/ into client/deployments/.
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
  deployment-phase1a-token-baseSepolia-fast.json
  deployment-phase1a-l2-baseSepolia-fast.json
  deployment-phase1b-mech-baseSepolia-fast.json
  deployment-stolas-l2-baseSepolia-fast.json
)

for f in "${FILES[@]}"; do
  src="$CONTRACTS_DIR/$f"
  if [ -f "$src" ]; then
    cp "$src" "$DEST/$f"
    echo "✓ $f"
  else
    echo "⚠ Missing: $src"
  fi
done

echo ""
echo "Deployment artifacts synced to $DEST"
