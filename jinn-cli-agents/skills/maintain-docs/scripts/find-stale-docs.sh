#!/bin/bash
# Find docs with stale last_verified dates or missing frontmatter
# Usage: ./find-stale-docs.sh [days_threshold]
# Default: 30 days
# Excludes: docs/site/ (marketing content)

THRESHOLD_DAYS="${1:-30}"
THRESHOLD_DATE=$(date -v-${THRESHOLD_DAYS}d +%Y-%m-%d 2>/dev/null || date -d "-${THRESHOLD_DAYS} days" +%Y-%m-%d)

echo "Checking for docs not verified since: $THRESHOLD_DATE"
echo "(excluding docs/site/)"
echo "=============================================="

# Check root entry-point docs (AGENTS.md, HUMANS.md) plus docs/ directory
{ find docs/ -name "*.md" -type f ! -path "docs/site/*"; ls AGENTS.md HUMANS.md 2>/dev/null; } | while read -r file; do
  # Check if file starts with frontmatter delimiter
  first_line=$(head -1 "$file")
  if [[ "$first_line" != "---" ]]; then
    echo "NO_FRONTMATTER: $file"
    continue
  fi

  last_verified=$(grep -m1 "^last_verified:" "$file" 2>/dev/null | sed 's/last_verified: *//')

  if [ -z "$last_verified" ]; then
    echo "MISSING_DATE: $file"
  elif [[ "$last_verified" < "$THRESHOLD_DATE" ]]; then
    echo "STALE ($last_verified): $file"
  fi
done
