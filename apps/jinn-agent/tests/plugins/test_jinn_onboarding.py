"""jinn-agent guided first-run onboarding — snapshot tests (mono#1405).

The capstone of the CLI TUI chain (#1417 splash → #1418 consent/ledger →
this). These tests assert the *presentation* (exact copy, keys, step-rail
states) and the *contract*: facts-over-flags persistence (returning operators
see nothing; reads are non-destructive), the confirmed-step-at-a-time flow,
``--replay`` re-rendering without re-asking, and the ``◇ corpus`` evidence
signal-line format wired into pickup's first-turn pickup path (Stage 1
rescope R3 — the walk is now consent → publish → signals; the rewards step
and the "run a network node" stub are Stage 3 economy concepts, removed).

Design artifact:
``docs/design/artifacts/2026-07-06-corpus-onboarding/1405-cli-onboarding.html``.

Rendering is pure ANSI (reuses the #1417 splash palette). Colours asserted
against the truecolor palette; visible text against the ANSI-stripped render.
"""

from __future__ import annotations

import json
import re

import pytest

from hermes_cli.banner import _TC
from plugins.jinn import consent, onboarding

_ANSI = re.compile(r"\033\[[0-9;]*m")


def _plain(text: str) -> str:
    return _ANSI.sub("", text)


_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002B00-\U00002BFF\U0000FE00-\U0000FE0F]"
)


