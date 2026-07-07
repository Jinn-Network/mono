# jinn-agent into mono + CLI free of hermes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `jinn-agent` fork into this monorepo as `apps/jinn-agent/`, then finish making the CLI's main path free of any user-visible hermes branding.

**Architecture:** Two sequenced parts (Gall's Law — each independently shippable). Part 1 imports the fork as a squashed subtree and makes it run in its new home. Part 2 sweeps the ~34 remaining user-visible `hermes` strings out of core chrome, routing reachable surfaces through the existing skin brand accessor and hard-coding only argparse (which is built before the skin loads). The interactive first-run is already de-hermesed via the skin and is not touched.

**Tech Stack:** Python 3 (agent core, pytest, argparse), git subtree, GitHub Actions (mono per-package CI), the fork's existing skin engine (`hermes_cli/skin_engine.py`).

**Spec:** [`../specs/2026-07-07-agent-into-mono-and-cli-dehermes-design.md`](../specs/2026-07-07-agent-into-mono-and-cli-dehermes-design.md)

## Global Constraints

- **Main-path brand ban (G2):** no user-visible `Hermes` / `Hermes Agent` / `Nous` on install, first-run, `--help`, `--version`, `status`, `doctor`, `setup`, `auth`, `update`, `uninstall`. The env-var identifier `HERMES_HOME` and internal module names (`hermes_cli`, …) are technical, not branding — they are allowed.
- **Brand policy:** for reachable Python surfaces, substitute the literal `"Hermes Agent"` with `get_active_skin().get_branding("agent_name", "Hermes Agent")` — resolves to `"jinn-agent"` under the jinn skin, stays `"Hermes Agent"` under the `default` skin (byte-identical to upstream). Hard-code **only** argparse.
- **Command name is `jinn-agent`** (the real launcher `bin/jinn-agent`). Never tell a user to run `hermes` — it resolves to a different, upstream binary.
- **Do not** do a deep `hermes_* → jinn_*` rename; do not modify `plugins/jinn/` (already done), `locales/`, `website/` i18n, or vendored `dist/` assets.
- **Out of scope (accepted, not silently skipped):** degraded-path fallbacks (fire only on skin failure / the `default` skin), the Homebrew formula, upstream-attribution links.
- **Copy rules:** British English; **no emoji** (Jinn brand rule, per `plugins/jinn/skin/jinn.yaml`).
- **Cadence:** feature branch off mono `next`; PR into `next`. Conventional commits (`feat(jinn):`, `fix(jinn):`, `chore:`).

---

# Part 1 — Migration

### Task 1: Squash-subtree import of jinn-agent into `apps/jinn-agent/`

**Files:**
- Create: `apps/jinn-agent/**` (the entire imported tree)

**Interfaces:**
- Produces: a runnable fork at `apps/jinn-agent/` with launcher `apps/jinn-agent/bin/jinn-agent`.

- [ ] **Step 1: Branch off `next`**

```bash
cd <mono>
git fetch origin
git switch -c feat/agent-into-mono next
```

- [ ] **Step 2: Add the fork as a temporary remote and fetch its default branch**

```bash
# Source can be the local clone or the GitHub remote. Pin the SHA you import.
git remote add jinn-agent-src https://github.com/Jinn-Network/jinn-agent.git
git fetch jinn-agent-src main
git rev-parse jinn-agent-src/main   # record this SHA for the commit message
```

- [ ] **Step 3: Squash-import into `apps/jinn-agent/`**

```bash
git subtree add --prefix=apps/jinn-agent jinn-agent-src main --squash
```

Expected: one merge/import commit; `apps/jinn-agent/` now contains the fork tree.

- [ ] **Step 4: Remove the temporary remote and record provenance**

```bash
git remote remove jinn-agent-src
```

Amend the import commit message to name the source repo and pinned SHA (provenance; the old repo stays archived read-only for history/blame).

- [ ] **Step 5: Verify the import is present and history stayed linear**

```bash
test -x apps/jinn-agent/bin/jinn-agent && echo "launcher present"
git merge-base --is-ancestor origin/main HEAD && echo "main still ancestor: ok"
```

Expected: `launcher present` and `main still ancestor: ok`.

- [ ] **Step 6: Commit** (the subtree add already committed; nothing extra unless Step 4 amended)

---

### Task 2: Make the agent runnable in its new home (toolchain + smoke gate)

**Files:**
- Modify (only if required by the mono environment): `apps/jinn-agent/.envrc`, `apps/jinn-agent/README.md` (dev-setup note)

**Interfaces:**
- Produces: a working venv/toolchain under `apps/jinn-agent/` so Part 2 can invoke the CLI and run pytest.

- [ ] **Step 1: Create the venv and install the package** (the launcher prefers `venv/bin` then `.venv/bin`)

```bash
cd apps/jinn-agent
python3 -m venv venv
./venv/bin/pip install -e . -c constraints-termux.txt 2>/dev/null || ./venv/bin/pip install -e .
```

- [ ] **Step 2: Smoke-launch and confirm the jinn skin is active**

```bash
HERMES_HOME="$(mktemp -d)" ./bin/jinn-agent --version
HERMES_HOME="$(mktemp -d)" ./bin/jinn-agent --help | head -5
```

Expected: the CLI runs. (Both still say "Hermes Agent" at this point — that is Part 2's job. This step only proves it *runs* in mono.)

- [ ] **Step 3: Run a fast pytest subset to prove the harness works**

```bash
./venv/bin/python -m pytest tests/hermes_cli/ -q -x -k "status or parser or version" 2>&1 | tail -20
```

Expected: collected and passing (or the same pass/fail profile as in the source repo — record any pre-existing failures; do not fix unrelated ones here).

- [ ] **Step 4: Commit**

```bash
git add apps/jinn-agent/.envrc apps/jinn-agent/README.md 2>/dev/null; git commit -m "chore(jinn): make agent runnable under apps/jinn-agent in mono" || echo "no toolchain files changed"
```

---

### Task 3: Path-filtered CI + root-config isolation

**Files:**
- Create: `.github/workflows/jinn-agent-ci.yml`
- Verify (read-only): mono root `.dockerignore`, `.railwayignore`, any root `railway.toml`

**Interfaces:**
- Produces: CI that runs the agent's pytest on agent changes only.

- [ ] **Step 1: Add the workflow, mirroring the per-package pattern**

Model the structure on `.github/workflows/sdk-ci.yml` (triggers: `pull_request` + `push` to `next`), swapping Node steps for Python. It **must** be path-filtered so it fires only on agent changes and unrelated pipelines do not fire on agent changes:

```yaml
name: jinn-agent CI
on:
  push:
    branches: [next, main]
    paths: ['apps/jinn-agent/**']
  pull_request:
    paths: ['apps/jinn-agent/**']
jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/jinn-agent
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: python -m venv venv && ./venv/bin/pip install -e .
      - run: ./venv/bin/python -m pytest tests/hermes_cli/ -q
```

- [ ] **Step 2: Confirm no root-config bleed** (mono was burned by a global `railway.toml` — issue #846)

```bash
cd <mono>
grep -rl "apps/jinn-agent" railway.toml .dockerignore .railwayignore 2>/dev/null && echo "REVIEW: root config references the agent" || echo "clean: no root config captures the agent"
```

Expected: `clean`. If a root config globs the agent in, scope it out (keep agent config inside `apps/jinn-agent/`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/jinn-agent-ci.yml
git commit -m "ci(jinn): path-filtered CI for apps/jinn-agent"
```

**Part 1 done when:** a fresh mono clone can `pip install -e apps/jinn-agent` and launch `apps/jinn-agent/bin/jinn-agent`, the new CI is green, and mono's existing CI is unaffected.

---

# Part 2 — CLI free of hermes

> All Part 2 paths are under `apps/jinn-agent/`. Omit the prefix below for brevity; every path is relative to `apps/jinn-agent/`.

### Task 4: Foundation — brand test utility + titled-box helper

**Files:**
- Create: `tests/dehermes/__init__.py`, `tests/dehermes/brandcheck.py`
- Modify: `hermes_cli/status.py` (add a shared titled-box renderer, or reuse if one exists)

**Interfaces:**
- Produces:
  - `assert_no_upstream_brand(text: str) -> None` — fails if user-visible hermes/nous branding is present (ignores technical tokens `HERMES_*`, `.hermes`, `hermes_*`).
  - `run_cli(*args, home: str) -> str` — execs `bin/jinn-agent` with a throwaway `HERMES_HOME`, returns combined stdout+stderr.
  - `titled_box(title: str, width: int = 57) -> list[str]` — three lines (top border, centred title, bottom border) that re-centre for any brand width.

- [ ] **Step 1: Write the brand-check utility**

```python
# tests/dehermes/brandcheck.py
import os, re, subprocess, sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]          # apps/jinn-agent/
_BIN = _REPO / "bin" / "jinn-agent"
# Technical tokens that are NOT branding and are allowed on screen:
_TECHNICAL = re.compile(r"HERMES_[A-Z0-9_]+|\.hermes\b|hermes_[a-z0-9_]+")
_BRAND_WORDS = ("hermes", "nous")

def strip_technical(text: str) -> str:
    return _TECHNICAL.sub("", text)

def assert_no_upstream_brand(text: str) -> None:
    cleaned = strip_technical(text).lower()
    for w in _BRAND_WORDS:
        i = cleaned.find(w)
        assert i == -1, f"upstream brand {w!r} leaked: ...{cleaned[max(0,i-40):i+40]!r}..."

def run_cli(*args: str, home: str) -> str:
    env = {**os.environ, "HERMES_HOME": home}
    env.pop("JINN_AGENT_HOME", None)
    p = subprocess.run([str(_BIN), *args], env=env, capture_output=True, text=True, timeout=120)
    return p.stdout + p.stderr
```

- [ ] **Step 2: Self-test the utility**

```python
# tests/dehermes/test_brandcheck.py
from tests.dehermes.brandcheck import assert_no_upstream_brand
import pytest

def test_allows_technical_tokens():
    assert_no_upstream_brand("HERMES_HOME=/x  module hermes_cli loaded")   # no raise

def test_flags_branding():
    with pytest.raises(AssertionError):
        assert_no_upstream_brand("Welcome to Hermes Agent!")
```

Run: `./venv/bin/python -m pytest tests/dehermes/test_brandcheck.py -v` — Expected: PASS.

- [ ] **Step 3: Add a reusable titled-box helper** (first `grep -rn "def .*box" hermes_cli/` — if a boxed-title renderer already exists, reuse it and skip this)

```python
# hermes_cli/status.py (module level, near the top)
def titled_box(title: str, width: int = 57) -> list[str]:
    """Three box lines with the title centred — brand-width agnostic."""
    inner = title[: width]
    pad = width - len(inner)
    left = pad // 2
    return [
        "┌" + "─" * width + "┐",
        "│" + " " * left + inner + " " * (pad - left) + "│",
        "└" + "─" * width + "┘",
    ]
```

- [ ] **Step 4: Commit**

```bash
git add tests/dehermes hermes_cli/status.py
git commit -m "test(jinn): brand-check utility + titled-box helper for de-hermes sweep"
```

---

### Task 5: argparse — `prog`, description, epilog (highest-value; hard-coded)

**Files:**
- Modify: `hermes_cli/_parser.py:40-96`
- Test: `tests/dehermes/test_help.py`

**Interfaces:**
- Consumes: `assert_no_upstream_brand`, `run_cli` (Task 4).

- [ ] **Step 1: Write the failing tests**

```python
# tests/dehermes/test_help.py
from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

def test_top_level_help_is_hermes_free(tmp_path):
    out = run_cli("--help", home=str(tmp_path))
    assert_no_upstream_brand(out)
    assert "jinn-agent" in out.lower()

def test_help_examples_use_the_real_command(tmp_path):
    out = run_cli("--help", home=str(tmp_path))
    assert "\n    hermes " not in out            # no example tells the user to run `hermes`
```

Run: `./venv/bin/python -m pytest tests/dehermes/test_help.py -v` — Expected: FAIL (`prog="hermes"`, epilog says `hermes …`).

- [ ] **Step 2: Rewrite the parser strings** (hard-coded — argparse builds before the skin loads; `prog` must be the real command)

In `hermes_cli/_parser.py`:
- Line 92: `prog="hermes"` → `prog="jinn-agent"`
- Line 93: `description="Hermes Agent - AI assistant with tool-calling capabilities"` → `description="jinn-agent - AI assistant with tool-calling capabilities"`
- `_EPILOGUE` (lines 40-81): replace every leading `hermes ` with `jinn-agent `. **Two care points:** (a) line 63 `hermes -s hermes-agent-dev,github-auth` — rewrite to `jinn-agent -s dev-tools,github-auth` (the branded toolset name is illustrative; keep the example brand-free); (b) line 80 `hermes <command> --help` → `jinn-agent <command> --help`.

- [ ] **Step 3: Run tests** — `./venv/bin/python -m pytest tests/dehermes/test_help.py -v` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add hermes_cli/_parser.py tests/dehermes/test_help.py
git commit -m "fix(jinn): argparse prog/description/epilog say jinn-agent, not hermes"
```

---

### Task 6: `--version`, `status`, `doctor` (invocable surfaces; guarded)

**Files:**
- Modify: `hermes_cli/main.py:233`, `cli.py:3499`, `hermes_cli/status.py:106,111,238`, `hermes_cli/doctor.py:557`
- Test: `tests/dehermes/test_status_version.py`

**Interfaces:**
- Consumes: `assert_no_upstream_brand`, `run_cli`, `titled_box`, `get_active_skin`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/dehermes/test_status_version.py
from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

def test_version_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("--version", home=str(tmp_path)))

def test_status_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("status", home=str(tmp_path)))

def test_doctor_is_hermes_free(tmp_path):
    assert_no_upstream_brand(run_cli("doctor", home=str(tmp_path)))
```

Run — Expected: FAIL (headers say "Hermes Agent Status", "Hermes Doctor", version says "Hermes Agent v…").

- [ ] **Step 2: Guard the version strings**

- `hermes_cli/main.py:233`: `print(f"Hermes Agent v{__version__} …")` → use the brand accessor:
  ```python
  from hermes_cli.skin_engine import get_active_skin
  _brand = get_active_skin().get_branding("agent_name", "Hermes Agent")
  print(f"{_brand} v{__version__} …")   # keep the rest of the original line verbatim
  ```
- `cli.py:3499` (`HERMES_FAST_STARTUP_BANNER` version line): same substitution — `f"{get_active_skin().get_branding('agent_name','Hermes Agent')} v{_version} …"`.

- [ ] **Step 3: Guard the boxed headers via `titled_box`**

- `hermes_cli/status.py:109-112`: replace the three hand-drawn box lines with:
  ```python
  from hermes_cli.skin_engine import get_active_skin
  for _line in titled_box(f"⚕ {get_active_skin().get_branding('agent_name','Hermes Agent')} Status"):
      print(color(_line, Colors.CYAN))
  ```
  (Under the jinn skin the "⚕" is fine to drop if the skin art omits it — match the jinn splash convention; verify no emoji rule violation.)
- `hermes_cli/status.py:106` docstring `"Show status of all Hermes Agent components."` → `"Show status of all jinn-agent components."`
- `hermes_cli/status.py:238` `"not logged in (run: hermes portal)"` → `"not logged in (run: jinn-agent portal)"`.
- `hermes_cli/doctor.py:557`: same `titled_box` treatment for the "Hermes Doctor" header.

- [ ] **Step 4: Run tests** — Expected: PASS. Also eyeball the box alignment: `HERMES_HOME=$(mktemp -d) ./bin/jinn-agent status | head -4` (borders must line up).

- [ ] **Step 5: Commit**

```bash
git add hermes_cli/main.py cli.py hermes_cli/status.py hermes_cli/doctor.py tests/dehermes/test_status_version.py
git commit -m "fix(jinn): version/status/doctor read the skin brand, not hardcoded Hermes"
```

---

### Task 7: setup / config / tools-config wizard headers (guarded)

**Files:**
- Modify: `hermes_cli/setup.py:2825,2861,2872`, `hermes_cli/config.py:7493`, `hermes_cli/tools_config.py:3761`
- Test: `tests/dehermes/test_setup_wizard.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/dehermes/test_setup_wizard.py
import subprocess, sys, os
from pathlib import Path
from tests.dehermes.brandcheck import assert_no_upstream_brand
_REPO = Path(__file__).resolve().parents[2]

def _wizard_header_text():
    # The wizard headers are module-level constants/f-strings; assert on the rendered
    # header without launching interactive input. Drive the header builder directly:
    import importlib, io, contextlib
    os.environ["HERMES_HOME"] = os.environ.get("HERMES_HOME") or "/tmp/jinn-test"
    from hermes_cli import setup as s
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        s._print_setup_header() if hasattr(s, "_print_setup_header") else None
    return buf.getvalue()

def test_setup_header_is_hermes_free():
    # If the header isn't isolatable, assert on the source constant instead:
    src = (_REPO / "hermes_cli" / "setup.py").read_text()
    for line in ("Hermes Agent Setup Wizard", "configure your Hermes Agent", "Hermes Setup"):
        assert line not in src, f"leftover wizard branding: {line!r}"
```

Run — Expected: FAIL.

- [ ] **Step 2: Guard each header** using the same accessor pattern

Replace the literal `"Hermes Agent"` / `"Hermes"` inside each wizard header with `get_active_skin().get_branding("agent_name", "Hermes Agent")`. Where the header is a fixed-width box, use `titled_box` (Task 4). Exact sites: `setup.py:2825` ("Hermes Setup"), `setup.py:2861` ("Hermes Agent Setup Wizard"), `setup.py:2872` ("Let's configure your Hermes Agent installation."), `config.py:7493` ("Hermes Configuration"), `tools_config.py:3761` ("Hermes Tool Configuration").

- [ ] **Step 3: Run test** — Expected: PASS.

- [ ] **Step 4: Commit** — `git commit -m "fix(jinn): setup/config wizard headers read the skin brand"`

---

### Task 8: post-install bootstrap, update flow, auth/login (guarded)

**Files:**
- Modify: `hermes_cli/main.py:2655,2662,2703,8405,9216`, `hermes_cli/cli_commands_mixin.py:2689`, `hermes_cli/auth.py` (search-driven)
- Test: `tests/dehermes/test_auth_update.py`

- [ ] **Step 1: Write the failing test** (auth is invocable in a no-op mode; update/bootstrap assert on source constants)

```python
# tests/dehermes/test_auth_update.py
from pathlib import Path
_REPO = Path(__file__).resolve().parents[2]

def test_no_hermes_in_user_facing_prints():
    # These strings are printed to users; none may carry upstream branding.
    banned = [
        ("hermes_cli/main.py",   ["Hermes post-install bootstrap", "Updating Hermes Agent", "prefixed with 'Hermes Agent'"]),
        ("hermes_cli/cli_commands_mixin.py", ["Update Hermes Agent"]),
        ("hermes_cli/auth.py",   ["authorize Hermes", "Starting Hermes login", "to use Hermes."]),
    ]
    for rel, phrases in banned:
        src = (_REPO / rel).read_text()
        for p in phrases:
            assert p not in src, f"{rel}: leftover {p!r}"
```

Run — Expected: FAIL.

- [ ] **Step 2: Replace each print string** with the guarded accessor (`get_active_skin().get_branding("agent_name","Hermes Agent")`) interpolated into the message. For the auth strings, `grep -n "Hermes" hermes_cli/auth.py` to get exact current lines (the map's line numbers are approximate); replace the branding token only, leaving provider/URL text intact.

- [ ] **Step 3: Run test** — Expected: PASS. Smoke: `HERMES_HOME=$(mktemp -d) ./bin/jinn-agent auth --help` is hermes-free.

- [ ] **Step 4: Commit** — `git commit -m "fix(jinn): bootstrap/update/auth messages read the skin brand"`

---

### Task 9: uninstall, gateway wizard, `cli.py` docstrings, `setup-hermes.sh` commands

**Files:**
- Modify: `hermes_cli/uninstall.py:604,882`, `hermes_cli/gateway.py:4691`, `cli.py:3` (+ other module docstrings), `setup-hermes.sh:59,406,428`
- Test: `tests/dehermes/test_uninstall_installer.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/dehermes/test_uninstall_installer.py
from pathlib import Path
_REPO = Path(__file__).resolve().parents[2]

def test_uninstall_and_installer_commands_hermes_free():
    checks = {
        "hermes_cli/uninstall.py": ["Hermes Agent Uninstaller", "Thank you for using Hermes Agent"],
        "cli.py": ["Hermes Agent CLI - Interactive Terminal Interface"],
        # installer must not tell users to run the `hermes` binary:
        "setup-hermes.sh": ["`hermes setup`", "run: hermes", "hermes setup"],
    }
    for rel, phrases in checks.items():
        src = (_REPO / rel).read_text()
        for p in phrases:
            assert p not in src, f"{rel}: leftover {p!r}"
```

Run — Expected: FAIL.

- [ ] **Step 2: Apply edits**
- `uninstall.py:604` header → `titled_box` with the guarded brand; `uninstall.py:882` goodbye → guarded brand.
- `gateway.py:4691` "Hermes Gateway Starting" → guarded brand + `titled_box` if boxed.
- `cli.py:3` module docstring "Hermes Agent CLI - Interactive Terminal Interface" → "jinn-agent CLI - Interactive Terminal Interface" (source/IDE only; plain text replace). Repeat for the other docstring lines the map flags (`cli.py:3676,15640`).
- `setup-hermes.sh`: rewrite the **printed next-step commands** so scrollback tells users the right binary — `hermes setup` → `jinn-agent setup`, bare `hermes` next-step → `jinn-agent` (lines ~406, ~428). Leave internal mechanics (paths like `~/.hermes/skills/` are covered by the launcher's `HERMES_HOME` and are technical, not next-step commands). The `setup.sh` bookend already frames the header at line 59.

- [ ] **Step 3: Run test** — Expected: PASS.

- [ ] **Step 4: Commit** — `git commit -m "fix(jinn): uninstall/gateway/docstrings/installer commands say jinn-agent"`

---

### Task 10: Final acceptance gate — full main-path sweep (G2) + coexistence (G1)

**Files:**
- Create: `tests/dehermes/test_main_path_acceptance.py`

**Interfaces:**
- Consumes: `assert_no_upstream_brand`, `run_cli`.

- [ ] **Step 1: Write the whole-main-path acceptance test** (this is the G2 success criterion; it also catches any string earlier tasks missed)

```python
# tests/dehermes/test_main_path_acceptance.py
import subprocess
from pathlib import Path
import pytest
from tests.dehermes.brandcheck import assert_no_upstream_brand, run_cli

MAIN_PATH_INVOCATIONS = ["--help", "--version", "status", "doctor", "config", "auth --help", "update --help"]

@pytest.mark.parametrize("argline", MAIN_PATH_INVOCATIONS)
def test_main_path_surface_is_hermes_free(argline, tmp_path):
    assert_no_upstream_brand(run_cli(*argline.split(), home=str(tmp_path)))

def test_every_subcommand_help_is_hermes_free(tmp_path):
    top = run_cli("--help", home=str(tmp_path))
    # crude subcommand scrape from the help output; assert each subcommand --help is clean
    import re
    subs = set(re.findall(r"^\s{2,}([a-z][a-z-]{2,})\s{2,}\S", top, re.M))
    for s in sorted(subs):
        assert_no_upstream_brand(run_cli(s, "--help", home=str(tmp_path)))
```

- [ ] **Step 2: Run it and drive any residuals to green**

```bash
./venv/bin/python -m pytest tests/dehermes/ -q
```

Expected: PASS. If a subcommand help still leaks branding, locate it (`grep -rn "Hermes" hermes_cli/subcommands/`) and apply the guarded substitution; re-run until green.

- [ ] **Step 3: Coexistence test (G1)** — a stock-hermes user is unaffected

```python
# append to test_main_path_acceptance.py
import os
def test_coexistence_default_home_is_isolated(tmp_path, monkeypatch):
    # jinn-agent must default to ~/.jinn-agent, never ~/.hermes, when neither env var is set.
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.delenv("JINN_AGENT_HOME", raising=False)
    launcher = Path(__file__).resolve().parents[2] / "bin" / "jinn-agent"
    text = launcher.read_text()
    assert ".jinn-agent" in text and 'JINN_AGENT_HOME' in text   # isolation contract intact
```

- [ ] **Step 4: Commit**

```bash
git add tests/dehermes/test_main_path_acceptance.py
git commit -m "test(jinn): main-path acceptance gate — CLI is free of hermes branding"
```

**Part 2 done when:** `pytest tests/dehermes/` is green — every main-path surface renders no user-visible hermes/nous branding, help examples name `jinn-agent`, and the coexistence contract holds.

---

## Self-review notes (spec coverage)

- G1 coexistence → Task 10 Step 3 (+ already built in `bin/jinn-agent`).
- G2 no-hermes main path → Tasks 5–10; acceptance gate in Task 10.
- G3 internals use jinn → already met (Jinn layer); asserted implicitly (skin brand is the source of truth in every guarded edit).
- Brand policy (guarded + argparse hard-code) → Global Constraints + Tasks 5 (hard-code) vs 6–9 (guarded).
- setup-hermes.sh command rewrite (decision §7-2) → Task 9.
- Squash subtree import (decision §7-4) → Task 1. Tree name `apps/jinn-agent` (decision §7-3) → throughout.
- Out-of-scope items (degraded fallbacks, Homebrew, attribution) → excluded by the `assert_no_upstream_brand` technical-token allowance and not targeted by any task; recorded in Global Constraints.
