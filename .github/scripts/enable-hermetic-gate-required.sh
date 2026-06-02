#!/usr/bin/env bash
# Promotes the "hermetic-gate" check to a REQUIRED status check on `next`
# (spec docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md
# §3.1, §7; #923). Mirrors .github/scripts/enable-main-base-guard.sh.
#
# Per the two-gate redesign, PRs merge to `next` only when the deterministic
# hermetic gate is green for the head SHA. This script registers that as a
# branch-protection required status check on `next`.
#
# Run once, by a repo admin, AFTER .github/workflows/hermetic-gate.yml has landed
# on `next` and run at least once (so the "hermetic-gate" check-run context
# appears in GitHub's status-context catalogue).
#
# Full-replace caveat (same as the main guard): the protection endpoint is PUT,
# not PATCH — anything missing from the payload is DROPPED. To avoid silently
# dropping `next`'s existing protections, this script READS `next`'s current
# protection, INJECTS "hermetic-gate" into required_status_checks.contexts
# (preserving every other field), and PUTs the merged object back. If `next` has
# no protection yet, it falls back to a documented baseline payload.
#
# The future "environment-suite" check (environment-suite.yml) is intentionally
# NOT made required on `next` here: it runs at cut cadence (Thursday pre-flight +
# on-demand readiness dispatch), NOT per-PR (spec §8), so requiring it per-PR
# would block every merge on a weekly real-testnet run. Its verdict gates the
# CUT via the publish guard (npm-publish.yml §7), not the merge to `next`. When
# that policy changes, add "environment-suite" to REQUIRED_CONTEXTS below.
#
# Usage:
#   .github/scripts/enable-hermetic-gate-required.sh              # apply
#   DRY_RUN=1 .github/scripts/enable-hermetic-gate-required.sh    # print payload only

set -euo pipefail

REPO="${REPO:-Jinn-Network/mono}"
BRANCH="${BRANCH:-next}"
# Must match the check-run name produced by hermetic-gate.yml (the "hermetic-gate"
# context per the two-gate spec §3.1). Keep in lockstep with that workflow.
CONTEXT="${CONTEXT:-hermetic-gate}"

# Contexts to require on `next`. environment-suite is deliberately excluded — see
# the header note (it gates the cut, not the per-PR merge).
REQUIRED_CONTEXTS=("${CONTEXT}")

# jq program: merge REQUIRED_CONTEXTS into the existing protection object's
# required_status_checks.contexts (dedup, preserve order), keep strict as-is,
# and reshape the rest of the protection object into the PUT payload schema
# (the GET shape and the PUT shape differ slightly — required_pull_request_reviews
# and restrictions especially).
build_merged_payload() {
  local current_json="$1"
  CTX_JSON=$(printf '%s\n' "${REQUIRED_CONTEXTS[@]}" | jq -R . | jq -s .)
  echo "${current_json}" | jq --argjson add "${CTX_JSON}" '
    {
      required_status_checks: {
        strict: (.required_status_checks.strict // false),
        contexts: (((.required_status_checks.contexts // []) + $add) | unique)
      },
      enforce_admins: (.enforce_admins.enabled // false),
      required_pull_request_reviews: (
        if .required_pull_request_reviews then {
          dismiss_stale_reviews: (.required_pull_request_reviews.dismiss_stale_reviews // false),
          require_code_owner_reviews: (.required_pull_request_reviews.require_code_owner_reviews // false),
          required_approving_review_count: (.required_pull_request_reviews.required_approving_review_count // 0),
          require_last_push_approval: (.required_pull_request_reviews.require_last_push_approval // false)
        } else null end
      ),
      restrictions: null,
      required_linear_history: (.required_linear_history.enabled // false),
      allow_force_pushes: (.allow_force_pushes.enabled // false),
      allow_deletions: (.allow_deletions.enabled // false),
      required_conversation_resolution: (.required_conversation_resolution.enabled // false),
      lock_branch: (.lock_branch.enabled // false),
      allow_fork_syncing: (.allow_fork_syncing.enabled // false),
      block_creations: (.block_creations.enabled // false)
    }'
}

# Documented baseline used only when `next` has NO protection yet. Mirrors the
# main-base-guard baseline; enforce_admins=false keeps an emergency override.
baseline_payload() {
  CTX_JSON=$(printf '%s\n' "${REQUIRED_CONTEXTS[@]}" | jq -R . | jq -s .)
  jq -n --argjson contexts "${CTX_JSON}" '
    {
      required_status_checks: { strict: false, contexts: $contexts },
      enforce_admins: false,
      required_pull_request_reviews: {
        dismiss_stale_reviews: false,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: false
      },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      required_conversation_resolution: false,
      lock_branch: false,
      allow_fork_syncing: false,
      block_creations: false
    }'
}

echo "Reading current protection for ${REPO}@${BRANCH} ..."
if CURRENT=$(gh api "repos/${REPO}/branches/${BRANCH}/protection" 2>/dev/null); then
  PAYLOAD=$(build_merged_payload "${CURRENT}")
  echo "Merging '${CONTEXT}' into existing protection (preserving other fields)."
else
  echo "No existing protection on ${BRANCH}; applying documented baseline."
  PAYLOAD=$(baseline_payload)
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "Would PUT repos/${REPO}/branches/${BRANCH}/protection with:"
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
echo
echo "Note: 'environment-suite' is NOT required per-PR on ${BRANCH} by design — it"
echo "gates the CUT via the npm-publish.yml two-gate guard, not the merge to next."
