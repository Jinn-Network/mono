"""jinn-agent consent + ledger TUI — snapshot tests (Jinn-Network/mono#1418).

The consent screen is the product's trust surface and the gate on all
contribution; the ledger is where an operator sees what left the machine.
These tests assert the *presentation* — exact copy, keys, tier colours, the
retained-local retry sub-line, and the empty-state copy — while the consent
semantics and gating stay covered by test_jinn_plugin.py (unchanged).

Design artifact:
``docs/design/artifacts/2026-07-06-corpus-onboarding/1312-fork-consent-ledger.html``.

Rendering is pure ANSI (reuses the #1417 splash palette), so every surface is
re-derivable from these strings, not an eyeball. Colours are asserted against
the truecolor palette; visible text against the ANSI-stripped render.
"""

from __future__ import annotations

import re

import pytest

from hermes_cli.banner import _TC
from plugins.jinn import consent, ledger_view, style

_ANSI = re.compile(r"\033\[[0-9;]*m")


def _plain(text: str) -> str:
    return _ANSI.sub("", text)


# The full emoji planes — no consent/ledger surface may contain any (status is
# colour + word only). Box-drawing glyphs and the middot are not emoji.
_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002B00-\U00002BFF\U0000FE00-\U0000FE0F]"
)


@pytest.fixture(autouse=True)
def _truecolor(monkeypatch):
    # Force the truecolor palette so colour assertions are deterministic and
    # independent of the CI terminal's COLORTERM.
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setenv("COLORTERM", "truecolor")
    monkeypatch.setenv("COLUMNS", "120")
    # This suite snapshots the fork's copy verbatim (module is named for the
    # jinn-agent fork); pin the harness identity so the templated renderers
    # in consent.py resolve to the same literals these snapshots pin.
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    yield


# ── Consent explainer (design 1a) ────────────────────────────────────────────


def test_explainer_is_the_single_sharing_question():
    plain = _plain(consent.render_explainer_styled())
    assert "Contribute tasks from your work?" in plain
    assert (
        "When you solve something on a public project, Jinn can turn it into a "
        "task other agents can attempt" in plain
    )
    assert "a reproducible problem based on your work" in plain
    assert "Your actual code and history stay on your machine." in plain
    assert "Jinn works fully either way." in plain


def test_explainer_no_jargon():
    plain = _plain(consent.render_explainer_styled()).lower()
    for jargon in ("trace", "mining", "mineable", "scrubbed", "corpus"):
        assert jargon not in plain


def test_explainer_shows_keys_default_decline():
    plain = _plain(consent.render_explainer_styled())
    assert "[Y]" in plain and "Yes" in plain
    assert "[N]" in plain and "No" in plain
    assert "[P]" in plain and "Preview" in plain
    assert "[?]" in plain and "Docs" in plain
    assert "default is no" in plain


def test_explainer_no_emoji_no_vow_language():
    plain = _plain(consent.render_explainer_styled())
    assert not _EMOJI.search(plain)
    for vow in ("summon", "vessel", "smoke", "wish", "vow", "seer", "wane"):
        assert vow not in plain.lower()


# ── Confirm + recorded ───────────────────────────────────────────────────────


def test_confirm_accept_and_decline_copy():
    a = _plain(consent.render_confirm_styled(accept=True))
    assert "Share tasks from your work?" in a
    assert "[Y]" in a and "[N]" in a
    d = _plain(consent.render_confirm_styled(accept=False))
    assert "Keep everything on your machine?" in d
    assert "Nothing derived from your work will be shared." in d


def test_recorded_on_states_preview_gate():
    on = _plain(consent.render_recorded_styled(on=True))
    assert "sharing is ON" in on
    assert "nothing is shared until you" in on.lower()  # preview gate, plain speech


def test_recorded_off_keeps_everything_local():
    off = _plain(consent.render_recorded_styled(on=False))
    assert "sharing is OFF" in off
    assert "Nothing derived from your work leaves this machine" in off


def test_node_stub_is_later_or_skip_and_sets_nothing_up():
    plain = _plain(consent.render_node_stub_styled())
    assert "RUN A NETWORK NODE?" in plain
    assert "[L]" in plain and "Later" in plain
    assert "[Enter]" in plain and "Skip" in plain
    # Not needed to share or read — the stub configures nothing.
    assert "not needed to share or to read" in plain


# ── Preview example fixture ──────────────────────────────────────────────────


def test_preview_example_is_labelled_no_task_run_yet():
    plain = _plain(consent.render_preview_example())
    assert "example — no task run yet" in plain
    assert "NOTHING IS SHARED FROM THIS SCREEN" in plain
    assert not _EMOJI.search(plain)


# ── Ledger (design 1b) ───────────────────────────────────────────────────────


def _rows():
    return [
        {"time": "05-26 06:41", "task": "fix flaky retry", "env": "env-8f21c2",
         "anchor": "0x7a2f…c019", "tier": "evaluator-verified"},
        {"time": "05-25 23:58", "task": "add pagination", "env": "env-6c93e1",
         "anchor": "0x33de…0f17", "tier": "tests-passed"},
        {"time": "05-25 16:47", "task": "tidy dead imports", "env": "env-3ff019",
         "anchor": "0xaea9…3e0b", "tier": "user-accepted"},
        {"time": "05-25 22:41", "task": "refactor auth", "state": "vetoed"},
        {"time": "05-25 21:40", "task": "add rate-limit headers", "env": "env-5b17aa",
         "state": "failed"},
    ]


