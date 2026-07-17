"""Welcome banner, ASCII art, skills summary, and update check for the CLI.

Pure display functions with no HermesCLI state dependency.
"""

import json
import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlparse
from hermes_constants import get_hermes_home
from typing import TYPE_CHECKING, Dict, List, Optional

# rich and prompt_toolkit are imported lazily (inside the functions that use
# them) rather than at module level.  Importing this module is on the TUI
# gateway's critical startup path purely to reach the lightweight update-check
# helpers (``prefetch_update_check``); pulling rich.console + prompt_toolkit
# eagerly added ~50ms of wasted imports before ``gateway.ready`` could fire.
# Keep the type-only reference available to checkers without the runtime cost.
if TYPE_CHECKING:
    from rich.console import Console

logger = logging.getLogger(__name__)


# =========================================================================
# ANSI building blocks for conversation display
# =========================================================================

_GOLD = "\033[1;38;2;255;215;0m"  # True-color #FFD700 bold
_BOLD = "\033[1m"
_DIM = "\033[2m"
_RST = "\033[0m"


def cprint(text: str):
    """Print ANSI-colored text through prompt_toolkit's renderer."""
    from prompt_toolkit import print_formatted_text as _pt_print
    from prompt_toolkit.formatted_text import ANSI as _PT_ANSI
    _pt_print(_PT_ANSI(text))


# =========================================================================
# Skin-aware color helpers
# =========================================================================

def _skin_color(key: str, fallback: str) -> str:
    """Get a color from the active skin, or return fallback."""
    try:
        from hermes_cli.skin_engine import get_active_skin
        return get_active_skin().get_color(key, fallback)
    except Exception:
        return fallback
# =========================================================================
# ASCII Art & Branding
# =========================================================================

from hermes_cli import __version__ as VERSION, __release_date__ as RELEASE_DATE

HERMES_AGENT_LOGO = """[bold #FFD700]██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗███████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗[/]
[bold #FFD700]██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝[/]
[#FFBF00]███████║█████╗  ██████╔╝██╔████╔██║█████╗  ███████╗█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║[/]
[#FFBF00]██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ╚════██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║[/]
[#CD7F32]██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████║      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║[/]
[#CD7F32]╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝[/]"""

HERMES_CADUCEUS = """[#CD7F32]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⡀⠀⣀⣀⠀⢀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#CD7F32]⠀⠀⠀⠀⠀⠀⢀⣠⣴⣾⣿⣿⣇⠸⣿⣿⠇⣸⣿⣿⣷⣦⣄⡀⠀⠀⠀⠀⠀⠀[/]
[#FFBF00]⠀⢀⣠⣴⣶⠿⠋⣩⡿⣿⡿⠻⣿⡇⢠⡄⢸⣿⠟⢿⣿⢿⣍⠙⠿⣶⣦⣄⡀⠀[/]
[#FFBF00]⠀⠀⠉⠉⠁⠶⠟⠋⠀⠉⠀⢀⣈⣁⡈⢁⣈⣁⡀⠀⠉⠀⠙⠻⠶⠈⠉⠉⠀⠀[/]
[#FFD700]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⡿⠛⢁⡈⠛⢿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#FFD700]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠿⣿⣦⣤⣈⠁⢠⣴⣿⠿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#FFBF00]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠻⢿⣿⣦⡉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#FFBF00]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢷⣦⣈⠛⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#CD7F32]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣴⠦⠈⠙⠿⣦⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#CD7F32]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣿⣤⡈⠁⢤⣿⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠷⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⠑⢶⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠁⢰⡆⠈⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠳⠈⣡⠞⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[#B8860B]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]"""


# =========================================================================
# Jinn terminal splash (Jinn-Network/mono#1417)
# =========================================================================
#
# An instant one-paint greeting for the jinn-agent fork: the Vessel sigil
# (circle · inscribed triangle · horizon · centre point), a lower-case
# ``jinn`` wordmark under a gold rule, the version, and live status lines
# (network, corpus, contribution; node is render-supported but omitted by the
# fork — it has no local node concept). Design artifact:
# ``docs/design/artifacts/2026-07-06-corpus-onboarding/1319-terminal-splash.html``.
#
# Rendering is pure ANSI (no Rich / prompt_toolkit dependency) so the splash
# is cheap on the startup path and trivially snapshot-testable. Two variants:
# truecolor line-art, and a 16-colour ASCII fallback that fits 80x24. The
# fallback is chosen when ``$COLORTERM`` is unset or ``$COLUMNS`` is narrow.
#
# Gold appears exactly twice on testnet — the sigil centre point and the
# version — and nowhere else; that scarcity is load-bearing. Mainnet is the
# one sanctioned exception: the design renders the ``base · mainnet`` network
# line gold, so mainnet legitimately carries three golds (sigil + version +
# network line). Update-available drops the version to amber, so it carries
# two on mainnet, one on testnet. See test_gold_count_on_mainnet_is_three.

# ── ANSI palette ─────────────────────────────────────────────────────────────
# Truecolor (24-bit) — mirrors the design's --t-* tokens.
_TC = {
    "sky": "\033[38;2;122;167;220m",     # #7aa7dc — structure
    "gold": "\033[38;2;220;184;102m",    # #dcb866 — single accent
    "dim": "\033[38;2;107;123;149m",     # #6b7b95 — secondary / labels / off
    "green": "\033[38;2;123;176;162m",   # #7bb0a2 — ok / on / running
    "amber": "\033[38;2;207;154;63m",    # #cf9a3f — warn / degraded
    "red": "\033[38;2;192;112;112m",     # #c07070 — error / unreachable
    "fg": "\033[38;2;214;224;240m",      # #d6e0f0 — bone default text
}
# 16-colour fallback (basic xterm) — mirrors the design's --c-* tokens.
_FB = {
    "sky": "\033[36m",       # cyan — structure
    "gold": "\033[93m",      # bright yellow — accent
    "dim": "\033[90m",       # bright black (grey) — secondary / off
    "green": "\033[32m",     # green — ok
    "amber": "\033[33m",     # yellow — warn
    "red": "\033[31m",       # red — error
    "fg": "\033[97m",        # bright white — default text
}


def _splash_palette(truecolor: bool) -> Dict[str, str]:
    return _TC if truecolor else _FB


