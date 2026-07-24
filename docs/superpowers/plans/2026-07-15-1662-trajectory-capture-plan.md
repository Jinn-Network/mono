# Plan — #1662: Complete trajectory capture in the Hermes plugin (EpisodeV1)

Version: 1.0
Date: 2026-07-15
Author: Planning subagent (worktree `feat/1662-...`)
Shape: `feat` (Medium effort) — TDD

## Goal

Capture the *complete* agent trajectory in the Jinn Hermes plugin and emit it as an
`EpisodeV1` record, while:
- the legacy `CapturedTask` tee still feeds the distiller (compat), and
- the in-memory-only gating (no consent / no distill opt-in → nothing on disk) stays intact.

## Acceptance criteria (map every step to these)

1. Driving the hooks in tests yields an episode with all **user turns, assistant turns, and
   tool calls in order**.
2. `environment` includes the **skills loadout**; `cost.tokens` is populated when the host
   reports usage.
3. The episode is written as `EpisodeV1`; the distiller still reads legacy captures (compat test).
4. Absent consent/distill opt-in, the buffer remains **in-memory only** (existing gating tests
   stay green).

---

## Findings from integration-point verification (read before implementing)

All line numbers below were confirmed in this worktree on 2026-07-15.

### Hook wiring (`apps/jinn-agent/plugins/jinn/__init__.py`)
- `:108` `_on_pre_llm_call` → `buf.record_first_turn(...)`, gated by
  `consent.capture_enabled() or distill.distill_capture_enabled(_runner)`. Also does corpus
  pickup on `is_first_turn` (NOT consent-gated — do not touch that branch).
- `:133` `_on_post_tool_call` → `buf.record_tool_call(...)`, same gate.
- `:148` `_on_session_end` → `buf.assemble(...)` then `distill.tee_capture(task, ...)`, then the
  publish lifecycle. Same gate at `:156`.
- `:469-472` `register()` subscribes `on_session_start`, `pre_llm_call`, `post_tool_call`,
  `on_session_end`. **No `post_llm_call` subscription yet** — this is the one to add.

### Buffer (`apps/jinn-agent/plugins/jinn/capture_buffer.py`)
- `:38` `record_first_turn` — setdefault-idempotent; sets `summary`/`model`/`platform`. Keep it.
- `:67` `record_tool_call` — appends a span to `buf["steps"]` with `name: "tool:<tool>"`, a
  `spanId`, `startTimeUnixNano`/`endTimeUnixNano`, `attributes`, `redactedKeys`.
- `:106` `has_steps` — used by `/jinn veto`.
- `:112` `assemble` — **pops** the buffer, returns the strict legacy `CapturedTask` dict. Because
  it pops, `_on_session_end` can only call ONE assembler. See "Ordering / pop hazard" below.
- `:157` `reset` — test helper.
- The buffer is a module-global keyed on `session_id or task_id or "default"` (`_key`, `:25`).

### EpisodeV1 schema of record (`packages/plugin/src/schemas/episode.ts`)
Mirror these exact field names in the Python dict (strictObject → unknown fields REJECTED, so
emit exactly these keys, no extras):

```
schemaVersion: 'jinn.episode.v1'          # EPISODE_SCHEMA_VERSION literal
episodeId: string (min 1)
session: { sessionId: string(1..128), capturedAt: ISO-8601 datetime }
task: { summary: string(min 1), distributionTags: string[] (default []) }
trajectory: Step[] (min 1)                 # ordered; ≥1 even for zero-tool sessions
environment: {
  harness: { name, version },
  model: string(min 1),
  tools: string[],
  skillsLoadout: string[],                 # NEW — required, may be []
}
outcome: { status: 'completed'|'failed'|'abandoned',
           verifiabilityTier: 'user-accepted'|'tests-passed'|'evaluator-verified',
           summary?: string }
cost: { durationMs: int>=0,
        tokens?: { input: int>=0, output: int>=0 },   # OMIT when host reports no usage
        usdEstimate?: string }
retention: { policy: 'local-private' | 'contribution-eligible' }   # NEW
provenance: 'contributed' | 'imported' (default 'contributed')
lineage?: { episodeId, mintRef? }          # omit in Stage 1
```

