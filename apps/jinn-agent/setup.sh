#!/bin/sh
# jinn-agent setup — one-time install (deps, sandboxing, agent core).
# Thin wrapper over the upstream core's installer, made fork-aware
# (mono#1360):
#   - state and bundled skills land in the jinn-agent home, not the
#     upstream one;
#   - a stock upstream install's `hermes` command link is preserved
#     (the installer would otherwise repoint it at this repo's venv);
#   - the command this fork puts on PATH is `jinn-agent`.
set -e
cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

# Same home resolution as bin/jinn-agent: the installer (skills sync,
# state seeding) must target the home the runtime will actually read.
if [ -z "$HERMES_HOME" ]; then
  export HERMES_HOME="${JINN_AGENT_HOME:-$HOME/.jinn-agent}"
fi

# The installer runs `ln -sf <repo>/venv/bin/hermes ~/.local/bin/hermes`,
# clobbering any stock install's command link. Park the existing entry
# (symlink or file) and put it back afterwards — also on failure.
LINK_DIR="$HOME/.local/bin"
PARKED=""
if [ -e "$LINK_DIR/hermes" ] || [ -L "$LINK_DIR/hermes" ]; then
  PARKED="$LINK_DIR/.hermes.jinn-setup-parked"
  mv "$LINK_DIR/hermes" "$PARKED"
fi
restore_hermes_link() {
  rm -f "$LINK_DIR/hermes"
  if [ -n "$PARKED" ] && { [ -e "$PARKED" ] || [ -L "$PARKED" ]; }; then
    mv "$PARKED" "$LINK_DIR/hermes"
  fi
}
trap restore_hermes_link EXIT

# Pre-installer header (mono#1387): the upstream installer's output brands
# itself 'Hermes' and names upstream commands/paths. Frame it before it
# scrolls past so the user knows what applies to this fork.
echo "============================================================"
echo " jinn-agent setup"
echo ""
echo " The upstream agent-core installer runs next. Its output"
echo " brands itself 'Hermes' and may name commands (hermes,"
echo " hermes setup, ...) and paths (~/.hermes) that this fork"
echo " remaps to jinn-agent and ~/.jinn-agent."
echo ""
echo " Only the jinn-agent next steps at the very end apply."
echo "============================================================"
echo ""

# The installer's LAST step is an interactive "run the wizard now?" read,
# which fails (exit 1) without a TTY — after the install itself is done.
# Judge success by the artifact the install exists to produce, not by
# that exit code.
INSTALL_STATUS=0
./setup-hermes.sh "$@" || INSTALL_STATUS=$?
if [ ! -x "$REPO_DIR/venv/bin/hermes" ]; then
  echo "jinn-agent setup failed (installer exit $INSTALL_STATUS)" >&2
  exit $(( INSTALL_STATUS ? INSTALL_STATUS : 1 ))
fi

# Ensure the tirith security scanner is present at install time so the
# first session does not start degraded (mono#1359). Non-fatal: offline
# installs degrade with a clear message; the runtime retries later.
# Deliberately calls upstream's PRIVATE _install_tirith — the public
# ensure_installed() is fire-and-forget (background thread), useless for
# a setup step that must block until the download completes. If upstream
# renames the helper, the heredoc exits non-zero and falls into the same
# degrade warning below; setup itself still succeeds.
if ! "$REPO_DIR/venv/bin/python" - <<'PY'
import os, shutil, sys
from tools import tirith_security as ts
if not ts.is_platform_supported():
    print("tirith: no prebuilt binary for this platform; command scanning uses pattern matching.")
    sys.exit(0)
local = os.path.join(ts._hermes_bin_dir(), "tirith")
found = shutil.which("tirith") or (local if os.path.isfile(local) and os.access(local, os.X_OK) else None)
if found:
    print(f"tirith present: {found}")
    sys.exit(0)
installed, reason = ts._install_tirith()
if installed:
    print(f"tirith installed: {installed}")
    sys.exit(0)
print(f"tirith install failed ({reason})", file=sys.stderr)
sys.exit(1)
PY
then
  echo "warning: tirith security scanner not installed — sessions will fall back to pattern-matching command scanning and retry the download automatically." >&2
fi

mkdir -p "$LINK_DIR"
ln -sf "$REPO_DIR/bin/jinn-agent" "$LINK_DIR/jinn-agent"

# Post-installer rc repairs (mono#1387).
#
# 1. The installer appends a PATH block commented '# Hermes Agent — …' to
#    the user's shell rc file. Rebrand JUST that comment line — the block
#    was written on this fork's behalf. Rewrite via temp file + cat-back so
#    symlinked rc files (dotfiles repos) keep their inode; idempotent (the
#    pattern is gone after the first rewrite).
UPSTREAM_RC_COMMENT='# Hermes Agent — ensure ~/.local/bin is on PATH'
JINN_RC_COMMENT='# jinn-agent — ensure ~/.local/bin is on PATH'
for RC in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$RC" ] && grep -Fq "$UPSTREAM_RC_COMMENT" "$RC"; then
    RC_TMP="$RC.jinn-setup.tmp.$$"
    sed "s|^$UPSTREAM_RC_COMMENT\$|$JINN_RC_COMMENT|" "$RC" > "$RC_TMP" \
      && cat "$RC_TMP" > "$RC"
    rm -f "$RC_TMP"
  fi
done

# 2. Fresh-machine PATH hole: the installer only appends the PATH line to an
#    EXISTING rc file, so a machine with none silently gets no PATH entry.
#    If no rc file puts ~/.local/bin on PATH, create/append the one matching
#    the user's shell. RC_FILE also feeds the next-steps message below, so
#    it names the rc file actually involved.
RC_FILE=""
for RC in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$RC" ] && grep -q '\.local/bin' "$RC" 2>/dev/null; then
    RC_FILE="$RC"
    break
  fi
done
if [ -z "$RC_FILE" ]; then
  case "${SHELL:-}" in
    *zsh*)  RC_FILE="$HOME/.zshrc" ;;
    *bash*) RC_FILE="$HOME/.bashrc" ;;
    *)      RC_FILE="$HOME/.profile" ;;
  esac
  {
    echo ""
    echo "$JINN_RC_COMMENT"
    echo 'export PATH="$HOME/.local/bin:$PATH"'
  } >> "$RC_FILE"
fi
RC_DISPLAY=$(printf '%s' "$RC_FILE" | sed "s|^$HOME|~|")

printf '\n%s\n' "jinn-agent is installed."
echo ""
echo "Next steps (ignore any instructions above that name another command):"
echo ""
echo "  1. Reload your shell so ~/.local/bin is on PATH:"
echo "     source $RC_DISPLAY"
echo ""
echo "  2. Configure a model provider:"
echo "     jinn-agent setup"
echo ""
echo "  3. Start:"
echo "     jinn-agent"
