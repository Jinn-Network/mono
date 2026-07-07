"""jinn-agent terminal splash — snapshot tests (Jinn-Network/mono#1417).

The splash is the first surface every operator sees at launch: sigil +
lowercase ``jinn`` wordmark + gold rule + version + four live status lines
(network, corpus, contribution, node). Design artifact:
``docs/design/artifacts/2026-07-06-corpus-onboarding/1319-terminal-splash.html``.

These tests assert the exact rendered strings and colours per state — not an
eyeball. They cover: the status lines in every documented state, the fixed
ordering, contribution-line omission pre-consent, node-line omission (the fork
has no node source), ``checking…`` for unresolved network/corpus values, no
emoji, gold-appears-exactly-twice-on-testnet (with the sanctioned mainnet
three-gold exception — the network line is gold on mainnet), and the 80x24
ASCII fallback fit. banner.py is an owned upstream file (JINN.md); this splash
surface is re-derivable from these tests.
"""

from __future__ import annotations

import re

import pytest

from hermes_cli import banner
from hermes_cli.banner import _FB, _TC, render_jinn_splash

# ── helpers ──────────────────────────────────────────────────────────────────

_ANSI = re.compile(r"\033\[[0-9;]*m")


def _plain(text: str) -> str:
    """Strip ANSI SGR codes → visible characters only."""
    return _ANSI.sub("", text)


def _healthy_state(**over) -> dict:
    state = {
        "network": "testnet",
        "network_label": "testnet",
        "corpus": "connected",
        "corpus_count": 1284902,
        "contribution": "on",
        "contribution_count": 1284,
        "node": "running",
        "node_vessel": "vessel-0x91be…44a2",
        "version": "v0.4.2",
    }
    state.update(over)
    return state


# The full emoji planes — the splash must contain none (status is colour +
# word only). Excludes the design's box-drawing glyphs and the middot, which
# are not emoji.
_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\U00002B00-\U00002BFF\U0000FE00-\U0000FE0F]"
)


# ── status-line strings, every state (design 3.3 table) ──────────────────────


def test_network_testnet_string_and_colour():
    out = render_jinn_splash(_healthy_state(), truecolor=True)
    plain = _plain(out)
    assert "network        base-sepolia · testnet" in plain
    # value carries sky
    assert f"{_TC['sky']}base-sepolia · testnet" in out


def test_network_mainnet_string_and_gold():
    out = render_jinn_splash(
        _healthy_state(network="mainnet", network_label="mainnet"), truecolor=True
    )
    assert "network        base · mainnet" in _plain(out)
    assert f"{_TC['gold']}base · mainnet" in out


def test_corpus_connected_string_and_count():
    out = render_jinn_splash(_healthy_state(), truecolor=True)
    plain = _plain(out)
    assert "corpus         connected · 1,284,902 envelopes" in plain
    assert f"{_TC['green']}connected · 1,284,902 envelopes" in out


def test_corpus_unreachable_string_and_red():
    out = render_jinn_splash(_healthy_state(corpus="unreachable"), truecolor=True)
    assert "corpus         unreachable — retrying" in _plain(out)
    assert f"{_TC['red']}unreachable — retrying" in out


def test_corpus_checking_when_unresolved_is_dim():
    out = render_jinn_splash(_healthy_state(corpus=None), truecolor=True)
    assert "corpus         checking…" in _plain(out)
    assert f"{_TC['dim']}checking…" in out


def test_contribution_on_string_and_count():
    out = render_jinn_splash(_healthy_state(), truecolor=True)
    plain = _plain(out)
    assert "contribution   on · 1,284 traces published" in plain
    assert f"{_TC['green']}on · 1,284 traces published" in out


def test_contribution_off_reader_only_is_dim():
    out = render_jinn_splash(_healthy_state(contribution="off"), truecolor=True)
    plain = _plain(out)
    assert "contribution   off · reader only" in plain
    assert f"{_TC['dim']}off · reader only" in out


