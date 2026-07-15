# S1-C2 — Contribution inspection (design note)

- **Issue:** Jinn-Network/mono#1664 (Stage 1, S1-C2)
- **Date:** 2026-07-15
- **Shape:** `design` (Stage 1 of the DESIGN → implement flow)
- **Branch:** `feat/1664-stage-1-contribution-inspection-history-entries-first-publis`
- **Design refs:** product design §4.4 (contribution — silent, inspectable), §4.5 (history);
  Stage 1 plan §S1-C2.

## TL;DR — the delta is (mostly) already closed on this branch

The headline finding of this design pass: **all four acceptance criteria already have
implementation + passing tests committed on this branch**, ahead of an earlier autopilot
pass (commits `dceafe505`, `b83b03145`, `618e3eee8`, all tagged `#1664`). Verified green:

- `packages/plugin/test/history-forward-states.test.ts` + `history.test.ts` — 7 pass
- `apps/jinn-agent/tests/plugins/test_jinn_contribution_lane.py` +
  `test_jinn_ledger_mint_states.py` — 10 pass

So the honest design output is not "here is net-new work to build" but "here is what is
satisfied, on which surface, and the *one* real architectural loose end that a reviewer
should decide about deliberately rather than by omission." The chosen approach is
**Rule 2 / Rule 3 minimal**: keep the three-surface split the Stage 1 package boundary
already enforces (TS plugin core owns the derived history view; TS harness-layer adapter
owns the local `queued`/`vetoed` status store; Python jinn-agent plugin owns the
publish/preview/veto/status interaction), and do not re-plumb the ledger producer within
S1-C2's scope.

## Surface map (whose job is each AC)

Three surfaces, one-way dependency arrow (`harness-layer → @jinn-network/plugin`; plugin
never imports `client/**`):

1. **TS plugin core** (`packages/plugin/`) — `foldHistory`/`foldExplain` (`src/history.ts`)
   read `ContributionPort.ledger()` and join `contributionState.status` by `episodeId`.
   This is the canonical AC1 surface: history *is* a derived view over Evidence +
   Contribution + LocalLearning (product design §4.5 invariant "owns no facts").
2. **TS harness-layer adapter** (`client/packages/harness-layer/src/adapters/contribution-adapter.ts`)
   — `ContributionPort` backed by an adapter-owned JSON `ContributionStatusStore`. Authors
   `queued` (on `recordMineable`) and `vetoed` (on `veto`); `minted`/`published` are forward
   states an off-adapter mint/publish path sets. It MUST NOT import `MineableTraceStore` or
   anything from `client/src/**` — that is the #1660 boundary.
3. **Python jinn-agent plugin** (`apps/jinn-agent/plugins/jinn/`) — owns the *interaction*:
   `_on_session_end` publish lane, the `previewed` gate, `/jinn veto`, `/jinn status`,
   `/jinn ledger` rendering (`ledger_view.py`). It reaches the layer only by shelling out to
   the `jinn-layer` CLI (`jinn_layer.py`); it does not consume the TS `ContributionPort`
   directly.

## Per-AC delta

### AC1 — history shows recorded/minted/queued/published states "from the pool"

**Satisfied.** Two rendering paths, both already built and tested:

- *Core derived view* (canonical): `foldHistory` maps `ContributionLedgerEntry.status`
  (`queued|minted|published|vetoed`) onto `HistoryEntry.contributionState.status`
  (`none|queued|minted|published|vetoed`). `HistoryEntrySchema` already carries the field.
  Pinned by `history-forward-states.test.ts` (all four forward states) and
  `history.test.ts` ("joins contribution state by episodeId"). "From the pool" is honored
  *through the port*: the ledger is the pool projection; the core never touches the store.
- *Ledger receipt view* (Python TUI): `ledger_view.py` renders `queued`→`recorded`,
  `minted`→`minted`, keeping envelope/anchor as em-dash placeholders (not-yet-left-machine),
  and the raw `queued` enum spelling never reaches the terminal. Pinned by
  `test_jinn_ledger_mint_states.py`.

