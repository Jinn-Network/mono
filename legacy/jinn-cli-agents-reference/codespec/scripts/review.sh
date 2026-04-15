#!/bin/bash
# Simple code review against codespec blueprints
# Usage: ./codespec/scripts/review.sh <file-or-dir>
#
# Reviews code against invariants defined in codespec/blueprints/
# Uses Claude to identify violations

set -euo pipefail

TARGET="${1:-.}"

if ! command -v claude &> /dev/null; then
  echo "Error: Claude CLI not found. Install from https://docs.claude.com/en/docs/claude-code/setup"
  exit 1
fi

echo "Reviewing $TARGET against codespec blueprints..."
echo ""

claude --model sonnet --print -p "Review this code against the invariants in codespec/blueprints/ (objectives.json, rules.json, defaults.json). For each violation found, output:

- File and line number
- Which invariant is violated (e.g., RULE-NO-SECRETS, DB-CONFIG)
- Description of the issue
- Suggested fix

If no violations are found, say 'No violations found.'" "$TARGET"
