#!/usr/bin/env bash
# THIS SCRIPT IS THE FLIP. Running it turns the merge queue on for `next` and
# makes ten CI contexts mandatory for the first time in this repository's life.
# Nothing merges into `next` afterwards except through the queue.
#
# WHAT IT DOES (DR-2026-08-18-b D2/D5/D6 step 1,
# log/decisions/2026-08-18-merge-queue-on-next.md):
#
#   1. Reads the ruleset listing once, by name.
#   2. Creates (or updates) the `next` ruleset carrying the pull-request rule
#      with dismiss-stale-on-push, the required-check set, the `merge_queue`
#      rule at the D5 constants, deletion and non-fast-forward, and EMPTY
#      bypass_actors.
#   3. Creates (or updates) a `gh-readonly-queue guard` ruleset that restricts
#      creation and non-fast-forward on `refs/heads/gh-readonly-queue/**` to the
#      merge-queue bot.
#   4. LAST: PUTs the shared "Base" ruleset back as a `main`-ONLY ruleset.
#      `~DEFAULT_BRANCH` and `refs/heads/next` drop out of its conditions, its
#      existing rules are kept verbatim, `Main base guard` is added as a
#      required status check (ported from the retired classic-API
#      .github/scripts/enable-main-base-guard.sh), and the admin bypass actor is
#      KEPT — promote-main.yml's Monday fast-forward push depends on it.
#
# The split in steps 2-4 exists because `bypass_actors` is a RULESET-level
# array: `main` needs the admin bypass and `next` must have none, and one
# ruleset cannot express both.
#
# WHY THAT ORDER, AND WHAT THE SAFETY PROPERTY ACTUALLY IS. This is not atomic —
# the API offers no transaction across three rulesets. It is ADDITIVE-FIRST, so
# protection is monotonically NON-DECREASING at every point: the new coverage
# for `next` exists before the old coverage is narrowed away. "Base" is the only
# ruleset covering `next` today, so narrowing it first and then failing the
# create would leave the default branch entirely unprotected with no rollback.
# During the overlap window `next` is covered by both rulesets, which is
# strictly stronger than either end state — a ruleset's bypass actors only
# bypass that ruleset's own rules, so Base's admin bypass cannot open a hole in
# the new `next` ruleset. Every step is create-or-update BY NAME, so the whole
# script is idempotent and safe to re-run after a partial failure; an ERR trap
# prints exactly which mutations completed and what to re-issue.
#
# WHEN TO RUN: after the pre-wire train has merged and soaked for at least
# several days (so open PR heads have accrued the new check names), immediately
# after the flip PR merges, by a repo ADMIN (ruleset writes need admin). Then
# dispatch the Architecture Policy Audit and run
# .github/scripts/verify-land-one-at-a-time.sh before Autopilot resumes
# enqueueing.
#
# Usage — DRY RUN IS THE DEFAULT. This is the flip: three rulesets and the
# default branch's protection posture, so applying is opt-in and explicit.
#   .github/scripts/enable-next-merge-queue.sh              # print every payload, mutate nothing
#   DRY_RUN=1 .github/scripts/enable-next-merge-queue.sh    # same thing, said out loud
#   APPLY=1 .github/scripts/enable-next-merge-queue.sh      # apply
#
# Environment overrides: REPO, BASE_RULESET_NAME, NEXT_RULESET_NAME,
# QUEUE_GUARD_RULESET_NAME, QUEUE_BOT_ACTOR_ID, QUEUE_BOT_ACTOR_TYPE.
# Authentication is the ambient `gh auth` session.

set -euo pipefail

REPO="${REPO:-Jinn-Network/mono}"
DRY_RUN="${DRY_RUN:-0}"
APPLY="${APPLY:-0}"

if [[ "${APPLY}" == "1" && "${DRY_RUN}" == "1" ]]; then
  echo "error: APPLY=1 and DRY_RUN=1 are contradictory; pick one." >&2
  exit 1
fi
APPLYING=0
if [[ "${APPLY}" == "1" ]]; then
  APPLYING=1
fi

BASE_RULESET_NAME="${BASE_RULESET_NAME:-Base}"
NEXT_RULESET_NAME="${NEXT_RULESET_NAME:-Next merge queue}"
QUEUE_GUARD_RULESET_NAME="${QUEUE_GUARD_RULESET_NAME:-gh-readonly-queue guard}"