def test_node_running_string_and_vessel():
    out = render_jinn_splash(_healthy_state(), truecolor=True)
    plain = _plain(out)
    assert "node           running · vessel-0x91be…44a2" in plain
    assert f"{_TC['green']}running · vessel-0x91be…44a2" in out


def test_node_not_running_is_dim():
    out = render_jinn_splash(_healthy_state(node="not_running"), truecolor=True)
    assert "node           not running" in _plain(out)
    assert f"{_TC['dim']}not running" in out


def test_node_line_omitted_when_key_absent():
    # The fork has no local node concept (node operation is the separate mono
    # client daemon), so an absent node key omits the line entirely — same rule
    # as the pre-consent contribution line. A perpetual node "checking…" that
    # can never resolve would be misleading, so it must not render.
    state = _healthy_state()
    del state["node"]
    del state["node_vessel"]
    plain = _plain(render_jinn_splash(state, truecolor=True))
    assert "node" not in plain, plain
    # the other three lines still render
    for label in ("network", "corpus", "contribution"):
        assert f"\n     {label}" in plain


def test_node_omitted_in_fallback_too():
    state = _healthy_state()
    del state["node"]
    del state["node_vessel"]
    plain = _plain(render_jinn_splash(state, truecolor=False))
    assert "node" not in plain


# ── ordering + pre-consent omission ──────────────────────────────────────────


def test_status_lines_fixed_order():
    plain = _plain(render_jinn_splash(_healthy_state(), truecolor=True))
    order = [w for w in ("network", "corpus", "contribution", "node")]
    positions = [plain.index(f"\n     {label}") for label in order]
    assert positions == sorted(positions), plain


def test_pre_consent_omits_contribution_line_entirely():
    # Consent unset → contribution key absent → line must not appear at all.
    state = _healthy_state()
    del state["contribution"]
    del state["contribution_count"]
    plain = _plain(render_jinn_splash(state, truecolor=True))
    assert "contribution" not in plain, plain
    # the other three lines still render, in order
    for label in ("network", "corpus", "node"):
        assert f"\n     {label}" in plain


def test_pre_consent_omits_contribution_in_fallback_too():
    state = _healthy_state()
    del state["contribution"]
    del state["contribution_count"]
    plain = _plain(render_jinn_splash(state, truecolor=False))
    assert "contribution" not in plain


# ── gold appears exactly twice; update-available ─────────────────────────────


def test_gold_appears_exactly_twice_on_testnet():
    # centre point of the sigil + the version — nothing else.
    out = render_jinn_splash(_healthy_state(), truecolor=True)
    assert out.count(_TC["gold"]) == 2, _plain(out)


def test_gold_count_on_mainnet_is_three():
    # Mainnet is the one sanctioned exception to "gold exactly twice": the
    # design renders the `base · mainnet` network line gold (issue #1417 /
    # design 3.3). So mainnet legitimately carries three golds — sigil centre
    # point + version + network line — where testnet reserves gold to two.
    out = render_jinn_splash(
        _healthy_state(network="mainnet", network_label="mainnet"), truecolor=True
    )
    assert out.count(_TC["gold"]) == 3, _plain(out)


def test_gold_count_on_mainnet_update_available_is_two():
    # Update-available drops the version row to amber, so mainnet's three golds
    # fall to two (sigil centre point + network line); testnet would be one.
    out = render_jinn_splash(
        _healthy_state(
            network="mainnet", network_label="mainnet", update_available=True
        ),
        truecolor=True,
    )
    assert out.count(_TC["gold"]) == 2, _plain(out)
    assert out.count(_TC["amber"]) == 1


def test_update_available_renders_version_amber_with_annotation():
    out = render_jinn_splash(_healthy_state(update_available=True), truecolor=True)
    plain = _plain(out)
    assert "· update available" in plain
    # version row is amber, so gold drops to the single sigil centre point
    assert out.count(_TC["amber"]) == 1
    assert out.count(_TC["gold"]) == 1
    ver_row = [l for l in plain.split("\n") if "harness" in l][0]
    assert ver_row.strip() == "harness v0.4.2 · testnet · update available"


