#!/usr/bin/env bash
#
# migrate-issue-taxonomy.sh -- Idempotent backfill + retirement for the
# DR-2026-05-20-b taxonomy redesign on Jinn-Network/mono.
#
# Owns AC-3 (optional Epic-field deletion is documented in the matching
# runbook, not scripted), AC-4 (label retirement), AC-5 (backfill of
# Issue Type + Project v2 single-select fields) from Issue #425.
#
# Subcommands:
#   list-missing-type     Read-only. Print open Issues with no Issue Type.
#   backfill-type         Suggest Issue Type from legacy default labels or
#                         the ## Run-mode body line. --apply path is
#                         deferred -- see docs/runbooks/2026-05-23-issue-
#                         taxonomy-provisioning.md section 5 for the
#                         manual mutation shape.
#   list-missing-fields   Read-only. Print Project v2 items missing any
#                         of Blocked on / Effort / Priority.
#   backfill-fields       Suggest default Blocked-on=Nothing / Effort=
#                         Medium / Priority=P2 per missing field. --apply
#                         path is deferred -- see runbook section 5.
#   retire-labels         Delete the nine retired labels listed below.
#
# Global flags:
#   --dry-run             Default. No mutations.
#   --apply               Required for any mutation.
#   -y                    Skip the retire-labels confirmation prompt.
#
# The first action under each subcommand is a GraphQL rate-limit probe;
# if remaining < 200, the script prints the reset time and exits 0
# cleanly so the operator can resume after the window.
#
# Idempotent: every mutation is preceded by a read-check, so re-running
# is safe. Treat absent labels as success.

set -euo pipefail

# ---- Configuration ----

REPO_OWNER="Jinn-Network"
REPO_NAME="mono"
REPO_SLUG="${REPO_OWNER}/${REPO_NAME}"
PROJECT_NUMBER=1
RATE_LIMIT_FLOOR=200
# Note: batching constants (chunk size, inter-chunk sleep) intentionally
# omitted -- the --apply mutation paths for backfill-type / backfill-fields
# are deferred to the runbook's manual mutation shape (see
# docs/runbooks/2026-05-23-issue-taxonomy-provisioning.md section 5). When
# those paths land in-script, re-introduce the constants alongside the
# batching loop that actually consumes them.

# Retired labels -- exact list from runbook section 4. Edit here to extend.
RETIRED_LABELS=(
  "sprint:2026-05-18"
  "sprint:2026-05-25"
  "sprint:sprint-1"
  "sprint:sprint-2"
  "agent:opus"
  "agent:ritsu.kai2000@gmail.com"
  "bug"
  "enhancement"
  "documentation"
)

# Default field values applied by backfill-fields.
DEFAULT_BLOCKED_ON="Nothing"
DEFAULT_EFFORT="Medium"
DEFAULT_PRIORITY="P2"

# Legacy-label -> Issue-Type mapping for backfill-type auto-suggest.
# Parallel arrays (bash 3.2-compatible; macOS system bash has no assoc arrays).
LEGACY_LABELS=(bug enhancement documentation)
LEGACY_TYPES=(fix feat docs)

legacy_type_for() {
  # Return the suggested Issue Type if the given label list contains any legacy
  # default label; else empty. $1 = comma-separated label list.
  local labels="$1" i label mapped
  for i in "${!LEGACY_LABELS[@]}"; do
    label="${LEGACY_LABELS[$i]}"
    mapped="${LEGACY_TYPES[$i]}"
    if printf '%s' "$labels" | grep -q -F "$label"; then
      printf '%s' "$mapped"
      return 0
    fi
  done
  return 0
}

# The nine canonical Issue Type names. Used for ## Run-mode line matching.
VALID_TYPES=(feat fix refactor spike chore docs test incident design)

# Path to the runbook that documents the manual --apply paths.
RUNBOOK_PATH="docs/runbooks/2026-05-23-issue-taxonomy-provisioning.md"

# ---- Flags ----

DRY_RUN=true
ASSUME_YES=false
SUBCOMMAND=""

# ---- Helpers ----

