"""The ``◇ corpus`` evidence-pickup signal line — the single source of this
render, hooked from ``pickup.py``'s first-turn pickup path.

Relocated here from the deleted onboarding wizard (mono#1818); it depends only
on ``style`` primitives, no consent/ledger/harness coupling.
"""

from __future__ import annotations

from typing import List

from . import style as _style


def render_evidence_signal_line(
    searched_terms: List[str],
    provided_count: int,
    pal=None,
    rst=None,
) -> str:
    """One in-run line at the point of evidence pickup (rescope plan §3.4).
    ``◇ corpus`` prefix (sky), the provided count bright, the searched terms
    dim. One line per session, emitted only when evidence was actually
    provided.

    This is the product-behaviour render hooked into pickup.py's first-turn
    pickup path. Kept here so the format has a single source.

    ``searched_terms`` are sanitised of C0/C1 control chars at this boundary:
    they are derived from the session's own first message, but a corpus
    record's `contextBlock` (rendered separately, not here) is PUBLIC and
    cross-operator, so this boundary sanitises unconditionally rather than
    trusting upstream term derivation, matching the rest of this module's
    convention.
    """
    if pal is None:
        pal, rst = _style.palette()
    terms = ", ".join(_style.sanitise(term) for term in searched_terms)
    noun = "packet" if provided_count == 1 else "packets"
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    return (
        "  " + sky("◇ corpus") + "  " + fg(f"provided {provided_count} evidence {noun}")
        + dim(f"  ·  searched: {terms}")
    )
