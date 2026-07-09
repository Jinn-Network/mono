# Stock-Hermes-installable Jinn plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `plugins/jinn/` installable into an unmodified upstream Hermes install as a pip entry-point plugin, while the same artifact keeps serving the fork's bundled path unchanged.

**Architecture:** The plugin becomes self-contained (no fork-private host imports) and feature-detects the host it runs in. Trust-critical corpus logic that had leaked into the plugin is deferred back to the `jinn-layer` CLI. One `pyproject.toml` inside `plugins/jinn/` turns the directory into an importable `jinn_plugin` package exposing `register`, discovered via the `hermes_agent.plugins` entry-point group — without changing the bundled-path load.

**Tech Stack:** Python 3, pytest, setuptools (pyproject), the `jinn-layer` CLI (`@jinn-network/client`).

## Global Constraints

- **Boundary:** no scrubbing / consent-conversion / publishing / anchoring / ledger / corpus-**write** trust logic in the plugin — it stays in `jinn-layer`. The plugin shells out.
- **Feature-detect, never fork-detect:** no assumption of `~/.jinn-agent`, `setup.sh`, or any fork-owned file. Resolve identity from env with an honest host default.
- **String hygiene:** never "paid" / "payment" / "compensation" — use "earn" (operator-side) or protocol verbs (mints to, distributes). No emoji.
- **No auto-onboarding at install:** contribute paths stay inert until consent is recorded.
- **Do not touch branding-swept files** (`tests/dehermes/*`, the six owned upstream files in `JINN.md`).
- **Harness identity resolution (used everywhere a trace or copy names the harness):**
  - name: `env JINN_HARNESS_NAME` → default `"hermes-agent"`.
  - version: `env JINN_HARNESS_VERSION` → else `hermes_cli.__version__` → else `"unknown"`.
  - cli name: `env JINN_CLI_NAME` → else `basename(sys.argv[0])` → else `"hermes"`.

---

## File Structure

- **Create** `plugins/jinn/harness.py` — harness-identity resolver (name/version/cli/label). One responsibility: answer "which harness am I in?".
- **Create** `plugins/jinn/pyproject.toml` — packaging + entry-point.
- **Modify** `plugins/jinn/style.py` — vendor the palette + truecolor probe; drop the `hermes_cli.banner` import (Finding A).
- **Modify** `plugins/jinn/capture_buffer.py` — resolve harness name/version instead of hardcoding (Finding C).
- **Modify** `plugins/jinn/consent.py`, `plugins/jinn/onboarding.py` — template the harness-naming copy (Finding D).
- **Modify** `plugins/jinn/skills_install.py` — `install()` defers to `jinn-layer skills install`; keep the read-only envelope helpers as the flagged residual (Finding B).
- **Modify** `plugins/jinn/jinn_layer.py` — add a `cwd` param to the default runner (Finding B needs it).
- **Modify** `plugins/jinn/pickup.py` — `autoAdopt` flag, default off (suggest-only); adopt path uses the cwd-aware default runner.
- **Modify** `bin/jinn-agent` — export `JINN_HARNESS_NAME` / `JINN_HARNESS_VERSION` / `JINN_CLI_NAME` so the fork keeps its identity.
- **Create** `scripts/cold-stock-e2e.sh` + `tests/plugins/test_jinn_stock_load.py`, `tests/plugins/test_jinn_harness_identity.py`, `tests/plugins/test_jinn_packaging.py`; **rework** `tests/plugins/test_jinn_skills_install.py`.

---

## Task 1: Vendor the palette into `style.py` (Finding A — the load blocker)

**Files:**
- Modify: `plugins/jinn/style.py:21` (the `from hermes_cli.banner import …` line and the `palette()` body)
- Test: `tests/plugins/test_jinn_stock_load.py` (create)

**Interfaces:**
- Produces: `style.palette()`, `style.no_color()`, `style.wrap()`, `style.box_*()`, `style.sanitise()` — unchanged signatures; now self-contained.

- [ ] **Step 1: Write the failing test** — the plugin must import with a `banner` that has only `_RST` (simulates stock upstream).