# The merge queue creates `gh-readonly-queue/**` refs itself, so the guard
# ruleset in step 3 must let it through. GitHub made the merge queue selectable as a
# ruleset bypass actor in the 2025-08-26 changelog; before that, restricting
# creation of those refs was impossible without breaking the queue.
#
# The actor id is NOT hard-coded here because it cannot be resolved from an
# unauthenticated or user-token API call (`GET /apps/github-merge-queue` needs
# app authentication and 404s otherwise), and guessing it would either lock the
# queue out of its own refs — wedging every enqueue — or silently create a
# useless restriction. Resolve it once, then pass it in:
#
#   In the repository UI: Settings -> Rules -> New branch ruleset -> Bypass
#   list -> Add bypass -> select the merge queue entry. Save, then read the
#   exact encoding back:
#
#     gh api repos/$REPO/rulesets/<new-id> --jq '.bypass_actors'
#
#   Feed the reported actor_id / actor_type back in here:
#
#     QUEUE_BOT_ACTOR_ID=<id> QUEUE_BOT_ACTOR_TYPE=<type> \
#       .github/scripts/enable-next-merge-queue.sh
#
# Apply mode REFUSES to run without it, checked before any mutation. Dry run
# still prints every payload with the slot marked unset.
QUEUE_BOT_ACTOR_ID="${QUEUE_BOT_ACTOR_ID:-}"
QUEUE_BOT_ACTOR_TYPE="${QUEUE_BOT_ACTOR_TYPE:-Integration}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_CHECK_SET="${SCRIPT_DIR}/required-check-set.mjs"

for tool in gh jq node; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "error: ${tool} is required" >&2; exit 1; }
done
test -f "${REQUIRED_CHECK_SET}" || { echo "error: missing ${REQUIRED_CHECK_SET}" >&2; exit 1; }

if [[ "${APPLYING}" == "1" && -z "${QUEUE_BOT_ACTOR_ID}" ]]; then
  echo "error: QUEUE_BOT_ACTOR_ID is unset." >&2
  echo "       Creating the gh-readonly-queue restriction without the merge-queue bot" >&2
  echo "       in its bypass list would stop the queue creating its own refs and wedge" >&2
  echo "       every enqueue. Resolve the actor id first (see the header comment)," >&2
  echo "       or drop APPLY=1 to review the payloads." >&2
  exit 1
fi

# The ten required contexts are GENERATED, never hand-typed. A context this
# script registers that no workflow reports leaves every queue entry sitting on
# an unreported check until the check-response timeout ejects it, so the ruleset
# and the workflows read the same source of truth.
CONTEXTS_JSON="$(node "${REQUIRED_CHECK_SET}" --print-contexts | jq -R . | jq -s 'map({context: .})')"
CONTEXT_COUNT="$(jq 'length' <<<"${CONTEXTS_JSON}")"
if [[ "${CONTEXT_COUNT}" -lt 1 ]]; then
  echo "error: required-check-set.mjs printed no contexts" >&2
  exit 1
fi
echo "Required contexts for next (${CONTEXT_COUNT}, from required-check-set.mjs --print-contexts):"
jq -r '.[].context | "  - " + .' <<<"${CONTEXTS_JSON}"
echo

# ---------------------------------------------------------------------------
# 1. Read the ruleset listing once and resolve all three names from it.
# ---------------------------------------------------------------------------
# Resolving the two created rulesets by name here is what makes the flip
# re-runnable: a step that already completed is PUT back over its existing id
# rather than POSTed again, so a re-run after a partial failure converges
# instead of creating duplicate rulesets or hard-failing on a name collision.
echo "Reading rulesets on ${REPO} ..."
RULESET_LISTING="$(gh api "repos/${REPO}/rulesets")"
ruleset_id_by_name() {
  jq -r --arg name "$1" 'map(select(.name == $name)) | .[0].id // empty' <<<"${RULESET_LISTING}"
}
BASE_ID="$(ruleset_id_by_name "${BASE_RULESET_NAME}")"
if [[ -z "${BASE_ID}" ]]; then
  echo "error: no ruleset named '${BASE_RULESET_NAME}' on ${REPO}" >&2
  exit 1
