"""turn_finalizer forwards tokens + skills loadout to the jinn plugin hooks.

The jinn plugin's EpisodeV1 capture (mono #1662) needs two values that are only
reachable on the agent object, not in-plugin: the session token counters and the
preloaded skills loadout. finalize_turn forwards them additively so the plugin
can populate cost.tokens and environment.skillsLoadout.

These are additive-kwargs-only forwards; every existing hook handler takes
**kwargs, so no other plugin breaks.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent import turn_finalizer


class _Budget:
    remaining = 100
    used = 1
    max_total = 100


def _fake_agent():
    return SimpleNamespace(
        session_id="sess-A",
        model="test-model",
        provider="test-provider",
        base_url="http://localhost",
        platform="cli",
        max_iterations=100,
        iteration_budget=_Budget(),
        context_compressor=SimpleNamespace(last_prompt_tokens=0),
        # Token counters the jinn forward reads.
        session_input_tokens=100,
        session_output_tokens=50,
        loaded_skill_names=["tdd", "debugging"],
        # Remaining session counters the result dict serializes.
        session_cache_read_tokens=0,
        session_cache_write_tokens=0,
        session_reasoning_tokens=0,
        session_prompt_tokens=0,
        session_completion_tokens=0,
        session_total_tokens=0,
        session_estimated_cost_usd=0.0,
        session_cost_status="ok",
        session_cost_source="test",
        _response_was_previewed=False,
        _tool_guardrail_halt_decision=None,
        _interrupt_message=None,
        _stream_callback=None,
        _skill_nudge_interval=0,
        _iters_since_skill=0,
        valid_tool_names=set(),
        _turn_failed_file_mutations={},
        _save_trajectory=lambda *a, **k: None,
        _cleanup_task_resources=lambda *a, **k: None,
        _drop_trailing_empty_response_scaffolding=lambda *a, **k: None,
        _persist_session=lambda *a, **k: None,
        _file_mutation_verifier_enabled=lambda: False,
        _turn_completion_explainer_enabled=lambda: False,
        _drain_pending_steer=lambda: None,
        clear_interrupt=lambda: None,
        _sync_external_memory_for_turn=lambda **k: None,
        _spawn_background_review=lambda **k: None,
    )


def _run(monkeypatch):
    calls: list[tuple[str, dict]] = []

    def invoke_hook(name, **kwargs):
        calls.append((name, kwargs))
        return []

    monkeypatch.setattr("hermes_cli.plugins.invoke_hook", invoke_hook)

    turn_finalizer.finalize_turn(
        _fake_agent(),
        final_response="done",
        api_call_count=1,
        interrupted=False,
        failed=False,
        messages=[{"role": "user", "content": "do X"}],
        conversation_history=[],
        effective_task_id="task-1",
        turn_id="turn-1",
        user_message="do X",
        original_user_message="do X",
        _should_review_memory=False,
        _turn_exit_reason="text_response(done)",
    )
    return calls


def test_post_llm_call_forwards_token_counters(monkeypatch):
    calls = _run(monkeypatch)
    post = dict(calls)["post_llm_call"]
    assert post["input_tokens"] == 100
    assert post["output_tokens"] == 50
    assert post["turn_id"] == "turn-1"


def test_on_session_end_forwards_tokens_and_skills_loadout(monkeypatch):
    calls = _run(monkeypatch)
    end = dict(calls)["on_session_end"]
    assert end["input_tokens"] == 100
    assert end["output_tokens"] == 50
    assert end["skills_loadout"] == ["tdd", "debugging"]
    assert end["turn_id"] == "turn-1"


def test_skills_loadout_defaults_to_empty_when_agent_lacks_it(monkeypatch):
    # A stock agent that never stored a preloaded skills loadout must not break
    # the hook: the forward reads via getattr and defaults to [].
    calls: list[tuple[str, dict]] = []

    def invoke_hook(name, **kwargs):
        calls.append((name, kwargs))
        return []

    monkeypatch.setattr("hermes_cli.plugins.invoke_hook", invoke_hook)

    agent = _fake_agent()
    del agent.loaded_skill_names

    turn_finalizer.finalize_turn(
        agent,
        final_response="done",
        api_call_count=1,
        interrupted=False,
        failed=False,
        messages=[{"role": "user", "content": "do X"}],
        conversation_history=[],
        effective_task_id="task-1",
        turn_id="turn-1",
        user_message="do X",
        original_user_message="do X",
        _should_review_memory=False,
        _turn_exit_reason="text_response(done)",
    )

    end = dict(calls)["on_session_end"]
    assert end["skills_loadout"] == []
