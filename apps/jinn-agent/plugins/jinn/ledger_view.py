"""Fork-side renderer for the contribution ledger (design 1b).

The ledger *data* is owned by the ``jinn-layer`` package (thin-fork
discipline): what published, what was vetoed, what failed, and each row's
verifiability tier all come from the layer. This module only turns a list of
structured rows into the design's exact terminal table — columns
``time · task · envelope · anchor · tier`` with tier/state chips, the
retained-local retry sub-line, and the exact empty-state copy.

Rows are dicts with keys: ``time``, ``task``, ``env``, ``anchor``, ``tier``
(one of ``user-accepted`` | ``tests-passed`` | ``evaluator-verified``), and an
optional ``state`` (``vetoed`` | ``failed``). Colours reuse the #1417 splash
palette via ``style``.

The renderer is pure and snapshot-testable. ``/jinn ledger`` calls it when the
layer yields JSON, and degrades to the layer's raw text otherwise.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from . import style as _style

# Strip C0/C1 control chars (incl. ESC, CR, LF, DEL) from any layer-supplied
# field before it reaches the terminal (ANSI injection + column-padding desync).
# The sanitiser now lives in ``style`` so every render boundary shares one
# implementation (the #1405 corpus signal line reuses it too); this thin alias
# preserves the existing callers here.
_sanitise = _style.sanitise

# Column widths (chars) — design COL.
_COL = {"time": 12, "task": 32, "env": 11, "anchor": 12}

_TIER_CLS = {
    "user-accepted": "sky",
    "tests-passed": "green",
    "evaluator-verified": "gold",
}

# Exact empty-state copy (design 1b).
EMPTY_LINES = (
    "Nothing published yet. Traces appear here after your first task "
    "publishes. Vetoed and retained-local tasks are listed here too."
)

VETOED_LABEL = "vetoed (local only)"
FAILED_LABEL = "publish failed — retained locally"


def _cell(text: Optional[str], w: int, align_right: bool = False) -> str:
    s = "" if text is None else _sanitise(str(text))
    if len(s) > w:
        s = s[: w - 1] + "…"
    return s.rjust(w) if align_right else s.ljust(w)


def _row(pal, rst: str, r: Dict[str, object]) -> str:
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    amber = lambda s: _style.wrap(pal, rst, "amber", s)
    red = lambda s: _style.wrap(pal, rst, "red", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)

    time = dim(_cell(r.get("time"), _COL["time"]))
    task = fg(_cell(r.get("task"), _COL["task"]))
    state = r.get("state")

    if state == "vetoed":
        env = dim(_cell("—", _COL["env"]))
        anc = dim(_cell("—", _COL["anchor"]))
        return f"{time}  {task}  {env}  {anc}  {amber(VETOED_LABEL)}"

    if state == "failed":
        env = sky(_cell(r.get("env"), _COL["env"]))
        anc = dim(_cell("pending", _COL["anchor"]))
        main = f"{time}  {task}  {env}  {anc}  {red(FAILED_LABEL)}"
        indent = " " * (_COL["time"] + 2 + _COL["task"] + 2)
        sub = (
            indent
            + dim("└ kept on this machine · anchor not written · ")
            + kbd("[r]")
            + dim(" retry   ")
            + kbd("[v]")
            + dim(" veto instead")
        )
        return main + "\n" + sub

    tier = _sanitise(str(r.get("tier") or ""))
    tier_cls = _TIER_CLS.get(tier, "dim")
    env = sky(_cell(r.get("env"), _COL["env"]))
    anc = dim(_cell(r.get("anchor"), _COL["anchor"]))
    return f"{time}  {task}  {env}  {anc}  {_style.wrap(pal, rst, tier_cls, tier)}"


def _header(pal, rst: str) -> str:
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    return (
        dim("TIME".ljust(_COL["time"]))
        + "  "
        + dim("TASK".ljust(_COL["task"]))
        + "  "
        + dim("ENVELOPE".ljust(_COL["env"]))
        + "  "
        + dim("ANCHOR".ljust(_COL["anchor"]))
        + "  "
        + dim("TIER")
    )


def render_empty(node_id: str = "vessel-0x91be…44a2", enabled: bool = True) -> str:
    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    green = lambda s: _style.wrap(pal, rst, "green", s)
    if enabled:
        status = dim("contribution is ") + green("ON") + dim("  ·  run a task to begin.")
    else:
        status = (
            dim("contribution is ")
            + fg("OFF · reader only")
            + dim("  ·  turn on any time: /jinn consent")
        )
    return "\n".join([
        "  " + fg("contribution ledger") + dim("  ·  ") + sky(node_id),
        "",
        dim("  Nothing published yet. Traces appear here after your first task"),
        dim("  publishes. Vetoed and retained-local tasks are listed here too."),
        "",
        "  " + status,
    ])


def render_ledger(
    rows: Sequence[Dict[str, object]],
    node_id: str = "vessel-0x91be…44a2",
    enabled: bool = True,
) -> str:
    """Render the populated ledger (design 1b). Empty ``rows`` → empty state.

    ``vessel-…`` in the node id is the *only* vow-language on the surface, and
    only in neutral chrome — every consent/veto/failure line stays plain.
    ``enabled`` is the real consent state, threaded only to the empty state so
    a declined/unset operator is not told contribution is ON.
    """
    if not rows:
        return render_empty(node_id, enabled=enabled)

    pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    green = lambda s: _style.wrap(pal, rst, "green", s)
    amber = lambda s: _style.wrap(pal, rst, "amber", s)
    red = lambda s: _style.wrap(pal, rst, "red", s)

    published = sum(1 for r in rows if r.get("state") not in ("vetoed", "failed"))
    vetoed = sum(1 for r in rows if r.get("state") == "vetoed")
    retained = sum(1 for r in rows if r.get("state") == "failed")
    rule = dim("─" * 88)

    counts = [green(f"{published} published")]
    if vetoed:
        counts.append(amber(f"{vetoed} vetoed"))
    if retained:
        counts.append(red(f"{retained} retained"))

    out: List[str] = [
        "  " + fg("contribution ledger") + dim("  ·  ") + sky(node_id) + dim("  ·  ") + dim("  ·  ").join(counts),
        "  " + rule,
        "  " + _header(pal, rst),
        "  " + rule,
    ]
    out += ["  " + _row(pal, rst, r) for r in rows]
    out += [
        "  " + rule,
        "  "
        + dim("tier:  ")
        + sky("user-accepted")
        + dim("  <  ")
        + green("tests-passed")
        + dim("  <  ")
        + gold("evaluator-verified")
        + dim("   ·  every published envelope is anchored on-chain"),
    ]
    return "\n".join(out)


def rows_from_json(payload: object) -> Optional[List[Dict[str, object]]]:
    """Coerce a parsed ``jinn-layer ledger --json`` payload into render rows.

    Accepts either a bare list of row dicts or ``{"rows": [...]}``. Returns
    ``None`` when the shape is unrecognised so the caller can degrade to the
    layer's raw text. Unknown keys are ignored; missing keys render blank.
    """
    if isinstance(payload, dict):
        payload = payload.get("rows")
    if not isinstance(payload, list):
        return None
    rows: List[Dict[str, object]] = []
    for item in payload:
        if not isinstance(item, dict):
            return None
        rows.append(
            {
                "time": item.get("time"),
                "task": item.get("task"),
                "env": item.get("env") or item.get("envelope"),
                "anchor": item.get("anchor"),
                "tier": item.get("tier"),
                "state": item.get("state"),
            }
        )
    return rows