fi
NEXT_EXISTING_ID="$(ruleset_id_by_name "${NEXT_RULESET_NAME}")"
GUARD_EXISTING_ID="$(ruleset_id_by_name "${QUEUE_GUARD_RULESET_NAME}")"
BASE_CURRENT="$(gh api "repos/${REPO}/rulesets/${BASE_ID}")"
echo "Found '${BASE_RULESET_NAME}' ruleset id=${BASE_ID}"
echo "'${NEXT_RULESET_NAME}': ${NEXT_EXISTING_ID:-absent (will be created)}"
echo "'${QUEUE_GUARD_RULESET_NAME}': ${GUARD_EXISTING_ID:-absent (will be created)}"
echo

# ---------------------------------------------------------------------------
# The Base payload: main-only, with the ported base guard. Built here, APPLIED
# LAST — see the additive-first note in the header.
# ---------------------------------------------------------------------------
# Derived from the live object rather than restated, so the pull_request rule's
# existing parameters (allowed_merge_methods, review-thread resolution, and the
# rest) survive the split byte for byte. Only three things change: the ref
# conditions narrow to main, a required_status_checks rule is added, and any
# pre-existing checks rule is replaced rather than duplicated. The admin bypass
# passes through untouched.
MAIN_PAYLOAD="$(jq \
  --argjson checks '[{"context": "Main base guard"}]' \
  '{
    name: .name,
    target: .target,
    enforcement: .enforcement,
    bypass_actors: [.bypass_actors[] | {actor_id, actor_type, bypass_mode}],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: (
      (.rules | map(select(.type != "required_status_checks")))
      + [{
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: $checks
          }
        }]
    )
  }' <<<"${BASE_CURRENT}")"

# ---------------------------------------------------------------------------
# 2. The next ruleset: pull request, required checks, merge queue, no bypass.
# ---------------------------------------------------------------------------
# `~DEFAULT_BRANCH` rides alongside the literal ref because `next` IS the
# default branch; keeping both means a future default-branch change cannot
# silently drop the queue's protection. The flip side of that belt-and-braces:
# if the default branch ever MOVES to `main`, `~DEFAULT_BRANCH` would clamp
# `main` under the queue rule and break promote-main.yml's fast-forward push.
# `exclude: ["refs/heads/main"]` is the cheap structural guard against that —
# inert while `next` is the default branch, load-bearing the day it is not.
#
# strict_required_status_checks_policy is false on purpose: "require branches to
# be up to date" is precisely the job the queue's speculative merge does, and
# turning it on would fight the queue by demanding a rebase the queue supersedes.
#
# min_entries_to_merge_wait_minutes is inert at min_entries_to_merge=1 (the
# queue never waits to accumulate a batch it already has); it is GitHub's
# default, carried so the API receives a complete parameter set.
NEXT_PAYLOAD="$(jq -n \
  --arg name "${NEXT_RULESET_NAME}" \
  --argjson checks "${CONTEXTS_JSON}" \
  '{
    name: $name,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/next"], exclude: ["refs/heads/main"] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          require_code_owner_review: true,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash", "rebase", "merge"]
        }
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: $checks
        }
      },
      {
        type: "merge_queue",
        parameters: {
          merge_method: "MERGE",
          grouping_strategy: "ALLGREEN",
          max_entries_to_merge: 1,
          min_entries_to_merge: 1,
          max_entries_to_build: 2,
          min_entries_to_merge_wait_minutes: 5,
          check_response_timeout_minutes: 180
        }
      }
    ]
  }')"

# ---------------------------------------------------------------------------
# 3. The queue-ref creation guard.
# ---------------------------------------------------------------------------
# A `creation` rule blocks creating refs that match the conditions; the bypass
# list is the exception. So "only the queue may create gh-readonly-queue refs"
# is expressed as: restrict creation of that ref pattern, bypass = the queue bot.
#
# `non_fast_forward` rides alongside `creation` for the same reason: without it,
# a ref the queue legitimately created can still be force-rewritten by anyone
# with push access, and the required contexts already reported against it then
# attest a commit nobody tested. The queue bot bypasses both.
if [[ -n "${QUEUE_BOT_ACTOR_ID}" ]]; then
  QUEUE_BYPASS="$(jq -n \
    --argjson id "${QUEUE_BOT_ACTOR_ID}" \
    --arg type "${QUEUE_BOT_ACTOR_TYPE}" \
    '[{actor_id: $id, actor_type: $type, bypass_mode: "always"}]')"