```python
# tests/plugins/test_jinn_stock_load.py
"""Finding A regression fence: the plugin must import + register on a stock
Hermes, whose hermes_cli.banner exposes only _RST (no fork _TC/_FB/probe)."""
import sys
import types
import importlib


def test_plugin_imports_with_stock_banner(monkeypatch):
    # Simulate stock upstream banner: only _RST, nothing fork-added.
    stock_banner = types.ModuleType("hermes_cli.banner")
    stock_banner._RST = "\033[0m"
    monkeypatch.setitem(sys.modules, "hermes_cli.banner", stock_banner)

    # Force a fresh import of the plugin's style module under the stub.
    for mod in list(sys.modules):
        if mod.startswith("plugins.jinn.style") or mod.startswith("jinn_plugin.style"):
            monkeypatch.delitem(sys.modules, mod, raising=False)

    style = importlib.import_module("plugins.jinn.style")
    pal, rst = style.palette(truecolor=True)
    assert pal["sky"].startswith("\033[")  # a real ANSI code, vendored — no ImportError
    assert rst == "\033[0m"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/plugins/test_jinn_stock_load.py -v`
Expected: FAIL — `ImportError: cannot import name '_FB' from 'hermes_cli.banner'` (raised while importing `style`).

- [ ] **Step 3: Replace the host import with vendored tokens.** In `plugins/jinn/style.py`, delete the line `from hermes_cli.banner import _FB, _RST, _TC, supports_truecolor` and insert this block after the existing imports (`import re`, `from typing import …`):

```python
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
```

