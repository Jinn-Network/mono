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
    from plugins.jinn import consent, onboarding
    explainer = consent.render_explainer()
    assert "jinn-agent" not in explainer
    assert "fork of hermes-agent" not in explainer
    replay = onboarding.render_already_complete()  # the returning-operator line
    assert "jinn-agent onboarding" not in replay


def test_copy_keeps_fork_identity_when_env_set(monkeypatch):
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    monkeypatch.setenv("JINN_CLI_NAME", "jinn-agent")
    monkeypatch.setenv("NO_COLOR", "1")
    from plugins.jinn import consent
    assert "jinn-agent" in consent.render_explainer()
