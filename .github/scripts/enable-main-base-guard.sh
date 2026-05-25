#!/usr/bin/env bash
# Promotes the "Main base guard" check to a required status check on main.
#
# Run once, by a repo admin, after .github/workflows/main-base-guard.yml has
# landed on main and run at least once (so the check appears in GitHub's
# status-context catalogue).
#
# The call PUTs the full branch-protection object (PATCH is not supported
# at this endpoint). The payload mirrors main's current settings exactly:
# required_pull_request_reviews, require_code_owner_reviews,
# required_linear_history, required_conversation_resolution, enforce_admins=false,
# and restrictions=null. If main's protection drifts, update this payload
# in lockstep — PUT is a full replace, so anything missing from the payload
# is dropped.
#
# Usage:
#   .github/scripts/enable-main-base-guard.sh              # apply
#   DRY_RUN=1 .github/scripts/enable-main-base-guard.sh    # print payload only

set -euo pipefail

REPO="${REPO:-Jinn-Network/mono}"
BRANCH="${BRANCH:-main}"
CONTEXT="${CONTEXT:-Main base guard}"   # must match the job's display name in main-base-guard.yml

PAYLOAD=$(cat <<EOF
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["${CONTEXT}"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false,
  "block_creations": false
}
EOF
)

# enforce_admins=false is intentional: matches main's current protection so
# Captain retains an emergency override for hotfixes that need to bypass the
# guard (e.g., a security disclosure where the guard itself is misfiring).
# Flip to true via the GitHub UI if that policy stance changes.

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "Would PATCH repos/${REPO}/branches/${BRANCH}/protection with:"
  echo "${PAYLOAD}"
  exit 0
fi

echo "${PAYLOAD}" | gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/${REPO}/branches/${BRANCH}/protection" \
  --input -

echo
echo "OK: required_status_checks now requires '${CONTEXT}' on ${BRANCH}."
echo "Verify with: gh api repos/${REPO}/branches/${BRANCH}/protection | jq .required_status_checks"
