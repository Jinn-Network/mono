"""The ``◇ corpus`` evidence-pickup signal line (mono#1818).

Relocated from the deleted onboarding wizard: this renderer is the
product-behaviour line wired into pickup.py's first-turn pickup path.
These assert the exact copy, the sky ``◇`` prefix / bright count structure,
control-char sanitisation, and NO_COLOR degradation.

Rendering is pure ANSI; colours asserted against the truecolor palette,
visible text against the ANSI-stripped render.
"""

from __future__ import annotations

import re

import pytest

from hermes_cli.banner import _TC
from plugins.jinn import corpus_view


@pytest.fixture(autouse=True)
def _truecolor(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setenv("COLORTERM", "truecolor")
    monkeypatch.setenv("COLUMNS", "120")
    yield tmp_path

_ANSI = re.compile(r"\033\[[0-9;]*m")


def _plain(text: str) -> str:
    return _ANSI.sub("", text)


_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002B00-\U00002BFF\U0000FE00-\U0000FE0F]"
)


def test_evidence_signal_line_format():
    out = corpus_view.render_evidence_signal_line(["dashboard", "vitest", "flake"], 1)
    plain = _plain(out)
    assert plain.startswith("  ◇ corpus")
    assert "provided 1 evidence packet" in plain
    assert "searched: dashboard, vitest, flake" in plain
    # ◇ prefix is sky (structure); the provided-count phrase is bright fg.
    assert f"{_TC['sky']}◇ corpus" in out
    assert f"{_TC['fg']}provided 1 evidence packet" in out
    assert not _EMOJI.search(plain)


def test_evidence_signal_line_pluralises_the_packet_noun():
    plain = _plain(corpus_view.render_evidence_signal_line(["dashboard"], 2))
    assert "provided 2 evidence packets" in plain
    singular = _plain(corpus_view.render_evidence_signal_line(["dashboard"], 1))
    assert "provided 1 evidence packet " in singular or singular.rstrip().endswith("packet")


def test_evidence_signal_line_strips_terminal_control_chars():
    # Searched terms are derived from the session's own first message, but
    # sanitise unconditionally anyway (matches the rest of the plugin's
    # convention for any dynamic field reaching the terminal).
    out = corpus_view.render_evidence_signal_line(["evil\x1b[31mterm", "pwn\rned\x07"], 1)
    plain = _plain(out)
    assert "evil[31mterm" in plain
    assert "pwnned" in plain
    assert "\r" not in out and "\x07" not in out
    stray = _ANSI.sub("", out)
    assert "\033" not in stray


def test_no_color_yields_plain_text(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("NO_COLOR", "1")
    out = corpus_view.render_evidence_signal_line(["dashboard"], 1)
    assert _ANSI.search(out) is None