else
  QUEUE_BYPASS='"<QUEUE_BOT_ACTOR_ID unset - see the header comment>"'
fi
GUARD_PAYLOAD="$(jq -n \
  --arg name "${QUEUE_GUARD_RULESET_NAME}" \
  --argjson bypass "${QUEUE_BYPASS}" \
  '{
    name: $name,
    target: "branch",
    enforcement: "active",
    bypass_actors: $bypass,
    conditions: { ref_name: { include: ["refs/heads/gh-readonly-queue/**"], exclude: [] } },
    rules: [{ type: "creation" }, { type: "non_fast_forward" }]
  }')"

# The mutation order is the safety property, so it is stated the same way in the
# dry run and in apply mode: additive first, Base narrowed last.
verb_for() { if [[ -n "$1" ]]; then echo "PUT repos/${REPO}/rulesets/$1"; else echo "POST repos/${REPO}/rulesets"; fi; }

if [[ "${APPLYING}" != "1" ]]; then
  echo "DRY RUN (default) - nothing below is applied. Re-run with APPLY=1 to apply."
  echo
  echo "Mutation order (additive first, Base narrowed last):"
  echo "  (1) $(verb_for "${NEXT_EXISTING_ID}")  [${NEXT_RULESET_NAME}]"
  echo "  (2) $(verb_for "${GUARD_EXISTING_ID}")  [${QUEUE_GUARD_RULESET_NAME}]"
  echo "  (3) PUT repos/${REPO}/rulesets/${BASE_ID}  [${BASE_RULESET_NAME} -> main only, + Main base guard]"
  echo
  echo "=== (1) $(verb_for "${NEXT_EXISTING_ID}")  [${NEXT_RULESET_NAME}] ==="
  echo "${NEXT_PAYLOAD}"
  echo
  echo "=== (2) $(verb_for "${GUARD_EXISTING_ID}")  [${QUEUE_GUARD_RULESET_NAME}] ==="
  echo "${GUARD_PAYLOAD}"
  echo
  echo "=== (3) PUT repos/${REPO}/rulesets/${BASE_ID}  [${BASE_RULESET_NAME} -> main only, + Main base guard] ==="
  echo "${MAIN_PAYLOAD}"
  if [[ -z "${QUEUE_BOT_ACTOR_ID}" ]]; then
    echo
    echo "!!! QUEUE_BOT_ACTOR_ID is unset: payload (2) above is INCOMPLETE and APPLY=1 will refuse."
    echo "!!! Resolve the merge-queue bypass actor first (header comment), then re-run."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Apply, additive first. State is tracked at top level so the ERR trap can name
# exactly what is in force if a call fails part-way through.
# ---------------------------------------------------------------------------
FLIP_NEXT_STATE="not attempted"
FLIP_GUARD_STATE="not attempted"
FLIP_BASE_STATE="not attempted - '${BASE_RULESET_NAME}' still covers BOTH next and main"

report_partial_flip() {
  local status=$?
  trap - ERR
  {
    echo
    echo "!!! FLIP ABORTED (exit ${status}) — mutations completed so far:"
    echo "      (1) ${NEXT_RULESET_NAME}: ${FLIP_NEXT_STATE}"
    echo "      (2) ${QUEUE_GUARD_RULESET_NAME}: ${FLIP_GUARD_STATE}"
    echo "      (3) ${BASE_RULESET_NAME} -> main only: ${FLIP_BASE_STATE}"
    echo
    echo "    Because mutations are applied additive first, protection is"
    echo "    monotonically non-decreasing: nothing above can have left 'next'"
    echo "    unprotected. If (3) did not run, 'next' is covered by"
    echo "    '${BASE_RULESET_NAME}' — and, if (1) ran, by the new ruleset too."
    echo "    One window to close promptly: if (1) applied but (2) did not, the"
    echo "    queue rule is live on 'next' with no gh-readonly-queue/** guard, so"
    echo "    queue-shaped refs are forgeable until (2) lands — recover now."
    echo
    echo "    TO RECOVER: re-run the same command. Every step resolves its"
    echo "    ruleset by name and updates in place, so completed steps re-apply"
    echo "    idempotently and the failed step is retried."
    echo
    echo "    TO INSPECT FIRST: gh api repos/${REPO}/rulesets"
  } >&2
  exit "${status}"
}
trap report_partial_flip ERR