Step (`StepSchema`, strict):
```
spanId: string(min 1)
parentSpanId: string(min 1) | null
kind: 'jinn.agent_turn' | 'jinn.tool_call'   # NEW discriminator
name: string(min 1)
startTimeUnixNano: /^\d+$/ string
endTimeUnixNano: /^\d+$/ string
attributes: Record<string, unknown>          # role:'user'|'assistant' lives HERE for agent_turn
redactedKeys: string[] (default [])
```

### Compat reader to protect (`client/packages/harness-layer/src/distill-captures.ts:19`)
`loadRecentCaptures` reads every `*.json` in the captures dir and calls `parseCapturedTask`
(strict). A file that fails strict parse is **skipped with a stderr warning** — it does NOT
crash, but it is silently dropped. Therefore an EpisodeV1 written into the captures dir under a
distinct name would be *skipped*, not read — which is why the design is **dual-write** (legacy
`CapturedTask` stays byte-identical) and the EpisodeV1 goes to a **separate location** so it is
never even offered to `parseCapturedTask`.

### `write_task_file` collision hazard (`apps/jinn-agent/plugins/jinn/jinn_layer.py:91`)
`write_task_file(task, dir, session_id)` writes `<sanitized-session>.json` — one file per session.
If the episode reused the same dir + session-derived name it would clobber the legacy capture.
The episode MUST be written to a distinct dir (e.g. `<captures_dir>/../episodes/` or a dedicated
`episodes_dir()`), or with a distinct suffix. Plan uses a dedicated `episodes_dir()`.

### Token + skills reachability (the design's open question) — DECIDED: minimal host forward
Evidence:
- Token counters live on the **agent object**: `agent.session_input_tokens` /
  `session_output_tokens` — initialized `agent/agent_init.py:1826-1827`, incremented
  `agent/conversation_loop.py:2021-2022` and `agent/codex_runtime.py:175-176`.
- `post_llm_call` is invoked at `agent/turn_finalizer.py:369-378` and forwards
  `session_id, task_id, turn_id, user_message, assistant_response, conversation_history, model,
  platform` — **NOT tokens**.
- `on_session_end` is invoked at `agent/turn_finalizer.py:494-503` and forwards
  `session_id, task_id, turn_id, completed, interrupted, model, platform` — **NOT tokens**.
- Skills loadout: `build_preloaded_skills_prompt` (`agent/skill_commands.py:564`) returns
  `loaded_names`, but callers (`cli.py:15787`, `tui_gateway/server.py:4266`) do **not** store it
  on the agent, and it is not forwarded through any hook.

