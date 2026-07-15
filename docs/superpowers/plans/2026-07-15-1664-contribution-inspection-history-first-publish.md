# Issue #1664 — Contribution Inspection, History Entries, First-Publish Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the contribution ledger surface `recorded`/`minted`/`queued`/`published` states, prove the first-publish one-time preview + subsequent-silent behavior, prove `/jinn veto` withholds the current session, and prove a held (pre-publish) trace reads as `recorded` in `/jinn status` with no error when nothing has advanced it — all against the **post-#1714 single-consent publish path** that already ships on `next`.

**Architecture:** Post-#1714 there is exactly ONE contribution lane — the `share_enabled()` publish path in `_on_session_end`. It is already gated on the single `shareConsent`, preview-gated on `previewed`, and veto-honored via `_vetoed_tasks`. AC1/AC2/AC3 are **already implemented on `next`**; this issue adds regression tests that pin the behavior, plus two small renderer/status additions (the ledger mint-state chips and one `/jinn status` line). There is **no mint lane, no `mineable/` dir, no `_run_mint_lane`, no `_capture_active`, no multi-tier consent** — the closed PR #1730 (salvage SHA `5044edfd36fb1e1d1efccf4c72ba15ec7f12680e`) was built on the pre-#1714 model and its `__init__.py` changes are discarded.

**Tech Stack:** Python 3.13 + pytest 9 (`apps/jinn-agent`, import root `plugins.jinn`); TypeScript + vitest (`packages/plugin`, `client/packages/harness-layer`).

## Global Constraints