@pytest.fixture(autouse=True)
def _truecolor(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("JINN_MINEABLE_STATE_DIR", str(tmp_path / "mineable"))
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setenv("COLORTERM", "truecolor")
    monkeypatch.setenv("COLUMNS", "120")
    yield tmp_path


# ── A canned ledger runner (fact source for step 2 + --replay) ───────────────


class LedgerRunner:
    """Serves ``jinn-layer ledger --json`` with a fixed row set."""

    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def __call__(self, argv):
        self.calls.append(argv)
        if argv[1:] == ["ledger", "--json"]:
            return 0, json.dumps({"rows": self.rows})
        return 1, f"unexpected: {argv}"


_PUBLISHED_ROW = {
    "time": "05-26 06:41", "task": "fix flaky retry", "env": "bafkFIRSTenv",
    "anchor": "0x7a2f…c019", "tier": "tests-passed",
}


# ── Step 1 · consent (reuses #1418 renderers) ────────────────────────────────


def test_step1_recorded_on_continues_to_publish():
    plain = _plain(onboarding.render_consent_recorded())
    assert "step 1 of 3" in plain
    assert "sharing is ON" in plain
    assert "Continue — step 2 · your first publish" in plain
    assert "[Enter]" in plain
    assert not _EMOJI.search(plain)


def test_step1_recorded_off_sets_aside_publish():
    plain = _plain(onboarding.render_consent_recorded_off())
    assert "OFF · reader only" in plain
    assert "set aside" in plain
    assert "reading the corpus is on for everyone" in plain
    assert "Continue — step 3 · corpus signals" in plain


def test_step1_rail_shows_consent_current_gold():
    out = onboarding.render_consent_recorded()
    # The rail's current step (consent, index 0) is gold.
    assert f"{_TC['gold']}consent" in out


def test_step1_rail_has_exactly_three_steps():
    plain = _plain(onboarding.render_consent_recorded())
    assert "consent" in plain and "publish" in plain and "signals" in plain
    assert "rewards" not in plain.lower()


# ── Step 2 · first publish ───────────────────────────────────────────────────


def test_step2_waiting_screen_says_it_completes_on_the_event():
    plain = _plain(onboarding.render_first_publish_waiting())
    assert "Run your first task." in plain
    assert "completes on its own when your first task finishes" in plain
    # The waiting screen must offer an explicit key, not auto-advance.
    assert "[Enter]" in plain and "[S]" in plain and "Skip" in plain


def test_step2_confirmation_frame_has_task_tier_envelope_anchor():
    plain = _plain(onboarding.render_first_publish_confirmed())
    for field in ("task", "tier", "envelope", "anchor", "view it"):
        assert field in plain
    assert "tests-passed" in plain
    assert "published — your first contribution" in plain


def test_step2_view_it_is_the_single_gold_deep_link():
    out = onboarding.render_first_publish_confirmed(envelope="bafkTESTcid")
    plain = _plain(out)
    assert "explorer.jinn.network/corpus/bafkTESTcid" in plain
    # The deep link is gold (the single hero line).
    assert f"{_TC['gold']}explorer.jinn.network/corpus/bafkTESTcid" in out


def test_step2_rail_consent_done_publish_current():
    out = onboarding.render_first_publish_confirmed()
    assert f"{_TC['green']}consent" in out   # done
    assert f"{_TC['gold']}publish" in out    # current


def test_step2_confirmed_continues_directly_to_signals():
    # No rewards step: publish transitions straight to step 3.
    plain = _plain(onboarding.render_first_publish_confirmed())
    assert "Continue — step 3 · corpus signals" in plain
    assert "rewards" not in plain.lower()


# ── Step 3 · corpus signals + the evidence signal line ───────────────────────


def test_step3_shows_the_signal_line_format_once():
    plain = _plain(onboarding.render_signals({"consent": "done", "publish": "done"}))
    assert "step 3 of 3" in plain
    assert "prior evidence" in plain.lower()
    assert "◇ corpus" in plain
    assert "Finish" in plain


def test_evidence_signal_line_format():
    out = onboarding.render_evidence_signal_line(["dashboard", "vitest", "flake"], 1)
    plain = _plain(out)
    assert plain.startswith("  ◇ corpus")
    assert "provided 1 evidence packet" in plain
    assert "searched: dashboard, vitest, flake" in plain
    # ◇ prefix is sky (structure); the provided-count phrase is bright fg.
    assert f"{_TC['sky']}◇ corpus" in out
    assert f"{_TC['fg']}provided 1 evidence packet" in out
    assert not _EMOJI.search(plain)


def test_evidence_signal_line_pluralises_the_packet_noun():
    plain = _plain(onboarding.render_evidence_signal_line(["dashboard"], 2))
    assert "provided 2 evidence packets" in plain
    singular = _plain(onboarding.render_evidence_signal_line(["dashboard"], 1))
    assert "provided 1 evidence packet " in singular or singular.rstrip().endswith("packet")


def test_evidence_signal_line_strips_terminal_control_chars():
    # Searched terms are derived from the session's own first message, but
    # sanitise unconditionally anyway (matches the rest of this module's
    # convention for any dynamic field reaching the terminal).
    out = onboarding.render_evidence_signal_line(["evil\x1b[31mterm", "pwn\rned\x07"], 1)
    plain = _plain(out)
    assert "evil[31mterm" in plain
    assert "pwnned" in plain
    assert "\r" not in out and "\x07" not in out
    stray = _ANSI.sub("", out)
    assert "\033" not in stray


def test_no_installed_skill_or_adopt_language_anywhere_in_onboarding():
    # Boundary: Stage 3 concepts (skill install/adopt) must not leak into
    # Stage 1 onboarding copy.
    screens = [
        onboarding.render_consent_recorded(),
        onboarding.render_consent_recorded_off(),
        onboarding.render_first_publish_waiting(),
        onboarding.render_first_publish_confirmed(),
        onboarding.render_signals({"consent": "done", "publish": "done"}),
        onboarding.render_done(reader_only=False),
        onboarding.render_done(reader_only=True),
    ]
    for screen in screens:
        plain = _plain(screen).lower()
        assert "install" not in plain
        assert "adopt" not in plain
        assert "skill" not in plain


def test_no_rewards_or_olas_earning_language_anywhere_in_onboarding():
    screens = [
        onboarding.render_consent_recorded(),
        onboarding.render_consent_recorded_off(),
        onboarding.render_first_publish_waiting(),
        onboarding.render_first_publish_confirmed(),
        onboarding.render_signals({"consent": "done", "publish": "done"}),
        onboarding.render_done(reader_only=False),
        onboarding.render_done(reader_only=True),
    ]
    for screen in screens:
        plain = _plain(screen).lower()
        assert "rewards" not in plain
        assert "olas earned" not in plain
        assert "/jinn rewards" not in plain
        assert "run a network node" not in plain


# ── Persistence — facts over flags ───────────────────────────────────────────


def test_returning_operator_is_complete_and_sees_nothing(tmp_path):
    # Consent recorded + ledger non-empty + the signals flag → complete.
    consent.record_accept()
    onboarding.mark_flag("signals_shown")
    runner = LedgerRunner([_PUBLISHED_ROW])
    assert onboarding.is_complete(runner=runner) is True


def test_unset_consent_is_not_complete(tmp_path):
    runner = LedgerRunner([_PUBLISHED_ROW])
    # No consent recorded → step 1 unsatisfied.
    assert onboarding.consent_decided() is False
    assert onboarding.is_complete(runner=runner) is False


def test_accepted_but_empty_ledger_is_not_complete(tmp_path):
    consent.record_accept()
    onboarding.mark_flag("signals_shown")
    runner = LedgerRunner([])  # ledger empty → step 2 fact unsatisfied
    assert onboarding.ledger_nonempty(runner=runner) is False
    assert onboarding.is_complete(runner=runner) is False


def test_declined_operator_complete_on_signals_flag_only(tmp_path):
    # Reader-only: publish is set aside, so the ledger fact does not gate.
    consent.record_decline()
    runner = LedgerRunner([])
    assert onboarding.is_complete(runner=runner) is False  # signals not shown yet
    onboarding.mark_flag("signals_shown")
    assert onboarding.is_complete(runner=runner) is True


def test_only_signals_shown_is_a_valid_flag_name(tmp_path):
    with pytest.raises(ValueError):
        onboarding.mark_flag("rewards_explained")


def test_deleting_flag_file_reruns_only_step_3(tmp_path):
    # Consent + publish are facts (survive); the flag is onboarding's own.
    consent.record_accept()
    onboarding.mark_flag("signals_shown")
    onboarding.state_path().unlink()
    # Facts survive:
    assert onboarding.consent_decided() is True
    # Flag resets:
    flags = onboarding.load_flags()
    assert flags["signals_shown"] is False


def test_flag_writes_never_touch_consent_or_ledger(tmp_path):
    consent.record_accept()
    before = consent.state_path().read_text()
    onboarding.mark_flag("signals_shown")
    # Non-destructive: onboarding writes only its own flag file.
    assert consent.state_path().read_text() == before
    assert onboarding.state_path().exists()


def test_ledger_read_is_non_destructive(tmp_path):
    # ledger_nonempty issues a read-only `ledger --json`, never a write verb.
    runner = LedgerRunner([_PUBLISHED_ROW])
    assert onboarding.ledger_nonempty(runner=runner) is True
    for call in runner.calls:
        assert call[1] == "ledger"  # only reads, no publish/veto


def test_ledger_unreachable_degrades_to_not_done(tmp_path):
    class Broken:
        def __call__(self, argv):
            return 1, "layer down"

    assert onboarding.ledger_nonempty(runner=Broken()) is False


# ── The driver — one confirmed step at a time ────────────────────────────────


class Driver:
    """Feeds scripted keypresses to run_onboarding, collects each screen."""

    def __init__(self, keys):
        self._keys = list(keys)
        self.screens = []

    def input(self, prompt):
        return self._keys.pop(0) if self._keys else ""

    def print(self, s):
        self.screens.append(s)

    def plain(self):
        return _plain("\n".join(self.screens))


def test_driver_accept_path_walks_all_three_steps(tmp_path, monkeypatch):
    # consent 'a' → confirm 'y', then step-1 enter, step-2 enter, step-3 enter.
    d = Driver(["a", "y", "", "", ""])
    onboarding.run_onboarding(d.input, d.print)
    text = d.plain()
    # Sharing recorded ON, then both remaining step surfaces + done.
    assert "sharing is ON" in text
    assert "your first publish" in text
    assert "prior evidence" in text.lower()
    assert "complete" in text.lower()
    assert "rewards" not in text.lower()
    # Facts-over-flags: sharing consent is on, the signals flag is true.
    assert consent.share_enabled() is True
    flags = onboarding.load_flags()
    assert flags["signals_shown"]


def test_driver_decline_path_skips_to_signals(tmp_path):
    # consent bare-enter → decline confirm 'y'; step-1 enter, step-3 enter.
    d = Driver(["", "y", "", ""])
    onboarding.run_onboarding(d.input, d.print)
    text = d.plain()
    assert "reader only" in text
    # The publish CONFIRMATION SCREEN is never rendered on the decline path
    # (step 1's own explanation names step 2, which is a different thing).
    assert "Run your first task." not in text
    assert "published — your first contribution" not in text
    assert "prior evidence" in text.lower()
    flags = onboarding.load_flags()
    assert flags["signals_shown"]


def test_driver_replay_re_asks_nothing_and_writes_nothing(tmp_path):
    # A returning operator replays: consent recorded, ledger has the row.
    consent.record_accept()
    onboarding.mark_flag("signals_shown")
    before_consent = consent.state_path().read_text()
    before_flags = onboarding.state_path().read_text()

    runner = LedgerRunner([_PUBLISHED_ROW])
    # 3 confirmations, one per screen. No consent keystrokes — never re-asked.
    d = Driver(["", "", ""])
    onboarding.run_onboarding(d.input, d.print, replay=True, runner=runner)
    text = d.plain()
    # Shows the recorded consent state + the ACTUAL first envelope from ledger.
    assert "sharing is ON" in text
    assert "bafkFIRSTenv" in text
    # Replay mutates neither consent nor the flag file.
    assert consent.state_path().read_text() == before_consent
    assert onboarding.state_path().read_text() == before_flags


def test_run_onboarding_no_longer_accepts_a_rewards_fn(tmp_path):
    # The rewards step (and its rewards_fn hook) is gone — passing it is a
    # TypeError, proving the parameter was actually removed, not just unused.
    d = Driver(["a", "y", "", "", ""])
    with pytest.raises(TypeError):
        onboarding.run_onboarding(d.input, d.print, rewards_fn=lambda: None)


# ── NO_COLOR degrades to plain text ──────────────────────────────────────────


def test_no_color_yields_plain_text(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("NO_COLOR", "1")
    for out in (
        onboarding.render_consent_recorded(),
        onboarding.render_first_publish_confirmed(),
        onboarding.render_signals({"consent": "done"}),
        onboarding.render_evidence_signal_line(["dashboard"], 1),
    ):
        assert _ANSI.search(out) is None


# ── CLI handler ──────────────────────────────────────────────────────────────


def test_cli_returning_operator_is_a_noop(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    consent.record_accept()
    onboarding.mark_flag("signals_shown")
    # Patch the ledger fact to "non-empty" so is_complete() is satisfied.
    monkeypatch.setattr(onboarding, "ledger_nonempty", lambda runner=None: True)

    class Args:
        replay = False

    rc = onboarding.cli_handler(Args())
    assert rc == 0
    assert "already complete" in capsys.readouterr().out
