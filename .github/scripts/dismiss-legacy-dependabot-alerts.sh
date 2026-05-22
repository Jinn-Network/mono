#!/usr/bin/env bash
# .github/scripts/dismiss-legacy-dependabot-alerts.sh
#
# One-shot, re-runnable batch-dismissal of every open Dependabot alert
# whose manifest_path is under legacy/. These point at the
# jinn-cli-agents-reference git subtree retained for historical reference
# only — no live code consumes those manifests. Per .github/dependabot.yml
# the directory is omitted from scanning going forward; this script clears
# the backlog of alerts already opened before the config landed.
#
# Reason enum (GitHub REST): fix_started | inaccurate | no_bandwidth
#                            | not_used | tolerable_risk
# We use `not_used`.
#
# Usage:
#   ./.github/scripts/dismiss-legacy-dependabot-alerts.sh
#
# Re-runnable: alerts already in state `dismissed` are skipped.

set -euo pipefail

REPO="Jinn-Network/mono"
REASON="not_used"
COMMENT='legacy/jinn-cli-agents-reference is the archived git subtree retained as historical reference only — no live code consumes these manifests; per .github/dependabot.yml the directory is omitted from scanning'

echo "Enumerating open Dependabot alerts under legacy/ on ${REPO}..."

# List numbers + manifest_path of OPEN alerts under legacy/.
# Use a temp file (instead of `mapfile`/`readarray`) so the script runs on
# macOS's stock bash 3.2 as well as bash 4+ on CI.
TARGETS_FILE="$(mktemp -t legacy-dependabot-alerts.XXXXXX)"
trap 'rm -f "${TARGETS_FILE}"' EXIT

gh api "/repos/${REPO}/dependabot/alerts?state=open" --paginate \
  --jq '.[] | select((.dependency.manifest_path // "") | startswith("legacy/")) | "\(.number)\t\(.dependency.manifest_path)"' \
  > "${TARGETS_FILE}"

TOTAL="$(wc -l < "${TARGETS_FILE}" | tr -d ' ')"
echo "Found ${TOTAL} open alert(s) under legacy/."

if [[ "${TOTAL}" -eq 0 ]]; then
  echo "Nothing to dismiss. Exiting."
  exit 0
fi

i=0
while IFS=$'\t' read -r number path; do
  i=$((i + 1))
  printf "[%4d/%4d] Dismissing alert #%s (%s)... " "${i}" "${TOTAL}" "${number}" "${path}"

  if gh api \
        --method PATCH \
        -H "Accept: application/vnd.github+json" \
        "/repos/${REPO}/dependabot/alerts/${number}" \
        -f "state=dismissed" \
        -f "dismissed_reason=${REASON}" \
        -f "dismissed_comment=${COMMENT}" \
        > /dev/null; then
    echo "ok"
  else
    echo "FAILED"
    echo "  (continuing; re-run the script to retry just this alert)"
  fi

  # Be polite to the REST quota
  sleep 0.2
done < "${TARGETS_FILE}"

echo
echo "Done. Re-run the script to verify zero remaining open alerts under legacy/."