def supports_truecolor(columns: Optional[int] = None) -> bool:
    """Decide the splash variant: truecolor line-art vs 16-colour ASCII.

    Truecolor is used only when the terminal advertises it (``$COLORTERM`` is
    ``truecolor`` / ``24bit``) AND there is room for the line-art sigil
    (>= 96 columns — the design's real minimum; the artifact's ``< 100``
    threshold was a placeholder left to this probe). ``NO_COLOR`` forces the
    fallback. Any of these unmet → the ASCII fallback that fits 80x24.
    """
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


# ── Status-line copy (design 3.3, exact) ─────────────────────────────────────
# A splash state is a plain dict describing what to render. Callers pass real
# values; anything not synchronously known is ``None`` and renders ``checking…``.
_LABEL_W = 15  # fixed-width, lower-case, dim label column


def _thousands(n: int) -> str:
    return f"{n:,}"


def _status_lines(state: Dict[str, object], pal: Dict[str, str]) -> List[str]:
    """Render the status lines (network, corpus, contribution, node).

    Fixed order. Pre-consent (``contribution`` is ``None``/unset) omits the
    contribution line entirely; likewise an absent ``node`` key omits the node
    line (the fork has no node source — see the node block below). Unresolved
    network/corpus values render ``checking…`` dim.
    """
    rst = _RST
    dim, sky, gold, green, red = (
        pal["dim"], pal["sky"], pal["gold"], pal["green"], pal["red"]
    )
    sep = " · " if pal is _TC else " * "  # ASCII fallback avoids the middot

    def label(text: str) -> str:
        return f"{dim}{text.ljust(_LABEL_W)}{rst}"

    lines: List[str] = []

    # network — sky on testnet, gold on mainnet (the only other gold, on
    # mainnet only; on testnet gold stays reserved for sigil + version).
    net = state.get("network")
    if net == "mainnet":
        lines.append(label("network") + f"{gold}base{sep}mainnet{rst}")
    elif net == "testnet":
        lines.append(label("network") + f"{sky}base-sepolia{sep}testnet{rst}")
    else:
        lines.append(label("network") + f"{dim}checking…{rst}")

    # corpus — connected(green) / unreachable(red) / checking(dim)
    corpus = state.get("corpus")
    if corpus == "connected":
        count = state.get("corpus_count")
        tail = f"{sep}{_thousands(int(count))} envelopes" if isinstance(count, int) else ""
        lines.append(label("corpus") + f"{green}connected{tail}{rst}")
    elif corpus == "unreachable":
        lines.append(label("corpus") + f"{red}unreachable — retrying{rst}")
    else:
        lines.append(label("corpus") + f"{dim}checking…{rst}")

    # contribution — omitted entirely pre-consent (state == None / 'unset').
    contrib = state.get("contribution")
    if contrib == "on":
        count = state.get("contribution_count")
        tail = f"{_thousands(int(count))} traces published" if isinstance(count, int) else "traces published"
        lines.append(label("contribution") + f"{green}on{sep}{tail}{rst}")
    elif contrib == "off":
        lines.append(label("contribution") + f"{dim}off{sep}reader only{rst}")
    # else: unset — line omitted.

    # node — running(green) / not running(dim). Omitted entirely when the
    # key is absent (same rule as the pre-consent contribution line): the
    # jinn-agent harness has no local node/vessel concept (node operation is
    # the separate mono client daemon), so an unresolved node line would show
    # ``checking…`` forever and can never resolve — misleading. The fork's
    # gather_splash_state never sets ``node``, so the fork never renders this
    # line; the render path is retained for callers that do have a node source.
    node = state.get("node")
    if node == "running":
        vessel = state.get("node_vessel")
        tail = f"{sep}{vessel}" if vessel else ""
        lines.append(label("node") + f"{green}running{tail}{rst}")
    elif node == "not_running":
        lines.append(label("node") + f"{dim}not running{rst}")
    # else: unset/None — line omitted (no perpetual checking… for the fork).

    return lines


# ── Sigil art (transcribed from the design's rendered output) ────────────────
# Truecolor line-art: circle · inscribed upward triangle · horizon · centre.
# Whole rows are colour-wrapped so alignment cannot drift; only the horizon
# row is split to place the single gold centre point.
def _line_sigil(pal: Dict[str, str]) -> List[str]:
    sky, gold, rst = pal["sky"], pal["gold"], _RST
    s = lambda t: f"{sky}{t}{rst}"
    return [
        s("           ╭───────────────╮"),
        s("        ╭──╯       ╱╲        ╰──╮"),
        s("      ╭─╯        ╱    ╲         ╰─╮"),
        s("     ╱         ╱        ╲          ╲"),
        s("    │        ╱            ╲         │"),
        s("    │       ╱              ╲        │"),
        f"{sky}  ──┼──────╱────────{rst}{gold}•{rst}{sky}───────╲───────┼──{rst}",
        s("    │     ╱                  ╲       │"),
        s("    │    ╱____________________╲      │"),
        s("     ╲                              ╱"),
        s("      ╰─╮                        ╭─╯"),
        s("        ╰──╮                  ╭──╯"),
        s("           ╰────────────────╯"),
    ]


# 16-colour ASCII fallback sigil (no box-drawing, no braille) — fits 80x24.
def _fallback_sigil(pal: Dict[str, str]) -> List[str]:
    c, gold, rst = pal["sky"], pal["gold"], _RST
    s = lambda t: f"{c}{t}{rst}"
    return [
        s("            .-\"\"\"\"\"\"\"-."),
        s("         .'      /\\      '."),
        s("        /      /  \\      \\"),
        s("       /      /    \\      \\"),
        s("      |      /      \\      |"),
        f"{c}  +---|-----/---{rst}{gold}*{rst}{c}---\\-----|---+{rst}",
        s("      |    /          \\    |"),
        s("       \\  /____________\\  /"),
        s("        \\                /"),
        s("         '.            .'"),
        s("           '-.________.-'"),
    ]


