"""The visible moments: the corpus line, the honest empty state, the doctor render."""

from __future__ import annotations

import importlib

view = importlib.import_module("jinn_plugin.view")


def test_the_corpus_line_names_the_count_and_the_terms():
    line = view.corpus_line(["flaky", "vitest"], 2)
    assert view.MARKER in line
    assert "provided 2 evidence packets" in line
    assert "searched: flaky, vitest" in line


def test_the_corpus_line_is_singular_for_one_packet():
    assert "provided 1 evidence packet " in view.corpus_line(["a"], 1) + " "


def test_the_empty_state_is_honest_and_never_apologetic():
    line = view.empty_line(["obscure", "thing"])
    assert view.MARKER in line
    assert "searched 2 terms" in line
    assert "nothing relevant yet" in line
    for forbidden in ("sorry", "unfortunately", "failed"):
        assert forbidden not in line.lower()


def test_terms_are_sanitised_at_this_boundary():
    line = view.corpus_line(["ok", "bad\x1b[31mred"], 1)
    assert "\x1b" not in line
    assert "badred" in line


def test_the_line_carries_no_ansi_ever():
    assert "\x1b" not in view.corpus_line(["a"], 1)
    assert "\x1b" not in view.empty_line(["a"])


def healthy(name="a", detail="fine"):
    return {"name": name, "ok": True, "detail": detail, "remedy": None}


def failed(name, detail, remedy):
    return {"name": name, "ok": False, "detail": detail, "remedy": remedy}


def test_fail_lines_are_two_lines_naming_the_remedy():
    lines = view.fail_lines(failed("runtime-available", "not installed", "hermes plugins update jinn"))
    assert lines == [
        "[fail] runtime-available: not installed",
        "       remedy: hermes plugins update jinn",
    ]


def test_a_failed_check_with_no_remedy_names_the_channel_outage_not_a_no_op_command():
    lines = view.fail_lines(failed("runtime-available", "npm cannot supply 0.1.0", None))
    assert lines[1].strip() == "not fixable from this machine - channel issue"
    assert "hermes" not in lines[1]


def test_render_checks_summarises_and_counts_failures():
    rendered = view.render_checks([healthy(), failed("b", "broken", "fix it")])
    assert "[ok  ] a: fine" in rendered
    assert "[fail] b: broken" in rendered
    assert "1 check failed." in rendered


def test_render_checks_says_so_when_everything_passes():
    assert "all checks passed." in view.render_checks([healthy()])


def test_render_checks_ends_with_the_host_provider_pointer():
    rendered = view.render_checks([healthy()])
    assert rendered.strip().endswith(view.HOST_PROVIDER_POINTER)
    assert "hermes doctor" in view.HOST_PROVIDER_POINTER


def test_the_pointer_is_not_a_check_row():
    rendered = view.render_checks([healthy()])
    assert "[ok  ] host-provider" not in rendered


def test_green_checks_render_their_detail_not_just_their_name():
    rendered = view.render_checks(
        [healthy("corpus-chain-verification", "mirroring without announcement-chain verification")]
    )
    assert "mirroring without announcement-chain verification" in rendered


def test_the_first_session_banner_leads_with_the_verdict():
    banner = view.first_session_banner([healthy()])
    assert banner[0].startswith("jinn ready")
    assert any(view.MARKER in line for line in banner)
    assert any("/jinn doctor" in line for line in banner)


def test_the_first_session_banner_leads_with_the_first_failure():
    banner = view.first_session_banner([healthy(), failed("b", "broken", "fix it")])
    assert banner[0] == "[fail] b: broken"
    assert banner[1].strip() == "remedy: fix it"
