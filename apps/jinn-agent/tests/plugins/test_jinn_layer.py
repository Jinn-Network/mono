"""jinn-layer wrapper argv tests (Jinn-Network/mono#1420).

The splash corpus reachability+count read depends on ``corpus_search``
emitting ``--limit`` and ``--json``. These assert the exact argv the wrapper
hands the runner (a fake callable capturing the full argv, ``binary()`` at
index 0).
"""

from __future__ import annotations

from plugins.jinn import jinn_layer


def test_corpus_search_emits_limit_and_json_flags():
    captured = []

    def runner(argv):
        captured.append(argv)
        return 0, "[]"

    code, out = jinn_layer.corpus_search("", limit=500, as_json=True, runner=runner)
    assert code == 0
    assert out == "[]"
    assert captured[0][1:] == ["corpus", "search", "", "--limit", "500", "--json"]


def test_corpus_search_query_only_default_still_json():
    captured = []

    def runner(argv):
        captured.append(argv)
        return 0, "[]"

    jinn_layer.corpus_search("tdd", runner=runner)
    assert captured[0][1:] == ["corpus", "search", "tdd", "--limit", "500", "--json"]


def test_corpus_search_no_json_omits_flag():
    captured = []

    def runner(argv):
        captured.append(argv)
        return 0, ""

    jinn_layer.corpus_search("q", as_json=False, runner=runner)
    assert captured[0][1:] == ["corpus", "search", "q", "--limit", "500"]
