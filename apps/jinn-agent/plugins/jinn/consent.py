"""Consent state + first-run flow for the Jinn layer.

Consent is a three-value machine: ``unset -> accepted | declined``.
``unset`` and ``declined`` behave identically at capture time — nothing
leaves the machine. The safe default (bare Enter) is decline.

Copy is verbatim from the design artifact
(mono: docs/design/artifacts/2026-07-02-1312-fork-consent-ledger/):
plain language wherever data leaves the machine, no emoji, no metaphor.
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


UNSET = "unset"
ACCEPTED = "accepted"
DECLINED = "declined"

# ── Exact copy (design artifact) ─────────────────────────────────────────────

def opening() -> str:
    return (
        f"{_harness.harness_name()} is an open coding harness. When it finishes a "
        "task it can publish a scrubbed trace of that task to a public corpus — "
        "the shared record that trains the harness everyone runs."
    )

WHY = [
    "Build the open harness — your tasks improve the agent no one company owns.",
    "Earn rewards — verified contributions earn OLAS.",
    "Two-way — you read from the same corpus you feed.",
]

WHAT_LEAVES = [
    "Only traces of tasks this harness runs — never your machine, shell, files, "
    "or anything outside a task.",
    "Every trace is scrubbed of secrets and personal data here, first. If "
    "scrubbing can't finish, nothing sends. It fails closed.",
    "You can veto any task, and preview the exact payload before the first send.",
]

def decline_line() -> str:
    return f"Decline and {_harness.harness_name()} still works fully — as a reader."

CONFIRM_ACCEPT = (
    "Turn on contribution? Every task this harness runs will be scrubbed and "
    "published to the public corpus. You can veto any task and turn this off "
    "any time. [Y] Yes · [N] No"
)
CONFIRM_DECLINE = (
    "Decline contribution? The harness stays fully functional — it will read "
    "the corpus and publish nothing. [Y] Yes · [N] No"
)
RECORDED_ON = (
    "Contribution is ON. Scrubbed task traces will publish to the public "
    "corpus. Next: run /jinn preview after your first task to see exactly "
    "what would publish. Nothing publishes until you do."
)
RECORDED_OFF = (
    "Contribution is OFF — reader only. No trace leaves this machine. "
    "Turn on any time: /jinn consent"
)
NODE_STUB = (
    "Run a network node? Running a node executes tasks for others and earns "
    "rewards. Separate setup; not needed to contribute or read. "
    "[L] Later — show docs · [Enter] Skip"
)
NODE_STUB_LATER = (
    "See docs.jinn.network/run-a-node when you're ready. Nothing to do now."
)

KEYS_LINE = "[A] Accept · [D] Decline · [P] Preview a scrubbed envelope · [?] Docs"

# Section headers (design 1a): benefits first, then the safety mechanics.
WHY_HEADER = "WHY TURN IT ON"
WHAT_LEAVES_HEADER = "WHAT LEAVES THIS MACHINE"

# Current-state line shown above the pitch, so /jinn consent always tells the
# operator where they stand before re-pitching (mono#1384).
STATE_LINES = {
    UNSET: "Contribution is currently OFF (never asked).",
    ACCEPTED: "Contribution is currently ON.",
    DECLINED: "Contribution is currently OFF (declined).",
}

# The slash-command surface (TUI-safe: no blocking reads — see run_consent_flow's
# docstring). Same deliberate two-step as the keyboard flow.
COMMANDS_LINE = (
    "Accept: /jinn consent accept · Decline: /jinn consent decline · "
    "Preview a scrubbed envelope first: /jinn preview · Docs: docs.jinn.network/harness"
)


# ── State store ──────────────────────────────────────────────────────────────

def state_path() -> Path:
    return get_hermes_home() / "jinn" / "consent.json"


def load_state() -> Dict[str, object]:
    path = state_path()
    if not path.exists():
        return {"status": UNSET, "previewed": False}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("status") not in (UNSET, ACCEPTED, DECLINED):
            return {"status": UNSET, "previewed": False}
        data.setdefault("previewed", False)
        return data
    except Exception:
        logger.warning("jinn: unreadable consent state at %s — treating as unset", path)
        return {"status": UNSET, "previewed": False}


def save_state(status: str, *, previewed: Optional[bool] = None) -> Dict[str, object]:
    if status not in (UNSET, ACCEPTED, DECLINED):
        raise ValueError(f"invalid consent status: {status}")
    current = load_state()
    state: Dict[str, object] = {
        "status": status,
        "previewed": bool(current.get("previewed") if previewed is None else previewed),
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    }
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    return state


def mark_previewed() -> None:
    current = load_state()
    save_state(str(current.get("status", UNSET)), previewed=True)


def capture_enabled() -> bool:
    """True only when the operator explicitly accepted. unset == declined."""
    return load_state().get("status") == ACCEPTED


# ── The flow ─────────────────────────────────────────────────────────────────

def state_line() -> str:
    return STATE_LINES[str(load_state().get("status", UNSET))]


def render_explainer(keys_line: str = KEYS_LINE) -> str:
    """Plain-text explainer (NO_COLOR / tests / blocking-terminal path).

    Leads with the three benefits (design ``WHY TURN IT ON``) then the safety
    mechanics (``WHAT LEAVES THIS MACHINE``). The styled TUI variant is
    ``render_explainer_styled``; both carry identical visible text.
    """
    lines = [state_line(), "", opening(), "", f"{WHY_HEADER}:"]
    lines += [f"  · {s}" for s in WHY]
    lines.append("")
    lines.append(f"{WHAT_LEAVES_HEADER}:")
    lines += [f"  · {s}" for s in WHAT_LEAVES]
    lines.append("")
    lines.append(decline_line())
    lines.append("")
    lines.append(keys_line)
    return "\n".join(lines)


def confirm_accept_command() -> str:
    return CONFIRM_ACCEPT.replace("[Y] Yes · [N] No", "To confirm: /jinn consent accept confirm")


def confirm_decline_command() -> str:
    return CONFIRM_DECLINE.replace("[Y] Yes · [N] No", "To confirm: /jinn consent decline confirm")


def record_accept() -> str:
    save_state(ACCEPTED)
    return RECORDED_ON


def record_decline() -> str:
    save_state(DECLINED)
    return RECORDED_OFF


def run_consent_flow(
    input_fn: Callable[[str], str],
    print_fn: Callable[[str], None],
    preview_fn: Optional[Callable[[], None]] = None,
) -> str:
    """The first-run consent flow for a PLAIN TERMINAL (blocking reads).

    Do NOT call from a TUI slash-command handler — ``input()`` blocks on
    stdin the TUI owns and deadlocks the session (first cold-clone dogfood
    finding, 2026-07-03). The slash surface uses the stateless
    ``/jinn consent accept|decline [confirm]`` commands instead.

    Returns the recorded status.

    ``unset -> accepted | declined``; per-action lifecycle
    ``idle -> confirming -> recorded``. Bare Enter defaults to decline —
    the safe default never publishes.
    """
    print_fn(render_explainer_styled())
    while True:
        choice = input_fn("> ").strip().lower()
        if choice == "p":
            # Preview is reachable before any publish. A real scrubbed
            # envelope when preview_fn is wired; otherwise the labelled
            # example fixture (design requirement iv — fresh machine).
            if preview_fn is not None:
                preview_fn()
            else:
                print_fn(render_preview_example())
            print_fn("[A] Accept · [B] Back")
            continue
        if choice == "?":
            print_fn(render_docs_styled())
            continue
        if choice == "a":
            print_fn(render_confirm_styled(accept=True))
            confirm = input_fn("> ").strip().lower()
            if confirm == "y":
                save_state(ACCEPTED)
                print_fn(render_recorded_styled(on=True))
                break
            continue
        # Bare Enter, 'd', or anything unrecognised routes to decline —
        # but decline still takes one deliberate confirmation.
        print_fn(render_confirm_styled(accept=False))
        confirm = input_fn("> ").strip().lower()
        if confirm == "y":
            save_state(DECLINED)
            print_fn(render_recorded_styled(on=False))
            break

    status = str(load_state().get("status"))
    print_fn(render_node_stub_styled())
    node = input_fn("> ").strip().lower()
    if node == "l":
        print_fn(NODE_STUB_LATER)
    return status


# ── Styled renderers (design 1a) — reuse the #1417 splash palette ─────────────
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


def render_explainer_styled(keys_line: str = KEYS_LINE) -> str:
    """The design 1a explainer, styled. Benefits (why) then safety (what
    leaves the machine), with the plain-language guarantees. Default decline."""
    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    amber = lambda s: _style.wrap(pal, rst, "amber", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)

    out = [
        _sigil_head(pal, rst),
        "",
        fg("  Contribute to the open corpus?"),
        "",
        dim("  " + opening()),
        "",
        sky("  " + WHY_HEADER),
    ]
    out += [dim("  · ") + fg(s.split(" — ")[0]) + dim(" — " + s.split(" — ", 1)[1] if " — " in s else s) for s in WHY]
    out += [
        "",
        sky("  " + WHAT_LEAVES_HEADER),
    ]
    out += [dim("  · " + s) for s in WHAT_LEAVES]
    out += [
        "",
        dim("  " + decline_line()),
        "",
        _rule(pal, rst),
        "  " + kbd("[A]") + fg(" Accept & contribute") + "      " + kbd("[P]") + fg(" Preview a real payload"),
        "  " + kbd("[D]") + dim(" Decline · read only") + "      " + kbd("[?]") + dim(" Docs"),
        "",
        dim("  consent: ") + amber(str(load_state().get("status", UNSET))) + dim("   ·   default is decline"),
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
        dim("  Full detail on what is published, how scrubbing works, and how to"),
        dim("  audit the corpus:"),
        "",
        "  " + sky("docs.jinn.network/harness") + dim("   — consent, scrubbing, and the corpus"),
        "",
        dim("  Nothing has been decided. Consent is still ") + amber("unset") + dim("."),
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
            fg("  Turn on contribution?"),
            "",
            dim("  Every task this harness runs will be scrubbed and published to the"),
            dim("  public corpus. You can veto any task and turn this off any time."),
            "",
            "  " + kbd("[Y]") + fg(" Yes, turn on contribution") + "     " + kbd("[N]") + dim(" No, go back"),
        ]
    else:
        body = [
            fg("  Decline contribution?"),
            "",
            dim("  The harness stays fully functional — it will read the corpus and"),
            dim("  publish nothing. No trace will leave this machine."),
            "",
            "  " + kbd("[Y]") + fg(" Yes, decline") + "     " + kbd("[N]") + dim(" No, go back"),
        ]
    return "\n".join([
        _sigil_head(pal, rst), "", gold("  CONFIRM"), "",
        *body, "",
        dim("  consent: ") + amber("unset") + dim("  →  action: ") + gold("confirming"),
    ])


def render_recorded_styled(on: bool) -> str:
    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    green = lambda s: _style.wrap(pal, rst, "green", s)
    if on:
        body = [
            green("  recorded") + dim(" — contribution is ") + green("ON"),
            "",
            dim("  " + RECORDED_ON),
            "",
            dim("  Verified traces earn ") + gold("OLAS") + dim(" as the corpus is trained on them."),
            "",
            dim("  Manage:  ") + sky("/jinn consent") + dim("  |  ") + sky("/jinn veto") + dim("  |  ") + sky("/jinn ledger"),
        ]
    else:
        body = [
            sky("  recorded") + dim(" — contribution is ") + fg("OFF · reader only"),
            "",
            dim("  " + RECORDED_OFF),
        ]
    return "\n".join([_sigil_head(pal, rst), "", *body])


def render_node_stub_styled() -> str:
    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)
    return "\n".join([
        _sigil_head(pal, rst),
        "",
        dim("  One more, optional —"),
        "",
        gold("  RUN A NETWORK NODE?"),
        dim("  Running a node executes tasks for others and earns rewards. It is a"),
        dim("  separate setup and is not needed to contribute or to read."),
        "",
        "  " + kbd("[L]") + fg(" Later — show me the docs") + dim("  (recommended)") + "     " + kbd("[Enter]") + dim(" Skip for now"),
    ])


def render_preview_example() -> str:
    """A labelled example envelope for a fresh machine with no task run yet
    (design requirement iv). Real previews go through jinn-layer; this is the
    fallback so ``P`` is reachable before any task exists. Every field is
    marked ``example`` so it can never be mistaken for a real trace."""
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
        bl([("schema      ", None), ("jinn.trace/v1", "sky")]),
        bl([("task        ", None), ("(example) fix flaky retry in http client", "fg")]),
        bl([("harness     ", None), (_harness.harness_name(), "fg")]),
        bl([("tier        ", None), ("tests-passed", "green")]),
        bl([("scrub       ", None), ("12 secrets removed · 3 paths anonymised · ", "dim"), ("ok", "green")]),
        bm("redacted before send"),
        bl([("  export OPENAI_API_KEY=", None), ("«redacted:secret»", "amber")]),
        bl([("  /home/", None), ("«redacted:user»", "amber"), ("/work/http/client.py", None)]),
        bm("content that ships (scrubbed)"),
        bl([("  prompt   \"the retry loop drops the 429 backoff…\"", "dim")]),
        bl([("  diff     +14 −6  http/client.py", "dim")]),
        bl([("  result   3 tests added · suite green", "dim")]),
        bb(),
    ])
    return "\n".join([
        _sigil_head(pal, rst),
        "",
        gold("  PREVIEW — NOTHING IS SENT FROM THIS SCREEN"),
        dim("  This is an example envelope: no task has run on this machine yet."),
        dim("  After your first task, /jinn preview shows the real scrubbed payload"),
        dim("  that would be published — the whole thing, before anything sends."),
        "",
        box,
        "",
        dim("  Everything inside the box is what would leave the machine. Nothing else."),
    ])
