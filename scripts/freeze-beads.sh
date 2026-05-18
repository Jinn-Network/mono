#!/usr/bin/env bash
#
# freeze-beads.sh — One-time freeze of the bd issue corpus per DR-2026-05-18.
#
# Implements waxs.5 from the bd-retirement plan (umbrella #261, DR file at
# log/decisions/2026-05-18-bd-vs-gh-substrate.md). Run AFTER waxs.4
# (close-or-port sweep) has executed so the freeze snapshot captures the
# post-sweep state.
#
# What this does:
#   1. Sanity-check: bd CLI is on PATH and the Dolt database is reachable.
#   2. `bd dolt commit` — flush any pending writes.
#   3. `bd export` — write a JSONL snapshot to `.beads-archive-2026-05-18.jsonl`
#      at the repo root for redundancy. The Dolt database is the
#      authoritative archive; the JSONL is a portable secondary copy.
#   4. `bd dolt push` — sync to the configured Dolt remote.
#   5. Print the Dolt-remote tag command Captain must run manually (this
#      script does not run the tag command itself because Dolt-remote
#      tagging mechanics are deployment-specific and we don't want a
#      half-completed automation).
#   6. Print the post-freeze checklist (operator-local cleanup, repo notes).
#
# What this does NOT do (Captain runs these manually after this script):
#   - Tag the Dolt remote head as `bd-archive-2026-05-18`.
#   - Remove the `bd prime` SessionStart / PreCompact hooks from each
#     operator's `.claude/settings.json` (those are gitignored / operator-local).
#   - Open a follow-up PR if a label-only "sprint candidate" workflow is wanted.
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
bd status >/dev/null 2>&1 || {
  echo "error: bd CLI reachable but database is not — check .beads/ exists at ${REPO_ROOT}/.beads." >&2
  exit 1
}
echo "bd CLI ok; .beads/ database reachable."

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
bd dolt push 2>&1 || {
  echo "warning: bd dolt push failed — Captain may need to push manually before tagging the remote." >&2
}

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
