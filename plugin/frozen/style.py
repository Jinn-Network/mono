"""Shared ANSI styling for the Jinn-layer TUI surfaces (consent + ledger).

Mirrors the #1417 splash palette and colour idiom — the tokens and the
truecolor probe are vendored from ``hermes_cli.banner`` below (that module's
palette symbols are fork-only, so importing them broke plugin load on a stock
host) — so consent and the ledger match the splash chrome exactly: same
sky/gold/dim tokens, same truecolor→16-colour fallback, same softened-brutalist
box.

Rendering is pure ANSI strings (no Rich, no prompt_toolkit) so every surface
is trivially snapshot-testable — the #1417 discipline. ``NO_COLOR`` and the
truecolor probe use the vendored copy below.

The box idiom mirrors the design artifact's ``boxTop/boxMid/boxBot/boxLine``:
a titled top/mid rule and content lines padded to a fixed inner width, drawn
in sky. Softened-brutalist corners (``╭ ╮ ╰ ╯``) match the splash sigil.
"""

from __future__ import annotations

import re
from typing import List, Optional, Sequence, Tuple

import os
import shutil

# ── Vendored palette (was hermes_cli.banner; those symbols are fork-only and
# absent on a stock host — importing them broke plugin load on stock Hermes).
# Values copied verbatim from the fork banner so the fork's look is unchanged.
_RST = "\033[0m"
_TC = {
    "sky": "\033[38;2;122;167;220m",
    "gold": "\033[38;2;220;184;102m",
    "dim": "\033[38;2;107;123;149m",
    "green": "\033[38;2;123;176;162m",
    "amber": "\033[38;2;207;154;63m",
    "red": "\033[38;2;192;112;112m",
    "fg": "\033[38;2;214;224;240m",
}
_FB = {
    "sky": "\033[36m",
    "gold": "\033[93m",
    "dim": "\033[90m",
    "green": "\033[32m",
    "amber": "\033[33m",
    "red": "\033[31m",
    "fg": "\033[97m",
}


def supports_truecolor(columns=None) -> bool:
    """Truecolor line-art vs 16-colour fallback. NO_COLOR forces fallback;
    needs COLORTERM=truecolor/24bit and >= 96 columns. Vendored from banner."""
    if os.environ.get("NO_COLOR"):
        return False
    colorterm = (os.environ.get("COLORTERM") or "").strip().lower()
    if colorterm not in ("truecolor", "24bit"):
        return False
    if columns is None:
        env_cols = os.environ.get("COLUMNS")
        if env_cols and env_cols.isdigit():
            columns = int(env_cols)
        else:
            try:
                columns = shutil.get_terminal_size().columns
            except Exception:
                columns = 80
    return columns >= 96

__all__ = [
    "palette",
    "wrap",
    "box_top",
    "box_mid",
    "box_bot",
    "box_line",
    "no_color",
    "sanitise",
    "strip_ansi",
]


# Strip C0/C1 control chars (incl. ESC, CR, LF, DEL) from any layer- or
# corpus-supplied field before it reaches the terminal: a value carrying
# \x1b/\r/newline would otherwise pass raw ANSI to the terminal (screen
# manipulation, output spoofing) and desync len()-based column padding.
# The corpus is PUBLIC and rows may be cross-operator, so every render
# boundary that interpolates dynamic fields sanitises unconditionally.
_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def sanitise(s: str) -> str:
    return _CTRL.sub("", s)


# Strip complete ANSI/CSI escape sequences (SGR colour codes, incl. the
# truecolor `\033[38;2;r;g;bm` form this module emits, and resets) rather
# than the lone ESC byte: `sanitise` above removes `\x1b` but leaves the
# rest of a sequence — `[38;2;122;167;220m` — behind as literal text. That
# half-strip is exactly the `?[38;2;…m` noise mono issue #1798 reported:
# prompt_toolkit's `patch_stdout` proxies the TUI's stderr channel and
# renders the orphaned ESC byte as `?` without interpreting the sequence
# that follows it. Channels that must render plain regardless of the active
# palette (`_user_line` in __init__.py, the pickup evidence-signal sink)
# strip with this before printing. Mirrors the CSI pattern already used
# privately in history_view.py.
_ANSI_SEQUENCE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def strip_ansi(text: str) -> str:
    return _ANSI_SEQUENCE.sub("", text)


def no_color() -> bool:
    """True when colour is suppressed (NO_COLOR or non-truecolor terminal).

    Falls back to the 16-colour palette rather than stripping colour entirely;
    only a hard ``NO_COLOR`` yields empty codes (handled by ``palette``).
    """
    import os

    return bool(os.environ.get("NO_COLOR"))


def palette(truecolor: Optional[bool] = None):
    """Return the active colour map + reset.

    ``truecolor=None`` probes the terminal via ``banner.supports_truecolor``.
    Under ``NO_COLOR`` every token is the empty string (plain text).
    """
    if no_color():
        empty = {k: "" for k in _TC}
        return empty, ""
    tc = supports_truecolor() if truecolor is None else truecolor
    return (_TC if tc else _FB), _RST


def wrap(pal, rst: str, cls: str, text: str) -> str:
    return f"{pal[cls]}{text}{rst}"


# ── Softened-brutalist box (design boxTop/boxMid/boxBot/boxLine) ──────────────
# inner content width = IW; total line = IW + 4 (│␣ … ␣│).

def box_top(pal, rst: str, iw: int, title: str = "") -> str:
    sky = pal["sky"]
    if not title:
        return f"{sky}╭{'─' * (iw + 2)}╮{rst}"
    t = f" {title} "
    return f"{sky}╭─{t}{'─' * max(0, iw + 1 - len(t))}╮{rst}"


def box_mid(pal, rst: str, iw: int, title: str = "") -> str:
    sky = pal["sky"]
    if not title:
        return f"{sky}├{'─' * (iw + 2)}┤{rst}"
    t = f" {title} "
    return f"{sky}├─{t}{'─' * max(0, iw + 1 - len(t))}┤{rst}"


def box_bot(pal, rst: str, iw: int) -> str:
    sky = pal["sky"]
    return f"{sky}╰{'─' * (iw + 2)}╯{rst}"


def box_line(pal, rst: str, iw: int, segs: Sequence[Tuple[str, Optional[str]]]) -> str:
    """Render one boxed content line. ``segs`` is ``[(text, cls|None), …]``.

    The visible text is padded to ``iw``; colour is applied per segment.
    """
    raw = "".join(s[0] for s in segs)
    pad = " " * max(0, iw - len(raw))
    sky = pal["sky"]
    body = "".join(wrap(pal, rst, s[1], s[0]) if s[1] else s[0] for s in segs)
    return f"{sky}│ {rst}{body}{pad}{sky} │{rst}"
