#!/usr/bin/env bash
# Resolve the standalone Autopilot CLI. Fail closed.
# Never fall back to <repo>/packages/autopilot.
#
# Inputs:
#   JINN_AUTOPILOT_BIN         — path to a ready autopilot executable
#   JINN_AUTOPILOT_PACKAGE_DIR — standalone Autopilot checkout (not packages/autopilot)
#
# When sourced, defines `autopilot` as a function.

_jinn_refuse_vendored_autopilot_dir() {
  local dir="${1%/}"
  case "$dir" in
    */packages/autopilot|packages/autopilot)
      echo "error: JINN_AUTOPILOT_PACKAGE_DIR must not point at the retired vendored tree ($dir)" >&2
      return 1
      ;;
  esac
  return 0
}

_jinn_fail_autopilot_resolution() {
  echo "error: set JINN_AUTOPILOT_BIN or JINN_AUTOPILOT_PACKAGE_DIR to the standalone Autopilot checkout. The vendored packages/autopilot tree is not a fallback." >&2
  return 1
}

if [ -n "${JINN_AUTOPILOT_BIN:-}" ]; then
  if [ ! -e "$JINN_AUTOPILOT_BIN" ]; then
    echo "error: JINN_AUTOPILOT_BIN is set but not found: $JINN_AUTOPILOT_BIN" >&2
    return 1 2>/dev/null || exit 1
  fi
  autopilot() { "$JINN_AUTOPILOT_BIN" "$@"; }
elif [ -n "${JINN_AUTOPILOT_PACKAGE_DIR:-}" ]; then
  _jinn_refuse_vendored_autopilot_dir "$JINN_AUTOPILOT_PACKAGE_DIR" \
    || return 1 2>/dev/null || exit 1
  autopilot() { yarn --cwd "$JINN_AUTOPILOT_PACKAGE_DIR" autopilot "$@"; }
else
  _jinn_fail_autopilot_resolution || return 1 2>/dev/null || exit 1
fi
