#!/bin/bash
# Pre-push hook: Documentation + Code Spec checks
# Runs Claude Sonnet to check docs and code standards on commits being pushed
#
# Skip conditions:
#   - --no-verify flag (handled by git)
#   - No code files in commits being pushed
#   - Claude CLI not available
#   - SKIP_CHECKS=1 environment variable

set -euo pipefail

# Allow skipping via env var
if [ "${SKIP_CHECKS:-0}" = "1" ]; then
  exit 0
fi

# Check if claude CLI is available
if ! command -v claude &> /dev/null; then
  echo "⚠️  Claude CLI not found, skipping doc check"
  exit 0
fi

# Get files changed in commits being pushed (compared to remote)
# stdin provides: <local ref> <local sha> <remote ref> <remote sha>
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    # New branch, compare to main
    CHANGED=$(git diff --name-only main..."$local_sha" 2>/dev/null || true)
  else
    # Existing branch, compare to remote
    CHANGED=$(git diff --name-only "$remote_sha".."$local_sha" 2>/dev/null || true)
  fi
done

# Check if any code files changed
CODE_CHANGED=$(echo "$CHANGED" | grep -E '\.(ts|tsx|js|jsx)$' || true)
if [ -z "$CODE_CHANGED" ]; then
  exit 0
fi

# Build file list for the prompt
FILE_LIST=$(echo "$CODE_CHANGED" | head -20 | tr '\n' ' ')

echo ""
echo "📚 Checking documentation for pushed changes..."
echo "   Files: $FILE_LIST"
echo ""

# Run Claude with maintain-docs skill (post-change mode)
# Advisory only - don't block push on failure
claude --model sonnet --print -p "Run /maintain-docs in post-change mode for these files: $FILE_LIST. Output a brief summary of any docs that need updating." --allowedTools Read,Grep,Glob 2>/dev/null || true

echo ""
echo "✅ Doc check complete"
echo ""

# Run codespec review on changed code files
echo "📋 Checking code against codespec blueprints..."
echo ""

claude --model sonnet --print -p "Review these files against the invariants in codespec/blueprints/ (objectives.json, rules.json, defaults.json). For each violation, output file, line, invariant ID, and suggested fix. If no violations, say 'No violations found.': $FILE_LIST" 2>/dev/null || true

echo ""
echo "✅ Code spec check complete (advisory only)"

exit 0
