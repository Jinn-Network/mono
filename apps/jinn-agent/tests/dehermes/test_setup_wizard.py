from pathlib import Path

from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

_REPO = Path(__file__).resolve().parents[2]


def test_config_header_is_hermes_free(tmp_path):
    # `hermes config` (no subcommand) renders show_config() non-interactively —
    # drive it for real and assert on the rendered output, not just the source.
    out = run_cli("config", home=str(tmp_path))
    assert_no_upstream_brand(out)
    assert "jinn-agent Configuration" in out


def test_setup_wizard_headers_are_hermes_free_in_source():
    # run_setup_wizard's boxed headers only render on an interactive TTY (the
    # non-interactive path short-circuits to print_noninteractive_setup_guidance
    # before reaching them — verified: `jinn-agent setup` under a piped/CI
    # stdin never prints these boxes). Assert on the source constants instead.
    src = (_REPO / "hermes_cli" / "setup.py").read_text()
    for line in (
        "Hermes Setup",
        "Hermes Agent Setup Wizard",
        "Let's configure your Hermes Agent installation.",
    ):
        assert line not in src, f"leftover wizard branding: {line!r}"


def test_tools_config_header_is_hermes_free_in_source():
    # `hermes tools` refuses to run at all without a real TTY (guarded in
    # hermes_cli/main.py's non-interactive check), so its header can never be
    # captured via subprocess in a test harness — assert on the source.
    src = (_REPO / "hermes_cli" / "tools_config.py").read_text()
    assert "Hermes Tool Configuration" not in src


def test_setup_wizard_interior_copy_is_hermes_free_in_source():
    # Wizard interior copy (mode prompt, terminal-backend line, telegram/
    # bluebubbles/gateway body copy, OpenClaw migration warnings + command
    # hints) only renders on an interactive TTY or during a real OpenClaw
    # migration — assert on the source constants instead.
    src = (_REPO / "hermes_cli" / "setup.py").read_text()
    for line in (
        "How would you like to set up Hermes?",
        "Choose where Hermes runs shell commands and code.",
        "Home Channel: where Hermes delivers cron job results,",
        "Connects Hermes to iMessage via BlueBubbles",
        "Connect to messaging platforms to chat with Hermes from anywhere.",
        "Would overwrite (conflicts with existing Hermes config):",
        "OpenClaw config values may have different semantics in Hermes.",
        "Hermes's yolo mode",
        "Hermes can preview what would be imported before making any changes.",
        "You can run it later with: hermes claw migrate --dry-run",
        "You can run it later with: hermes claw migrate",
        "already exist in Hermes (use hermes claw migrate --overwrite to force)",
    ):
        assert line not in src, f"leftover wizard interior branding: {line!r}"