- **FROZEN — must NOT change:** `apps/jinn-agent/plugins/jinn/consent.py` (#1714 contract: `share_enabled()`, `load_state()` → `{shareConsent, previewed}`, `mark_previewed()`, `save_state(share, *, previewed=…)`); `packages/plugin/src/ports/contribution-port.ts`; `packages/plugin/src/history.ts` (S1-F1/F2 owner's contracts — consume read-only). Do NOT touch `_drain_pending` in `__init__.py`.
- **Discard entirely** (never reference): `_run_mint_lane`, `_mineable_dir`, `_capture_active`, `_has_mineable_record`, `mineableTraceConsent`, `publishMinedTasksConsent`, `mineable_trace_enabled()`, `capture_enabled()`, `consent.DECLINED`, `consent.ACCEPTED`, `save_state(..., mineable_trace_consent=…, publish_mined_tasks_consent=…)`. These symbols do not exist on `next`.
- American English spelling in identifiers and copy.
- Consent state gate for the publish path is `consent.share_enabled()` (single bool). Preview gate is `consent.load_state().get("previewed")`. Veto set is `jinn._vetoed_tasks`.
- Each new/changed file lands with its test in the same task (TDD).

## File map

| File | Responsibility | Action |
|---|---|---|
| `apps/jinn-agent/plugins/jinn/ledger_view.py` | ledger row renderer | **Modify** — add mint-state labels + local-state branch + published-count exclusion (verbatim salvage) |
| `apps/jinn-agent/tests/plugins/test_jinn_ledger_mint_states.py` | ledger renderer AC1 tests | **Create** (verbatim salvage) |
| `apps/jinn-agent/plugins/jinn/__init__.py` | `/jinn status` handler | **Modify** — one status line: held pre-publish trace with nothing published reads `contribution: recorded` |
| `apps/jinn-agent/tests/plugins/test_jinn_contribution_lane.py` | AC2/AC3/AC4 Python tests against the REAL `_on_session_end`/`/jinn status` | **Create** (rewrite of salvaged `test_jinn_mint_lane.py`) |
| `packages/plugin/test/history-forward-states.test.ts` | AC1 history-projection test | **Create** (verbatim salvage) |
| `client/packages/harness-layer/test/adapters/contribution-adapter-forward-states.test.ts` | AC1/AC3/AC4 adapter-state tests | **Create** (verbatim salvage) |

---

## Task 1: TS history projection surfaces all four states (AC1)

Salvage verbatim — every symbol it consumes exists on `next` (`createJinnPlugin`, `InMemory*Port`, `makeSampleEpisode` with `episodeId`/`session` overrides, `ok`, `ContributionLedgerEntry`, `ContributionPort`, `plugin.history()` → `entries[].sessionId` + `.contributionState.status`). Confirmed against `packages/plugin/src/history.ts:82-89` and `test/_fixtures/episode.ts:4`.

**Files:**
- Create: `packages/plugin/test/history-forward-states.test.ts`

**Interfaces:**
- Consumes (read-only, frozen): `ContributionPort`, `ContributionLedgerEntry` from `packages/plugin/src/ports/contribution-port.ts`; `plugin.history()` from `packages/plugin/src/history.ts`.

- [ ] **Step 1: Create the test file (verbatim salvage)**

Write `packages/plugin/test/history-forward-states.test.ts` with exactly the salvaged content:

```bash
cd "$(git -C . rev-parse --show-toplevel)" && \
git show 5044edfd36fb1e1d1efccf4c72ba15ec7f12680e:packages/plugin/test/history-forward-states.test.ts \
  > packages/plugin/test/history-forward-states.test.ts
```

- [ ] **Step 2: Run the test — expect PASS (code already shipped)**

Run: `cd packages/plugin && yarn test history-forward-states`
Expected: PASS — `projects queued / minted / published / vetoed onto history rows`. (This is a pin-the-behavior test; `foldHistory` already maps ledger status onto `contributionState.status` at `history.ts:47-49,89`.)

- [ ] **Step 3: Typecheck the package**

Run: `cd packages/plugin && yarn typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add packages/plugin/test/history-forward-states.test.ts
git commit -m "test(plugin): pin history projection of queued/minted/published/vetoed (#1664 AC1)"
```

---

## Task 2: TS contribution-adapter forward states + sidecar-absent + veto (AC1, AC3, AC4)

Salvage verbatim — `createContributionStatusStore`, `createContributionAdapter`, `ContributionStatusStore`, store `.put`/`.setStatus`, adapter `.recordMineable`/`.ledger`/`.mintStatus`/`.veto` all exist on `next` (`client/packages/harness-layer/src/adapters/contribution-adapter.ts:33,42,71,76,87,98,104`). The AC4 case (`recordMineable` → `mintStatus` reads `queued`) is the TS proof for "sidecar absent → status reads queued, no error".

**Files:**
- Create: `client/packages/harness-layer/test/adapters/contribution-adapter-forward-states.test.ts`

**Interfaces:**
- Consumes: `createContributionAdapter`, `createContributionStatusStore`, `ContributionStatusStore` from `../../src/adapters/contribution-adapter.js`.

- [ ] **Step 1: Create the test file (verbatim salvage)**

```bash
cd "$(git -C . rev-parse --show-toplevel)" && \
mkdir -p client/packages/harness-layer/test/adapters && \
git show 5044edfd36fb1e1d1efccf4c72ba15ec7f12680e:client/packages/harness-layer/test/adapters/contribution-adapter-forward-states.test.ts \
  > client/packages/harness-layer/test/adapters/contribution-adapter-forward-states.test.ts
```

- [ ] **Step 2: Run the test — expect PASS (adapter already ships these states)**

The `client` vitest include globs cover `packages/*/test/**/*.test.ts` (`client/vitest.config.ts:10`), so this file is picked up by the client suite. Run it in isolation:

Run: `cd client && yarn vitest run packages/harness-layer/test/adapters/contribution-adapter-forward-states.test.ts`
Expected: PASS — three describe blocks (forward states AC1, sidecar-absent AC4, veto AC3).

> Note: `client/packages/harness-layer/package.json` has no `test` script of its own; harness-layer tests run through the `client` package's vitest. Do not add a `test` script — match the existing convention.

- [ ] **Step 3: Typecheck harness-layer**

Run: `cd client && yarn typecheck:harness-layer`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add client/packages/harness-layer/test/adapters/contribution-adapter-forward-states.test.ts
git commit -m "test(harness-layer): pin contribution adapter forward states + sidecar-absent queued + veto (#1664 AC1/AC3/AC4)"
```

---

## Task 3: Ledger renderer mint-state chips (AC1)

Verbatim salvage of the `ledger_view.py` diff + its test. Adds `RECORDED_LABEL`/`MINTED_LABEL`/`_LOCAL_STATE_LABELS`, a `state in _LOCAL_STATE_LABELS` branch (em-dash env/anchor like the vetoed row, sky chip), and excludes `queued`/`minted` from the published count. This is the only Python change to a shipped renderer.

**Files:**
- Modify: `apps/jinn-agent/plugins/jinn/ledger_view.py` (add after `FAILED_LABEL` at line 48; add branch after the `vetoed` branch ~line 73; widen the published-count exclusion at line 160)
- Create: `apps/jinn-agent/tests/plugins/test_jinn_ledger_mint_states.py`

**Interfaces:**
- Produces: `ledger_view.RECORDED_LABEL == "recorded"`, `ledger_view.MINTED_LABEL == "minted"`, `_LOCAL_STATE_LABELS = {"queued": "recorded", "minted": "minted"}`. `render_ledger` renders `state="queued"` rows as `recorded`, `state="minted"` as `minted`, never leaks the raw `queued` spelling, keeps published tier chips and `vetoed (local only)`.

- [ ] **Step 1: Create the failing test (verbatim salvage)**

```bash
cd "$(git -C . rev-parse --show-toplevel)" && \
git show 5044edfd36fb1e1d1efccf4c72ba15ec7f12680e:apps/jinn-agent/tests/plugins/test_jinn_ledger_mint_states.py \
  > apps/jinn-agent/tests/plugins/test_jinn_ledger_mint_states.py
```

- [ ] **Step 2: Run it — expect FAIL (labels not defined yet)**

Run: `cd apps/jinn-agent && python -m pytest tests/plugins/test_jinn_ledger_mint_states.py -q`
Expected: FAIL — `AttributeError: module 'plugins.jinn.ledger_view' has no attribute 'RECORDED_LABEL'`.

- [ ] **Step 3: Add the labels to `ledger_view.py`**

Insert immediately after `FAILED_LABEL = "publish failed — retained locally"` (currently line 48):

```python
# `queued`/`minted` are pre-publish enum states — human labels only, chosen
# here (never in the schema/port). A recorded or minted trace has not left the
# machine, so envelope + anchor stay em-dash placeholders like the vetoed row.
RECORDED_LABEL = "recorded"
MINTED_LABEL = "minted"

_LOCAL_STATE_LABELS = {"queued": RECORDED_LABEL, "minted": MINTED_LABEL}
```

- [ ] **Step 4: Add the local-state render branch**

In `_row(...)`, immediately after the `if state == "vetoed":` block returns (currently after line 73, before `if state == "failed":`), insert:

```python
    if state in _LOCAL_STATE_LABELS:
        env = dim(_cell("—", _COL["env"]))
        anc = dim(_cell("—", _COL["anchor"]))
        return f"{time}  {task}  {env}  {anc}  {sky(_LOCAL_STATE_LABELS[state])}"
```

- [ ] **Step 5: Widen the published-count exclusion**

In `render_ledger(...)`, replace (currently line 160):

```python
    published = sum(1 for r in rows if r.get("state") not in ("vetoed", "failed"))
```

with:

```python
    published = sum(
        1 for r in rows if r.get("state") not in ("vetoed", "failed", "queued", "minted")
    )
```

- [ ] **Step 6: Run the test — expect PASS**

Run: `cd apps/jinn-agent && python -m pytest tests/plugins/test_jinn_ledger_mint_states.py -q`
Expected: PASS — 5 tests (`queued`→recorded chip, `minted` chip, no env/anchor leak, all-states-together, `rows_from_json` passes state through).

- [ ] **Step 7: Run the full jinn ledger/consent suite to catch regressions**

Run: `cd apps/jinn-agent && python -m pytest tests/plugins/ -k "ledger or consent" -q`
Expected: PASS — the salvaged branch is additive; existing `vetoed`/`failed`/tier rows are untouched.

- [ ] **Step 8: Commit**

```bash
git add apps/jinn-agent/plugins/jinn/ledger_view.py apps/jinn-agent/tests/plugins/test_jinn_ledger_mint_states.py
git commit -m "feat(jinn-plugin): ledger renders recorded/minted local-state chips (#1664 AC1)"
```

---

## Task 4: Python `/jinn status` recorded line + AC2/AC3/AC4 against the real path

This is the one genuine `__init__.py` addition and the rewrite of the salvaged `test_jinn_mint_lane.py`. The salvaged test file is renamed to `test_jinn_contribution_lane.py` and rewritten to drive the REAL single-consent publish path (`consent.save_state(True)` + `mark_previewed()` + real `_on_session_end`), the real `_pending_dir()` (NOT a `mineable/` dir), and the real `_vetoed_tasks`. The `/jinn status` handler gains one line: when a held pre-publish trace exists in `_pending_dir()` (`_latest_pending()` non-None) but the operator has not previewed (so nothing has published), status emits `contribution: recorded`.

**Why the status line is needed:** AC4 requires "sidecar absent → status reads `recorded`/`queued`, no error." The real held-trace path writes a `_pending_dir()` file when `share_enabled()` is True but holds it (no publish) until `previewed`. The current `/jinn status` (line 329-341) only prints `pending trace: <path>` — it never emits the `recorded` human label. We add exactly one line and no new dir/sidecar.

**Files:**
- Modify: `apps/jinn-agent/plugins/jinn/__init__.py` — `/jinn status` handler (the `if sub == "status":` block, currently lines 329-341)
- Create: `apps/jinn-agent/tests/plugins/test_jinn_contribution_lane.py`

**Interfaces:**
- Consumes (frozen): `consent.save_state(True)`, `consent.mark_previewed()`, `consent.share_enabled()`, `consent.load_state()`.
- Consumes (existing, do not change): `jinn._on_pre_llm_call`, `_on_post_tool_call`, `_on_session_end`, `_handle_jinn`, `jinn._vetoed_tasks`, `jinn._pending_dir()`, `jinn._latest_pending()`, `capture_buffer.reset()`.
- Produces: `/jinn status` emits a `contribution: recorded` line when `_latest_pending()` is non-None and `consent.load_state().get("previewed")` is falsy.

### AC2/AC3 first (tests pass against shipped code)

- [ ] **Step 1: Create the rewritten test file**

Create `apps/jinn-agent/tests/plugins/test_jinn_contribution_lane.py`. This drives the real path; the runner returns `(0, "ok")` for `publish` so the publish branch succeeds and unlinks (mirrors `test_jinn_distill_tee.py`). Full content:

```python
"""Contribution lane — publish/preview/veto/status against the real single-
consent path (Jinn-Network/mono#1664).

Post-#1714 there is ONE lane: the share_enabled() publish path in
_on_session_end. It is gated on the single shareConsent, preview-gated on
`previewed`, and veto-honored via _vetoed_tasks. These tests pin:

AC2 — first publish is preview-gated (held), subsequent publishes silent.
AC3 — /jinn veto withholds the current session's trace (recorded locally,
      never published).
AC4 — a held pre-publish trace reads `contribution: recorded` in /jinn status
      with no error line; absent held trace → no such line, no error.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
consent = importlib.import_module("plugins.jinn.consent")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")


class RunnerSpy:
    """Answers every jinn-layer verb with (code, out). argv[0] is the binary;
    the verb is argv[1]."""

    def __init__(self, code: int = 0, out: str = "ok"):
        self.calls: list[list[str]] = []
        self.code = code
        self.out = out

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        return self.code, self.out

    def publish_calls(self) -> list[list[str]]:
        return [c for c in self.calls if len(c) > 1 and c[1] == "publish"]


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("JINN_HARNESS_NAME", "jinn-agent")
    capture_buffer.reset()
    jinn._vetoed_tasks.clear()
    jinn._session_hint_shown.clear()
    spy = RunnerSpy()
    jinn._runner = spy
    yield spy
    jinn._runner = None


def _share_on():
    """Single sharing consent ON (post-#1714). previewed stays False."""
    consent.save_state(True)


def _start_session(session_id="s1", task_id="t1"):
    jinn._on_pre_llm_call(
        session_id=session_id, task_id=task_id,
        user_message="Fix the failing test suite", is_first_turn=False,
        model="test-model", platform="cli",
    )
    jinn._on_post_tool_call(
        tool_name="terminal", args={"command": "yarn test"},
        session_id=session_id, task_id=task_id, tool_call_id="call-1",
        result='{"output": "1 failed"}', duration_ms=50,
    )


def _end_session(session_id="s1", task_id="t1"):
    jinn._on_session_end(
        session_id=session_id, task_id=task_id, completed=True, interrupted=False,
    )


def _pending_files() -> list[Path]:
    d = jinn._pending_dir()
    return sorted(d.glob("*.json")) if d.exists() else []


# ── AC2 — preview-gated first publish, then silent ───────────────────────────

def test_first_publish_is_held_until_previewed(isolated_home):
    _share_on()  # previewed is False
    _start_session()
    _end_session()
    # Held: the trace sits in the pending dir, nothing published yet.
    assert isolated_home.publish_calls() == []
    assert len(_pending_files()) == 1


def test_publishes_after_preview_and_is_silent_next_time(isolated_home):
    _share_on()
    consent.mark_previewed()
    _start_session(session_id="s1", task_id="t1")
    _end_session(session_id="s1", task_id="t1")
    assert len(isolated_home.publish_calls()) == 1  # published, no re-preview

    # A subsequent session publishes silently — no second preview gate.
    _start_session(session_id="s2", task_id="t2")
    _end_session(session_id="s2", task_id="t2")
    assert len(isolated_home.publish_calls()) == 2
    assert consent.load_state()["previewed"] is True


# ── AC3 — /jinn veto withholds the current session's trace ───────────────────

def test_veto_withholds_the_current_session(isolated_home):
    _share_on()
    consent.mark_previewed()
    _start_session()
    out = jinn._handle_jinn(command_args="veto", session_id="s1", task_id="t1")
    assert "This task is vetoed" in out
    _end_session()
    # The publish path took the veto branch: a veto-record call fired, but no
    # plain publish left the machine. The veto branch calls publish(..., veto=True)
    # — assert nothing published WITHOUT the veto flag.
    plain_publish = [
        c for c in isolated_home.publish_calls()
        if "--veto" not in c and "veto" not in c[2:]
    ]
    assert plain_publish == []


# ── AC4 — held trace reads `recorded` in /jinn status, no error ──────────────

def test_status_reads_recorded_when_trace_held(isolated_home):
    _share_on()  # previewed False → the trace is held, not published
    _start_session()
    _end_session()
    out = jinn._handle_jinn(command_args="status")
    assert "contribution: recorded" in out
    assert "error" not in out.lower()
    assert "unavailable" not in out.lower()


def test_status_has_no_recorded_line_when_no_trace(isolated_home):
    _share_on()
    out = jinn._handle_jinn(command_args="status")
    assert "contribution: recorded" not in out
    assert "error" not in out.lower()
```

- [ ] **Step 2: Run AC2/AC3 tests — expect PASS (shipped behavior)**

Run: `cd apps/jinn-agent && python -m pytest tests/plugins/test_jinn_contribution_lane.py -q -k "held_until_previewed or after_preview or veto_withholds"`
Expected: PASS — AC2 (held-then-silent) and AC3 (veto) already work on `next`.

- [ ] **Step 3: Run the AC4 status tests — expect FAIL (status line not added yet)**

Run: `cd apps/jinn-agent && python -m pytest tests/plugins/test_jinn_contribution_lane.py -q -k "status"`
Expected: FAIL — `test_status_reads_recorded_when_trace_held` asserts `contribution: recorded` which the current status handler never emits.

### AC4 status line

- [ ] **Step 4: Add the `contribution: recorded` line to `/jinn status`**

In `_handle_jinn`, inside `if sub == "status":`, immediately after the existing `pending trace` block (currently lines 338-340):

```python
        pending = _latest_pending()
        if pending:
            lines.append(f"pending trace: {pending}")
```

append:

```python
            # A held pre-publish trace (share ON, not yet previewed → nothing
            # published) reads `recorded` — the queued enum's human label. No
            # sidecar, no separate dir, no error when absent (mono#1664 AC4).
            if not state.get("previewed"):
                lines.append("contribution: recorded")
```

> `state` is already bound at the top of the status block (`state = consent.load_state()`, line 330). The new lines are nested inside `if pending:` so they only fire when a held trace exists.

- [ ] **Step 5: Run the AC4 status tests — expect PASS**

Run: `cd apps/jinn-agent && python -m pytest tests/plugins/test_jinn_contribution_lane.py -q -k "status"`
Expected: PASS — held trace → `contribution: recorded`; no held trace → no line, no error.

- [ ] **Step 6: Run the whole new file**

Run: `cd apps/jinn-agent && python -m pytest tests/plugins/test_jinn_contribution_lane.py -q`
Expected: PASS — all 5 tests.

- [ ] **Step 7: Run the full jinn plugin suite for regressions**

Run: `cd apps/jinn-agent && python -m pytest tests/plugins/ -k jinn -q`
Expected: PASS — the status change is additive and nested under `if pending:`; existing status/consent/veto/entrypoint tests are unaffected.

- [ ] **Step 8: Commit**

```bash
git add apps/jinn-agent/plugins/jinn/__init__.py apps/jinn-agent/tests/plugins/test_jinn_contribution_lane.py
git commit -m "feat(jinn-plugin): /jinn status reports held trace as recorded; pin publish/veto/preview lane (#1664 AC2/AC3/AC4)"
```

---

## Task 5: Full-suite verification

- [ ] **Step 1: Python plugin suite (all jinn tests)**

Run: `cd apps/jinn-agent && python -m pytest tests/plugins/ -k jinn -q`
Expected: PASS.

- [ ] **Step 2: Plugin package (TS)**

Run: `cd packages/plugin && yarn test && yarn typecheck`
Expected: PASS + zero typecheck errors.

- [ ] **Step 3: Harness-layer adapter test + typecheck (TS)**

Run: `cd client && yarn vitest run packages/harness-layer/test/adapters/contribution-adapter-forward-states.test.ts && yarn typecheck:harness-layer`
Expected: PASS + zero typecheck errors.

- [ ] **Step 4: Confirm no discarded symbols leaked into the tree**

Run: `cd "$(git -C . rev-parse --show-toplevel)" && git grep -nE '_run_mint_lane|_mineable_dir|_capture_active|_has_mineable_record|mineableTraceConsent|publishMinedTasksConsent|mineable_trace_enabled|capture_enabled\(' apps/jinn-agent/plugins/jinn apps/jinn-agent/tests/plugins/test_jinn_contribution_lane.py apps/jinn-agent/tests/plugins/test_jinn_ledger_mint_states.py`
Expected: **no matches** in the files this issue touches (matches elsewhere in the wider tree, if any, are out of scope). If any of the six files above matches, the salvage bled in — remove it.

---

## AC → Task → Test mapping

| AC | Behavior | Task(s) | Test file(s) |
|---|---|---|---|
| **AC1** — history shows recorded/minted/queued/published states from the pool | TS history projection + TS adapter states + Python ledger chips | 1, 2, 3 | `packages/plugin/test/history-forward-states.test.ts`; `client/packages/harness-layer/test/adapters/contribution-adapter-forward-states.test.ts`; `apps/jinn-agent/tests/plugins/test_jinn_ledger_mint_states.py` |
| **AC2** — first publish preview-gated, subsequent silent | (shipped) pinned by test | 4 | `test_jinn_contribution_lane.py::test_first_publish_is_held_until_previewed`, `::test_publishes_after_preview_and_is_silent_next_time` |
| **AC3** — `/jinn veto` withholds current session | (shipped) pinned by test (Py + TS) | 2, 4 | `test_jinn_contribution_lane.py::test_veto_withholds_the_current_session`; `contribution-adapter-forward-states.test.ts` veto block |
| **AC4** — sidecar absent → status reads queued/recorded, no error | Python `/jinn status` line + TS adapter proof | 2, 4 | `test_jinn_contribution_lane.py::test_status_reads_recorded_when_trace_held`, `::test_status_has_no_recorded_line_when_no_trace`; `contribution-adapter-forward-states.test.ts` sidecar-absent block |

## Verification command list (exact)

```bash
# Python (from apps/jinn-agent)
python -m pytest tests/plugins/test_jinn_ledger_mint_states.py -q
python -m pytest tests/plugins/test_jinn_contribution_lane.py -q
python -m pytest tests/plugins/ -k jinn -q

# TS plugin package (from packages/plugin)
yarn test history-forward-states
yarn test
yarn typecheck

# TS harness-layer (from client)
yarn vitest run packages/harness-layer/test/adapters/contribution-adapter-forward-states.test.ts
yarn typecheck:harness-layer

# Leak guard (from repo root)
git grep -nE '_run_mint_lane|_mineable_dir|_capture_active|_has_mineable_record|mineableTraceConsent|publishMinedTasksConsent' apps/jinn-agent/plugins/jinn apps/jinn-agent/tests/plugins/test_jinn_contribution_lane.py apps/jinn-agent/tests/plugins/test_jinn_ledger_mint_states.py
```

## Notes for the implementer — where the design note's line numbers drifted

- The design note cited `__init__.py:219–261` for the publish path, `237-245` preview gate, `247` subsequent-silent, `407-414` veto, `224-235` veto-record, `329-341` status. **Verified against the real file:** publish/share lifecycle is `_on_session_end` lines **184-261**; preview gate **237-245**; subsequent-silent publish **247-261**; `/jinn veto` handler **407-414**; veto-record branch **224-235**; `/jinn status` block **329-341**. All symbols match; only the publish-path start line differs (184, not 219). Use the anchors in this plan, not raw line numbers — the file will shift as you edit.
- The design note said to salvage `ledger_view.py` render + `test_jinn_ledger_mint_states.py` **verbatim** — confirmed: the salvaged `ledger_view.py` hunk applies cleanly against the current `next` file (insert after `FAILED_LABEL` line 48, branch after the vetoed block, widen the count at line 160). Task 3 reproduces those exact hunks.
- The design note said to **rewrite** `test_jinn_mint_lane.py` — this plan renames it to `test_jinn_contribution_lane.py` (the "mint lane" name is discarded along with `_run_mint_lane`) and re-points every fixture to `consent.save_state(True)` / `mark_previewed()` / the real `_pending_dir()`. The salvaged file's `consent.DECLINED`, `consent.ACCEPTED`, `save_state(..., mineable_trace_consent=…, publish_mined_tasks_consent=…)`, `_mineable_dir()`, and `mineable record:` assertions are all **removed** — none of those symbols exist on `next`.
- The salvaged AC3 test asserted "no publish call fired." Because the real veto branch calls `jinn_layer.publish(task_file, veto=True)` (a veto *record*, `__init__.py:229`), the rewritten AC3 test asserts no **plain** (non-veto) publish left the machine, not zero publish calls. This matches the shipped `_on_session_end` veto branch exactly.

---

## Execution note

Tasks 1 and 2 (TS, pure test-adds) are independent of Tasks 3 and 4 (Python) and of each other — they may be dispatched in parallel. Tasks 3 and 4 both touch different regions of Python plugin files (`ledger_view.py` vs `__init__.py`) and different test files, so they are also independent, but Task 4's regression step (`-k jinn`) will pick up Task 3's new test — run Task 4's Step 7 after Task 3 lands if executing sequentially. Task 5 runs last.
