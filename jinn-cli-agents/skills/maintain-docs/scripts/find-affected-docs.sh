#!/bin/bash
# Find docs affected by changed files
# Usage: ./find-affected-docs.sh [file1] [file2] ...
# Or:    git diff --name-only | ./find-affected-docs.sh

echo "Finding docs affected by changes..."
echo "=============================================="

# Collect all changed files
changed_files=()
if [ $# -gt 0 ]; then
  changed_files=("$@")
else
  while IFS= read -r line; do
    [ -n "$line" ] && changed_files+=("$line")
  done
fi

if [ ${#changed_files[@]} -eq 0 ]; then
  echo "No files provided."
  exit 0
fi

# Find affected docs (using temp file for deduplication)
tmpfile=$(mktemp)
trap "rm -f $tmpfile" EXIT

for changed_file in "${changed_files[@]}"; do
  grep -rl "$changed_file" docs/ --include="*.md" 2>/dev/null | while read -r doc; do
    echo "$doc|$changed_file"
  done
done | sort -u -t'|' -k1,1 > "$tmpfile"

# Output results
count=0
while IFS='|' read -r doc ref; do
  echo "AFFECTED: $doc (references $ref)"
  ((count++))
done < "$tmpfile"

if [ $count -eq 0 ]; then
  echo "No docs reference the changed files."
fi