def test_ledger_columns_present():
    plain = _plain(ledger_view.render_ledger(_rows()))
    for col in ("TIME", "TASK", "ENVELOPE", "ANCHOR", "TIER"):
        assert col in plain


def test_ledger_tier_chip_colours():
    out = ledger_view.render_ledger(_rows())
    assert f"{_TC['sky']}user-accepted" in out       # sky
    assert f"{_TC['green']}tests-passed" in out       # green
    assert f"{_TC['gold']}evaluator-verified" in out  # gold


def test_ledger_vetoed_row_blanks_envelope_and_anchor_amber():
    out = ledger_view.render_ledger([
        {"time": "05-25 22:41", "task": "refactor auth", "state": "vetoed"},
    ])
    plain = _plain(out)
    assert "vetoed (local only)" in plain
    # envelope + anchor are em-dash placeholders
    assert "—" in plain
    assert f"{_TC['amber']}vetoed (local only)" in out


def test_ledger_failed_row_is_red_with_retry_subline():
    out = ledger_view.render_ledger([
        {"time": "05-25 21:40", "task": "add rate-limit headers",
         "env": "env-5b17aa", "state": "failed"},
    ])
    plain = _plain(out)
    assert "publish failed — retained locally" in plain
    assert "[r] retry" in plain
    assert "[v] veto instead" in plain
    assert f"{_TC['red']}publish failed — retained locally" in out


def test_ledger_counts_summary():
    plain = _plain(ledger_view.render_ledger(_rows()))
    assert "3 published" in plain
    assert "1 vetoed" in plain
    assert "1 retained" in plain


def test_ledger_empty_state_exact_copy():
    plain = _plain(ledger_view.render_ledger([], enabled=True))
    assert "Nothing published yet. Traces appear here after your first task" in plain
    assert "Vetoed and retained-local tasks are listed here too." in plain
    assert "contribution is ON" in plain


def test_ledger_empty_state_declined_is_reader_only():
    # A declined/unset operator must not be told contribution is ON.
    plain = _plain(ledger_view.render_ledger([], enabled=False))
    assert "contribution is OFF · reader only" in plain
    assert "contribution is ON" not in plain
    assert "turn on any time: /jinn consent" in plain


def test_ledger_strips_terminal_control_chars_from_fields():
    # A hostile `task` value carrying ESC / CR / newline must not reach the
    # terminal raw (ANSI injection) or desync the column padding.
    out = ledger_view.render_ledger([
        {"time": "05-25 16:47", "task": "evil\x1b[31mRED\r\n\x07", "env": "env-1",
         "anchor": "0x00…00", "tier": "tests-passed"},
    ])
    # The ESC that would open a raw ANSI sequence is stripped; the bracket text
    # that follows survives as inert literal characters.
    assert "evil[31mRED" in _plain(out)
    # CR and BEL (never emitted by styling) are gone from the raw output.
    assert "\r" not in out and "\x07" not in out
    # No stray ESC other than the palette's own well-formed codes: every ESC in
    # the output must be followed by '[' and a valid SGR terminator.
    stray = re.sub(r"\033\[[0-9;]*m", "", out)
    assert "\033" not in stray


def test_ledger_vow_language_only_in_node_id_chrome():
    # The only vow-word on the surface is the vessel-… node id (neutral chrome).
    plain = _plain(ledger_view.render_ledger(_rows()))
    assert "vessel-0x91be…44a2" in plain
    # No vow-language on any tier / state / failure line.
    for line in plain.splitlines():
        if "vessel-" in line:
            continue
        for vow in ("summon", "smoke", "wish", "vow ", "seer", "wane"):
            assert vow not in line.lower()


def test_ledger_no_emoji():
    assert not _EMOJI.search(_plain(ledger_view.render_ledger(_rows())))


# ── JSON coercion for the /jinn ledger wiring ────────────────────────────────


def test_rows_from_json_accepts_list_and_wrapped():
    payload = [{"time": "t", "task": "x", "envelope": "e", "anchor": "a", "tier": "tests-passed"}]
    rows = ledger_view.rows_from_json(payload)
    assert rows is not None and rows[0]["env"] == "e"
    wrapped = ledger_view.rows_from_json({"rows": payload})
    assert wrapped is not None and wrapped[0]["tier"] == "tests-passed"


def test_rows_from_json_rejects_bad_shape():
    assert ledger_view.rows_from_json("nope") is None
    assert ledger_view.rows_from_json({"rows": "nope"}) is None
    assert ledger_view.rows_from_json([1, 2, 3]) is None


# ── NO_COLOR degrades to plain text ──────────────────────────────────────────


def test_no_color_yields_plain_text(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "1")
    out = consent.render_explainer_styled()
    assert _ANSI.search(out) is None  # no escape codes at all
    ledg = ledger_view.render_ledger(_rows())
    assert _ANSI.search(ledg) is None
