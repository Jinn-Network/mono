"""jinn-agent guided first-run onboarding — snapshot tests (mono#1405).

The capstone of the CLI TUI chain (#1417 splash → #1418 consent/ledger →
this). These tests assert the *presentation* (exact copy, keys, step-rail
states) and the *contract*: facts-over-flags persistence (returning operators
see nothing; reads are non-destructive), the confirmed-step-at-a-time flow,
``--replay`` re-rendering without re-asking, and the ``◇ corpus`` signal-line
format wired into pickup's consumption path.

Design artifact:
``docs/design/artifacts/2026-07-06-corpus-onboarding/1405-cli-onboarding.html``.

Rendering is pure ANSI (reuses the #1417 splash palette), so every screen is
re-derivable from these strings. Colours asserted against the truecolor
palette; visible text against the ANSI-stripped render.
"""

from __future__ import annotations

import importlib
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
    assert "step 1 of 4" in plain
    assert "sharing is ON" in plain
    assert "Continue — step 2 · your first publish" in plain
    assert "[Enter]" in plain
    assert not _EMOJI.search(plain)


def test_step1_recorded_off_sets_aside_publish_and_rewards():
    plain = _plain(onboarding.render_consent_recorded_off())
    assert "OFF · reader only" in plain
    assert "they're set aside" in plain
    assert "reading the corpus is on for everyone" in plain
    assert "Continue — step 4 · corpus signals" in plain


def test_step1_rail_shows_consent_current_gold():
    out = onboarding.render_consent_recorded()
    # The rail's current step (consent, index 0) is gold.
    assert f"{_TC['gold']}consent" in out


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


# ── Step 3 · rewards ─────────────────────────────────────────────────────────


def test_step3_none_yet_states_the_honest_trigger():
    plain = _plain(onboarding.render_rewards_none())
    assert "OLAS earned:" in plain and "none yet" in plain
    # Plain speech on money — protocol-native verb (no pay/paid): publication
    # alone does not earn; verification triggers it and is not guaranteed.
    assert "Publication alone does not earn" in plain
    assert "verification" in plain and "it is not guaranteed." in plain
    assert not _EMOJI.search(plain)


def test_step3_names_the_tier_ladder_with_ledger_colours():
    out = onboarding.render_rewards_none()
    assert f"{_TC['green']}tests-passed" in out
    assert f"{_TC['gold']}evaluator-verified" in out


def test_step3_earned_variant_states_amount_and_count():
    plain = _plain(onboarding.render_rewards_earned("12.40 OLAS", 3))
    assert "12.40 OLAS" in plain
    assert "3 traces evaluator-verified" in plain
    assert "not publication" in plain


def test_step3_earned_singular_count_grammar():
    plain = _plain(onboarding.render_rewards_earned("4.10 OLAS", 1))
    assert "1 trace evaluator-verified" in plain


def test_step3_earned_degrades_amount_honestly():
    # No fabricated figure — 'checking…' is passed straight through.
    plain = _plain(onboarding.render_rewards_earned("checking…", 2))
    assert "checking…" in plain


# ── Step 4 · corpus signals + the signal line ────────────────────────────────


def test_step4_shows_the_signal_line_format_once():
    plain = _plain(onboarding.render_signals({"consent": "done", "publish": "done", "rewards": "done"}))
    assert "When a run draws on the corpus, you'll see it." in plain
    assert "◇ corpus" in plain
    assert "One line per use" in plain
    assert "Finish" in plain


def test_corpus_signal_line_format():
    out = onboarding.render_corpus_signal_line(
        "retry-backoff-patterns", "learned from 214 contributions", "bafkr…hx2c"
    )
    plain = _plain(out)
    assert plain.startswith("  ◇ corpus")
    assert "using retry-backoff-patterns" in plain
    assert "learned from 214 contributions" in plain
    assert "env bafkr…hx2c" in plain
    # ◇ prefix is sky (structure), skill name is bright fg.
    assert f"{_TC['sky']}◇ corpus" in out
    assert f"{_TC['fg']}retry-backoff-patterns" in out
    assert not _EMOJI.search(plain)


