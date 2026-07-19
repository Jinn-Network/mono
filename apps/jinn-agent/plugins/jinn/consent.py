"""Consent state + first-run flow for the Jinn layer.

There is exactly ONE contribution-consent question: may a task derived from
your work be shared so other agents can attempt it. It persists a single
boolean, ``shareConsent`` (default ``False`` — bare Enter declines). Local
capture, mining, and distillation happen unconditionally and are never gated
on this flag; the flag governs only whether a mined task leaves the machine.
Preview remains informational, while per-session veto and the ledger remain
available on top.

Copy is the single sharing question from mono#1714: plain language, no
"trace/mining/corpus" jargon, and it never claims your code or history is
shared.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Optional

logger = logging.getLogger(__name__)

from . import harness as _harness

try:
    from hermes_constants import get_hermes_home
except Exception:  # pragma: no cover — plugin may load before constants resolves

    def get_hermes_home() -> Path:  # type: ignore[no-redef]
        val = (os.environ.get("HERMES_HOME") or "").strip()
        return Path(val).resolve() if val else (Path.home() / ".hermes").resolve()


# ── Exact copy (mono#1714 single sharing question) ───────────────────────────

HEADER = "Contribute tasks from your work?"

BODY = (
    "When you solve something on a public project, Jinn can turn it into a "
    "task other agents can attempt — a reproducible problem based on your "
    "work. Your actual code and history stay on your machine."
)

KEYS = "[Y] Yes · [N] No"
EITHER_WAY = "Jinn works fully either way."

CONFIRM_ACCEPT = (
    "Share tasks from your work? A reproducible problem based on your work "
    "may be shared for other agents to attempt. Your actual code and history "
    "stay on your machine. You can turn this off any time. [Y] Yes · [N] No"
)
CONFIRM_DECLINE = (
    "Keep everything on your machine? Nothing derived from your work will be "
    "shared. Jinn stays fully functional. [Y] Yes · [N] No"
)
RECORDED_ON = (
    "Sharing is ON. A reproducible problem based on your work may be shared "
    "for other agents to attempt. Run /jinn preview to see a labelled example "
    "of what may be shared."
)
RECORDED_OFF = (
    "Sharing is OFF. Nothing derived from your work leaves this machine. "
    "Turn on any time: /jinn consent"
)

KEYS_LINE = "[Y] Yes · [N] No · [P] Preview what would be shared · [?] Docs"

# Current-state line shown above the pitch, so /jinn consent always tells the
# operator where they stand before re-pitching (mono#1384).
STATE_LINE_ON = "Sharing is currently ON."
STATE_LINE_OFF = "Sharing is currently OFF."

# The slash-command surface (TUI-safe: no blocking reads — see run_consent_flow's
# docstring). Same deliberate two-step as the keyboard flow.
COMMANDS_LINE = (
    "Yes: /jinn consent accept · No: /jinn consent decline · "
    "Preview what would be shared: /jinn preview · Docs: docs.jinn.network/harness"
)


# ── State store ──────────────────────────────────────────────────────────────

def state_path() -> Path:
    return get_hermes_home() / "jinn" / "consent.json"


def _migrate_legacy(data: Dict[str, object]) -> Optional[bool]:
    """Derive shareConsent from legacy fields (read-then-drop, one release).

    Only the old *publish* bit ever meant "a task may leave this machine";
    the tier-1 retention bit is discarded (retention is now unconditional).
    Returns the derived value, or None when the file carries no legacy keys.
    """
    if "publishMinedTasksConsent" in data or "status" in data:
        return bool(data.get("publishMinedTasksConsent"))
    return None


def load_state() -> Dict[str, object]:
    path = state_path()
    if not path.exists():
        return {"shareConsent": False, "previewed": False}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("jinn: unreadable consent state at %s — treating as unset", path)
        return {"shareConsent": False, "previewed": False}
    if not isinstance(data, dict):
        return {"shareConsent": False, "previewed": False}
    if "shareConsent" in data:
        share = bool(data.get("shareConsent"))
    else:
        migrated = _migrate_legacy(data)
        share = bool(migrated) if migrated is not None else False
    return {"shareConsent": share, "previewed": bool(data.get("previewed", False))}


def save_state(share: bool, *, previewed: Optional[bool] = None) -> Dict[str, object]:
    current = load_state()
    state: Dict[str, object] = {
        "shareConsent": bool(share),
        "previewed": bool(current.get("previewed") if previewed is None else previewed),
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    }
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    return state


def mark_previewed() -> None:
    current = load_state()
    save_state(bool(current.get("shareConsent")), previewed=True)


def share_enabled() -> bool:
    """True only when the operator explicitly opted into sharing."""
    return load_state().get("shareConsent") is True


def consent_decided() -> bool:
    """True once the operator has recorded a decision (either way)."""
    return state_path().exists()


# ── The flow ─────────────────────────────────────────────────────────────────

def state_line() -> str:
    return STATE_LINE_ON if share_enabled() else STATE_LINE_OFF


def _sigil_head_plain() -> str:
    """Plain (NO_COLOR) sigil head carrying fork identity — the configured
    harness name, and on a fork the upstream it forked from. Mirrors the styled
    ``_sigil_head`` so the plain explainer keeps the same fork identity; the
    single-question copy collapse (mono#1714) must not drop it, since headless
    forks re-skin by name (test_jinn_harness_identity).
    """
    suffix = "  ·  first run" + ("  ·  fork of hermes-agent" if _harness.is_fork() else "")
    return f"◇ {_harness.harness_name()}{suffix}"


def render_explainer(keys_line: str = KEYS_LINE) -> str:
    """Plain-text explainer (NO_COLOR / tests / blocking-terminal path).

    The single sharing question. The styled TUI variant is
    ``render_explainer_styled``; both open with the fork-identity sigil head
    and carry the same sharing copy.
    """
    lines = [
        state_line(),
        "",
        _sigil_head_plain(),
        "",
        HEADER,
        "",
        BODY,
        "",
        f"{KEYS} — {EITHER_WAY}",
        "",
        keys_line,
    ]
    return "\n".join(lines)


def confirm_accept_command() -> str:
    return CONFIRM_ACCEPT.replace("[Y] Yes · [N] No", "To confirm: /jinn consent accept confirm")


def confirm_decline_command() -> str:
    return CONFIRM_DECLINE.replace("[Y] Yes · [N] No", "To confirm: /jinn consent decline confirm")


def record_accept() -> str:
    save_state(True)
    return RECORDED_ON


def record_decline() -> str:
    save_state(False)
    return RECORDED_OFF


def run_consent_flow(
    input_fn: Callable[[str], str],
    print_fn: Callable[[str], None],
    preview_fn: Optional[Callable[[], None]] = None,
) -> bool:
    """The first-run consent flow for a PLAIN TERMINAL (blocking reads).

    Do NOT call from a TUI slash-command handler — ``input()`` blocks on
    stdin the TUI owns and deadlocks the session (first cold-clone dogfood
    finding, 2026-07-03). The slash surface uses the stateless
    ``/jinn consent accept|decline [confirm]`` commands instead.

    Returns the recorded shareConsent (True when sharing was accepted).

    Per-action lifecycle ``idle -> confirming -> recorded``. Bare Enter
    defaults to decline — the safe default shares nothing. This is the ONE
    sharing question (mono#1714 copy collapse) — no second, unrelated
    question follows it.
    """
    print_fn(render_explainer_styled())
    while True:
        choice = input_fn("> ").strip().lower()
        if choice == "p":
            # Preview is reachable before any share. A real preview when
            # preview_fn is wired; otherwise the labelled example fixture
            # (fresh machine).
            if preview_fn is not None:
                preview_fn()
            else:
                print_fn(render_preview_example())
            print_fn("[Y] Yes · [B] Back")
            continue
        if choice == "?":
            print_fn(render_docs_styled())
            continue
        if choice in ("a", "y"):
            print_fn(render_confirm_styled(accept=True))
            confirm = input_fn("> ").strip().lower()
            if confirm == "y":
                save_state(True)
                print_fn(render_recorded_styled(on=True))
                break
            continue
        # Bare Enter, 'n', 'd', or anything unrecognised routes to decline —
        # but decline still takes one deliberate confirmation.
        print_fn(render_confirm_styled(accept=False))
        confirm = input_fn("> ").strip().lower()
        if confirm == "y":
            save_state(False)
            print_fn(render_recorded_styled(on=False))
            break

    return share_enabled()


# ── Styled renderers — reuse the #1417 splash palette ────────────────────────
#
# Pure ANSI strings, snapshot-testable, NO_COLOR-safe (style.palette yields
# empty codes). Each carries the same visible text as its plain constant, so
# both surfaces stay in copy-lockstep. The sigil header matches the splash's
# softened-brutalist chrome.

from . import style as _style  # noqa: E402  (kept local to the render section)


def _sigil_head(pal, rst: str) -> str:
    suffix = "  ·  first run" + ("  ·  fork of hermes-agent" if _harness.is_fork() else "")
    return (
        _style.wrap(pal, rst, "sky", "◇")
        + " "
        + _style.wrap(pal, rst, "fg", _harness.harness_name())
        + _style.wrap(pal, rst, "dim", suffix)
    )


def _rule(pal, rst: str, n: int = 66) -> str:
    return _style.wrap(pal, rst, "dim", "─" * n)


def render_explainer_styled() -> str:
    """The single sharing question, styled. Plain language; default decline."""
    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    amber = lambda s: _style.wrap(pal, rst, "amber", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)

    out = [
        _sigil_head(pal, rst),
        "",
        fg("  " + HEADER),
        "",
        dim("  " + BODY),
        "",
        dim("  " + EITHER_WAY),
        "",
        _rule(pal, rst),
        "  " + kbd("[Y]") + fg(" Yes, share tasks") + "      " + kbd("[P]") + fg(" Preview what would be shared"),
        "  " + kbd("[N]") + dim(" No · keep everything local") + "      " + kbd("[?]") + dim(" Docs"),
        "",
        dim("  sharing: ") + amber("ON" if share_enabled() else "OFF") + dim("   ·   default is no"),
    ]
    return "\n".join(out)


def render_docs_styled() -> str:
    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    amber = lambda s: _style.wrap(pal, rst, "amber", s)
    return "\n".join([
        _sigil_head(pal, rst),
        "",
        gold("  DOCS"),
        dim("  Full detail on what a shared task is, how provenance is blinded,"),
        dim("  and what stays on your machine:"),
        "",
        "  " + sky("docs.jinn.network/harness") + dim("   — sharing, safety, and how it works"),
        "",
        dim("  Nothing has been decided. Sharing is ") + amber("OFF") + dim("."),
    ])


def render_confirm_styled(accept: bool) -> str:
    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    amber = lambda s: _style.wrap(pal, rst, "amber", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)
    if accept:
        body = [
            fg("  Share tasks from your work?"),
            "",
            dim("  A reproducible problem based on your work may be shared for other"),
            dim("  agents to attempt. Your actual code and history stay on your machine."),
            dim("  You can turn this off any time."),
            "",
            "  " + kbd("[Y]") + fg(" Yes, share") + "     " + kbd("[N]") + dim(" No, go back"),
        ]
    else:
        body = [
            fg("  Keep everything on your machine?"),
            "",
            dim("  Nothing derived from your work will be shared. Jinn stays fully"),
            dim("  functional."),
            "",
            "  " + kbd("[Y]") + fg(" Yes, keep local") + "     " + kbd("[N]") + dim(" No, go back"),
        ]
    return "\n".join([
        _sigil_head(pal, rst), "", gold("  CONFIRM"), "",
        *body, "",
        dim("  sharing: ") + amber("OFF") + dim("  →  action: ") + gold("confirming"),
    ])


def render_recorded_styled(on: bool) -> str:
    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    green = lambda s: _style.wrap(pal, rst, "green", s)
    if on:
        body = [
            green("  recorded") + dim(" — sharing is ") + green("ON"),
            "",
            dim("  " + RECORDED_ON),
            "",
            dim("  Manage:  ") + sky("/jinn veto"),
        ]
    else:
        body = [
            sky("  recorded") + dim(" — sharing is ") + fg("OFF"),
            "",
            dim("  " + RECORDED_OFF),
        ]
    return "\n".join([_sigil_head(pal, rst), "", *body])


def render_preview_example() -> str:
    """A labelled example of a shared task for a fresh machine with no task run
    yet. Real previews go through jinn-layer; this is the fallback so ``P`` is
    reachable before any task exists. Every field is marked ``example`` so it
    can never be mistaken for a real shared task."""
    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    iw = 60
    bt = lambda title="": _style.box_top(pal, rst, iw, title)
    bm = lambda title="": _style.box_mid(pal, rst, iw, title)
    bb = lambda: _style.box_bot(pal, rst, iw)
    bl = lambda segs: _style.box_line(pal, rst, iw, segs)
    box = "\n".join([
        bt("example — no task run yet"),
        bl([("task        ", None), ("(example) fix flaky retry in http client", "fg")]),
        bl([("repo        ", None), ("acme/http @ a1b2c3d (public)", "fg")]),
        bl([("problem     ", None), ("the retry loop drops the 429 backoff", "dim")]),
        bl([("check       ", None), ("suite green after fix", "green")]),
        bm("stays on your machine — never shared"),
        bl([("  your code and history", "dim")]),
        bb(),
    ])
    return "\n".join([
        _sigil_head(pal, rst),
        "",
        gold("  PREVIEW — NOTHING IS SHARED FROM THIS SCREEN"),
        dim("  This is an example: no task has run on this machine yet."),
        dim("  After your first task, /jinn preview shows the real reproducible"),
        dim("  problem that would be shared — the whole thing, before anything leaves."),
        "",
        box,
        "",
        dim("  Everything inside the box is what would be shared. Your code and"),
        dim("  history stay on your machine."),
    ])
