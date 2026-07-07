"""jinn-agent's default session chrome must show jinn-agent branding.

Regression for Jinn-Network/mono#1358: a cold clone's first screen showed
the upstream agent's branding (NOUS/Hermes banner art, 'Nous Research'
credit, Hermes/OpenClaw tips). The fork ships a `jinn` skin
(``plugins/jinn/skin/jinn.yaml``, installed to ``$HERMES_HOME/skins/`` by
``bin/jinn-agent``) and two surgically-owned upstream files
(``hermes_cli/banner.py`` version label + credit, ``hermes_cli/tips.py``
brand-filter tail).

The skin fixture mirrors tests/test_cli_skin_integration.py: skin state is
the process-global ``_active_skin``, so teardown MUST reset to ``default``
or it poisons the rest of the suite.
"""

from __future__ import annotations

import re
import shutil as _shutil
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import yaml

# Import cli at module level (test_cli_skin_integration.py precedent):
# importing cli runs init_skin_from_config() as a module side effect, which
# would reset the active skin if the import happened inside a test body
# after the fixture activated the jinn skin.
from cli import _build_compact_banner  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
SKIN_FILE = REPO_ROOT / "plugins" / "jinn" / "skin" / "jinn.yaml"

# Upstream brand words that must never appear in jinn-agent session chrome.
# Lowercase `hermes` (command strings like `hermes update`) is functional,
# not branding, and is deliberately NOT matched.
BRAND_WORDS = re.compile(r"NOUS|Nous|\bHermes\b|OpenClaw")


@pytest.fixture()
def jinn_skin_active(tmp_path, monkeypatch):
    """Install the repo's jinn skin into an isolated home and activate it."""
    from hermes_cli.skin_engine import set_active_skin

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    skins = tmp_path / "skins"
    skins.mkdir()
    _shutil.copy(SKIN_FILE, skins / "jinn.yaml")
    set_active_skin("jinn")
    yield
    set_active_skin("default")


def test_jinn_skin_file_exists_and_is_complete():
    assert SKIN_FILE.is_file(), "plugins/jinn/skin/jinn.yaml is missing"
    raw = SKIN_FILE.read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    assert data["name"] == "jinn"

    branding = data.get("branding") or {}
    assert branding.get("agent_name") == "jinn-agent"
    for key in ("welcome", "goodbye", "response_label", "help_header",
                "prompt_symbol", "credit"):
        assert str(branding.get(key) or "").strip(), (
            f"branding.{key} must be set and non-empty "
            "(empty credit leaves a dangling '·' separator; the rest fall "
            "back to upstream Hermes strings)"
        )

    # banner_logo / banner_hero do NOT inherit through _build_skin_config —
    # an empty field falls back to the upstream Hermes art at render time
    # (skin_engine builds them from data.get(..., '') with no default merge).
    assert str(data.get("banner_logo") or "").strip(), "banner_logo required"
    assert str(data.get("banner_hero") or "").strip(), "banner_hero required"

    assert not BRAND_WORDS.search(raw), (
        f"upstream brand word in jinn.yaml: {BRAND_WORDS.search(raw).group(0)!r}"
    )


def test_version_label_uses_skin_agent_name(jinn_skin_active):
    from hermes_cli.banner import format_banner_version_label

    label = format_banner_version_label()
    assert label.startswith("jinn-agent v"), label


def test_compact_banner_clean(jinn_skin_active):
    from rich.console import Console

    with patch("cli.shutil.get_terminal_size",
               return_value=SimpleNamespace(columns=100)):
        banner = _build_compact_banner()

    console = Console(record=True, width=100)
    console.print(banner)
    text = console.export_text()

    assert "jinn-agent" in text
    assert not BRAND_WORDS.search(text), (
        f"upstream brand word in compact banner: "
        f"{BRAND_WORDS.search(text).group(0)!r}\n{text}"
    )


def test_full_welcome_banner_clean(jinn_skin_active):
    from rich.console import Console

    from hermes_cli.banner import build_welcome_banner
    from hermes_cli.skin_engine import get_active_skin

    console = Console(record=True, width=120)
    # Pin the terminal below the >=95-column logo threshold so the render is
    # deterministic; the logo/hero fields are asserted directly below.
    with patch("hermes_cli.banner.shutil.get_terminal_size",
               return_value=SimpleNamespace(columns=80)):
        build_welcome_banner(console, model="test-model", cwd=".", tools=[])
    text = console.export_text()

    assert "jinn-agent" in text
    assert not BRAND_WORDS.search(text), (
        f"upstream brand word in welcome banner: "
        f"{BRAND_WORDS.search(text).group(0)!r}\n{text}"
    )

    # The wide-terminal logo and the left-panel hero come straight from the
    # skin fields — assert the fields, not the width-gated render.
    skin = get_active_skin()
    assert not BRAND_WORDS.search(skin.banner_logo)
    assert not BRAND_WORDS.search(skin.banner_hero)


def test_welcome_line_from_skin(jinn_skin_active):
    from hermes_cli.skin_engine import get_active_skin

    welcome = get_active_skin().get_branding(
        "welcome",
        "Welcome to Hermes Agent! Type your message or /help for commands.",
    )
    assert "jinn-agent" in welcome
    assert not BRAND_WORDS.search(welcome)


def test_jinn_tips_list_has_no_upstream_branding():
    """THE pin for the acceptance criterion: deterministic full-list check."""
    from hermes_cli.tips import _JINN_TIPS

    branded = [t for t in _JINN_TIPS if BRAND_WORDS.search(t)]
    assert not branded, f"upstream brand words in _JINN_TIPS: {branded}"

    assert any("jinn-agent" in t for t in _JINN_TIPS), (
        "brand substitution produced no jinn-agent tips"
    )