def test_corpus_signal_line_strips_terminal_control_chars():
    # The corpus is PUBLIC + cross-operator: a hostile adopted skill/summary/ref
    # carrying ESC / CR / BEL must not reach a victim operator's terminal raw
    # (ANSI injection, screen manipulation) on auto-adoption.
    out = onboarding.render_corpus_signal_line(
        "evil\x1b[31mSKILL",
        "pwn\rned\x07",
        "bafk\x1b[2Jref",
    )
    plain = _plain(out)
    # The ESC that would open a raw ANSI sequence is stripped; the bracket text
    # that follows survives as inert literal characters.
    assert "evil[31mSKILL" in plain
    assert "pwnned" in plain
    assert "bafk[2Jref" in plain
    # CR and BEL (never emitted by styling) are gone from the raw output.
    assert "\r" not in out and "\x07" not in out
    # No stray ESC other than the palette's own well-formed SGR codes.
    stray = _ANSI.sub("", out)
    assert "\033" not in stray


def test_corpus_signal_line_hooked_into_pickup(tmp_path, monkeypatch):
    """Adopting a verified corpus skill emits exactly one ◇ corpus line."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Auto-adopt is opt-in by default (manual-approval-by-default); opt in so
    # this test can exercise the adopt-signal path.
    cfg = tmp_path / "jinn" / "pickup.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps({"autoAdopt": True}))
    # Reload pickup fresh so its module-level state is clean.
    pickup = importlib.reload(importlib.import_module("plugins.jinn.pickup"))

    tp = importlib.import_module("tests.plugins.test_jinn_pickup")
    skills_install = importlib.import_module("plugins.jinn.skills_install")
    # The adopt DECISION (and its signal-line emission) is under test here,
    # not the layer shell-out (that's covered in test_jinn_skills_install.py).
    monkeypatch.setattr(skills_install, "install", tp._fake_install(tmp_path))
    runner = tp.CorpusRunner(tp.trace(tier="evaluator-verified", slug="tdd"))

    lines = []
    result = pickup.pickup(tp.MSG, runner=runner, signal_sink=lines.append)
    assert result is not None
    assert "Adopted automatically (verified)" in result["context"]
    # Exactly one signal line, at the point of use, carrying the ref.
    assert len(lines) == 1
    plain = _plain(lines[0])
    assert plain.startswith("  ◇ corpus")
    assert "using tdd" in plain
    assert "evaluator-verified" in plain
    assert "env " in plain


def test_pickup_suggested_but_not_adopted_emits_no_signal(tmp_path, monkeypatch):
    """A suggested (unadopted) candidate is only injected context, not used —
    so it must NOT emit a signal."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    pickup = importlib.reload(importlib.import_module("plugins.jinn.pickup"))
    tp = importlib.import_module("tests.plugins.test_jinn_pickup")
    runner = tp.CorpusRunner(tp.trace(tier="user-accepted", slug="tdd"))
    lines = []
    result = pickup.pickup(tp.MSG, runner=runner, signal_sink=lines.append)
    assert result is not None
    assert "unverified" in result["context"]
    assert lines == []


# ── Persistence — facts over flags ───────────────────────────────────────────


def test_returning_operator_is_complete_and_sees_nothing(tmp_path):
    # Consent recorded + ledger non-empty + both flags → complete.
    consent.record_accept()
    onboarding.mark_flag("rewards_explained")
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
    onboarding.mark_flag("rewards_explained")
    onboarding.mark_flag("signals_shown")
    runner = LedgerRunner([])  # ledger empty → step 2 fact unsatisfied
    assert onboarding.ledger_nonempty(runner=runner) is False
    assert onboarding.is_complete(runner=runner) is False


def test_declined_operator_complete_on_signals_flag_only(tmp_path):
    # Reader-only: publish/rewards set aside, so the ledger fact does not gate.
    consent.record_decline()
    runner = LedgerRunner([])
    assert onboarding.is_complete(runner=runner) is False  # signals not shown yet
    onboarding.mark_flag("signals_shown")
    assert onboarding.is_complete(runner=runner) is True


def test_deleting_flag_file_reruns_only_steps_3_and_4(tmp_path):
    # Consent + publish are facts (survive); flags are onboarding's own.
    consent.record_accept()
    onboarding.mark_flag("rewards_explained")
    onboarding.mark_flag("signals_shown")
    onboarding.state_path().unlink()
    # Facts survive:
    assert onboarding.consent_decided() is True
    # Flags reset:
    flags = onboarding.load_flags()
    assert flags["rewards_explained"] is False and flags["signals_shown"] is False


