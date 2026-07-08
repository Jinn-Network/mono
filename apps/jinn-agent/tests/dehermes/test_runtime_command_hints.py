"""Runtime output must hint `jinn-agent <subcmd>`, never `hermes <subcmd>`.

Follow-up to the main-path sweep (spec §5.2): the final review found ~65
`hermes <cmd>` command-hint literals surviving in RUNTIME output (not
--help) across main.py's whatsapp next-steps, gateway.py, cron.py,
backup.py, config.py and gateway_windows.py. `hermes` on the user's PATH
resolves to a stock upstream install, so each hint directed the user at
the wrong binary.

Static coverage: scan the swept files' ASTs for `hermes <subcmd>` string
literals outside docstrings/help-kwargs/matcher allowlists (see
scan_runtime_hint_violations in brandcheck.py) — this also guards surfaces
that cannot be probed non-destructively (whatsapp post-pairing block,
Windows gateway prompts, update/uninstall flows; uninstall self-deletes
the checkout, so it is never executed here).

Behavioural coverage: probe the swept surfaces that ARE safe to run
against a throwaway HERMES_HOME — read-only status commands and bad-usage
error paths.
"""
import pytest

from tests.dehermes.brandcheck import (
    COMMAND_HINT,
    assert_no_upstream_brand,
    run_cli,
    scan_runtime_hint_violations,
)

SWEPT_FILES = [
    "hermes_cli/main.py",
    "hermes_cli/gateway.py",
    "hermes_cli/cron.py",
    "hermes_cli/backup.py",
    "hermes_cli/config.py",
    "hermes_cli/gateway_windows.py",
]


@pytest.mark.parametrize("rel_path", SWEPT_FILES)
def test_no_hermes_command_hints_in_runtime_strings(rel_path):
    violations = scan_runtime_hint_violations(rel_path)
    assert not violations, (
        f"{rel_path} has `hermes <subcmd>` command hints in runtime string "
        "literals (user's `hermes` is a different binary — hint must say "
        "`jinn-agent`):\n"
        + "\n".join(f"  line {ln}: {lit!r}" for ln, lit in violations)
    )


# Swept runtime surfaces that are non-destructive to invoke: read-only
# status commands and bad-usage error paths. Each prints next-step command
# hints that the sweep rewrote.
RUNTIME_HINT_INVOCATIONS = [
    "cron status",      # cron.py gateway-not-running guidance
    "gateway status",   # gateway.py "To start:" block
    "config set",       # config.py bad-usage Usage/Examples block
    "whatsapp",         # main.py _require_tty error (non-tty here)
]


@pytest.mark.parametrize("argline", RUNTIME_HINT_INVOCATIONS)
def test_swept_runtime_surface_is_hermes_free(argline, tmp_path):
    assert_no_upstream_brand(run_cli(*argline.split(), home=str(tmp_path)))


def test_fallback_update_command_is_jinn_agent():
    # The git-checkout fallback is the path jinn-agent installs actually
    # take (setup.sh clone + symlink); it must not recommend `hermes`.
    from hermes_cli.config import recommended_update_command_for_method

    assert recommended_update_command_for_method("git") == "jinn-agent update"


def test_user_systemd_error_hints_jinn_agent():
    # User-facing raised-error surface in gateway.py — safe to build
    # without touching any gateway state.
    from hermes_cli.gateway import (
        UserSystemdUnavailableError,
        _raise_user_systemd_unavailable,
    )

    with pytest.raises(UserSystemdUnavailableError) as exc_info:
        _raise_user_systemd_unavailable(
            "testuser", reason="test reason", fix_hint="    do the fix"
        )
    msg = str(exc_info.value)
    assert "jinn-agent gateway run" in msg
    assert not COMMAND_HINT.search(msg)
