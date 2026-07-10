"""Tests for the local-trace-distiller Hermes plugin."""

from plugins.local_trace_distiller import (
    _handle_distill,
    build_distill_prompt,
    distill_ack,
)


class TestBuildDistillPrompt:
    def test_empty_request_defaults_to_this_session(self):
        prompt = build_distill_prompt("")
        low = prompt.lower()

        assert "[/distill]" in prompt
        assert "this session" in low
        assert "current conversation" in low
        assert "distill_trace_search" in prompt
        assert "do not use another trace-mining path" in prompt
        assert "skill_manage" not in prompt

    def test_all_mode_uses_capped_plugin_cluster_before_reading_deeply(self):
        prompt = build_distill_prompt("all")
        low = prompt.lower()

        assert "distill_trace_cluster" in prompt
        assert "distill_local" in prompt
        assert "session_search" not in prompt
        assert "limit=50" in prompt
        assert "cluster" in low
        assert "ask the user" in low
        assert "do not read full transcripts first" in low

    def test_reuses_existing_jinn_distillation_methodology(self):
        prompt = build_distill_prompt("recent build failures")
        low = prompt.lower()

        assert "existing jinn distillation methodology" in low
        assert "user-accepted" in low
        assert "failed or abandoned" in low
        assert "experimental" in low
        assert "provenance" in low

    def test_ack_reflects_the_requested_scope(self):
        assert "this session" in distill_ack("").lower()
        assert "recent local sessions" in distill_ack("all").lower()
        assert "requested traces" in distill_ack("session abc").lower()


class TestDistillRegistryWiring:
    def test_distill_is_not_a_builtin_command(self):
        from hermes_cli.commands import resolve_command

        assert resolve_command("distill") is None

    def test_distill_plugin_command_returns_agent_turn(self):
        result = _handle_distill("all")

        assert result["action"] == "agent_turn"
        assert "distill_trace_cluster" in result["prompt"]
        assert "session_search" not in result["prompt"]
        assert "skill_manage" not in result["prompt"]
        assert "limit=50" in result["prompt"]
        assert "recent local sessions" in result["message"].lower()
