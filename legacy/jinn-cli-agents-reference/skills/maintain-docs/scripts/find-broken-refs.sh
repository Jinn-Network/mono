#!/bin/bash
# Find docs with related_code pointing to deleted files
# Usage: ./find-broken-refs.sh
# Excludes: docs/site/ (marketing content)

echo "Checking for broken related_code references..."
echo "(excluding docs/site/)"
echo "=============================================="

find docs/ -name "*.md" -type f ! -path "docs/site/*" | while read -r doc; do
  in_related_code=false

  while IFS= read -r line; do
    # Detect start of related_code block
    if [[ "$line" =~ ^related_code: ]]; then
      in_related_code=true
      continue
    fi

    # Detect end of YAML list (line doesn't start with space or -)
    if $in_related_code && [[ ! "$line" =~ ^[[:space:]]*- ]] && [[ ! "$line" =~ ^[[:space:]]*$ ]]; then
      in_related_code=false
      continue
    fi

    # Check each related_code entry
    if $in_related_code && [[ "$line" =~ ^[[:space:]]*-[[:space:]]*(.*) ]]; then
      ref="${BASH_REMATCH[1]}"
      # Use -e (exists) not -f (file) to handle both files and directories
      if [ -n "$ref" ] && [ ! -e "$ref" ]; then
        echo "BROKEN: $doc -> $ref"
      fi
    fi
  done < "$doc"
done
