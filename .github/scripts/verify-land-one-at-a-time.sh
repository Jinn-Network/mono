#!/usr/bin/env bash
# Measures the one mechanic DR-2026-08-18-b D5 carries as UNVERIFIED: whether
# speculative successors survive a landing ref-move under max_entries_to_merge=1.
#
# GitHub documents that merge limits do not combine merge_group builds. It does
# NOT document what happens to the entries queued behind one that lands. If
# successors are invalidated and rebuilt on every landing, throughput degrades
# toward one landing per full battery (45-75 min) and the DR's named fallback --
# default batching, max_entries_to_merge=5 -- comes into play. That fallback
# changes canary granularity from per-PR to per-group, so engaging it AMENDS
# handbook rule 8 and needs its own docs PR. This script is what decides.
#
# WHEN TO RUN: immediately after .github/scripts/enable-next-merge-queue.sh, by
# the admin who ran it, and BEFORE Autopilot (in its own repo) resumes
# enqueueing. Autopilot's enqueue stage stays paused until this passes.
#
# WHAT IT DOES NOT DO: create pull requests. Supply 2-3 trivial, already
# approved, already green PR numbers yourself. Everything else here is reads,
# plus one enqueue mutation per supplied PR.
#
# Usage:
#   .github/scripts/verify-land-one-at-a-time.sh 2801 2802 2803
#
# Environment overrides: REPO, BRANCH, POLL_SECONDS, TIMEOUT_MINUTES.
# Authentication is the ambient `gh auth` session.

set -euo pipefail

REPO="${REPO:-Jinn-Network/mono}"
BRANCH="${BRANCH:-next}"
POLL_SECONDS="${POLL_SECONDS:-30}"
TIMEOUT_MINUTES="${TIMEOUT_MINUTES:-240}"

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

for tool in gh jq; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "error: ${tool} is required" >&2; exit 1; }
done

if [[ "$#" -lt 2 ]]; then
  echo "usage: $0 <pr-number> <pr-number> [pr-number ...]" >&2
  echo "       supply 2-3 trivial, approved, CI-green PRs targeting ${BRANCH}" >&2
  exit 1
fi
if [[ "$#" -gt 3 ]]; then
  echo "note: ${#} PRs supplied; 2-3 is the intended shape, the extras just lengthen the run."
fi
PRS=("$@")

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

FAILURES="${WORK}/failures.txt"
: > "${FAILURES}"

fail() {
  echo "FAIL: $*"
  echo "$*" >> "${FAILURES}"
}

branch_head() {
  gh api "repos/${REPO}/commits/${BRANCH}" --jq '.sha'
}