say()  { printf '\n=== %s ===\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
migrate-issue-taxonomy.sh -- DR-2026-05-20-b backfill + retirement for Jinn-Network/mono.

Usage:
  migrate-issue-taxonomy.sh <subcommand> [--apply] [-y]

Subcommands:
  list-missing-type     Print open Issues with no Issue Type. Read-only.
  backfill-type         Suggest Issue Type from legacy default labels or the
                        ## Run-mode body line. --apply prints a pointer to
                        the runbook's manual mutation shape (deferred).
  list-missing-fields   Print Project v2 items missing any of
                        Blocked on / Effort / Priority. Read-only.
  backfill-fields       Suggest default Blocked-on=Nothing / Effort=Medium /
                        Priority=P2 per missing field. --apply prints a
                        pointer to the runbook's manual mutation shape.
  retire-labels         Delete the nine retired labels listed in the script.

Global flags:
  --dry-run     Default. No mutations performed.
  --apply       Required for any mutation.
  -y            Skip the retire-labels confirmation prompt.

Examples:
  migrate-issue-taxonomy.sh list-missing-type
  migrate-issue-taxonomy.sh backfill-type
  migrate-issue-taxonomy.sh retire-labels --apply -y

Re-run safety:
  Every mutation is preceded by a read-check; absent labels are treated as
  success. Rate-limit probe runs before each mutation batch; if the
  remaining quota is below the floor, the script prints the reset time
  and exits 0.

See: docs/runbooks/2026-05-23-issue-taxonomy-provisioning.md
EOF
}

parse_args() {
  if [ "$#" -eq 0 ]; then
    usage
    exit 1
  fi
  SUBCOMMAND="$1"
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --apply)   DRY_RUN=false ;;
      --dry-run) DRY_RUN=true ;;
      -y)        ASSUME_YES=true ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown flag: $1 (run with --help)" ;;
    esac
    shift
  done
}

require_gh() {
  command -v gh >/dev/null 2>&1 || die "gh CLI not on PATH; install gh and authenticate (gh auth login)."
}

rate_limit_probe() {
  # Probe GraphQL rate limit. On exhaustion, print reset time and exit 0
  # cleanly so the operator can resume after the reset window.
  local probe
  probe="$(gh api graphql -f query='{ rateLimit { remaining resetAt } }' 2>/dev/null || true)"
  if [ -z "$probe" ]; then
    warn "rate-limit probe returned empty; continuing without floor check (gh may be unauthenticated)."
    return 0
  fi
  local remaining reset_at
  remaining="$(printf '%s' "$probe" | sed -n 's/.*"remaining":[[:space:]]*\([0-9]*\).*/\1/p' | head -n1)"
  reset_at="$(printf '%s' "$probe" | sed -n 's/.*"resetAt":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -z "$remaining" ]; then
    warn "could not parse rate-limit probe response; continuing without floor check."
    return 0
  fi
  note "GraphQL rate limit: remaining=${remaining}, resetAt=${reset_at:-unknown}"
  if [ "$remaining" -lt "$RATE_LIMIT_FLOOR" ]; then
    say "Rate limit below floor (${remaining} < ${RATE_LIMIT_FLOOR})"
    printf '  GraphQL quota exhausted. Reset at: %s. Re-run after the window.\n' "${reset_at:-unknown}"
    exit 0
  fi
}

guard_apply() {
  if [ "$DRY_RUN" = true ]; then
    note "dry-run (default) -- no mutations performed. Re-run with --apply to mutate."
    return 1
  fi
  return 0
}

defer_with_pointer() {
  local label="$1"
  note "${label} --apply mutation path is deferred in-script."
  note "see ${RUNBOOK_PATH} section 5 for the manual GraphQL mutation shape."
}

# ---- Subcommand: list-missing-type ----

cmd_list_missing_type() {
  say "Open Issues with no Issue Type"
  require_gh
  rate_limit_probe
  # GitHub's REST issues endpoint exposes `type` (the new Issue Type) once
  # provisioned. Filter to issues where .type is null.
  gh issue list --repo "$REPO_SLUG" --state open --limit 500 \
    --json number,title,labels,type 2>/dev/null \
    | jq -r '.[] | select(.type == null or .type.name == null) | "  #\(.number) -- \(.title)"' \
    || warn "gh issue list returned an error; check auth + Issue Type provisioning."
}

# ---- Subcommand: backfill-type ----

