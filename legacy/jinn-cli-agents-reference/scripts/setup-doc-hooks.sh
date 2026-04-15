#!/bin/bash
# Setup pre-push hook for docs + code spec checks
#
# Usage: ./scripts/setup-doc-hooks.sh

set -euo pipefail

HOOK_SCRIPT="scripts/hooks/pre-push-checks.sh"
PRE_PUSH=".git/hooks/pre-push"
MARKER="# pre-push-checks-hook"

echo "🔧 Setting up pre-push checks hook..."

# Check if we're in repo root
if [ ! -d ".git" ]; then
  echo "❌ Error: Run from repository root"
  exit 1
fi

# Make hook script executable
chmod +x "$HOOK_SCRIPT"

# Check if already installed
if grep -q "$MARKER" "$PRE_PUSH" 2>/dev/null; then
  echo "✅ Hook already installed"
  exit 0
fi

# Create or append to pre-push hook
if [ ! -f "$PRE_PUSH" ]; then
  echo "#!/bin/bash" > "$PRE_PUSH"
  chmod +x "$PRE_PUSH"
fi

cat >> "$PRE_PUSH" << 'EOF'

# pre-push-checks-hook
# Documentation + code spec checks (added by setup-doc-hooks.sh)
if [ -x scripts/hooks/pre-push-checks.sh ]; then
  scripts/hooks/pre-push-checks.sh "$@" || true
fi
EOF

echo "✅ Hook installed!"
echo ""
echo "📋 What happens now:"
echo "   - Before each push, Claude checks:"
echo "     1. Documentation that may need updating"
echo "     2. Code against codespec blueprints"
echo "   - Only runs when .ts/.tsx/.js/.jsx files changed"
echo "   - Advisory only (won't block pushes)"
echo ""
echo "🚀 Skip options:"
echo "   - git push --no-verify"
echo "   - SKIP_CHECKS=1 git push"
echo ""