# The `next` ruleset FIRST. Until this exists, '${BASE_RULESET_NAME}' is the only
# thing protecting the default branch.
echo "Applying (1): $(verb_for "${NEXT_EXISTING_ID}") - ${NEXT_RULESET_NAME} ..."
FLIP_NEXT_STATE="IN FLIGHT - $(verb_for "${NEXT_EXISTING_ID}") did not report success; re-issue it"
if [[ -n "${NEXT_EXISTING_ID}" ]]; then
  NEXT_ID="$(echo "${NEXT_PAYLOAD}" | gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    "repos/${REPO}/rulesets/${NEXT_EXISTING_ID}" \
    --input - --jq '.id')"
else
  NEXT_ID="$(echo "${NEXT_PAYLOAD}" | gh api \
    --method POST \
    -H "Accept: application/vnd.github+json" \
    "repos/${REPO}/rulesets" \
    --input - --jq '.id')"
fi
FLIP_NEXT_STATE="APPLIED (ruleset ${NEXT_ID})"
echo "OK: ruleset ${NEXT_ID} protects next with ${CONTEXT_COUNT} required contexts, the merge queue, and no bypass actors."
echo

echo "Applying (2): $(verb_for "${GUARD_EXISTING_ID}") - ${QUEUE_GUARD_RULESET_NAME} ..."
FLIP_GUARD_STATE="IN FLIGHT - $(verb_for "${GUARD_EXISTING_ID}") did not report success; re-issue it"
if [[ -n "${GUARD_EXISTING_ID}" ]]; then
  GUARD_ID="$(echo "${GUARD_PAYLOAD}" | gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    "repos/${REPO}/rulesets/${GUARD_EXISTING_ID}" \
    --input - --jq '.id')"
else
  GUARD_ID="$(echo "${GUARD_PAYLOAD}" | gh api \
    --method POST \
    -H "Accept: application/vnd.github+json" \
    "repos/${REPO}/rulesets" \
    --input - --jq '.id')"
fi
FLIP_GUARD_STATE="APPLIED (ruleset ${GUARD_ID})"
echo "OK: ruleset ${GUARD_ID} restricts creation and non-fast-forward on refs/heads/gh-readonly-queue/** to actor ${QUEUE_BOT_ACTOR_TYPE} ${QUEUE_BOT_ACTOR_ID}."
echo

# Base narrowed LAST: this is the only subtractive step, and by now `next` has
# its own ruleset to fall back on.
echo "Applying (3): PUT repos/${REPO}/rulesets/${BASE_ID} - ${BASE_RULESET_NAME} becomes main-only ..."
FLIP_BASE_STATE="IN FLIGHT - PUT repos/${REPO}/rulesets/${BASE_ID} did not report success; re-issue it"
echo "${MAIN_PAYLOAD}" | gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/${REPO}/rulesets/${BASE_ID}" \
  --input - >/dev/null
FLIP_BASE_STATE="APPLIED (ruleset ${BASE_ID})"
echo "OK: '${BASE_RULESET_NAME}' now targets refs/heads/main only and requires 'Main base guard'."
echo "OK: its admin bypass actor is retained (promote-main.yml pushes through it)."
echo

trap - ERR

echo "THE QUEUE IS LIVE. Verify, in order:"
echo
echo "  gh api repos/${REPO}/rulesets"
echo "  GITHUB_TOKEN=\"\$(gh auth token)\" node .github/scripts/branch-protection-audit.mjs \\"
echo "    --repository ${REPO} --out /tmp/audit.json --summary /tmp/audit.md"
echo "  gh workflow run 'Architecture Policy Audit' --repo ${REPO}"
echo "  .github/scripts/verify-land-one-at-a-time.sh <pr> <pr> <pr>"
echo
echo "Autopilot stays paused until verify-land-one-at-a-time.sh passes (DR-2026-08-18-b D5)."
