#!/bin/bash
#
# Configuration Enforcement Script
#
# Detects direct process.env access outside of allowed infrastructure files.
# This enforces the "Centralize configuration access" default behavior from
# docs/spec/code-spec/spec.md
#
# Usage:
#   ./scripts/check-config-violations.sh           # Check entire codebase
#   ./scripts/check-config-violations.sh --strict  # Exit 1 on any violation
#
# Exit codes:
#   0 = No violations found
#   1 = Violations found (in --strict mode)
#   2 = Script error
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Strict mode flag
STRICT_MODE=false
if [[ "${1:-}" == "--strict" ]]; then
  STRICT_MODE=true
fi

echo -e "${BLUE}==> Checking for configuration violations...${NC}\n"

# Allowed files (config infrastructure - these are the ONLY files that should access process.env directly)
ALLOWED_FILES=(
  "config/index.ts"
  "env/index.ts"
  "env/operate-profile.ts"
)

# Build grep exclude pattern for allowed files
ALLOWED_PATTERN=""
for file in "${ALLOWED_FILES[@]}"; do
  ALLOWED_PATTERN="${ALLOWED_PATTERN} -e ${file}"
done

# Search for process.env usage in TypeScript files
# Exclude:
# - node_modules (dependencies)
# - .git (version control)
# - Allowed config infrastructure files
# - Lines with TODO(JINN-234) comment (intentionally deferred migration)
VIOLATIONS=$(grep -r "process\.env\." \
  --include="*.ts" \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=.conductor \
  . 2>/dev/null \
  | grep -v ${ALLOWED_PATTERN} \
  | grep -v "TODO(JINN-234)" \
  | grep -v "@deprecated" \
  | grep -v "Legacy helper" \
  | grep -v "// Allow" \
  | grep -v "process\.env\.__ENV_LOADED" \
  | grep -v "process\.env\.NODE_ENV" \
  || true)

# Count violations by file
if [ -n "$VIOLATIONS" ]; then
  VIOLATION_COUNT=$(echo "$VIOLATIONS" | wc -l | tr -d ' ')
  FILE_COUNT=$(echo "$VIOLATIONS" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')

  echo -e "${RED}❌ Found ${VIOLATION_COUNT} configuration violations in ${FILE_COUNT} files:${NC}\n"

  # Group by file for readability
  echo "$VIOLATIONS" | cut -d: -f1 | sort -u | while read -r file; do
    COUNT=$(echo "$VIOLATIONS" | grep "^${file}:" | wc -l | tr -d ' ')
    echo -e "${YELLOW}${file}${NC} (${COUNT} violations)"

    # Show first 3 violations from each file
    echo "$VIOLATIONS" | grep "^${file}:" | head -3 | while read -r violation; do
      LINE_NUM=$(echo "$violation" | cut -d: -f2)
      CODE=$(echo "$violation" | cut -d: -f3- | sed 's/^[[:space:]]*//')
      echo -e "  ${BLUE}Line ${LINE_NUM}:${NC} ${CODE}"
    done

    if [ "$COUNT" -gt 3 ]; then
      echo -e "  ${BLUE}... and $((COUNT - 3)) more${NC}"
    fi
    echo ""
  done

  echo -e "${YELLOW}==> Remediation:${NC}"
  echo ""
  echo "1. For runtime code (worker/, gemini-agent/), migrate to use config/index.ts:"
  echo -e "   ${GREEN}import { getRequiredRpcUrl } from '../config/index.js';${NC}"
  echo -e "   ${GREEN}const rpcUrl = getRequiredRpcUrl();${NC}"
  echo ""
  echo "2. For one-off scripts or tests, add a TODO comment:"
  echo -e "   ${GREEN}// TODO(JINN-234): Migrate to config/index.ts getters${NC}"
  echo -e "   ${GREEN}const chainId = parseInt(process.env.CHAIN_ID || '8453', 10);${NC}"
  echo ""
  echo "3. For test setup code that legitimately needs to set env vars:"
  echo -e "   ${GREEN}// Allow direct env access in test setup${NC}"
  echo -e "   ${GREEN}process.env.RPC_URL = 'https://test.example.com';${NC}"
  echo ""
  echo "See: docs/spec/code-spec/spec.md \"Centralize configuration access\""
  echo ""

  if [ "$STRICT_MODE" = true ]; then
    exit 1
  fi
else
  echo -e "${GREEN}✅ No configuration violations found${NC}"
  echo ""
  echo "All runtime code uses config/index.ts getters for environment variables."
  echo ""
fi

echo -e "${BLUE}==> Summary:${NC}"
echo ""
echo "Allowed infrastructure files (can access process.env):"
for file in "${ALLOWED_FILES[@]}"; do
  echo "  - ${file}"
done
echo ""
echo "All other files must import from config/index.ts"
echo ""

exit 0