def test_jinn_tips_have_no_home_hermes_paths():
    """mono#1366: jinn-agent state lives under ~/.jinn-agent (bin/jinn-agent
    exports HERMES_HOME) — tips must not point users at ~/.hermes/.
    Workspace-relative `.hermes/` references (no ~ prefix, e.g.
    '.hermes/plans/') are repo-local and intentionally untouched."""
    from hermes_cli.tips import _JINN_TIPS

    offenders = [t for t in _JINN_TIPS if "~/.hermes" in t]
    assert not offenders, f"home-dir hermes paths in _JINN_TIPS: {offenders}"
    assert any("~/.jinn-agent/" in t for t in _JINN_TIPS), (
        "path rewrite produced no ~/.jinn-agent/ tips"
    )


def test_jinn_tips_have_no_hermes_command_forms():
    """mono#1366: there is no `hermes` on PATH for jinn-agent users; the
    wrapper forwards subcommands, so `jinn-agent <subcmd>` is the invocable
    form. HERMES_* env var names and repo-local .hermes files stay."""
    import re as _re
    from hermes_cli.tips import _JINN_TIPS

    cmd_form = _re.compile(r"\bhermes (\w+)")
    offenders = [t for t in _JINN_TIPS if cmd_form.search(t)]
    assert not offenders, f"hermes command forms in _JINN_TIPS: {offenders}"
    assert any("jinn-agent config check" in t for t in _JINN_TIPS), (
        "command rewrite produced no jinn-agent command tips"
    )


def test_jinn_tips_fit_the_single_line_budget():
    """The rewrites lengthen tips (+4 chars each) — keep the upstream
    <= 150 char single-line budget; overflowing tips are dropped."""
    from hermes_cli.tips import _JINN_TIPS

    over = [t for t in _JINN_TIPS if len(t) > 150]
    assert not over, f"tips over 150 chars: {over}"


def test_random_tips_clean_under_jinn_skin(jinn_skin_active):
    import random

    from hermes_cli.tips import get_random_tip

    random.seed(1358)  # deterministic draws
    draws = [get_random_tip() for _ in range(200)]

    branded = [t for t in draws if BRAND_WORDS.search(t)]
    assert not branded, f"upstream brand words drawn under jinn skin: {branded}"

    assert any("jinn-agent" in t for t in draws), (
        "200 draws under the jinn skin produced no jinn-agent tip"
    )


def _non_docstring_string_literals(source: str):
    """Yield (lineno, value) for every string literal except docstrings.

    Runtime string literals in the jinn plugin are the pool every
    user-facing message is drawn from (help text, slash-command replies,
    error strings, f-string fragments), so pinning at the source level
    catches brand-word recurrences anywhere in the plugin. Docstrings are
    excluded: they are developer-facing and legitimately name the upstream
    agent when describing the fork relationship. Functional identifiers
    (``HERMES_HOME``, ``.hermes``, ``hermes_cli`` imports) don't trip the
    pin either — BRAND_WORDS matches the prose casing ``Hermes``, not the
    all-caps env var or lowercase command/path forms.
    """
    import ast

    tree = ast.parse(source)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef,
                             ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                docstrings.add(id(body[0].value))
    for node in ast.walk(tree):
        if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                and id(node) not in docstrings):
            yield node.lineno, node.value


def test_jinn_plugin_source_strings_have_no_upstream_branding():
    """Regression for Jinn-Network/mono#1371: `/jinn skills install`
    replied "Hermes's skill loader picks it up from here." — an upstream
    brand word on a Jinn-owned human-facing surface."""
    plugin_dir = REPO_ROOT / "plugins" / "jinn"
    offenders = []
    for py in sorted(plugin_dir.rglob("*.py")):
        source = py.read_text(encoding="utf-8")
        for lineno, value in _non_docstring_string_literals(source):
            match = BRAND_WORDS.search(value)
            if match:
                offenders.append(
                    f"{py.relative_to(REPO_ROOT)}:{lineno}: "
                    f"{match.group(0)!r} in {value!r}"
                )
    assert not offenders, (
        "upstream brand words in jinn plugin string literals:\n"
        + "\n".join(offenders)
    )


def test_default_skin_gets_untouched_upstream_tips():
    """An explicit `display.skin: default` must not mix jinn tips with the
    upstream Hermes banner — upstream TIPS stays unfiltered and draws come
    from it unchanged."""
    import random

    from hermes_cli.skin_engine import set_active_skin
    from hermes_cli.tips import _JINN_TIPS, TIPS, get_random_tip

    # Upstream list is unmodified at import time: the OpenClaw-era tips and
    # Nous tips are still present, and it is strictly larger than the
    # filtered fork list.
    assert any(re.search(r"claw", t, re.IGNORECASE) for t in TIPS), (
        "upstream TIPS was mutated: OpenClaw tips are gone"
    )
    assert any(re.search(r"Nous", t) for t in TIPS), (
        "upstream TIPS was mutated: Nous tips are gone"
    )
    assert len(TIPS) > len(_JINN_TIPS)

    set_active_skin("default")
    try:
        random.seed(1358)
        draws = [get_random_tip() for _ in range(200)]
        assert all(t in TIPS for t in draws), (
            "default skin drew a tip not in the upstream corpus"
        )
    finally:
        set_active_skin("default")
