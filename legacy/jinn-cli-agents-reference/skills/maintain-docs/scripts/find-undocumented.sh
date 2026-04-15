#!/bin/bash
# Find code files that lack documentation
# Usage: ./find-undocumented.sh [code_path]
# Default: gemini-agent/mcp/tools/*.ts

CODE_PATH="${1:-gemini-agent/mcp/tools/*.ts}"

echo "Checking for undocumented code in: $CODE_PATH"
echo "=============================================="

for f in $CODE_PATH; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .ts)

  # Skip index files and test files
  [[ "$name" == "index" ]] && continue
  [[ "$name" == *".test" ]] && continue
  [[ "$name" == *".spec" ]] && continue

  # Check if mentioned anywhere in docs
  if ! grep -rq "$name" docs/ 2>/dev/null; then
    echo "UNDOCUMENTED: $f"
  fi
done