queue_entries() {
  gh api graphql \
    -f query='
      query($owner:String!,$name:String!,$branch:String!){
        repository(owner:$owner,name:$name){
          mergeQueue(branch:$branch){
            entries(first:50){
              nodes{ id position state enqueuedAt headCommit{oid} pullRequest{number} }
            }
          }
        }
      }' \
    -f owner="${OWNER}" -f name="${NAME}" -f branch="${BRANCH}" \
    --jq '[.data.repository.mergeQueue.entries.nodes[]
           | {pr: .pullRequest.number, position, state, enqueuedAt, head: (.headCommit.oid // "")}]'
}

pull_request_head() {
  gh api graphql \
    -f query='
      query($owner:String!,$name:String!,$number:Int!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){ id number headRefOid baseRefName state }
        }
      }' \
    -f owner="${OWNER}" -f name="${NAME}" -F number="$1" \
    --jq '.data.repository.pullRequest'
}

pull_request_merged() {
  gh api "repos/${REPO}/pulls/$1" --jq '.merged'
}

echo "Repository: ${REPO}    branch: ${BRANCH}"
echo "PRs under test: ${PRS[*]}"
echo "Poll interval: ${POLL_SECONDS}s    timeout: ${TIMEOUT_MINUTES}m"
echo

START_EPOCH="$(date +%s)"
DEADLINE=$((START_EPOCH + TIMEOUT_MINUTES * 60))
BASE_START="$(branch_head)"
echo "${BRANCH} starts at ${BASE_START}"
echo

# ---------------------------------------------------------------------------
# Enqueue every supplied PR, pinned to the exact head that was reviewed.
# ---------------------------------------------------------------------------
# expectedHeadOid is the same exact-head discipline rule 4 already runs on: if
# the head moved between the read and the mutation, the enqueue is refused
# rather than queueing an unreviewed commit.
for pr in "${PRS[@]}"; do
  INFO="$(pull_request_head "${pr}")"
  PR_ID="$(jq -r '.id' <<<"${INFO}")"
  PR_HEAD="$(jq -r '.headRefOid' <<<"${INFO}")"
  PR_BASE="$(jq -r '.baseRefName' <<<"${INFO}")"
  if [[ "${PR_BASE}" != "${BRANCH}" ]]; then
    echo "error: PR #${pr} targets ${PR_BASE}, not ${BRANCH}" >&2
    exit 1
  fi
  echo "Enqueueing PR #${pr} at head ${PR_HEAD} ..."
  ENQUEUED="$(gh api graphql \
    -f query='
      mutation($id:ID!,$oid:GitObjectID!){
        enqueuePullRequest(input:{pullRequestId:$id, expectedHeadOid:$oid}){
          mergeQueueEntry{ id position state }
        }
      }' \
    -f id="${PR_ID}" -f oid="${PR_HEAD}" \
    --jq '.data.enqueuePullRequest.mergeQueueEntry | "position=\(.position) state=\(.state)"')"
  echo "  #${pr} ${ENQUEUED}"
  # Record the head the queue built for this entry, so a later change to it is
  # visible as a rebuild rather than being silently absorbed.
  echo "" > "${WORK}/${pr}.head"
  echo "" > "${WORK}/${pr}.state"
done
echo

# ---------------------------------------------------------------------------
# Observe.
# ---------------------------------------------------------------------------
PREV_BASE="${BASE_START}"
LANDINGS=0
POLL=0

while :; do
  NOW="$(date +%s)"
  if [[ "${NOW}" -gt "${DEADLINE}" ]]; then
    fail "timed out after ${TIMEOUT_MINUTES} minutes with ${LANDINGS} landing(s) observed"
    break
  fi

  POLL=$((POLL + 1))
  CURRENT_BASE="$(branch_head)"
  ENTRIES="$(queue_entries)"
  ELAPSED=$(( (NOW - START_EPOCH) / 60 ))

  echo "[poll ${POLL}  +${ELAPSED}m] ${BRANCH}=${CURRENT_BASE:0:12}  queue: $(jq -r 'if length == 0 then "(empty)" else map("#\(.pr) pos=\(.position) \(.state)") | join("  ") end' <<<"${ENTRIES}")"

  # --- successor survival -------------------------------------------------
  # A successor that survives a predecessor's landing keeps the speculative
  # merge commit it was already built and tested on. A successor rebuilt from
  # scratch gets a NEW head commit, and its state falls back out of MERGEABLE.
  for pr in "${PRS[@]}"; do
    ENTRY_HEAD="$(jq -r --argjson pr "${pr}" 'map(select(.pr == $pr)) | .[0].head // ""' <<<"${ENTRIES}")"
    ENTRY_STATE="$(jq -r --argjson pr "${pr}" 'map(select(.pr == $pr)) | .[0].state // ""' <<<"${ENTRIES}")"
    LAST_HEAD="$(cat "${WORK}/${pr}.head")"
    LAST_STATE="$(cat "${WORK}/${pr}.state")"
    if [[ -n "${ENTRY_HEAD}" && -n "${LAST_HEAD}" && "${ENTRY_HEAD}" != "${LAST_HEAD}" && "${LANDINGS}" -gt 0 ]]; then
      fail "successor #${pr} was rebuilt: speculative head moved ${LAST_HEAD:0:12} -> ${ENTRY_HEAD:0:12} after a landing"
    fi
    if [[ "${LAST_STATE}" == "MERGEABLE" && -n "${ENTRY_STATE}" && "${ENTRY_STATE}" != "MERGEABLE" && "${LANDINGS}" -gt 0 ]]; then
      fail "successor #${pr} fell back from MERGEABLE to ${ENTRY_STATE} after a landing"
    fi
    if [[ -n "${ENTRY_HEAD}" ]]; then echo "${ENTRY_HEAD}" > "${WORK}/${pr}.head"; fi
    if [[ -n "${ENTRY_STATE}" ]]; then echo "${ENTRY_STATE}" > "${WORK}/${pr}.state"; fi
  done

  # --- landing granularity ------------------------------------------------
  if [[ "${CURRENT_BASE}" != "${PREV_BASE}" ]]; then
    LANDINGS=$((LANDINGS + 1))
    ADVANCE="$(gh api "repos/${REPO}/compare/${PREV_BASE}...${CURRENT_BASE}")"
    MERGE_SHAS="$(jq -r '.commits[] | select((.parents | length) >= 2) | .sha' <<<"${ADVANCE}")"
    MERGE_COUNT="$(printf '%s\n' "${MERGE_SHAS}" | grep -c '[0-9a-f]' || true)"
    echo
    echo "  LANDING ${LANDINGS}: ${BRANCH} ${PREV_BASE:0:12} -> ${CURRENT_BASE:0:12} (${MERGE_COUNT} merge commit(s))"
    jq -r '.commits[] | select((.parents | length) >= 2) | "    " + .sha[0:12] + "  " + (.commit.message | split("\n")[0])' <<<"${ADVANCE}"

    # Under land-one-at-a-time each push carries exactly one merge commit. Two
    # or more in a single advance is a batched push -- the fallback condition.
    if [[ "${MERGE_COUNT}" -gt 1 ]]; then
      fail "landing ${LANDINGS} pushed ${MERGE_COUNT} merge commits in one advance (batched push)"
    fi

    # The landed commit must be the commit the queue tested: the speculative
    # head this run already observed for one of the entries.
    MATCHED=""
    for pr in "${PRS[@]}"; do
      if [[ "$(cat "${WORK}/${pr}.head")" == "${CURRENT_BASE}" ]]; then MATCHED="${pr}"; fi
    done
    for sha in ${MERGE_SHAS}; do
      for pr in "${PRS[@]}"; do
        if [[ "$(cat "${WORK}/${pr}.head")" == "${sha}" ]]; then MATCHED="${pr}"; fi
      done
    done
    if [[ -n "${MATCHED}" ]]; then
      echo "    tested commit == landed commit (PR #${MATCHED})"
    else
      echo "    note: landed commit did not match a speculative head this run observed;"
      echo "          the entry may have landed between polls. Re-run with a smaller"
      echo "          POLL_SECONDS if this repeats. Not counted as a failure."
    fi
    echo
    PREV_BASE="${CURRENT_BASE}"
  fi

  # --- done? --------------------------------------------------------------
  REMAINING=0
  for pr in "${PRS[@]}"; do
    if [[ "$(pull_request_merged "${pr}")" != "true" ]]; then REMAINING=$((REMAINING + 1)); fi
  done
  if [[ "${REMAINING}" -eq 0 ]]; then
    echo "All ${#PRS[@]} PRs merged."
    break
  fi

  sleep "${POLL_SECONDS}"
done

# ---------------------------------------------------------------------------
# Report.
# ---------------------------------------------------------------------------
TOTAL=$(( ($(date +%s) - START_EPOCH) / 60 ))
echo
echo "================================================================"
echo "PRs under test:      ${PRS[*]}"
echo "Landings observed:   ${LANDINGS}"
echo "Total time:          ${TOTAL} minutes"
echo "${BRANCH}:           ${BASE_START:0:12} -> $(branch_head | cut -c1-12)"
echo "================================================================"

if [[ -s "${FAILURES}" ]]; then
  echo
  echo "MECHANIC FAILED"
  echo
  while IFS= read -r line; do echo "  - ${line}"; done < "${FAILURES}"
  echo
  echo "The land-one-at-a-time mechanic did not hold. DR-2026-08-18-b D5 names the"
  echo "fallback: default batching (max_entries_to_merge=5). That changes canary"
  echo "granularity from per-PR to per-group, which AMENDS handbook rule 8 and"
  echo "requires its own docs PR before the queue configuration is changed."
  echo "Do not resume Autopilot enqueueing until that decision is taken."
  exit 1
fi

echo
echo "MECHANIC HELD: one push per landed PR, successors survived each landing."
echo "Autopilot enqueueing may resume (DR-2026-08-18-b D5)."
