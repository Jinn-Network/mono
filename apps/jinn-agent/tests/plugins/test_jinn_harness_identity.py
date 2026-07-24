import sys
from plugins.jinn import harness


def test_defaults_to_host_when_env_unset(monkeypatch):
    for k in ("JINN_HARNESS_NAME", "JINN_HARNESS_VERSION", "JINN_CLI_NAME"):
        monkeypatch.delenv(k, raising=False)
    assert harness.harness_name() == "hermes-agent"
    assert harness.is_fork() is False
    assert harness.harness_version()  # non-empty (host __version__ or "unknown")


def test_fork_env_overrides(monkeypatch):
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    monkeypatch.setenv("JINN_HARNESS_VERSION", "0.1.0")
    monkeypatch.setenv("JINN_CLI_NAME", "jinn-agent")
    assert harness.harness() == ("jinn-agent", "0.1.0")
    assert harness.is_fork() is True
    assert harness.cli_name() == "jinn-agent"


def test_cli_name_falls_back_to_argv0(monkeypatch):
    monkeypatch.delenv("JINN_CLI_NAME", raising=False)
    monkeypatch.setattr(sys, "argv", ["/usr/local/bin/hermes", "chat"])
    assert harness.cli_name() == "hermes"


def test_copy_never_claims_jinn_agent_on_stock(monkeypatch):
    for k in ("JINN_HARNESS_NAME", "JINN_CLI_NAME"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("NO_COLOR", "1")
    from plugins.jinn import consent
    explainer = consent.render_explainer()
    assert "jinn-agent" not in explainer
    assert "fork of hermes-agent" not in explainer


def test_copy_keeps_fork_identity_when_env_set(monkeypatch):
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    monkeypatch.setenv("JINN_CLI_NAME", "jinn-agent")
    monkeypatch.setenv("NO_COLOR", "1")
    from plugins.jinn import consent
    assert "jinn-agent" in consent.render_explainer()


def test_stock_plugin_remedies_use_the_host_cli_and_never_fork_only_commands(monkeypatch):
    monkeypatch.delenv("JINN_HARNESS_NAME", raising=False)
    monkeypatch.setenv("JINN_CLI_NAME", "hermes")

    from plugins.jinn import distill, doctor, jinn_layer

    assert doctor._update_remedy() == "hermes plugins update jinn"
    assert doctor._check_host_provider()["detail"].endswith("run: hermes doctor")
    assert "hermes plugins update jinn" in distill._update_layer_line()

    code, out, err = jinn_layer._default_runner(["definitely-not-a-real-binary-xyz"])
    assert (code, out) == (127, "")
    assert "hermes plugins update jinn" in err

    for text in (
        doctor._update_remedy(),
        doctor._check_host_provider()["detail"],
        distill._update_layer_line(),
        err,
    ):
        assert "jinn-agent" not in text


def test_fork_plugin_remedies_keep_the_fork_cli_name(monkeypatch):
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    monkeypatch.setenv("JINN_CLI_NAME", "jinn-agent")

    from plugins.jinn import distill, doctor, jinn_layer

    assert doctor._update_remedy() == "jinn-agent plugins update jinn"
    assert doctor._check_host_provider()["detail"].endswith("run: jinn-agent doctor")
    assert "jinn-agent plugins update jinn" in distill._update_layer_line()
    assert "jinn-agent plugins update jinn" in jinn_layer._default_runner(
        ["definitely-not-a-real-binary-xyz"],
    )[2]