def render_jinn_splash(
    state: Dict[str, object],
    *,
    truecolor: bool = True,
    columns: Optional[int] = None,
) -> str:
    """Render the full splash to an ANSI string — pure, one paint, no I/O.

    ``state`` keys (all optional; missing → ``checking…`` or omitted):
      network: 'testnet' | 'mainnet'
      corpus: 'connected' | 'unreachable'   corpus_count: int
      contribution: 'on' | 'off'            contribution_count: int
      node: 'running' | 'not_running'       node_vessel: str
      version: 'v0.4.2'  network_label: 'testnet'  update_available: bool
    """
    pal = _splash_palette(truecolor)
    dim, gold, sky, amber, rst = (
        pal["dim"], pal["gold"], pal["sky"], pal["amber"], _RST
    )
    sep = " · " if truecolor else " * "

    sigil = _line_sigil(pal) if truecolor else _fallback_sigil(pal)
    indent = "     " if truecolor else "    "

    # Wordmark block — lower-case mono ``jinn``, gold rule, tagline, version.
    version = str(state.get("version") or "")
    net_label = str(state.get("network_label") or "testnet")
    ver_str = f"harness {version}" if version else "harness"
    if state.get("update_available"):
        # Out-of-date build: version renders amber with the annotation.
        ver_line = f"{amber}{ver_str}{sep}{net_label}{sep}update available{rst}"
    else:
        ver_line = f"{gold}{ver_str}{rst}{dim}{sep}{rst}{sky}{net_label}{rst}"

    if truecolor:
        # The wordmark rule is dim, NOT gold: gold is reserved to exactly two
        # marks — the sigil centre point and the version (issue #1417 AC).
        # The design artifact renders this rule gold; the AC's "gold appears
        # exactly twice" is the binding contract, so the rule stays dim.
        wordmark = [
            "",
            f"              {_BOLD}{pal['fg']}j i n n{rst}",
            f"           {dim}──────────────────{rst}",
            f"     {dim}an open agentic knowledge economy{rst}",
            f"           {ver_line}",
        ]
        ether = f"{dim}────────────────────  the ether  ────────────────────{rst}"
    else:
        wordmark = [
            "",
            f"        {_BOLD}{pal['fg']}j i n n{rst}   {dim}an open agentic knowledge economy{rst}",
            f"        {ver_line}",
        ]
        ether = f"{dim}----------------------  the ether  ----------------------{rst}"

    status = _status_lines(state, pal)

    out: List[str] = []
    out.extend(sigil)
    out.extend(wordmark)
    out.append("")
    out.append(indent + ether)
    out.append("")
    out.extend(indent + line for line in status)
    return "\n".join(out)


def gather_splash_state() -> Dict[str, object]:
    """Collect a synchronous best-effort snapshot for the splash.

    Instant-paint discipline: only values cheaply known without a network
    call are read live; anything needing a subprocess or RPC round-trip is
    left unresolved (``checking…``) rather than blocking the greeting.

    Wired to real fork data:
      - version / update_available: the same VERSION + update check the
        Rich banner uses.
      - network / network_label: ``$JINN_NETWORK`` (default ``testnet`` —
        the fork's only sync network source; there is no chain config).
      - contribution: real consent state — ``unset`` omits the line,
        ``accepted`` → on, ``declined`` → off.

    Wired via the background prefetch (non-blocking, ``timeout=0.0``):
      - corpus reachability + count and contribution_count come from
        ``prefetch_splash_reads()`` (jinn-layer corpus search + ledger). Until
        the prefetch resolves the read yields None and corpus honestly stays
        ``checking…`` — the settle can't shift layout (label-column-fixed).

    Omitted (no source at all in the fork — the line is not rendered):
      - node status + vessel: the harness has no local node/vessel concept
        (node operation is the separate mono client daemon).
    """
    state: Dict[str, object] = {}

    state["version"] = f"v{VERSION}"

    net = (os.environ.get("JINN_NETWORK") or "testnet").strip().lower()
    if net not in ("testnet", "mainnet"):
        net = "testnet"
    state["network"] = net
    state["network_label"] = net

    # Update check — reuse the prefetched result if it's ready; never block.
    try:
        behind = get_update_result(timeout=0.0)
        state["update_available"] = bool(behind is not None and behind != 0)
    except Exception:
        state["update_available"] = False

    # Consent — synchronous, real. Drives the contribution line's presence.
    try:
        from plugins.jinn import consent as _consent
        if _consent.consent_decided():
            state["contribution"] = "on" if _consent.share_enabled() else "off"
        # Undecided → key absent → contribution line omitted (pre-consent).
    except Exception:
        pass  # No consent module → treat as pre-consent, omit the line.

    # Corpus + contribution count — reuse the prefetched reads; never block.
    # Un-prefetched / not-yet-resolved → None → corpus stays checking… (paint
    # never shifts layout: the status strings are label-column-fixed). node:
    # key never set → line omitted (see _status_lines).
    try:
        reads = get_splash_reads(timeout=0.0)
    except Exception:
        reads = None
    if reads is not None:
        if "corpus" in reads:
            state["corpus"] = reads["corpus"]
        if "corpus_count" in reads:
            state["corpus_count"] = reads["corpus_count"]
        # contribution_count only when contribution is on (renderer degrades to
        # 'on · traces published' without a count otherwise).
        if state.get("contribution") == "on" and "contribution_count" in reads:
            state["contribution_count"] = reads["contribution_count"]
    return state


def print_jinn_splash(force_fallback: bool = False) -> None:
    """Print the jinn splash to stdout in one paint (raw ANSI, no Rich)."""
    truecolor = (not force_fallback) and supports_truecolor()
    text = render_jinn_splash(gather_splash_state(), truecolor=truecolor)
    print(text)


# =========================================================================
# Skills scanning
# =========================================================================

def get_available_skills() -> Dict[str, List[str]]:
    """Return skills grouped by category, filtered by platform and disabled state.

    Delegates to ``_find_all_skills()`` from ``tools/skills_tool`` which already
    handles platform gating (``platforms:`` frontmatter) and respects the
    user's ``skills.disabled`` config list.
    """
    try:
        from tools.skills_tool import _find_all_skills
        all_skills = _find_all_skills()  # already filtered
    except Exception:
        return {}

    skills_by_category: Dict[str, List[str]] = {}
    for skill in all_skills:
        category = skill.get("category") or "general"
        skills_by_category.setdefault(category, []).append(skill["name"])
    return skills_by_category


# =========================================================================
# Update check
# =========================================================================

# Cache update check results for 6 hours to avoid repeated git fetches
_UPDATE_CHECK_CACHE_SECONDS = 6 * 3600

# Sentinel returned when we know an update exists but can't count commits
# (e.g. nix-built hermes — no local git history to count against).
UPDATE_AVAILABLE_NO_COUNT = -1

_UPSTREAM_REPO_URL = "https://github.com/NousResearch/hermes-agent.git"
_OFFICIAL_REPO_CANONICAL = "github.com/nousresearch/hermes-agent"


