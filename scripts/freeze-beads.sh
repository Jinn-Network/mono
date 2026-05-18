#!/usr/bin/env bash
#
# freeze-beads.sh — One-time freeze of the bd issue corpus per DR-2026-05-18.
#
# Implements waxs.5 from the bd-retirement plan (umbrella #261, DR file at
# log/decisions/2026-05-18-bd-vs-gh-substrate.md). Run AFTER waxs.4
# (close-or-port sweep) has executed so the freeze snapshot captures the
# post-sweep state.
#
# What this does NOT do (Captain runs these manually after this script):
#   - Tag the Dolt remote head as `bd-archive-2026-05-18`. Tagging mechanics
#     depend on the Dolt-remote deployment; we don't want a half-completed
#     automation.
#   - Remove the `bd prime` SessionStart / PreCompact hooks from each
#     operator's `.claude/settings.json` (those are gitignored / operator-local).
#   - Open a follow-up Issue if a label-only "sprint candidate" workflow is wanted.
#
# Idempotent: re-running is safe. The export overwrites; the Dolt push is a
# no-op if nothing changed; bd dolt commit is a no-op if nothing is pending.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
ARCHIVE_DATE="2026-05-18"
JSONL_PATH="${REPO_ROOT}/.beads-archive-${ARCHIVE_DATE}.jsonl"

say() { printf '\n=== %s ===\n' "$*"; }

say "Sanity check"
if ! command -v bd >/dev/null 2>&1; then
  echo "error: bd CLI not on PATH. Install bd or run this from a shell with bd installed." >&2
  exit 1
fi

say "Commit pending bd writes (no-op if clean)"
bd dolt commit --message "Freeze for bd-archive-${ARCHIVE_DATE} per DR-2026-05-18" 2>&1 || {
  echo "(bd dolt commit had nothing to commit, or the commit failed cleanly — continuing.)"
}

say "Export bd state to JSONL snapshot"
bd export --output "${JSONL_PATH}" 2>&1 || {
  echo "warning: bd export failed; the Dolt database remains authoritative — continuing." >&2
}
if [ -f "${JSONL_PATH}" ]; then
  echo "JSONL snapshot: ${JSONL_PATH}"
  echo "  size: $(wc -c < "${JSONL_PATH}" | tr -d ' ') bytes"
  echo "  records: $(wc -l < "${JSONL_PATH}" | tr -d ' ')"
fi

say "Push to Dolt remote"
# Hard-stop on push failure. A silent push failure means the remote is stale, and the manual
# Dolt-remote tag step in the next section would tag the wrong (pre-freeze) head — corrupting
# the archive intent. Surface the failure now so Captain can fix auth / connectivity before
# attempting the tag.
if ! bd dolt push 2>&1; then
  echo "error: bd dolt push failed — fix the underlying issue (Dolt auth, network, remote state) and re-run the script before attempting the manual tag step. Do NOT proceed to tag the remote until this push succeeds." >&2
  exit 1
fi

say "Manual follow-up (Captain runs these)"
cat <<EOF
The Dolt-remote tagging step is **not automated** because tagging
mechanics depend on the deployment of the Dolt remote (ritsuJinn proxy,
direct Dolt server, etc.). Captain runs ONE of:

  # If the remote is a Dolt server reachable via the dolt CLI:
  cd ${REPO_ROOT}/.beads && dolt tag bd-archive-${ARCHIVE_DATE} -m "Frozen per DR-2026-05-18 / waxs.5"
  cd ${REPO_ROOT}/.beads && dolt push origin bd-archive-${ARCHIVE_DATE}

  # If the remote is a Dolt-via-git proxy (per bd config sync.remote):
  # see the ritsuJinn proxy docs for the equivalent tag-and-push.

After tagging, the archive is read-only by convention. The bd CLI on
operator machines continues to read for historical \`jinn-mono-<id>\`
lookups; new writes are not synced to the remote.

Operator-local cleanup (per-operator, gitignored):
  Edit ~/.claude/settings.json — remove any SessionStart or PreCompact
  hook that invokes \`bd prime\`. Per DR-2026-05-18 the hook is no longer
  recommended; CLAUDE.md auto-load covers session start.

Repo-level acceptance for waxs.5:
  - [ ] Dolt remote head tagged \`bd-archive-${ARCHIVE_DATE}\`.
  - [ ] \`bd show jinn-mono-waxs\` resolves locally (smoke-test the archive read path).
  - [ ] A follow-up commit on this branch (or a sibling) records the final tag SHA + closes #267.
EOF