**Net-new: none required.** The one *naming* subtlety the AC text hints at ("recorded"
vs the enum's `queued`) is already resolved at the render boundary — the human label
`recorded` is chosen only in `ledger_view.py` (and in `/jinn status`), never in the schema
or port. That is the correct altitude: the enum stays machine-honest (`queued`), the label
stays human-honest (`recorded`, i.e. "on your machine, not yet shared").

### AC2 — first mint publication is preview-gated; subsequent mints silent

**Satisfied.** The gate is the existing consent `previewed` flag — deliberately reused, not
a second "first-mint" flag. In `__init__.py _on_session_end`: if `share_enabled()` and
`not consent.load_state()["previewed"]`, the assembled task is written to the pending dir
and **held** (nothing published); the user is told to run `/jinn preview`. `/jinn preview`
runs `jinn-layer capture preview` and calls `consent.mark_previewed()`; from then on task
ends publish automatically, and `_drain_pending` publishes the earlier held trace.

**Which surface owns it: the Python plugin.** This is correct — the preview is a one-time
*interaction* moment (P4: "the first shared task shows a one-time preview; thereafter
minting is silent"), and the interaction/consent state lives in the Python `consent.py`
store, not the TS port. Pinned by `test_jinn_contribution_lane.py`
(`test_first_publish_is_held_until_previewed`,
`test_publishes_after_preview_and_is_silent_next_time`) and the older
`test_jinn_plugin.py` drain tests.

**Decision recorded:** we do *not* introduce a distinct "first-mint-publication" preview
separate from the onboarding consent preview. One preview, one gate. Rationale: P3/P4 make
the mint the *sole* thing that leaves the machine, so "first thing that publishes" and
"first mint" are the same event; a second gate would be a redundant interrupt against the
"felt product moment is the boost, not the contribution" posture.

### AC3 — `/jinn veto` withholds the current session's mineable record

**Satisfied, on the Python surface.** `/jinn veto` (in `_handle_jinn`) checks
`buf.has_steps(task_id, session_id)` (so vetoing nothing returns the honest "no active
task" copy, not a false success — #1383), then adds `_task_key(task_id, session_id)` to the
in-process `_vetoed_tasks` set. At `_on_session_end` the publish lane reads that set: a
vetoed task takes the `jinn_layer.publish(..., veto=True)` branch, which records locally and
publishes nothing. The current-session mapping is `(task_id, session_id) → _task_key`, and
the mineable record is the pending task file for that session.

**Which surface owns it: the Python plugin, not the TS adapter.** This is the correct
resolution of the "TS-adapter vs Python ownership" open question. The daemon-sidecar
`ContributionPort.veto(recordId)` exists and is the path for records that reached the
adapter's status store, but Stage 1's *interactive* veto operates on the current session's
in-flight trace *before* it is ever handed to the layer — it must gate the publish call the
plugin itself makes. Routing the interactive veto through the TS port would require the
plugin to first mint→recordId→veto a record it is simultaneously trying not to publish; the
session-local set is strictly simpler and matches the existing `_on_session_end` control
flow. Pinned by `test_veto_withholds_the_current_session` and the older
`test_jinn_plugin.py` veto tests.

### AC4 — sidecar absent → status reads `queued`, no error

**Satisfied.** Publication to chain runs through the *optional* daemon sidecar (product
design §4.4/§4.6). When it is absent, approved mints stay in the pending dir with an honest
status. `/jinn status` surfaces a held pre-publish trace as `contribution: recorded` (the
`queued` enum's human label) with no error line, no separate dir, no sidecar dependency —
`__init__.py` lines ~338-345. Pinned by `test_status_reads_recorded_when_trace_held` (and
the negative `test_status_has_no_recorded_line_when_no_trace`), which assert `"error"` and
`"unavailable"` never appear.

On the TS side the same honesty holds structurally: the adapter authors `queued` on
`recordMineable` and the fold reads it fail-open (`collect` records a labelled reason but
never throws), so an absent forward-state publisher leaves history at `queued`, never at an
error state.

## The one real loose end (out of S1-C2 scope — flag, don't fix)

The Python `/jinn ledger` renderer (`ledger_view.py`) *can* render `recorded`/`minted`
rows, and its test feeds them synthetically — but the production data path it reads,
`jinn-layer ledger --json` → `ledger.ts` `toLedgerRow`, only ever emits `published` /
`vetoed` rows. Nothing wires the adapter's `ContributionStatusStore` (or a mint pool) into
the CLI ledger output, so in production the ledger view never shows a live `recorded`/
`minted` row. The `/jinn status` "recorded" line (AC4) covers the held-trace case
independently, so **the ACs are met without closing this** — but a reviewer should know the
ledger's local-state rows are renderer-ready and producer-absent.

**Recommendation:** leave it. Wiring the `queued`/`minted` producer into the CLI ledger is a
mint-pool integration (the "from the pool" plumbing) that belongs with the sidecar
`HarvestLoop`/miner work (S1-C1 re-land, §9 drift 2/3), not with S1-C2's inspection
surfaces. Closing it here would pull `MineableTraceStore`/pool state across the very
package boundary #1660 established. Record it as a follow-up rather than smuggling it into
this issue.

## Test strategy (already realized — verification, not new authoring)

Per surface, matching existing patterns:

- **AC1** — vitest: `history-forward-states.test.ts` (stub port seeds all four states),
  `history.test.ts` (in-memory port, `queued` join + reproducibility). pytest:
  `test_jinn_ledger_mint_states.py` (renderer label/leak assertions).
- **AC2/AC3/AC4** — pytest `test_jinn_contribution_lane.py` drives the real
  `_on_session_end` lane with an injected `RunnerSpy` (the `jinn._runner` test seam) over an
  isolated `HERMES_HOME`; asserts publish-call counts, veto-branch flag, and status copy.

Implementation stage (S1-C2 execute) reduces to: run both suites, confirm green on the
current merge-ref, and — if a reviewer accepts the recommendation above — do nothing
further. If a reviewer instead wants the ledger producer closed inside S1-C2, that is a
scope expansion that needs its own TDD cycle in the harness-layer CLI and an explicit
boundary carve-out; this note recommends against it.

## Trade-offs and risks

- **Reused `previewed` flag vs a dedicated first-mint gate (chosen: reuse).** Simpler, one
  interrupt, matches P4. Risk: if a future stage separates "onboarding preview" from "first
  real mint," the single flag conflates them. Accepted — that separation is not a Stage 1
  concern and the flag is cheap to split later.
- **Session-local veto set vs TS-port veto (chosen: session-local).** Matches the existing
  control flow and the "veto before it ever leaves" semantics; the in-process set is lost on
  a crash mid-session, but a lost veto degrades to "held, not published" (the pre-preview
  default) — never to an accidental publish, because the publish branch still requires
  `previewed`. Acceptable failure mode.
- **Renderer-ready / producer-absent ledger local-states (chosen: leave).** Risk that a
  reviewer reads AC1 as requiring live `recorded`/`minted` rows in `/jinn ledger`. Mitigated
  by: (a) the core history view *does* show them from the port, (b) `/jinn status` shows the
  held-trace `recorded` line, (c) this note names the gap explicitly so the call is
  deliberate.

## Decision

The implementation for all four ACs is present and green on this branch. S1-C2 is a
**verify-and-document** issue, not a build issue. The chosen approach preserves the
three-surface boundary, reuses the `previewed` gate, keeps the interactive veto
session-local, and defers the CLI-ledger mint-pool producer to the sidecar/mining work.
