"""Task 10 — final acceptance gate for the de-hermes sweep.

G2 (no upstream brand on the main path): parametrised invocations of the
surfaces a user actually hits, plus an exhaustive scrape of every subcommand's
own `--help`.

G1 (coexistence): a stock hermes install must be unaffected by jinn-agent's
presence — asserted at the source level against the launcher contract.
"""
import os
import re
from pathlib import Path

import pytest

from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

MAIN_PATH_INVOCATIONS = [
    "--help", "--version", "status", "doctor", "config", "auth --help", "update --help",
]


@pytest.mark.parametrize("argline", MAIN_PATH_INVOCATIONS)
def test_main_path_surface_is_hermes_free(argline, tmp_path):
    assert_no_upstream_brand(run_cli(*argline.split(), home=str(tmp_path)))


def _subcommand_names(top_level_help: str) -> list[str]:
    """Extract the exact subcommand list from argparse's own choices set.

    argparse renders the positional-argument choices as a single
    ``{a,b,c,...}`` token right after ``positional arguments:`` (and again in
    the usage line). Scraping that set is exact — it comes straight from the
    parser's registered subparser names — whereas scraping the indented
    per-command help lines below it is fragile: some wrap across multiple
    lines (e.g. ``journey (learning, memory-graph)``), and the epilog's
    "Examples:" block contains indented lines that look like more of the
    same table (e.g. ``jinn-agent auth add <provider>    Add a pooled
    credential``) but aren't subcommands at all.
    """
    m = re.search(r"positional arguments:\n\s+\{([^}]+)\}", top_level_help)
    assert m, "could not find the positional-arguments choices set in --help output"
    return sorted(m.group(1).split(","))


def test_every_subcommand_help_is_hermes_free(tmp_path):
    top = run_cli("--help", home=str(tmp_path))
    subs = _subcommand_names(top)
    assert len(subs) > 50, f"scrape looks too small ({len(subs)}); parser surface may have changed"

    unreachable: dict[str, str] = {}
    for s in subs:
        out = run_cli(s, "--help", home=str(tmp_path))
        # Every subcommand in this CLI answers `--help` non-interactively
        # (verified across all currently-registered subcommands at the time
        # this test was written — none require a TTY or block on input for
        # --help specifically). If a future subcommand's --help does hang or
        # error, fail loudly here rather than silently skipping it: the
        # exclusion path below exists so we can still assert something, but
        # it is not a way to quietly drop coverage.
        if not out.strip():
            unreachable[s] = "empty output"
            continue
        try:
            assert_no_upstream_brand(out)
        except AssertionError as e:
            raise AssertionError(f"subcommand {s!r} --help leaked brand: {e}") from e

    # Fallback path for any subcommand whose --help could not be exercised
    # this way (documented per-case, not a silent catch-all): fall back to
    # asserting on the registered description/help string in source.
    for s, reason in unreachable.items():
        raise AssertionError(
            f"subcommand {s!r} --help was unreachable ({reason}); add a "
            f"source-level assertion here against its description= string "
            f"instead of silently excluding it"
        )


def test_coexistence_default_home_is_isolated(tmp_path, monkeypatch):
    # jinn-agent must default to ~/.jinn-agent, never ~/.hermes, when neither
    # env var is set — a stock hermes install (~/.hermes) must never be
    # touched just because jinn-agent is also installed on the same machine.
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.delenv("JINN_AGENT_HOME", raising=False)
    launcher = Path(__file__).resolve().parents[2] / "bin" / "jinn-agent"
    text = launcher.read_text()
    assert ".jinn-agent" in text and "JINN_AGENT_HOME" in text  # isolation contract intact
    # The default-home line must derive from JINN_AGENT_HOME (falling back to
    # ~/.jinn-agent), not unconditionally alias to $HOME/.hermes.
    assert re.search(r'HERMES_HOME="\$\{JINN_AGENT_HOME:-\$HOME/\.jinn-agent\}"', text), (
        "launcher must default HERMES_HOME to $JINN_AGENT_HOME or ~/.jinn-agent, "
        "never unconditionally to ~/.hermes"
    )