Conclusion: **neither tokens nor skills loadout are reachable in-plugin today.** Both need a
minimal host-side forward. Per the design ("a Hermes-side one-line forward … is acceptable ONLY
if the counters are genuinely unreachable in-plugin — keep any host change minimal"), we add two
minimal forwards, both in `agent/turn_finalizer.py`, guarded so they never break the hook:
- Add `input_tokens=agent.session_input_tokens, output_tokens=agent.session_output_tokens` to the
  `post_llm_call` invocation (`:369`).
- Add `input_tokens=…, output_tokens=…, skills_loadout=<loaded names>` to the `on_session_end`
  invocation (`:494`). For the skills loadout, read from the agent if present
  (`getattr(agent, "loaded_skill_names", None)` — plan adds one assignment where
  `build_preloaded_skills_prompt` is consumed so the agent carries the list; fall back to `[]`).

This host change is additive kwargs only; every existing hook handler takes `**_`/`**kwargs`, so
no existing plugin breaks.

### Consent gate (unchanged)
`consent.capture_enabled()` / `distill.distill_capture_enabled(_runner)` — the same gate guards
every new recorder call and the episode emit. No change to `consent.py` / gating logic.

---

## Ordering / pop hazard (design-critical)

`assemble()` **pops** the buffer. `_on_session_end` must produce BOTH the legacy `CapturedTask`
(for the tee) and the `EpisodeV1`. Two safe options; the plan chooses **B**:

- **A (rejected):** call `assemble_episode()` first (non-popping), then `assemble()` (popping).
  Fragile — two functions must stay in lockstep and both must survive the pop-order.
- **B (chosen):** make `assemble_episode(task_id, session_id, completed, interrupted, ...)` the
  single popping assembler that returns a tuple `(legacy_task, episode)` — or add a non-popping
  `snapshot()` that both `assemble` and `assemble_episode` read, with the pop happening once.
  Concretely: add a private `_pop(task_id, session_id)` that pops once; `assemble` and
  `assemble_episode` each build their shape from the popped buffer. `_on_session_end` calls a new
  `assemble_both(...)` that pops once and returns `(legacy, episode)`. This guarantees the two
  shapes come from the identical buffer snapshot and the pop happens exactly once.

Order of interleaving is guaranteed by append order into `buf["steps"]`: within a turn,
`post_tool_call` fires per tool call (already appending tool spans), and `post_llm_call` fires
**after** the tool loop completes. So natural append order per turn is:
`user_turn (pre_llm_call) → tool_call* (post_tool_call) → assistant_turn (post_llm_call)`.
`record_user_turn` must append its `jinn.agent_turn`/`role:user` span at the moment `pre_llm_call`
fires (so it precedes that turn's tool calls), and `record_assistant_turn` appends its
`jinn.agent_turn`/`role:assistant` span when `post_llm_call` fires (after the tool calls).

Note `record_first_turn` (metadata: summary/model/platform) stays separate from
`record_user_turn` (which appends the ordered user span). `pre_llm_call` will call BOTH.

---

## Test suite invocation (implementer + verifier use the SAME command)

Working dir: `apps/jinn-agent`. Canonical runner (matches CI, per-file isolated):

```bash
cd apps/jinn-agent
./scripts/run_tests.sh tests/plugins/test_jinn_capture_buffer.py -q
./scripts/run_tests.sh tests/plugins/test_jinn_distill_tee.py -q
./scripts/run_tests.sh tests/plugins/test_jinn_episode.py -q   # new file
```

Full jinn-plugin gate (as CI runs it):
```bash
cd apps/jinn-agent
FILES=$(find tests/plugins -maxdepth 1 -name 'test_jinn_*.py' | sort | paste -sd:)
./scripts/run_tests.sh --files "$FILES" -j 4 --file-timeout 1200 -q
```

Client-side compat (TS) — the distiller reader must still parse legacy captures:
```bash
cd client && yarn workspace @jinn-network/harness-layer test
```

---

## TDD steps

Each step: **RED** (write failing test) → **GREEN** (minimal impl) → run the command above.

### Step 1 — Buffer records ordered user + assistant turns as spans  → AC1
**RED** — `tests/plugins/test_jinn_capture_buffer.py` (extend existing file):
- `test_records_user_and_assistant_turns_in_order`: call
  `record_user_turn("s","s","do X")`, `record_tool_call(...)`, `record_assistant_turn("s","s","done")`,
  then a new non-popping accessor (or `assemble_episode`) and assert the ordered `trajectory`/steps
  are `[agent_turn(role=user), tool_call, agent_turn(role=assistant)]` with matching `kind` and
  `attributes.role`. Assert `startTimeUnixNano <= endTimeUnixNano` and monotonic ordering.
**GREEN** — `capture_buffer.py`:
- Add `record_user_turn(task_id, session_id, user_message)` and
  `record_assistant_turn(task_id, session_id, assistant_response)`. Each appends a span into the
  same `buf["steps"]` list with `spanId` (`f"turn-{len(steps)+1}"`), `parentSpanId: None`,
  `name: "turn:user"|"turn:assistant"`, nano timestamps, `attributes: {"turn.text": <msg>,
  "role": "user"|"assistant"}`, `redactedKeys: []`. Do NOT add a `kind` here — legacy steps have
  no `kind`; `kind` is applied only when building the EpisodeV1 shape (Step 3). Use `setdefault`
  buffer-init identical to `record_tool_call` so a turn span can be the first thing recorded.

### Step 2 — Buffer accepts + stores skills loadout and token usage  → AC2
**RED** — same test file:
- `test_records_skills_loadout_and_tokens`: `record_environment(s, s, skills_loadout=["tdd"])`
  and `record_tokens(s, s, input=100, output=50)`; assert the episode's
  `environment.skillsLoadout == ["tdd"]` and `cost.tokens == {"input":100,"output":50}`.
- `test_tokens_omitted_when_never_recorded`: build an episode without `record_tokens`; assert
  `"tokens" not in episode["cost"]`.
**GREEN** — `capture_buffer.py`:
- Add `record_environment(task_id, session_id, skills_loadout: list[str])` (setdefault-idempotent
  on `buf["skillsLoadout"]`) and `record_tokens(task_id, session_id, input, output)` (stores
  `buf["tokens"] = {"input":…, "output":…}`). Both use the same buffer-init guard.

### Step 3 — `assemble_episode` emits a schema-shaped EpisodeV1 dict  → AC1, AC2, AC3
**RED** — new file `tests/plugins/test_jinn_episode.py`:
- `test_assemble_episode_shape`: drive user/tool/assistant/env/tokens recorders, call
  `assemble_episode(...)`, assert:
  - `schemaVersion == "jinn.episode.v1"`, `episodeId` non-empty, `session.sessionId`,
    `session.capturedAt` ISO-8601.
  - `trajectory` is the ordered list with each step carrying `kind` in
    `{"jinn.agent_turn","jinn.tool_call"}`; user/assistant steps → `jinn.agent_turn` with
    `attributes.role`; tool steps → `jinn.tool_call`.
  - `environment.skillsLoadout` present; `environment.tools` sorted; `environment.harness`,
    `environment.model` present.
  - `cost.durationMs` int≥0; `cost.tokens` present when recorded.
  - `retention.policy == "local-private"` by default; passing `publish_consented=True`
    (or equivalent) yields `"contribution-eligible"`.
  - `outcome.status`/`verifiabilityTier` mirror `assemble`'s mapping.
  - No extra top-level keys beyond the schema (guards strict-object rejection).
- `test_assemble_episode_returns_none_when_empty`: no steps → `None`.
- `test_retention_policy_flips_with_publish_consent`.
**GREEN** — `capture_buffer.py`:
- Refactor pop into `_pop(task_id, session_id)`; keep `assemble` behavior identical by having it
  call `_pop`. Add `assemble_episode(task_id, session_id, completed, interrupted,
  publish_consented=False)` that builds the EpisodeV1 dict from the popped buffer, mapping each
  legacy step to a `kind`-tagged step (tool spans → `jinn.tool_call`; `turn:*` spans →
  `jinn.agent_turn`, moving/keeping `role` in attributes). `episodeId` = a uuid4 hex or
  `f"{sessionId}-{startedNs}"`. Emit `cost.tokens` only when `buf.get("tokens")` is set.
  `retention.policy` = `"contribution-eligible"` if `publish_consented` else `"local-private"`.
- Add `assemble_both(task_id, session_id, completed, interrupted, publish_consented)` that pops
  once and returns `(legacy_task_dict, episode_dict_or_None)` so `_on_session_end` calls a single
  popping path (see Ordering hazard §B). `assemble` and `assemble_episode` may keep their own
  public signatures for unit tests by internally snapshotting before pop; simplest concrete form:
  `assemble_both` pops once, then builds both dicts from the same snapshot.

### Step 4 — Plugin subscribes `post_llm_call` and records turns/env/tokens  → AC1, AC2, AC4
**RED** — extend `tests/plugins/test_jinn_distill_tee.py` (or a new `test_jinn_episode.py` driver):
- `test_full_hook_drive_yields_ordered_episode` (consent accepted): drive
  `_on_pre_llm_call → _on_post_tool_call → _on_post_llm_call → _on_session_end`; assert an episode
  file was written whose `trajectory` is `[user, tool, assistant]` in order and
  `environment.skillsLoadout` / `cost.tokens` populated (forwarded via kwargs).
- `test_no_consent_no_distill_writes_nothing` (gating): consent UNSET, distill mode off — drive
  all four hooks; assert NO capture file AND NO episode file on disk; buffer stays in memory.
  (This is the AC4 guard for the new `post_llm_call` handler; mirror the existing
  `test_mode_off_...` gating test.)
**GREEN** — `__init__.py`:
- Add `_on_post_llm_call(session_id="", task_id="", user_message="", assistant_response="",
  input_tokens=None, output_tokens=None, **_)`: gate on
  `consent.capture_enabled() or distill.distill_capture_enabled(_runner)`; call
  `buf.record_assistant_turn(task_id, session_id, assistant_response)` and, when tokens present,
  `buf.record_tokens(...)`. (User turn recording is done in `_on_pre_llm_call`.)
- In `_on_pre_llm_call`, under the SAME existing gate, add `buf.record_user_turn(task_id,
  session_id, user_message)` (in addition to the existing `record_first_turn`).
- In `register()` at `:471`, add `ctx.register_hook("post_llm_call", _on_post_llm_call)`.
- In `_on_session_end`, before `record_environment`-dependent assembly, call
  `buf.record_environment(task_id, session_id, skills_loadout)` when `on_session_end` forwards it;
  and if `input_tokens`/`output_tokens` arrive on `on_session_end` (host forward), record them as
  a fallback. Then replace the single `buf.assemble(...)` with `buf.assemble_both(...)` (pop once),
  tee the legacy task as today, and write the episode via a new `distill.write_episode(...)` (Step 5).
  `publish_consented` argument = `consent.capture_enabled()`.

### Step 5 — Dual-write: legacy tee unchanged + EpisodeV1 to its own dir  → AC3, AC4
**RED** — `tests/plugins/test_jinn_distill_tee.py`:
- `test_legacy_capture_still_written_byte_shape`: after a driven accepted session, assert the
  legacy capture file in `captures_dir()` still parses as the old `CapturedTask` shape (keys:
  `session/task/environment/steps/outcome/cost/provenance`, no `schemaVersion`) — this is the
  compat contract the TS `parseCapturedTask` reads.
- `test_episode_written_to_separate_location`: assert exactly one `*.json` in
  `episodes_dir()` distinct from `captures_dir()`, and it parses as EpisodeV1 (`schemaVersion`
  present).
- `test_episode_not_written_without_gate`: gating off → neither dir gets a file.
**GREEN** — `distill.py`:
- Add `episodes_dir()` (env override `JINN_LAYER_EPISODES_DIR`, default
  `~/.jinn-client/harness-layer/episodes`) and `write_episode(episode, session_id, runner=None)`
  mirroring `tee_capture`'s best-effort discipline (never raises; gated by the same `should_tee`
  so a distill/publish opt-in is required). Keep `tee_capture` exactly as-is (legacy path).
- `__init__.py::_on_session_end` calls `distill.write_episode(episode, session_id_or_task_id)`
  right after the existing `distill.tee_capture(task, ...)`.

### Step 6 — Compat regression: distiller still reads legacy captures  → AC3
**RED / GREEN (already-green guard):**
- Python side: `test_legacy_capture_still_written_byte_shape` (Step 5) is the producer-side compat
  proof.
- TS side (reader-side proof): add a fixture-based test under
  `client/packages/harness-layer/` asserting `loadRecentCaptures` still parses a legacy capture
  produced by the current `assemble()` shape AND that an EpisodeV1 file dropped into the SAME dir
  is *skipped with a warning* (never crashes the reader). If a suitable test file exists
  (`distill-captures` spec), extend it; otherwise add `distill-captures.compat.test.ts`.
  Run: `cd client && yarn workspace @jinn-network/harness-layer test`.
- Because we do NOT mutate `assemble()` and the episode never lands in the captures dir, this is
  expected to pass immediately — it is a regression fence, not new behavior.

### Step 7 — Host-side minimal forwards (tokens + skills loadout)  → AC2
**RED** — `apps/jinn-agent/tests/cli/` or `tests/agent/`:
- Assert `post_llm_call` invocation includes `input_tokens`/`output_tokens` kwargs (a
  turn-finalizer unit test that spies `invoke_hook` and checks the kwargs dict for
  `post_llm_call`), and `on_session_end` includes `skills_loadout` + tokens. Reuse the existing
  `tests/cli/test_single_query_session_finalize.py` pattern (it already drives session finalize).
**GREEN** — `agent/turn_finalizer.py`:
- At the `post_llm_call` invoke (`:369`) add
  `input_tokens=getattr(agent, "session_input_tokens", 0), output_tokens=getattr(agent, "session_output_tokens", 0)`.
- At the `on_session_end` invoke (`:494`) add the same two, plus
  `skills_loadout=getattr(agent, "loaded_skill_names", None) or []`.
- Where `build_preloaded_skills_prompt` results are consumed (`cli.py:15787`,
  `tui_gateway/server.py:4266`), add a one-line `agent.loaded_skill_names = loaded_skills` so the
  agent carries the loadout to session end. Guard with `getattr`/`or []` on the read side so the
  absence path (no preloaded skills) yields `[]` and never raises.
- Keep changes additive-kwargs only; confirm no existing `post_llm_call`/`on_session_end` handler
  signature breaks (all use `**kwargs`/`**_`; verified for langfuse, nemo_relay, raft, jinn).

---

## Gating tests — confirmed NO change needed (AC4)

The existing gating tests in `test_jinn_distill_tee.py`
(`test_mode_off_tees_nothing_but_publish_path_unaffected`,
`test_declined_consent_and_old_layer_degrades_to_nothing`, etc.) assert the in-memory-only
property via the captures dir. They keep passing because:
- Every new recorder call in `_on_pre_llm_call` / `_on_post_llm_call` / `_on_session_end` sits
  under the SAME `capture_enabled() or distill_capture_enabled()` gate.
- `write_episode` is gated by `should_tee` (same table as `tee_capture`).
So no consent/gating test is modified. Step 4's `test_no_consent_no_distill_writes_nothing` and
Step 5's `test_episode_not_written_without_gate` are NEW guards specifically covering the new
surfaces (post_llm_call handler + episode write).

## Files touched

- `apps/jinn-agent/plugins/jinn/capture_buffer.py` — `record_user_turn`, `record_assistant_turn`,
  `record_environment`, `record_tokens`, `_pop`, `assemble_episode`, `assemble_both`
  (keep `assemble`, `record_first_turn`, `record_tool_call`, `has_steps`, `reset` intact).
- `apps/jinn-agent/plugins/jinn/__init__.py` — `_on_post_llm_call`, extend `_on_pre_llm_call` and
  `_on_session_end`, register `post_llm_call`.
- `apps/jinn-agent/plugins/jinn/distill.py` — `episodes_dir`, `write_episode` (keep `tee_capture`).
- `apps/jinn-agent/agent/turn_finalizer.py` — additive kwargs on two invokes.
- `apps/jinn-agent/cli.py` + `apps/jinn-agent/tui_gateway/server.py` — one-line
  `agent.loaded_skill_names = loaded_skills` each.
- Tests: `tests/plugins/test_jinn_capture_buffer.py` (extend),
  `tests/plugins/test_jinn_episode.py` (new), `tests/plugins/test_jinn_distill_tee.py` (extend),
  `tests/cli/test_single_query_session_finalize.py` (extend),
  `client/packages/harness-layer/.../distill-captures.compat.test.ts` (new/extend).

## Out of scope (Stage 1)
- `lineage`, `usdEstimate`, `distributionTags` policy (schema defaults to `[]`).
- Anchoring / publishing the EpisodeV1 (the pending/publish lifecycle stays on the legacy path).
- Scrubbing the episode (raw capture; scrub stays in `jinn-layer` on the legacy path).
