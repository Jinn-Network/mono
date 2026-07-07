import pytest

from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli


@pytest.mark.xfail(
    strict=False,
    reason=(
        "Top-level --help aggregates one-line help= strings from subcommand "
        "modules (subcommands/backup.py, portal_cli.py, subcommands/uninstall.py, "
        "subcommands/profile.py, subcommands/dashboard.py, ...) that still say "
        "Hermes/Nous. Those are de-hermes tasks 6-9; this test is the sweep's "
        "acceptance test and flips to pass when they land. Task 5 cleaned "
        "everything _parser.py owns: prog, description, epilog, flag help."
    ),
)
def test_top_level_help_is_hermes_free(tmp_path):
    out = run_cli("--help", home=str(tmp_path))
    assert_no_upstream_brand(out)
    assert "jinn-agent" in out.lower()


def test_help_examples_use_the_real_command(tmp_path):
    out = run_cli("--help", home=str(tmp_path))
    assert "\n    hermes " not in out            # no example tells the user to run `hermes`


def test_usage_line_and_description_say_jinn_agent(tmp_path):
    """The Task 5 surface itself — prog, description, epilog — must be clean now."""
    out = run_cli("--help", home=str(tmp_path))
    assert "usage: jinn-agent" in out
    assert "jinn-agent - AI assistant" in out
    assert "jinn-agent <command> --help" in out
    # Epilogue examples block must be fully de-branded, including the
    # illustrative toolset name (was `hermes -s hermes-agent-dev,...`).
    assert "hermes-agent-dev" not in out