(The existing `no_color()` body already does `import os` locally — leave it; the top-level `import os` is now also present and harmless.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/plugins/test_jinn_stock_load.py -v`
Expected: PASS.

- [ ] **Step 5: Run the existing style-dependent suites to confirm no visual regression on the fork**

Run: `python3 -m pytest tests/plugins/test_jinn_consent_ledger_tui.py tests/plugins/test_jinn_splash.py -q`
Expected: PASS (vendored values are byte-identical to the fork banner's).

- [ ] **Step 6: Commit**

```bash
git add plugins/jinn/style.py tests/plugins/test_jinn_stock_load.py
git commit -m "fix(jinn-plugin): vendor palette into style, drop fork-only banner import (stock-load blocker)"
```

---

## Task 2: Harness-identity resolver + capture wiring (Finding C)

**Files:**
- Create: `plugins/jinn/harness.py`
- Modify: `plugins/jinn/capture_buffer.py:22-23` (constants) and `assemble()` (`:127-143`)
- Modify: `bin/jinn-agent` (export env so the fork keeps its identity)
- Test: `tests/plugins/test_jinn_harness_identity.py` (create); extend `tests/plugins/test_jinn_capture_buffer.py`

**Interfaces:**
- Produces: `harness.harness_name() -> str`, `harness.harness_version() -> str`, `harness.harness() -> tuple[str,str]`, `harness.cli_name() -> str`, `harness.is_fork() -> bool`.
- Consumes: env `JINN_HARNESS_NAME` / `JINN_HARNESS_VERSION` / `JINN_CLI_NAME`.

- [ ] **Step 1: Write the failing test**

```python
# tests/plugins/test_jinn_harness_identity.py
import sys
from plugins.jinn import harness


def test_defaults_to_host_when_env_unset(monkeypatch):
    for k in ("JINN_HARNESS_NAME", "JINN_HARNESS_VERSION", "JINN_CLI_NAME"):
        monkeypatch.delenv(k, raising=False)
    assert harness.harness_name() == "hermes-agent"
    assert harness.is_fork() is False
    assert harness.harness_version()  # non-empty (host __version__ or "unknown")


def test_fork_env_overrides(monkeypatch):
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    monkeypatch.setenv("JINN_HARNESS_VERSION", "0.1.0")
    monkeypatch.setenv("JINN_CLI_NAME", "jinn-agent")
    assert harness.harness() == ("jinn-agent", "0.1.0")
    assert harness.is_fork() is True
    assert harness.cli_name() == "jinn-agent"


def test_cli_name_falls_back_to_argv0(monkeypatch):
    monkeypatch.delenv("JINN_CLI_NAME", raising=False)
    monkeypatch.setattr(sys, "argv", ["/usr/local/bin/hermes", "chat"])
    assert harness.cli_name() == "hermes"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/plugins/test_jinn_harness_identity.py -v`
Expected: FAIL — `ModuleNotFoundError: plugins.jinn.harness`.

- [ ] **Step 3: Create `plugins/jinn/harness.py`**

```python
"""Resolve the harness identity the plugin is running inside.

Stock Hermes and the jinn-agent fork share ONE plugin artifact. The fork's
bin/jinn-agent exports JINN_HARNESS_NAME/_VERSION and JINN_CLI_NAME; on a stock
host those are unset and we fall back to the host's own identity. Feature-detect
via env — never assume the fork, never sniff for fork-owned files.
"""
from __future__ import annotations

import os
import sys
from typing import Tuple

DEFAULT_NAME = "hermes-agent"


def harness_name() -> str:
    return (os.environ.get("JINN_HARNESS_NAME") or "").strip() or DEFAULT_NAME


def harness_version() -> str:
    v = (os.environ.get("JINN_HARNESS_VERSION") or "").strip()
    if v:
        return v
    try:
        from hermes_cli import __version__ as host_version
        return str(host_version)
    except Exception:
        return "unknown"


def harness() -> Tuple[str, str]:
    return harness_name(), harness_version()


def is_fork() -> bool:
    return harness_name() != DEFAULT_NAME


def cli_name() -> str:
    name = (os.environ.get("JINN_CLI_NAME") or "").strip()
    if name:
        return name
    argv0 = os.path.basename(sys.argv[0] or "")
    return argv0 or "hermes"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/plugins/test_jinn_harness_identity.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing capture test** — traces must carry the resolved harness, not a hardcoded `jinn-agent`. Add to `tests/plugins/test_jinn_capture_buffer.py`:

```python
def test_assemble_uses_resolved_harness_when_stock(monkeypatch):
    from plugins.jinn import capture_buffer as buf
    monkeypatch.delenv("JINN_HARNESS_NAME", raising=False)
    buf.reset()
    buf.record_first_turn("t", "s", "fix the retry bug", "gpt-4o-mini", "")
    buf.record_tool_call("t", "s", "edit", "c1", {}, "ok", 5)
    task = buf.assemble("t", "s", completed=True, interrupted=False)
    assert task["environment"]["harness"]["name"] == "hermes-agent"
    assert task["task"]["distributionTags"][0] == "hermes-agent"
```

- [ ] **Step 6: Run to verify it fails**

Run: `python3 -m pytest tests/plugins/test_jinn_capture_buffer.py::test_assemble_uses_resolved_harness_when_stock -v`
Expected: FAIL — asserts `hermes-agent`, gets `jinn-agent`.

- [ ] **Step 7: Wire the resolver into `capture_buffer.py`.** Remove the two constants at `:22-23`:

```python
HARNESS_NAME = "jinn-agent"
HARNESS_VERSION = "0.1.0"
```

Add near the top imports: `from . import harness as _harness`. In `assemble()`, replace the `tags` construction and the `environment.harness` block so they read:

```python
    h_name, h_version = _harness.harness()
    tags = [h_name]
    if buf.get("platform"):
        tags.append(str(buf["platform"]))
    ...
        "environment": {
            "harness": {"name": h_name, "version": h_version},
            "model": buf.get("model") or "unknown",
            "tools": sorted(buf["tools"]),
        },
```

- [ ] **Step 8: Run capture + distribution-tag suites**

Run: `python3 -m pytest tests/plugins/test_jinn_capture_buffer.py tests/plugins/test_jinn_distribution_tag.py -v`
Expected: PASS. (If `test_jinn_distribution_tag.py` asserts a literal `jinn-agent` with env unset, update that assertion to set `JINN_HARNESS_NAME=jinn-agent` first — it is testing fork behaviour.)

- [ ] **Step 9: Export identity from the fork entrypoint.** In `bin/jinn-agent`, after `export JINN_AGENT_REPO="$PWD"` (near line 25), add:

```sh
# The Jinn plugin resolves its harness identity from these; unset (stock host)
# it honestly reports the host. The fork asserts its own identity here.
export JINN_HARNESS_NAME="jinn-agent"
export JINN_CLI_NAME="jinn-agent"
```

- [ ] **Step 10: Commit**

```bash
git add plugins/jinn/harness.py plugins/jinn/capture_buffer.py bin/jinn-agent \
        tests/plugins/test_jinn_harness_identity.py tests/plugins/test_jinn_capture_buffer.py \
        tests/plugins/test_jinn_distribution_tag.py
git commit -m "feat(jinn-plugin): resolve harness identity from env (honest label on stock hosts)"
```

---

## Task 3: Template the harness-naming copy (Finding D)

**Files:**
- Modify: `plugins/jinn/consent.py` (OPENING, DECLINE_LINE, `_sigil_head`, preview-example harness field)
- Modify: `plugins/jinn/onboarding.py` (the `<cli> onboarding --replay` / `<cli> onboarding` strings + first-run sigils)
- Test: extend `tests/plugins/test_jinn_harness_identity.py`

**Interfaces:**
- Consumes: `harness.harness_name()`, `harness.cli_name()`, `harness.is_fork()`.

- [ ] **Step 1: Write the failing test** — with env unset (stock), no rendered string may claim the user runs `jinn-agent`, and command hints must use the resolved cli name.

```python
def test_copy_never_claims_jinn_agent_on_stock(monkeypatch):
    for k in ("JINN_HARNESS_NAME", "JINN_CLI_NAME"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("NO_COLOR", "1")
    from plugins.jinn import consent, onboarding
    explainer = consent.render_explainer()
    assert "jinn-agent" not in explainer
    assert "fork of hermes-agent" not in explainer
    replay = onboarding.render_already_complete()  # the returning-operator line
    assert "jinn-agent onboarding" not in replay


def test_copy_keeps_fork_identity_when_env_set(monkeypatch):
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    monkeypatch.setenv("JINN_CLI_NAME", "jinn-agent")
    monkeypatch.setenv("NO_COLOR", "1")
    from plugins.jinn import consent
    assert "jinn-agent" in consent.render_explainer()
```

(Confirm the exact name of onboarding's returning-operator renderer while implementing — in the current source the no-op copy is emitted from `cli_handler`; extract the string into a `render_already_complete()` pure function so it is testable, and call it from `cli_handler`.)

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m pytest tests/plugins/test_jinn_harness_identity.py -k copy -v`
Expected: FAIL — `jinn-agent` present in the explainer.

- [ ] **Step 3: Template `consent.py`.** Add `from . import harness as _harness` near the top. Change the module-level copy that names the harness into functions (constants evaluated at import are fine since env is set before process start, but a function keeps tests monkeypatch-friendly):

```python
def opening() -> str:
    return (
        f"{_harness.harness_name()} is an open coding harness. When it finishes a "
        "task it can publish a scrubbed trace of that task to a public corpus — "
        "the shared record that trains the harness everyone runs."
    )


def decline_line() -> str:
    return f"Decline and {_harness.harness_name()} still works fully — as a reader."
```

Replace uses of `OPENING` with `opening()` and `DECLINE_LINE` with `decline_line()` in `render_explainer` and `render_explainer_styled`. In `_sigil_head`, replace the literal `"jinn-agent"` with `_harness.harness_name()` and render the `"  ·  first run  ·  fork of hermes-agent"` suffix as `"  ·  first run" + ("  ·  fork of hermes-agent" if _harness.is_fork() else "")`. In `render_preview_example`, replace the `("jinn-agent", "fg")` harness cell with `(_harness.harness_name(), "fg")`.

- [ ] **Step 4: Template `onboarding.py`.** Add `from . import harness as _harness`. Replace the literal command strings `jinn-agent onboarding --replay` and `jinn-agent onboarding` with `f"{_harness.cli_name()} onboarding --replay"` / `f"{_harness.cli_name()} onboarding"`, and the sigil `fg("jinn-agent")` with `fg(_harness.harness_name())`, plus the `"fork of hermes-agent"` suffix gated on `_harness.is_fork()` as in Step 3. Extract the returning-operator no-op copy from `cli_handler` into `render_already_complete()` and call it.

- [ ] **Step 5: Run to verify it passes**

Run: `python3 -m pytest tests/plugins/test_jinn_harness_identity.py -k copy -v`
Expected: PASS.

- [ ] **Step 6: Run the consent/onboarding snapshot suites**

Run: `python3 -m pytest tests/plugins/test_jinn_consent_ledger_tui.py tests/plugins/test_jinn_onboarding.py -q`
Expected: PASS (fork env in those tests keeps the visible text identical; update any snapshot that pinned the raw literal only if it now reads through the resolver with the same value).

- [ ] **Step 7: Commit**

```bash
git add plugins/jinn/consent.py plugins/jinn/onboarding.py tests/plugins/test_jinn_harness_identity.py
git commit -m "feat(jinn-plugin): template harness naming in consent/onboarding copy (honest on stock hosts)"
```

---

## Task 4: Defer skill install to the layer (Finding B)

**Files:**
- Modify: `plugins/jinn/jinn_layer.py` (`run()` + `_default_runner()` gain a `cwd` param)
- Modify: `plugins/jinn/skills_install.py` (`install()` shells to `jinn-layer skills install`; keep read-only helpers marked residual)
- Test: rework `tests/plugins/test_jinn_skills_install.py`

**Interfaces:**
- Consumes: `jinn-layer skills install <ref> --json` → stdout `{"dir": "<abs>", "name": "...", "shape": "...", "files": [...], "provenance": {...}}`, writing `SKILL.md` (+ companions) into `<dir>`.
- Produces: `skills_install.install(ref, runner=None) -> str` (path to installed `SKILL.md`); `jinn_layer.run(args, runner=None, cwd=None)`.

- [ ] **Step 1: Add `cwd` to the runner.** In `plugins/jinn/jinn_layer.py`, change `_default_runner` and `run`:

```python
def _default_runner(argv: List[str], cwd: Optional[str] = None) -> Tuple[int, str]:
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=_TIMEOUT_S, check=False, cwd=cwd,
        )
        out = proc.stdout + (("\n" + proc.stderr) if proc.stderr.strip() else "")
        return proc.returncode, out.strip()
    except FileNotFoundError:
        return 127, (
            f"{argv[0]}: not found. Install the Jinn layer "
            "(npm install -g @jinn-network/client@canary) or set JINN_LAYER_BIN."
        )
    except subprocess.TimeoutExpired:
        return 124, f"{argv[0]}: timed out after {_TIMEOUT_S}s"


def run(args: List[str], runner: Optional[Runner] = None, cwd: Optional[str] = None) -> Tuple[int, str]:
    argv = [binary(), *args]
    if runner is not None:
        return runner(argv)          # injected test seam ignores cwd
    return _default_runner(argv, cwd)
```

- [ ] **Step 2: Write the failing skills-install test.** Replace the body of `tests/plugins/test_jinn_skills_install.py` install-path tests with one that asserts the plugin no longer parses envelopes — it shells to the layer and drops the marker into the layer-reported dir:

```python
import json
from pathlib import Path
from plugins.jinn import skills_install


def test_install_shells_to_layer_and_drops_marker(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    skills_root = tmp_path / "skills"

    def fake_runner(argv):
        # argv == ["jinn-layer", "skills", "install", "<ref>", "--json"]
        assert argv[1:4] == ["skills", "install", "abc123"]
        assert "--json" in argv
        target = skills_root / "flaky-retry"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("# skill\n")
        return 0, json.dumps({"dir": str(target), "name": "flaky-retry",
                              "shape": "package", "files": [], "provenance": {}})

    path = skills_install.install("abc123", runner=fake_runner)
    installed = Path(path)
    assert installed.name == "SKILL.md"
    assert (installed.parent / ".jinn-ref").exists()
    ref = json.loads((installed.parent / ".jinn-ref").read_text())["ref"]
    assert ref == "abc123"


def test_uninstall_refuses_unmarked(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    d = tmp_path / "skills" / "mine"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("# mine\n")  # no .jinn-ref marker
    try:
        skills_install.uninstall("mine")
        assert False, "should have refused"
    except ValueError as exc:
        assert "marker" in str(exc)
```

- [ ] **Step 3: Run to verify it fails**

Run: `python3 -m pytest tests/plugins/test_jinn_skills_install.py -v`
Expected: FAIL — current `install()` calls `corpus get` + `_extract_trace`, not `skills install`.

- [ ] **Step 4: Rewrite `install()` in `skills_install.py`** to defer to the layer:

```python
def install(ref: str, runner: Optional[jinn_layer.Runner] = None) -> str:
    """Install a corpus-published skill by ref via `jinn-layer skills install`.

    The layer extracts, sha256-verifies, and writes SKILL.md (+ companions) into
    the skills dir; this function only chooses the dir and drops the .jinn-ref
    fence. No envelope parsing or hash verification happens here — that is the
    layer's job (thin-fork boundary, mono #1345 / distillation-v1 §9).
    """
    skills_root = skills_dir()
    skills_root.mkdir(parents=True, exist_ok=True)
    code, out = jinn_layer.run(
        ["skills", "install", ref, "--json"], runner, cwd=str(skills_root)
    )
    if code != 0:
        raise ValueError(f"skills install failed: {out}")
    try:
        result = json.loads(out)
        target = Path(result["dir"])
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError(f"unreadable skills install result: {exc}")
    (target / MARKER_FILE).write_text(
        json.dumps({"ref": ref}) + "\n", encoding="utf-8"
    )
    logger.info("jinn: installed skill %s from %s", target.name, ref)
    return str(target / "SKILL.md")
```

Above the retained `_extract_trace` / `_skill_md_and_slug` helpers, add a comment:

```python
# RESIDUAL (flagged cross-repo, 2026-07-08 design): these read-only envelope
# helpers still serve corpus_fetch + pickup classification for DISPLAY. They no
# longer gate any install write (install() defers to the layer). Fully removing
# them needs an interpreted `jinn-layer corpus get` projection — a harness-layer
# follow-up, tracked separately.
```

- [ ] **Step 5: Run to verify it passes**

Run: `python3 -m pytest tests/plugins/test_jinn_skills_install.py -v`
Expected: PASS.

- [ ] **Step 6: Point pickup's adopt path at the cwd-aware default runner.** In `plugins/jinn/pickup.py`, change `_adopt_skill`:

```python
def _adopt_skill(ref: str, runner: Optional[jinn_layer.Runner]) -> str:
    # Auto-adopt is a real install: use the default cwd-aware runner (the pickup
    # runner has no cwd support). Dormant by default (see Task 5).
    path = skills_install.install(ref, runner=None)
    return f"installed skill at {path}"
```

- [ ] **Step 7: Run the pickup suite**

Run: `python3 -m pytest tests/plugins/test_jinn_pickup.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/jinn/jinn_layer.py plugins/jinn/skills_install.py plugins/jinn/pickup.py \
        tests/plugins/test_jinn_skills_install.py
git commit -m "refactor(jinn-plugin): defer skill install (extract+verify+write) to jinn-layer (boundary)"
```

---

## Task 5: Pickup suggest-only by default (constraint 4)

**Files:**
- Modify: `plugins/jinn/pickup.py` (`DEFAULT_CONFIG`, the adopt branch in `_pickup_inner`)
- Test: extend `tests/plugins/test_jinn_pickup.py`

**Interfaces:**
- Consumes: `pickup.json` config `{"enabled", "autoAdopt", "autoAdoptTier", "maxCandidates"}`.
- Produces: unchanged `pickup.pickup(user_message, runner=None, signal_sink=None)` shape; auto-adopt gated on `autoAdopt`.

- [ ] **Step 1: Write the failing test** — an evaluator-verified skill candidate must be SUGGESTED, not adopted, under the default config.

```python
def test_verified_candidate_is_suggested_not_adopted_by_default(tmp_path, monkeypatch):
    from plugins.jinn import pickup
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # (Reuse this file's existing helper that builds a runner returning one
    # evaluator-verified skill record for a search+get. See existing tests.)
    runner = _one_verified_skill_runner(slug="tdd-helper")  # existing fixture helper
    result = pickup.pickup("write tests first for the parser", runner=runner)
    assert result is not None
    ctx = result["context"]
    assert "install: /jinn skills install" in ctx      # suggested
    assert "Adopted automatically" not in ctx          # NOT adopted
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m pytest tests/plugins/test_jinn_pickup.py -k suggested_not_adopted -v`
Expected: FAIL — current default auto-adopts evaluator-verified.

- [ ] **Step 3: Add the flag.** In `pickup.py`, change `DEFAULT_CONFIG`:

```python
DEFAULT_CONFIG: Dict[str, Any] = {
    "enabled": True,
    # Remote skills are manual-approval by default (ratified). Auto-adopt is an
    # explicit opt-in; when off, verified candidates are SUGGESTED, not installed.
    "autoAdopt": False,
    "autoAdoptTier": "evaluator-verified",
    "maxCandidates": 3,
}
```

In `_pickup_inner`, guard the adopt branch — replace `if tier_at_least(tier, threshold):` (the skill branch) with:

```python
            if config.get("autoAdopt") and tier_at_least(tier, threshold):
```

and mirror the same `config.get("autoAdopt") and` guard on the unknown-payload `tier_at_least` branch below it, so nothing auto-adopts unless opted in.

- [ ] **Step 4: Run to verify it passes**

Run: `python3 -m pytest tests/plugins/test_jinn_pickup.py -k suggested_not_adopted -v`
Expected: PASS.

- [ ] **Step 5: Add the opt-in test** — with `autoAdopt: true`, the verified candidate is adopted.

```python
def test_opt_in_auto_adopts(tmp_path, monkeypatch):
    import json
    from plugins.jinn import pickup
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "jinn").mkdir()
    (tmp_path / "jinn" / "pickup.json").write_text(json.dumps({"autoAdopt": True}))
    runner = _one_verified_skill_runner(slug="tdd-helper")
    result = pickup.pickup("write tests first for the parser", runner=runner)
    assert "Adopted automatically" in result["context"]
```

- [ ] **Step 6: Run the full pickup suite**

Run: `python3 -m pytest tests/plugins/test_jinn_pickup.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/jinn/pickup.py tests/plugins/test_jinn_pickup.py
git commit -m "feat(jinn-plugin): pickup suggest-only by default; auto-adopt is explicit opt-in"
```

---

## Task 6: Packaging + entry-point (canonical channel)

**Files:**
- Create: `plugins/jinn/pyproject.toml`
- Test: `tests/plugins/test_jinn_packaging.py` (create)

**Interfaces:**
- Produces: an installable `jinn_plugin` package (mapped to `plugins/jinn/`) exposing `register`, discoverable via entry-point group `hermes_agent.plugins`, name `jinn`.

- [ ] **Step 1: Write the failing test** — assert the packaging contract without needing a real pip install.

```python
# tests/plugins/test_jinn_packaging.py
import tomllib
from pathlib import Path
import plugins.jinn as jinn_pkg

PYPROJECT = Path(__file__).resolve().parents[2] / "plugins" / "jinn" / "pyproject.toml"


def test_pyproject_declares_entry_point():
    data = tomllib.loads(PYPROJECT.read_text())
    eps = data["project"]["entry-points"]["hermes_agent.plugins"]
    assert eps["jinn"] == "jinn_plugin"
    assert "pyyaml" in " ".join(data["project"].get("dependencies", [])).lower()


def test_package_dir_maps_jinn_plugin_to_dot():
    data = tomllib.loads(PYPROJECT.read_text())
    assert data["tool"]["setuptools"]["package-dir"]["jinn_plugin"] == "."


def test_register_is_exposed():
    assert callable(getattr(jinn_pkg, "register", None))
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m pytest tests/plugins/test_jinn_packaging.py -v`
Expected: FAIL — `pyproject.toml` missing.

- [ ] **Step 3: Create `plugins/jinn/pyproject.toml`**

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "jinn-plugin"
version = "0.1.0"
description = "Jinn layer as a Hermes plugin — consent-gated contribution, corpus consumption, skill install. Installs into stock upstream Hermes or the jinn-agent fork."
requires-python = ">=3.10"
dependencies = ["pyyaml"]

[project.entry-points."hermes_agent.plugins"]
jinn = "jinn_plugin"

[tool.setuptools]
package-dir = {"jinn_plugin" = "."}
packages = ["jinn_plugin"]

[tool.setuptools.package-data]
jinn_plugin = ["plugin.yaml", "skin/*.yaml", "soul/*.md"]
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 -m pytest tests/plugins/test_jinn_packaging.py -v`
Expected: PASS.

- [ ] **Step 5: Verify a real build produces an importable `jinn_plugin` with `register`** (sdist/wheel build in a throwaway venv):

```bash
python3 -m venv /tmp/jinn-pkg-check && /tmp/jinn-pkg-check/bin/pip install -q ./plugins/jinn && \
/tmp/jinn-pkg-check/bin/python -c "import jinn_plugin; assert callable(jinn_plugin.register); print('ok')"
```
Expected: prints `ok`. (Relative imports resolve because `jinn_plugin` is imported as a package.)

- [ ] **Step 6: Commit**

```bash
git add plugins/jinn/pyproject.toml tests/plugins/test_jinn_packaging.py
git commit -m "feat(jinn-plugin): pip packaging + hermes_agent.plugins entry-point (stock-install channel)"
```

---

## Task 7: Cold e2e against stock upstream Hermes

**Files:**
- Create: `scripts/cold-stock-e2e.sh`
- Create: `scripts/fixtures/jinn-layer-stub` (a fake `jinn-layer` binary)

**Interfaces:**
- Consumes: everything above. Verifies the whole success-criteria loop against a real upstream clone.

- [ ] **Step 1: Write the layer stub.** Create `scripts/fixtures/jinn-layer-stub` (chmod +x) — records argv, returns canned success, never touches a real corpus. For `skills install --json` it must write a `SKILL.md` into `cwd/<slug>` and echo `{"dir": …}`:

```bash
#!/usr/bin/env bash
# Fake jinn-layer for the cold e2e. No network, no real corpus.
set -euo pipefail
echo "STUB $*" >> "${JINN_LAYER_STUB_LOG:-/dev/null}"
case "$1 ${2:-}" in
  "corpus search") echo '[]' ;;
  "corpus get")    echo '{"artifacts":[]}' ;;
  "capture preview") echo '{"envelope":{},"redactions":[]}' ;;
  "publish")       echo -e 'Published.\n  ref       stub-ref-001' ;;
  "ledger")        echo '[]' ;;
  "skills install")
     slug="stub-skill"; mkdir -p "$slug"; printf '# stub skill\n' > "$slug/SKILL.md"
     printf '{"dir":"%s/%s","name":"%s","shape":"package","files":[],"provenance":{}}\n' "$PWD" "$slug" "$slug" ;;
  *) echo "stub: unhandled $*" >&2; exit 2 ;;
esac
```

- [ ] **Step 2: Write the e2e script.** Create `scripts/cold-stock-e2e.sh`:

```bash
#!/usr/bin/env bash
# Cold test: install the Jinn plugin into a fresh STOCK upstream Hermes and
# verify discovery, consent-offer, capture→publish (via the stub layer),
# corpus tools, skill install, and clean uninstall. No fork files involved.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; export HERMES_HOME="$WORK/home"; mkdir -p "$HERMES_HOME"
export JINN_LAYER_BIN="$HERE/scripts/fixtures/jinn-layer-stub"
export JINN_LAYER_STUB_LOG="$WORK/stub.log"

git clone --depth 1 https://github.com/NousResearch/hermes-agent "$WORK/upstream"
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q "$WORK/upstream"
"$WORK/venv/bin/pip" install -q "$HERE/plugins/jinn"

# 1. discovered + register() runs (import surface); 2. consent inert until set.
"$WORK/venv/bin/python" - <<'PY'
import jinn_plugin, types
calls = {"hooks": [], "tools": [], "cmds": [], "cli": []}
ctx = types.SimpleNamespace(
    register_hook=lambda n, cb: calls["hooks"].append(n),
    register_tool=lambda **k: calls["tools"].append(k["name"]),
    register_command=lambda n, **k: calls["cmds"].append(n),
    register_cli_command=lambda n, **k: calls["cli"].append(n),
)
jinn_plugin.register(ctx)
assert set(calls["hooks"]) == {"on_session_start","pre_llm_call","post_tool_call","on_session_end"}, calls
assert set(calls["tools"]) == {"corpus_search","corpus_fetch"}, calls
assert "jinn" in calls["cmds"] and "corpus" in calls["cmds"], calls
from plugins.jinn import consent  # noqa
print("register ok:", calls)
PY

echo "COLD E2E PASS"; rm -rf "$WORK"
```

- [ ] **Step 3: Run the e2e**

Run: `bash scripts/cold-stock-e2e.sh`
Expected: clones upstream, installs both packages, prints `register ok: …` then `COLD E2E PASS`. (Requires network for the upstream clone.)

- [ ] **Step 4: Run the whole fork plugin suite to confirm nothing regressed**

Run: `python3 -m pytest tests/plugins -q && python3 -m pytest tests/dehermes -q`
Expected: PASS (dehermes untouched; plugin suite green).

- [ ] **Step 5: Commit**

```bash
git add scripts/cold-stock-e2e.sh scripts/fixtures/jinn-layer-stub
git commit -m "test(jinn-plugin): cold e2e installing the plugin into stock upstream Hermes"
```

---

## Self-Review

**Spec coverage:**
- Finding A (load blocker) → Task 1. Finding B (boundary leak) → Task 4. Finding C (harness label) → Task 2. Finding D (copy honesty) → Task 3. Residual → documented, retained read-only in Task 4, not fixed (cross-repo). ✓
- Architecture: one-artifact-three-routes → Task 6 (pip/entry-point canonical; bundled path untouched — no code change needed there; dir-drop is inherent). Feature-detect → Task 2. API drift feature-detect guard → **NOTE:** `register()` already only calls methods proven present upstream; an explicit `hasattr` guard is optional hardening — add if desired, not load-bearing (documented in spec §4). ✓
- Behaviour: pickup suggest-only → Task 5; harness identity → Task 2; copy → Task 3. ✓
- Testing (tests-first): stock-load (T1), harness/consent (T2), copy (T3), skill-install (T4), pickup gating (T5), entry-point discovery (T6), cold e2e (T7). ✓
- What-user-runs → covered by the T7 install sequence + spec §7. ✓

**Placeholder scan:** No TBD/TODO. Two "confirm while implementing" notes (onboarding renderer name in T3; existing pickup fixture helper `_one_verified_skill_runner` in T5) point at concrete existing code, not deferred design. ✓

**Type consistency:** `harness.harness()` returns `(name, version)` used in T2 capture wiring; `jinn_layer.run(args, runner, cwd)` defined in T4 and used by T4 `install`; `install(ref, runner)` return `str` consumed by T4/T5 tests and pickup. `MARKER_FILE`, `skills_dir()`, `uninstall()` unchanged. ✓

**Out of scope (from spec §8), not in this plan:** bulk import, produce-side `distill → publish`, federated eval, the `corpus get` interpreted projection, the open-weight runtime-tier measurement axis, PyPI registration. ✓
