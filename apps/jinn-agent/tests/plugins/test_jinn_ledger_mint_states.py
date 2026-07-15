"""Ledger contribution-state projection foundation (Jinn-Network/mono#1664, AC1).

The contribution enum is ``queued | minted | published | vetoed``. The render
layer is the only place a human-facing LABEL is chosen: ``queued`` renders as
``recorded`` (it has not left the machine yet), ``minted`` as ``minted``, and
the raw enum spelling ``queued`` never leaks to the terminal. ``published``
rows keep the existing tier chip; ``vetoed`` keeps ``vetoed (local only)``.
"""

from __future__ import annotations

import re

import pytest

from plugins.jinn import ledger_view

_ANSI = re.compile(r"\033\[[0-9;]*m")


def _plain(text: str) -> str:
    return _ANSI.sub("", text)


@pytest.fixture(autouse=True)
def _truecolor(monkeypatch):
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setenv("COLORTERM", "truecolor")
    monkeypatch.setenv("COLUMNS", "120")


def _mixed_rows():
    return [
        {"time": "05-26 06:41", "task": "fix flaky retry", "env": "env-8f21c2",
         "anchor": "0x7a2f…c019", "tier": "tests-passed"},   # published (tier chip)
        {"time": "05-26 06:40", "task": "add pagination", "state": "minted"},
        {"time": "05-26 06:39", "task": "tidy imports", "state": "queued"},
        {"time": "05-26 06:38", "task": "refactor auth", "state": "vetoed"},
    ]


def test_queued_renders_as_recorded_chip_not_raw_enum():
    plain = _plain(ledger_view.render_ledger([
        {"time": "05-26 06:39", "task": "tidy imports", "state": "queued"},
    ]))
    assert ledger_view.RECORDED_LABEL == "recorded"
    assert "recorded" in plain
    # The raw enum spelling never reaches the terminal.
    assert "queued" not in plain


def test_minted_renders_as_minted_chip():
    plain = _plain(ledger_view.render_ledger([
        {"time": "05-26 06:40", "task": "add pagination", "state": "minted"},
    ]))
    assert ledger_view.MINTED_LABEL == "minted"
    assert "minted" in plain


def test_recorded_and_minted_projection_hides_env_and_anchor_values():
    # The renderer foundation treats recorded/minted rows as local: envelope
    # and anchor are placeholders, never adapter-supplied values.
    for state in ("queued", "minted"):
        env_sentinel = f"ENV-SENTINEL-{state}"
        anchor_sentinel = f"ANCHOR-SENTINEL-{state}"
        plain = _plain(ledger_view.render_ledger([
            {
                "time": "05-26 06:40",
                "task": "x",
                "state": state,
                "env": env_sentinel,
                "anchor": anchor_sentinel,
            },
        ]))
        assert "—" in plain
        assert env_sentinel not in plain
        assert anchor_sentinel not in plain


def test_non_string_state_is_ignored_by_projection_renderer():
    plain = _plain(ledger_view.render_ledger([
        {"time": "05-26 06:40", "task": "malformed state", "state": {"queued": True}},
    ]))
    assert "malformed state" in plain


def test_all_states_render_their_labels_together():
    plain = _plain(ledger_view.render_ledger(_mixed_rows()))
    assert "recorded" in plain
    assert "minted" in plain
    assert "tests-passed" in plain          # published row keeps its tier chip
    assert "vetoed (local only)" in plain
    assert "queued" not in plain            # enum never leaks


def test_rows_from_json_passes_state_through():
    rows = ledger_view.rows_from_json([
        {"time": "t", "task": "x", "state": "minted"},
        {"time": "t2", "task": "y", "state": "queued"},
    ])
    assert rows is not None
    assert [r["state"] for r in rows] == ["minted", "queued"]
