"""Tests for /distill -- local trace skill distillation."""

from agent.distill_prompt import build_distill_prompt, distill_ack


class TestBuildDistillPrompt:
    def test_empty_request_defaults_to_this_session(self):
        prompt = build_distill_prompt("")
        low = prompt.lower()

        assert "[/distill]" in prompt
        assert "this session" in low
        assert "current conversation" in low
        assert "skill_manage" in prompt

    def test_all_mode_uses_capped_session_search_before_reading_deeply(self):
        prompt = build_distill_prompt("all")
        low = prompt.lower()

        assert "session_search" in prompt
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
    def test_distill_is_registered_and_resolves(self):
        from hermes_cli.commands import resolve_command

        cmd = resolve_command("distill")
        assert cmd is not None
        assert cmd.name == "distill"

    def test_distill_is_in_tools_and_skills_category(self):
        from hermes_cli.commands import resolve_command

        assert resolve_command("distill").category == "Tools & Skills"

    def test_distill_works_on_the_gateway(self):
        from hermes_cli.commands import GATEWAY_KNOWN_COMMANDS

        assert "distill" in GATEWAY_KNOWN_COMMANDS

    def test_distill_is_not_cli_only(self):
        from hermes_cli.commands import resolve_command

        assert not resolve_command("distill").cli_only