def test_flag_writes_never_touch_consent_or_ledger(tmp_path):
    consent.record_accept()
    before = consent.state_path().read_text()
    onboarding.mark_flag("rewards_explained")
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


def test_driver_accept_path_walks_all_four_steps(tmp_path, monkeypatch):
    # consent 'a' → confirm 'y' → node skip enter, then step-1 enter, step-2
    # enter, step-3 enter, step-4 enter.
    d = Driver(["a", "y", "", "", "", "", ""])
    onboarding.run_onboarding(d.input, d.print)
    text = d.plain()
    # Sharing recorded ON, then all four step surfaces + done.
    assert "sharing is ON" in text
    assert "your first publish" in text
    assert "OLAS earned:" in text
    assert "When a run draws on the corpus" in text
    assert "complete" in text.lower()
    # Flags set (facts-over-flags: sharing consent is on, both seen-flags true).
    assert consent.share_enabled() is True
    flags = onboarding.load_flags()
    assert flags["rewards_explained"] and flags["signals_shown"]


def test_driver_decline_path_skips_to_signals(tmp_path):
    # consent bare-enter → decline confirm 'y' → node enter; step-1 enter,
    # step-4 enter.
    d = Driver(["", "y", "", "", ""])
    onboarding.run_onboarding(d.input, d.print)
    text = d.plain()
    assert "reader only" in text
    # Publish + rewards are set aside — never rendered on the decline path.
    assert "your first publish" not in text
    assert "OLAS earned:" not in text
    assert "When a run draws on the corpus" in text
    # Only the signals flag is set; rewards stays unseen.
    flags = onboarding.load_flags()
    assert flags["signals_shown"] and not flags["rewards_explained"]


def test_driver_replay_re_asks_nothing_and_writes_nothing(tmp_path):
    # A returning operator replays: consent recorded, ledger has the row.
    consent.record_accept()
    onboarding.mark_flag("rewards_explained")
    onboarding.mark_flag("signals_shown")
    before_consent = consent.state_path().read_text()
    before_flags = onboarding.state_path().read_text()

    runner = LedgerRunner([_PUBLISHED_ROW])
    # 4 confirmations, one per screen. No consent keystrokes — never re-asked.
    d = Driver(["", "", "", ""])
    onboarding.run_onboarding(d.input, d.print, replay=True, runner=runner)
    text = d.plain()
    # Shows the recorded consent state + the ACTUAL first envelope from ledger.
    assert "sharing is ON" in text
    assert "bafkFIRSTenv" in text
    # Replay mutates neither consent nor the flag file.
    assert consent.state_path().read_text() == before_consent
    assert onboarding.state_path().read_text() == before_flags


def test_driver_earned_variant_when_rewards_fn_reports(tmp_path):
    d = Driver(["a", "y", "", "", "", "", ""])
    onboarding.run_onboarding(
        d.input, d.print,
        rewards_fn=lambda: {"amount": "12.40 OLAS", "count": 3},
    )
    text = d.plain()
    assert "12.40 OLAS" in text
    assert "3 traces evaluator-verified" in text


# ── NO_COLOR degrades to plain text ──────────────────────────────────────────


def test_no_color_yields_plain_text(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("NO_COLOR", "1")
    for out in (
        onboarding.render_consent_recorded(),
        onboarding.render_first_publish_confirmed(),
        onboarding.render_rewards_none(),
        onboarding.render_signals({"consent": "done"}),
        onboarding.render_corpus_signal_line("s", "p", "e"),
    ):
        assert _ANSI.search(out) is None


# ── CLI handler ──────────────────────────────────────────────────────────────


def test_cli_returning_operator_is_a_noop(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    consent.record_accept()
    onboarding.mark_flag("rewards_explained")
    onboarding.mark_flag("signals_shown")
    # Patch the ledger fact to "non-empty" so is_complete() is satisfied.
    monkeypatch.setattr(onboarding, "ledger_nonempty", lambda runner=None: True)

    class Args:
        replay = False

    rc = onboarding.cli_handler(Args())
    assert rc == 0
    assert "already complete" in capsys.readouterr().out
