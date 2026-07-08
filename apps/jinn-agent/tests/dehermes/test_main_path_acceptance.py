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


def _subcommand_names(help_text: str) -> list[str]:
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

    Returns an empty list (not an error) when there is no nested choices
    block — that's the normal, expected shape for a depth-1 subcommand with
    no children (e.g. ``doctor --help``, ``status --help``), and callers at
    depth 2 rely on that to mean "nothing further to descend into".

    Some subparsers are registered with an explicit ``metavar=`` (e.g.
    ``checkpoints``, which uses ``metavar="COMMAND"`` in
    ``hermes_cli/checkpoints.py``) precisely to suppress the ugly
    ``{status,list,prune,...}`` braces from the usage line. argparse honours
    that by rendering the *metavar* instead of the choices set everywhere,
    including under ``positional arguments:`` — so there is no ``{...}``
    block to scrape at all, even though the subparser has children. Falling
    through to "no children" here would silently exclude every command
    registered this way from the gate. Instead, fall back to scraping the
    indented command listing itself: each child is a 4-space-indented,
    first-column token directly under ``positional arguments:`` (the same
    table argparse prints either way), terminated by the next unindented
    section header (``options:`` and friends) or end of text.
    """
    m = re.search(r"positional arguments:\n\s+\{([^}]+)\}", help_text)
    if m:
        return sorted(m.group(1).split(","))

    m = re.search(r"positional arguments:\n(.*?)(?:\n\S|\Z)", help_text, re.S)
    if not m:
        return []
    names = re.findall(r"^ {4}([A-Za-z][\w-]*)", m.group(1), re.M)
    return sorted(names)


def test_every_subcommand_help_is_hermes_free(tmp_path):
    top = run_cli("--help", home=str(tmp_path))
    subs = _subcommand_names(top)
    assert len(subs) > 50, f"scrape looks too small ({len(subs)}); parser surface may have changed"

    unreachable: dict[str, str] = {}
    checked_depth2 = 0
    checkpoints_children_seen = 0
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
            unreachable[(s,)] = "empty output"
            continue
        try:
            assert_no_upstream_brand(out)
        except AssertionError as e:
            raise AssertionError(f"subcommand {s!r} --help leaked brand: {e}") from e

        # Recurse one level: a depth-1 subcommand's --help only shows each
        # child's one-line `help=` blurb, never its full `description=` or
        # its own nested flags/epilog — brand leaks live in exactly that
        # untested text (this is precisely how the review's 17 depth-2
        # leaks escaped the original depth-1-only gate). Bound at depth 2:
        # only recurse where a nested `{a,b,...}` choices block is actually
        # present (grandchildren, e.g. `skills snapshot export`, are out of
        # scope for this gate — the brief bounds depth at 2).
        children = _subcommand_names(out)
        if s == "checkpoints":
            checkpoints_children_seen = len(children)
        for c in children:
            checked_depth2 += 1
            child_out = run_cli(s, c, "--help", home=str(tmp_path))
            if not child_out.strip():
                unreachable[(s, c)] = "empty output"
                continue
            try:
                assert_no_upstream_brand(child_out)
            except AssertionError as e:
                raise AssertionError(
                    f"subcommand {s!r} {c!r} --help leaked brand: {e}"
                ) from e

    assert checked_depth2 > 0, (
        "no depth-2 nested subcommands were found to probe; the recursive "
        "scrape may be broken (parser surface may have changed shape)"
    )

    # `checkpoints` registers its subparsers with metavar="COMMAND"
    # (hermes_cli/checkpoints.py), which suppresses the {a,b,...} choices
    # block that _subcommand_names() normally scrapes and forces it onto
    # the indented-listing fallback path instead. Pin the exact count so
    # a future metavar-suppressed parser (or a change to checkpoints'
    # own children) that silently drops back to 0 gets caught here rather
    # than passing quietly.
    assert checkpoints_children_seen == 5, (
        f"expected checkpoints to contribute exactly 5 children "
        f"(status, list, prune, clear, clear-legacy), got "
        f"{checkpoints_children_seen}; the metavar-suppressed-parser "
        f"fallback scrape may have regressed"
    )

    # Fallback path for any subcommand whose --help could not be exercised
    # this way (documented per-case, not a silent catch-all): fall back to
    # asserting on the registered description/help string in source.
    for path, reason in unreachable.items():
        raise AssertionError(
            f"subcommand {' '.join(path)!r} --help was unreachable ({reason}); "
            f"add a source-level assertion here against its description= "
            f"string instead of silently excluding it"
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
