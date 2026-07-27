"""`_user_line` prints byte-plain regardless of the active palette (mono #1798).

`_user_line` (plugins/jinn/__init__.py) is the TUI-visible feedback channel:
`print(..., file=sys.stderr)`, proxied by prompt_toolkit's `patch_stdout`
while the TUI runs. That proxy renders raw ESC bytes as `?[38;2;…m` noise
rather than colour, so this channel must strip ANSI unconditionally before
printing — matching the fork-precedent plugins (memory/hindsight) it was
modeled on. Styled surfaces that never run inside the TUI (the
pickup `◇ corpus` line) are untouched; see
`test_jinn_corpus_view.py::test_evidence_signal_line_format` for the
still-styled counterpart.

`style.strip_ansi` is unit-tested directly here; the pickup marker-line
counterpart (`pickup._default_signal_sink`) is covered in
`test_jinn_pickup.py`, which already owns the pickup fixtures.
"""

from __future__ import annotations

import importlib

import pytest

jinn = importlib.import_module("plugins.jinn")
style = importlib.import_module("plugins.jinn.style")
session_view = importlib.import_module("plugins.jinn.session_view")


@pytest.fixture(autouse=True)
def _truecolor(monkeypatch, tmp_path):
    # Forces the exact palette the live bug report showed
    # (`\033[38;2;122;167;220m`) — NO_COLOR unset, COLORTERM=truecolor,
    # wide enough columns for style.supports_truecolor().
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setenv("COLORTERM", "truecolor")
    monkeypatch.setenv("COLUMNS", "120")


def test_strip_ansi_removes_truecolor_and_reset_sequences():
    styled = (
        f"{style._TC['sky']}◇ corpus{style._RST}  "
        f"{style._TC['fg']}provided 1 evidence packet{style._RST}"
    )
    assert "\x1b" in styled  # sanity: the fixture built a genuinely styled string

    plain = style.strip_ansi(styled)

    assert "\x1b" not in plain
    assert plain == "◇ corpus  provided 1 evidence packet"


def test_strip_ansi_is_a_no_op_on_plain_text():
    assert style.strip_ansi("already plain") == "already plain"


def test_user_line_prints_byte_plain(capsys):
    styled = (
        f"{style._TC['sky']}◇ corpus{style._RST}  "
        f"{style._TC['fg']}provided 1 evidence packet{style._RST}"
    )

    jinn._user_line(styled)

    err = capsys.readouterr().err
    assert "\x1b" not in err
    assert "◇ corpus" in err
    assert "provided 1 evidence packet" in err


def test_session_end_summary_rendered_block_prints_byte_plain(capsys):
    rendered = session_view.render_complete(
        summary={
            "searchedTerms": ["dashboard", "vitest"],
            "providedPackets": [{"ref": "bafySourceEpisode", "title": "x"}],
            "nothingFound": False,
            "eligibility": {"eligible": True, "reason": "accepted diff"},
        },
        activity={},
        capture_status="captured",
        local_learning_status="pending",
        contribution={"status": "ok", "value": {"status": "recorded"}},
    )
    # Sanity: under this env the renderer itself does emit ANSI (the title
    # line) — otherwise this test couldn't guard against the regression.
    assert "\x1b" in rendered

    jinn._user_line(rendered)

    err = capsys.readouterr().err
    assert "\x1b" not in err
    assert "Jinn" in err
    assert "Used 1 prior note from your local Jinn history" in err
    assert "Saved this session for next time" in err
    assert "episode captured" not in err
    assert "local learning pending" not in err
    assert "contribution recorded" not in err
