"""Versioned subprocess transport for the additive session bridge (#1661)."""

from __future__ import annotations

import json

from plugins.jinn import jinn_layer


class StdinRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], str | None]] = []

    def __call__(self, argv: list[str], *, input: str | None = None) -> tuple[int, str]:
        self.calls.append((argv, input))
        return 0, '{"contractVersion":1,"status":"ok","value":{}}'


def test_contract_uses_the_versioned_json_verb():
    runner = StdinRunner()

    assert jinn_layer.contract(runner=runner)[0] == 0
    assert runner.calls == [([jinn_layer.binary(), "contract", "--json"], None)]


def test_session_end_writes_one_complete_request_to_stdin():
    runner = StdinRunner()
    request = {
        "contractVersion": 1,
        "episode": {"schemaVersion": "jinn.episode.v1", "episodeId": "episode-1"},
        "activity": {"searchedTerms": [], "providedRefs": [], "surfacedRefs": [], "fetchedRefs": []},
        "eligibilityInputs": {"acceptedDiff": True},
    }

    code, _ = jinn_layer.session_end(request, runner=runner)

    assert code == 0
    assert runner.calls == [
        ([jinn_layer.binary(), "session", "end"], json.dumps(request, separators=(",", ":")))
    ]


def test_session_pickup_writes_one_complete_request_to_stdin():
    runner = StdinRunner()
    request = {
        "contractVersion": 1,
        "meta": {
            "sessionId": "s1",
            "taskSummary": "fix the flaky test",
            "harness": {"name": "jinn-agent", "version": "0.1.0"},
            "model": "claude-test",
            "tools": [],
        },
        "firstMessage": "fix the flaky test",
    }

    code, _ = jinn_layer.session_pickup(request, runner=runner)

    assert code == 0
    assert runner.calls == [
        ([jinn_layer.binary(), "session", "pickup"], json.dumps(request, separators=(",", ":")))
    ]


def test_session_pickup_uses_a_tighter_timeout_than_the_general_default(monkeypatch):
    # The real subprocess runner (no injected runner) must apply the tighter
    # 15s pickup budget (rescope plan §3.5), not the general 120s default —
    # pickup runs before the LLM call and must fail open in seconds.
    calls = []

    def fake_default_runner(argv, cwd=None, input=None, timeout_s=jinn_layer._TIMEOUT_S):
        calls.append(timeout_s)
        return 0, '{"contractVersion":1,"status":"ok","value":{}}'

    monkeypatch.setattr(jinn_layer, "_default_runner", fake_default_runner)
    jinn_layer.session_pickup({"contractVersion": 1})

    assert calls == [jinn_layer._SESSION_PICKUP_TIMEOUT_S]
    assert jinn_layer._SESSION_PICKUP_TIMEOUT_S < jinn_layer._TIMEOUT_S


def test_parse_session_pickup_response_accepts_the_exact_v1_envelope():
    response = jinn_layer.parse_session_pickup_response(
        json.dumps({
            "contractVersion": 1,
            "status": "ok",
            "value": {
                "contextBlock": "[jinn corpus] Prior evidence relevant to this task:\n…",
                "packets": [{"ref": "bafyRef1"}],
                "searchedTerms": ["dashboard", "vitest"],
            },
        })
    )
    assert response["status"] == "ok"
    assert response["value"]["packets"][0]["ref"] == "bafyRef1"


def test_parse_session_pickup_response_rejects_malformed_or_wrong_version():
    for raw in (
        "not json",
        "[]",
        '{"contractVersion":2,"status":"ok","value":{}}',
        '{"contractVersion":1,"status":"mystery"}',
    ):
        try:
            jinn_layer.parse_session_pickup_response(raw)
        except ValueError:
            pass
        else:  # pragma: no cover - makes each bad fixture independently legible
            raise AssertionError(f"accepted invalid session-pickup response: {raw}")


def test_history_contribution_preview_ledger_and_disable_use_versioned_json_commands():
    runner = StdinRunner()

    assert jinn_layer.history_json(runner=runner)[0] == 0
    assert jinn_layer.contribution_preview(acknowledge=True, runner=runner)[0] == 0
    assert jinn_layer.contribution_ledger_json(runner=runner)[0] == 0
    assert jinn_layer.contribution_disable(runner=runner)[0] == 0

    assert runner.calls == [
        ([jinn_layer.binary(), "history", "--json"], None),
        ([jinn_layer.binary(), "contribution", "preview", "--ack", "--json"], None),
        ([jinn_layer.binary(), "contribution", "ledger", "--json"], None),
        ([jinn_layer.binary(), "contribution", "disable", "--json"], None),
    ]


def test_parse_session_end_response_accepts_the_exact_v1_envelope():
    response = jinn_layer.parse_session_end_response(
        json.dumps(
            {
                "contractVersion": 1,
                "status": "degraded",
                "reason": "contribution unavailable",
                "value": {
                    "episodeRef": "episode-1",
                    "persistence": {
                        "status": "degraded",
                        "reason": "secondary index unavailable",
                        "value": {"episodeId": "episode-1"},
                    },
                    "eligibility": {"eligible": True, "reason": "accepted diff", "checkedAt": "2026-07-15T00:00:00Z"},
                    "summary": {
                        "episodeRef": "episode-1",
                        "searchedTerms": [],
                        "providedPackets": [],
                        "eligibility": {"eligible": True, "reason": "accepted diff", "checkedAt": "2026-07-15T00:00:00Z"},
                        "nothingFound": True,
                    },
                },
            }
        )
    )

    assert response["status"] == "degraded"
    assert response["value"]["persistence"]["value"]["episodeId"] == "episode-1"


def test_parse_session_end_response_rejects_malformed_or_wrong_version():
    for raw in (
        "not json",
        '[]',
        '{"contractVersion":2,"status":"ok","value":{}}',
        '{"contractVersion":1,"status":"mystery"}',
    ):
        try:
            jinn_layer.parse_session_end_response(raw)
        except ValueError:
            pass
        else:  # pragma: no cover - makes each bad fixture independently legible
            raise AssertionError(f"accepted invalid session-end response: {raw}")
