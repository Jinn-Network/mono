"""Shared ANSI styling for the Jinn-layer TUI surfaces (consent + ledger).

Reuses the #1417 splash palette and colour idiom (``hermes_cli.banner``) so
consent and the ledger match the splash chrome exactly — same sky/gold/dim
tokens, same truecolor→16-colour fallback, same softened-brutalist box.

Rendering is pure ANSI strings (no Rich, no prompt_toolkit) so every surface
is trivially snapshot-testable — the #1417 discipline. ``NO_COLOR`` and the
truecolor probe both defer to ``banner``.

The box idiom mirrors the design artifact's ``boxTop/boxMid/boxBot/boxLine``:
a titled top/mid rule and content lines padded to a fixed inner width, drawn
in sky. Softened-brutalist corners (``╭ ╮ ╰ ╯``) match the splash sigil.
"""

from __future__ import annotations

import re
from typing import List, Optional, Sequence, Tuple

from hermes_cli.banner import _FB, _RST, _TC, supports_truecolor

__all__ = [
    "palette",
    "wrap",
    "box_top",
    "box_mid",
    "box_bot",
    "box_line",
    "no_color",
    "sanitise",
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
