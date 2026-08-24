#!/bin/bash
# Coverage check: no-tools quiz of claude-opus-5. One arg pair: slug, protocol desc, action desc.
slug="$1"; proto="$2"; action="$3"
prompt=$(sed -e "s|PROTOCOL_DESC|$proto|" -e "s|ACTION_DESC|$action|" quiz-template.txt)
echo "$prompt" > "$slug.prompt.txt"
echo "$prompt" | claude -p --model claude-opus-5 \
  --disallowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit" \
  > "$slug.answer.md" 2> "$slug.err.log"
echo "=== $slug done ($(wc -w < "$slug.answer.md") words)"