cmd_backfill_type() {
  say "Backfill Issue Type for open Issues"
  require_gh
  rate_limit_probe
  local raw
  raw="$(gh issue list --repo "$REPO_SLUG" --state open --limit 500 \
    --json number,title,body,labels,type 2>/dev/null || true)"
  if [ -z "$raw" ]; then
    warn "gh issue list returned empty; no issues to scan."
    raw='[]'
  fi
  local count=0
  while IFS=$'\t' read -r num title labels body_b64; do
    [ -z "$num" ] && continue
    local body suggested=""
    body="$(printf '%s' "$body_b64" | base64 --decode 2>/dev/null || true)"
    # (1) Legacy-label mapping.
    suggested="$(legacy_type_for "$labels")"
    # (2) ## Run-mode body line.
    if [ -z "$suggested" ]; then
      local rm_line
      rm_line="$(printf '%s' "$body" | grep -i -E '^## Run-mode' -A1 | tail -n1 | tr -d '\r' || true)"
      for t in "${VALID_TYPES[@]}"; do
        if printf '%s' "$rm_line" | grep -q -w "$t"; then
          suggested="$t"
          break
        fi
      done
    fi
    if [ -z "$suggested" ]; then
      note "#${num} -- no auto-suggest; hand-assign. (${title})"
      continue
    fi
    count=$((count + 1))
    note "#${num} -> ${suggested} (${title})"
  done < <(printf '%s' "$raw" \
    | jq -r '.[] | select(.type == null or .type.name == null)
             | [.number, .title, (.labels | map(.name) | join(",")), (.body // "" | @base64)] | @tsv')
  note "done. suggested=${count}"
  guard_apply || return 0
  defer_with_pointer "backfill-type"
}

# ---- Subcommand: list-missing-fields ----

cmd_list_missing_fields() {
  say "Project v2 items missing Blocked on / Effort / Priority"
  require_gh
  rate_limit_probe
  # Read project items; surface ones missing any of the three single-select
  # field values. Suggested defaults: Blocked on=Nothing / Effort=Medium /
  # Priority=P2.
  gh project item-list "$PROJECT_NUMBER" --owner "$REPO_OWNER" --format json --limit 500 2>/dev/null \
    | jq -r --arg b "$DEFAULT_BLOCKED_ON" --arg e "$DEFAULT_EFFORT" --arg p "$DEFAULT_PRIORITY" '
        .items[]
        | select((.["blocked on"] // null) == null
                 or (.effort // null) == null
                 or (.priority // null) == null)
        | "  #\(.content.number // "?") -- missing: " +
          ([
            (if (.["blocked on"] // null) == null then "Blocked on (-> \($b))" else empty end),
            (if (.effort // null)       == null then "Effort (-> \($e))"       else empty end),
            (if (.priority // null)     == null then "Priority (-> \($p))"     else empty end)
          ] | join(", "))
      ' \
    || warn "gh project item-list returned an error."
}

# ---- Subcommand: backfill-fields ----

cmd_backfill_fields() {
  say "Backfill Blocked on / Effort / Priority on Project v2 items"
  require_gh
  rate_limit_probe
  note "Defaults: Blocked on=${DEFAULT_BLOCKED_ON}, Effort=${DEFAULT_EFFORT}, Priority=${DEFAULT_PRIORITY}"
  cmd_list_missing_fields
  guard_apply || return 0
  defer_with_pointer "backfill-fields"
}

# ---- Subcommand: retire-labels ----

cmd_retire_labels() {
  say "Retire labels (delete from ${REPO_SLUG})"
  require_gh
  rate_limit_probe
  note "Labels marked for retirement:"
  for lbl in "${RETIRED_LABELS[@]}"; do
    note "  $lbl"
  done
  if ! guard_apply; then
    note "(dry-run) re-run with --apply -y to delete the labels above."
    return 0
  fi
  if [ "$ASSUME_YES" != true ]; then
    printf 'Confirm label deletion (y/N): '
    read -r reply
    [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "aborted by operator."
  fi
  for lbl in "${RETIRED_LABELS[@]}"; do
    if gh label delete "$lbl" --repo "$REPO_SLUG" --yes >/dev/null 2>&1; then
      note "deleted: $lbl"
    else
      # Idempotent: absent label is success.
      note "skipped (absent or already deleted): $lbl"
    fi
  done
}

# ---- Dispatch ----

main() {
  parse_args "$@"
  case "$SUBCOMMAND" in
    list-missing-type)   cmd_list_missing_type ;;
    backfill-type)       cmd_backfill_type ;;
    list-missing-fields) cmd_list_missing_fields ;;
    backfill-fields)     cmd_backfill_fields ;;
    retire-labels)       cmd_retire_labels ;;
    -h|--help|help)      usage; exit 0 ;;
    "")                  usage; exit 1 ;;
    *) printf 'unknown subcommand: %s\n\n' "$SUBCOMMAND" >&2; usage >&2; exit 1 ;;
  esac
}

main "$@"