def test_version_string_format():
    plain = _plain(render_jinn_splash(_healthy_state(), truecolor=True))
    assert "harness v0.4.2 · testnet" in plain


# ── no emoji ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("truecolor", [True, False])
def test_no_emoji_any_state(truecolor):
    states = [
        _healthy_state(),
        _healthy_state(network="mainnet", network_label="mainnet"),
        _healthy_state(corpus="unreachable", node="not_running"),
        _healthy_state(corpus=None, node=None),
        _healthy_state(update_available=True),
    ]
    for s in states:
        plain = _plain(render_jinn_splash(s, truecolor=truecolor))
        hit = _EMOJI.search(plain)
        assert hit is None, f"emoji {hit.group(0)!r} in splash: {plain}"


# ── 80x24 ASCII fallback fit ─────────────────────────────────────────────────


def test_fallback_fits_80x24_with_all_status_lines():
    out = render_jinn_splash(_healthy_state(), truecolor=False)
    plain = _plain(out)
    lines = plain.split("\n")
    assert len(lines) <= 24, f"{len(lines)} rows > 24"
    assert max(len(l) for l in lines) <= 80, f"widest {max(len(l) for l in lines)} > 80"
    # all four status lines present in the fallback
    for label in ("network", "corpus", "contribution", "node"):
        assert label in plain


def test_fallback_uses_no_truecolor_escapes():
    out = render_jinn_splash(_healthy_state(), truecolor=False)
    assert "38;2;" not in out  # no 24-bit SGR in the 16-colour variant
    # uses basic-ANSI codes from the fallback palette
    assert _FB["sky"] in out and _FB["green"] in out


def test_fallback_avoids_middot_and_boxdrawing():
    out = render_jinn_splash(_healthy_state(), truecolor=False)
    plain = _plain(out)
    assert "·" not in plain  # fallback separator is ' * ', not the middot
    for glyph in ("╭", "─", "│", "╱", "╲"):
        assert glyph not in plain, glyph


# ── capability probe ─────────────────────────────────────────────────────────


def test_supports_truecolor_requires_colorterm(monkeypatch):
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setenv("COLORTERM", "truecolor")
    assert banner.supports_truecolor(columns=120) is True
    monkeypatch.delenv("COLORTERM", raising=False)
    assert banner.supports_truecolor(columns=120) is False


def test_supports_truecolor_falls_back_when_narrow(monkeypatch):
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setenv("COLORTERM", "truecolor")
    assert banner.supports_truecolor(columns=80) is False
    assert banner.supports_truecolor(columns=96) is True


def test_no_color_forces_fallback(monkeypatch):
    monkeypatch.setenv("COLORTERM", "truecolor")
    monkeypatch.setenv("NO_COLOR", "1")
    assert banner.supports_truecolor(columns=200) is False


# ── gather_splash_state wires real fork data ─────────────────────────────────


def test_gather_state_wires_version_and_network(monkeypatch):
    monkeypatch.delenv("JINN_NETWORK", raising=False)
    state = banner.gather_splash_state()
    assert state["version"].startswith("v")
    assert state["network"] == "testnet"  # default, no chain config in fork
    # corpus + node have no cheap sync source → left unresolved (checking…)
    assert "corpus" not in state
    assert "node" not in state


def test_gather_state_reads_jinn_network_env(monkeypatch):
    monkeypatch.setenv("JINN_NETWORK", "mainnet")
    assert banner.gather_splash_state()["network"] == "mainnet"
    monkeypatch.setenv("JINN_NETWORK", "nonsense")
    assert banner.gather_splash_state()["network"] == "testnet"  # invalid → testnet


def test_gather_state_contribution_follows_consent(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from plugins.jinn import consent

    # unset → contribution key absent (line omitted pre-consent)
    assert "contribution" not in banner.gather_splash_state()

    consent.save_state(consent.ACCEPTED)
    assert banner.gather_splash_state().get("contribution") == "on"

    consent.save_state(consent.DECLINED)
    assert banner.gather_splash_state().get("contribution") == "off"
