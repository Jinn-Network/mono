from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli


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
