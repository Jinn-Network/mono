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
# THE INSTRUMENT IS CONTROLLED. A verification script that can silently fail to
# measure and then print a pass is worse than no script: it would retire D5's
# UNVERIFIED question on no evidence. Three things guard against that here.
# Before enqueueing, the merge_queue rule in EFFECT on the branch is read and
# max_entries_to_merge is required to be 1 — the mechanic only exists at 1, so
# claiming it held under 1 without reading it is an unfounded claim. During the
# run, every survival comparison actually evaluated is counted, and at least one
# entry must report a headCommit distinct from its pull request's own head,
# which is the premise (entry head == speculative merge commit) the comparisons
# rest on. If either control comes up empty the verdict is CANNOT MEASURE, and
# that exits non-zero exactly like a failure. An empty queue with PRs still
# unmerged is an ejection: reported immediately, not polled out to the timeout.
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

# The rules in EFFECT on the branch, not a ruleset the flip script happens to
# have named. Whatever supplies the merge_queue rule, this is what GitHub is
# actually running the queue under.
effective_merge_queue_rule() {
  gh api "repos/${REPO}/rules/branches/${BRANCH}" \
    --jq 'map(select(.type == "merge_queue")) | .[0] // empty'
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
# Precondition: the queue really is configured land-one-at-a-time.
# ---------------------------------------------------------------------------
# Reporting "the mechanic held under max_entries_to_merge=1" without ever having
# read max_entries_to_merge is an unfounded claim, and an unfounded pass here is
# what would retire D5's UNVERIFIED question on no evidence. Read it once, up
# front, and refuse to run otherwise — enqueueing under the wrong configuration
# measures a different mechanic and burns the trivial PRs doing it.
QUEUE_RULE="$(effective_merge_queue_rule)"
if [[ -z "${QUEUE_RULE}" ]]; then
  echo "error: no merge_queue rule is in effect on ${BRANCH}." >&2
  echo "       There is no queue to measure — run .github/scripts/enable-next-merge-queue.sh first." >&2
  exit 1
fi
MAX_ENTRIES_TO_MERGE="$(jq -r '.parameters.max_entries_to_merge // "unset"' <<<"${QUEUE_RULE}")"
if [[ "${MAX_ENTRIES_TO_MERGE}" != "1" ]]; then
  echo "error: ${BRANCH}'s merge_queue has max_entries_to_merge=${MAX_ENTRIES_TO_MERGE}, not 1." >&2
  echo "       This script measures the land-one-at-a-time mechanic, which only exists at 1." >&2
  echo "       Under batching the successor question is moot and the run would prove nothing." >&2
  exit 1
fi
echo "Queue configuration in effect on ${BRANCH}: max_entries_to_merge=1, $(jq -r '.parameters | "grouping=\(.grouping_strategy) build=\(.max_entries_to_build)"' <<<"${QUEUE_RULE}")"
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
  # visible as a rebuild rather than being silently absorbed. The PR's own head
  # is recorded separately: the instrument's whole premise is that the entry
  # head is the SPECULATIVE merge commit and not this, and that premise is
  # asserted rather than assumed (see the control checks in the report).
  echo "" > "${WORK}/${pr}.head"
  echo "" > "${WORK}/${pr}.state"
  echo "${PR_HEAD}" > "${WORK}/${pr}.prhead"
done
echo

# ---------------------------------------------------------------------------
# Observe.
# ---------------------------------------------------------------------------
PREV_BASE="${BASE_START}"
LANDINGS=0
POLL=0
# Instrument controls. Three independent conditions can silently disable the
# survival measurement (a null headCommit, an entry never observed twice, a
# state that never reached MERGEABLE), and a disabled measurement that prints
# "MECHANIC HELD" is worse than no run at all — it would retire D5's UNVERIFIED
# question on no evidence. So: count what was actually evaluated, prove the
# entry head really is the speculative merge commit, and fail if either control
# comes up empty.
SURVIVAL_COMPARISONS=0
SPECULATIVE_HEADS_SEEN=0
EMPTY_QUEUE_STREAK=0
EJECTED=0

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

  # --- landing granularity ------------------------------------------------
  # This block runs BEFORE successor survival, and the order is load-bearing.
  # The survival assertions are gated on a landing having been observed; with
  # survival first, the poll that first sees a landing overwrites the stored
  # heads while LANDINGS is still 0, so the rebuild the ref-move caused is
  # absorbed at exactly the poll that could have detected it. With the DR's
  # 2-PR minimum that leaves the assertion never evaluating at all.
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

  # --- successor survival -------------------------------------------------
  # A successor that survives a predecessor's landing keeps the speculative
  # merge commit it was already built and tested on. A successor rebuilt from
  # scratch gets a NEW head commit, and its state falls back out of MERGEABLE.
  for pr in "${PRS[@]}"; do
    ENTRY_HEAD="$(jq -r --argjson pr "${pr}" 'map(select(.pr == $pr)) | .[0].head // ""' <<<"${ENTRIES}")"
    ENTRY_STATE="$(jq -r --argjson pr "${pr}" 'map(select(.pr == $pr)) | .[0].state // ""' <<<"${ENTRIES}")"
    LAST_HEAD="$(cat "${WORK}/${pr}.head")"
    LAST_STATE="$(cat "${WORK}/${pr}.state")"

    # Control (a): the entry head must be the SPECULATIVE merge commit, not the
    # PR's own head. If GraphQL reported the PR head instead, every comparison
    # below is measuring the wrong thing and the run cannot conclude anything.
    if [[ -n "${ENTRY_HEAD}" && "${ENTRY_HEAD}" != "$(cat "${WORK}/${pr}.prhead")" ]]; then
      if [[ "${SPECULATIVE_HEADS_SEEN}" -eq 0 ]]; then
        echo "  control: entry head ${ENTRY_HEAD:0:12} differs from #${pr}'s own head — speculative merge commits are observable"
      fi
      SPECULATIVE_HEADS_SEEN=$((SPECULATIVE_HEADS_SEEN + 1))
    fi

    EVALUATED=0
    if [[ "${LANDINGS}" -gt 0 && -n "${ENTRY_HEAD}" && -n "${LAST_HEAD}" ]]; then
      EVALUATED=1
      if [[ "${ENTRY_HEAD}" != "${LAST_HEAD}" ]]; then
        fail "successor #${pr} was rebuilt: speculative head moved ${LAST_HEAD:0:12} -> ${ENTRY_HEAD:0:12} after a landing"
      fi
    fi
    if [[ "${LANDINGS}" -gt 0 && "${LAST_STATE}" == "MERGEABLE" && -n "${ENTRY_STATE}" ]]; then
      EVALUATED=1
      if [[ "${ENTRY_STATE}" != "MERGEABLE" ]]; then
        fail "successor #${pr} fell back from MERGEABLE to ${ENTRY_STATE} after a landing"
      fi
    fi
    if [[ "${EVALUATED}" -eq 1 ]]; then
      SURVIVAL_COMPARISONS=$((SURVIVAL_COMPARISONS + 1))
    fi

    if [[ -n "${ENTRY_HEAD}" ]]; then echo "${ENTRY_HEAD}" > "${WORK}/${pr}.head"; fi
    if [[ -n "${ENTRY_STATE}" ]]; then echo "${ENTRY_STATE}" > "${WORK}/${pr}.state"; fi
  done

  # --- done? --------------------------------------------------------------
  REMAINING=0
  for pr in "${PRS[@]}"; do
    if [[ "$(pull_request_merged "${pr}")" != "true" ]]; then REMAINING=$((REMAINING + 1)); fi
  done
  if [[ "${REMAINING}" -eq 0 ]]; then
    echo "All ${#PRS[@]} PRs merged."
    break
  fi

  # --- ejection -------------------------------------------------------------
  # An empty queue with PRs still unmerged means the queue dropped them — a
  # failing required check, a check-response timeout, a conflict. That is a
  # terminal outcome, not a slow one, and polling it out for the remaining
  # TIMEOUT_MINUTES buys nothing. Two consecutive empty polls, because the queue
  # can legitimately read empty for one poll between the final landing and the
  # merged flag propagating on the REST side.
  if [[ "$(jq -r 'length' <<<"${ENTRIES}")" -eq 0 ]]; then
    EMPTY_QUEUE_STREAK=$((EMPTY_QUEUE_STREAK + 1))
  else
    EMPTY_QUEUE_STREAK=0
  fi
  if [[ "${EMPTY_QUEUE_STREAK}" -ge 2 ]]; then
    EJECTED=1
    fail "the queue is empty with ${REMAINING} of ${#PRS[@]} PR(s) still unmerged: the entries were ejected, not landed"
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
echo "PRs under test:         ${PRS[*]}"
echo "Landings observed:      ${LANDINGS}"
echo "Survival comparisons:   ${SURVIVAL_COMPARISONS}"
echo "Speculative heads seen: ${SPECULATIVE_HEADS_SEEN}"
echo "Total time:             ${TOTAL} minutes"
echo "${BRANCH}:              ${BASE_START:0:12} -> $(branch_head | cut -c1-12)"
echo "================================================================"

if [[ -s "${FAILURES}" ]]; then
  echo
  if [[ "${EJECTED}" == "1" ]]; then echo "ENTRIES EJECTED - CANNOT MEASURE THIS MECHANIC"; else echo "MECHANIC FAILED"; fi
  echo
  while IFS= read -r line; do echo "  - ${line}"; done < "${FAILURES}"
  echo
  if [[ "${EJECTED}" == "1" ]]; then
    # An ejection is not evidence about batching, so it must not route the
    # operator to D5's fallback. The queue dropped the entries before the
    # mechanic could be measured; the question stays open.
    echo "The entries left the queue without landing, so this run says nothing about"
    echo "the land-one-at-a-time mechanic — DR-2026-08-18-b D5 stays UNVERIFIED."
    echo "Read each PR's timeline for the ejection reason: a required context nothing"
    echo "reports, a check-response timeout, or a conflict against the moved base."
    echo "Fix that first, then re-run this script."
  else
    echo "The land-one-at-a-time mechanic did not hold. DR-2026-08-18-b D5 names the"
    echo "fallback: default batching (max_entries_to_merge=5). That changes canary"
    echo "granularity from per-PR to per-group, which AMENDS handbook rule 8 and"
    echo "requires its own docs PR before the queue configuration is changed."
  fi
  echo "Do not resume Autopilot enqueueing until that decision is taken."
  exit 1
fi

# No recorded failure is not the same as a measurement. Both controls have to
# have fired, or the only honest verdict is that the instrument did not measure
# the mechanic — which is NOT a pass, and leaves D5's question open.
if [[ "${SPECULATIVE_HEADS_SEEN}" -eq 0 ]]; then
  echo
  echo "CANNOT MEASURE THIS MECHANIC"
  echo
  echo "  No queue entry ever reported a headCommit distinct from its pull request's"
  echo "  own head. The whole instrument rests on entry.headCommit.oid being the"
  echo "  SPECULATIVE merge commit; without one observation proving that, every"
  echo "  survival comparison below compared the wrong thing."
  echo
  echo "  Likely causes: the API stopped populating headCommit, or POLL_SECONDS"
  echo "  (${POLL_SECONDS}s) is coarse enough that no entry was seen while building."
  echo "  Re-run with a smaller POLL_SECONDS. D5 stays UNVERIFIED."
  exit 1
fi
if [[ "${SURVIVAL_COMPARISONS}" -eq 0 ]]; then
  echo
  echo "CANNOT MEASURE THIS MECHANIC"
  echo
  echo "  ${LANDINGS} landing(s) were observed, but not one successor-survival"
  echo "  comparison was actually evaluated: no entry was seen both before and"
  echo "  after a landing, so nothing was compared."
  echo
  echo "  Re-run with a smaller POLL_SECONDS (currently ${POLL_SECONDS}s), or with"
  echo "  more PRs, so a successor is observed on both sides of a landing."
  echo "  D5 stays UNVERIFIED."
  exit 1
fi

echo
echo "MECHANIC HELD under max_entries_to_merge=1: one push per landed PR, and"
echo "successors survived each landing across ${SURVIVAL_COMPARISONS} evaluated comparison(s)."
echo "Autopilot enqueueing may resume (DR-2026-08-18-b D5)."
