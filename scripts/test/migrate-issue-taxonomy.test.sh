#!/usr/bin/env bash
#
# migrate-issue-taxonomy.test.sh — Bash test harness for
# scripts/migrate-issue-taxonomy.sh. Function-shadows `gh` (via PATH
# override with a stub binary in a temp dir) so no real GitHub API calls
# are made; exercises --help, default-dry-run posture, rate-limit-
# exhausted handling, and unknown-subcommand failure.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SCRIPT="${REPO_ROOT}/scripts/migrate-issue-taxonomy.sh"
FAILS=0

say()  { printf '\n=== %s ===\n' "$*"; }
pass() { printf '  PASS - %s\n' "$*"; }
fail() { printf '  FAIL - %s\n' "$*" >&2; FAILS=$((FAILS + 1)); }

assert_contains() {
  local needle="$1" haystack="$2" label="$3"
  if printf '%s' "$haystack" | grep -q -F "$needle"; then
    pass "$label"
  else
    fail "$label (missing: $needle)"
  fi
}

assert_not_contains() {
  local needle="$1" haystack="$2" label="$3"
  if printf '%s' "$haystack" | grep -q -F "$needle"; then
    fail "$label (unexpected: $needle)"
  else
    pass "$label"
  fi
}

if [ ! -f "$SCRIPT" ]; then
  printf 'error: target script does not exist at %s\n' "$SCRIPT" >&2
  printf '       (this is expected during the TDD "red" phase before the script is written.)\n' >&2
  exit 1
fi

# ---- Test 1: --help prints the usage block and exits 0 ----

say "Test 1: --help prints usage and exits 0"
set +e
OUT="$(bash "$SCRIPT" --help 2>&1)"
RC=$?
set -e
if [ "$RC" -eq 0 ]; then pass "exit code is 0"; else fail "exit code is $RC, expected 0"; fi
assert_contains "Usage:" "$OUT" "usage block printed"
assert_contains "list-missing-type" "$OUT" "lists list-missing-type subcommand"
assert_contains "backfill-type" "$OUT" "lists backfill-type subcommand"
assert_contains "retire-labels" "$OUT" "lists retire-labels subcommand"

# ---- Test 2: default is dry-run; retire-labels lists labels without deleting ----

say "Test 2: default is dry-run (no --apply means no gh delete called)"
# Stub gh so any call is logged; if any 'gh label delete' is invoked, the
# test fails. The rate-limit probe stub returns a healthy quota so the
# script proceeds past the probe.
TMPDIR_T2="$(mktemp -d)"
cat > "${TMPDIR_T2}/gh" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "api" ] && [ "${2:-}" = "graphql" ]; then
  # Heuristic: rate-limit probe response.
  printf '{"data":{"rateLimit":{"remaining":5000,"resetAt":"2099-01-01T00:00:00Z"}}}\n'
  exit 0
fi
printf 'gh called with: %s\n' "$*" >&2
if [ "${1:-}" = "label" ] && [ "${2:-}" = "delete" ]; then
  printf 'STUB-GH-DELETED:%s\n' "${3:-}" >&2
fi
exit 0
STUB
chmod +x "${TMPDIR_T2}/gh"
set +e
OUT2="$(PATH="${TMPDIR_T2}:$PATH" bash "$SCRIPT" retire-labels 2>&1)"
RC2=$?
set -e
if [ "$RC2" -eq 0 ]; then pass "exit code is 0"; else fail "exit code is $RC2, expected 0"; fi
assert_contains "sprint:2026-05-18" "$OUT2" "lists sprint:2026-05-18 label"
assert_contains "agent:opus" "$OUT2" "lists agent:opus label"
assert_contains "bug" "$OUT2" "lists bug label"
assert_contains "dry-run" "$OUT2" "indicates dry-run posture"
assert_not_contains "STUB-GH-DELETED" "$OUT2" "no gh label delete invoked"
rm -rf "$TMPDIR_T2"

# ---- Test 3: rate-limit probe handles remaining: 0 ----

say "Test 3: rate-limit probe with remaining: 0 exits 0 with reset message"
TMPDIR_T3="$(mktemp -d)"
cat > "${TMPDIR_T3}/gh" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "api" ] && [ "${2:-}" = "graphql" ]; then
  printf '{"data":{"rateLimit":{"remaining":0,"resetAt":"2099-01-01T00:00:00Z"}}}\n'
  exit 0
fi
# If any other gh call is made after an exhausted probe, that's a regression.
printf 'UNEXPECTED-GH-CALL:%s\n' "$*" >&2
exit 0
STUB
chmod +x "${TMPDIR_T3}/gh"
set +e
OUT3="$(PATH="${TMPDIR_T3}:$PATH" bash "$SCRIPT" list-missing-type 2>&1)"
RC3=$?
set -e
if [ "$RC3" -eq 0 ]; then pass "exit code is 0 on exhausted probe"; else fail "exit code is $RC3, expected 0"; fi
assert_contains "Reset at" "$OUT3" "prints reset time message"
assert_contains "2099-01-01T00:00:00Z" "$OUT3" "echoes resetAt timestamp"
assert_not_contains "UNEXPECTED-GH-CALL:issue" "$OUT3" "did not call gh issue list after exhausted probe"
rm -rf "$TMPDIR_T3"

# ---- Test 4: unknown subcommand prints help and exits non-zero ----

say "Test 4: unknown subcommand exits non-zero with help"
set +e
OUT4="$(bash "$SCRIPT" totally-bogus-subcmd 2>&1)"
RC4=$?
set -e
if [ "$RC4" -ne 0 ]; then pass "exit code is non-zero ($RC4)"; else fail "exit code is 0, expected non-zero"; fi
assert_contains "unknown subcommand" "$OUT4" "prints unknown-subcommand message"
assert_contains "Usage:" "$OUT4" "prints usage block"

# ---- Summary ----

say "Summary"
if [ "$FAILS" -eq 0 ]; then
  printf '  all tests passed.\n'
  exit 0
else
  printf '  %d test(s) failed.\n' "$FAILS" >&2
  exit 1
fi