def _canonical_github_remote(url: str | None) -> str:
    """Return ``host/owner/repo`` for common GitHub remote URL forms."""
    if not url:
        return ""
    value = url.strip()
    if value.startswith("git@github.com:"):
        value = "github.com/" + value[len("git@github.com:"):]
    elif value.startswith("ssh://git@github.com/"):
        value = "github.com/" + value[len("ssh://git@github.com/"):]
    else:
        parsed = urlparse(value)
        if parsed.netloc and parsed.path:
            value = f"{parsed.netloc}{parsed.path}"
    value = value.strip().rstrip("/")
    if value.endswith(".git"):
        value = value[:-4]
    return value.lower()


def _is_ssh_remote(url: str | None) -> bool:
    if not url:
        return False
    value = url.strip().lower()
    return value.startswith("git@") or value.startswith("ssh://")


def _is_official_ssh_remote(url: str | None) -> bool:
    return _is_ssh_remote(url) and _canonical_github_remote(url) == _OFFICIAL_REPO_CANONICAL


def _git_stdout(args: list[str], *, cwd: Path, timeout: int = 5) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(cwd),
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return (result.stdout or "").strip()


def _check_via_rev(local_rev: str) -> Optional[int]:
    """Compare an embedded git revision to upstream main via ls-remote.

    Returns 0 if up-to-date, ``UPDATE_AVAILABLE_NO_COUNT`` if behind,
    or ``None`` on failure.
    """
    try:
        result = subprocess.run(
            ["git", "ls-remote", _UPSTREAM_REPO_URL, "refs/heads/main"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    if result.returncode != 0 or not result.stdout:
        return None
    upstream_rev = result.stdout.split()[0]
    if not upstream_rev:
        return None
    return 0 if upstream_rev == local_rev else UPDATE_AVAILABLE_NO_COUNT


def _check_via_local_git(repo_dir: Path) -> Optional[int]:
    """Count commits behind origin/main in a local checkout."""
    origin_url = _git_stdout(["remote", "get-url", "origin"], cwd=repo_dir)
    if _is_official_ssh_remote(origin_url):
        head_rev = _git_stdout(["rev-parse", "HEAD"], cwd=repo_dir)
        checked = _check_via_rev(head_rev) if head_rev else None
        if checked == UPDATE_AVAILABLE_NO_COUNT:
            return 1
        return checked

    # Installer checkouts are shallow (`git clone --depth 1`). On a shallow
    # clone the history stops at a single commit, so a plain `git fetch` would
    # unshallow the repo (dragging in the whole history) and
    # `rev-list --count HEAD..origin/main` would report a huge bogus "behind"
    # number (e.g. "12492 commits behind"). Detect shallow up front: fetch with
    # --depth 1 to preserve the boundary and compare tip SHAs instead of
    # counting. Full clones (developers, Docker dev images) keep the exact
    # count path unchanged. Mirrors the desktop fix in apps/desktop/electron/main.cjs.
    shallow = _git_stdout(["rev-parse", "--is-shallow-repository"], cwd=repo_dir)
    is_shallow = shallow == "true"

    try:
        fetch_args = ["git", "fetch", "origin"]
        if is_shallow:
            fetch_args += ["--depth", "1"]
        fetch_args.append("--quiet")
        subprocess.run(
            fetch_args,
            capture_output=True, timeout=10,
            cwd=str(repo_dir),
        )
    except Exception:
        pass  # Offline or timeout — use stale refs, that's fine

    if is_shallow:
        # No history to count across the shallow boundary. `origin/main` may not
        # be a tracking ref in a `clone --depth 1`, so prefer FETCH_HEAD (just
        # updated by the fetch above) and fall back to origin/main.
        head_rev = _git_stdout(["rev-parse", "HEAD"], cwd=repo_dir)
        target_rev = (
            _git_stdout(["rev-parse", "FETCH_HEAD"], cwd=repo_dir)
            or _git_stdout(["rev-parse", "origin/main"], cwd=repo_dir)
        )
        if not head_rev or not target_rev:
            return None
        return 0 if head_rev == target_rev else UPDATE_AVAILABLE_NO_COUNT

    try:
        result = subprocess.run(
            ["git", "rev-list", "--count", "HEAD..origin/main"],
            capture_output=True, text=True, timeout=5,
            cwd=str(repo_dir),
        )
        if result.returncode == 0:
            return int(result.stdout.strip())
    except Exception:
        pass
    return None


def _version_tuple(v: str) -> tuple[int, ...]:
    """Parse '0.13.0' into (0, 13, 0) for comparison. Non-numeric segments become 0."""
    parts = []
    for segment in v.split("."):
        try:
            parts.append(int(segment))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def _fetch_pypi_latest(package: str = "hermes-agent") -> Optional[str]:
    """Fetch the latest version of a package from PyPI. Returns None on failure."""
    try:
        import urllib.request
        url = f"https://pypi.org/pypi/{package}/json"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("info", {}).get("version")
    except Exception:
        return None


def check_via_pypi() -> Optional[int]:
    """Compare installed version against PyPI latest.

    Returns 0 if up-to-date, 1 if behind, None on failure.
    """
    latest = _fetch_pypi_latest()
    if latest is None:
        return None
    if latest == VERSION:
        return 0
    try:
        if _version_tuple(latest) > _version_tuple(VERSION):
            return 1
        return 0
    except Exception:
        return 1 if latest != VERSION else 0


def check_for_updates() -> Optional[int]:
    """Check whether a Hermes update is available.

    Two paths: if ``HERMES_REVISION`` is set (nix builds embed it), compare
    it to upstream main via ``git ls-remote``. Otherwise look for a local
    git checkout and count commits behind ``origin/main``.

    Returns the number of commits behind, ``UPDATE_AVAILABLE_NO_COUNT`` (-1)
    if behind but the count is unknown, ``0`` if up-to-date, or ``None`` if
    the check failed or doesn't apply. Cached for 6 hours.
    """
    hermes_home = get_hermes_home()
    cache_file = hermes_home / ".update_check"
    embedded_rev = os.environ.get("HERMES_REVISION") or None

    # Docker images have no working tree to count commits against — the
    # published image excludes `.git` (see .dockerignore) and sets no
    # HERMES_REVISION (that's nix-only). Without this guard the checks below
    # fall through to `check_via_pypi()`, whose PyPI-version mismatch flag (1)
    # then gets rendered by the CLI banner and the TUI badge as a phantom
    # "1 commit behind" — even though no git repo or commit math is involved,
    # and `hermes update` correctly refuses to run in-place inside the
    # container anyway. The dashboard's REST `/api/hermes/update/check`
    # endpoint already short-circuits docker the same way (web_server.py);
    # mirror that here so the banner/TUI surfaces agree. Returning None makes
    # both the Rich banner (build_welcome_banner) and the Ink badge
    # (branding.tsx, guarded on `typeof === 'number' && > 0`) show nothing.
    try:
        from hermes_cli.config import detect_install_method
        if detect_install_method() == "docker":
            return None
    except Exception:
        pass

    # Read cache — invalidate if the embedded rev OR installed version has
    # changed since the last check. The version guard matters for pip installs:
    # `check_via_pypi()` compares against VERSION, so a `pip install --upgrade`
    # changes VERSION but leaves rev unchanged (both None), and without this
    # the stale "behind" count would survive the upgrade for up to 6h. See #34491.
    now = time.time()
    try:
        if cache_file.exists():
            cached = json.loads(cache_file.read_text())
            if (
                now - cached.get("ts", 0) < _UPDATE_CHECK_CACHE_SECONDS
                and cached.get("rev") == embedded_rev
                and cached.get("ver") == VERSION
            ):
                return cached.get("behind")
    except Exception:
        pass

    if embedded_rev:
        behind = _check_via_rev(embedded_rev)
    else:
        # Prefer the running code's location over the profile-scoped path.
        # $HERMES_HOME/hermes-agent/ may be a stale copy from --clone-all;
        # Path(__file__) always resolves to the actual installed checkout.
        repo_dir = Path(__file__).parent.parent.resolve()
        if not (repo_dir / ".git").exists():
            repo_dir = hermes_home / "hermes-agent"
        if not (repo_dir / ".git").exists():
            behind = check_via_pypi()
        else:
            behind = _check_via_local_git(repo_dir)

    try:
        cache_file.write_text(
            json.dumps({"ts": now, "behind": behind, "rev": embedded_rev, "ver": VERSION})
        )
    except Exception:
        pass

    return behind


def _resolve_repo_dir() -> Optional[Path]:
    """Return the active Hermes git checkout, or None if this isn't a git install.

    Prefers the running code's location over the profile-scoped path
    because ``$HERMES_HOME/hermes-agent/`` may be a stale copy carried
    over by ``--clone-all``.
    """
    repo_dir = Path(__file__).parent.parent.resolve()
    if not (repo_dir / ".git").exists():
        hermes_home = get_hermes_home()
        repo_dir = hermes_home / "hermes-agent"
    return repo_dir if (repo_dir / ".git").exists() else None


def _git_short_hash(repo_dir: Path, rev: str) -> Optional[str]:
    """Resolve a git revision to an 8-character short hash."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=8", rev],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=str(repo_dir),
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    value = (result.stdout or "").strip()
    return value or None


def get_git_banner_state(repo_dir: Optional[Path] = None) -> Optional[dict]:
    """Return upstream/local git hashes for the startup banner.

    For source installs and dev images this runs ``git rev-parse`` against
    the active checkout.  When no checkout is available — the canonical case
    is the published Docker image, which excludes ``.git`` from the build
    context — we fall back to the baked-in build SHA (see
    ``hermes_cli/build_info.py``) and return it as a frozen
    ``upstream == local`` state with ``ahead=0``.  A built image is by
    definition pinned to one commit, so "ahead" is always zero and the
    banner correctly shows ``· upstream <sha>`` with no carried-commits
    annotation.
    """
    repo_dir = repo_dir or _resolve_repo_dir()
    if repo_dir is None:
        # No git checkout — try the baked build SHA (Docker image path).
        try:
            from hermes_cli.build_info import get_build_sha
            baked = get_build_sha(short=8)
            if baked:
                return {"upstream": baked, "local": baked, "ahead": 0}
        except Exception:
            pass
        return None

    upstream = _git_short_hash(repo_dir, "origin/main")
    local = _git_short_hash(repo_dir, "HEAD")
    if not upstream or not local:
        # Live-git lookup failed (e.g. shallow clone without origin/main).
        # Fall back to the baked build SHA if available.
        try:
            from hermes_cli.build_info import get_build_sha
            baked = get_build_sha(short=8)
            if baked:
                return {"upstream": baked, "local": baked, "ahead": 0}
        except Exception:
            pass
        return None

    ahead = 0
    try:
        result = subprocess.run(
            ["git", "rev-list", "--count", "origin/main..HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=str(repo_dir),
        )
        if result.returncode == 0:
            ahead = int((result.stdout or "0").strip() or "0")
    except Exception:
        ahead = 0

    return {"upstream": upstream, "local": local, "ahead": max(ahead, 0)}


_RELEASE_URL_BASE = "https://github.com/NousResearch/hermes-agent/releases/tag"
_latest_release_cache: Optional[tuple] = None  # (tag, url) once resolved


def get_latest_release_tag(repo_dir: Optional[Path] = None) -> Optional[tuple]:
    """Return ``(tag, release_url)`` for the latest git tag, or None.

    Local-only — runs ``git describe --tags --abbrev=0`` against the
    Hermes checkout. Cached per-process. Release URL always points at the
    canonical NousResearch/hermes-agent repo (forks don't get a link).
    """
    global _latest_release_cache
    if _latest_release_cache is not None:
        return _latest_release_cache or None

    repo_dir = repo_dir or _resolve_repo_dir()
    if repo_dir is None:
        _latest_release_cache = ()  # falsy sentinel — skip future lookups
        return None

    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            capture_output=True,
            text=True,
            timeout=3,
            cwd=str(repo_dir),
        )
    except Exception:
        _latest_release_cache = ()
        return None

    if result.returncode != 0:
        _latest_release_cache = ()
        return None

    tag = (result.stdout or "").strip()
    if not tag:
        _latest_release_cache = ()
        return None

    url = f"{_RELEASE_URL_BASE}/{tag}"
    _latest_release_cache = (tag, url)
    return _latest_release_cache


def format_banner_version_label() -> str:
    """Return the version label shown in the startup banner title.

    The agent name comes from the active skin (jinn-agent fork, mono#1358);
    the default skin's ``agent_name`` is "Hermes Agent", so default-skin
    output is unchanged. Degrades to the literal on any skin-engine error,
    matching the ``_skin_color`` precedent above.
    """
    try:
        from hermes_cli.skin_engine import get_active_skin
        agent_name = get_active_skin().get_branding("agent_name", "Hermes Agent")
    except Exception:
        agent_name = "Hermes Agent"
    base = f"{agent_name} v{VERSION} ({RELEASE_DATE})"
    state = get_git_banner_state()
    if not state:
        return base

    upstream = state["upstream"]
    local = state["local"]
    ahead = int(state.get("ahead") or 0)

    if ahead <= 0 or upstream == local:
        return f"{base} · upstream {upstream}"

    carried_word = "commit" if ahead == 1 else "commits"
    return f"{base} · upstream {upstream} · local {local} (+{ahead} carried {carried_word})"


# =========================================================================
# Non-blocking update check
# =========================================================================

_update_result: Optional[int] = None
_update_check_done = threading.Event()


def prefetch_update_check():
    """Kick off update check in a background daemon thread."""
    def _run():
        global _update_result
        _update_result = check_for_updates()
        _update_check_done.set()
    t = threading.Thread(target=_run, daemon=True)
    t.start()


def get_update_result(timeout: float = 0.5) -> Optional[int]:
    """Get result of prefetched check. Returns None if not ready."""
    _update_check_done.wait(timeout=timeout)
    return _update_result


# =========================================================================
# Non-blocking splash reads (corpus reachability+count, contribution count)
# =========================================================================

_splash_result: Optional[Dict[str, object]] = None
_splash_reads_done = threading.Event()


def _read_contribution_count() -> Optional[int]:
    """Published-trace count via jinn-layer ``ledger --json``, or None.

    Mirrors ``/jinn ledger``'s "N published" (ledger_view.render_ledger) and
    the ``onboarding.ledger_nonempty`` degrade rule: any layer error /
    unparseable output / unrecognised shape → None (never a false count, never
    raise). Stored raw — consent-gating is applied at merge time in
    ``gather_splash_state``.
    """
    try:
        from plugins.jinn import jinn_layer, ledger_view
        code, out, _err = jinn_layer.ledger_json()
        if code != 0:
            return None
        rows = ledger_view.rows_from_json(json.loads(out))
        if rows is None:
            return None
        return ledger_view.published_count(rows)
    except Exception:
        return None


def _read_corpus() -> Dict[str, object]:
    """Corpus reachability+count via ``corpus search '' --limit 500 --json``.

    exit 0 + a parseable JSON array → connected + len(hits); anything else →
    unreachable. NOTE: corpus_count is capped at the ``--limit`` (500) — the
    only corpus verb is ``search`` (no total-count/stats verb in harness-layer),
    so this is exact at testnet scale and under-reports past 500 records. A real
    total-count verb is the follow-up if/when mainnet scale demands it.
    """
    try:
        from plugins.jinn import jinn_layer
        code, out, _err = jinn_layer.corpus_search("", limit=500, as_json=True)
        if code == 0:
            hits = json.loads(out)
            if isinstance(hits, list):
                return {"corpus": "connected", "corpus_count": len(hits)}
    except Exception:
        pass
    return {"corpus": "unreachable"}


def prefetch_splash_reads():
    """Kick both splash subprocess reads in a background daemon thread."""
    def _run():
        global _splash_result
        result: Dict[str, object] = {}
        try:
            result.update(_read_corpus())
            cc = _read_contribution_count()
            if cc is not None:
                result["contribution_count"] = cc
        except Exception:
            pass  # never raise — publish whatever resolved, honest checking… for the rest
        _splash_result = result
        _splash_reads_done.set()
    t = threading.Thread(target=_run, daemon=True)
    t.start()


def get_splash_reads(timeout: float = 0.0) -> Optional[Dict[str, object]]:
    """Result of the prefetched reads, or None if unresolved. Never blocks at 0.0."""
    _splash_reads_done.wait(timeout=timeout)
    return _splash_result


# =========================================================================
# Welcome banner
# =========================================================================

def _format_context_length(tokens: int) -> str:
    """Format a token count for display (e.g. 128000 → '128K', 1048576 → '1M')."""
    if tokens >= 1_000_000:
        val = tokens / 1_000_000
        rounded = round(val)
        if abs(val - rounded) < 0.05:
            return f"{rounded}M"
        return f"{val:.1f}M"
    elif tokens >= 1_000:
        val = tokens / 1_000
        rounded = round(val)
        if abs(val - rounded) < 0.05:
            return f"{rounded}K"
        return f"{val:.1f}K"
    return str(tokens)


def _display_toolset_name(toolset_name: str) -> str:
    """Normalize internal/legacy toolset identifiers for banner display."""
    if not toolset_name:
        return "unknown"
    return (
        toolset_name[:-6]
        if toolset_name.endswith("_tools")
        else toolset_name
    )


def build_welcome_banner(console: "Console", model: str, cwd: str,
                         tools: List[dict] = None,
                         enabled_toolsets: List[str] = None,
                         session_id: str = None,
                         get_toolset_for_tool=None,
                         context_length: int = None,
                         provider: str = None):
    """Build and print a welcome banner with caduceus on left and info on right.

    Args:
        console: Rich Console instance.
        model: Current model name.
        cwd: Current working directory.
        tools: List of tool definitions.
        enabled_toolsets: List of enabled toolset names.
        session_id: Session identifier.
        get_toolset_for_tool: Callable to map tool name -> toolset name.
        context_length: Model's context window size in tokens.
        provider: Active provider id. When ``"moa"``, ``model`` is a MoA
            preset name and the banner renders the aggregator instead of a
            bare model slug.
    """
    from model_tools import check_tool_availability, TOOLSET_REQUIREMENTS
    from rich.panel import Panel
    from rich.table import Table
    if get_toolset_for_tool is None:
        from model_tools import get_toolset_for_tool

    tools = tools or []
    enabled_toolsets = enabled_toolsets or []

    _, unavailable_toolsets = check_tool_availability(quiet=True)
    # The availability check walks the GLOBAL toolset registry, so it includes
    # toolsets that aren't part of this agent's platform set at all (e.g.
    # `discord`, `feishu_doc` on a CLI session). Those must never surface in the
    # banner's "Available Tools" — they aren't exposed to the agent. Restrict to
    # toolsets actually enabled for this agent; a toolset that's enabled but
    # currently has unmet deps legitimately shows as disabled/lazy below.
    _enabled_ts = {str(t) for t in enabled_toolsets}
    if _enabled_ts:
        unavailable_toolsets = [
            item for item in unavailable_toolsets
            if str(item.get("id", item.get("name", ""))) in _enabled_ts
        ]
    disabled_tools = set()
    # Tools whose toolset has a check_fn are lazy-initialized (e.g. honcho,
    # homeassistant) — they show as unavailable at banner time because the
    # check hasn't run yet, but they aren't misconfigured.
    lazy_tools = set()
    for item in unavailable_toolsets:
        toolset_name = item.get("name", "")
        ts_req = TOOLSET_REQUIREMENTS.get(toolset_name, {})
        tools_in_ts = item.get("tools", [])
        if ts_req.get("check_fn"):
            lazy_tools.update(tools_in_ts)
        else:
            disabled_tools.update(tools_in_ts)

    layout_table = Table.grid(padding=(0, 2))
    layout_table.add_column("left", justify="center")
    layout_table.add_column("right", justify="left")

    # Resolve skin colors once for the entire banner
    accent = _skin_color("banner_accent", "#FFBF00")
    dim = _skin_color("banner_dim", "#B8860B")
    text = _skin_color("banner_text", "#FFF8DC")
    session_color = _skin_color("session_border", "#8B8682")

    # Use skin's custom caduceus art if provided
    try:
        from hermes_cli.skin_engine import get_active_skin
        _bskin = get_active_skin()
        _hero = _bskin.banner_hero if hasattr(_bskin, 'banner_hero') and _bskin.banner_hero else HERMES_CADUCEUS
        _credit = _bskin.get_branding("credit", "Nous Research")
    except Exception:
        _bskin = None
        _hero = HERMES_CADUCEUS
        _credit = "Nous Research"
    left_lines = ["", _hero, ""]
    # Skin-supplied credit line (jinn-agent fork, mono#1358). Rendered only
    # when non-empty so a blank credit can't leave a dangling '·' separator.
    _credit_seg = f" [dim {dim}]·[/] [dim {dim}]{_credit}[/]" if _credit else ""
    if (provider or "").strip().lower() == "moa":
        # MoA virtual provider: ``model`` is a preset name. Show the preset and
        # its aggregator so the banner is meaningful instead of a bare slug.
        preset_name = model
        agg_label = ""
        try:
            from hermes_cli.config import load_config
            from hermes_cli.moa_config import normalize_moa_config

            _moa = normalize_moa_config(load_config().get("moa") or {})
            _preset = _moa.get("presets", {}).get(preset_name)
            if _preset:
                _agg = _preset.get("aggregator") or {}
                _am = str(_agg.get("model") or "")
                agg_label = _am.split("/")[-1] if "/" in _am else _am
        except Exception:
            agg_label = ""
        if len(preset_name) > 28:
            preset_name = preset_name[:25] + "..."
        agg_str = f" [dim {dim}]·[/] [dim {dim}]agg {agg_label}[/]" if agg_label else ""
        ctx_str = f" [dim {dim}]·[/] [dim {dim}]{_format_context_length(context_length)} context[/]" if context_length else ""
        left_lines.append(f"[{accent}]MoA: {preset_name}[/]{agg_str}{ctx_str}{_credit_seg}")
    else:
        model_short = model.split("/")[-1] if "/" in model else model
        if model_short.endswith(".gguf"):
            model_short = model_short[:-5]
        if len(model_short) > 28:
            model_short = model_short[:25] + "..."
        ctx_str = f" [dim {dim}]·[/] [dim {dim}]{_format_context_length(context_length)} context[/]" if context_length else ""
        left_lines.append(f"[{accent}]{model_short}[/]{ctx_str}{_credit_seg}")

    if os.getenv("HERMES_YOLO_MODE"):
        left_lines.append(f"[bold red]⚠ YOLO mode[/] [dim {dim}]— all approval prompts bypassed[/]")
    left_lines.append(f"[dim {dim}]{cwd}[/]")
    if session_id:
        left_lines.append(f"[dim {session_color}]Session: {session_id}[/]")
    left_content = "\n".join(left_lines)

    right_lines = [f"[bold {accent}]Available Tools[/]"]
    toolsets_dict: Dict[str, list] = {}

    for tool in tools:
        tool_name = tool["function"]["name"]
        toolset = _display_toolset_name(get_toolset_for_tool(tool_name) or "other")
        toolsets_dict.setdefault(toolset, []).append(tool_name)

    for item in unavailable_toolsets:
        toolset_id = item.get("id", item.get("name", "unknown"))
        display_name = _display_toolset_name(toolset_id)
        if display_name not in toolsets_dict:
            toolsets_dict[display_name] = []
        for tool_name in item.get("tools", []):
            if tool_name not in toolsets_dict[display_name]:
                toolsets_dict[display_name].append(tool_name)

    sorted_toolsets = sorted(toolsets_dict.keys())
    display_toolsets = sorted_toolsets[:8]
    remaining_toolsets = len(sorted_toolsets) - 8

    for toolset in display_toolsets:
        tool_names = toolsets_dict[toolset]
        colored_names = []
        for name in sorted(tool_names):
            if name in disabled_tools:
                colored_names.append(f"[red]{name}[/]")
            elif name in lazy_tools:
                colored_names.append(f"[yellow]{name}[/]")
            else:
                colored_names.append(f"[{text}]{name}[/]")

        tools_str = ", ".join(colored_names)
        if len(", ".join(sorted(tool_names))) > 45:
            short_names = []
            length = 0
            for name in sorted(tool_names):
                if length + len(name) + 2 > 42:
                    short_names.append("...")
                    break
                short_names.append(name)
                length += len(name) + 2
            colored_names = []
            for name in short_names:
                if name == "...":
                    colored_names.append("[dim]...[/]")
                elif name in disabled_tools:
                    colored_names.append(f"[red]{name}[/]")
                elif name in lazy_tools:
                    colored_names.append(f"[yellow]{name}[/]")
                else:
                    colored_names.append(f"[{text}]{name}[/]")
            tools_str = ", ".join(colored_names)

        right_lines.append(f"[dim {dim}]{toolset}:[/] {tools_str}")

    if remaining_toolsets > 0:
        right_lines.append(f"[dim {dim}](and {remaining_toolsets} more toolsets...)[/]")

    # MCP Servers section (only if configured)
    try:
        from tools.mcp_tool import get_mcp_status
        mcp_status = get_mcp_status()
    except Exception:
        mcp_status = []

    if mcp_status:
        right_lines.append("")
        right_lines.append(f"[bold {accent}]MCP Servers[/]")
        for srv in mcp_status:
            status = srv.get("status")
            if srv["connected"]:
                right_lines.append(
                    f"[dim {dim}]{srv['name']}[/] [{text}]({srv['transport']})[/] "
                    f"[dim {dim}]—[/] [{text}]{srv['tools']} tool(s)[/]"
                )
            elif srv.get("disabled") or status == "disabled":
                right_lines.append(
                    f"[dim {dim}]{srv['name']}[/] [dim]({srv['transport']})[/] "
                    f"[dim {dim}]— disabled[/]"
                )
            elif status == "connecting":
                right_lines.append(
                    f"[dim {dim}]{srv['name']}[/] [dim]({srv['transport']})[/] "
                    f"[yellow]— connecting[/]"
                )
            elif status == "configured":
                right_lines.append(
                    f"[dim {dim}]{srv['name']}[/] [dim]({srv['transport']})[/] "
                    f"[dim {dim}]— configured[/]"
                )
            else:
                right_lines.append(
                    f"[red]{srv['name']}[/] [dim]({srv['transport']})[/] "
                    f"[red]— failed[/]"
                )

    right_lines.append("")
    right_lines.append(f"[bold {accent}]Available Skills[/]")
    # The skills catalog is only reachable when the `skills` toolset is enabled
    # (it exposes skill_view / skill_manage). When it's disabled — e.g. a Blank
    # Slate install — the agent literally cannot load any skill, so advertising
    # the on-disk catalog here is misleading. Reflect the real state instead.
    _skills_enabled = (not _enabled_ts) or ("skills" in _enabled_ts)
    if _skills_enabled:
        skills_by_category = get_available_skills()
        total_skills = sum(len(s) for s in skills_by_category.values())
    else:
        skills_by_category = {}
        total_skills = 0

    if not _skills_enabled:
        right_lines.append(f"[dim {dim}]Skills toolset disabled[/]")
    elif skills_by_category:
        for category in sorted(skills_by_category.keys()):
            skill_names = sorted(skills_by_category[category])
            if len(skill_names) > 8:
                display_names = skill_names[:8]
                skills_str = ", ".join(display_names) + f" +{len(skill_names) - 8} more"
            else:
                skills_str = ", ".join(skill_names)
            if len(skills_str) > 50:
                skills_str = skills_str[:47] + "..."
            right_lines.append(f"[dim {dim}]{category}:[/] [{text}]{skills_str}[/]")
    else:
        right_lines.append(f"[dim {dim}]No skills installed[/]")

    right_lines.append("")
    mcp_connected = sum(1 for s in mcp_status if s["connected"]) if mcp_status else 0
    summary_parts = [f"{len(tools)} tools", f"{total_skills} skills"]
    if mcp_connected:
        summary_parts.append(f"{mcp_connected} MCP servers")
    summary_parts.append("/help for commands")
    # Indicate when the codex_app_server runtime is active so users
    # understand why tool counts may not match what's actually reachable
    # (codex builds its own tool list inside the spawned subprocess).
    try:
        from hermes_cli.codex_runtime_switch import get_current_runtime
        from hermes_cli.config import load_config as _load_cfg
        if get_current_runtime(_load_cfg()) == "codex_app_server":
            right_lines.append(
                f"[bold {accent}]Runtime:[/] [{text}]codex app-server[/] "
                f"[dim {dim}](terminal/file ops/MCP run inside codex)[/]"
            )
    except Exception:
        pass
    # Show active profile name when not 'default'
    try:
        from hermes_cli.profiles import get_active_profile_name
        _profile_name = get_active_profile_name()
        if _profile_name and _profile_name != "default":
            right_lines.append(f"[bold {accent}]Profile:[/] [{text}]{_profile_name}[/]")
    except Exception:
        pass  # Never break the banner over a profiles.py bug

    right_lines.append(f"[dim {dim}]{' · '.join(summary_parts)}[/]")

    # Update check — use prefetched result if available
    try:
        behind = get_update_result(timeout=0.5)
        if behind is not None and behind != 0:
            from hermes_cli.config import get_managed_update_command, recommended_update_command
            if behind > 0:
                commits_word = "commit" if behind == 1 else "commits"
                right_lines.append(
                    f"[bold yellow]⚠ {behind} {commits_word} behind[/]"
                    f"[dim yellow] — run [bold]{recommended_update_command()}[/bold] to update[/]"
                )
            else:
                # UPDATE_AVAILABLE_NO_COUNT: nix-built hermes; we know an update
                # exists but not by how much, and we don't know how the user
                # installed it (nix run, profile, system flake, home-manager).
                managed_cmd = get_managed_update_command()
                line = "[bold yellow]⚠ update available[/]"
                if managed_cmd:
                    line += f"[dim yellow] — run [bold]{managed_cmd}[/bold][/]"
                right_lines.append(line)
    except Exception:
        pass  # Never break the banner over an update check

    # Pip-install warning — `pip install hermes-agent` is not the supported
    # install path (it exists on PyPI for internal/CI reasons, not end users).
    # Such installs miss the git checkout + installer-managed deps, so updates,
    # self-update, and issue triage don't behave correctly. Warn, don't block.
    try:
        from hermes_cli.config import detect_install_method
        if detect_install_method() == "pip":
            right_lines.append(
                "[bold yellow]⚠ pip install not officially supported[/]"
                "[dim yellow] — exists for reasons other than user install; "
                "expect instability and an inability to support issues[/]"
            )
    except Exception:
        pass  # Never break the banner over the install-method check

    right_content = "\n".join(right_lines)
    layout_table.add_row(left_content, right_content)

    title_color = _skin_color("banner_title", "#FFD700")
    border_color = _skin_color("banner_border", "#CD7F32")
    version_label = format_banner_version_label()
    release_info = get_latest_release_tag()
    if release_info:
        _tag, _url = release_info
        title_markup = f"[bold {title_color}][link={_url}]{version_label}[/link][/]"
    else:
        title_markup = f"[bold {title_color}]{version_label}[/]"
    outer_panel = Panel(
        layout_table,
        title=title_markup,
        border_style=border_color,
        padding=(0, 2),
    )

    console.print()
    term_width = shutil.get_terminal_size().columns
    if term_width >= 95:
        _logo = _bskin.banner_logo if _bskin and hasattr(_bskin, 'banner_logo') and _bskin.banner_logo else HERMES_AGENT_LOGO
        console.print(_logo)
        console.print()
    console.print(outer_panel)
