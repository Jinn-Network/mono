"""Guided first-run onboarding for the jinn-agent CLI (Jinn-Network/mono#1405).

The capstone of the CLI TUI chain (#1417 splash → #1418 consent/ledger →
this). A new operator gets one guided pass through the core loop, one
confirmed step at a time:

  1. consent   — the #1418 consent flow, reused VERBATIM (not re-copied).
  2. publish   — a waiting screen shown once; the publish confirmation
                 (task · tier · envelope · anchor + the gold ``view it``
                 deep link) fires on the real publish event.
  3. rewards   — "None yet" + the honest trigger (evaluator verification
                 under bond, not publication, not guaranteed); an earned
                 variant states amount + count.
  4. signals   — the ``◇ corpus`` signal-line format, shown once; thereafter
                 the line renders in real runs at the point of use (product
                 behaviour, wired into pickup.py's consumption path).

Persistence is FACTS OVER FLAGS (design's model). A per-machine flag file
lives beside the other jinn state (``<home>/jinn/onboarding.json``), but
wherever a step maps to a real fact the fact wins:

  - consent is read from the consent record (#1418's store), never a flag.
  - step 2 (first publish) is derived from the ledger being non-empty.
  - only steps 3 and 4 use pure seen-flags.

So a returning operator (consent recorded + ledger non-empty) derives every
gate as satisfied and sees nothing. Onboarding is non-destructive by
construction: it only READS the consent record and the ledger, it never
writes them.

Rendering is pure ANSI (reuses the #1417 splash palette via ``style``), so
every screen is snapshot-testable — the #1417/#1418 discipline. The step
rail (``consent · publish · rewards · signals``) is words, colour carries
state (green done · gold current · amber skipped · dim future); no glyph
icons. Voice is plain on consent + money (design copy verbatim).

Design artifact:
``docs/design/artifacts/2026-07-06-corpus-onboarding/1405-cli-onboarding.html``.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

from . import consent
from . import harness as _harness
from . import jinn_layer
from . import ledger_view
from . import style as _style
from .consent import get_hermes_home

logger = logging.getLogger(__name__)

# The four steps, in order. Rail labels are words (no glyphs) — colour carries
# state per the no-unicode-icons rule.
STEPS = ("consent", "publish", "rewards", "signals")


# ── Persistence — facts over flags ───────────────────────────────────────────
#
# The flag file only holds the two pure seen-flags (steps 3 and 4). Consent and
# publish are never flags: they are derived from the consent record and the
# ledger. Deleting the flag file therefore re-runs ONLY steps 3–4 — consent and
# publish state survive because they were never onboarding's to keep.


def state_path() -> Path:
    return get_hermes_home() / "jinn" / "onboarding.json"


def load_flags() -> Dict[str, object]:
    """The two pure seen-flags. Never carries consent or publish state."""
    path = state_path()
    if not path.exists():
        return {"rewards_explained": False, "signals_shown": False}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {
            "rewards_explained": bool(data.get("rewards_explained", False)),
            "signals_shown": bool(data.get("signals_shown", False)),
        }
    except Exception:
        logger.warning("jinn: unreadable onboarding flags at %s — treating as unseen", path)
        return {"rewards_explained": False, "signals_shown": False}


def mark_flag(name: str) -> None:
    """Set one seen-flag. ``name`` is ``rewards_explained`` | ``signals_shown``."""
    if name not in ("rewards_explained", "signals_shown"):
        raise ValueError(f"unknown onboarding flag: {name}")
    flags = load_flags()
    flags[name] = True
    flags["updatedAt"] = datetime.now(timezone.utc).isoformat()
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(flags, indent=2) + "\n", encoding="utf-8")


# ── Fact reads (never mutate) ────────────────────────────────────────────────


def consent_decided() -> bool:
    """True once consent is recorded either way (accepted OR declined).

    ``unset`` means step 1 is not satisfied — the question re-asks.
    """
    return consent.load_state().get("status") in (consent.ACCEPTED, consent.DECLINED)


def ledger_nonempty(runner: Optional[jinn_layer.Runner] = None) -> bool:
    """True when the ledger has at least one row — the step-2 fact.

    Derived, not flagged: a non-empty ledger means the operator has published
    (or vetoed/failed a) trace, so the first-publish step is done. Reads only;
    never writes the ledger. Any layer error degrades to False (not done) — an
    unreachable ledger must never mark the step complete on a false negative,
    but it also must never block, so callers treat False as "still to do".
    """
    code, out = jinn_layer.ledger_json(runner=runner)
    if code != 0:
        return False
    try:
        rows = ledger_view.rows_from_json(json.loads(out))
    except json.JSONDecodeError:
        return False
    return bool(rows)


def is_complete(runner: Optional[jinn_layer.Runner] = None) -> bool:
    """True when every gate is satisfied — a returning operator sees nothing.

    consent decided AND ledger non-empty AND both seen-flags set. Because the
    first two are facts, a returning operator (consented + published) satisfies
    them without ever having run onboarding, and the flags are the only piece
    onboarding itself owns.
    """
    if not consent_decided():
        return False
    # Reader-only operators (declined) never publish, so the ledger fact does
    # not gate them — steps 2–3 are set aside on the decline path. They are
    # complete once consent is decided and the signals flag is set.
    flags = load_flags()
    if consent.load_state().get("status") == consent.DECLINED:
        return bool(flags["signals_shown"])
    if not ledger_nonempty(runner):
        return False
    return bool(flags["rewards_explained"] and flags["signals_shown"])


# ── Shared chrome (design 1b) ────────────────────────────────────────────────


def _rail(pal, rst: str, statuses: Dict[str, str], current: int) -> str:
    """The step rail — words, colour carries state. ``current`` is the 0-based
    index of the current step, or -1 for none (done/complete)."""
    parts = []
    for i, name in enumerate(STEPS):
        st = statuses.get(name)
        if st == "done":
            parts.append(_style.wrap(pal, rst, "green", name))
        elif st == "skipped":
            parts.append(_style.wrap(pal, rst, "amber", name))
        elif i == current:
            parts.append(_style.wrap(pal, rst, "gold", name))
        else:
            parts.append(_style.wrap(pal, rst, "dim", name))
    sep = _style.wrap(pal, rst, "dim", "  ·  ")
    return sep.join(parts)


def _step_head(pal, rst: str, n: int, label: str, statuses: Dict[str, str]) -> List[str]:
    """Header: sigil + binary + ``first run`` + step count, rail, rule.

    Gold appears exactly twice on any onboarding screen — the step counter
    here, and the single hero line in the step body.
    """
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    head = (
        sky("◇") + " " + fg(_harness.harness_name()) + dim("  ·  first run  ·  ")
        + gold(f"step {n} of 4") + dim("  ·  ") + fg(label)
    )
    return [head, "  " + _rail(pal, rst, statuses, n - 1), _style.wrap(pal, rst, "dim", "─" * 70)]


# ── Step 1 · consent (reuses #1418 renderers verbatim) ───────────────────────
#
# The consent SCREEN copy is owned by consent.py and reused verbatim — this
# module never re-copies it. run_onboarding() calls consent.run_consent_flow()
# for the interactive decision. These two renderers only wrap the recorded
# outcome in the onboarding step-head + rail, pointing at the next step.


def render_consent_recorded(pal=None, rst=None) -> str:
    """Step 1 outcome when consent is ON — continue to step 2."""
    if pal is None:
        pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    green = lambda s: _style.wrap(pal, rst, "green", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)
    return "\n".join([
        *_step_head(pal, rst, 1, "contribute?", {}),
        "",
        green("  recorded") + dim(" — contribution is ") + green("ON"),
        "",
        dim("  Scrubbed task traces will publish to the public corpus. Nothing"),
        dim("  publishes until you preview once — run ") + sky("/jinn preview") + dim(" any time to"),
        dim("  see the next payload before it sends."),
        "",
        dim("  Manage:  ") + sky("/jinn consent") + dim("  |  ") + sky("/jinn veto")
        + dim("  |  ") + sky("/jinn ledger"),
        "",
        _style.wrap(pal, rst, "dim", "─" * 70),
        "  " + kbd("[Enter]") + fg(" Continue — step 2 · your first publish"),
    ])


def render_consent_recorded_off(pal=None, rst=None) -> str:
    """Step 1 outcome when consent is OFF — steps 2–3 set aside, go to step 4."""
    if pal is None:
        pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)
    return "\n".join([
        *_step_head(pal, rst, 1, "contribute?", {}),
        "",
        sky("  recorded") + dim(" — contribution is ") + fg("OFF · reader only"),
        "",
        dim("  This harness will run tasks and read the corpus, and will publish"),
        dim("  nothing. No trace leaves this machine."),
        "",
        dim("  Turn on any time:  ") + sky("/jinn consent"),
        "",
        dim("  Steps 2 and 3 cover publishing and rewards — they apply only when"),
        dim("  contribution is on, so they're set aside. Step 4 still applies:"),
        dim("  reading the corpus is on for everyone."),
        "",
        _style.wrap(pal, rst, "dim", "─" * 70),
        "  " + kbd("[Enter]") + fg(" Continue — step 4 · corpus signals"),
    ])


# ── Step 2 · first publish ───────────────────────────────────────────────────


def render_first_publish_waiting(pal=None, rst=None) -> str:
    """The waiting screen, rendered once. Advances on the real publish event —
    onboarding must not hold the terminal hostage while the operator works."""
    if pal is None:
        pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)
    return "\n".join([
        *_step_head(pal, rst, 2, "your first publish", {"consent": "done"}),
        "",
        fg("  Run your first task."),
        "",
        dim("  This step completes on its own when your first task finishes and"),
        dim("  its trace publishes. Nothing to configure — just work:"),
        "",
        "  " + dim("$ ") + fg(_harness.cli_name() + " ") + sky('"fix the flaky retry test in http/client.py"'),
        "",
        dim("  Onboarding stays out of the way until then."),
        "",
        _style.wrap(pal, rst, "dim", "─" * 70),
        "  " + kbd("[Enter]") + dim(" (walkthrough: simulate the task finishing)")
        + "      " + kbd("[S]") + dim(" Skip"),
    ])


# Deep-link host for the ``view it`` line. NOT a configured live source in the
# fork — the design's own seam note. Degrade honestly if unset (see the PR
# gap note): the CLI states what was published, the explorer proves it.
EXPLORER_HOST = "explorer.jinn.network"


def render_first_publish_confirmed(
    task: str = "fix flaky retry in http client",
    tier: str = "tests-passed",
    envelope: str = "bafkreid6qv…shxv4",
    anchor: str = "0x7a2f…c019",
    scrub_note: str = "12 secrets removed · 3 paths anonymised",
    pal=None,
    rst=None,
) -> str:
    """The publish confirmation frame (design 1b anatomy). The single gold
    hero line is the ``view it`` deep link to ``/corpus/:cid``."""
    if pal is None:
        pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    green = lambda s: _style.wrap(pal, rst, "green", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)
    iw = 62
    bt = lambda title="": _style.box_top(pal, rst, iw, title)
    bm = lambda title="": _style.box_mid(pal, rst, iw, title)
    bb = lambda: _style.box_bot(pal, rst, iw)
    bl = lambda segs: _style.box_line(pal, rst, iw, segs)
    deep_link = f"{EXPLORER_HOST}/corpus/{envelope}"
    box = "\n".join([
        bt("published — your first contribution"),
        bl([("task        ", None), (task, "fg")]),
        bl([("tier        ", None), (tier, "green")]),
        bl([("envelope    ", None), (envelope, "sky"), ("  ·  ipfs", "dim")]),
        bl([("anchor      ", None), (anchor, "sky"), ("  ·  base-sepolia · erc-8004", "dim")]),
        bm(),
        bl([("view it     ", None), (deep_link, "gold")]),
        bb(),
    ])
    return "\n".join([
        *_step_head(pal, rst, 2, "your first publish", {"consent": "done"}),
        "",
        dim("  …task complete · suite green"),
        "",
        green("  contribution") + dim(" · captured — scrubbed ") + green("ok")
        + dim(f" ({scrub_note})"),
        "",
        box,
        "",
        dim("  That page is public — anyone can read the trace, follow its content"),
        dim("  ref, and check its anchor. Your ledger: ") + sky("/jinn ledger"),
        "",
        _style.wrap(pal, rst, "dim", "─" * 70),
        "  " + kbd("[Enter]") + fg(" Continue — step 3 · rewards")
        + "      " + kbd("[V]") + dim(" Veto — pull it back"),
    ])


# ── Step 3 · rewards ─────────────────────────────────────────────────────────


def render_rewards_none(pal=None, rst=None) -> str:
    """"None yet" + the honest trigger. Plain speech on money (design verbatim):
    publication alone does not earn; verification triggers it, not guaranteed."""
    if pal is None:
        pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    green = lambda s: _style.wrap(pal, rst, "green", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)
    return "\n".join([
        *_step_head(pal, rst, 3, "rewards", {"consent": "done", "publish": "done"}),
        "",
        fg("  OLAS earned: ") + dim("none yet."),
        "",
        dim("  Publication alone does not earn — verification does. OLAS accrues"),
        dim("  when an evaluator scores one of your published traces under bond;"),
        dim("  verification triggers it, and it is not guaranteed."),
        "",
        dim("  Your first trace is published at tier ") + green("tests-passed") + dim(". If an"),
        dim("  evaluator verifies it, the tier moves to ") + gold("evaluator-verified"),
        dim("  and the reward lands on your operator address."),
        "",
        dim("  Check any time:  ") + sky("/jinn rewards"),
        "",
        _style.wrap(pal, rst, "dim", "─" * 70),
        "  " + kbd("[Enter]") + fg(" Continue — step 4 · corpus signals")
        + "      " + kbd("[S]") + dim(" Skip"),
    ])


def render_rewards_earned(amount: str, count: int, pal=None, rst=None) -> str:
    """Earned variant — states amount + verified count, links the rewards view.

    The amount is not a fork-native synchronous source (no rewards lookup wired
    yet); callers pass ``amount='checking…'`` to degrade honestly (design's
    error state) rather than fabricate a figure.
    """
    if pal is None:
        pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    gold = lambda s: _style.wrap(pal, rst, "gold", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)
    verified = f"{count} trace{'s' if count != 1 else ''} evaluator-verified"
    return "\n".join([
        *_step_head(pal, rst, 3, "rewards", {"consent": "done", "publish": "done"}),
        "",
        fg("  OLAS earned: ") + gold(amount) + dim(f" · {verified}."),
        "",
        dim("  Accrues on verification, not publication: an evaluator scored those"),
        dim("  traces under bond. Details and per-trace provenance:"),
        "",
        dim("  ") + sky("/jinn rewards") + dim("   ·   each entry links its evaluation and anchor tx."),
        "",
        _style.wrap(pal, rst, "dim", "─" * 70),
        "  " + kbd("[Enter]") + fg(" Continue — step 4 · corpus signals"),
    ])


# ── Step 4 · corpus signals ──────────────────────────────────────────────────


def render_corpus_signal_line(
    skill: str,
    provenance: str,
    env_ref: str,
    pal=None,
    rst=None,
) -> str:
    """One in-run line at the point of corpus use (design 1c) — the permanent
    artefact of step 4. ``◇ corpus`` prefix (sky), skill name bright, provenance
    dim, the envelope ref carried so the claim is checkable. One line per use.

    This is the product-behaviour render hooked into pickup.py's consumption
    path — NOT onboarding-only. Kept here so the format has a single source.

    Every dynamic field (``skill``, ``provenance``, ``env_ref``) is sanitised
    of C0/C1 control chars at this boundary: the corpus is PUBLIC and
    cross-operator, so a hostile ``summary``/``slug``/``ref`` carrying
    ``\\x1b[…]``/``\\r``/CSI bytes would otherwise reach a victim operator's
    terminal raw on auto-adoption (screen manipulation, output spoofing). We
    sanitise unconditionally here rather than trusting upstream slug/tier
    constraints, so every caller is covered.
    """
    if pal is None:
        pal, rst = _style.palette()
    skill = _style.sanitise(skill)
    provenance = _style.sanitise(provenance)
    env_ref = _style.sanitise(env_ref)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    skyh = lambda s: _style.wrap(pal, rst, "fg", s)  # bright skill name
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    return (
        "  " + sky("◇ corpus") + "  " + fg("using ") + skyh(skill)
        + dim(f"  ·  {provenance}  ·  ") + sky(f"env {env_ref}")
    )


def render_signals(statuses: Dict[str, str], pal=None, rst=None) -> str:
    """The step-4 screen — shows the signal-line format once."""
    if pal is None:
        pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    kbd = lambda s: _style.wrap(pal, rst, "gold", s)
    example = render_corpus_signal_line(
        "retry-backoff-patterns", "learned from 214 contributions", "bafkr…hx2c", pal, rst
    )
    return "\n".join([
        *_step_head(pal, rst, 4, "corpus signals", statuses),
        "",
        fg("  When a run draws on the corpus, you'll see it."),
        "",
        dim("  Any time this harness uses a network skill or another operator's"),
        dim("  contribution inside your own run, one line marks it at the point"),
        dim("  of use — like this:"),
        "",
        example,
        "",
        dim("  One line per use, in the scrying as it happens. Every line carries"),
        dim("  the envelope ref, so the claim is checkable — nothing uses the"),
        dim("  corpus invisibly."),
        "",
        _style.wrap(pal, rst, "dim", "─" * 70),
        "  " + kbd("[Enter]") + fg(" Finish"),
    ])


# ── Done ─────────────────────────────────────────────────────────────────────


def render_done(reader_only: bool = False, first_publish: str = "", pal=None, rst=None) -> str:
    if pal is None:
        pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    green = lambda s: _style.wrap(pal, rst, "green", s)
    if reader_only:
        statuses = {"consent": "done", "publish": "skipped", "rewards": "skipped", "signals": "done"}
    else:
        statuses = {"consent": "done", "publish": "done", "rewards": "done", "signals": "done"}
    head = (
        sky("◇") + " " + fg(_harness.harness_name()) + dim("  ·  first run  ·  ") + green("complete")
    )
    out = [
        head,
        "  " + _rail(pal, rst, statuses, -1),
        _style.wrap(pal, rst, "dim", "─" * 70),
        "",
        dim("  Done. These steps are remembered on this machine and won't repeat."),
        "",
    ]
    if reader_only:
        out += [
            dim("  Contribution is ") + fg("off · reader only") + dim(" — no trace leaves this"),
            dim("  machine. If you turn it on later (") + sky("/jinn consent") + dim("), the"),
            dim("  publish and rewards steps run then, once."),
        ]
    else:
        out += [
            dim("  contribution   ") + green("on"),
            dim("  first publish  ") + sky(first_publish or "recorded"),
            dim("  rewards        ") + dim("explained"),
            dim("  signals        ") + dim("shown"),
        ]
    out += [
        "",
        dim("  Replay any time: ") + sky(f"{_harness.cli_name()} onboarding --replay")
        + dim("  (never re-asks consent)"),
    ]
    return "\n".join(out)


def render_skipped_all(pal=None, rst=None) -> str:
    """Setup skipped from the launch screen — nothing decided, returns next launch."""
    if pal is None:
        pal, rst = _style.palette()
    dim = lambda s: _style.wrap(pal, rst, "dim", s)
    fg = lambda s: _style.wrap(pal, rst, "fg", s)
    sky = lambda s: _style.wrap(pal, rst, "sky", s)
    return "\n".join([
        sky("◇") + " " + fg(_harness.harness_name()) + dim("  ·  first run"),
        "",
        dim("  Setup skipped. Nothing was decided — capture stays ") + fg("off") + dim(" until"),
        dim("  consent is granted. The steps return next launch, or any time:"),
        "",
        "  " + sky(f"{_harness.cli_name()} onboarding"),
    ])


# ── The interactive driver ───────────────────────────────────────────────────


def run_onboarding(
    input_fn: Callable[[str], str],
    print_fn: Callable[[str], None],
    *,
    replay: bool = False,
    runner: Optional[jinn_layer.Runner] = None,
    publish_wait_fn: Optional[Callable[[], Optional[Dict[str, str]]]] = None,
    rewards_fn: Optional[Callable[[], Optional[Dict[str, object]]]] = None,
) -> None:
    """Walk the four steps for a PLAIN TERMINAL (blocking reads).

    One confirmed step at a time — every screen exits on an explicit key.
    Nothing auto-advances on a timer. Step 2 advances on the real publish event
    (``publish_wait_fn``) and says so; when no event source is wired it degrades
    to a keyboard confirm in walkthrough mode.

    ``replay=True`` re-renders all four screens but re-asks nothing: a recorded
    consent shows its current state, step 2 shows the actual first envelope from
    the ledger. It never mutates consent or the ledger.

    Do NOT call from a TUI slash-command handler — like the consent flow, the
    blocking ``input()`` deadlocks a session whose stdin the TUI owns. This is a
    subcommand-level flow (``jinn-agent onboarding``).
    """
    pal, rst = _style.palette()

    # ── Step 1 · consent ──
    if replay:
        # Never re-ask; show the recorded state as-is.
        status = str(consent.load_state().get("status", consent.UNSET))
        on = status == consent.ACCEPTED
        print_fn(render_consent_recorded(pal, rst) if on else render_consent_recorded_off(pal, rst))
        input_fn("> ")
    else:
        # Reuse the #1418 consent flow VERBATIM for the decision itself.
        status = consent.run_consent_flow(input_fn, print_fn)
        on = status == consent.ACCEPTED
        print_fn(render_consent_recorded(pal, rst) if on else render_consent_recorded_off(pal, rst))
        input_fn("> ")

    if not on:
        # Decline / reader-only path: steps 2–3 set aside, jump to step 4.
        print_fn(render_signals(
            {"consent": "done", "publish": "skipped", "rewards": "skipped"}, pal, rst
        ))
        input_fn("> ")
        if not replay:
            mark_flag("signals_shown")
        print_fn(render_done(reader_only=True, pal=pal, rst=rst))
        return

    # ── Step 2 · first publish ──
    first_env = _replay_first_envelope(runner) if replay else "bafkreid6qv…shxv4"
    if replay:
        print_fn(render_first_publish_confirmed(envelope=first_env, pal=pal, rst=rst))
        input_fn("> ")
    else:
        print_fn(render_first_publish_waiting(pal, rst))
        choice = input_fn("> ").strip().lower()
        if choice == "s":
            # Skip: the publish frame still shows once after the first real
            # publish — but for the walkthrough we move straight on.
            pass
        else:
            result = publish_wait_fn() if publish_wait_fn is not None else None
            if result:
                print_fn(render_first_publish_confirmed(
                    task=result.get("task", "fix flaky retry in http client"),
                    tier=result.get("tier", "tests-passed"),
                    envelope=result.get("envelope", "bafkreid6qv…shxv4"),
                    anchor=result.get("anchor", "0x7a2f…c019"),
                    pal=pal, rst=rst,
                ))
            else:
                print_fn(render_first_publish_confirmed(pal=pal, rst=rst))
            input_fn("> ")

    # ── Step 3 · rewards ──
    earned = rewards_fn() if rewards_fn is not None else None
    if earned and earned.get("count"):
        amount = str(earned.get("amount") or "checking…")
        print_fn(render_rewards_earned(amount, int(earned["count"]), pal, rst))
    else:
        print_fn(render_rewards_none(pal, rst))
    input_fn("> ")
    if not replay:
        mark_flag("rewards_explained")

    # ── Step 4 · corpus signals ──
    print_fn(render_signals(
        {"consent": "done", "publish": "done", "rewards": "done"}, pal, rst
    ))
    input_fn("> ")
    if not replay:
        mark_flag("signals_shown")

    print_fn(render_done(reader_only=False, first_publish=first_env, pal=pal, rst=rst))


def _replay_first_envelope(runner: Optional[jinn_layer.Runner]) -> str:
    """The actual first published envelope from the ledger, for --replay.

    Reads the ledger (never writes it) and returns the earliest published row's
    envelope. Degrades to the design's example CID when the ledger is
    unavailable or unparseable — honest degrade, no fabrication of a live source.
    """
    code, out = jinn_layer.ledger_json(runner=runner)
    if code != 0:
        return "bafkreid6qv…shxv4"
    try:
        rows = ledger_view.rows_from_json(json.loads(out))
    except json.JSONDecodeError:
        return "bafkreid6qv…shxv4"
    if not rows:
        return "bafkreid6qv…shxv4"
    published = [r for r in rows if r.get("state") not in ("vetoed", "failed")]
    row = (published or rows)[0]
    env = row.get("env")
    return str(env) if env else "bafkreid6qv…shxv4"


# ── CLI subcommand (jinn-agent onboarding [--replay]) ────────────────────────


def setup_parser(parser) -> None:
    parser.add_argument(
        "--replay",
        action="store_true",
        help="Re-render all four onboarding screens without re-asking consent.",
    )


def render_already_complete() -> str:
    """The returning-operator no-op copy: nothing repeats, replay hint given."""
    cli = _harness.cli_name()
    return (
        f"{cli} onboarding: already complete on this machine — nothing to do.\n"
        f"Replay the walkthrough any time: {cli} onboarding --replay"
    )


def cli_handler(args) -> int:
    replay = bool(getattr(args, "replay", False))
    if not replay and is_complete():
        # Returning operator: nothing repeats. Launch is identical to any other.
        print(render_already_complete())
        return 0

    def _print(s: str) -> None:
        print(s)

    def _input(prompt: str) -> str:
        try:
            return input(prompt)
        except EOFError:
            return ""

    run_onboarding(_input, _print, replay=replay)
    return 0
