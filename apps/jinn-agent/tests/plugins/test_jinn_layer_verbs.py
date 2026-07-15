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
        "activity": {"surfacedRefs": [], "fetchedRefs": [], "installedSkillRefs": []},
        "eligibilityInputs": {"acceptedDiff": True},
    }

    code, _ = jinn_layer.session_end(request, runner=runner)

    assert code == 0
    assert runner.calls == [
        ([jinn_layer.binary(), "session", "end"], json.dumps(request, separators=(",", ":")))
    ]


def test_contribution_preview_and_disable_use_versioned_json_commands():
    runner = StdinRunner()

    assert jinn_layer.contribution_preview(acknowledge=True, runner=runner)[0] == 0
    assert jinn_layer.contribution_disable(runner=runner)[0] == 0

    assert runner.calls == [
        ([jinn_layer.binary(), "contribution", "preview", "--ack", "--json"], None),
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
                        "surfacedHits": [],
                        "fetchedHits": [],
                        "installedSkillRefs": [],
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
