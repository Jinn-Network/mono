"""Everything the user sees.

Plain text, no ANSI: the host's user-line channel proxies stderr through
prompt_toolkit's patch_stdout, which renders raw escape bytes as noise rather
than interpreting them (mono #1798). One module owns every rendered string so
the product's voice has a single source.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Sequence

MARKER = "◇ corpus"

_CONTROL = re.compile("[" + "".join(chr(code) for code in list(range(0, 9)) + [11, 12] + list(range(14, 32)) + [127]) + "]")
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

_NOT_FIXABLE = "not fixable from this machine - channel issue"

# Provider and credential sanity is the host's, and the answer is identical on
# every install - so it is a pointer, not a check (C5 finding F9: a fact that is
# the same everywhere is a release note, not a health check).
HOST_PROVIDER_POINTER = "provider and credential sanity is owned by the host - run: hermes doctor"


def sanitise(value: str) -> str:
    """Strip control characters at the render boundary.

    Search terms derive from the session's own message, but a corpus record's
    metadata does not, and this module renders both. Sanitising unconditionally
    is cheaper than tracking which caller is trustworthy.
    """
    return _CONTROL.sub("", _ANSI.sub("", str(value)))


def corpus_line(terms: Sequence[str], provided_count: int) -> str:
    noun = "packet" if provided_count == 1 else "packets"
    joined = ", ".join(sanitise(term) for term in terms)
    return f"  {MARKER}  provided {provided_count} evidence {noun}  .  searched: {joined}"


def empty_line(terms: Sequence[str]) -> str:
    """The designed empty state: the mechanism is visible even with no result."""
    return f"  {MARKER}  searched {len(terms)} terms  .  nothing relevant yet"


def fail_lines(check: Dict[str, Any]) -> List[str]:
    """Two lines: what broke, and the one command that fixes it.

    A ``remedy`` of ``None`` is the spec 9.3 state - broken, and no action of
    the reader's fixes it. Printing a command there would send someone round a
    loop that cannot close, so the second line says so instead.
    """
    remedy = check.get("remedy")
    second = f"       remedy: {remedy}" if remedy else f"       {_NOT_FIXABLE}"
    return [f"[fail] {check['name']}: {sanitise(str(check['detail']))}", second]


def render_checks(checks: Sequence[Dict[str, Any]]) -> str:
    """Every check, then the summary, then the host pointer.

    Green rows render their ``detail``, never the name alone: a check that is
    green *because the operator chose a posture* carries its whole meaning in
    that sentence.
    """
    lines: List[str] = []
    failures = 0
    for check in checks:
        if check.get("ok"):
            lines.append(f"[ok  ] {check['name']}: {sanitise(str(check['detail']))}")
        else:
            failures += 1
            lines.extend(fail_lines(check))
    if failures == 0:
        lines.append("all checks passed.")
    else:
        lines.append(f"{failures} check{'s' if failures != 1 else ''} failed.")
    lines.append(HOST_PROVIDER_POINTER)
    return "\n".join(lines)


def first_session_banner(checks: Sequence[Dict[str, Any]]) -> List[str]:
    """Three lines, once per install: the verdict, the moment, the commands."""
    failing = [check for check in checks if not check.get("ok")]
    verdict = fail_lines(failing[0]) if failing else [f"jinn ready - {len(checks)} checks passed"]
    return [
        *verdict,
        f'when your first message matches prior evidence you will see a "{MARKER}" line'
        " - silence means nothing relevant yet",
        "commands: /jinn - re-check: /jinn doctor",
    ]
